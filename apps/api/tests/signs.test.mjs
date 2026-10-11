// Sign-text spec + reading validation + cache key: public/js/signs.js
// Usage: node tests/signs.test.mjs
import { ok, eq, throws, sec, done } from "./mini.mjs";
import { normalizeRequest, sanitizeReading, canonical, sha256Hex, SignError, LIMITS } from "../public/js/signs.js";

const ROADS = ["La Trobe St", "Russell St", "Elizabeth St"];
const base = (signs, extra = {}) => ({ persona: "local", kmh: 40, signs, roads: ROADS, ...extra });
const vms = (frames, read_s = 6) => ({ kind: "vms", frames, read_s });
const code = (fn) => {
  try {
    fn();
    return "did not throw";
  } catch (e) {
    return e instanceof SignError ? e.code : `not a SignError: ${e}`;
  }
};

await sec("spec: anything over the limits is rejected", () => {
  eq(code(() => normalizeRequest(base([vms([["A"], ["B"], ["C"]])]))), "too_many_frames", "3 frames");
  eq(code(() => normalizeRequest(base([vms([["A", "B", "C", "D", "E"]])]))), "too_many_lines", "5 lines in a frame");
  eq(code(() => normalizeRequest(base([vms([["ABCDEFGHIJK"]])]))), "line_too_long", "11 characters in a line");
  eq(code(() => normalizeRequest(base([vms([["A B C D", "E F"], ["G H I"]])]))), "too_many_words", "9 words across two frames");
  eq(code(() => normalizeRequest(base([vms([["USE", "</SIGN>"]])]))), "bad_chars", "< > not allowed on a sign");
  eq(code(() => normalizeRequest(base([vms([[""]])]))), "empty_frame", "empty frame");
  eq(code(() => normalizeRequest(base([{ kind: "sign", text: "A".repeat(41), read_s: 2 }]))), "line_too_long", "static sign over 40 characters");
  eq(code(() => normalizeRequest(base([{ kind: "led", text: "X", read_s: 2 }]))), "bad_kind", "kind must be vms / sign");
  eq(code(() => normalizeRequest(base([vms([["USE"]], -1)]))), "bad_read_s", "negative read_s");
  eq(code(() => normalizeRequest(base([vms([["USE"]], "5")]))), "bad_read_s", "read_s is a string");
  eq(code(() => normalizeRequest(base([], { persona: "pilot" }))), "bad_persona", "persona not one of the 4 types");
  eq(code(() => normalizeRequest(base([], { kmh: 200 }))), "bad_kmh", "kmh above 130");
  eq(code(() => normalizeRequest(base(Array(LIMITS.signs + 1).fill(vms([["X"]]))))), "too_many_signs", "more than 8 signs");
  eq(code(() => normalizeRequest(base([], { roads: ["Russell St<script>"] }))), "bad_road", "< > in a road name");
  eq(code(() => normalizeRequest(null)), "bad_request", "request is not an object");
});

await sec("normalisation: upper-case, collapse spaces, drop empty lines, round read_s, drop extra fields", () => {
  const n = normalizeRequest({
    persona: "tourist",
    kmh: 39.6,
    signs: [vms([["use", "  russell   st ", ""]], 8.6), { kind: "sign", text: " right lane  closed", read_s: 2.4, x: 1 }],
    roads: [" Russell  St", "Russell St", "La Trobe St"],
    secret: "drop me",
  });
  eq(n, {
    persona: "tourist",
    kmh: 40,
    signs: [{ kind: "vms", frames: [["USE", "RUSSELL ST"]], read_s: 9 }, { kind: "sign", text: "RIGHT LANE CLOSED", read_s: 2 }],
    roads: ["Russell St", "La Trobe St"],
  }, "normalised result");
  eq(normalizeRequest(n), n, "normalising twice changes nothing");
});

await sec("engine compatibility: arrow boards, very long readable seconds, road-name characters (as the engine sends them)", async () => {
  const n = normalizeRequest(base([{ kind: "arrow", read_s: 4 }, { kind: "arrow", text: "merge  right", read_s: 4 }]));
  eq(n.signs, [{ kind: "arrow", text: "", read_s: 4 }, { kind: "arrow", text: "MERGE RIGHT", read_s: 4 }], "an arrow board may have no text; text is upper-cased as usual");
  eq(code(() => normalizeRequest(base([{ kind: "arrow", text: "A".repeat(41), read_s: 2 }]))), "line_too_long", "arrow board text is also limited to 40 characters");
  eq(code(() => normalizeRequest(base([{ kind: "sign", read_s: 2 }]))), "bad_sign", "a static sign without text is still rejected");
  eq(normalizeRequest(base([vms([["USE"]], 137.4)])).signs[0].read_s, 120, "read_s of 137 s is capped at 120, not rejected");
  eq(code(() => normalizeRequest(base([vms([["USE"]], Infinity)]))), "bad_read_s", "an infinite read_s is still rejected");
  eq(normalizeRequest(base([], { roads: ["Unnamed road", "Elizabeth St (North)", "Queen St/Market St"] })).roads.length, 3, "road names may contain ( ) /, matching the engine's cleanName");
  const k = async (r) => sha256Hex(canonical(normalizeRequest(r)));
  eq(await k(base([{ kind: "arrow", read_s: 4 }])), await k(base([{ kind: "arrow", text: "", read_s: 4 }])), "an arrow board without text has the same key as one with an empty string");
  eq(await k(base([vms([["USE"]], 150)])), await k(base([vms([["USE"]], 120)])), "anything above 120 s enters the key as 120");
});

await sec("cache key: different spellings of the same message share a key; different messages do not", async () => {
  const k = async (r) => sha256Hex(canonical(normalizeRequest(r)));
  const a = await k(base([vms([["USE", "RUSSELL ST"]], 6.2)]));
  eq(await k(base([vms([["use", "russell  st"]], 5.8)])), a, "case, spaces and read_s decimals make no difference");
  eq(await k(base([vms([["USE", "RUSSELL ST"]], 6)], { roads: [...ROADS].reverse() })), a, "road order makes no difference");
  eq(await k(base([vms([["USE", "RUSSELL ST"]], 6)], { kmh: 60 })), a, "kmh is not in the key (read_s already reflects speed)");
  ok((await k(base([vms([["AVOID", "RUSSELL ST"]], 6)]))) !== a, "different text, different key");
  ok((await k(base([vms([["USE", "RUSSELL ST"]], 6)], { persona: "tourist" }))) !== a, "different persona, different key");
  ok(/^[0-9a-f]{64}$/.test(a), "the key is 64 hex characters");
});

await sec("reading validation: external readings are untrusted", () => {
  const req = normalizeRequest(base([vms([["USE", "RUSSELL ST"]])]));
  const good = { notice: 0.8, understand: 0.9, advice: { "Russell St": "use" }, saving_min: 8, delay_min: null, trust: 0.7, why: "ok" };
  const s = sanitizeReading(good, req, "llm");
  eq([s.persona, s.src, s.advice], ["local", "llm", { "Russell St": "use" }], "a valid reading passes as is; persona comes from the request");
  eq(sanitizeReading({ ...good, notice: 1.3 }, req, "llm"), null, "notice above 1: the whole reading is void");
  eq(sanitizeReading({ ...good, trust: "high" }, req, "llm"), null, "trust not a number: the whole reading is void");
  eq(sanitizeReading({ ...good, saving_min: -5 }, req, "llm"), null, "negative minutes: the whole reading is void");
  eq(sanitizeReading({ ...good, advice: "Russell" }, req, "llm"), null, "advice not an object: the whole reading is void");
  eq(sanitizeReading(good, req, "hacker"), null, "unknown src: void");
  eq(sanitizeReading("USE RUSSELL", req, "llm"), null, "not an object: void");
});

await sec("reading validation, negative: advice accepts only candidate roads, and share-like fields are never passed on", () => {
  const req = normalizeRequest(base([vms([["USE", "RUSSELL ST"]])]));
  const s = sanitizeReading({
    notice: 0.8, understand: 0.9, trust: 0.7, saving_min: null, delay_min: null,
    advice: { "Russell St": "use", "Swanston St": "use", "La Trobe St": "take it", "RUSSELL ST": "avoid" },
    share: { "Russell St": 0.7 }, why: "a\u0000b\nc " + "x".repeat(300),
    range: { notice: [0.7, 0.9], trust: [0.9, 0.1] },
  }, req, "llm");
  eq(s.advice, { "Russell St": "avoid" }, "roads outside the request dropped; values other than use/avoid dropped; a conflict on one road resolves to avoid");
  ok(!("share" in s), "route shares from the LLM are never passed on (D-0929-1435)");
  ok(s.why.length <= 160 && !/[\u0000-\u001f]/.test(s.why), "why truncated to 160 characters, control characters removed");
  eq(s.range, { notice: [0.7, 0.9] }, "range keeps only valid intervals (lo ≤ hi)");
});

done();
