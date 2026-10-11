// Smoke test: starts the Worker in the real Workers runtime (workerd) with wrangler's unstable_dev, using the wrangler.jsonc config
// Checks /api/health, /api/read, 400, static assets (reader.js, answers/demo.json) and the Durable Object daily counter: what calling fetch() directly in Node cannot cover (config, bindings, bundling)
// Usage: cd apps/api && npm i, then node tests/workerd.test.mjs; skipped when wrangler is not installed (CI and anyone without npm i are unaffected)
// 🔒 Hermetic: every variable is overridden explicitly via vars, so whether MOCK in wrangler.jsonc is 0 or 1 and whether a local .dev.vars holds a real key,
//    the result is the same, and no real provider is ever contacted (the second Worker's LLM URL is a fake server in this process). config.test.mjs checks these lines stay
import { createServer } from "node:http";
import { ok, eq, sec, done } from "./mini.mjs";

const here = new URL("..", import.meta.url).pathname;
let unstable_dev;
try {
  ({ unstable_dev } = await import("wrangler"));
} catch {
  console.log("⏭ skipped: wrangler not installed (run cd apps/api && npm i, then try again)");
}

// vars override wrangler.jsonc and .dev.vars (verified); persist:false = DO counters live only in memory and start from 0 each time
const OFF = { MOCK: "1", LLM_API_KEY: "" };
const start = (vars) =>
  unstable_dev("src/worker.js", {
    config: "wrangler.jsonc",
    ip: "127.0.0.1",
    logLevel: "error",
    vars,
    persist: false,
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true },
  });

const REQ = {
  persona: "commuter",
  kmh: 40,
  signs: [{ kind: "vms", frames: [["USE", "RUSSELL ST", "SAVE 8 MIN"]], read_s: 9 }],
  roads: ["La Trobe St", "Russell St", "Elizabeth St"],
};
const postTo = (worker, body) =>
  worker.fetch("/api/read", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

if (unstable_dev) {
  process.chdir(here);
  const worker = await start(OFF);
  const post = (body) => postTo(worker, body);
  try {
    await sec("GET /api/health (the test forces MOCK=1 and no key, whatever wrangler.jsonc / .dev.vars say)", async () => {
      const r = await worker.fetch("/api/health");
      const b = await r.json();
      eq([r.status, b.ok, b.mock], [200, true, true], "200 · ok · mock");
      eq([b.llm?.mode, b.llm?.key], ["rules", false], "negative: even with a key in a local .dev.vars, this is key:false, mode rules (no spending)");
      eq(b.llm?.budget, true, "the BUDGET Durable Object from wrangler.jsonc is bound");
    });

    await sec("POST /api/read", async () => {
      const r = await post(REQ);
      const b = await r.json();
      eq([r.status, b.ok, b.reading.src], [200, true, "rule"], "200 · rule reading");
      eq([b.reading.advice, b.reading.saving_min], [{ "Russell St": "use" }, 8], "advice · saving_min");
      const bad = await post({ ...REQ, signs: [{ kind: "vms", frames: [["A", "B", "C", "D", "E"]], read_s: 6 }] });
      eq([bad.status, (await bad.json()).error], [400, "too_many_lines"], "5 lines → 400");
      const nope = await worker.fetch("/api/nope");
      eq([nope.status, (await nope.json()).error], [404, "not_found"], "unknown endpoint → 404 JSON");
      const big = await worker.fetch("/api/read", { method: "POST", body: "x".repeat(9000) });
      eq(big.status, 413, "> 8KB → 413");
    });

    await sec("static assets: the browser can fetch reader.js and the answers file", async () => {
      const js = await worker.fetch("/js/reader.js");
      ok(js.status === 200 && /javascript/.test(js.headers.get("content-type") || ""), "reader.js 200 and JavaScript");
      ok((await js.text()).includes("export async function readSigns"), "reader.js content is correct");
      const ans = await worker.fetch("/answers/demo.json");
      eq([ans.status, typeof (await ans.json()).answers], [200, "object"], "answers/demo.json 200");
    });

    await sec("worksite register: a real Durable Object in workerd (persist:false, not saved to disk)", async () => {
      const h = await (await worker.fetch("/api/health")).json();
      eq(h.register, true, "the REGISTER binding from wrangler.jsonc is bound");
      const ws = {
        title: "workerd smoke",
        links: ["l595594354_9756035316"],
        closes: { lanes: 1 },
        time: { from: "2026-10-12", to: "2026-10-13", hours: [9, 15] },
      };
      const c = await worker.fetch("/api/worksites", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ws) });
      const cb = await c.json();
      eq([c.status, cb.worksite?.seed], [201, false], "POST → 201");
      const lt = await (await worker.fetch("/api/worksites")).text();
      const lb = JSON.parse(lt);
      eq([lb.register, lb.n], ["do", 4], "list = 3 seeds + 1 new entry");
      ok(!lt.includes(cb.edit_token), "negative: no edit_token in the list");
      const patch = (token) =>
        worker.fetch(`/api/worksites/${cb.worksite.id}`, { method: "PATCH", headers: { "content-type": "application/json", "x-edit-token": token }, body: JSON.stringify({ status: "assessed" }) });
      eq((await patch("0".repeat(32))).status, 403, "wrong token → 403");
      const p = await patch(cb.edit_token);
      eq([p.status, (await p.json()).worksite?.status], [200, "assessed"], "correct token → 200");
      const js = await worker.fetch("/js/worksites.js");
      ok(js.status === 200 && (await js.text()).includes("export async function listWorksites"), "the browser-side worksites.js can be fetched");
    });

    await sec("plan explanation POST /api/explain (rule-based version)", async () => {
      const opt = (id, label, delay) => ({ id, label, metrics: { delay_veh_min: delay, queue_m: delay / 10 } });
      const r = await worker.fetch("/api/explain", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ lang: "zh", options: [opt("a", "Warning only", 10000), opt("b", "Add a USE RUSSELL ST frame", 5000)] }) });
      const b = await r.json();
      eq([r.status, b.explain?.src, b.explain?.lean?.option], [200, "rule", "b"], "200 · rule-based version · leans towards the plan with less delay");
      const js = await worker.fetch("/js/explain.js");
      ok(js.status === 200 && (await js.text()).includes("export async function explainOptions"), "the browser-side explain.js can be fetched");
      const pk = await worker.fetch("/js/pack.js");
      ok(pk.status === 200 && (await pk.text()).includes("export function buildPack"), "the browser-side pack.js (execution pack) can be fetched");
    });
  } finally {
    await worker.stop();
  }

  // Second Worker: LLM on, but pointed at a fake server in this process (fake key), 3 calls per day → checks the Durable Object really caps calls in workerd
  const FAKE = ["fake", "workerd", "key", "91c2"].join("-");
  const hits = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || "{}") });
      const content = JSON.stringify({ notice: 0.8, understand: 0.9, advice: { "Russell St": "use" }, saving_min: 8, delay_min: null, trust: 0.7, why: "fake upstream" });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const llm = await start({
    MOCK: "0",
    LLM_API_KEY: FAKE,
    LLM_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    LLM_MODEL: "deepseek-flash",
    LLM_MAX_CALLS_PER_DAY: "3",
    LLM_MAX_CALLS_PER_MIN: "60",
  });
  try {
    await sec("Durable Object daily cap in workerd (fake provider, no real calls)", async () => {
      const h = await (await llm.fetch("/api/health")).text();
      const hb = JSON.parse(h);
      eq([hb.llm.mode, hb.llm.key, hb.llm.budget, hb.llm.per_day], ["llm", true, true, 3], "health: llm · key true · budget true · 3 per day");
      ok(!h.includes(FAKE), "negative: health does not contain the key value");
      const a = await (await postTo(llm, REQ)).text();
      const b = await (await postTo(llm, REQ)).text();
      const other = { ...REQ, signs: [{ kind: "vms", frames: [["AVOID", "RUSSELL ST"]], read_s: 9 }] };
      const c = await (await postTo(llm, other)).text();
      const [ra, rb, rc] = [a, b, c].map((t) => JSON.parse(t).reading);
      eq([ra.src, rb.src, rc.src, rc.note], ["llm", "kv", "rule", "llm_daily_cap"], "1st reading asks the LLM · same message comes from the cache · a new message is over the cap and falls back to the rules");
      eq(hits.length, 3, "the fake provider receives only 3 calls");
      ok(hits.every((x) => x.url === "/chat/completions" && x.auth === `Bearer ${FAKE}`), "POST /chat/completions with Bearer");
      eq(hits[0].body.thinking, { type: "disabled" }, "deepseek-* gets thinking disabled");
      ok(![a, b, c].some((t) => t.includes(FAKE)), "negative: reading responses do not contain the key value");
    });
  } finally {
    await llm.stop();
    server.close();
  }
}

done();
