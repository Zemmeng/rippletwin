// Precompute demo readings → public/answers/demo.json (the browser's readSigns() checks this file first: the demo works offline, costs nothing and never waits)
// Requests: fixtures/demo-signs.json (8 messages × 4 personas) + the requests the engine's two demo plans actually send (lonsdale / latrobe in backend.js: run, before/after compare, advisor)
// LLM calls take the same path as the Worker (llmReading in src/llm.js: 3 samples, combine, sanitise)
//
// Usage (D-09: no spending by default):
//   node apps/api/tools/precompute.mjs                 dry run: only prints how many requests, how many calls and the rough cost
//   node --env-file=apps/api/.dev.vars apps/api/tools/precompute.mjs --run [--limit N]
//                                                      real calls (key from the LLM_API_KEY environment variable; DEEPSEEK_API_KEY also works for DeepSeek)
//   node apps/api/tools/precompute.mjs --check         only validate demo.json (keys match, readings valid, no key-like strings)
// Other options: --no-engine demo messages only; --force re-ask entries already at this version; --out <path> write elsewhere; --concurrency N parallel requests (default 4)
// Base URL and model: LLM_BASE_URL / LLM_MODEL environment variables > vars in apps/api/wrangler.jsonc > DeepSeek defaults
// 🔒 Never prints or writes the key; errors are short codes only
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeRequest, canonical, sha256Hex, sanitizeReading, SignError } from "../public/js/signs.js";
import { ruleReading } from "../public/js/rules.js";
import { PROMPT } from "../src/prompt.js";
import { llmConfig, llmReading, buildMessages, SAMPLES } from "../src/llm.js";
import { parseJsonc } from "./jsonc.mjs";

const API = new URL("..", import.meta.url);
const APPS = new URL("../..", import.meta.url);
export const ANSWERS = fileURLToPath(new URL("public/answers/demo.json", API));
const FIXTURES = new URL("fixtures/demo-signs.json", API);

// DeepSeek deepseek-flash prices (per million tokens, CNY; docs/hackathon/llm-apis/jinmingq-deepseek.md §1, tested 2026-09-29). Half price off-peak
const PRICE = { deepseek: { in: 2, out: 8, offpeak: 0.5, src: "docs/hackathon/llm-apis/jinmingq-deepseek.md" } };
const OUT_TOKENS = 120; // estimated output tokens per call (prompts.md, "Cost estimate")

// ---------------------------------------------------------------- collect requests

// /<module>/public/<path> → apps/<module>/public/<path>: lets backend.js read the network, flows and parameters in Node
const fileFetch = async (u) => {
  const m = String(u).match(/^\/([a-z0-9_-]+)\/public\/([A-Za-z0-9_./-]+)$/);
  if (!m || m[2].includes("..")) return { ok: false, status: 404, json: async () => null };
  const p = new URL(`${m[1]}/public/${m[2]}`, APPS);
  if (!existsSync(p)) return { ok: false, status: 404, json: async () => null };
  const text = readFileSync(p, "utf8");
  return { ok: true, status: 200, json: async () => JSON.parse(text) };
};

async function engineRequests() {
  const B = await import(new URL("engine/public/js/backend.js", APPS).href);
  const { checkSigns } = await import(new URL("public/js/check.js", API).href);
  const out = [];
  let from = "";
  const capture = async (req) => {
    out.push({ from, req });
    return ruleReading(req); // only so the engine can finish; no LLM call
  };
  const be = await B.connect({ fetch: fileFetch, readSigns: capture, checkSigns });
  for (const name of B.DEMO_NAMES) {
    from = `engine:${name}:run`;
    await be.run(be.demo(name));
    from = `engine:${name}:compare`;
    await be.compare(be.demo(name, { frames: [["ROADWORK", "AHEAD"]] }), be.demo(name));
    from = `engine:${name}:advise`;
    await be.advise(be.demo(name));
  }
  return out;
}

function fixtureRequests() {
  const fx = JSON.parse(readFileSync(FIXTURES, "utf8"));
  return fx.messages.flatMap((m) => fx.personas.map((persona) => ({ from: `fixture:${m.id}`, req: { persona, kmh: fx.kmh, signs: m.signs, roads: fx.roads } })));
}

// → [{ from, req (normalised), key }], de-duplicated by canonical string
export async function collectRequests({ engine = true, log = console.log } = {}) {
  const raw = fixtureRequests();
  if (engine) {
    try {
      raw.push(...(await engineRequests()));
    } catch (e) {
      log(`⚠️ Could not collect the engine demo requests (using the demo messages only): ${e?.message || e}`);
    }
  }
  const seen = new Map();
  for (const { from, req } of raw) {
    let n;
    try {
      n = normalizeRequest(req);
    } catch (e) {
      if (e instanceof SignError) {
        log(`⚠️ Skipping an invalid request (${from}): ${e.code}`);
        continue;
      }
      throw e;
    }
    const c = canonical(n);
    if (!seen.has(c)) seen.set(c, { from, req: n, key: await sha256Hex(c) });
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------- config

function workerVars() {
  try {
    return parseJsonc(readFileSync(new URL("wrangler.jsonc", API), "utf8")).vars || {};
  } catch {
    return {};
  }
}

// env for precompute: MOCK=0 is forced (the tool itself only calls with --run); the timeout is relaxed to 20 s (an offline run, no rush)
function llmEnv(env) {
  const vars = workerVars();
  const base = env.LLM_BASE_URL || vars.LLM_BASE_URL;
  const model = env.LLM_MODEL || vars.LLM_MODEL;
  const probe = llmConfig({ MOCK: "0", LLM_API_KEY: "x", LLM_BASE_URL: base, LLM_MODEL: model });
  const key = env.LLM_API_KEY || (probe.provider === "deepseek" ? env.DEEPSEEK_API_KEY : "") || "";
  return { MOCK: "0", LLM_API_KEY: key, LLM_BASE_URL: base, LLM_MODEL: model, LLM_TIMEOUT_MS: env.LLM_TIMEOUT_MS || "20000" };
}

function loadAnswers(path) {
  if (!existsSync(path)) return { note: "", prompt_v: PROMPT.v, answers: {} };
  const data = JSON.parse(readFileSync(path, "utf8"));
  if (!data || typeof data !== "object" || !data.answers || typeof data.answers !== "object") throw new Error(`${path} is not in the { answers: {…} } format`);
  return data;
}

const fresh = (entry, cfg) => entry?.reading?.prompt_v === PROMPT.v && entry?.reading?.model === cfg.model;

// ---------------------------------------------------------------- three modes

function dryRun(items, todo, cfg, log) {
  const inChars = todo.reduce((s, it) => s + [0, 1, 2].reduce((t, i) => t + buildMessages(it.req, i).reduce((u, m) => u + m.content.length, 0), 0), 0);
  const calls = todo.length * SAMPLES;
  const inTok = Math.ceil(inChars / 4);
  const outTok = calls * OUT_TOKENS;
  log(`To ask: ${todo.length} requests (${items.length} in total, ${items.length - todo.length} already in the file at this version) → ${todo.length} × ${SAMPLES} = ${calls} calls`);
  log(`Token estimate: about ${inTok.toLocaleString("en")} input (characters ÷ 4) · about ${outTok.toLocaleString("en")} output (${OUT_TOKENS} per call)`);
  const p = PRICE[cfg.provider];
  if (p) {
    const peak = (inTok * p.in + outTok * p.out) / 1e6;
    log(`Cost estimate (${cfg.model} prices, source ${p.src}): about ¥${peak.toFixed(2)} at peak, about ¥${(peak * p.offpeak).toFixed(2)} off-peak`);
  } else {
    log(`Cost: apply the ${cfg.model} price list to the token counts above (only DeepSeek prices are built in)`);
  }
  log("This is a dry run: no calls, nothing spent. Before a real run, report the call count and cost above to the team, then:");
  log("  node --env-file=apps/api/.dev.vars apps/api/tools/precompute.mjs --run --limit 2   # try 2 requests first");
  log("  node --env-file=apps/api/.dev.vars apps/api/tools/precompute.mjs --run            # then the full set");
  return 0;
}

async function run(items, todo, cfg, env, path, data, { fetch, log, concurrency, now }) {
  if (!env.LLM_API_KEY) {
    log("❌ No LLM_API_KEY (environment variable). Use node --env-file=apps/api/.dev.vars … or export it first; keep the key on your machine, never in the repo");
    return 1;
  }
  let ok = 0;
  let failed = 0;
  const save = () => {
    data.prompt_v = PROMPT.v;
    data.model = cfg.model;
    data.generated = now();
    writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
  };
  for (let i = 0; i < todo.length; i += concurrency) {
    const chunk = todo.slice(i, i + concurrency);
    const outs = await Promise.all(chunk.map((it) => llmReading(it.req, env, { fetch })));
    chunk.forEach((it, j) => {
      const o = outs[j];
      if (o.reading) {
        data.answers[it.key] = { req: it.req, reading: o.reading, from: it.from };
        ok++;
      } else {
        failed++;
        log(`  ✗ ${it.from} · ${it.req.persona}: ${o.valid}/${o.calls} valid (${[...new Set(o.errors)].join(", ")})`);
      }
    });
    save(); // save after every batch: if interrupted, the money already spent is not wasted
    log(`  … ${Math.min(i + concurrency, todo.length)}/${todo.length}`);
  }
  log(`${failed ? "⚠️" : "✅"} wrote ${ok}, failed ${failed} → ${path} (failed ones use /api/read or the rules in the demo)`);
  log(`   about ${todo.length * SAMPLES} calls: record what was spent, then run --check`);
  return failed ? 1 : 0;
}

// Keys match, readings valid, no key-like strings
export async function check(path, { log = console.log, env = {} } = {}) {
  let text;
  let data;
  try {
    text = readFileSync(path, "utf8");
    data = JSON.parse(text);
  } catch (e) {
    log(`❌ cannot read ${path}: ${e?.message || e}`);
    return 1;
  }
  const bad = [];
  if (!data || typeof data.answers !== "object" || !data.answers || Array.isArray(data.answers)) bad.push("the top level must have an answers object");
  const entries = Object.entries(data?.answers || {});
  let stale = 0;
  for (const [k, e] of entries) {
    let n;
    try {
      n = normalizeRequest(e?.req);
    } catch (err) {
      bad.push(`${k.slice(0, 12)}…: invalid req (${err?.code || err})`);
      continue;
    }
    if ((await sha256Hex(canonical(n))) !== k) bad.push(`${k.slice(0, 12)}…: key does not match req (did answerKey change?)`);
    if (!sanitizeReading(e?.reading, n, "file")) bad.push(`${k.slice(0, 12)}…: reading fails sanitizeReading`);
    if (e?.reading?.prompt_v !== PROMPT.v) stale++;
  }
  if (/(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/=-]{16,}/.test(text)) bad.push("the file contains a key-like string");
  const key = env.LLM_API_KEY || env.DEEPSEEK_API_KEY;
  if (key && text.includes(key)) bad.push("the file contains the key value");
  for (const b of bad) log(`  ✗ ${b}`);
  if (stale) log(`⚠️ ${stale} readings come from an older prompt (not ${PROMPT.v}): still usable; to refresh, use --run --force`);
  log(`${bad.length ? "❌" : "✅"} ${path}: ${entries.length} readings, ${bad.length} problems`);
  return bad.length ? 1 : 0;
}

function args(argv) {
  const o = { run: argv.includes("--run"), check: argv.includes("--check"), engine: !argv.includes("--no-engine"), force: argv.includes("--force") };
  const val = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  o.limit = Number(val("--limit")) || Infinity;
  o.concurrency = Math.max(1, Math.min(8, Number(val("--concurrency")) || 4));
  o.out = val("--out");
  return o;
}

// deps: { fetch, env, log, now } (tests inject a fake fetch and env)
export async function main(argv = process.argv.slice(2), deps = {}) {
  const log = deps.log || console.log;
  const penv = deps.env || process.env;
  const o = args(argv);
  const path = o.out ? resolve(o.out) : ANSWERS;
  if (o.check) return check(path, { log, env: penv });

  const env = llmEnv(penv);
  const cfg = llmConfig(env);
  if (!cfg.baseOk) {
    log("❌ Invalid LLM_BASE_URL: it must be https://… with no credentials or query string (the value is not printed in case it contains a key)");
    return 1;
  }
  const items = await collectRequests({ engine: o.engine, log });
  const data = loadAnswers(path);
  const todo = items.filter((it) => o.force || !fresh(data.answers[it.key], cfg)).slice(0, o.limit);
  log(`Precompute demo readings · prompt_v ${PROMPT.v} · ${cfg.model} @ ${new URL(cfg.baseUrl).host} · key ${env.LLM_API_KEY ? "set" : "missing"}`);
  const n = (p) => items.filter((it) => it.from.startsWith(p)).length;
  log(`${items.length} requests after de-duplication (demo messages ${n("fixture:")} · engine demo plans ${n("engine:")})`);
  if (!o.run) return dryRun(items, todo, cfg, log);
  return run(items, todo, cfg, env, path, data, {
    fetch: deps.fetch || globalThis.fetch,
    log,
    concurrency: o.concurrency,
    now: deps.now || (() => new Date().toISOString()),
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.log(`❌ ${e?.message || e}`);
      process.exit(1);
    },
  );
}
