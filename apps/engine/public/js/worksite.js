// worksite.js — worksite semantics: when it is active, how much capacity it removes from which links, shifting dates. Pure functions.
// Worksite format (docs/reference/interfaces.md, Worksite plan):
//   { id, name?, links: [link ids in driving direction], closes: { lanes, footpath? }, time: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', hours: [start, end) },
//     equipment: [{ id, type: 'vms'|'sign'|'arrow'|'barrier', at_m: metres upstream of the works start, dir?, frames?, text?, char_mm? }] }
// when = { date: 'YYYY-MM-DD', hour: 0–23, day?: 'wd'|'we' } (without day, the weekday comes from the date)

export const WZ_FRICTION = 0.9; // lanes next to a work zone are slower too: remaining capacity × 0.9 (engineering assumption)

// closes.footpath (optional): which footpath is closed, relative to the works link's driving direction, same convention as walk.json side (keep-left traffic: left = the kerb next to the closed lane).
// Missing / null / 'none' = footpath open; any other value is a validateWorksite error
export const FOOTPATH_SIDES = ['left', 'right', 'both'];
export function footpathOf(ws) {
  const f = ws?.closes?.footpath;
  return FOOTPATH_SIDES.includes(f) ? f : 'none';
}

// worksite validation → list of errors (empty = valid). Only rejects input the engine would certainly get wrong; other fields stay lenient
export function validateWorksite(ws) {
  const errs = [];
  const who = `Worksite ${ws?.id ?? '?'}`;
  if (!ws || typeof ws !== 'object' || Array.isArray(ws)) return ['A worksite must be an object'];
  if (!Array.isArray(ws.links)) errs.push(`${who}: links must be an array of link ids`);
  if (ws.closes != null && (typeof ws.closes !== 'object' || Array.isArray(ws.closes))) errs.push(`${who}: closes must be an object`);
  const f = ws.closes?.footpath;
  if (f != null && f !== 'none' && !FOOTPATH_SIDES.includes(f)) errs.push(`${who}: closes.footpath = ${JSON.stringify(f)} must be one of ${FOOTPATH_SIDES.join(' / ')} (omit it to keep the footpath open)`);
  return errs;
}
export function validatePlan(plan) {
  if (!plan || typeof plan !== 'object') return ['A plan must be a { when, worksites } object'];
  if (!Array.isArray(plan.worksites)) return ["The plan's worksites must be an array"];
  return plan.worksites.flatMap(validateWorksite);
}

const dayNum = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000;
const fmt = n => new Date(n * 86400000).toISOString().slice(0, 10);

export function dayType(when) {
  if (when.day === 'wd' || when.day === 'we') return when.day;
  const dow = new Date(dayNum(when.date) * 86400000).getUTCDay();
  return dow === 0 || dow === 6 ? 'we' : 'wd';
}

export function isActive(ws, when) {
  const t = ws.time;
  if (!t) return true;
  if (when.date < t.from || when.date > t.to) return false;
  const [h0, h1] = t.hours || [0, 24];
  return when.hour >= h0 && when.hour < h1;
}

export function overlaps(a, b) {
  const ta = a.time, tb = b.time;
  if (!ta || !tb) return true;
  const [a0, a1] = ta.hours || [0, 24], [b0, b1] = tb.hours || [0, 24];
  return ta.from <= tb.to && tb.from <= ta.to && a0 < b1 && b0 < a1;
}

// active worksites → per link { f: capacity factor (0 = full closure), open: lanes still open }
export function capFactors(net, worksites) {
  const closed = new Map();
  for (const ws of worksites) {
    for (const id of ws.links || []) closed.set(id, (closed.get(id) || 0) + (ws.closes?.lanes ?? 0));
  }
  const f = new Map();
  for (const [id, n] of closed) {
    const l = net.links.get(id);
    if (!l) continue;
    const open = Math.max(0, l.lanes - n);
    f.set(id, { f: open <= 0 ? 0 : n > 0 ? (open / l.lanes) * WZ_FRICTION : 1, open });
  }
  return f;
}

export function shiftWorksite(ws, days) {
  const t = ws.time;
  return { ...ws, time: { ...t, from: fmt(dayNum(t.from) + days), to: fmt(dayNum(t.to) + days) } };
}

export const PEAK_HOURS = [8, 17];
export const MAX_DAYS = 31; // sample at most 31 days: every sampled hour runs the engine (and its sign readings) in the browser, so long works only look at their first month

// which hours to sample: use `hours` if given; otherwise each worksite contributes the peak hours (8, 17) inside its own hours, or the middle hour of its hours if neither falls inside
export function sampleHours(worksites, hours) {
  if (hours && hours.length) return [...hours];
  const hs = new Set();
  for (const w of worksites) {
    const [h0, h1] = w.time?.hours || [0, 24];
    const pk = PEAK_HOURS.filter(h => h >= h0 && h < h1);
    (pk.length ? pk : [Math.floor((h0 + h1 - 1) / 2)]).forEach(h => hs.add(h));
  }
  return [...hs].sort((a, b) => a - b);
}

// every day from the earliest start to the latest finish × sampled hours → list of whens (for clash and stagger comparisons). Beyond MAX_DAYS only the first MAX_DAYS are kept and the result carries truncated
export function windowWhens(worksites, hours) {
  const ts = worksites.map(w => w.time).filter(Boolean);
  const out = [];
  if (!ts.length) return out;
  const d0 = Math.min(...ts.map(t => dayNum(t.from))), d1 = Math.max(...ts.map(t => dayNum(t.to)));
  const hs = sampleHours(worksites, hours);
  for (let d = d0; d <= Math.min(d1, d0 + MAX_DAYS - 1); d++) for (const hour of hs) out.push({ date: fmt(d), hour });
  out.truncated = d1 - d0 + 1 > MAX_DAYS;
  return out;
}
