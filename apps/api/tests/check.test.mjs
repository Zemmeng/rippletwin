// Soft warnings for the sign-text editor, checkSigns() (public/js/check.js) + the demo message list (fixtures/demo-signs.json) + real network road names
// Usage: node tests/check.test.mjs
import { readFileSync } from "node:fs";
import { ok, eq, sec, done } from "./mini.mjs";
import { checkSigns } from "../public/js/check.js";
import { ruleReading } from "../public/js/rules.js";

const ROADS = ["La Trobe Street", "Russell Street", "Lonsdale Street", "Little Lonsdale Street", "A'Beckett Street"];
const req = (signs) => ({ persona: "tourist", kmh: 40, signs, roads: ROADS });
const vms = (frames, read_s = 9) => ({ kind: "vms", frames, read_s });
const codes = (r) => r.warnings.map((w) => w.code);

await sec("over the spec: ok=false + code, no throw", () => {
  const r = checkSigns(req([vms([["ABCDEFGHIJK"]])]));
  eq([r.ok, r.error.code, r.warnings], [false, "line_too_long", []], "11 characters");
  eq(checkSigns(null).error.code, "bad_request", "a non-object request does not throw either");
});

await sec("soft warnings: within the spec but hard to read", () => {
  eq(codes(checkSigns(req([vms([["USE", "RUSSELL ST"]])]))), [], "easy to read: no warnings");
  eq(codes(checkSigns(req([vms([["ROADWORKS", "AHEAD"]])]))), ["long_line"], "a 9-character line (not a road name)");
  eq(codes(checkSigns(req([vms([["USE", "A'BECKETT"]])]))), [], "a line that is a whole road name: no warning even at 9 characters");
  eq(codes(checkSigns(req([vms([["A", "B", "C", "D"]])]))), ["many_lines"], "4 lines");
  eq(codes(checkSigns(req([vms([["LA TROBE", "CLOSED"], ["USE", "RUSSELL ST"]], 3)]))), ["frames_too_fast", "short_read"], "two frames with only 3 s to read");
  eq(codes(checkSigns(req([vms([["LA TROBE", "CLOSED"], ["USE", "RUSSELL ST"]], 4)]))), ["short_read"], "two frames, 4 s: one full cycle fits, but 5 words cannot be read");
  eq(codes(checkSigns(req([vms([["RD WKS", "AHD"]])]))), ["odd_abbrev"], "non-standard abbreviation");
  eq(codes(checkSigns(req([vms([["RD WKS AHD"]])]))), ["long_line", "odd_abbrev"], "a 10-character abbreviated line: both warnings");
  const w = checkSigns(req([vms([["USE"]]), vms([["RD WKS", "AHD"]])])).warnings;
  eq(w.map((x) => x.sign), [1], "each warning records which sign it is for");
  ok(w.every((x) => typeof x.msg === "string" && x.msg.length > 0), "each has a human-readable msg");
});

await sec("road-name spellings on the real network (network.json uses full names)", () => {
  const adv = (lines) => ruleReading(req([vms([lines])])).advice;
  eq(adv(["USE", "RUSSELL ST"]), { "Russell Street": "use" }, "ST matches Street");
  eq(adv(["USE", "A'BECKETT"]), { "A'Beckett Street": "use" }, "with an apostrophe");
  eq(adv(["USE LITTLE", "LONSDALE"]), { "Little Lonsdale Street": "use" }, "Little Lonsdale takes precedence over Lonsdale");
  eq(adv(["USE", "LONSDALE"]), { "Lonsdale Street": "use" }, "LONSDALE alone is Lonsdale Street");
});

await sec("demo message list: every message is within the spec and the rule readings make sense", () => {
  const demo = JSON.parse(readFileSync(new URL("../fixtures/demo-signs.json", import.meta.url), "utf8"));
  ok(demo.messages.length >= 6, "at least 6 messages");
  eq(new Set(demo.messages.map((m) => m.id)).size, demo.messages.length, "unique ids");
  const roads = JSON.parse(readFileSync(new URL("../../roads/public/cbd/network.json", import.meta.url), "utf8"));
  const names = new Set(roads.links.map((l) => l.name));
  for (const r of demo.roads) ok(names.has(r), `road name ${r} exists in network.json`);
  for (const m of demo.messages) {
    for (const persona of demo.personas) {
      const r = checkSigns({ persona, kmh: demo.kmh, signs: m.signs, roads: demo.roads });
      ok(r.ok, `${m.id} × ${persona} within the spec${r.ok ? "" : `: ${r.error.msg}`}`);
    }
  }
  const byId = Object.fromEntries(demo.messages.map((m) => [m.id, ruleReading({ persona: "local", kmh: demo.kmh, signs: m.signs, roads: demo.roads })]));
  eq(byId.plain.advice, {}, "plain: no advice");
  eq(byId["use-russell"].advice, { "Russell Street": "use" }, "use-russell");
  eq(byId["closed-use"].advice, { "Russell Street": "use", "La Trobe Street": "avoid" }, "closed-use");
  eq(byId["delay-only"].delay_min, 15, "delay-only: 15 minutes");
});

done();
