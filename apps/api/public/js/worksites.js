// Worksite register: normalisation of worksite objects, time overlap, and the browser client. Shared by the browser and the Worker (src/register.js)
// Worksite = the engine worksite plan in docs/reference/interfaces.md (links / closes / time / equipment) + register fields (title / kind / status / decision)
//   The server adds id / seed / created / updated. toEngineWorksite() converts to the engine format
// 🔒 Whitelisted fields only: anything else (email, names...) is dropped, never stored or returned
// 🔒 title / reason must not contain < > or control characters: the web page builds templates with innerHTML, so they are blocked at the entry point
import { normSign, SignError } from "./signs.js";
import { SEED_WORKSITES } from "./worksites-seed.js";

export const WS_LIMITS = {
  title: 80,
  reason: 280,
  links: 20,
  equipment: 30,
  lanes: 8,
  atM: 2000, // max distance of equipment from the start of the works (same as the engine advisor's at_m limit); negative = downstream of the start (e.g. END ROADWORK)
  spanDays: 366,
  entries: 200, // max stored entries (seed worksites not included)
  writesPerDay: 500, // global writes per day (reset at 00:00 UTC): a public endpoint, so this stops anyone flooding the Durable Object
};
export const KINDS = ["road", "utility", "building", "event", "other"];
export const STATUSES = ["draft", "assessed", "decided", "exported", "withdrawn"];
export const ROLES = ["contractor", "council"];
export const EQUIP_TYPES = ["vms", "sign", "arrow", "barrier"];
export const FOOTPATH_SIDES = ["left", "right", "both"];
export const PATCH_KEYS = ["title", "kind", "status", "links", "closes", "time", "equipment", "decision"];

export class WorksiteError extends Error {
  constructor(code, msg) {
    super(msg);
    this.name = "WorksiteError";
    this.code = code; // machine-readable code; the Worker puts it into { ok:false, error } as is
  }
}

const bad = (code, msg) => new WorksiteError(code, msg);
const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
export const ID_RE = /^[A-Za-z0-9_-]{1,32}$/;
const LINK_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DIR_RE = /^[NSEW]{1,2}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

// Human-readable text: collapse whitespace; error if empty and required; no < > or control characters
function text(x, max, code, where, required = true) {
  if (x === undefined || x === null || x === "") {
    if (required) throw bad(code, `${where} must not be empty`);
    return "";
  }
  if (typeof x !== "string") throw bad(code, `${where} must be a string`);
  const t = x.replace(/\s+/g, " ").trim();
  if (!t && required) throw bad(code, `${where} must not be empty`);
  if (t.length > max) throw bad(code, `${where} must be at most ${max} characters`);
  if (/[<>\u0000-\u001f\u007f]/.test(t)) throw bad("bad_text", `${where} must not contain < > or control characters`);
  return t;
}

function oneOf(x, list, code, where) {
  if (!list.includes(x)) throw bad(code, `${where} must be one of ${list.join(" / ")}`);
  return x;
}

export function isDate(s) {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
const dayNum = (s) => Date.parse(`${s}T00:00:00Z`) / 86400000;

function normLinks(x) {
  if (!Array.isArray(x) || x.length < 1 || x.length > WS_LIMITS.links) {
    throw bad("bad_links", `links must be an array of 1–${WS_LIMITS.links} link ids (network.json ids, in the direction of travel)`);
  }
  for (const id of x) if (typeof id !== "string" || !LINK_RE.test(id)) throw bad("bad_links", `a link id must be 1–64 letters, digits, _ or -`);
  return [...new Set(x)];
}

// closes.lanes = lanes closed (≥ the link's lane count = full closure, computed by the engine); footpath missing / null / "none" = footpath open
function normCloses(c) {
  if (!isObj(c)) throw bad("bad_closes", "closes must be a { lanes, footpath? } object");
  const { lanes } = c;
  if (!Number.isInteger(lanes) || lanes < 0 || lanes > WS_LIMITS.lanes) throw bad("bad_closes", `closes.lanes must be an integer from 0 to ${WS_LIMITS.lanes}`);
  const f = c.footpath;
  const footpath = f === undefined || f === null || f === "none" ? null : oneOf(f, FOOTPATH_SIDES, "bad_closes", "closes.footpath");
  if (lanes === 0 && !footpath) throw bad("bad_closes", "neither lanes nor footpath closed: nothing to register");
  return { lanes, footpath };
}

// time.hours = daily [start, end), as in the engine; overnight works that cross midnight must be split into two entries
function normTime(t) {
  if (!isObj(t)) throw bad("bad_time", "time must be a { from, to, hours } object");
  if (!isDate(t.from) || !isDate(t.to)) throw bad("bad_time", "time.from / time.to must be YYYY-MM-DD dates");
  if (t.from > t.to) throw bad("bad_time", "time.from must not be after time.to");
  if (dayNum(t.to) - dayNum(t.from) + 1 > WS_LIMITS.spanDays) throw bad("bad_time", `works can last at most ${WS_LIMITS.spanDays} days`);
  const h = t.hours === undefined || t.hours === null ? [0, 24] : t.hours;
  if (!Array.isArray(h) || h.length !== 2 || !h.every(Number.isInteger) || h[0] < 0 || h[1] > 24 || h[0] >= h[1]) {
    throw bad("bad_time", "time.hours must be two whole hours [start, end) with 0 ≤ start < end ≤ 24");
  }
  return { from: t.from, to: t.to, hours: [h[0], h[1]] };
}

// Sign text follows the signs.js spec (2 frames × 4 lines × 10 characters, 8 words, capitals and common punctuation only)
function signOf(s, at) {
  try {
    return normSign({ ...s, read_s: 0 }, 0);
  } catch (e) {
    if (e instanceof SignError) throw bad(e.code, e.message.replace(/^signs\[0\]/, at));
    throw e;
  }
}

function normEquipment(list) {
  if (list === undefined || list === null) return [];
  if (!Array.isArray(list) || list.length > WS_LIMITS.equipment) throw bad("bad_equipment", `equipment must be an array of at most ${WS_LIMITS.equipment} items`);
  const ids = new Set();
  return list.map((e, i) => {
    const at = `equipment[${i}]`;
    if (!isObj(e)) throw bad("bad_equipment", `${at} must be an object`);
    if (typeof e.id !== "string" || !ID_RE.test(e.id)) throw bad("bad_equipment", `${at}.id must be 1–32 letters, digits, _ or -`);
    if (ids.has(e.id)) throw bad("bad_equipment", `${at}.id "${e.id}" is a duplicate`);
    ids.add(e.id);
    oneOf(e.type, EQUIP_TYPES, "bad_equipment", `${at}.type`);
    if (typeof e.at_m !== "number" || !Number.isFinite(e.at_m) || Math.abs(e.at_m) > WS_LIMITS.atM) {
      throw bad("bad_equipment", `${at}.at_m must be −${WS_LIMITS.atM} to ${WS_LIMITS.atM} metres (distance upstream of the start of the works; negative = downstream, e.g. END ROADWORK)`);
    }
    const out = { id: e.id, type: e.type, at_m: Math.round(e.at_m) };
    if (e.type === "vms") out.frames = signOf({ kind: "vms", frames: e.frames }, at).frames;
    if (e.type === "sign" || e.type === "arrow") {
      const s = signOf({ kind: e.type, text: e.text }, at);
      if (s.text) out.text = s.text;
    }
    if (e.dir !== undefined && e.dir !== null) {
      if (typeof e.dir !== "string" || !DIR_RE.test(e.dir)) throw bad("bad_equipment", `${at}.dir must be N / S / E / W (or two letters, e.g. NW)`);
      out.dir = e.dir;
    }
    if (e.char_mm !== undefined && e.char_mm !== null) {
      if (!Number.isInteger(e.char_mm) || e.char_mm < 100 || e.char_mm > 600) throw bad("bad_equipment", `${at}.char_mm must be an integer from 100 to 600 (millimetres)`);
      out.char_mm = e.char_mm;
    }
    // Optional: which RPM inventory item (equipment.json in apps/roads) and how many. If omitted, pack.js infers them from type / sign text / link length (the engine ignores both fields)
    if (e.item !== undefined && e.item !== null) {
      if (typeof e.item !== "string" || !/^[a-z0-9_]{1,40}$/.test(e.item)) throw bad("bad_equipment", `${at}.item must be an equipment.json id (lower-case letters, digits, _)`);
      out.item = e.item;
    }
    if (e.qty !== undefined && e.qty !== null) {
      if (!Number.isInteger(e.qty) || e.qty < 1 || e.qty > 500) throw bad("bad_equipment", `${at}.qty must be an integer from 1 to 500`);
      out.qty = e.qty;
    }
    return out;
  });
}

// The human decision: which plan, who chose it, and why. at is written by the server; a client value is kept only if well-formed
function normDecision(d) {
  if (d === undefined || d === null) return null;
  if (!isObj(d)) throw bad("bad_decision", "decision must be a { option, by, reason? } object");
  if (typeof d.option !== "string" || !ID_RE.test(d.option)) throw bad("bad_decision", "decision.option must be a plan id (1–32 letters, digits, _ or -)");
  return {
    option: d.option,
    by: oneOf(d.by, ROLES, "bad_decision", "decision.by"),
    reason: text(d.reason, WS_LIMITS.reason, "bad_decision", "decision.reason", false),
    at: typeof d.at === "string" && ISO_RE.test(d.at) ? d.at : null,
  };
}

// Input → normalised worksite (without id / seed / created / updated); throws WorksiteError if invalid; unknown fields are dropped
export function normalizeWorksite(x) {
  if (!isObj(x)) throw bad("bad_worksite", "a worksite must be an object");
  const ws = {
    title: text(x.title, WS_LIMITS.title, "bad_title", "title"),
    kind: x.kind === undefined || x.kind === null ? "other" : oneOf(x.kind, KINDS, "bad_kind", "kind"),
    status: x.status === undefined || x.status === null ? "draft" : oneOf(x.status, STATUSES, "bad_status", "status"),
    links: normLinks(x.links),
    closes: normCloses(x.closes),
    time: normTime(x.time),
    equipment: normEquipment(x.equipment),
    decision: normDecision(x.decision),
  };
  if ((ws.status === "decided" || ws.status === "exported") && !ws.decision) {
    throw bad("bad_status", "status decided / exported requires a decision (which plan, who chose it)");
  }
  return ws;
}

// PATCH: only PATCH_KEYS fields are accepted; the merged worksite is validated again in full
export function applyPatch(cur, patch) {
  if (!isObj(patch)) throw bad("bad_worksite", "PATCH body must be an object");
  const keys = Object.keys(patch).filter((k) => PATCH_KEYS.includes(k));
  if (!keys.length) throw bad("bad_patch", `no editable fields (only ${PATCH_KEYS.join(" / ")} can be changed)`);
  const merged = { ...cur };
  for (const k of keys) merged[k] = patch[k];
  return normalizeWorksite(merged);
}

// Seed worksites, normalised once (an error throws at module load, so tests fail)
export const SEEDS = SEED_WORKSITES.map((s) => ({ id: s.id, ...normalizeWorksite(s), seed: true, created: null, updated: null }));
export const isSeedId = (id) => SEEDS.some((s) => s.id === id);

// Whether the works period intersects the date window [from, to] (inclusive); dates only, not hours
export function inWindow(ws, from, to) {
  return (!from || ws.time.to >= from) && (!to || ws.time.from <= to);
}

// Whether two worksites run at the same time: dates intersect and daily hours intersect (same rule as overlaps() in the engine's worksite.js)
export function timeOverlap(a, b) {
  const [a0, a1] = a.time.hours || [0, 24];
  const [b0, b1] = b.time.hours || [0, 24];
  return a.time.from <= b.time.to && b.time.from <= a.time.to && a0 < b1 && b0 < a1;
}

// Other worksites in the register that overlap ws in time (withdrawn ones excluded) → the web page calls the engine's conflict(a, b) for each pair to get the clash cost
export function overlapping(ws, list) {
  return list.filter((o) => o.id !== ws.id && o.status !== "withdrawn" && timeOverlap(ws, o));
}

// Query parameters → { from, to, status }; throws bad_query if invalid
export function parseQuery(q = {}) {
  const get = (k) => (typeof q.get === "function" ? q.get(k) : q[k]) || null;
  const out = { from: get("from"), to: get("to"), status: get("status") };
  for (const k of ["from", "to"]) if (out[k] && !isDate(out[k])) throw bad("bad_query", `${k} must be a YYYY-MM-DD date`);
  if (out.from && out.to && out.from > out.to) throw bad("bad_query", "from must not be after to");
  if (out.status && !STATUSES.includes(out.status)) throw bad("bad_query", `status must be one of ${STATUSES.join(" / ")}`);
  return out;
}

// Filter by query; sort by start date, then id
export function selectWorksites(list, q = {}) {
  return list
    .filter((ws) => inWindow(ws, q.from, q.to) && (!q.status || ws.status === q.status))
    .sort((a, b) => (a.time.from === b.time.from ? (a.id < b.id ? -1 : 1) : a.time.from < b.time.from ? -1 : 1));
}

// Register worksite → engine worksite plan object (the engine ignores title / status and the like, so converting keeps it clean)
export function toEngineWorksite(ws) {
  return {
    id: ws.id,
    name: ws.title,
    links: [...ws.links],
    closes: { lanes: ws.closes.lanes, ...(ws.closes.footpath ? { footpath: ws.closes.footpath } : {}) },
    time: { from: ws.time.from, to: ws.time.to, hours: [...ws.time.hours] },
    equipment: structuredClone(ws.equipment),
  };
}

// ---- Browser client: apiBase is empty for same-origin deployment; opts: { fetch, apiBase, timeoutMs }; tests inject fetch ----

async function call(path, { method = "GET", body, token, fetch, apiBase = "", timeoutMs = 8000 } = {}) {
  const f = fetch || globalThis.fetch;
  if (typeof f !== "function") throw bad("no_fetch", "no fetch available");
  const ctl = typeof AbortController === "function" ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
  try {
    const headers = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers["x-edit-token"] = token;
    const r = await f(`${apiBase}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: ctl?.signal });
    const b = await r.json().catch(() => null);
    if (!r.ok || !b || b.ok !== true) throw bad(b?.error || `http_${r.status}`, b?.msg || `register API returned ${r.status}`);
    return b;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// List the register (all by default) → { src: "api" | "seed", worksites }. If the API is unreachable, fall back to the read-only seed worksites so the page still works
export async function listWorksites(query = {}, opts = {}) {
  const q = parseQuery(query);
  try {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v)).toString();
    const b = await call(`/api/worksites${qs ? `?${qs}` : ""}`, opts);
    return { src: b.register === "do" ? "api" : "seed", worksites: b.worksites };
  } catch {
    return { src: "seed", worksites: selectWorksites(structuredClone(SEEDS), q) };
  }
}

export async function getWorksite(id, opts = {}) {
  return (await call(`/api/worksites/${encodeURIComponent(id)}`, opts)).worksite;
}

// Register → { worksite, edit_token }. edit_token is returned only this once: the page must keep it (localStorage) and send it to edit
export async function createWorksite(ws, opts = {}) {
  const b = await call("/api/worksites", { ...opts, method: "POST", body: normalizeWorksite(ws) });
  return { worksite: b.worksite, edit_token: b.edit_token };
}

// Change status / record a decision / replace equipment → the updated worksite
export async function updateWorksite(id, patch, token, opts = {}) {
  return (await call(`/api/worksites/${encodeURIComponent(id)}`, { ...opts, method: "PATCH", body: patch, token })).worksite;
}
