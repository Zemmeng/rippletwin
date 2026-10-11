// Precompute tool tools/precompute.mjs: dry run by default (no spending); --run writes the file with a fake fetch; --check validates; readSigns() can really use the written file
// Usage: node tests/precompute.test.mjs (offline: every fetch is fake)
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok, eq, sec, done } from "./mini.mjs";
import { main, check, collectRequests, ANSWERS } from "../tools/precompute.mjs";
import { readSigns, resetReader, answerKey } from "../public/js/reader.js";
import { PROMPT } from "../src/prompt.js";

const FAKE = ["fake", "k3y", "for", "tests", "7f3a9c"].join("-");
const dir = mkdtempSync(join(tmpdir(), "precompute-"));
const out = join(dir, "demo.json");

const answer = { notice: 0.8, understand: 0.9, advice: { "Russell Street": "use" }, saving_min: 4, delay_min: null, trust: 0.7, why: "Use Russell" };
function fakeLLM() {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(answer) } }] }) };
  };
  f.calls = calls;
  return f;
}
const logger = () => {
  const lines = [];
  const log = (s) => lines.push(String(s));
  log.text = () => lines.join("\n");
  return log;
};

try {
  await sec("negative (billing): dry run by default: reports counts and cost only, 0 fetches", async () => {
    const f = fakeLLM();
    const log = logger();
    const code = await main(["--no-engine", "--out", out], { fetch: f, env: { LLM_API_KEY: FAKE }, log });
    eq([code, f.calls.length], [0, 0], "exit code 0, 0 fetches");
    ok(/To ask: 32 requests.*32 × 3 = 96 calls/.test(log.text()), "reports request and call counts (8 messages × 4 personas × 3 samples)");
    ok(/about ¥\d+\.\d\d at peak/.test(log.text()), "reports the cost at DeepSeek prices");
    ok(!log.text().includes(FAKE), "negative: no key in the output");
  });

  await sec("--run without a key: refused, no calls", async () => {
    const f = fakeLLM();
    const log = logger();
    eq(await main(["--run", "--no-engine", "--out", out], { fetch: f, env: {}, log }), 1, "exit code 1");
    eq(f.calls.length, 0, "0 fetches");
  });

  await sec("--run (fake fetch): 3 samples combined, written to the file, key = answerKey", async () => {
    const f = fakeLLM();
    const log = logger();
    const code = await main(["--run", "--no-engine", "--limit", "2", "--out", out], { fetch: f, env: { LLM_API_KEY: FAKE }, log, now: () => "2026-09-29T00:00:00Z" });
    eq([code, f.calls.length], [0, 6], "2 requests × 3 = 6 calls");
    ok(f.calls.every((c) => c.body.thinking?.type === "disabled"), "uses the same call layer as the Worker (DeepSeek with thinking disabled)");
    const data = JSON.parse(readFileSync(out, "utf8"));
    const entries = Object.entries(data.answers);
    eq([entries.length, data.prompt_v, data.model], [2, PROMPT.v, "deepseek-flash"], "wrote 2 entries, with prompt_v and model");
    for (const [k, e] of entries) {
      eq(k, await answerKey(e.req), `key = answerKey(req) (${e.from})`);
      eq([e.reading.src, e.reading.range?.notice], ["llm", [0.8, 0.8]], "the reading comes from the LLM, with range");
    }
    const all = readFileSync(out, "utf8") + log.text();
    ok(!all.includes(FAKE), "negative: no key in the file or the output");
    const again = logger();
    await main(["--no-engine", "--out", out], { fetch: f, env: {}, log: again });
    ok(/To ask: 30 requests/.test(again.text()), "readings already asked at this version are not asked again (dry run leaves 30)");
  });

  await sec("the browser's readSigns() can really use the written file (src file, no API call)", async () => {
    const data = JSON.parse(readFileSync(out, "utf8"));
    const [e] = Object.values(data.answers);
    resetReader();
    const hits = [];
    const f = async (url) => {
      hits.push(url);
      return url === "https://t/answers.json" ? { ok: true, status: 200, json: async () => data } : { ok: false, status: 500, json: async () => ({}) };
    };
    const r = await readSigns(e.req, { fetch: f, answersUrl: "https://t/answers.json", apiBase: "https://t" });
    eq([r.src, r.advice, hits], ["file", { "Russell Street": "use" }, ["https://t/answers.json"]], "file hit, /api/read not called");
  });

  await sec("--check: a good file passes, bad files are rejected", async () => {
    const quiet = logger();
    eq(await check(out, { log: quiet }), 0, "the freshly written file passes");
    eq(await check(ANSWERS, { log: quiet }), 0, "the repo's public/answers/demo.json passes");
    const data = JSON.parse(readFileSync(out, "utf8"));
    const [k, e] = Object.entries(data.answers)[0];
    const bad = join(dir, "bad.json");
    const put = (d) => writeFileSync(bad, JSON.stringify(d));
    put({ ...data, answers: { ["0".repeat(64)]: e } });
    eq(await check(bad, { log: quiet }), 1, "key does not match req → rejected");
    put({ ...data, answers: { [k]: { ...e, reading: { ...e.reading, notice: 3 } } } });
    eq(await check(bad, { log: quiet }), 1, "invalid reading → rejected");
    put({ ...data, leak: ["sk", "abcdefghijklmnopqrstuvwx"].join("-") });
    eq(await check(bad, { log: quiet }), 1, "key-like string → rejected");
    put({ ...data, leak: FAKE });
    eq(await check(bad, { log: quiet, env: { LLM_API_KEY: FAKE } }), 1, "contains the key value → rejected");
  });

  await sec("engine demo requests are collected too (lonsdale / latrobe run, before/after compare, advisor)", async () => {
    const log = logger();
    const items = await collectRequests({ engine: true, log });
    const eng = items.filter((i) => i.from.startsWith("engine:"));
    ok(eng.length > 0, `collected ${eng.length} engine requests (${items.length} in total)${log.text() ? "; " + log.text() : ""}`);
    ok(eng.some((i) => i.from.startsWith("engine:lonsdale:")) && eng.some((i) => i.from.startsWith("engine:latrobe:")), "both demo plans are present");
    eq(new Set(items.map((i) => i.key)).size, items.length, "de-duplicated by canonical string");
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

done();
