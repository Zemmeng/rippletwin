// options.js — build 3 traffic-management kits for one worksite from the RPM Hire inventory (apps/roads equipment.json) and price their hire (D-0929-2011 item 3). Pure functions.
// This file only decides which equipment, how many, where, how much and whether stock suffices; each kit's queue and delay are computed by the engine via be.options() in backend.js (D-0929-1310: the engine computes the numbers).
// Rule: stock quantities and day rates are assumed values (each equipment.json item's assumed / sources fields say RPM Hire publishes no prices) → hire.assumed is always true (D-0929-1536)
// Rule: never exceed stock: each item's quantity in a kit (plus what time-overlapping worksites in the same plan already use) ≤ stock; shortfalls go into short instead of being forced in
// Equipment entries carry item (equipment.json id) and qty, matching equipment[].item / qty in docs/reference/interfaces.md, so apps/api pack.js can quote the same plan
import { footpathOf, overlaps } from './worksite.js';
import { signsOn } from './reading.js';
import { approaches } from './routes.js';

// Three tiers (revised: previously A and B both showed only "roadwork ahead" and read the same, and C cost as much as B):
//   Minimum o1  = barriers + static signs, no VMS
//   Standard o2 = adds an arrow board + two VMS showing the extra minutes on the stay route without naming a road (e.g. EXPECT / DELAYS ▸ 10 MIN); the most expensive tier
//   Guided o3   = arrow board + one VMS naming the engine's fastest detour and the minutes saved (e.g. USE / RUSSELL ▸ SAVE / 9 MIN); one VMS fewer than Standard
// vms = number of VMS; delay = the sign reports delay (Standard); guided = the sign names a detour (Guided)
export const TIERS = [
  { id: 'o1', label: 'Minimum', label_zh: '最省', vms: 0, arrow: false, guided: false, delay: false },
  { id: 'o2', label: 'Standard', label_zh: '标准', vms: 2, arrow: true, guided: false, delay: true },
  { id: 'o3', label: 'Guided', label_zh: '引导绕行', vms: 1, arrow: true, guided: true, delay: false },
];
export const WARN_FRAME = ['ROADWORK', 'AHEAD'];
export const DELAY_HEAD = ['EXPECT', 'DELAYS']; // first frame of the Standard VMS; the second is "N MIN" (delayFrames)
export const VMS_AT_M = 300; // VMS 300 m upstream when no faster detour is found (same as the demo plans in backend.js)
export const VMS2_AT_M = 500; // the Standard tier's second VMS goes at most 500 m upstream (vms2At pulls it back if the modelled upstream stretch is shorter)
export const AT_M = { ahead: 200, lane: 100, arrow: 60 }; // static sign / arrow board distance from the works start (engineering assumption, same positions as the demo plans)
export const BARRIER_PREF = ['barrier_water', 'barrier_klemmfix', 'barrier_steel']; // water-filled barriers first (RPM Hire: suited to roads under 50 km/h, pedestrian-friendly)
export const VMS_PREF = ['vms_a', 'vms_c'];
export const HIRE_NOTE = 'Stock and day rates are assumed values (RPM Hire publishes no prices); confirm with an RPM Hire quote.';

const dayNum = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const okDate = s => DATE_RE.test(String(s)) && new Date(dayNum(s) * 86400000).toISOString().slice(0, 10) === s;
// a malformed time would silently price hire as 1 day and leave the works inactive at `when` → be.options() rejects it first with bad_plan
export function timeErrors(time, who = 'Worksite') {
  if (time == null) return [];
  if (typeof time !== 'object' || Array.isArray(time)) return [`${who}: time must be a { from, to, hours? } object`];
  const errs = [];
  if (!okDate(time.from) || !okDate(time.to)) errs.push(`${who}: time.from / to must be real dates YYYY-MM-DD (got ${JSON.stringify(time.from)} / ${JSON.stringify(time.to)})`);
  else if (time.from > time.to) errs.push(`${who}: time.from ${time.from} is after time.to ${time.to}`);
  const h = time.hours;
  if (h != null && !(Array.isArray(h) && h.length === 2 && h.every(Number.isFinite) && h[0] >= 0 && h[1] <= 24 && h[0] < h[1])) {
    errs.push(`${who}: time.hours must be [start, end) with 0 ≤ start < end ≤ 24 (got ${JSON.stringify(h)})`);
  }
  return errs;
}
export function whenErrors(when) {
  const ok = when && typeof when === 'object' && okDate(when.date) && Number.isInteger(when.hour) && when.hour >= 0 && when.hour <= 23;
  return ok ? [] : [`when must be { date: 'YYYY-MM-DD', hour: 0–23 } (got ${JSON.stringify(when ?? null)})`];
}

// hire days = calendar days from time.from to time.to inclusive; no dates = 1 day (flagged as flags.no_time). be.options() has already rejected malformed dates via timeErrors
export function daysOf(time) {
  if (!time || !DATE_RE.test(String(time.from)) || !DATE_RE.test(String(time.to))) return 1;
  return Math.max(1, dayNum(time.to) - dayNum(time.from) + 1);
}

// works links → closed length (sum of len_m), minimum lane count, full closure or not, which footpath is closed
export function siteOf(net, ws) {
  let len = 0, lanes = Infinity;
  const missing = [];
  for (const id of ws.links || []) {
    const l = net?.links?.get(id);
    if (!l) { missing.push(id); continue; }
    len += Number(l.len_m) || 0;
    lanes = Math.min(lanes, Number(l.lanes) || 0);
  }
  const close = Number(ws.closes?.lanes) || 0;
  return {
    len_m: Math.round(len), lanes: Number.isFinite(lanes) ? lanes : null, close_lanes: close,
    full: Number.isFinite(lanes) && close > 0 && close >= lanes, footpath: footpathOf(ws), missing, up_m: missing.length ? null : upOf(net, ws),
  };
}

// length of the upstream stretch the engine models (what routes.js approaches() walks upstream along the same street from the works start; every approach's vehicles enter at its start).
// Shortest over the approaches; null if it cannot be computed
function upOf(net, ws) {
  try {
    const ms = approaches(net, ws).map(a => a.up.reduce((s, l) => s + (Number(l.len_m) || 0), 0));
    return ms.length ? Math.round(Math.min(...ms)) : null;
  } catch { return null; }
}

// where the Standard tier's second VMS goes: further upstream than the first, so drivers learn the delay before more turn-offs. At most VMS2_AT_M;
// if the modelled upstream stretch (up_m) is shorter, place it ≥ 25 m inside its start, rounded to 50 — beyond the start, vehicles turning in from cross streets never pass the sign,
// yet the engine would assume every vehicle saw it; always at least 50 m beyond the first. Lonsdale at 08:00: upstream stretch 436 m (to Spring St) → 400 m, before the Exhibition St turn (298 m)
export function vms2At(vmsAt, upM) {
  const far = Number.isFinite(upM) && upM > 0 ? Math.min(VMS2_AT_M, Math.floor((upM - 25) / 50) * 50) : VMS2_AT_M;
  return Math.min(2000, Math.max((Number(vmsAt) || 0) + 50, far));
}

// which lane is closed: left if the original plan has a LEFT LANE CLOSED sign, otherwise right as in the demo plans
export function laneSide(ws) {
  return (ws.equipment || []).some(e => /LEFT LANE CLOSED/i.test(String(e.text || ''))) ? 'left' : 'right';
}

// VMS text rules (same as apps/api signs.js and the advisor's checkSuggestion): ≤ 2 frames × ≤ 4 lines × ≤ 10 characters, ≤ 8 words in total, upper case
const LINE_RE = /^[A-Z0-9 .,'&/:+-]{1,10}$/;
export function vmsTextOk(frames) {
  if (!Array.isArray(frames) || frames.length < 1 || frames.length > 2) return false;
  const lines = frames.every(f => Array.isArray(f) && f.length >= 1 && f.length <= 4 && f.every(l => typeof l === 'string' && LINE_RE.test(l) && l.trim() === l));
  return lines && frames.flat().join(' ').split(/\s+/).filter(Boolean).length <= 8;
}

// guidance frames from the rule-based advisor (e.g. USE / RUSSELL ▸ SAVE / 9 MIN) → VMS frames. Two frames are used as given: a VMS has at most two, and the S-1 static sign already says "roadwork ahead";
// a single frame (older form, or passed directly) gets ROADWORK / AHEAD in front, keeping only the guidance frame if that exceeds 8 words
export function guidedFrames(frames) {
  if (!Array.isArray(frames) || !frames.length) return null;
  const fs = Array.isArray(frames[0]) ? frames : [frames];
  if (fs.length > 1) return vmsTextOk(fs) ? fs.map(f => [...f]) : null;
  const two = [[...WARN_FRAME], [...fs[0]]];
  if (vmsTextOk(two)) return two;
  return vmsTextOk([[...fs[0]]]) ? [[...fs[0]]] : null;
}

// Standard tier sign: the extra minutes per vehicle on the stay route, without naming a road → [['EXPECT', 'DELAYS'], ['N MIN']].
// N uses the same summary as the advisor's "SAVE N MIN" for the Guided tier (advisorSummary of the Minimum kit's engine result) and the same method: pick approaches by delay, largest first,
// stay route minutes now − usual minutes, rounded to whole minutes, written only if ≥ 1, capped at 99 (the advisor uses stay − fastest detour).
// If it cannot be computed (works inactive this hour, under 1 minute) → null, and the sign keeps ROADWORK / AHEAD (flags.no_delay_min)
export function delayFrames(summary, wsId) {
  const aps = [...(summary?.approaches || [])].filter(a => wsId == null || a.worksite === wsId).sort((a, b) => (b.delay_min || 0) - (a.delay_min || 0));
  for (const ap of aps) {
    const stay = (ap.routes || []).find(r => r.id === 'stay');
    const n = stay ? Math.round(stay.now_min - stay.usual_min) : NaN;
    if (!(n >= 1)) continue;
    const min = Math.min(n, 99), frames = [[...DELAY_HEAD], [`${min} MIN`]];
    if (vmsTextOk(frames)) return { min, frames };
  }
  return null;
}

// tier → equipment needed (before checking stock): { id, type, at_m, text? | frames?, items: [inventory ids in order of preference], close?, len_m? | qty? }
// tier.vms VMS boards show the same text: VMS-1 at vmsAt, VMS-2 (Standard) at vms2At (by default from site.up_m, see vms2At())
export function tierNeeds(tier, ws, site, { vmsAt = VMS_AT_M, frames = [WARN_FRAME], vms2 = vms2At(vmsAt, site?.up_m) } = {}) {
  const out = [];
  const lanes = site.close_lanes > 0;
  const sides = site.footpath === 'both' ? ['L', 'R'] : site.footpath === 'left' ? ['L'] : site.footpath === 'right' ? ['R'] : [];
  if (lanes) out.push({ id: 'B-1', type: 'barrier', at_m: 0, items: BARRIER_PREF, close: 'lane', len_m: site.len_m });
  for (const s of sides) out.push({ id: `B-F${s}`, type: 'barrier', at_m: 0, items: BARRIER_PREF, close: 'footpath', len_m: site.len_m });
  out.push({ id: 'S-1', type: 'sign', at_m: AT_M.ahead, text: 'ROADWORK AHEAD', items: ['sign_roadwork_ahead'] });
  if (lanes) {
    const side = laneSide(ws);
    out.push(site.full
      ? { id: 'S-2', type: 'sign', at_m: AT_M.lane, text: 'DETOUR AHEAD', items: ['sign_detour_straight'] }
      : { id: 'S-2', type: 'sign', at_m: AT_M.lane, text: `${side.toUpperCase()} LANE CLOSED`, items: [`sign_lane_closed_${side}`] });
  }
  for (const s of sides) out.push({ id: `S-F${s}`, type: 'sign', at_m: 0, text: 'FOOTPATH CLOSED', items: ['sign_footpath_closed'] });
  // END ROADWORK goes at the end of the works (negative at_m = downstream of the works start): the list is complete and it is hired; reading.js signsOn() only takes signs with at_m ≥ 0,
  // so it is not in the reading request and does not use one of the reader's 6 sign slots (upstream there can be up to 7: S-1, S-2, S-FL, S-FR, A-1, VMS-1, VMS-2 — with both footpaths closed
  // the Standard tier's farthest VMS-2 is pushed out, reported truthfully as flags.vms_read = false)
  out.push({ id: 'S-9', type: 'sign', at_m: -Math.max(1, site.len_m), text: 'END ROADWORK', items: ['sign_end_roadwork'] });
  if (tier.arrow && lanes && !site.full) out.push({ id: 'A-1', type: 'arrow', at_m: AT_M.arrow, items: ['arrow_board'] });
  const nV = Math.max(0, Math.min(2, Math.floor(Number(tier.vms)) || 0));
  if (nV >= 1) out.push({ id: 'VMS-1', type: 'vms', at_m: vmsAt, frames: frames.map(f => [...f]), items: VMS_PREF });
  if (nV >= 2) out.push({ id: 'VMS-2', type: 'vms', at_m: vms2, frames: frames.map(f => [...f]), items: VMS_PREF });
  return out;
}

// equipment already taken by other worksites (item → quantity): stock is shared, so subtract time-overlapping worksites before building this one
export function usageOf(worksites) {
  const m = new Map();
  for (const w of worksites || []) for (const e of w.equipment || []) if (e.item) m.set(e.item, (m.get(e.item) || 0) + (Number(e.qty) || 1));
  return m;
}
export const sharingWith = (worksites, ws) => (worksites || []).filter(w => w !== ws && overlaps(w, ws));

// does each VMS reach the reading request: signsOn() passes only the 6 signs nearest the works to the reader, and a VMS pushed out is as good as absent (Guided would silently match Standard); every VMS must be read
export function vmsRead(equipment) {
  const seen = signsOn({ dir: null, kmh: 40 }, { equipment });
  return (equipment || []).filter(e => e.type === 'vms').every(v => seen.some(x => x.kind === 'vms' && x.m === (Number(v.at_m) || 0)));
}

// Check stock: for each need pick the first item in order of preference with enough stock left; if none has enough, use the first choice with whatever is left (skip if 0) and record the shortfall in short.
// Barrier count = ⌈closed length ÷ section length unit_len_m⌉; footpath closures only use barriers whose can_close includes footpath.
// Needs with fewer candidate items go first (footpaths can only use water-filled barriers), so lane barriers do not use them all up and report a footpath shortfall while plastic barriers sit idle; output keeps the order of needs.
// used0 = quantities already taken by other worksites (usageOf), subtracted from stock first
export function resolveNeeds(needs, inventory, used0) {
  const inv = new Map((inventory?.items || []).map(i => [i.id, i]));
  const used = new Map(used0 || []);
  const eqAt = [], shortAt = [];
  const slots = needs.map((n, i) => ({ n, i, cands: n.items.map(id => inv.get(id)).filter(it => it && (!n.close || (it.can_close || []).includes(n.close))) }));
  for (const { n, i, cands } of [...slots].sort((a, b) => a.cands.length - b.cands.length || a.i - b.i)) {
    const want = it => (n.len_m != null ? Math.max(1, Math.ceil(n.len_m / (Number(it.unit_len_m) || 1))) : n.qty || 1);
    const left = it => Math.max(0, Math.floor(Number(it.qty) || 0) - (used.get(it.id) || 0));
    let it = cands.find(c => left(c) >= want(c));
    let qty = it ? want(it) : 0;
    if (!it) {
      it = cands[0];
      if (!it) { shortAt[i] = { equipment: n.id, item: n.items[0] ?? null, need: n.qty || 1, got: 0, stock: 0, why: 'not_in_inventory' }; continue; }
      qty = left(it);
      shortAt[i] = { equipment: n.id, item: it.id, need: want(it), got: qty, stock: Math.floor(Number(it.qty) || 0), why: 'over_stock' };
      if (!qty) continue;
    }
    used.set(it.id, (used.get(it.id) || 0) + qty);
    const { items, close, len_m, qty: _q, ...rest } = n;
    eqAt[i] = { ...rest, item: it.id, qty };
  }
  return { equipment: eqAt.filter(Boolean), short: shortAt.filter(Boolean) };
}

// kit equipment → hire breakdown (one line per item, in order of first appearance): qty × day rate × days. Prices and stock are assumed values
export function hireOf(equipment, inventory, days) {
  const inv = new Map((inventory?.items || []).map(i => [i.id, i]));
  const rows = new Map();
  for (const e of equipment) {
    if (!e.item) continue;
    const it = inv.get(e.item);
    const r = rows.get(e.item) || { item: e.item, name: it?.name ?? null, qty: 0, day_rate_aud: typeof it?.day_rate_aud === 'number' ? it.day_rate_aud : null, days };
    r.qty += Number(e.qty) || 1;
    rows.set(e.item, r);
  }
  const lines = [...rows.values()].map(r => ({ ...r, cost_aud: r.day_rate_aud == null ? null : r.qty * r.day_rate_aud * days }));
  const known = lines.filter(l => l.cost_aud != null);
  return {
    lines, days,
    per_day_aud: known.reduce((s, l) => s + l.qty * l.day_rate_aud, 0),
    total_aud: known.reduce((s, l) => s + l.cost_aud, 0),
    unpriced: lines.filter(l => l.cost_aud == null).map(l => l.item),
    assumed: true,
    note: HIRE_NOTE,
  };
}

// kit quantities vs stock: this worksite's quantity + what time-overlapping worksites already take (used0) ≤ stock
export function stockOf(equipment, inventory, short = [], used0) {
  const inv = new Map((inventory?.items || []).map(i => [i.id, i]));
  const need = new Map();
  for (const e of equipment) if (e.item) need.set(e.item, (need.get(e.item) || 0) + (Number(e.qty) || 1));
  const tot = id => need.get(id) + ((used0 && used0.get(id)) || 0);
  const over = [...need.keys()].filter(id => tot(id) > (Number(inv.get(id)?.qty) || 0)).map(item => ({ item, need: tot(item), stock: Number(inv.get(item)?.qty) || 0 }));
  return { ok: !short.length && !over.length, short: [...short, ...over.map(o => ({ equipment: null, item: o.item, need: o.need, got: o.need, stock: o.stock, why: 'over_stock' }))] };
}
