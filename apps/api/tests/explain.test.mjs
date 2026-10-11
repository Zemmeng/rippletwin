// Plan explanation (public/js/explain.js + POST /api/explain): normalisation, rule-based version, number traceability, sanitising external explanations, real engine results
// Negative assertions: every number in an explanation traces back to the engine; sentences with invented numbers are dropped; an external explanation cannot remove rule-based risks; no "chosen for you" field in the response
// Usage: node tests/explain.test.mjs; no npm install needed
import { existsSync, readFileSync } from "node:fs";
import { ok, eq, sec, done } from "./mini.mjs";
import worker from "../src/worker.js";
import {
  normalizeExplainRequest, ruleExplain, sanitizeExplain, allowedNumbers, numbersIn, totalOf, optionFromRun, explainOptions, ExplainError,
} from "../public/js/explain.js";
import { readSigns } from "../public/js/reader.js";

const codeOf = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof ExplainError ? e.code : `not ExplainError: ${e?.message}`;
  }
};

const A = {
  id: "o1", label: "Warning only",
  metrics: { delay_veh_min: 10493, queue_m: 918, mean_delay_s: 509, detour_share: 0.14, transit_pax_min: 18693, hire_aud: 900, days: 5 },
  per_capita_min: { commuter: 3.9, local: 4.4, tourist: 5.1, delivery: 3.0, transit: 2.2 },
  flags: { params_assumed: true, reading_rules: true },
};
const B = {
  id: "o2", label: "Add USE RUSSELL ST",
  metrics: { delay_veh_min: 5746, queue_m: 548, mean_delay_s: 244, detour_share: 0.35, transit_pax_min: 11206, hire_aud: 900, days: 5 },
  per_capita_min: { commuter: 1.9, local: 2.4, tourist: 3.1, delivery: 1.5, transit: 1.3 },
  flags: { params_assumed: true, reading_rules: true },
};
const C = {
  id: "o3", label: "Full closure at night",
  metrics: { delay_veh_min: 2100, queue_m: 0, mean_delay_s: 90, detour_share: 1, transit_pax_min: 0, transit_blocked_pax_h: 640, blocked_vph: 35, hire_aud: 1500, days: 3 },
  per_capita_min: { commuter: 1.2, pedestrian: 0.4 },
};
const REQ = { lang: "en", options: [A, B, C] };

// All human-readable text in an explanation
const texts = (x) => [
  ...x.options.flatMap((o) => [o.summary, ...o.pros, ...o.cons, ...o.risks, o.hardest_hit?.text || ""]),
  x.lean?.why || "",
];
const untraceable = (x, req) => {
  const allowed = allowedNumbers(normalizeExplainRequest(req));
  return texts(x).flatMap((t) => numbersIn(t).filter((n) => !allowed.has(n) && !allowed.has(String(Number(n)))).map((n) => `${n} ← ${t}`));
};

await sec("request normalisation", () => {
  const n = normalizeExplainRequest({ options: [{ ...A, metrics: { ...A.metrics, secret: 1 }, per_capita_min: { ...A.per_capita_min, ceo: 9 }, flags: { params_assumed: "yes" }, extra: "x" }] });
  eq(n.lang, "en", "English by default");
  ok(!("secret" in n.options[0].metrics) && !("ceo" in n.options[0].per_capita_min) && !("extra" in n.options[0]), "unknown metrics, groups and fields are dropped");
  eq(n.options[0].flags, { params_assumed: false, reading_rules: false }, "flags accept only true");
  eq(codeOf(() => normalizeExplainRequest({ lang: "fr", options: [A] })), "bad_lang", "unknown lang");
  eq(codeOf(() => normalizeExplainRequest({ options: [] })), "bad_options", "0 plans");
  eq(codeOf(() => normalizeExplainRequest({ options: [A, B, C, { ...A, id: "o4" }, { ...A, id: "o5" }, { ...A, id: "o6" }] })), "bad_options", "more than 5 plans");
  eq(codeOf(() => normalizeExplainRequest({ options: [A, { ...B, id: "o1" }] })), "bad_options", "duplicate id");
  eq(codeOf(() => normalizeExplainRequest({ options: [{ ...A, label: "<b>x</b>" }] })), "bad_text", "negative: label contains < >");
  eq(codeOf(() => normalizeExplainRequest({ options: [{ ...A, metrics: { queue_m: -3 } }] })), "bad_number", "negative number");
  eq(codeOf(() => normalizeExplainRequest({ options: [{ ...A, metrics: { detour_share: 1.4 } }] })), "bad_number", "detour share above 1");
  eq(codeOf(() => normalizeExplainRequest({ options: [{ ...A, metrics: { queue_m: "918" } }] })), "bad_number", "number written as a string");
});

await sec("rule-based version: pros, cons, hardest-hit group, risks, lean", () => {
  const x = ruleExplain(REQ);
  eq(x.src, "rule", "src rule");
  const [a, b, c] = x.options;
  ok(a.cons.some((t) => /Highest network delay \(10,493/.test(t)) && a.cons.some((t) => /Highest queue/.test(t)), "Warning only: highest network delay and queue");
  ok(c.pros.some((t) => /Lowest network delay \(2,100/.test(t)) && c.cons.some((t) => /Highest equipment hire/.test(t)), "night closure: lowest delay but highest hire cost");
  ok(a.pros.some((t) => /Lowest equipment hire \(900/.test(t)) && b.pros.some((t) => /Lowest equipment hire \(900/.test(t)), "ties for lowest all count (two plans at 900, cheaper than the third)");
  eq(a.hardest_hit.group, "tourist", "Warning only hits visitors hardest (5.1 min each)");
  eq(c.hardest_hit.group, "commuter", "with only commuters and pedestrians given, uses what is given");
  ok(c.risks.some((t) => /Trams or buses stop running: about 640/.test(t)) && c.risks.some((t) => /no detour: about 35/.test(t)), "stopped service and no way around appear in the risks");
  ok(c.risks.some((t) => /100% of drivers detour/.test(t)), "a detour share above half appears in the risks");
  ok(a.risks.some((t) => /assumptions/.test(t)) && a.risks.some((t) => /keyword-rule/.test(t)), "assumed inputs and rule-based sign reading appear in the risks");
  eq(totalOf(normalizeExplainRequest(REQ).options[2]), 2100, "total = vehicle-minutes + passenger-minutes + pedestrian-minutes");
  eq(x.lean.option, "o3", "leans towards the plan with the lowest total");
  ok(/not weighted by occupancy/.test(x.lean.why) && /not the cheapest/.test(x.lean.why) && /Check its risks/.test(x.lean.why), "the lean explains the summing method, hire cost and risks");
  ok(/chooses the plan/.test(x.decide), "always states that a person decides");
  const keys = JSON.stringify(Object.keys(x)) + JSON.stringify(Object.keys(x.lean));
  ok(!/final|chosen|selected|decision|approved/i.test(keys), `negative: no "chosen for you" field in the response: ${keys}`);
  eq(untraceable(x, REQ), [], "negative: every number in the English explanation traces back to the request");
  const z = ruleExplain({ ...REQ, lang: "zh" });
  ok(z.options[0].cons.some((t) => t.startsWith("全网延误最多（10,493 车·分钟）")) && /由负责人决定/.test(z.decide), "Chinese version");
  eq(untraceable(z, { ...REQ, lang: "zh" }), [], "negative: every number in the Chinese explanation is traceable");
});

await sec("one plan only, or missing numbers: no forced comparison", () => {
  const one = ruleExplain({ options: [A] });
  eq([one.options[0].pros, one.options[0].cons, one.lean], [[], [], null], "one plan: no pros or cons, no lean");
  const tie = ruleExplain({ options: [A, { ...A, id: "o2", label: "Same" }] });
  eq([tie.options[0].pros.length, tie.lean], [0, null], "two identical plans: no forced ranking");
  const gap = ruleExplain({ options: [A, { ...B, metrics: { queue_m: 548 } }] });
  eq(gap.lean, null, "one plan lacks network delay: no totals, no lean");
});

await sec("external explanations (from the LLM) are untrusted", () => {
  const raw = {
    options: [
      { id: "o1", summary: "Warning only keeps 918 m of queue.", pros: ["Cheap to set up"], cons: ["Queue grows to 1,200 m at 8:30", "Visitors lose 5.1 min each"], risks: [] },
      { id: "o2", summary: "Saves 12 minutes for everyone", pros: ["<script>alert(1)</script>", "Queue drops to 548 m"], cons: [], risks: ["Detour via Russell St may clog"] },
      { id: "o3", summary: "Night closure", pros: [], cons: [], risks: [] },
    ],
    lean: { option: "o2", why: "Queue drops from 918 m to 548 m." },
    final: "o2",
  };
  const s = sanitizeExplain(raw, REQ, "llm");
  eq(s.options[0].cons, ["Visitors lose 5.1 min each"], "negative: sentences with invented numbers (1,200 m, 8:30) dropped, traceable ones kept");
  eq(s.options[1].summary, ruleExplain(REQ).options[1].summary, "a summary with an invented number → replaced by the rule-based summary");
  eq(s.options[1].pros, ["Queue drops to 548 m"], "negative: sentences containing < > are dropped");
  ok(s.options[2].risks.some((t) => /Trams or buses stop running/.test(t)), "negative: an external explanation cannot remove the rule-based stopped-service risk");
  eq(s.options[0].hardest_hit.group, "tourist", "the hardest-hit group comes from engine numbers, not from outside");
  eq(s.lean, { option: "o2", why: "Queue drops from 918 m to 548 m." }, "a traceable lean and reason are kept");
  ok(!("final" in s), "negative: an external final field is dropped");
  eq(sanitizeExplain({ ...raw, lean: { option: "o9", why: "x" } }, REQ, "llm").lean, null, "a lean pointing at a non-existent plan → discarded");
  eq(sanitizeExplain({ options: raw.options.slice(0, 2) }, REQ, "llm"), null, "a missing plan → the whole explanation is void (the caller uses the rule-based version)");
  eq(sanitizeExplain("nope", REQ, "llm"), null, "not an object → void");
});

await sec("POST /api/explain", async () => {
  const post = (body, raw) => worker.fetch(new Request("https://site.test/api/explain", { method: "POST", headers: { "content-type": "application/json" }, body: raw ?? JSON.stringify(body) }), {});
  const r = await post(REQ);
  const b = await r.json();
  eq([r.status, b.ok, b.explain.src, b.explain.lean.option], [200, true, "rule", "o3"], "200 · rule-based version");
  eq((await worker.fetch(new Request("https://site.test/api/explain"), {})).status, 405, "GET → 405");
  const bj = await post(null, "{");
  eq([bj.status, (await bj.json()).error], [400, "bad_json"], "bad JSON → 400");
  const bo = await post({ options: [] });
  eq([bo.status, (await bo.json()).error], [400, "bad_options"], "no plans → 400 code");
  eq((await post(null, JSON.stringify({ options: [{ ...A, label: "x".repeat(9000) }] }))).status, 413, "> 8KB → 413");
});

await sec("browser-side explainOptions (fake fetch)", async () => {
  const reply = (body) => async () => ({ ok: true, status: 200, json: async () => body });
  const fromApi = await explainOptions(REQ, { fetch: reply({ ok: true, explain: ruleExplain(REQ) }) });
  eq([fromApi.src, fromApi.lean.option], ["rule", "o3"], "API reachable → uses the API answer");
  const off = await explainOptions(REQ, { fetch: async () => { throw new Error("offline"); } });
  eq([off.src, off.lean.option], ["rule", "o3"], "offline → rule-based version in the browser");
  const liar = ruleExplain(REQ);
  liar.options[0].pros = ["Cuts delay by 99%"];
  const cleaned = await explainOptions(REQ, { fetch: reply({ ok: true, explain: { ...liar, src: "llm" } }) });
  eq([cleaned.src, cleaned.options[0].pros], ["llm", []], "negative: API text is sanitised too, invented numbers dropped (src llm as given by the API)");
  const odd = await explainOptions(REQ, { fetch: reply({ ok: true, explain: { ...ruleExplain(REQ), src: "gpt" } }) });
  eq(odd.src, "api", "an unknown src is recorded as api");
  let code = null;
  try {
    await explainOptions({ options: [] }, { fetch: reply({}) });
  } catch (e) {
    code = e.code;
  }
  eq(code, "bad_options", "an invalid request throws straight away (a caller bug) and is not hidden behind the rules");
});

const engineUrl = new URL("../../engine/public/js/index.js", import.meta.url);
const backendUrl = new URL("../../engine/public/js/backend.js", import.meta.url);
const roadsDir = new URL("../../roads/public/cbd/", import.meta.url);
if (!existsSync(engineUrl) || !existsSync(backendUrl) || !existsSync(new URL("network.json", roadsDir))) {
  console.log("⏭ skipping the real-engine section: apps/engine or apps/roads is missing");
} else {
  await sec("real engine: Lonsdale with ROADWORK AHEAD only vs adding USE RUSSELL ST (engine → optionFromRun → rule-based explanation)", async () => {
    const { createEngine } = await import(engineUrl.href);
    const { summarize, demoPlan } = await import(backendUrl.href);
    const network = JSON.parse(readFileSync(new URL("network.json", roadsDir), "utf8"));
    const flows = JSON.parse(readFileSync(new URL("flows.json", roadsDir), "utf8"));
    const eng = createEngine({ network, flows, readSigns: (r) => readSigns(r, { fetch: null }) });
    const run = async (plan) => {
      const prep = await eng.prepare(plan);
      return summarize(eng.evaluate(plan), { failed: prep.failed, params: eng.params });
    };
    const warn = await run(demoPlan("lonsdale", { frames: [["ROADWORK", "AHEAD"]] }));
    const use = await run(demoPlan("lonsdale"));
    const req = { lang: "zh", options: [optionFromRun("warn", "Warning only", warn), optionFromRun("use", "Add a USE RUSSELL ST frame", use)] };
    const n = normalizeExplainRequest(req);
    ok(n.options.every((o) => o.metrics.delay_veh_min > 0 && o.metrics.queue_m >= 0), "optionFromRun picks up network delay and queue");
    eq(Object.keys(n.options[0].per_capita_min).sort(), ["commuter", "delivery", "local", "tourist"], "per-capita minutes for all four driver types are present");
    const x = ruleExplain(req);
    ok(use.delay_min < warn.delay_min, `engine: network delay drops with the extra frame (${warn.delay_min} → ${use.delay_min})`);
    eq(x.lean?.option, "use", "leans towards the plan with the extra frame");
    eq(untraceable(x, req), [], "negative: in an explanation written from real engine numbers, every number is traceable");
    console.log(`    ${x.options[0].summary}\n    ${x.options[1].summary}\n    lean: ${x.lean?.why}`);
  });
}

done();
