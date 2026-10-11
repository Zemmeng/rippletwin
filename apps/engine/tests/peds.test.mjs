// footpath closure → pedestrian detour (peds.js + summary.peds in backend.js). Uses the real walk.json / peds.json / network.json from apps/roads, offline
import { readFileSync, existsSync } from 'node:fs';
import { ok, t, done } from './_t.mjs';
import { connect, demoPlan, PATHS } from '../public/js/backend.js';
import { pedImpact, WALK_MPS, validatePlan, validateWorksite, loadNetwork, footpathOf, MIN_REACH } from '../public/js/index.js';

const APPS = new URL('../../', import.meta.url);
const file = p => new URL('.' + p, APPS);
for (const p of [PATHS.network, PATHS.walk, PATHS.peds]) if (!existsSync(file(p))) { ok(false, `apps${p} not found`); done(); }
const J = p => JSON.parse(readFileSync(file(p), 'utf8'));
const walk = J(PATHS.walk), peds = J(PATHS.peds), network = J(PATHS.network), net = loadNetwork(network);
const wl = new Map(walk.links.map(l => [l.id, l]));
const fakeFetch = async url => (existsSync(file(url)) ? { ok: true, status: 200, json: async () => JSON.parse(readFileSync(file(url), 'utf8')) } : { ok: false, status: 404 });
const noPedsFetch = async url => (url.includes('/walk.json') || url.includes('/peds.json') ? { ok: false, status: 404 } : fakeFetch(url));
const noImporter = async url => { throw new Error('404 ' + url); };
const withFp = (name, fp, o) => { const p = demoPlan(name, o); if (fp !== undefined) p.worksites[0].closes.footpath = fp; return p; };
const LON = 'l595594354_9756035316';
const ZERO = s => s.closed.length === 0 && s.closed_m === 0 && s.ped_h === 0 && s.detour_m === 0 && s.extra_min === 0 && s.crossings === 0 && s.blocked === false && s.detour.length === 0 && s.sensor === null;

await t('main demo: Lonsdale St westbound at 08:00, left footpath closed', async () => {
  const r = pedImpact(walk, peds, withFp('lonsdale', 'left'), { net });
  ok(r.src === 'peds' && r.footpath === 'left' && r.active && r.day === 'wd' && r.hour === 8, `src = peds, footpath = left, Tuesday = wd, 08:00`);
  ok(r.closed.length > 0 && r.closed.every(id => wl.get(id)?.road_link === LON && wl.get(id).side === 'left' && ['sidewalk', 'other', 'path'].includes(wl.get(id).kind)),
    `${r.closed.length} footpath segments closed (${r.closed_m} m), all on the works link, side = left, none a crossing`);
  const maxV = Math.max(...r.closed.map(id => peds.days.wd[id][8]));
  ok(r.ped_h > 0 && r.ped_h === maxV, `ped_h = busiest closed footpath at 08:00 = ${r.ped_h} ped/h (peds.json)`);
  ok(r.detour_m > 0 && r.extra_min > 0 && Math.abs(r.extra_min - (r.ped_h * r.detour_m) / (WALK_MPS * 60)) < 0.2,
    `${r.detour_m} m extra per person → ${r.extra_min} extra person-minutes (= ped_h × detour_m ÷ (${WALK_MPS} × 60))`);
  const closed = new Set(r.closed);
  ok(r.detour.length > 0 && r.detour.every(id => !closed.has(id) && wl.has(id)), `detour of ${r.detour.length} segments, none on a closed footpath (negative test)`);
  ok(Number.isInteger(r.crossings) && r.crossings === r.detour.filter(id => wl.get(id).kind === 'crossing' || wl.get(id).crossing != null).length && r.crossings >= 1, `the detour to the other side crosses the road ${r.crossings} times`);
  ok(r.step_free === null && r.assumed.walk_mps === WALK_MPS && /step/i.test(r.assumed.note), 'walk.json has no step data: step_free = null, assumed states the walking speed and why (no step-free claim)');
  ok(r.measured === r.closed.some(id => peds.method[id] === 'sensor') && (r.sensor === null || (typeof r.sensor.name === 'string' && r.sensor.ped_h >= 0)),
    `measured = ${r.measured} (${peds.method[r.closed[0]]}); nearest real counter ${r.sensor ? `${r.sensor.name} ${r.sensor.ped_h} ped/h, ${r.sensor.dist_m} m` : 'none'}`);
  const again = pedImpact(walk, peds, withFp('lonsdale', 'left'), { net });
  ok(JSON.stringify(again) === JSON.stringify(r), 'same input, same result');
});

await t('left / right / both', async () => {
  const L = pedImpact(walk, peds, withFp('lonsdale', 'left'), { net });
  const R = pedImpact(walk, peds, withFp('lonsdale', 'right'), { net });
  const B = pedImpact(walk, peds, withFp('lonsdale', 'both'), { net });
  ok(R.closed.length > 0 && R.closed.every(id => !L.closed.includes(id)), `right side (dual carriageway: on the opposite eastbound carriageway) closes ${R.closed.length} segments, no overlap with the left`);
  ok(B.closed.length === L.closed.length + R.closed.length && B.ped_h === L.ped_h + R.ped_h && B.stretches.length === 2, `both sides = left + right (two groups, ${B.ped_h} ped/h)`);
  ok(B.detour_m >= Math.min(L.detour_m, R.detour_m) && B.detour.every(id => !B.closed.includes(id)), `both sides closed: no crossing to the other side, ${B.detour_m} m extra per person (one side ${L.detour_m} / ${R.detour_m})`);
  const lat = pedImpact(walk, peds, withFp('latrobe', 'right'), { net });
  ok(lat.measured === lat.closed.some(id => peds.method[id] === 'sensor') && lat.measured, `La Trobe westbound right side: a closed footpath has a real counter → measured = true`);
});

await t('footpath not closed, or outside works hours → all zeros (negative test)', async () => {
  const none = pedImpact(walk, peds, withFp('lonsdale', undefined), { net });
  ok(none.src === 'peds' && none.footpath === 'none' && !none.active && ZERO(none), 'closes.footpath omitted → pedestrian impact all zeros');
  const nil = pedImpact(walk, peds, withFp('lonsdale', 'none'), { net });
  ok(nil.footpath === 'none' && ZERO(nil), "footpath = 'none' also counts as open");
  const late = pedImpact(walk, peds, withFp('lonsdale', 'left', { hour: 22 }), { net });
  ok(late.footpath === 'left' && !late.active && late.hour === 22 && ZERO(late), 'no works at 22:00 (hours 7–19) → all zeros, footpath still reports left');
  const we = withFp('lonsdale', 'left'); we.when = { date: '2026-10-10', hour: 8 };
  const wk = pedImpact(walk, peds, we, { net });
  ok(!wk.active && ZERO(wk), 'Saturday 10 Oct is outside the works dates → all zeros');
  const weP = withFp('lonsdale', 'left'); weP.when = { date: '2026-10-06', hour: 8, day: 'we' };
  const wd = pedImpact(walk, peds, weP, { net });
  ok(wd.day === 'we' && wd.ped_h === Math.max(...wd.closed.map(id => peds.days.we[id][8])), `when.day = we → weekend pedestrian counts (${wd.ped_h} ped/h)`);
});

await t('plan validation: footpath accepts only left / right / both', async () => {
  for (const v of ['left', 'right', 'both', 'none', null, undefined]) {
    const p = withFp('lonsdale', v);
    ok(validatePlan(p).length === 0, `footpath = ${JSON.stringify(v)} is valid`);
  }
  for (const v of ['LEFT', 'north', 1, true, ['left']]) {
    const errs = validatePlan(withFp('lonsdale', v));
    ok(errs.length === 1 && errs[0].includes('footpath'), `footpath = ${JSON.stringify(v)} → validation error (negative test)`);
  }
  ok(validateWorksite({ id: 'X', closes: { lanes: 1 } }).some(e => e.includes('links')) && validatePlan({ when: {} }).length === 1, 'missing links / missing worksites are reported too');
  ok(footpathOf({ closes: { footpath: 'both' } }) === 'both' && footpathOf({ closes: { footpath: 'x' } }) === 'none' && footpathOf({}) === 'none', 'footpathOf: unknown values count as open');
  let threw = null;
  try { pedImpact(walk, peds, withFp('lonsdale', 'north'), { net }); } catch (e) { threw = e; }
  ok(threw && /footpath/.test(threw.message), 'a direct pedImpact call with a malformed footpath throws too');
  const be = await connect({ fetch: fakeFetch, importer: noImporter });
  let err = null;
  try { await be.run(withFp('lonsdale', 'LEFT')); } catch (e) { err = e; }
  ok(err && err.code === 'bad_plan' && err.errors.length === 1 && be.validate(withFp('lonsdale', 'LEFT')).length === 1, 'backend.run with a malformed footpath → throws code = bad_plan (the page can call be.validate first)');
  let aerr = null;
  try { await be.advise(withFp('lonsdale', 'sideways')); } catch (e) { aerr = e; }
  ok(aerr && aerr.code === 'bad_plan', 'backend.advise rejects it too');
});

await t('backend: summary.peds and compare delta.peds_extra_min', async () => {
  const be = await connect({ fetch: fakeFetch, importer: noImporter });
  ok((await be.pedsReady()) === 'fetched' && be.status().peds === 'fetched', 'connect fetches walk.json + peds.json from same-origin /roads/public/cbd/ (in the background, pedsReady() → fetched)');
  const open = await be.run(withFp('lonsdale', undefined));
  const shut = await be.run(withFp('lonsdale', 'left'));
  ok(open.peds.src === 'peds' && ZERO(open.peds), 'footpath not closed: summary.peds all zeros');
  ok(shut.peds.src === 'peds' && shut.peds.extra_min > 0 && shut.peds.detour.length > 0 && typeof shut.peds.assumed.note === 'string', `left closed: summary.peds.extra_min = ${shut.peds.extra_min} person-minutes`);
  ok(shut.queue_m === open.queue_m && shut.affected_min === open.affected_min, 'closing a footpath does not change vehicle numbers (lane occupancy depends only on closes.lanes)');
  const c = await be.compare(withFp('lonsdale', undefined), withFp('lonsdale', 'left'));
  ok(c.delta.peds_extra_min === +(shut.peds.extra_min - open.peds.extra_min).toFixed(3) && c.delta.peds_extra_min > 0, `compare: delta.peds_extra_min = +${c.delta.peds_extra_min} (positive = worse)`);
  const c2 = await be.compare(withFp('lonsdale', 'both'), withFp('lonsdale', 'left'));
  ok(c2.delta.peds_extra_min < 0, `both sides → left only: delta.peds_extra_min = ${c2.delta.peds_extra_min} (negative = better)`);
});

await t('walk / peds unavailable: connect still works, summary.peds.src = null', async () => {
  const be = await connect({ fetch: noPedsFetch, importer: noImporter });
  await be.pedsReady();
  const st = be.status();
  ok(st.peds === 'none' && st.errors.some(e => e.includes('pedestrian')), 'status.peds = none, reason in status.errors');
  const s = await be.run(withFp('lonsdale', 'left'));
  ok(s.peds.src === null && s.peds.footpath === 'left' && !('extra_min' in s.peds), 'summary.peds = { src: null, footpath }, not a pretend 0 (negative test)');
  const ref = await (await connect({ fetch: fakeFetch, importer: noImporter })).run(withFp('lonsdale', 'left'));
  ok(s.queue_m === ref.queue_m && s.mean_delay_s === ref.mean_delay_s && s.queue_m > 0, `vehicle numbers unaffected (queue ${s.queue_m} m)`);
  const c = await be.compare(withFp('lonsdale', undefined), withFp('lonsdale', 'left'));
  ok(c.delta.peds_extra_min === null, 'without pedestrian data delta.peds_extra_min = null');
  const bad = await connect({ fetch: fakeFetch, importer: noImporter, walk: { nodes: 'x' }, peds: {} });
  ok(bad.status().peds === 'given' && (await bad.run(withFp('lonsdale', 'left'))).peds.src === null, 'injected walk in the wrong format: run does not crash, summary.peds.src = null');
  const lineNet = await connect({ network, flows: J(PATHS.flows), fetch: null, importer: noImporter });
  ok((await lineNet.pedsReady()) === 'none' && lineNet.status().peds === 'none', 'no fetch: still does not throw');
});

await t('no way round → blocked, pedestrians not counted in extra_min (small graph)', async () => {
  // a — b — c is one footpath on link R with no alternative: closing b—c cuts it
  const nodes = ['a', 'b', 'c', 'd'].map((id, i) => ({ id, lat: -37.81, lon: 144.96 + i * 0.001 }));
  const w = { nodes, links: [
    { id: 'ab', a: 'a', b: 'b', len_m: 88, kind: 'sidewalk', crossing: null, road_link: 'R0', side: 'left', geometry: [[-37.81, 144.96], [-37.81, 144.961]] },
    { id: 'bc', a: 'b', b: 'c', len_m: 88, kind: 'sidewalk', crossing: null, road_link: 'R', side: 'left', geometry: [[-37.81, 144.961], [-37.81, 144.962]] },
    { id: 'cd', a: 'c', b: 'd', len_m: 88, kind: 'sidewalk', crossing: null, road_link: 'R2', side: 'left', geometry: [[-37.81, 144.962], [-37.81, 144.963]] },
  ] };
  const pd = { days: { wd: { ab: Array(24).fill(10), bc: Array(24).fill(50), cd: Array(24).fill(10) } }, method: { bc: 'sensor' }, sensors: [] };
  const plan = { when: { date: '2026-10-06', hour: 8 }, worksites: [{ id: 'X', links: ['R'], closes: { lanes: 1, footpath: 'left' }, equipment: [] }] };
  const r = pedImpact(w, pd, plan);
  ok(r.blocked && r.blocked_ped_h === 50 && r.extra_min === 0 && r.detour.length === 0 && r.ped_h === 50 && r.measured, `only path closed: blocked = true, ${r.blocked_ped_h} ped/h stuck, not written off as 0 minutes`);
  // walk is treated as read-only (index cached per object): pass a new object after changing it
  const w2 = { ...w, links: [...w.links, { id: 'bxc', a: 'b', b: 'c', len_m: 200, kind: 'path', crossing: null, road_link: null, side: null, geometry: [[-37.81, 144.961], [-37.8105, 144.9615], [-37.81, 144.962]] }] };
  const r2 = pedImpact(w2, pd, plan);
  ok(!r2.blocked && r2.detour.join() === 'bxc' && r2.detour_m === 112 && r2.extra_min === +((50 * 112) / (WALK_MPS * 60)).toFixed(1), `add a 200 m path: detour = 200 − 88 = ${r2.detour_m} m, ${r2.extra_min} person-minutes`);
  ok(r2.crossings === 0 && r2.sensor === null, 'the path is not a crossing; no counter nearby → sensor = null');
});

// ---------- fixes from the second review ----------
// works link (Lonsdale westbound, a two-point straight line) in the local plane: left = +1 (left of driving direction = south kerb), right = −1
const K = 111320 * Math.cos(-37.81 * Math.PI / 180), KY = 110574;
const XY = ([lat, lon]) => [lon * K, lat * KY];
const lonGeo = network.links.find(l => l.id === LON).geometry.map(XY);
const [A0, B0] = [lonGeo[0], lonGeo[lonGeo.length - 1]];
const LEN = Math.hypot(B0[0] - A0[0], B0[1] - A0[1]), U = [(B0[0] - A0[0]) / LEN, (B0[1] - A0[1]) / LEN];
const wgeo = l => (l.geometry?.length >= 2 ? l.geometry : [walk.nodes.find(n => n.id === l.a), walk.nodes.find(n => n.id === l.b)].map(n => [n.lat, n.lon])).map(XY);
// how many metres a footpath on the `sign` side of the works link runs alongside it within [0, length] (angle < 45°, within 30 m laterally)
function besideFrontage(id, sign) {
  const g = wgeo(wl.get(id)); let m = 0;
  for (let i = 0; i + 1 < g.length; i++) {
    const d = Math.hypot(g[i + 1][0] - g[i][0], g[i + 1][1] - g[i][1]), n = Math.max(1, Math.ceil(d));
    if (!d || Math.abs(((g[i + 1][0] - g[i][0]) * U[0] + (g[i + 1][1] - g[i][1]) * U[1]) / d) < 0.7) continue; // crosswise pieces (laneway mouths) are not alongside
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n, p = [g[i][0] + t * (g[i + 1][0] - g[i][0]) - A0[0], g[i][1] + t * (g[i + 1][1] - g[i][1]) - A0[1]];
      const along = p[0] * U[0] + p[1] * U[1], lat = U[0] * p[1] - U[1] * p[0];
      if (along >= 0 && along <= LEN && Math.abs(lat) <= 30 && Math.sign(lat) === sign) m += d / n;
    }
  }
  return m;
}

await t('right side (opposite carriageway) chosen by parallel length, not midpoint (review P1)', async () => {
  const R = pedImpact(walk, peds, withFp('lonsdale', 'right'), { net });
  ok(besideFrontage('wl6167236662_6167344380', -1) >= 15 && R.closed.includes('wl6167236662_6167344380'),
    `the 81.8 m north-side footpath runs ${besideFrontage('wl6167236662_6167344380', -1).toFixed(1)} m alongside the works link (midpoint outside the works) → closed`);
  ok(!R.closed.includes('wl9756035311_13882913770'), `the 6.2 m fragment touching only ${besideFrontage('wl9756035311_13882913770', -1).toFixed(1)} m is not closed (negative test)`);
  const worst = Math.max(0, ...R.detour.map(id => besideFrontage(id, -1)));
  ok(R.detour.length > 0 && worst < 5, `right closed: no detour segment runs ≥ 5 m alongside the works link on the north side (max ${worst.toFixed(1)} m, negative test)`);
  const L = pedImpact(walk, peds, withFp('lonsdale', 'left'), { net });
  ok(Math.max(0, ...L.detour.map(id => besideFrontage(id, +1))) < 5, 'left closed: the detour does not run alongside the works link on the south side (negative test)');
  const B = pedImpact(walk, peds, withFp('lonsdale', 'both'), { net });
  ok(Math.max(0, ...B.detour.flatMap(id => [besideFrontage(id, 1), besideFrontage(id, -1)])) < 5 && B.extra_min > L.extra_min, `both closed: the detour runs alongside the works link on neither side, ${B.extra_min} person-minutes`);
  // on the network: closing the right side of this Southbank Blvd link used to find nothing yet report active = true with all zeros
  const sb = pedImpact(walk, peds, { when: { date: '2026-10-06', hour: 8 }, worksites: [{ id: 'S', links: ['l243097376_6713073579'], closes: { lanes: 1, footpath: 'right' } }] }, { net });
  ok(sb.closed.includes('wl9141340855_9141340867') && sb.ped_h > 0 && !sb.unmatched, `Southbank Blvd right closed: finds the opposite footpath running alongside most of it (${sb.ped_h} ped/h)`);
});

await t('crossings count streets crossed, not crossing segments (review P2)', async () => {
  for (const fp of ['left', 'right']) {
    const r = pedImpact(walk, peds, withFp('latrobe', fp), { net });
    const links = r.detour.map(id => wl.get(id));
    const pieces = links.filter(l => l.kind === 'crossing' || l.crossing != null).length;
    ok(r.crossings === 4 && pieces === 6, `La Trobe ${fp} closed: the detour crosses Swanston, La Trobe, Swanston, La Trobe = ${r.crossings} times (${pieces} crossing segments: the La Trobe crossing is split into 3 by refuge islands)`);
  }
  const L = pedImpact(walk, peds, withFp('lonsdale', 'left'), { net });
  ok(L.crossings === 2, `Lonsdale left closed: crossing Lonsdale and back = ${L.crossings} times`);
});

await t('the counter must be on the closed side (review P2)', async () => {
  const lat224 = peds.sensors.find(s => s.name === 'Lat224_T');
  const R = pedImpact(walk, peds, withFp('latrobe', 'right'), { net });
  ok(R.closed.includes(lat224.walk_link) && R.sensor?.name === 'Lat224_T' && R.sensor.on_closed === true, `right (north) closed: Lat224_T sits on the closed footpath → sensor = ${R.sensor?.name}, on_closed`);
  const L = pedImpact(walk, peds, withFp('latrobe', 'left'), { net });
  ok(L.sensor?.name !== 'Lat224_T' && (L.sensor === null || !R.closed.includes(peds.sensors.find(s => String(s.id) === String(L.sensor.id))?.walk_link)),
    `left (south) closed: Lat224_T across the road is not used as this stretch's measurement (sensor = ${L.sensor ? L.sensor.name : 'null'}, negative test)`);
  const lon = pedImpact(walk, peds, withFp('lonsdale', 'left'), { net });
  const s = lon.sensor && peds.sensors.find(x => String(x.id) === String(lon.sensor.id));
  ok(!s || !pedImpact(walk, peds, withFp('lonsdale', 'right'), { net }).closed.includes(s.walk_link), `Lonsdale left closed: counter ${lon.sensor?.name ?? 'none'} is not on the north footpath`);
});

await t('works on one straight street are not split in two when the bearing crosses 45° (review P2)', async () => {
  const plan = { when: { date: '2026-10-06', hour: 8 }, worksites: [{ id: 'S', links: ['l243097376_6713073579', 'l6713073579_1234672054'], closes: { lanes: 1, footpath: 'left' } }] };
  const r = pedImpact(walk, peds, plan, { net });
  const maxV = Math.max(...r.closed.map(id => peds.days.wd[id][8]));
  ok(r.stretches.length === 1 && r.ped_h === maxV, `Southbank Blvd, two links (312° / 319°), left closed = 1 stretch, ${r.ped_h} ped/h (previously split into W / N stretches, counting pedestrians twice)`);
  const one = pedImpact(walk, peds, { ...plan, worksites: [{ ...plan.worksites[0], links: ['l243097376_6713073579'] }] }, { net });
  ok(r.ped_h <= 2 * one.ped_h && r.ped_h >= one.ped_h, 'pedestrians over both links ≤ twice one link and ≥ one link');
});

await t('no footpath in the data on the closed side → unmatched, not "no impact" (review P2, negative test)', async () => {
  const at = (id, fp) => pedImpact(walk, peds, { when: { date: '2026-10-06', hour: 8 }, worksites: [{ id: 'U', links: [id], closes: { lanes: 1, footpath: fp } }] }, { net });
  for (const [id, fp] of [['no_such_link', 'left'], ['l289602682_1492145829', 'right'], ['l387153095_777795238', 'left']]) {
    const r = at(id, fp);
    ok(r.active && r.closed.length === 0 && r.unmatched === true && r.unmatched_sides.length === 1 && r.unmatched_sides[0].side === fp && /no footpath/.test(r.note) && typeof r.note_zh === 'string',
      `${id} closing ${fp}: no footpath found → unmatched = true with a note (not an unflagged 0)`);
  }
  const L = pedImpact(walk, peds, withFp('lonsdale', 'left'), { net });
  ok(L.unmatched === false && L.unmatched_sides.length === 0 && L.note === null, 'found → unmatched = false, note = null');
  const none = pedImpact(walk, peds, withFp('lonsdale', undefined), { net });
  ok(none.unmatched === false && none.note === null, 'no footpath closure is not unmatched');
  const emp = pedImpact(walk, peds, { when: { date: '2026-10-06', hour: 8 }, worksites: [{ id: 'E', links: [], closes: { lanes: 1, footpath: 'both' } }] }, { net });
  ok(emp.unmatched && emp.unmatched_sides.length === 2, 'empty links also report unmatched (one per side)');
});

await t('dead ends / small islands are not "no way round" (review P2, small graph)', async () => {
  // hexagonal ring p0…p5 (the wider network) + a dangling short footpath s—p1 + a small island p3—q1—q2 of two nodes
  const nodes = [...[0, 1, 2, 3, 4, 5].map(i => ({ id: 'p' + i, lat: -37.81 + 0.001 * Math.sin(i * Math.PI / 3), lon: 144.96 + 0.001 * Math.cos(i * Math.PI / 3) })),
    { id: 's', lat: -37.8095, lon: 144.9606 }, { id: 'q1', lat: -37.8105, lon: 144.9594 }, { id: 'q2', lat: -37.8106, lon: 144.9592 }];
  const at = id => nodes.find(n => n.id === id);
  const lk = (id, a, b, extra = {}) => ({ id, a, b, len_m: 100, kind: 'sidewalk', crossing: null, road_link: null, side: null, geometry: [[at(a).lat, at(a).lon], [at(b).lat, at(b).lon]], ...extra });
  const w = { nodes, links: [
    ...[0, 1, 2, 3, 4, 5].map(i => lk(`r${i}`, 'p' + i, 'p' + ((i + 1) % 6))),
    lk('sp1', 's', 'p1', { road_link: 'RS', side: 'left', len_m: 20 }),
    lk('p3q1', 'p3', 'q1', { road_link: 'RQ', side: 'left', len_m: 30 }), lk('q1q2', 'q1', 'q2', { len_m: 10 }),
  ] };
  const pd = { days: { wd: { sp1: Array(24).fill(525), p3q1: Array(24).fill(98), q1q2: Array(24).fill(5) } }, method: {}, sensors: [] };
  const plan = road => ({ when: { date: '2026-10-06', hour: 8 }, worksites: [{ id: 'X', links: [road], closes: { lanes: 1, footpath: 'left' } }] });
  const stub = pedImpact(w, pd, plan('RS'));
  ok(!stub.blocked && stub.dead_end && stub.blocked_ped_h === 0 && stub.extra_min === 0 && stub.ped_h === 525 && /dead end/.test(stub.note),
    'dangling short footpath (its end connects only to itself): dead_end, not blocked (previously reported "525 ped/h with no way round")');
  const pocket = pedImpact(w, pd, plan('RQ'));
  ok(!pocket.blocked && pocket.dead_end && pocket.extra_min === 0, `the other end is a 2-node island (< min(${MIN_REACH}, half the node count)): dead_end, not blocked`);
  // a real cut (proper networks on both sides) is still blocked: see the "no way round → blocked" small-graph test above (a—b and c—d on either side)
});

await t('connect does not wait for pedestrian data: vehicle numbers are not held up by 3.6 MB of walk / peds (review P1)', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const hangFetch = async url => (url.includes('/walk.json') || url.includes('/peds.json') ? (await gate, fakeFetch(url)) : fakeFetch(url));
  const be = await connect({ fetch: hangFetch, importer: noImporter, pedsWaitMs: 50 });
  ok(be.status().peds === 'loading', 'walk.json / peds.json never arrive, connect still completes (status.peds = loading)');
  const open = await be.run(withFp('lonsdale', undefined));
  ok(open.peds.src === 'peds' && ZERO(open.peds) && !open.peds.pending && open.queue_m > 0, 'no footpath closed this hour: no waiting, summary.peds all zeros, vehicle numbers returned');
  const late = await be.run(withFp('lonsdale', 'left', { hour: 22 }));
  ok(late.peds.src === 'peds' && ZERO(late.peds), 'footpath closed but works inactive this hour: no waiting either');
  const t1 = Date.now();
  const shut = await be.run(withFp('lonsdale', 'left'));
  const waited = Date.now() - t1;
  ok(shut.peds.src === null && shut.peds.pending === true && shut.peds.footpath === 'left' && !('extra_min' in shut.peds) && shut.queue_m === open.queue_m && waited < 2000,
    `footpath closed, data not in within 50 ms: summary.peds = { src: null, pending: true }, not a pretend 0, vehicle numbers returned (waited ${waited} ms)`);
  const c = await be.compare(withFp('lonsdale', undefined), withFp('lonsdale', 'left'));
  ok(c.delta.peds_extra_min === null, 'before the data arrives compare delta.peds_extra_min = null');
  release();
  ok((await be.pedsReady()) === 'fetched' && be.status().peds === 'fetched', 'data arrives → pedsReady() = fetched');
  const again = await be.run(withFp('lonsdale', 'left'));
  ok(again.peds.src === 'peds' && again.peds.extra_min > 0 && !again.peds.pending, `afterwards pedestrian numbers appear (${again.peds.extra_min} person-minutes)`);
  const slow = async url => (url.includes('/walk.json') ? (await new Promise(r => setTimeout(r, 30)), fakeFetch(url)) : fakeFetch(url));
  const be2 = await connect({ fetch: slow, importer: noImporter });
  const s2 = await be2.run(withFp('lonsdale', 'left'));
  ok(s2.peds.src === 'peds' && s2.peds.extra_min === again.peds.extra_min, 'slightly slow data (30 ms): a run with a closed footpath waits for it (default up to 8 s), same numbers');
});

done();
