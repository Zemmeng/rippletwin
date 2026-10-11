// Negative: every request the engine (apps/engine/public/js/reading.js) sends must be accepted, never throwing SignError
// The engine silently treats a readSigns error as "nobody persuaded", so a rejection here = a silently wrong result. Request shapes copied from the engine code as of 2026-09-29 15:20
// Usage: node tests/engine.test.mjs
import { ok, eq, sec, done } from "./mini.mjs";
import { readSigns, resetReader } from "../public/js/reader.js";

// As in the engine's cards.js: legible distance ÷ speed (with a 5 km/h minimum speed), rounded to the second
const legibleM = (charMm) => charMm * 0.6; // only to produce seconds of a realistic magnitude; the engine's coefficient is authoritative
const readSeconds = (kmh, charMm = 320) => Math.round(legibleM(charMm) / (Math.max(5, kmh) / 3.6));
// As cleanName in the engine's cards.js
const cleanName = (s) => String(s ?? "").replace(/[^A-Za-z0-9 .,'&/()-]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40) || "Unnamed road";

// As in the engine's reading.js: signsOn() orders vms / sign / arrow by position, at most 6, and request() drops m
function engineRequest(persona, kmh, equipment, street, alts) {
  const signs = equipment
    .filter((e) => e.type === "vms" || e.type === "sign" || e.type === "arrow")
    .map((e) => ({ kind: e.type, ...(e.type === "vms" ? { frames: e.frames } : { text: e.text }), read_s: readSeconds(kmh, e.type === "vms" ? e.char_mm : 200) }))
    .slice(-6);
  return { persona, kmh, signs, roads: [street, ...alts].map(cleanName) };
}

const EQUIP = [
  { type: "barrier" },
  { type: "arrow" }, // arrow only, no text
  { type: "arrow", text: "MERGE RIGHT" },
  { type: "sign", text: "RIGHT LANE CLOSED" },
  { type: "vms", frames: [["LA TROBE", "CLOSED"], ["USE", "RUSSELL ST"]], char_mm: 320 },
  { type: "vms", frames: [["ROADWORK", "AHEAD"]] },
];
const noFetch = { fetch: null }; // tests only the spec and rules, no network

await sec("every speed × 4 personas: all engine requests accepted", async () => {
  let n = 0;
  for (const kmh of [0, 5, 10, 40, 60]) {
    for (const persona of ["commuter", "local", "tourist", "delivery"]) {
      const req = engineRequest(persona, kmh, EQUIP, "La Trobe Street", ["Russell Street", "A'Beckett Street", "Unnamed (service) road?"]);
      resetReader();
      try {
        const r = await readSigns(req, noFetch);
        ok(r.src === "rule" && r.notice >= 0 && r.notice <= 1, `${kmh} km/h × ${persona}: valid reading`);
        n++;
      } catch (e) {
        ok(false, `${kmh} km/h × ${persona} rejected: ${e.code} ${e.message}`);
      }
    }
  }
  eq(n, 20, "all 20 requests have readings");
  ok(readSeconds(5) > 120, `precondition: at 5 km/h the engine's seconds (${readSeconds(5)}) really exceed 120`);
});

await sec("engine calibration anchors (calibrate.js)", async () => {
  for (const frames of [[["ROADWORK", "AHEAD"]], [["USE", "RUSSELL ST"]]]) {
    const r = await readSigns({
      persona: "local", kmh: 40,
      signs: [{ kind: "vms", frames, read_s: 9 }, { kind: "sign", text: "RIGHT LANE CLOSED", read_s: 9 }],
      roads: ["La Trobe Street", "Russell Street", "Elizabeth Street"],
    }, noFetch);
    ok(r.src === "rule", `${frames.flat().join(" / ")}: accepted`);
  }
});

await sec("reading an arrow board: noticed, but no road advice", async () => {
  resetReader();
  const r = await readSigns({ persona: "tourist", kmh: 40, signs: [{ kind: "arrow", read_s: 4 }], roads: ["La Trobe Street", "Russell Street"] }, noFetch);
  ok(r.notice > 0, "notice > 0");
  eq(r.advice, {}, "advice is empty");
});

done();
