// Worksite register pure functions + browser client (public/js/worksites.js): normalisation, whitelist, time overlap, seed worksites, engine format
// Usage: node tests/worksites.test.mjs; no npm install needed
import { existsSync, readFileSync } from "node:fs";
import { ok, eq, sec, done } from "./mini.mjs";
import {
  normalizeWorksite, applyPatch, timeOverlap, overlapping, inWindow, parseQuery, selectWorksites, toEngineWorksite,
  listWorksites, createWorksite, updateWorksite, SEEDS, WorksiteError, WS_LIMITS,
} from "../public/js/worksites.js";

const BASE = {
  title: "Test closure",
  links: ["l595594354_9756035316"],
  closes: { lanes: 1 },
  time: { from: "2026-10-05", to: "2026-10-09", hours: [7, 19] },
};
const codeOf = (fn) => {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof WorksiteError ? e.code : `not WorksiteError: ${e?.message}`;
  }
};
const rejects = (patch, code, msg) => eq(codeOf(() => normalizeWorksite({ ...BASE, ...patch })), code, msg);

await sec("seed worksites", async () => {
  eq(SEEDS.map((s) => s.id), ["W-LONSDALE", "W-LATROBE", "W-LTLBOURKE"], "3 entries with unique ids");
  ok(SEEDS.every((s) => s.seed === true && s.created === null), "all marked seed: true");
  const roads = new URL("../../roads/public/cbd/network.json", import.meta.url);
  if (existsSync(roads)) {
    const ids = new Set(JSON.parse(readFileSync(roads, "utf8")).links.map((l) => l.id));
    ok(SEEDS.every((s) => s.links.every((id) => ids.has(id))), "all link ids exist in the roads network.json");
  }
  const eng = new URL("../../engine/public/js/worksite.js", import.meta.url);
  if (existsSync(eng)) {
    const { validateWorksite, overlaps } = await import(eng.href);
    eq(SEEDS.flatMap((s) => validateWorksite(toEngineWorksite(s))), [], "after conversion to the engine format, the engine's validateWorksite() has no complaints");
    const pairs = SEEDS.flatMap((a) => SEEDS.map((b) => [a, b]));
    ok(pairs.every(([a, b]) => timeOverlap(a, b) === overlaps(toEngineWorksite(a), toEngineWorksite(b))), "timeOverlap() agrees with the engine's overlaps()");
  }
  const lon = SEEDS[0];
  eq(overlapping(lon, SEEDS).map((s) => s.id), ["W-LATROBE", "W-LTLBOURKE"], "Lonsdale overlaps the other two in time (not itself)");
  eq(overlapping(lon, SEEDS.map((s) => (s.id === "W-LTLBOURKE" ? { ...s, status: "withdrawn" } : s))).map((s) => s.id), ["W-LATROBE"], "withdrawn entries do not count");
});

await sec("normalisation: defaults and tidying", () => {
  const w = normalizeWorksite(BASE);
  eq([w.kind, w.status, w.time.hours, w.equipment, w.decision, w.closes.footpath], ["other", "draft", [7, 19], [], null, null], "defaults: other · draft · no equipment · no decision · footpath open");
  eq(normalizeWorksite({ ...BASE, time: { from: "2026-10-05", to: "2026-10-05" } }).time.hours, [0, 24], "no hours = all day");
  eq(normalizeWorksite({ ...BASE, title: "  Lonsdale \n  St   works " }).title, "Lonsdale St works", "title whitespace collapsed");
  eq(normalizeWorksite({ ...BASE, links: ["a", "b", "a"] }).links, ["a", "b"], "links de-duplicated");
  eq(normalizeWorksite({ ...BASE, closes: { lanes: 1, footpath: "none" } }).closes.footpath, null, "footpath none → null");
  const eqp = normalizeWorksite({ ...BASE, equipment: [{ id: "V", type: "vms", at_m: 299.6, frames: [["use", "russell  st"]] }, { id: "A", type: "arrow", at_m: 60 }, { id: "B", type: "barrier", at_m: 0, text: "IGNORED" }] }).equipment;
  eq(eqp, [{ id: "V", type: "vms", at_m: 300, frames: [["USE", "RUSSELL ST"]] }, { id: "A", type: "arrow", at_m: 60 }, { id: "B", type: "barrier", at_m: 0 }], "VMS upper-cased · at_m rounded · arrow board may have no text · barrier carries no text");
});

await sec("negative: fields outside the whitelist are dropped (no personal data stored, and the client cannot set id / seed)", () => {
  const w = normalizeWorksite({ ...BASE, id: "W-LONSDALE", seed: true, email: "someone@example.com", owner: "Alice", created: "2020-01-01T00:00:00Z", th: "x" });
  eq(Object.keys(w).sort(), ["closes", "decision", "equipment", "kind", "links", "status", "time", "title"], "only whitelisted fields remain");
  ok(!JSON.stringify(w).includes("example.com") && !JSON.stringify(w).includes("Alice"), "no email or name in the result");
  const e = normalizeWorksite({ ...BASE, equipment: [{ id: "S", type: "sign", at_m: 1, text: "ROAD CLOSED", secret: "x", url: "http://evil" }] }).equipment[0];
  eq(Object.keys(e).sort(), ["at_m", "id", "text", "type"], "equipment keeps only known fields too");
});

await sec("invalid input → WorksiteError code", () => {
  rejects({ title: "" }, "bad_title", "empty title");
  rejects({ title: "x".repeat(WS_LIMITS.title + 1) }, "bad_title", "title too long");
  rejects({ title: "<img src=x onerror=alert(1)>" }, "bad_text", "negative: a title with < > is rejected (the web page builds templates with innerHTML)");
  rejects({ title: "a\u0007b" }, "bad_text", "control characters rejected");
  rejects({ kind: "party" }, "bad_kind", "unknown kind");
  rejects({ status: "approved" }, "bad_status", "unknown status");
  rejects({ status: "decided" }, "bad_status", "decided without a decision");
  rejects({ links: [] }, "bad_links", "no links");
  rejects({ links: ["a b"] }, "bad_links", "link id contains a space");
  rejects({ links: Array.from({ length: WS_LIMITS.links + 1 }, (_, i) => `l${i}`) }, "bad_links", "too many links");
  rejects({ closes: null }, "bad_closes", "no closes");
  rejects({ closes: { lanes: 9 } }, "bad_closes", "9 lanes closed");
  rejects({ closes: { lanes: 1.5 } }, "bad_closes", "lane count not an integer");
  rejects({ closes: { lanes: 0 } }, "bad_closes", "nothing closed");
  rejects({ closes: { lanes: 1, footpath: "north" } }, "bad_closes", "footpath given as a compass direction");
  rejects({ time: { from: "2026-10-09", to: "2026-10-05" } }, "bad_time", "start after end");
  rejects({ time: { from: "2026-02-30", to: "2026-03-01" } }, "bad_time", "30 February");
  rejects({ time: { from: "2026-01-01", to: "2027-06-01" } }, "bad_time", "works longer than a year");
  rejects({ time: { from: "2026-10-05", to: "2026-10-09", hours: [19, 7] } }, "bad_time", "hours crossing midnight (must be split into two entries)");
  rejects({ time: { from: "2026-10-05", to: "2026-10-09", hours: [7.5, 19] } }, "bad_time", "hours not whole");
  rejects({ equipment: [{ id: "A", type: "sign", at_m: 1, text: "X" }, { id: "A", type: "sign", at_m: 2, text: "Y" }] }, "bad_equipment", "duplicate equipment id");
  rejects({ equipment: [{ id: "C", type: "cone", at_m: 1 }] }, "bad_equipment", "unknown equipment type");
  rejects({ equipment: [{ id: "C", type: "barrier", at_m: 5000 }] }, "bad_equipment", "at_m too far");
  rejects({ equipment: [{ id: "C", type: "sign", at_m: -5000, text: "END ROADWORK" }] }, "bad_equipment", "too far downstream as well");
  eq(normalizeWorksite({ ...BASE, equipment: [{ id: "E", type: "sign", at_m: -43, text: "END ROADWORK" }] }).equipment[0].at_m, -43, "negative = downstream of the start of the works (interfaces spec; END ROADWORK sits at the end of the works)");
  rejects({ equipment: [{ id: "V", type: "vms", at_m: 1, frames: [["A", "B", "C", "D", "E"]] }] }, "too_many_lines", "VMS with 5 lines (reuses the signs.js code)");
  rejects({ equipment: [{ id: "V", type: "vms", at_m: 1, frames: [["ROADWORKSAHEAD"]] }] }, "line_too_long", "VMS line over 10 characters");
  rejects({ equipment: [{ id: "V", type: "vms", at_m: 1, frames: [["<B>"]] }] }, "bad_chars", "negative: < > on the sign");
  rejects({ equipment: [{ id: "S", type: "sign", at_m: 1, text: "" }] }, "empty_sign", "sign with no text");
  rejects({ equipment: [{ id: "S", type: "sign", at_m: 1, text: "X", dir: "north" }] }, "bad_equipment", "dir given as a word");
  rejects({ decision: { option: "o1", by: "admin" } }, "bad_decision", "the decision maker must be contractor / council");
  rejects({ decision: { option: "o1", by: "council", reason: "see <script>" } }, "bad_text", "negative: < > in the reason");
  eq(codeOf(() => normalizeWorksite([BASE])), "bad_worksite", "not an object");
});

await sec("PATCH merge", () => {
  const cur = { id: "W-X", ...normalizeWorksite(BASE), seed: false };
  const d = applyPatch(cur, { status: "decided", decision: { option: "o2", by: "council", reason: "cheapest" } });
  eq([d.status, d.decision.option, d.decision.by, d.decision.at], ["decided", "o2", "council", null], "records the decision (at is stamped by the server)");
  eq(codeOf(() => applyPatch(cur, {})), "bad_patch", "empty PATCH");
  eq(codeOf(() => applyPatch(cur, { id: "W-LONSDALE", seed: true })), "bad_patch", "negative: id / seed alone are not editable fields");
  eq(applyPatch(cur, { title: "New", id: "W-HACK" }).title, "New", "with unknown fields mixed in, only known fields change");
  eq(codeOf(() => applyPatch(cur, { links: [] })), "bad_links", "the merged worksite is validated again in full");
});

await sec("queries and sorting", () => {
  eq(parseQuery(new URLSearchParams("from=2026-10-10")).from, "2026-10-10", "URLSearchParams is accepted too");
  eq(codeOf(() => parseQuery({ from: "10/10/2026" })), "bad_query", "bad date format");
  eq(codeOf(() => parseQuery({ from: "2026-10-10", to: "2026-10-01" })), "bad_query", "from after to");
  eq(codeOf(() => parseQuery({ status: "x" })), "bad_query", "unknown status");
  eq(selectWorksites(SEEDS, { from: "2026-10-10" }).map((s) => s.id), ["W-LTLBOURKE"], "only Little Bourke is still running after 10-10");
  eq(selectWorksites(SEEDS, { to: "2026-10-06" }).map((s) => s.id), ["W-LATROBE", "W-LONSDALE"], "the two starting before 10-06, sorted by id when they start on the same day");
  ok(inWindow(SEEDS[0], "2026-10-09", "2026-10-09") && !inWindow(SEEDS[0], "2026-10-10", null), "the window is inclusive");
});

await sec("toEngineWorksite: the engine worksite plan format", () => {
  const e = toEngineWorksite(SEEDS[0]);
  eq(Object.keys(e), ["id", "name", "links", "closes", "time", "equipment"], "only fields the engine knows");
  eq(e.closes, { lanes: 1 }, "no footpath key when the footpath is open");
  eq(toEngineWorksite({ ...SEEDS[0], closes: { lanes: 1, footpath: "left" } }).closes, { lanes: 1, footpath: "left" }, "footpath included when it is closed");
  e.equipment[0].at_m = 1;
  eq(SEEDS[0].equipment[0].at_m, 300, "negative: changing the converted object does not change the seed worksite");
});

await sec("browser client (fake fetch)", async () => {
  const calls = [];
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const f = (answer) => async (url, init) => {
    calls.push({ url, init });
    return answer(url, init);
  };
  const l1 = await listWorksites({ from: "2026-10-01" }, { fetch: f(() => reply(200, { ok: true, register: "do", worksites: [SEEDS[0]] })) });
  eq([l1.src, l1.worksites.length, calls.at(-1).url], ["api", 1, "/api/worksites?from=2026-10-01"], "API reachable → src api, query passed on");
  const l2 = await listWorksites({}, { fetch: async () => { throw new Error("offline"); } });
  eq([l2.src, l2.worksites.length], ["seed", 3], "offline → falls back to the 3 seeds, the page still works");
  const l3 = await listWorksites({}, { fetch: f(() => reply(503, { ok: false, error: "api_not_deployed" })) });
  eq(l3.src, "seed", "site without an api binding (503) → seeds");

  const c = await createWorksite({ ...BASE, email: "x@y.z" }, { fetch: f(() => reply(201, { ok: true, worksite: { id: "W-AAAAAA" }, edit_token: "t".repeat(32) })) });
  const sent = JSON.parse(calls.at(-1).init.body);
  eq([calls.at(-1).init.method, calls.at(-1).init.headers["content-type"], c.edit_token.length], ["POST", "application/json", 32], "POSTs JSON and gets the edit_token back");
  ok(!("email" in sent), "negative: the client normalises first, so unknown fields are never sent");

  await updateWorksite("W-AAAAAA", { status: "assessed" }, "a".repeat(32), { fetch: f(() => reply(200, { ok: true, worksite: { id: "W-AAAAAA" } })) });
  eq([calls.at(-1).init.method, calls.at(-1).url, calls.at(-1).init.headers["x-edit-token"]], ["PATCH", "/api/worksites/W-AAAAAA", "a".repeat(32)], "PATCH sends x-edit-token");

  let code = null;
  try {
    await updateWorksite("W-LONSDALE", { status: "assessed" }, "a".repeat(32), { fetch: f(() => reply(403, { ok: false, error: "locked", msg: "…" })) });
  } catch (e) {
    code = e.code;
  }
  eq(code, "locked", "the API error code is thrown to the page as is");
  let local = null;
  try {
    await createWorksite({ ...BASE, title: "" }, { fetch: f(() => reply(201, {})) });
  } catch (e) {
    local = e.code;
  }
  eq([local, calls.at(-1).init.method], ["bad_title", "PATCH"], "invalid input is rejected in the browser, no request sent");
});

done();
