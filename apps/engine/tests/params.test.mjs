// parameter entry tests: params.json → engine (item-by-item fallback, calibration targets follow, unreadable file never throws, defaults cannot be corrupted)
import { ok, t, done, wsA, WHEN } from './_t.mjs';
import {
  applyParams, loadParams, PARAMS_URL, createEngine, makeGrid, mockReadSigns, calibrate, anchorRequest,
  TYPES, MIX, PERSONAS, ANCHORS,
} from '../public/js/index.js';

const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const snap = () => JSON.stringify({ MIX, PERSONAS, lo: ANCHORS.lo.real, hi: ANCHORS.hi.real });
const before = snap();
const v = x => ({ value: x, range: [x, x], source: 'test', confidence: 'low' });
const good = () => ({
  version: 1,
  mix: { commuter: v(0.4), local: v(0.3), tourist: v(0.1), delivery: v(0.2) },
  anchors: { generic_warning_divert: v(0.05), named_route_divert: v(0.25), stated_to_actual: v(0.2) },
  persona: {
    commuter: { hurry: v(1.2), familiar: v(0.5) },
    tourist: { familiar: v(null), trust: v(0.9) },
  },
  value_of_time: { car: v(20) },
  vms: {},
});

await t('applyParams: missing / not an object → all assumed values', async () => {
  const d = applyParams(null);
  ok(d.used.src === 'default' && d.used.errors.length === 0 && JSON.stringify(d.mix) === JSON.stringify(MIX) && d.anchors.lo === ANCHORS.lo.real && d.anchors.hi === ANCHORS.hi.real, 'null → assumed values, no error');
  ok(applyParams([1, 2]).used.src === 'default' && applyParams('x').used.errors.length === 1, 'array / string → assumed values, one error recorded');
});

await t('applyParams: valid values used, missing ones fall back item by item', async () => {
  const p = applyParams(good());
  ok(p.used.src === 'params' && p.used.version === 1 && p.used.mix === 'params' && near(p.mix.commuter, 0.4) && near(p.mix.delivery, 0.2), 'mix from params');
  ok(p.used.anchors === 'params' && p.anchors.lo === 0.05 && p.anchors.hi === 0.25, 'anchors from params');
  ok(p.personas.commuter.hurry === 1.2 && p.personas.commuter.familiar === 0.5 && p.used.persona.commuter.hurry === 'params', 'persona: given items from params');
  ok(p.personas.commuter.trust === PERSONAS.commuter.trust && p.used.persona.commuter.trust === 'default', 'persona: missing items use assumed values');
  ok(p.personas.tourist.familiar === PERSONAS.tourist.familiar && p.personas.tourist.trust === 0.9 && p.used.errors.length === 0, 'value null (not found) → fallback, not an error');
  ok(JSON.stringify(p.used.ignored) === JSON.stringify(['anchors.stated_to_actual', 'value_of_time', 'vms']), 'fields the engine does not use are listed in ignored (full path, including nested anchors.stated_to_actual)');
  ok(TYPES.every(t => near(applyParams({ mix: { commuter: 0.505, local: 0.25, tourist: 0.1, delivery: 0.15 } }).mix[t] * 1.005, [0.505, 0.25, 0.1, 0.15][TYPES.indexOf(t)], 1e-9)), 'mix sums to 1.005 (within tolerance) → normalised');
});

await t('applyParams: invalid groups / items fall back with an error', async () => {
  const bad = applyParams({ mix: { commuter: 0.6, local: 0.3, tourist: 0.1, delivery: 0.15 } });
  ok(bad.used.mix === 'default' && JSON.stringify(bad.mix) === JSON.stringify(MIX) && /sum to/.test(bad.used.errors[0]), 'mix sums to 1.15 → whole group uses assumed values');
  const miss = applyParams({ mix: { commuter: 0.5, local: 0.5, tourist: null, delivery: 0 } });
  ok(miss.used.mix === 'default' && miss.used.errors.length === 1, 'mix missing a persona → whole group uses assumed values');
  const inv = applyParams({ anchors: { generic_warning_divert: 0.3, named_route_divert: 0.2 } });
  ok(inv.used.anchors === 'default' && inv.anchors.lo === ANCHORS.lo.real && inv.used.errors.length === 1, 'anchors low ≥ high → assumed values');
  ok(applyParams({ anchors: { generic_warning_divert: v(null), named_route_divert: v(null) } }).used.errors.length === 0, 'neither anchor found → assumed values, not an error');
  const zero = applyParams({ persona: { local: { familiar: 0, hurry: -1, trust: 1.5 } } });
  ok(zero.personas.local.familiar === PERSONAS.local.familiar && zero.personas.local.hurry === PERSONAS.local.hurry && zero.personas.local.trust === 1.5 && zero.used.errors.length === 2, 'familiar = 0 (would break ln), hurry < 0 → these two fall back, trust is used');
  ok(applyParams({ persona: { delivery: { truck_only: { value: false } } } }).personas.delivery.truck_only === false, 'boolean truck_only is used');
  const rf = applyParams({ persona: { tourist: { route_familiarity: v(0.25) }, local: { familiar: 0.9, route_familiarity: 0.7 } } });
  ok(rf.personas.tourist.familiar === 0.25 && rf.used.persona.tourist.familiar === 'params' && rf.personas.local.familiar === 0.9, 'route_familiarity (older alias) = familiar; familiar wins when both are given');
  ok(applyParams({ persona: { delivery: { truck_only: 'yes' } } }).personas.delivery.truck_only === true, 'non-boolean truck_only → assumed value');
});

await t('applyParams: sign_trust (share following the sign) → relative multiplier', async () => {
  const st = { commuter: 0.4, local: 0.2, tourist: 0.6, delivery: 0.3 };
  const p = applyParams({ persona: Object.fromEntries(TYPES.map(t => [t, { sign_trust: v(st[t]) }])) });
  const mean = TYPES.reduce((s, t) => s + MIX[t] * st[t], 0);
  ok(TYPES.every(t => near(p.personas[t].trust, st[t] / mean) && p.used.persona[t].trust === 'sign_trust'), 'all 4 given → trust = sign_trust ÷ mix-weighted mean');
  ok(near(TYPES.reduce((s, t) => s + MIX[t] * p.personas[t].trust, 0), 1), 'after conversion the mix-weighted mean = 1');
  const both = applyParams({ persona: { ...Object.fromEntries(TYPES.map(t => [t, { sign_trust: st[t] }])), local: { sign_trust: 0.2, trust: 0.7 } } });
  ok(both.personas.local.trust === 0.7 && both.used.persona.local.trust === 'params', 'a persona with an explicit trust is not overridden by sign_trust');
  const part = applyParams({ persona: { commuter: { sign_trust: 0.4 } } });
  ok(part.personas.commuter.trust === PERSONAS.commuter.trust && part.used.errors.length === 1, 'only one persona has sign_trust → no conversion, one error');
});

await t('negative test: params.json cannot inject unknown personas or corrupt defaults', async () => {
  const evil = JSON.parse('{"mix":{"commuter":0.5,"local":0.25,"tourist":0.1,"delivery":0.15,"hacker":0.9,"__proto__":{"polluted":1}},"persona":{"__proto__":{"hurry":{"value":9}},"hacker":{"hurry":2},"constructor":{"trust":2}}}');
  const p = applyParams(evil);
  ok(Object.keys(p.mix).sort().join() === [...TYPES].sort().join() && Object.keys(p.personas).sort().join() === [...TYPES].sort().join(), 'mix / personas contain only the 4 personas');
  ok(({}).polluted === undefined && ({}).hurry === undefined && p.personas.commuter.hurry === PERSONAS.commuter.hurry, '__proto__ keys do not pollute the prototype or change any persona');
  applyParams(good());
  ok(snap() === before, 'MIX / PERSONAS / ANCHORS themselves are unchanged (applyParams returns copies)');
});

await t('8 confirmed review findings (review-params-correctness / interop)', async () => {
  const { network, flows } = makeGrid();
  const raw = { version: 1, used: ['VicRoads 2019'], mix: { commuter: v(0.5), local: v(0.25), tourist: v(0.1), delivery: v(0.15) } };
  const eu = createEngine({ network, flows, readSigns: mockReadSigns, params: raw });
  const planU = { when: WHEN, worksites: [wsA()] };
  await eu.prepare(planU);
  ok(eu.params.src === 'params' && eu.params.ignored.includes('used') && Number.isFinite(eu.evaluate(planU).delay_min) && eu.calib.ok, 'params.json with a top-level used key: still treated as raw, no crash');
  const str = applyParams({ anchors: { generic_warning_divert: v('0.05'), named_route_divert: v('0.25') }, persona: { commuter: { hurry: '1.5' } } });
  ok(str.used.anchors === 'default' && str.used.persona.commuter.hurry === 'default' && str.used.errors.filter(e => /is not a number/.test(e)).length === 3, 'string values → assumed values, each reported as "is not a number"');
  const clip = applyParams({ persona: { commuter: { sign_trust: 0.2 }, local: { sign_trust: 0.2 }, tourist: { sign_trust: 0.8 }, delivery: { sign_trust: 0.2 } } });
  ok(clip.personas.tourist.trust === 3 && clip.used.persona.tourist.trust === 'sign_trust' && near(clip.personas.commuter.trust, 0.2 / 0.26) && clip.used.errors.length === 1, 'sign_trust converting above the cap → clipped to 3 (not reverted to the assumed 1.1), one error');
  const three = applyParams({ persona: { commuter: { sign_trust: 0.4 }, local: { sign_trust: 0.2 }, tourist: { sign_trust: v(null) }, delivery: { sign_trust: 0.3 } } });
  const w3 = MIX.commuter + MIX.local + MIX.delivery, m3 = (MIX.commuter * 0.4 + MIX.local * 0.2 + MIX.delivery * 0.3) / w3;
  ok(near(three.personas.commuter.trust, 0.4 / m3) && three.used.persona.tourist.trust === 'default' && three.personas.tourist.trust === PERSONAS.tourist.trust && three.used.errors.length === 0, 'only 3 personas have sign_trust: those 3 convert (weighted mean among them = 1), the 4th uses the assumed value');
  ok(applyParams({ persona: { local: { familiar: 0.015 } } }).used.persona.local.familiar === 'default', 'familiar lower bound matches choice.js (0.02): 0.015 is rejected');
  const nest = applyParams({ mix: { commuter: 0.5, local: 0.25, tourist: 0.1, delivery: 0.15, visitor: 0.1 }, persona: { commuter: { speed: 1 }, pedestrian: {} } });
  ok(['mix.visitor', 'persona.commuter.speed', 'persona.pedestrian'].every(k => nest.used.ignored.includes(k)), 'nested unknown fields are listed in ignored too (with path)');
  const read = async which => Object.fromEntries(await Promise.all(TYPES.map(async t => [t, await mockReadSigns(anchorRequest(which, t))])));
  const lo = await read('lo'), hi = await read('hi');
  lo.tourist = { ...lo.tourist, advice: { 'La Trobe Street': 'avoid' }, trust: 0.2 };
  const c = calibrate(lo, hi, { anchors: { lo: 0.002, hi: 0.2 } });
  ok(c.ok === false && c.lo_detour > 0.003, `low target 0.2%, actual ${c.lo_detour} (off by 2×) → ok = false (relative tolerance)`);
});

await t('loadParams: used when readable, never throws when not', async () => {
  let asked = null;
  const r = await loadParams({ fetch: async url => { asked = url; return { ok: true, status: 200, json: async () => good() }; } });
  ok(asked === PARAMS_URL && PARAMS_URL === '/params/public/params.json' && r.used.src === 'params' && r.anchors.hi === 0.25, 'reads same-origin /params/public/params.json by default');
  const nf = await loadParams({ fetch: async () => ({ ok: false, status: 404 }) });
  ok(nf.used.src === 'default' && /404/.test(nf.used.errors[0]), '404 → assumed values, reason in errors');
  const boom = await loadParams({ fetch: async () => { throw new Error('offline'); } });
  ok(boom.used.src === 'default' && /offline/.test(boom.used.errors[0]), 'offline → assumed values');
  const junk = await loadParams({ fetch: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } }) });
  ok(junk.used.src === 'default' && /bad json/.test(junk.used.errors[0]), 'not JSON → assumed values');
  ok((await loadParams({ fetch: null })).used.src === 'default', 'no fetch (old Node) → assumed values');
});

await t('createEngine({ params }): calibration targets, mix and persona parameters follow params', async () => {
  const { network, flows } = makeGrid();
  const plan = { when: WHEN, worksites: [wsA([['USE', 'RUSSELL ST']])] };
  const e0 = createEngine({ network, flows, readSigns: mockReadSigns });
  await e0.prepare(plan);
  ok(e0.params.src === 'default' && e0.calib.ok && near(e0.calib.hi_detour, 0.2, 1e-3), 'no params → assumed values, calibrated to 3% / 20%');
  const e1 = createEngine({ network, flows, readSigns: mockReadSigns, params: good() });
  await e1.prepare(plan);
  ok(e1.params.src === 'params' && e1.params.mix.commuter === 0.4 && e1.params.personas.commuter.hurry === 1.2, 'engine.params reports which values are used');
  ok(e1.params.used.mix === 'params' && e1.params.used.anchors === 'params' && e1.params.used.persona.commuter.hurry === 'params' && e1.params.used.persona.local.hurry === 'default' && JSON.stringify(e1.params.ignored) === '["anchors.stated_to_actual","value_of_time","vms"]', 'engine.params.used reports the source per item (params / default)');
  ok(e1.calib.ok && near(e1.calib.lo_detour, 0.05, 1e-3) && near(e1.calib.hi_detour, 0.25, 1e-3) && e1.calib.target.hi === 0.25, `calibration targets switch to 5% / 25% (A ${e1.calib.A}, B ${e1.calib.B})`);
  const r0 = e0.evaluate(plan), r1 = e1.evaluate(plan);
  ok(r1.delay_min !== r0.delay_min && Number.isFinite(r1.delay_min), `results follow the parameters (total delay ${r0.delay_min} → ${r1.delay_min})`);
  const e2 = createEngine({ network, flows, readSigns: mockReadSigns, params: applyParams(good()), mix: MIX });
  ok(e2.params.mix.commuter === MIX.commuter && e2.params.override.join() === 'mix', 'an explicit mix takes precedence over params, recorded in override');
  e1.params.mix.commuter = 9;
  ok(e1.params.mix.commuter === 0.4, 'engine.params returns a copy; changing it does not affect the engine');
});

await t('calibrate: ok = false when a target is unreachable', async () => {
  const read = async which => Object.fromEntries(await Promise.all(TYPES.map(async t => [t, await mockReadSigns(anchorRequest(which, t))])));
  const lo = await read('lo'), hi = await read('hi');
  ok(calibrate(lo, hi, { anchors: { lo: 0.03, hi: 0.2 } }).ok, '3% / 20% reachable');
  ok(calibrate(lo, hi, { anchors: { lo: 0.03, hi: 0.999 } }).ok === false, 'high target 99.9%: unreachable even with B at its cap → ok = false');
});

done();
