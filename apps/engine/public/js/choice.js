// choice.js — step 4: the choice model (D-0929-1435). The LLM only returns a "reading" (noticed, understood, which road to use / avoid, minutes saved or delay quoted, trust);
// how many people take each route is computed here from explicit per-persona parameters. Pure and deterministic.
//
// Each persona splits into two groups: the share "persuaded" by the signs, I = notice × understand × trust (× the persona's trust in signs), and the unpersuaded 1 − I.
//   Both groups choose by logit: utility = −β × hurry × minutes (the stay route also adds the visible queue); detours also carry inertia −A and familiarity ln(familiar)
//   Persuaded group: a road the sign says to use gets +B (not limited by familiarity), a road it says to avoid −B; "save N min" → that road +β × hurry × N; "N min delay" on the stay route → stay −β × hurry × N
//   Truck-only drivers (delivery) cannot see detours closed to trucks
// The two global parameters A and B come from two-point calibration (calibrate.js); the rest are engineering assumptions, edited here.

export const TYPES = ['commuter', 'local', 'tourist', 'delivery'];
// share of traffic by persona (assumed default; overridden by params.json mix)
export const MIX = { commuter: 0.5, local: 0.25, tourist: 0.1, delivery: 0.15 };
// Explicit per-persona parameters (the five listed in D-0929-1435): hurry · familiar (would think of the detour unprompted, 0–1) ·
// trust in signs (multiplies the reading's trust) · queue_averse · truck_only
export const PERSONAS = {
  commuter: { hurry: 1.0, familiar: 0.6, trust: 1.0, queue_averse: 1.0, truck_only: false },
  local: { hurry: 0.8, familiar: 1.0, trust: 0.6, queue_averse: 1.2, truck_only: false },
  tourist: { hurry: 0.5, familiar: 0.1, trust: 1.1, queue_averse: 0.5, truck_only: false },
  delivery: { hurry: 0.9, familiar: 0.7, trust: 0.8, queue_averse: 0.8, truck_only: true },
};
export const FAMILIAR_MIN = 0.02; // familiarity goes into ln(); values below this are clamped (params.js uses the same lower bound)
export const BETA = 0.4; // utility per minute (engineering assumption)
export const QUEUE_MIN_PER_M = 0.004; // seeing a 1 km queue ahead ≈ feels like 4 extra minutes (engineering assumption)
export const DEFAULT_AB = { A: 4, B: 3 }; // defaults before calibration (overwritten once calibrated)

const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);

function softmax(ids, u) {
  const m = Math.max(...ids.map(id => u[id]));
  const e = ids.map(id => Math.exp(u[id] - m));
  const s = e.reduce((a, b) => a + b, 0);
  const out = {};
  ids.forEach((id, i) => { out[id] = e[i] / s; });
  return out;
}

// share of a persona persuaded by the signs
export function informed(p, reading) {
  if (!reading) return 0;
  return clamp01((reading.notice ?? 0) * (reading.understand ?? 0) * clamp01((reading.trust ?? 0) * p.trust));
}

// routes: [{ id, usual_min, truck }] (id 'stay' is the stay route); sign: { use: Set(id), avoid: Set(id), saving_min, delay_min }
// ctx: { A, B, I, queue_m } → { routeId: share }
export function chooseShares(p, routes, sign, ctx) {
  const ok = routes.filter(r => r.id === 'stay' || !(p.truck_only && r.truck === false));
  const ids = ok.map(r => r.id);
  const hasStay = ids.includes('stay');
  const base = {}, told = {};
  for (const r of ok) {
    let t = r.usual_min;
    if (r.id === 'stay') t += (ctx.queue_m || 0) * QUEUE_MIN_PER_M * p.queue_averse;
    base[r.id] = -BETA * p.hurry * t;
    told[r.id] = base[r.id];
    if (r.id !== 'stay') {
      const fam = Math.log(Math.max(FAMILIAR_MIN, p.familiar));
      base[r.id] += -ctx.A + fam;
      told[r.id] += -ctx.A + (sign.use.has(r.id) ? ctx.B + BETA * p.hurry * (sign.saving_min || 0) : fam);
      if (sign.avoid.has(r.id)) told[r.id] -= ctx.B;
    } else {
      if (sign.avoid.has('stay')) told.stay -= ctx.B;
      if (sign.delay_min) told.stay -= BETA * p.hurry * sign.delay_min;
    }
  }
  if (!ids.length) return {};
  if (!hasStay && ids.length === 0) return {};
  const a = softmax(ids, told), b = softmax(ids, base);
  const I = ctx.I || 0;
  const out = {};
  for (const r of routes) out[r.id] = 0;
  for (const id of ids) out[id] = I * a[id] + (1 - I) * b[id];
  return out;
}
