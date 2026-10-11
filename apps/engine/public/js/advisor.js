// advisor.js — the engine half of step 7: hand a result summary to the planning advisor (askAdvisor, injected; the shipped advisor is the rule-based mockAdvise,
// no LLM advisor was built), take back up to 3 suggested changes, and re-run each through step 5 with the engine for a before/after comparison. The advisor proposes, the engine computes the numbers.
// Usage: const res = await advise(engine, plan, { askAdvisor: mockAdvise });

import { shiftWorksite, windowWhens } from './worksite.js';

const clone = x => JSON.parse(JSON.stringify(x));
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

export function advisorSummary(result, worksites, conflicts = []) {
  return {
    when: result.when,
    worksites: worksites.map(w => ({ id: w.id, name: w.name, links: w.links, closes: w.closes, time: w.time, equipment: w.equipment || [] })),
    approaches: result.approaches.map(a => ({
      worksite: a.worksite, street: a.street, dir: a.dir, queue_m: a.queue_m, delay_min: a.delay_min,
      routes: a.routes.map(r => ({ id: r.id, name: r.name, usual_min: r.usual_min, now_min: r.now_min, share: r.share, truck: r.truck, turn_m: r.turn_m })),
    })),
    conflicts,
  };
}

// is a suggestion valid: reword (sign text) / move equipment (at_m 0–2000) / shift dates (whole days, ≤ 60)
export function checkSuggestion(s) {
  if (!s || typeof s !== 'object' || !ID_RE.test(String(s.worksite))) return false;
  if (s.kind === 'text') return Array.isArray(s.frames) && s.frames.length >= 1 && s.frames.length <= 2 && s.frames.every(f => Array.isArray(f) && f.length >= 1 && f.length <= 4 && f.every(l => typeof l === 'string' && /^[A-Z0-9 .,'&/:+-]{1,10}$/.test(l)))
    && (s.equipment === null || ID_RE.test(String(s.equipment)));
  if (s.kind === 'move') return ID_RE.test(String(s.equipment)) && Number.isFinite(s.at_m) && s.at_m >= 0 && s.at_m <= 2000;
  if (s.kind === 'shift') return Number.isInteger(s.days) && s.days !== 0 && Math.abs(s.days) <= 60;
  return false;
}

// a suggestion → new list of worksites; null if it does not match (worksite / equipment does not exist)
export function applySuggestion(worksites, s) {
  const list = clone(worksites);
  const ws = list.find(w => w.id === s.worksite);
  if (!ws) return null;
  if (s.kind === 'shift') {
    if (!ws.time) return null; // a worksite without a time cannot be shifted
    const i = list.indexOf(ws);
    list[i] = shiftWorksite(ws, s.days);
    return list;
  }
  ws.equipment = ws.equipment || [];
  if (s.kind === 'text') {
    if (s.equipment == null) {
      ws.equipment.push({ id: 'vms-new', type: 'vms', at_m: Number.isFinite(s.at_m) ? s.at_m : 300, frames: s.frames });
      return list;
    }
    const e = ws.equipment.find(x => x.id === s.equipment && x.type === 'vms');
    if (!e) return null;
    e.frames = s.frames;
    return list;
  }
  if (s.kind === 'move') {
    const e = ws.equipment.find(x => x.id === s.equipment);
    if (!e) return null;
    e.at_m = s.at_m;
    return list;
  }
  return null;
}

// whens: the times to compare over (default = every day from the earliest start to the latest finish of all worksites before and after the change × each worksite's sampled hours).
// Before and after are compared over the same period: a date shift must include the days it moves into, or its benefit would be overstated
export async function advise(engine, plan, { askAdvisor, whens, hours } = {}) {
  const { when, worksites } = plan;
  const W0 = whens || windowWhens(worksites, hours);
  await engine.prepare(plan, { whens: W0 });
  const before = engine.evaluate(plan);
  const conflicts = [];
  for (let i = 0; i < worksites.length; i++) {
    for (let j = i + 1; j < worksites.length; j++) {
      const c = engine.conflict(worksites[i], worksites[j], { whens: W0 });
      if (c.overlap) conflicts.push({ a: worksites[i].id, b: worksites[j].id, cost_min: c.cost });
    }
  }
  const summary = advisorSummary(before, worksites, conflicts);
  const adv = await askAdvisor(summary);
  const sugg = (adv?.suggestions || []).filter(checkSuggestion).slice(0, 3).map(s => ({ s, next: applySuggestion(worksites, s) }));
  const W = whens || windowWhens([worksites, ...sugg.map(x => x.next || [])].flat(), hours);
  for (const { next } of sugg) if (next) await engine.prepare({ when, worksites: next }, { whens: W });
  await engine.prepare(plan, { whens: W });
  const beforeW = engine.window(worksites, W);
  const options = sugg.map(({ s, next }) => {
    if (!next) return { suggestion: s, skipped: 'no_such_worksite_or_equipment' };
    const afterW = engine.window(next, W);
    const delta = afterW.delay_min - beforeW.delay_min;
    // better: only if the engine's re-run is actually better; worse ideas are still listed and the UI marks them "not recommended"
    return { suggestion: s, worksites: next, delay_min: afterW.delay_min, delta_min: delta, better: delta < 0, result: engine.evaluate({ when, worksites: next }) };
  });
  return { src: adv?.src || 'unknown', summary, whens: W.length, truncated: Boolean(W.truncated), before: { delay_min: beforeW.delay_min, result: before }, options };
}

// ---------- Rule-based advisor (the one in use; rules: name the fastest detour · move a sign that sits after the turn · stagger overlapping works) ----------
const up = s => String(s ?? '').replace(/\s+/g, ' ').trim().toUpperCase();
function shortName(name) {
  let s = up(name).replace(/[^A-Z0-9 .,'&/:+-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s.length <= 10) return s;
  s = s.replace(/\s+(STREET|ST|ROAD|RD|AVENUE|AVE|LANE|LN|PARADE|PDE)$/, '');
  return s.length <= 10 ? s : s.split(' ')[0].slice(0, 10);
}
const dayNum = s => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / 86400000;

export async function mockAdvise(summary) {
  const out = [];
  const wsById = new Map((summary.worksites || []).map(w => [w.id, w]));
  const aps = [...(summary.approaches || [])].sort((a, b) => (b.delay_min || 0) - (a.delay_min || 0));
  const pick = ap => {
    const alts = (ap.routes || []).filter(r => r.id !== 'stay' && Number.isFinite(r.now_min));
    return alts.length ? alts.reduce((a, b) => (b.now_min < a.now_min || (b.now_min === a.now_min && (b.turn_m ?? 0) < (a.turn_m ?? 0)) ? b : a)) : null;
  };
  const vmsOf = (ws, ap) => (ws.equipment || []).find(e => e.type === 'vms' && (!e.dir || e.dir === ap.dir));
  for (const ap of aps) { // 1 reword: only suggest a detour when it really is faster now
    const ws = wsById.get(ap.worksite), best = pick(ap), stay = (ap.routes || []).find(r => r.id === 'stay');
    if (!ws || !best || !stay) continue;
    const save = Math.round(stay.now_min - best.now_min);
    if (!(save >= 1)) continue;
    // two frames, ≤ 3 lines each, ≤ 8 characters per line (road names excepted), to pass the soft warnings of checkSigns (apps/api check.js): a one-line "SAVE 9 MIN" is 10 characters, and saves of 10+ min used to split into 4 lines, so the advisor's own suggestion was warned by our own check
    const frames = [['USE', shortName(best.name)], ['SAVE', `${Math.min(save, 99)} MIN`]];
    const vms = vmsOf(ws, ap);
    if (vms && up(vms.frames?.flat().join(' ')) === up(frames.flat().join(' '))) continue;
    out.push({ kind: 'text', worksite: ws.id, equipment: vms ? vms.id : null, frames, ...(vms ? {} : { at_m: Math.min(2000, Math.round(((best.turn_m || 0) + 100) / 50) * 50) }),
      why: `Name the fastest detour (${best.name}) and the ${save} min it saves.` });
    break;
  }
  for (const ap of aps) { // 2 move equipment: the sign is after the recommended route's turn
    const ws = wsById.get(ap.worksite), best = pick(ap), vms = ws && vmsOf(ws, ap);
    if (!vms || !best || !(vms.at_m < (best.turn_m || 0))) continue;
    out.push({ kind: 'move', worksite: ws.id, equipment: vms.id, at_m: Math.min(2000, Math.round(((best.turn_m || 0) + 100) / 50) * 50),
      why: `The sign is ${vms.at_m} m before the works but the turn into ${best.name} is ${best.turn_m} m before; drivers see it too late.` });
    break;
  }
  for (const c of summary.conflicts || []) { // 3 shift dates
    const a = wsById.get(c.a), b = wsById.get(c.b);
    if (!(c.cost_min > 0) || !a?.time?.to || !b?.time?.from) continue;
    const days = dayNum(a.time.to) - dayNum(b.time.from) + 1;
    if (!(days > 0 && days <= 60)) continue;
    out.push({ kind: 'shift', worksite: b.id, days, why: `Overlaps ${a.id}; starting the day after it ends removes about ${Math.round(c.cost_min)} extra vehicle-minutes.` });
    break;
  }
  return { src: 'rule', suggestions: out.slice(0, 3) };
}
