// LLM sign reading: a swappable call layer + 3-sample self-consistency + server-side caching. Shared by the Worker (src/worker.js) and the precompute tool (tools/precompute.mjs)
// Plan explanation (D-0929-2307): serverExplain() reuses the same call, cache, rate limit, breaker and daily cap, asks once, and passes the text through sanitizeExplain()
// Prompts live only in prompts.md (tools/gen-prompt.mjs generates src/prompt.js); how to ask and how to combine also follow prompts.md
// Works with any OpenAI-compatible POST {LLM_BASE_URL}/chat/completions: DeepSeek (default), Alibaba DashScope compatible mode, OpenAI, etc.
// 🔒 The key is read from env.LLM_API_KEY only when a request is sent; it never enters the config object, logs, error messages or responses (negative assertions in tests/llm.test.mjs)
// 🔒 No spending by default: a real call happens only when MOCK === "0" and a key is set; any failure falls back to the rules
// 🔒 Spending has a global cap: every call first reserves budget in the BUDGET Durable Object (src/budget.js); once the cap is hit, only the rules run for the rest of the day
import { PROMPT } from "./prompt.js";
import { takeBudget } from "./budget.js";
import { canonical, sha256Hex, sanitizeReading } from "../public/js/signs.js";
import { ruleReading } from "../public/js/rules.js";
import { normalizeExplainRequest, ruleExplain, sanitizeExplain } from "../public/js/explain.js";

export const DEFAULTS = {
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-flash",
  maxCallsPerMin: 60, // calls per Worker instance per minute (best effort, see guard()); one demo page is about 20 requests × 3 = 60
  maxCallsPerDay: 600, // global calls per day (BUDGET counter, a hard cap): a sign-reading call counts 1, about ¥0.002 → about ¥1.2 a day, ¥2.4 worst case;
  //   an explain call counts EXPLAIN_CALLS = 5 (about ¥0.01–0.015), so spending it all on explains is 120 calls, about ¥1.8 worst case; the cost ceiling is unchanged
  timeoutMs: 6000, // per-call timeout; must be shorter than the 8 s the browser-side reader.js waits
};
export const SAMPLES = 3; // samples per persona per message (prompts.md)
const MAX_TOKENS = 300; // one JSON reading is about 80–120 tokens
const MEM_MAX = 500; // max entries in the per-instance memory cache
const CACHE_TTL_S = 30 * 24 * 3600; // KV / Cache API keep entries 30 days: a reading for the same message and persona never changes (prompt_v and model are in the key)
const BREAKER_FAILS = 3; // after this many consecutive failed readings (fewer than 2 valid samples)...
const BREAKER_MS = 60_000; // ...stop asking the LLM for this long and use the rules: with a bad key or a provider outage, requests should not each wait 6 s for nothing
// An explanation asks once (no 3-sample combine) but is charged as 5 against the daily and per-minute counters: max_tokens 1500 is 5x the 300 of a reading, so it costs about 5x.
// Charged as 1, the public /api/explain could be cache-busted by changing any number, and an anonymous script could spend about ¥9 a day and stop sign reading too (same ledger)
export const EXPLAIN_CALLS = 5;
const EXPLAIN_MAX_TOKENS = 1500; // pros, cons, risks and lean for 3–5 plans; about 600–900 tokens in Chinese
export const EXPLAIN_TIMEOUT_MS = 20_000; // explanations are long, 6 s is not enough; a larger LLM_TIMEOUT_MS wins. The browser-side explainOptions() waits 25 s

export class LlmError extends Error {
  // The message is a fixed short code only, never provider output (which may echo request headers)
  constructor(code) {
    super(`llm: ${code}`);
    this.name = "LlmError";
    this.code = code;
  }
}

// ---------------------------------------------------------------- config

const str = (x) => (typeof x === "string" ? x.trim() : "");
const hasKey = (env) => str(env?.LLM_API_KEY) !== "";

function baseOf(x) {
  const raw = str(x) || DEFAULTS.baseUrl;
  try {
    const u = new URL(raw);
    const local = u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname);
    if ((u.protocol !== "https:" && !local) || u.username || u.password || u.search || u.hash) return { url: raw, ok: false, host: "" };
    return { url: u.href.replace(/\/+$/, ""), ok: true, host: u.hostname };
  } catch {
    return { url: raw, ok: false, host: "" };
  }
}

// The provider only decides which extra parameters are sent; anything unknown is treated as plain OpenAI-compatible
function providerOf(host, model) {
  if (host.includes("dashscope")) return "dashscope"; // DashScope also hosts deepseek-* models: the host decides
  if (host === "api.deepseek.com" || host.endsWith(".deepseek.com") || model.startsWith("deepseek")) return "deepseek";
  return "openai-compatible";
}

// env → config (without the key value). mode = "llm" only when MOCK === "0", a key is set and the base URL is valid
export function llmConfig(env = {}) {
  const base = baseOf(env.LLM_BASE_URL);
  const m = str(env.LLM_MODEL);
  const model = /^[A-Za-z0-9._:/-]{1,80}$/.test(m) ? m : DEFAULTS.model;
  const n = num(env.LLM_MAX_CALLS_PER_MIN);
  const d = num(env.LLM_MAX_CALLS_PER_DAY);
  const t = num(env.LLM_TIMEOUT_MS);
  const mock = env.MOCK !== "0";
  const key = hasKey(env);
  return {
    mode: !mock && key && base.ok ? "llm" : "rules",
    mock,
    key,
    baseUrl: base.url,
    baseOk: base.ok,
    provider: providerOf(base.host, model),
    model,
    maxCallsPerMin: Number.isInteger(n) && n > 0 ? n : DEFAULTS.maxCallsPerMin,
    maxCallsPerDay: Number.isInteger(d) && d >= 0 ? d : DEFAULTS.maxCallsPerDay, // 0 = no calls at all
    timeoutMs: Number.isFinite(t) && t > 0 && t <= 30_000 ? t : DEFAULTS.timeoutMs,
  };
}

const num = (x) => (typeof x === "number" ? x : Number(str(x) || NaN));

// Which cross-request reading cache to use: kv (READINGS binding, across instances) > cache-api (shared within a data centre) > memory (500 entries in this instance only)
// host = request hostname: Cloudflare's Cache API is per zone and put / match do nothing on *.workers.dev (per the docs), so only memory is left there
export const isWorkersDev = (host) => /(^|\.)workers\.dev$/i.test(str(host));
export function cacheKind(env = {}, host = "") {
  const kv = env.READINGS;
  if (kv && typeof kv.get === "function" && typeof kv.put === "function") return "kv";
  if (!isWorkersDev(host) && globalThis.caches?.default && typeof globalThis.caches.default.match === "function") return "cache-api";
  return "memory";
}

const hasBudget = (env) => typeof env?.BUDGET?.idFromName === "function";

// The llm field of GET /api/health: says whether a key is set, never its value. host as in cacheKind
export function llmStatus(env = {}, host = "") {
  const c = llmConfig(env);
  const out = {
    mode: c.mode,
    model: c.model,
    key: c.key,
    cache: cacheKind(env, host),
    prompt_v: PROMPT.v,
    explain_v: PROMPT.explain.v, // version of the explain prompt (prompts.md, "Plan explanation")
    provider: c.provider,
    budget: hasBudget(env), // whether the global daily counter is bound (without it nothing is called, even in llm mode)
    per_day: c.maxCallsPerDay,
    per_min: c.maxCallsPerMin,
  };
  if (!c.baseOk) out.error = "bad_base_url";
  return out;
}

// ---------------------------------------------------------------- prompts

const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

function signBlock(s, n) {
  const kind_label = PROMPT.kinds[s.kind];
  const lines = s.kind === "vms" ? s.frames.map((f) => f.join("\n")).join("\n---\n") : s.text;
  if (!lines) return fill(PROMPT.arrowEmpty, { n, kind_label, read_s: s.read_s });
  return fill(PROMPT.sign, { n, kind_label, read_s: s.read_s, sign_lines: lines });
}

// Messages for sample i (0-based); roads = the road order for this sample
export function buildMessages(req, i, roads = req.roads) {
  const user = fill(PROMPT.user, {
    persona_line: PROMPT.personas[req.persona],
    kmh: req.kmh,
    signs: req.signs.map((s, j) => signBlock(s, j + 1)).join("\n"),
    roads: roads.join("; "),
    ask: PROMPT.asks[i % PROMPT.asks.length],
  });
  return [
    { role: "system", content: PROMPT.system },
    { role: "user", content: user },
  ];
}

// Shuffle seeded by the SHA-256 of the canonical request, so a request always gets the same orders; aim for 3 distinct orders (2 roads only have 2, so the 3rd repeats the 1st)
function rng(seedHex) {
  let a = parseInt(String(seedHex).slice(0, 8), 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function roadOrders(roads, seedHex, n = SAMPLES) {
  const rand = rng(seedHex);
  const shuffle = () => {
    const a = [...roads];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const distinct = roads.length <= 1 ? 1 : roads.length === 2 ? 2 : Infinity;
  const orders = [];
  const seen = new Set();
  for (let i = 0; i < n; i++) {
    let o;
    if (seen.size >= distinct) o = [...orders[i % distinct]];
    else {
      for (let t = 0; t < 30; t++) {
        o = shuffle();
        if (!seen.has(o.join("\n"))) break;
      }
      if (seen.has(o.join("\n"))) o = [...roads.slice(i % roads.length), ...roads.slice(0, i % roads.length)]; // fallback: rotate
    }
    seen.add(o.join("\n"));
    orders.push(o);
  }
  return orders;
}

// ---------------------------------------------------------------- calls

export function chatUrl(cfg) {
  return `${cfg.baseUrl}/chat/completions`;
}

export function requestBody(cfg, messages, maxTokens = MAX_TOKENS) {
  const body = { model: cfg.model, messages, response_format: { type: "json_object" }, max_tokens: maxTokens, stream: false };
  if (cfg.provider === "deepseek") body.thinking = { type: "disabled" }; // otherwise content is an empty string (docs/hackathon/llm-apis/jinmingq-deepseek.md §5)
  if (cfg.provider === "dashscope") body.enable_thinking = false;
  return body;
}

// Answer text → object. Tolerates ```json fences and extra text around it; throws bad_json if it is not a JSON object
export function parseJsonObject(content) {
  const t = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const tries = [t];
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a >= 0 && b > a) tries.push(t.slice(a, b + 1));
  for (const s of tries) {
    try {
      const v = JSON.parse(s);
      if (v && typeof v === "object" && !Array.isArray(v)) return v;
    } catch {
      // try the next one
    }
  }
  throw new LlmError("bad_json");
}

// One call → parsed object; throws LlmError (short code only) on failure
export async function askOnce(env, cfg, messages, opts = {}) {
  const f = opts.fetch || globalThis.fetch;
  if (typeof f !== "function") throw new LlmError("no_fetch");
  const ms = opts.timeoutMs ?? cfg.timeoutMs ?? DEFAULTS.timeoutMs;
  const ctl = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(new LlmError("timeout"));
    }, ms);
  });
  try {
    const res = await Promise.race([
      f(chatUrl(cfg), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${str(env.LLM_API_KEY)}` },
        body: JSON.stringify(requestBody(cfg, messages, opts.maxTokens)),
        signal: ctl.signal,
      }),
      timeout,
    ]);
    if (!res || !res.ok) throw new LlmError(`http_${Number(res?.status) || 0}`);
    const data = await Promise.race([res.json(), timeout]);
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new LlmError("no_content");
    return parseJsonObject(content);
  } catch (e) {
    if (e instanceof LlmError) throw e;
    throw new LlmError(ctl.signal.aborted ? "timeout" : "network"); // never pass the raw error through
  } finally {
    clearTimeout(timer);
  }
}

// Accept numbers written as strings ("0.8"); guess nothing else
function coerce(raw) {
  if (!raw || typeof raw !== "object") return raw;
  const out = { ...raw };
  for (const k of ["notice", "understand", "trust", "saving_min", "delay_min"]) {
    if (typeof out[k] === "string" && out[k].trim() !== "" && Number.isFinite(Number(out[k]))) out[k] = Number(out[k]);
  }
  return out;
}

// ---------------------------------------------------------------- combine 3 samples into one (prompts.md, "Combining three samples into one reading")

const r2 = (x) => Math.round(x * 100) / 100;

function median(xs) {
  const v = xs.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
  if (v.length < 2) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export function combine(samples, req, cfg) {
  if (samples.length < 2) return null;
  const mean = (k) => r2(samples.reduce((s, r) => s + r[k], 0) / samples.length);
  const range = {};
  for (const k of ["notice", "understand", "trust"]) {
    const v = samples.map((r) => r[k]);
    range[k] = [Math.min(...v), Math.max(...v)];
  }
  const advice = {};
  for (const road of new Set(samples.flatMap((r) => Object.keys(r.advice)))) {
    const said = samples.map((r) => r.advice[road]);
    const use = said.filter((x) => x === "use").length;
    const avoid = said.filter((x) => x === "avoid").length;
    if (avoid >= 2 || (use >= 1 && avoid >= 1)) advice[road] = "avoid";
    else if (use >= 2) advice[road] = "use";
  }
  const trust = mean("trust");
  const why = samples.reduce((best, r) => (Math.abs(r.trust - trust) < Math.abs(best.trust - trust) ? r : best)).why;
  return sanitizeReading(
    {
      notice: mean("notice"),
      understand: mean("understand"),
      advice,
      saving_min: median(samples.map((r) => r.saving_min)),
      delay_min: median(samples.map((r) => r.delay_min)),
      trust,
      why,
      range,
      model: cfg.model,
      prompt_v: PROMPT.v,
    },
    req,
    "llm",
  );
}

// No cache: ask 3 times (in parallel) → combine. Used directly by the precompute tool
// Returns { reading | null, valid, errors[], calls }; errors holds short codes only
export async function llmReading(req, env, opts = {}) {
  const cfg = opts.cfg || llmConfig(env);
  const seed = await sha256Hex(canonical(req));
  const orders = roadOrders(req.roads, seed);
  const results = await Promise.allSettled(orders.map((roads, i) => askOnce(env, cfg, buildMessages(req, i, roads), opts)));
  const valid = [];
  const errors = [];
  for (const r of results) {
    if (r.status === "rejected") {
      errors.push(r.reason instanceof LlmError ? r.reason.code : "error");
      continue;
    }
    const s = sanitizeReading(coerce(r.value), req, "llm");
    if (s) valid.push(s);
    else errors.push("invalid");
  }
  return { reading: combine(valid, req, cfg), valid: valid.length, errors, calls: orders.length };
}

// ---------------------------------------------------------------- Worker path: cache + rate limit + circuit breaker

const state = { mem: new Map(), win: { start: 0, n: 0 }, breaker: { fails: 0, until: 0 }, capUntil: 0 };

// For tests: clear the per-instance memory cache, rate counter and breaker
export function resetLlmState() {
  state.mem.clear();
  state.win = { start: 0, n: 0 };
  state.breaker = { fails: 0, until: 0 };
  state.capUntil = 0;
}

export const cacheKey = (req, cfg) => sha256Hex(`${PROMPT.v}|${cfg.model}|${canonical(req)}`);

// One counter per Worker instance, best effort: Cloudflare runs several instances at once and recycles them at any time, so this is not a billing cap
// (the billing cap is the global daily counter in src/budget.js plus a small prepaid balance at the provider). It only stops a day's budget being spent in one minute
function guard(n, max, now) {
  if (now - state.win.start >= 60_000) state.win = { start: now, n: 0 };
  if (state.win.n + n > max) return false;
  state.win.n += n;
  return true;
}

function memSet(key, reading) {
  if (state.mem.size >= MEM_MAX) state.mem.delete(state.mem.keys().next().value);
  state.mem.set(key, reading);
}

// KV (when READINGS is bound) or the Cache API (built into Workers; it does nothing on *.workers.dev, where cacheKind returns memory and it is left alone)
// ns: "read" for readings, "explain" for explanations, with separate key prefixes (read:<hash> / explain:<hash> in KV)
function store(env, origin, ns = "read") {
  let host = "";
  try {
    host = origin ? new URL(origin).hostname : "";
  } catch {
    // treat a bad origin as none
  }
  const kind = cacheKind(env, host);
  if (kind === "kv") {
    const kv = env.READINGS;
    return {
      get: async (k) => {
        const t = await kv.get(`${ns}:${k}`);
        return t ? JSON.parse(t) : null;
      },
      put: (k, v) => kv.put(`${ns}:${k}`, JSON.stringify(v), { expirationTtl: CACHE_TTL_S }),
    };
  }
  if (kind === "cache-api") {
    const cache = globalThis.caches.default;
    const url = (k) => new URL(`/__cache/llm-${ns}/${k}`, origin || "https://hackathon-api.internal").href;
    return {
      get: async (k) => {
        const r = await cache.match(url(k));
        return r ? r.json() : null;
      },
      put: (k, v) =>
        cache.put(
          url(k),
          new Response(JSON.stringify(v), { headers: { "content-type": "application/json", "cache-control": `public, max-age=${CACHE_TTL_S}` } }),
        ),
    };
  }
  return { get: async () => null, put: async () => {} };
}

const fallback = (req, note) => ({ ...ruleReading(req), note: String(note).slice(0, 120) });

// Record one failure (a whole reading or an explanation); BREAKER_FAILS in a row pause calls for BREAKER_MS. Reading and explain share a provider and key, so they share one breaker
function trip(now) {
  if (++state.breaker.fails >= BREAKER_FAILS) state.breaker = { fails: 0, until: now + BREAKER_MS };
}

// Admission gates before a call (breaker → this instance already knows today is used up → per minute → reserve n against the global daily cap); returns null to admit, otherwise a note code
async function admit(env, cfg, n, now) {
  if (now < state.breaker.until) return "llm_paused: recent calls failed";
  if (now < state.capUntil) return "llm_daily_cap"; // this instance already knows today is used up: stop asking the DO every time
  if (!guard(n, cfg.maxCallsPerMin, now)) return "llm_rate_limited";
  // Global daily cap: reserve first, no reservation means no call (same when BUDGET is unbound or the DO fails: never spend unrecorded money)
  const budget = await takeBudget(env, n, cfg.maxCallsPerDay);
  if (budget === "over") state.capUntil = (Math.floor(now / 86_400_000) + 1) * 86_400_000; // until the next 00:00 UTC
  if (budget !== "ok") return { over: "llm_daily_cap", no_budget: "llm_no_budget" }[budget] || "llm_budget_error";
  return null;
}

// Worker reading path: memory → KV / Cache API → LLM (3 samples) → store in cache; otherwise rules + note. The caller has already checked mode === "llm"
// opts: { origin, fetch, timeoutMs, now } (injected by tests)
export async function serverReading(req, env, opts = {}) {
  const cfg = llmConfig(env);
  if (cfg.mode !== "llm") return ruleReading(req);
  if (!req.signs.length) return ruleReading(req); // no signs: nothing to read
  const now = opts.now ?? Date.now();
  const key = await cacheKey(req, cfg);

  const hot = state.mem.get(key);
  if (hot) return sanitizeReading(hot, req, "kv");
  const st = store(env, opts.origin);
  try {
    const hit = await st.get(key);
    const r = hit && sanitizeReading(hit, req, "kv");
    if (r) {
      memSet(key, r);
      return r;
    }
  } catch {
    // a broken cache must not break the reading
  }

  const shut = await admit(env, cfg, SAMPLES, now); // one reading asks 3 times = reserve 3
  if (shut) return fallback(req, shut);

  const out = await llmReading(req, env, { ...opts, cfg });
  if (!out.reading) {
    trip(now);
    return fallback(req, `llm_fallback: ${out.valid}/${out.calls} valid (${[...new Set(out.errors)].join(", ")})`);
  }
  state.breaker.fails = 0;
  memSet(key, out.reading);
  try {
    await st.put(key, out.reading);
  } catch {
    // if it cannot be stored, ask again next time
  }
  return out.reading;
}

// ---------------------------------------------------------------- plan explanation (POST /api/explain, prompts.md "Plan explanation")

// Normalised request → messages. The user message holds only the output of normalizeExplainRequest() (plan id / label / metrics / per_capita_min / flags) and the language
export function buildExplainMessages(req) {
  const E = PROMPT.explain;
  return [
    { role: "system", content: E.system },
    { role: "user", content: fill(E.user, { lang_name: E.langs[req.lang], options_json: JSON.stringify(req.options) }) },
  ];
}

// normalizeExplainRequest builds keys in a fixed order, so JSON.stringify is the canonical string
export const explainKey = (req, cfg) => sha256Hex(`explain|${PROMPT.explain.v}|${cfg.model}|${JSON.stringify(req)}`);

const explainFallback = (req, note) => ({ ...ruleExplain(req), note: String(note).slice(0, 120) });

// How many model-written items survive sanitising (a summary swapped back to the rule version and rule-version risks do not count); 0 = effectively no answer
function authored(clean, rule) {
  let n = clean.lean ? 1 : 0;
  clean.options.forEach((o, i) => {
    const r = rule.options[i];
    n += (o.summary !== r.summary ? 1 : 0) + o.pros.length + o.cons.length + Math.max(0, o.risks.length - r.risks.length);
  });
  return n;
}

// Cached explanations are untrusted too: run sanitizeExplain again (hardest-hit group and rule risks are recomputed)
const explainFromCache = (hit, req) => sanitizeExplain(hit, req, "kv");

// Worker explain path: rules (LLM off), or memory → KV / Cache API → LLM (1 call) → sanitise → store in cache; otherwise the rule-based version + note
// opts: { origin, fetch, timeoutMs, now } (injected by tests). An invalid request throws ExplainError (the router answers 400)
export async function serverExplain(input, env, opts = {}) {
  const req = normalizeExplainRequest(input);
  const cfg = llmConfig(env);
  if (cfg.mode !== "llm") return ruleExplain(req);
  const now = opts.now ?? Date.now();
  const key = await explainKey(req, cfg);
  const memKey = `explain:${key}`;

  const hot = state.mem.get(memKey);
  const warm = hot && explainFromCache(hot, req);
  if (warm) return warm;
  const st = store(env, opts.origin, "explain");
  try {
    const hit = await st.get(key);
    const r = hit && explainFromCache(hit, req);
    if (r) {
      memSet(memKey, r); // only sanitised data goes into memory: tampered raw data from KV never does
      return r;
    }
  } catch {
    // a broken cache must not break the explanation
  }

  const shut = await admit(env, cfg, EXPLAIN_CALLS, now);
  if (shut) return explainFallback(req, shut);

  let raw;
  try {
    const timeoutMs = opts.timeoutMs ?? Math.max(cfg.timeoutMs, EXPLAIN_TIMEOUT_MS);
    raw = await askOnce(env, cfg, buildExplainMessages(req), { ...opts, timeoutMs, maxTokens: EXPLAIN_MAX_TOKENS });
  } catch (e) {
    trip(now);
    return explainFallback(req, `llm_fallback: ${e instanceof LlmError ? e.code : "error"}`);
  }
  // Take only options / lean: note, model, hardest_hit, decide and the like written by the model are ignored
  const clean = sanitizeExplain({ options: raw.options, lean: raw.lean }, req, "llm");
  const why = !clean ? "invalid" : !authored(clean, ruleExplain(req)) ? "empty" : null;
  if (why) {
    trip(now);
    return explainFallback(req, `llm_fallback: ${why}`);
  }
  state.breaker.fails = 0;
  const out = { ...clean, model: cfg.model, prompt_v: PROMPT.explain.v };
  memSet(memKey, out);
  try {
    await st.put(key, out);
  } catch {
    // if it cannot be stored, ask again next time
  }
  return out;
}
