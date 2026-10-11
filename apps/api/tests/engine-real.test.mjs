// Integration: the real engine (apps/engine) + the real road network (apps/roads) + readSigns() (rules, no network)
// The engine silently treats a readSigns() error as "nobody persuaded", so this counts readSigns errors: must be 0, and prepare's failed must be 0 too
// Only reads other modules, never changes them. If the engine changes its exports or request shape this fails: the interfaces disagree, so align them before merging
// Usage: node tests/engine-real.test.mjs
import { existsSync, readFileSync } from "node:fs";
import { ok, eq, sec, done } from "./mini.mjs";
import { readSigns, resetReader } from "../public/js/reader.js";

const engineUrl = new URL("../../engine/public/js/index.js", import.meta.url);
const roadsDir = new URL("../../roads/public/cbd/", import.meta.url);

if (!existsSync(engineUrl) || !existsSync(new URL("network.json", roadsDir))) {
  console.log("⏭ skipped: apps/engine or the apps/roads network is missing");
} else {
  const { createEngine, affected, capFactors } = await import(engineUrl.href);
  const network = JSON.parse(readFileSync(new URL("network.json", roadsDir), "utf8"));
  const flows = JSON.parse(readFileSync(new URL("flows.json", roadsDir), "utf8"));

  let calls = 0;
  const errors = [];
  const t5 = async (req) => {
    calls++;
    try {
      return await readSigns(req, { fetch: null }); // no network: skips the answers file and /api/read, straight to the rules
    } catch (e) {
      errors.push(`${e.code}: ${e.message}`);
      throw e;
    }
  };

  const WHEN = { date: "2026-10-06", hour: 17 };
  const LINK = "l2177124610_2190478926"; // Bourke Street eastbound, two lanes (the same link the engine e2e test uses)
  const eng = createEngine({ network, flows, readSigns: t5 });
  const [ap] = affected(eng.net, flows, { id: "R", links: [LINK], closes: { lanes: 1 } }, WHEN, capFactors(eng.net, [{ links: [LINK], closes: { lanes: 1 } }]));
  const best = ap.alts[0];
  const stem = best.name.split(" ")[0].toUpperCase().slice(0, 10);
  const plan = (equipment) => ({
    when: WHEN,
    worksites: [{ id: "R", links: [LINK], closes: { lanes: 1 }, time: { from: "2026-10-05", to: "2026-10-09", hours: [7, 19] }, equipment }],
  });

  await sec("real engine prepare: VMS + static sign + two arrow boards (one without text); readSigns never throws", async () => {
    resetReader();
    const p = plan([
      { id: "vms1", type: "vms", at_m: Math.round(best.diverge_m) + 100, frames: [["USE", stem, "SAVE 3 MIN"]] },
      { id: "s1", type: "sign", at_m: 80, text: "RIGHT LANE CLOSED" },
      { id: "a1", type: "arrow", at_m: 60 },
      { id: "a2", type: "arrow", at_m: 40, text: "MERGE LEFT" },
      { id: "b1", type: "barrier", at_m: 0 },
    ]);
    const out = await eng.prepare(p);
    eq(errors, [], "readSigns threw 0 times");
    eq(out.failed, 0, `prepare: asked ${out.asked}, failed = 0`);
    ok(calls > 0, `readSigns was really called (${calls} times)`);
    const r = eng.evaluate(p);
    eq(r.missing ?? 0, 0, "evaluate: no missing readings");
    const byType = r.approaches[0].by_type;
    ok(Object.values(byType).every((b) => b.reading && b.reading.src === "rule"), "every persona's reading comes from readSigns (src: rule)");
    const told = byType.commuter.reading.advice[best.name];
    eq(told, "use", `sign says USE ${stem} → the engine gets advice "${best.name}: use"`);
  });

  await sec("control: with sign text over the spec (11 characters) the engine misses readings for that link; the sign editor must block it first with checkSigns()", async () => {
    resetReader();
    errors.length = 0;
    const p = plan([{ id: "vms1", type: "vms", at_m: Math.round(best.diverge_m) + 100, frames: [["ROADWORKS AH"]] }]);
    const out = await eng.prepare(p);
    ok(errors.length > 0 && errors.every((e) => e.startsWith("line_too_long")), `readSigns rejected ${errors.length} times (line_too_long)`);
    ok(out.failed > 0, `prepare failed = ${out.failed}: the engine treats it as missing readings and does not crash`);
  });
}

done();
