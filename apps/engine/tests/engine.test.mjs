// Engine unit tests: network, shortest paths, BPR, works time windows, step 1 detours, step 2 reading requests, step 4 choice model + two-point calibration,
// evaluate / window / conflict, advisor suggestions. Readings come from the engine's mock reader or fake readings; no dependency on the api module.
import { ok, t, done, wsA, wsB, WHEN } from './_t.mjs';
import {
  makeGrid, loadNetwork, shortestPath, linkTime, bearing, isActive, overlaps, capFactors, shiftWorksite, windowWhens, dayType,
  affected, requestsFor, readSeconds, chooseShares, informed, PERSONAS, TYPES, MIX, calibrate, anchorRequest, createEngine,
  mockReadSigns, applySuggestion, checkSuggestion, mockAdvise,
} from '../public/js/index.js';

const { network, flows } = makeGrid();
const net = loadNetwork(network);
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;
const counting = () => { const f = async req => { f.n++; return mockReadSigns(req); }; f.n = 0; return f; };

await t('grid, paths, BPR, worksite time', async () => {
  ok(network.nodes.length === 45 && network.links.length === 152, 'toy grid 5 × 9: 45 nodes, 152 directed links');
  const need = ['id', 'from', 'to', 'name', 'highway', 'len_m', 'lanes', 'speed_kmh', 'cap_vph', 't0_s', 'tram', 'bike_lane', 'osm_way', 'geometry'];
  ok(network.links.every(l => need.every(k => k in l)) && network.links.every(l => flows.days.wd[l.id].length === 24), 'all fields present (network data file spec), 24 hours of flow per link');
  ok(bearing(net, net.links.get('L-n0_6-n0_5')) === 'W', 'direction: La Trobe St westbound is W');
  const p = shortestPath(net, 'n0_8', 'n0_3'), q = shortestPath(net, 'n0_8', 'n0_3', { banned: new Set(['L-n0_6-n0_5']) });
  ok(p.links.length === 5 && q.links.length === 7 && JSON.stringify(q) === JSON.stringify(shortestPath(net, 'n0_8', 'n0_3', { banned: new Set(['L-n0_6-n0_5']) })), 'shortest path: 5 links straight, 7 links around one closed link; ties resolved deterministically');
  ok(linkTime(38, 0, 1800) === 38 && near(linkTime(38, 1000, 800) - linkTime(38, 800, 800), (200 * 3600) / 1600), 'BPR; over capacity uses D/D/1: mean extra wait (v−c)T/(2c) (including clearance)');
  const a = wsA();
  ok(isActive(a, WHEN) && !isActive(a, { date: '2026-10-06', hour: 19 }) && isActive(a, { date: '2026-10-06', hour: 18 }), 'works hours [7, 19): active at 18:00, not at 19:00');
  ok(overlaps(a, wsB()) && !overlaps(a, shiftWorksite(wsB(), 3)) && dayType({ date: '2026-10-04' }) === 'we', 'dates overlap; shifted 3 days they do not; Sunday is a weekend day');
  ok(near(capFactors(net, [a]).get('L-n0_6-n0_5').f, 0.45), '1 of 2 lanes closed: capacity × 0.5 × 0.9');
  const night = { id: 'N', links: ['L-n0_6-n0_5'], closes: { lanes: 1 }, time: { from: '2026-10-05', to: '2026-10-09', hours: [20, 24] }, equipment: [] };
  ok(JSON.stringify([...new Set(windowWhens([night]).map(w => w.hour))]) === '[21]', 'night works sample the middle of their hours (21:00), not the fixed 8 and 17');
  const year = { ...a, time: { from: '2026-10-01', to: '2027-09-30', hours: [7, 19] } };
  const W = windowWhens([year]);
  ok(W.truncated && W.length === 62, 'a one-year worksite: only the first 31 days × 2 hours are sampled, flagged truncated');
});

await t('step 1-2: detours and reading requests', async () => {
  const [ap] = affected(net, flows, wsA(), WHEN, capFactors(net, [wsA()]));
  ok(ap.street === 'La Trobe St' && ap.dir === 'W' && ap.to === 'Queen St' && ap.volume === 1100, 'affected: La Trobe St westbound, 1,100 veh/h at 17:00');
  ok(ap.alts.map(r => r.name).sort().join() === 'Exhibition St,Russell St,Spring St' && ap.alts.every(r => !r.links.includes('L-n0_6-n0_5')), '3 detours (named after the street turned into), none through the works link');
  ok(ap.alts.find(r => r.name === 'Spring St').diverge_m === 400 && ap.alts.find(r => r.name === 'Russell St').diverge_m === 0, 'turn positions: Russell at the works start, Spring 400 m before');
  const reqs = requestsFor(ap, wsA([['USE', 'SPRING ST']]), TYPES);
  const f = reqs.full.commuter;
  ok(f.persona === 'commuter' && f.kmh === 40 && f.signs.length === 2 && f.signs[0].kind === 'vms' && f.signs[0].read_s === readSeconds(40, 320) && !('m' in f.signs[0]), 'reading request: signs in driving order with read seconds; positions are not sent (sign-reading interface)');
  ok(f.roads[0] === 'La Trobe St' && f.roads.length === 4, 'roads = current street + candidate detours');
  const spring = ap.alts.find(r => r.name === 'Spring St').id, russell = ap.alts.find(r => r.name === 'Russell St').id;
  ok(reqs.prefix.commuter[spring] === null && reqs.prefix.commuter[russell].signs.length === 2, 'sign at 300 m, Spring turn at 400 m: no sign visible before the turn (no prefix request); Russell turns at the works start: both signs visible');
  const many = wsA([['X']], { equipment: Array.from({ length: 10 }, (_, i) => ({ id: 's' + i, type: 'sign', at_m: 100 + i * 50, text: 'SIGN ' + i })) });
  ok(requestsFor(ap, many, ['commuter']).full.commuter.signs.length === 6, 'of 10 signs only the 6 nearest the works are kept');
  const line = { version: 1, nodes: ['a', 'b', 'c', 'd'].map((id, i) => ({ id, lat: -37.81, lon: 144.95 + i * 0.002 })),
    links: [['a', 'b'], ['b', 'c'], ['c', 'd']].map(([x, y]) => ({ id: x + y, from: x, to: y, name: null, len_m: 200, lanes: 2, speed_kmh: 40, cap_vph: 1800, t0_s: 38 })) };
  const [lap] = affected(loadNetwork(line), null, { id: 'X', links: ['bc'], closes: { lanes: 1 } }, WHEN);
  ok(lap.street === 'Unnamed road' && lap.stayLinks.length === 3, 'unnamed links still chain into one approach (the real network has 193 unnamed links)');
  const g2 = makeGrid();
  for (const l of g2.network.links) if (l.id === 'L-n0_6-n1_6') l.highway = 'living_street'; // turn the La Trobe → Lonsdale block of Russell St into a laneway
  const n2 = loadNetwork(g2.network);
  const [ap2] = affected(n2, g2.flows, wsA(), WHEN, capFactors(n2, [wsA()]));
  ok(ap2.alts.every(r => r.links.every(id => n2.links.get(id).highway !== 'living_street')) && ap2.alts.length >= 2, `detours avoid laneways (living_street): ${ap2.alts.map(r => r.name).join(' / ')}`);
  ok(ap2.stay.links.length === ap.stay.links.length, 'stay route unaffected');
});

await t('step 4: choice model', async () => {
  const routes = [{ id: 'stay', usual_min: 6 }, { id: 'r1', usual_min: 8 }, { id: 'r2', usual_min: 9, truck: false }];
  const none = { use: new Set(), avoid: new Set(), saving_min: 0, delay_min: 0 };
  const told = { use: new Set(['r1']), avoid: new Set(), saving_min: 0, delay_min: 0 };
  const c = PERSONAS.commuter, ctx = { A: 3, B: 3, I: 0.6, queue_m: 0 };
  const sum = s => Object.values(s).reduce((a, b) => a + b, 0);
  ok(near(sum(chooseShares(c, routes, told, ctx)), 1) && near(sum(chooseShares(PERSONAS.delivery, routes, none, ctx)), 1), 'shares sum to 1');
  ok(chooseShares(c, routes, told, ctx).r1 > chooseShares(c, routes, none, ctx).r1, 'sign says use r1 → r1 share rises');
  ok(chooseShares(c, routes, told, { ...ctx, I: 0 }).r1 === chooseShares(c, routes, none, { ...ctx, I: 0 }).r1, 'with nobody persuaded (I = 0) the sign text makes no difference');
  ok(chooseShares(c, routes, { ...told, saving_min: 8 }, ctx).r1 > chooseShares(c, routes, { ...told, saving_min: 2 }, ctx).r1, '"save 8 min" diverts more than "save 2 min"');
  ok(chooseShares(c, routes, none, { ...ctx, queue_m: 1000 }).stay < chooseShares(c, routes, none, ctx).stay, 'seeing a 1 km queue ahead → fewer stay');
  const dTold = { use: new Set(['r2']), avoid: new Set(), saving_min: 5, delay_min: 0 };
  ok(chooseShares(PERSONAS.delivery, routes, dTold, ctx).r2 === 0 && chooseShares(c, routes, dTold, ctx).r2 > 0, 'negative: sign says use r2 (no trucks), delivery drivers stay at 0 (commuters do go)');
  ok(chooseShares(c, routes, { ...none, avoid: new Set(['stay']) }, ctx).stay < chooseShares(c, routes, none, ctx).stay, 'sign says avoid the stay route → fewer stay');
  ok(near(informed(c, { notice: 0.9, understand: 0.8, trust: 0.5 }), 0.36) && informed(c, null) === 0, 'persuaded = notice × understand × trust (× persona trust in signs); no reading = 0');
});

await t('step 4: two-point calibration', async () => {
  const read = async which => Object.fromEntries(await Promise.all(TYPES.map(async p => [p, await mockReadSigns(anchorRequest(which, p))])));
  const cal = calibrate(await read('lo'), await read('hi'));
  ok(cal.method === 'two_point' && cal.ok && near(cal.lo_detour, 0.03, 1e-3) && near(cal.hi_detour, 0.2, 1e-3), `two-point calibration: ROADWORK AHEAD → 3%, USE RUSSELL ST → 20% (A ${cal.A}, B ${cal.B})`);
  ok(calibrate(null, null).method === 'default', 'missing anchor readings → default parameters, method = default');
  const flat = await read('lo');
  ok(calibrate(flat, flat).ok === false, 'both signs read the same (no road named) → B at its cap still misses 20%, ok = false');
});

await t('evaluate', async () => {
  const eng = createEngine({ network, flows, readSigns: mockReadSigns });
  const plan = { when: WHEN, worksites: [wsA()] };
  const fresh = createEngine({ network, flows, readSigns: mockReadSigns });
  ok(fresh.evaluate(plan).missing > 0, 'evaluate before prepare: reports the number of missing readings (missing)');
  const prep = await eng.prepare(plan);
  ok(prep.asked === 16 && prep.failed === 0 && prep.calib.method === 'two_point', `prepare: 8 anchor readings + 8 for this approach (actual ${prep.asked})`);
  const again = await eng.prepare(plan);
  ok(again.asked === 0, 'each wording asked once per persona; the cache stays valid');
  const r = eng.evaluate(plan);
  ok(r.missing === 0 && r.delay_min > 0 && r.approaches[0].queue_m > 0 && r.hot[0].name === 'La Trobe St', `one lane closed: total delay ${r.delay_min} veh·min, queue ${r.approaches[0].queue_m} m`);
  ok(JSON.stringify(eng.evaluate(plan, { seed: 1 })) === JSON.stringify(r), 'same input run twice gives an identical result');
  ok(r.links.length === 152 && r.links.every(l => 'v' in l && 'delay_s' in l && 'queue_m' in l), 'every link has flow / delay / queue');
  const typed = TYPES.reduce((s, x) => s + r.by_type[x].delay_min, 0);
  ok(Math.abs(typed + r.others_min - r.delay_min) <= 4 && TYPES.every(x => r.by_type[x].per_capita_min > 0), 'sum of persona delays + background traffic = network total delay; per-capita delay > 0');
  const a = r.approaches[0];
  ok(TYPES.every(x => a.by_type[x].reading && a.by_type[x].reading.src === 'rule' && typeof a.by_type[x].informed === 'number'), 'each persona carries its reading (notice, understand, trust, one-line reason) and persuaded share');
  ok(near(Object.values(a.share).reduce((s, v) => s + v, 0), 1, 0.01), 'route split sums to 1');
  ok(eng.evaluate({ when: { date: '2026-10-06', hour: 22 }, worksites: [wsA()] }).delay_min === 0, 'outside works hours: no impact');
  const one = eng, twoPlan = { when: WHEN, worksites: [wsA([['X']]), { ...wsA([['X']]), id: 'A2' }] }, onePlan = { when: WHEN, worksites: [wsA([['X']], { closes: { lanes: 2 } })] };
  await one.prepare(twoPlan); await one.prepare(onePlan);
  const d2 = one.evaluate(twoPlan).delay_min, d1 = one.evaluate(onePlan).delay_min;
  ok(Math.abs(d2 - d1) <= 0.05 * d1, `two worksites closing 1 lane each on one link ≈ one worksite closing 2 (${d2} vs ${d1}); no vehicles created from nothing`);
  const line = { version: 1, nodes: ['a', 'b', 'c', 'd'].map((id, i) => ({ id, lat: -37.81, lon: 144.95 + i * 0.002 })),
    links: [['a', 'b'], ['b', 'c'], ['c', 'd']].map(([x, y]) => ({ id: x + y, from: x, to: y, name: 'Only Rd', len_m: 200, lanes: 2, speed_kmh: 40, cap_vph: 1800, t0_s: 38 })) };
  const lf = { days: { wd: { ab: Array(24).fill(1000), bc: Array(24).fill(1000), cd: Array(24).fill(1000) }, we: {} } };
  const le = createEngine({ network: line, flows: lf, readSigns: mockReadSigns });
  const dead = { when: WHEN, worksites: [{ id: 'X', links: ['bc'], closes: { lanes: 2 }, time: wsA().time, equipment: [] }] };
  await le.prepare(dead);
  const dr = le.evaluate(dead);
  ok(dr.delay_min === 0 && dr.blocked_vph === 1000, `full closure with no detour: vehicles stuck (blocked ${dr.blocked_vph}), not vanishing`);
  const flaky = createEngine({ network, flows, readSigns: async () => { throw new Error('offline'); } });
  const fp = await flaky.prepare(plan);
  ok(fp.failed === fp.asked && flaky.evaluate(plan).approaches[0].by_type.commuter.informed === 0 && flaky.calib.method === 'default', 'readSigns failing entirely: no crash, nobody persuaded, default parameters, UI warns via missing');
});

await t('conflict and window', async () => {
  const eng = createEngine({ network, flows, readSigns: mockReadSigns });
  const a = wsA([['USE', 'RUSSELL ST', 'SAVE 4 MIN']]), b = wsB();
  const W = windowWhens([a, b], [17]);
  await eng.prepare({ when: WHEN, worksites: [a, b] }, { whens: W });
  const c = eng.conflict(a, b, { hours: [17] });
  ok(c.overlap && c.cost > 0 && c.ab > c.a + c.b, `overlap: ${c.a} + ${c.b} ≠ ${c.ab}, clash cost ${c.cost}`);
  const bs = shiftWorksite(b, 5);
  await eng.prepare({ when: WHEN, worksites: [a, bs] }, { whens: windowWhens([a, bs], [17]) });
  const s = eng.conflict(a, bs, { hours: [17] });
  ok(!s.overlap && s.cost === 0, `staggered dates: clash cost exactly 0 (actual ${s.cost})`);
});

await t('advisor pieces', async () => {
  const list = [wsA(), wsB()];
  ok(applySuggestion(list, { kind: 'text', worksite: 'A', equipment: 'vms1', frames: [['USE', 'RUSSELL ST']] })[0].equipment[0].frames[0][0] === 'USE' && list[0].equipment[0].frames[0][0] === 'ROADWORK', 'reword: produces a new plan, the original is unchanged');
  ok(applySuggestion(list, { kind: 'move', worksite: 'A', equipment: 'vms1', at_m: 500 })[0].equipment[0].at_m === 500 && applySuggestion(list, { kind: 'shift', worksite: 'B', days: 5 })[1].time.from === '2026-10-12', 'move sign, shift 5 days');
  ok(applySuggestion(list, { kind: 'move', worksite: 'A', equipment: 'nope', at_m: 1 }) === null && applySuggestion([{ ...wsA(), time: undefined }], { kind: 'shift', worksite: 'A', days: 3 }) === null, 'unknown equipment, worksite without time → null');
  ok(!checkSuggestion({ kind: 'move', worksite: '<img>', equipment: 'v', at_m: 1 }) && !checkSuggestion({ kind: 'text', worksite: 'A', equipment: null, frames: [['TOO LONG LINE']] }) && checkSuggestion({ kind: 'shift', worksite: 'B', days: 3 }), 'suggestion check: an id containing HTML or a line over 10 characters is rejected');
  const summary = { worksites: [{ ...wsA(), equipment: [{ id: 'vms1', type: 'vms', at_m: 100, frames: [['ROADWORK', 'AHEAD']] }] }, wsB()],
    approaches: [{ worksite: 'A', dir: 'W', delay_min: 400, routes: [{ id: 'stay', name: 'La Trobe St', now_min: 10 }, { id: 'r1', name: 'Exhibition St', now_min: 7, turn_m: 200 }] }],
    conflicts: [{ a: 'A', b: 'B', cost_min: 120 }] };
  const m = await mockAdvise(summary);
  ok(m.suggestions.map(s => s.kind).join() === 'text,move,shift' && m.suggestions.every(checkSuggestion), 'rule-based advisor: reword · move sign (sign after the turn) · stagger');
  // reword suggestion = two frames "USE / road" ▸ "SAVE / N MIN", ≤ 3 lines per frame, ≤ 8 characters per line in the second frame (checkSigns soft limit, from the RPM Hire VMS product page); saves of 10+ min do not split into 4 lines
  const far = { ...summary, approaches: [{ ...summary.approaches[0], routes: [{ id: 'stay', name: 'La Trobe St', now_min: 25 }, summary.approaches[0].routes[1]] }] };
  const [t3, t18] = [m, await mockAdvise(far)].map(x => x.suggestions.find(s => s.kind === 'text').frames);
  ok(JSON.stringify(t3) === '[["USE","EXHIBITION"],["SAVE","3 MIN"]]' && JSON.stringify(t18) === '[["USE","EXHIBITION"],["SAVE","18 MIN"]]', `reword suggestion has two frames: ${JSON.stringify(t3)} · saving 18 min ${JSON.stringify(t18)}`);
  ok([t3, t18].every(fr => fr.length === 2 && fr.every(f => f.length <= 3) && fr[1].every(l => l.length <= 8)), 'negative test: no "SAVE N MIN" line over 8 characters and no 4-line frame');
  const calm = { ...summary, approaches: [{ ...summary.approaches[0], routes: [{ id: 'stay', name: 'La Trobe St', now_min: 3 }, summary.approaches[0].routes[1]] }] };
  ok(!(await mockAdvise(calm)).suggestions.some(s => s.kind === 'text'), 'no congestion (stay route faster): no reword suggesting a detour');
});

await t('readings are cached per request', async () => {
  const rs = counting();
  const eng = createEngine({ network, flows, readSigns: rs });
  const W = windowWhens([wsA(), wsB()], [8, 17]);
  await eng.prepare({ when: WHEN, worksites: [wsA(), wsB()] }, { whens: W });
  const n1 = rs.n;
  eng.conflict(wsA(), wsB(), { whens: W });
  ok(n1 <= 40 && rs.n === n1, `a clash comparison over ${W.length} moments asked only ${n1} readings; evaluate itself asks none`);
});

done();
