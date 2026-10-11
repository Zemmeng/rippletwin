// LLM sign reading: src/llm.js + src/worker.js. Everything uses a fake fetch; no real call is ever made
// Negative assertions: no spending by default (0 fetches with MOCK=1 or no key); the key never appears in any response, health or error message
// Usage: node tests/llm.test.mjs
import { ok, eq, sec, done } from "./mini.mjs";
import worker from "../src/worker.js";
import {
  llmConfig, llmStatus, askOnce, combine, llmReading, serverReading, resetLlmState, requestBody, buildMessages, LlmError, cacheKey,
} from "../src/llm.js";
import { PROMPT } from "../src/prompt.js";
import { LlmBudget } from "../src/budget.js";
import { normalizeRequest } from "../public/js/signs.js";
import { ruleReading } from "../public/js/rules.js";

// Fake key, assembled at runtime so no whole key-like string appears in the repo (secret scanning)
const FAKE = ["fake", "k3y", "for", "tests", "7f3a9c"].join("-");

// Fake Durable Object namespace: runs the real LlmBudget class (src/budget.js) with a Map as storage; the clock can be moved
function budgetNs(clock = () => Date.now()) {
  const data = new Map();
  const obj = new LlmBudget({ storage: { get: async (k) => structuredClone(data.get(k)), put: async (k, v) => void data.set(k, structuredClone(v)) } }, {}, () => clock());
  const ns = {
    data,
    calls: 0,
    idFromName: (name) => ({ name }),
    get: (id) => ({
      fetch: async (u, init) => {
        ns.calls++;
        ns.ids = [...new Set([...(ns.ids || []), id.name])];
        return obj.fetch(new Request(u, init));
      },
    }),
  };
  return ns;
}
// LLM on (default DeepSeek URL + deepseek-flash), with the global daily counter (the BUDGET bound in production wrangler.jsonc)
const ON = { MOCK: "0", LLM_API_KEY: FAKE, BUDGET: budgetNs() };

const REQ = {
  persona: "commuter",
  kmh: 40,
  signs: [{ kind: "vms", frames: [["USE", "RUSSELL ST", "SAVE 8 MIN"]], read_s: 9 }],
  roads: ["La Trobe St", "Russell St", "Elizabeth St"],
};
const NREQ = normalizeRequest(REQ);
// A new sign text each time = a new cache key (no bleed-through from the memory cache)
let seq = 0;
const fresh = () => ({ ...REQ, signs: [{ kind: "vms", frames: [["USE", "RUSSELL ST", `SAVE ${++seq}`, "MIN"]], read_s: 9 }] });

const answer = (o) => ({
  notice: 0.8, understand: 0.9, advice: { "Russell St": "use" }, saving_min: 8, delay_min: null, trust: 0.7, why: "Sign says use Russell", ...o,
});
const chat = (content, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => ({ choices: [{ message: { content: typeof content === "string" ? content : JSON.stringify(content) } }] }),
});

// Fake fetch: call i answers replies[i] (calling it if it is a function); records url / headers / body
function fakeLLM(replies) {
  const calls = [];
  const f = async (url, init) => {
    const i = calls.length;
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body), signal: init.signal });
    const r = replies[Math.min(i, replies.length - 1)];
    return typeof r === "function" ? r(init, i) : r;
  };
  f.calls = calls;
  return f;
}

// Run fn with globalThis.fetch replaced by a fake (the Worker uses the global fetch)
async function withFetch(f, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = f;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

const call = async (path, init, env) => {
  const r = await worker.fetch(new Request(`https://api.test${path}`, init), env);
  const text = await r.text();
  return { status: r.status, text, body: JSON.parse(text) };
};
const post = (body, env) => call("/api/read", { method: "POST", body: JSON.stringify(body) }, env);

await sec("negative (billing): no spending by default: with MOCK=1 or MOCK unset, 0 fetches even with a key", async () => {
  resetLlmState();
  const f = fakeLLM([chat(answer())]);
  await withFetch(f, async () => {
    const a = await post(REQ, { MOCK: "1", LLM_API_KEY: FAKE });
    const b = await post(REQ, { LLM_API_KEY: FAKE });
    eq([a.body.reading.src, b.body.reading.src], ["rule", "rule"], "both are rule readings");
    eq(a.body.reading, ruleReading(REQ), "identical to the plain rule reading (no note)");
  });
  eq(f.calls.length, 0, "0 external fetches");
  eq(llmConfig({ MOCK: "1", LLM_API_KEY: FAKE }).mode, "rules", "MOCK=1 → mode rules");
  eq(llmConfig({ LLM_API_KEY: FAKE }).mode, "rules", "MOCK unset → mode rules");
});

await sec("MOCK=0 but no key: rules; health says key:false", async () => {
  resetLlmState();
  const f = fakeLLM([chat(answer())]);
  await withFetch(f, async () => {
    const r = await post(REQ, { MOCK: "0" });
    eq(r.body.reading.src, "rule", "rule reading");
    const h = await call("/api/health", {}, { MOCK: "0", LLM_API_KEY: "  " });
    eq([h.body.mock, h.body.llm.mode, h.body.llm.key], [false, "rules", false], "a blank key counts as none");
  });
  eq(f.calls.length, 0, "0 fetches");
});

await sec("GET /api/health llm field", async () => {
  const off = (await call("/api/health", {}, { MOCK: "1" })).body;
  eq(
    off.llm,
    { mode: "rules", model: "deepseek-flash", key: false, cache: "memory", prompt_v: PROMPT.v, explain_v: PROMPT.explain.v, provider: "deepseek", budget: false, per_day: 600, per_min: 60 },
    "default: rules · deepseek-flash · no key · memory cache only · no BUDGET · 600 per day / 60 per minute",
  );
  eq((await call("/api/health", {}, ON)).body.llm.budget, true, "BUDGET bound → budget true");
  const on = await call("/api/health", {}, { ...ON, LLM_MODEL: "deepseek-flash" });
  eq([on.body.mock, on.body.llm.mode, on.body.llm.key], [false, "llm", true], "MOCK=0 + key → mode llm, key true");
  ok(!on.text.includes(FAKE), "negative: health does not contain the key value");
  const kv = { get: async () => null, put: async () => {} };
  eq((await call("/api/health", {}, { ...ON, READINGS: kv })).body.llm.cache, "kv", "READINGS bound → cache kv");
  const bad = (await call("/api/health", {}, { ...ON, LLM_BASE_URL: "http://evil.example" })).body.llm;
  eq([bad.mode, bad.error], ["rules", "bad_base_url"], "non-https URL → no calls, health reports bad_base_url");
});

await sec("MOCK=0 + key + fake LLM: 3 samples, mean, range, sanitised", async () => {
  resetLlmState();
  const f = fakeLLM([
    chat(answer({ notice: 0.8, understand: 0.9, trust: 0.6, saving_min: 8, why: "one" })),
    chat(answer({ notice: 0.9, understand: 0.8, trust: 0.7, saving_min: 10, why: "two\u0000 two", advice: { "Russell St": "use", "Fake Rd": "use" } })),
    chat("```json\n" + JSON.stringify(answer({ notice: 0.7, understand: 1, trust: 0.9, saving_min: 9, why: "three" })) + "\n```"),
  ]);
  const r = await withFetch(f, () => post(REQ, ON));
  const x = r.body.reading;
  eq(f.calls.length, 3, "3 calls");
  eq([x.src, x.model, x.prompt_v], ["llm", "deepseek-flash", PROMPT.v], "src llm · model · prompt_v");
  eq([x.notice, x.understand, x.trust], [0.8, 0.9, 0.73], "mean of the three");
  eq(x.range, { notice: [0.7, 0.9], understand: [0.8, 1], trust: [0.6, 0.9] }, "range = [min, max]");
  eq(x.saving_min, 9, "saving_min is the median");
  eq(x.advice, { "Russell St": "use" }, "negative: a road not in the request (Fake Rd) is dropped");
  eq(x.why, "two two", "why comes from the sample with trust closest to the mean, control characters removed");
  const c0 = f.calls[0];
  eq(c0.url, "https://api.deepseek.com/chat/completions", "POST {LLM_BASE_URL}/chat/completions");
  eq(c0.headers.authorization, `Bearer ${FAKE}`, "Authorization: Bearer <key>");
  eq([c0.body.model, c0.body.response_format, c0.body.stream], ["deepseek-flash", { type: "json_object" }, false], "JSON only, no streaming");
  ok(c0.signal && typeof c0.signal.aborted === "boolean", "passes an AbortController signal (aborted on timeout)");
  const users = f.calls.map((c) => c.body.messages[1].content);
  eq(new Set(users.map((u) => u.split("\n").pop())).size, 3, "three samples, three phrasings");
  eq(new Set(users.map((u) => u.match(/Candidate roads[^\n]*/)[0])).size, 3, "three samples, three road orders");
  ok(users.every((u) => u.includes("<sign>\nUSE\nRUSSELL ST\nSAVE 8 MIN\n</sign>")), "sign text is placed verbatim inside <sign> tags");
  ok(f.calls.every((c) => c.body.messages[0].content === PROMPT.system), "system is the text from prompts.md");
});

await sec("DeepSeek gets thinking disabled; other providers do not (decided by URL / model)", async () => {
  const m = buildMessages(NREQ, 0);
  eq(requestBody(llmConfig(ON), m).thinking, { type: "disabled" }, "default DeepSeek: thinking disabled (otherwise content is an empty string)");
  const oa = requestBody(llmConfig({ ...ON, LLM_BASE_URL: "https://api.openai.com/v1", LLM_MODEL: "gpt-4o-mini" }), m);
  ok(!("thinking" in oa) && !("enable_thinking" in oa), "OpenAI: no thinking / enable_thinking");
  const ds = requestBody(llmConfig({ ...ON, LLM_BASE_URL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", LLM_MODEL: "qwen-plus" }), m);
  eq([ds.enable_thinking, "thinking" in ds], [false, false], "DashScope: enable_thinking false");
  const dsDeep = llmConfig({ ...ON, LLM_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1", LLM_MODEL: "deepseek-v3" });
  eq(dsDeep.provider, "dashscope", "deepseek-* models on DashScope are treated as DashScope");
});

await sec("fallback: bad JSON / timeout / 500 / only 1 of 3 valid → rules + note", async () => {
  const cases = [
    ["bad JSON", [chat("sure! here you go")], "bad_json"],
    ["HTTP 500", [chat("", 500)], "http_500"],
    ["empty content", [chat("")], "no_content"],
    ["bad fields", [chat({ notice: 2, understand: "x" })], "invalid"],
    ["1/3 valid", [chat(answer()), chat("nope"), chat("", 503)], "1/3 valid"],
    ["timeout", [() => new Promise(() => {})], "timeout"],
  ];
  for (const [name, replies, want] of cases) {
    resetLlmState();
    const f = fakeLLM(replies);
    const r = await withFetch(f, () => post(fresh(), { ...ON, LLM_TIMEOUT_MS: "30" }));
    const x = r.body.reading;
    ok(r.status === 200 && x.src === "rule" && typeof x.note === "string" && x.note.includes(want), `${name} → rules, note contains "${want}" (actual ${x.src} · ${x.note})`);
  }
  resetLlmState();
  const two = fakeLLM([chat(answer({ trust: 0.6 })), chat("nope"), chat(answer({ trust: 0.8 }))]);
  const r2 = await withFetch(two, () => post(fresh(), ON));
  eq([r2.body.reading.src, r2.body.reading.trust], ["llm", 0.7], "2 of 3 valid → still the LLM reading (mean of 2)");
});

await sec("cache: the same request does not call the LLM a second time (memory → KV → Cache API)", async () => {
  resetLlmState();
  const f = fakeLLM([chat(answer())]);
  const a = await withFetch(f, () => post(REQ, ON));
  const b = await withFetch(f, () => post(REQ, ON));
  eq([f.calls.length, a.body.reading.src, b.body.reading.src], [3, "llm", "kv"], "memory cache: 0 calls the second time, src kv");

  resetLlmState();
  const store = new Map();
  const KV = { get: async (k) => store.get(k) ?? null, put: async (k, v, o) => void store.set(k, v) || (KV.ttl = o?.expirationTtl) };
  const g = fakeLLM([chat(answer())]);
  await withFetch(g, () => post(REQ, { ...ON, READINGS: KV }));
  eq([g.calls.length, store.size], [3, 1], "KV: 3 calls the first time, 1 entry stored");
  ok(KV.ttl > 0, "KV entries are stored with a TTL");
  ok(![...store.values()].some((v) => v.includes(FAKE)), "negative: KV does not contain the key");
  resetLlmState(); // clear memory to simulate a different Worker instance
  const c = await withFetch(g, () => post(REQ, { ...ON, READINGS: KV }));
  eq([g.calls.length, c.body.reading.src, c.body.reading.advice], [3, "kv", { "Russell St": "use" }], "KV hit: no further calls, src kv");
  const other = await withFetch(g, () => post(REQ, { ...ON, READINGS: KV, LLM_MODEL: "deepseek-pro" }));
  eq([g.calls.length, other.body.reading.model], [6, "deepseek-pro"], "a different model = a different cache key, asked again");
  ok(
    (await cacheKey(NREQ, llmConfig(ON))) !== (await cacheKey(NREQ, llmConfig({ ...ON, LLM_MODEL: "x" }))),
    "the cache key includes the model name",
  );

  resetLlmState();
  const cache = new Map();
  const realCaches = globalThis.caches;
  globalThis.caches = {
    default: {
      match: async (u) => (cache.has(u) ? new Response(cache.get(u)) : undefined),
      put: async (u, res) => void cache.set(u, await res.text()),
    },
  };
  try {
    const h = fakeLLM([chat(answer())]);
    eq(llmStatus(ON).cache, "cache-api", "without KV, the built-in Workers Cache API is used");
    await withFetch(h, () => post(REQ, ON));
    ok([...cache.keys()].every((u) => u.startsWith("https://api.test/__cache/llm-read/")), "Cache API keys are fake same-origin URLs");
    resetLlmState();
    const d = await withFetch(h, () => post(REQ, ON));
    eq([h.calls.length, d.body.reading.src], [3, "kv"], "Cache API hit: no further calls");
  } finally {
    globalThis.caches = realCaches;
  }

  resetLlmState();
  const bad = fakeLLM([chat("nope")]);
  await withFetch(bad, () => post(fresh(), ON));
  const again = { ...REQ, signs: [{ kind: "vms", frames: [["USE", "RUSSELL ST", `SAVE ${seq}`, "MIN"]], read_s: 9 }] };
  await withFetch(bad, () => post(again, ON));
  eq(bad.calls.length, 6, "rule fallback readings are not cached (asked again next time)");
});

await sec("rate limit and circuit breaker (best effort per instance)", async () => {
  resetLlmState();
  const f = fakeLLM([chat(answer())]);
  const env = { ...ON, LLM_MAX_CALLS_PER_MIN: "3" };
  const a = await withFetch(f, () => post(fresh(), env));
  const b = await withFetch(f, () => post(fresh(), env));
  eq([a.body.reading.src, b.body.reading.src, b.body.reading.note, f.calls.length], ["llm", "rule", "llm_rate_limited", 3], "3 per minute: the second request goes straight to the rules, no call");

  resetLlmState();
  const g = fakeLLM([chat("", 401)]);
  for (let i = 0; i < 3; i++) await withFetch(g, () => post(fresh(), ON));
  const n = g.calls.length;
  const c = await withFetch(g, () => post(fresh(), ON));
  eq([n, g.calls.length, c.body.reading.note?.startsWith("llm_paused")], [9, 9, true], "3 consecutive failed readings → LLM paused (with a bad key, requests do not each wait for nothing)");
});

await sec("a request with no signs does not call the LLM", async () => {
  resetLlmState();
  const f = fakeLLM([chat(answer())]);
  const r = await withFetch(f, () => post({ ...REQ, signs: [] }, ON));
  eq([r.body.reading.src, r.body.reading.notice, f.calls.length], ["rule", 0, 0], "rule notice 0, 0 fetches");
});

await sec("negative (security): the key never appears in any response body, health or error message", async () => {
  // The provider echoes request headers in its error / fetch throws an exception containing the key / echoes it into content
  const echo = (init) => ({ ok: false, status: 401, json: async () => ({ error: `bad key ${init.headers.authorization}` }), text: async () => init.headers.authorization });
  const thrower = (init) => {
    throw new Error(`connect failed with ${init.headers.authorization}`);
  };
  for (const [name, reply] of [["401 echoes the headers", echo], ["fetch throws an error with the key", thrower]]) {
    resetLlmState();
    const f = fakeLLM([reply]);
    const r = await withFetch(f, () => post(fresh(), ON));
    ok(r.body.reading.src === "rule" && !r.text.includes(FAKE), `${name}: rule reading, no key in the response`);
    let msg = "";
    try {
      await askOnce(ON, llmConfig(ON), buildMessages(NREQ, 0), { fetch: f });
    } catch (e) {
      msg = `${e.message} ${e.stack} ${JSON.stringify(e)}`;
      ok(e instanceof LlmError, `${name}: askOnce throws LlmError (${e.code})`);
    }
    ok(msg && !msg.includes(FAKE), `${name}: no key in the error message / stack`);
  }
  const h = await call("/api/health", {}, ON);
  ok(!h.text.includes(FAKE) && !JSON.stringify(llmConfig(ON)).includes(FAKE), "neither health nor the config object contains the key value");
  resetLlmState();
  const f = fakeLLM([chat(answer())]);
  const r = await withFetch(f, () => post(fresh(), ON));
  ok(r.body.reading.src === "llm" && !r.text.includes(FAKE), "no key in a successful response either");
});

await sec("combine rules (prompts.md, \"Combining three samples into one reading\")", async () => {
  const cfg = llmConfig(ON);
  const s = (o) => ({ ...answer(o), persona: "commuter", src: "llm" });
  const x = combine([s({ advice: { "Russell St": "use" } }), s({ advice: { "Russell St": "avoid" } }), s({ advice: {} })], NREQ, cfg);
  eq(x.advice, { "Russell St": "avoid" }, "one use and one avoid → avoid");
  const y = combine([s({ advice: { "Russell St": "use", "Elizabeth St": "avoid" } }), s({ advice: { "Russell St": "use" } }), s({})], NREQ, cfg);
  eq(y.advice, { "Russell St": "use" }, "needs at least 2 agreeing samples; a road mentioned once is left out");
  const z = combine([s({ delay_min: 10 }), s({ delay_min: null }), s({ delay_min: null })], NREQ, cfg);
  eq(z.delay_min, null, "fewer than 2 non-null values → null");
  eq(combine([s({})], NREQ, cfg), null, "only 1 sample → null (the caller falls back to the rules)");
  const w = combine([s({ saving_min: 4 }), s({ saving_min: 7 })], NREQ, cfg);
  eq(w.saving_min, 6, "2 values: the midpoint (5.5 rounded)");
});

await sec("llmReading called directly (the same path the precompute tool uses)", async () => {
  const f = fakeLLM([chat(answer())]);
  const out = await llmReading(NREQ, ON, { fetch: f });
  eq([out.valid, out.calls, out.errors, out.reading.src], [3, 3, [], "llm"], "all 3 valid");
  const off = await serverReading(NREQ, { MOCK: "1", LLM_API_KEY: FAKE }, { fetch: f });
  eq([off.src, f.calls.length], ["rule", 3], "serverReading checks MOCK itself: no calls with MOCK=1");
});

await sec("negative (billing): global daily cap: many instances and cache-busting read_s values cannot exceed LLM_MAX_CALLS_PER_DAY", async () => {
  const f = fakeLLM([chat(answer())]);
  const BUDGET = budgetNs();
  const env = { ...ON, BUDGET, LLM_MAX_CALLS_PER_DAY: "30", LLM_MAX_CALLS_PER_MIN: "100000" };
  resetLlmState();
  const srcs = [];
  // Reproduces the review's attack: same sign text, only read_s changes, so every request is a new cache key; instance state is cleared every 5 requests = a new Worker instance
  for (let i = 0; i < 40; i++) {
    if (i % 5 === 0) resetLlmState();
    const r = await withFetch(f, () => post({ ...REQ, signs: [{ kind: "vms", frames: [["ROAD", "CLOSED"]], read_s: i }] }, env));
    srcs.push(r.body.reading.note || r.body.reading.src);
  }
  eq(f.calls.length, 30, "exactly 30 external calls (= the daily cap), none after that");
  eq(srcs.filter((x) => x === "llm").length, 10, "10 LLM readings (3 calls each)");
  ok(srcs.slice(10).every((x) => x === "llm_daily_cap"), `after the cap, all rules + llm_daily_cap (${[...new Set(srcs.slice(10))].join(", ")})`);
  eq(BUDGET.ids, ["global"], "all instances share one ledger (idFromName(\"global\"))");

  const before = BUDGET.calls;
  await withFetch(f, () => post(fresh(), env));
  eq(BUDGET.calls, before, "this instance knows today is used up: stops asking the DO each time");
});

await sec("the daily counter resets on the next UTC day; 0 = no calls at all", async () => {
  let t = Date.parse("2026-09-30T23:59:00Z");
  const BUDGET = budgetNs(() => t);
  const f = fakeLLM([chat(answer())]);
  const env = { ...ON, BUDGET, LLM_MAX_CALLS_PER_DAY: "3" };
  resetLlmState();
  const a = await withFetch(f, () => post(fresh(), env));
  resetLlmState();
  const b = await withFetch(f, () => post(fresh(), env));
  t += 120_000; // past 00:00 UTC
  resetLlmState();
  const c = await withFetch(f, () => post(fresh(), env));
  eq([a.body.reading.src, b.body.reading.note, c.body.reading.src, f.calls.length], ["llm", "llm_daily_cap", "llm", 6], "the 2nd reading of the day is blocked; the next day calls are allowed again");
  eq([...BUDGET.data.keys()].length, 1, "the DO stores a single entry (it does not grow by one per day)");

  resetLlmState();
  const g = fakeLLM([chat(answer())]);
  const z = await withFetch(g, () => post(fresh(), { ...ON, BUDGET: budgetNs(), LLM_MAX_CALLS_PER_DAY: "0" }));
  eq([z.body.reading.note, g.calls.length], ["llm_daily_cap", 0], "LLM_MAX_CALLS_PER_DAY=0 → no calls");
});

await sec("negative (billing): BUDGET unbound or DO error → no calls (never spend unrecorded money)", async () => {
  const f = fakeLLM([chat(answer())]);
  resetLlmState();
  const env = { MOCK: "0", LLM_API_KEY: FAKE };
  const a = await withFetch(f, () => post(fresh(), env));
  const h = await call("/api/health", {}, env);
  eq([a.body.reading.src, a.body.reading.note, h.body.llm.mode, h.body.llm.budget], ["rule", "llm_no_budget", "llm", false], "BUDGET unbound: rules + llm_no_budget; health says budget false");
  const boom = { idFromName: () => ({}), get: () => ({ fetch: async () => { throw new Error("do down"); } }) };
  const b = await withFetch(f, () => post(fresh(), { ...env, BUDGET: boom }));
  const bad = { idFromName: () => ({}), get: () => ({ fetch: async () => new Response("nope", { status: 500 }) }) };
  const c = await withFetch(f, () => post(fresh(), { ...env, BUDGET: bad }));
  eq([b.body.reading.note, c.body.reading.note], ["llm_budget_error", "llm_budget_error"], "DO throws / answers 500 → llm_budget_error");
  eq(f.calls.length, 0, "0 external fetches");
});

await sec("LlmBudget (the Durable Object itself)", async () => {
  const data = new Map();
  const d = new LlmBudget({ storage: { get: async (k) => data.get(k), put: async (k, v) => void data.set(k, v) } }, {}, () => Date.parse("2026-10-01T05:00:00Z"));
  const take = async (q) => (await d.fetch(new Request(`https://budget.internal/take?${q}`, { method: "POST" }))).json();
  eq(await take("n=3&max=5"), { ok: true, used: 3, max: 5, day: "2026-10-01" }, "reserve 3 of 5");
  eq(await take("n=3&max=5"), { ok: false, used: 3, max: 5, day: "2026-10-01" }, "3 more would exceed: refused, and nothing recorded");
  eq((await take("n=2&max=5")).ok, true, "2 more still fit");
  const bad = await d.fetch(new Request("https://budget.internal/take?n=-1&max=5", { method: "POST" }));
  eq(bad.status, 400, "invalid n → 400 (the caller treats it as an error and does not call)");
});

await sec("cache kind: the Cache API does nothing on *.workers.dev → health reports memory, and it is never written", async () => {
  const ops = [];
  const realCaches = globalThis.caches;
  globalThis.caches = {
    default: {
      match: async (u) => void ops.push(["match", u]),
      put: async (u) => void ops.push(["put", u]),
    },
  };
  try {
    const onDev = async (path, init, env) => {
      const r = await worker.fetch(new Request(`https://hackathon-site.example.workers.dev${path}`, init), env);
      return r.json();
    };
    eq((await onDev("/api/health", {}, ON)).llm.cache, "memory", "workers.dev: cache memory");
    eq((await call("/api/health", {}, ON)).body.llm.cache, "cache-api", "own domain: cache-api");
    const kv = { get: async () => null, put: async () => {} };
    eq((await onDev("/api/health", {}, { ...ON, READINGS: kv })).llm.cache, "kv", "with KV bound it is kv everywhere");
    resetLlmState();
    const f = fakeLLM([chat(answer())]);
    const r = await withFetch(f, () => onDev("/api/read", { method: "POST", body: JSON.stringify(fresh()) }, ON));
    eq([r.reading.src, ops.length], ["llm", 0], "readings work as usual on workers.dev and the Cache API is never touched");
  } finally {
    globalThis.caches = realCaches;
  }
});

done();
