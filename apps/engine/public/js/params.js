// params.js — entry point for engine parameters: `/params/public/params.json` from apps/params (every value carries a source; format in docs/hackathon/specs/T12-params-PRD.md §4).
// Sourced values are used when readable; anything unreadable, missing or invalid falls back item by item to the assumed values in choice.js / calibrate.js, and the source of every item is recorded.
// Usage: const params = await loadParams();  const engine = createEngine({ network, flows, readSigns, params });
//        in Node: applyParams(JSON.parse(fs.readFileSync('apps/params/public/params.json', 'utf8')))
//
// Fields the engine accepts (other fields are accepted but unused, listed in used.ignored):
//   mix.<persona>                 share of each of the 4 personas; all 4 required, each 0–1, summing to 1 ± 0.02 (normalised), otherwise the whole group uses assumed values
//   anchors.generic_warning_divert diversion under a generic "roadwork ahead" warning → low calibration point; named_route_divert with a named route → high point. Both required, 0–1, low < high
//   persona.<persona>.hurry | familiar | trust | queue_averse | truck_only   map directly to PERSONAS in choice.js, falling back item by item
//   persona.<persona>.route_familiarity (older alias from the T12 parameter spec: share who know an alternative route, 0–1) = alias of familiar, used when familiar is absent
//   persona.<persona>.sign_trust  share who follow what the sign says (0–1). For a persona without trust, when at least 2 personas have sign_trust,
//                                 it converts to a relative multiplier sign_trust ÷ (mix-weighted mean), average driver = 1 (the absolute level is absorbed by calibration strength B)
// Each value can be { value: n } or a bare number; value null (not found) counts as absent.

import { TYPES, MIX, PERSONAS, FAMILIAR_MIN } from './choice.js';
import { ANCHORS } from './calibrate.js';

export const PARAMS_URL = '/params/public/params.json';

// valid range per item (out of range → error + assumed value; familiar goes into ln(), so its lower bound is the same constant as in choice.js)
const PERSONA_KEYS = {
  hurry: [0.05, 5],
  familiar: [FAMILIAR_MIN, 1],
  trust: [0, 3],
  queue_averse: [0, 5],
};
const MIX_TOL = 0.02;
const APPLIED = new WeakSet(); // marks applyParams results: createEngine trusts only these and treats anything else as raw params.json

const own = (o, k) => o != null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const inRange = (v, [lo, hi]) => v != null && v >= lo && v <= hi;

export const isApplied = x => x != null && typeof x === 'object' && APPLIED.has(x);

function defaults() {
  return {
    mix: { ...MIX },
    personas: Object.fromEntries(TYPES.map(t => [t, { ...PERSONAS[t] }])),
    anchors: { lo: ANCHORS.lo.real, hi: ANCHORS.hi.real },
  };
}

// json → { mix, personas, anchors, used }; if json is not an object, everything uses assumed values. MIX / PERSONAS / ANCHORS themselves are never modified
export function applyParams(json) {
  const out = defaults();
  const used = { src: 'default', version: null, mix: 'default', anchors: 'default', persona: {}, ignored: [], errors: [] };
  for (const t of TYPES) used.persona[t] = Object.fromEntries([...Object.keys(PERSONA_KEYS), 'truck_only'].map(k => [k, 'default']));
  const done = () => { const r = { ...out, used }; APPLIED.add(r); return r; };
  if (json == null || typeof json !== 'object' || Array.isArray(json)) {
    if (json != null) used.errors.push('params.json is not an object');
    return done();
  }
  // read a number: { value: n } or a bare number. value null / missing → not found (not an error); present but not a finite number ("0.05", "3%", true) → error
  const num = (x, path) => {
    const v = x != null && typeof x === 'object' && !Array.isArray(x) ? x.value : x;
    if (v == null) return null;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    used.errors.push(`${path} = ${JSON.stringify(v)} is not a number`);
    return null;
  };
  const ignore = (obj, keep, prefix) => {
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) used.ignored.push(...Object.keys(obj).filter(k => !keep.has(k)).map(k => prefix + k));
  };
  used.src = 'params';
  used.version = num(json.version, 'version');
  ignore(json, new Set(['version', 'mix', 'anchors', 'persona']), '');

  // persona mix: all or nothing (cannot normalise with one missing)
  if (own(json, 'mix')) {
    ignore(json.mix, new Set(TYPES), 'mix.');
    const m = Object.fromEntries(TYPES.map(t => [t, own(json.mix, t) ? num(json.mix[t], `mix.${t}`) : null]));
    const sum = TYPES.reduce((s, t) => s + (m[t] ?? NaN), 0);
    if (!TYPES.every(t => inRange(m[t], [0, 1]))) used.errors.push('mix: all 4 personas need a value between 0 and 1');
    else if (!(Math.abs(sum - 1) <= MIX_TOL)) used.errors.push(`mix: values sum to ${+sum.toFixed(3)}, not 1`);
    else { for (const t of TYPES) out.mix[t] = m[t] / sum; used.mix = 'params'; }
  }

  // the two calibration targets (replaced together: replacing only one would solve A and B from two different sources)
  if (own(json, 'anchors')) {
    ignore(json.anchors, new Set(['generic_warning_divert', 'named_route_divert']), 'anchors.');
    const lo = own(json.anchors, 'generic_warning_divert') ? num(json.anchors.generic_warning_divert, 'anchors.generic_warning_divert') : null;
    const hi = own(json.anchors, 'named_route_divert') ? num(json.anchors.named_route_divert, 'anchors.named_route_divert') : null;
    if (lo == null && hi == null) { /* neither found: use assumed values, not an error */ }
    else if (!(inRange(lo, [0.001, 0.999]) && inRange(hi, [0.001, 0.999]) && lo < hi)) used.errors.push('anchors: generic_warning_divert and named_route_divert must both be between 0 and 1, the first smaller than the second');
    else { out.anchors = { lo, hi }; used.anchors = 'params'; }
  }

  // per-persona parameters: fall back item by item
  const P = own(json, 'persona') && json.persona && typeof json.persona === 'object' ? json.persona : null;
  if (P) {
    ignore(P, new Set(TYPES), 'persona.');
    const st = {};
    for (const t of TYPES) {
      const src = own(P, t) ? P[t] : null;
      if (!src || typeof src !== 'object') continue;
      const alias = !own(src, 'familiar') && own(src, 'route_familiarity'); // older alias from the T12 parameter spec
      ignore(src, new Set([...Object.keys(PERSONA_KEYS), 'truck_only', 'sign_trust', ...(alias ? ['route_familiarity'] : [])]), `persona.${t}.`);
      for (const [k, range] of Object.entries(PERSONA_KEYS)) {
        const key = k === 'familiar' && alias ? 'route_familiarity' : k;
        if (!own(src, key)) continue;
        const v = num(src[key], `persona.${t}.${key}`);
        if (v == null) continue;
        if (!inRange(v, range)) { used.errors.push(`persona.${t}.${key} = ${v} is outside ${range[0]}–${range[1]}`); continue; }
        out.personas[t][k] = v;
        used.persona[t][k] = 'params';
      }
      if (own(src, 'truck_only')) {
        const v = src.truck_only != null && typeof src.truck_only === 'object' ? src.truck_only.value : src.truck_only;
        if (typeof v === 'boolean') { out.personas[t].truck_only = v; used.persona[t].truck_only = 'params'; }
        else if (v != null) used.errors.push(`persona.${t}.truck_only = ${JSON.stringify(v)} is not a boolean`);
      }
      if (own(src, 'sign_trust')) {
        const v = num(src.sign_trust, `persona.${t}.sign_trust`);
        if (v == null) continue;
        if (!inRange(v, [0, 1])) { used.errors.push(`persona.${t}.sign_trust = ${v} is not within 0–1`); continue; }
        st[t] = v;
      }
    }
    // sign_trust (share who follow the sign) → relative multiplier: the mix-weighted mean over the personas that have a value = 1; "relative" needs at least 2.
    // Only fills personas without an explicit trust; values above the cap are clipped to it (distorts the group least) rather than reverting to the assumed value
    const have = TYPES.filter(t => st[t] != null);
    if (have.length >= 2) {
      const w = have.reduce((s, t) => s + out.mix[t], 0);
      const mean = have.reduce((s, t) => s + out.mix[t] * st[t], 0) / (w || 1);
      if (mean > 0) {
        for (const t of have) {
          if (used.persona[t].trust === 'params') continue;
          let v = st[t] / mean;
          if (v > PERSONA_KEYS.trust[1]) { used.errors.push(`persona.${t}.sign_trust converts to ${+v.toFixed(3)}, clipped to ${PERSONA_KEYS.trust[1]}`); v = PERSONA_KEYS.trust[1]; }
          out.personas[t].trust = v;
          used.persona[t].trust = 'sign_trust';
        }
      }
    } else if (have.length === 1) {
      used.errors.push(`persona.*.sign_trust: only ${have[0]} has a value; at least 2 personas are needed to convert to relative multipliers`);
    }
  }
  used.ignored.sort();
  return done();
}

// in the browser, reads /params/public/params.json from the same origin by default; any failure (404, offline, not JSON) falls back without throwing
export async function loadParams({ url = PARAMS_URL, fetch: f = globalThis.fetch } = {}) {
  if (typeof f !== 'function') return applyParams(null);
  try {
    const res = await f(url);
    if (!res || !res.ok) {
      const r = applyParams(null);
      r.used.errors.push(`Failed to read ${url}: HTTP ${res ? res.status : 'no response'}`);
      return r;
    }
    return applyParams(await res.json());
  } catch (e) {
    const r = applyParams(null);
    r.used.errors.push(`Failed to read ${url}: ${e?.message || e}`);
    return r;
  }
}
