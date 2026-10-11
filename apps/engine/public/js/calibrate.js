// calibrate.js — two-point calibration (D-0929-1435: kept, now calibrating engine parameters).
// The LLM (or the rules) reads the sign text, but how many drivers actually divert comes from the engine's choice model, which has two global parameters that cannot be guessed:
//   A = detour inertia (larger = less willing to leave the stay route)   B = strength of a sign naming a road
// Both are fixed on one reference scene (La Trobe St westbound) with two "standard signs":
//   ROADWORK / AHEAD only        → about 3% of all vehicles divert (working assumption, low confidence)  — depends only on A (no road named), so solve A first
//   named route USE / RUSSELL ST → about 20% (Erke, Sagberg & Hagman 2007, high confidence)            — then solve B with A fixed
// Targets come from params.json anchors when present. Other wordings, queues and persona differences then follow from the choice model; no separate conversion. Both standard-sign readings must come from the same readSigns.

import { TYPES, MIX, PERSONAS, DEFAULT_AB, chooseShares, informed } from './choice.js';

export const ANCHORS = {
  lo: { frames: [['ROADWORK', 'AHEAD']], real: 0.03 },
  hi: { frames: [['USE', 'RUSSELL ST']], real: 0.2 },
};

// Reference scene: sign at 400 m, 200 mm characters readable for 9 s at 40 km/h; both detours turn off at the works start
export const REF = {
  street: 'La Trobe Street',
  kmh: 40,
  routes: [
    { id: 'stay', name: 'La Trobe Street', usual_min: 6 },
    { id: 'r1', name: 'Russell Street', usual_min: 8, diverge_m: 0 },
    { id: 'r2', name: 'Elizabeth Street', usual_min: 9, truck: false, diverge_m: 0 },
  ],
};

export function anchorRequest(which, persona) {
  return {
    persona,
    kmh: REF.kmh,
    signs: [
      { kind: 'vms', frames: ANCHORS[which].frames, read_s: 9 },
      { kind: 'sign', text: 'RIGHT LANE CLOSED', read_s: 9 },
    ],
    roads: REF.routes.map(r => r.name),
  };
}

// reading → "what the sign says" for the choice model (in the reference scene both detours turn after the sign, so everything is visible)
export function signOf(reading, street, routes) {
  const use = new Set(), avoid = new Set();
  const adv = reading?.advice || {};
  for (const r of routes) {
    if (r.id === 'stay') { if (adv[street] === 'avoid') avoid.add('stay'); continue; }
    if (adv[r.name] === 'use') use.add(r.id);
    if (adv[r.name] === 'avoid') avoid.add(r.id);
  }
  return { use, avoid, saving_min: reading?.saving_min || 0, delay_min: reading?.delay_min || 0 };
}

export function refDetour(readings, A, B, { personas = PERSONAS, mix = MIX } = {}) {
  let d = 0;
  for (const t of TYPES) {
    const R = readings[t];
    const p = personas[t];
    const sh = chooseShares(p, REF.routes, signOf(R, REF.street, REF.routes), { A, B, I: informed(p, R), queue_m: 0 });
    d += (mix[t] || 0) * (1 - (sh.stay ?? 0));
  }
  return d;
}

function bisect(f, lo, hi, target, increasing, iters = 60) {
  let a = lo, b = hi;
  for (let i = 0; i < iters; i++) {
    const m = (a + b) / 2;
    if ((f(m) < target) === increasing) a = m; else b = m;
  }
  return (a + b) / 2;
}

// target hit: within 5% relative error (targets can be as low as 0.1%, where an absolute tolerance would accept a result off by 2×)
const near = (d, t) => Math.abs(d - t) <= Math.max(1e-4, 0.05 * t);

// lo / hi: each persona's reading of the two standard signs { persona: reading }. If any persona is missing, no calibration (method: 'default')
// opts.anchors = { lo, hi }: target diversion shares for the two standard signs (params.json anchors; defaults to the values in ANCHORS)
export function calibrate(lo, hi, opts = {}) {
  const have = x => x && TYPES.every(t => x[t]);
  if (!have(lo) || !have(hi)) return { ...DEFAULT_AB, method: 'default', ok: false };
  const tLo = opts.anchors?.lo ?? ANCHORS.lo.real;
  const tHi = opts.anchors?.hi ?? ANCHORS.hi.real;
  const A = bisect(a => refDetour(lo, a, 0, opts), -10, 20, tLo, false);
  const dMax = refDetour(hi, A, 40, opts);
  const B = dMax < tHi ? 40 : bisect(b => refDetour(hi, A, b, opts), 0, 40, tHi, true);
  const loD = refDetour(lo, A, B, opts), hiD = refDetour(hi, A, B, opts);
  const srcs = new Set(TYPES.flatMap(t => [lo[t].src, hi[t].src]));
  const models = new Set(TYPES.flatMap(t => [lo[t].model, hi[t].model]));
  return {
    A: +A.toFixed(4),
    B: +B.toFixed(4),
    method: 'two_point',
    // false = at least one target cannot be reached: e.g. the readings give a named route too little weight, so B at its cap still misses the high target; or the target itself is unrealistic
    ok: near(loD, tLo) && near(hiD, tHi),
    target: { lo: tLo, hi: tHi },
    lo_detour: +loD.toFixed(4),
    hi_detour: +hiD.toFixed(4),
    src: srcs.size === 1 ? [...srcs][0] : 'mixed',
    model: models.size === 1 ? [...models][0] : 'mixed',
  };
}
