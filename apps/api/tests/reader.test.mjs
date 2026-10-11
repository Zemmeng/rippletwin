// readSigns() resolution order: answers file → /api/read → rules. fetch is always injected; no network access
// Usage: node tests/reader.test.mjs
import { ok, eq, sec, done } from "./mini.mjs";
import { readSigns, resetReader, answerKey, SignError } from "../public/js/reader.js";
import { ruleReading } from "../public/js/rules.js";

const REQ = {
  persona: "commuter",
  kmh: 40,
  signs: [{ kind: "vms", frames: [["USE", "RUSSELL ST", "SAVE 8 MIN"]], read_s: 9 }],
  roads: ["La Trobe St", "Russell St", "Elizabeth St"],
};
const LLM = {
  notice: 0.85, understand: 0.9, advice: { "Russell St": "use", "La Trobe St": "avoid" }, saving_min: 8, delay_min: null,
  trust: 0.7, why: "Sign says Russell saves 8 min", range: { notice: [0.8, 0.9] }, model: "m", prompt_v: "r1",
};
const OPTS = { answersUrl: "https://t/answers.json", apiBase: "https://t", timeoutMs: 200 };

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// Fake fetch: dispatches by URL and records every call
function fakeFetch({ answers = {}, api }) {
  const calls = [];
  const f = async (url, init) => {
    calls.push(url);
    if (url === OPTS.answersUrl) return res(200, { answers });
    if (url === `${OPTS.apiBase}/api/read`) return api(JSON.parse(init.body), init);
    return res(404, {});
  };
  f.calls = calls;
  return f;
}

await sec("in the answers file: used directly, no API call", async () => {
  resetReader();
  const key = await answerKey(REQ);
  const f = fakeFetch({ answers: { [key]: { reading: LLM } }, api: () => res(200, { ok: true, reading: { ...LLM, src: "llm" } }) });
  const r = await readSigns(REQ, { ...OPTS, fetch: f });
  eq(r.src, "file", "src is file");
  eq(r.advice, LLM.advice, "the reading comes from the file");
  ok(!f.calls.includes(`${OPTS.apiBase}/api/read`), "/api/read not called");
});

await sec("not in the file: calls /api/read, src as given by the API", async () => {
  resetReader();
  let sent = null;
  const f = fakeFetch({ api: (body) => ((sent = body), res(200, { ok: true, reading: { ...LLM, src: "kv" } })) });
  const r = await readSigns(REQ, { ...OPTS, fetch: f });
  eq(r.src, "kv", "src is kv");
  eq(r.range, { notice: [0.8, 0.9] }, "range is passed back");
  eq(sent.signs[0].frames, [["USE", "RUSSELL ST", "SAVE 8 MIN"]], "the API receives the normalised request");
});

await sec("API down / timed out / invalid answer: rules every time", async () => {
  const cases = [
    ["500", () => res(500, { ok: false })],
    ["network error", () => { throw new Error("offline"); }],
    ["timeout", (_b, init) => new Promise((_r, rej) => init.signal.addEventListener("abort", () => rej(new Error("abort"))))],
    ["notice out of range", () => res(200, { ok: true, reading: { ...LLM, notice: 7, src: "llm" } })],
    ["bogus src", () => res(200, { ok: true, reading: { ...LLM, src: "file" } })],
    ["not a JSON object", () => res(200, "USE RUSSELL")],
  ];
  const rule = ruleReading(REQ);
  for (const [name, api] of cases) {
    resetReader();
    const r = await readSigns(REQ, { ...OPTS, fetch: fakeFetch({ api }) });
    eq(r, rule, `${name} → rule reading`);
  }
});

await sec("an environment without fetch (Node cannot fetch relative paths by default): straight to the rules", async () => {
  resetReader();
  const r = await readSigns(REQ, { fetch: null });
  eq(r.src, "rule", "src is rule");
});

await sec("same message and persona: fetched once per session; callers get a copy", async () => {
  resetReader();
  const f = fakeFetch({ api: () => res(200, { ok: true, reading: { ...LLM, src: "llm" } }) });
  const a = await readSigns(REQ, { ...OPTS, fetch: f });
  a.advice["Russell St"] = "avoid"; // mutating the result must not pollute the cache
  const b = await readSigns({ ...REQ, kmh: 60, signs: [{ ...REQ.signs[0], read_s: 9.2 }] }, { ...OPTS, fetch: f });
  eq(f.calls.filter((u) => u.endsWith("/api/read")).length, 1, "/api/read called only once");
  eq(b.advice["Russell St"], "use", "the second result is not polluted by changes to the first");
});

await sec("invalid request: throws SignError instead of hiding it behind the rules", async () => {
  resetReader();
  let err = null;
  try {
    await readSigns({ ...REQ, signs: [{ kind: "vms", frames: [["ABCDEFGHIJK"]], read_s: 3 }] }, { ...OPTS, fetch: fakeFetch({ api: () => res(500) }) });
  } catch (e) {
    err = e;
  }
  ok(err instanceof SignError && err.code === "line_too_long", "throws SignError(line_too_long)");
});

done();
