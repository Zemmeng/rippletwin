// End to end: createEngine + the mock reader run the whole flow of docs/hackathon/specs/ai-flow.md through the three fixed demo acts (docs/hackathon/plan.md),
// then once more on the real network (apps/roads/public/cbd/): it loads, a single evaluate takes < 100 ms, and act 1 goes the right way.
// Numbers come from assumed parameters + keyword readings, so only directions and relations are asserted, not exact values.
import { readFileSync, existsSync } from 'node:fs';
import { ok, t, done, wsA, wsB, WHEN } from './_t.mjs';
import { makeGrid, createEngine, mockReadSigns, advise, mockAdvise, shiftWorksite, windowWhens, affected, capFactors, loadNetwork } from '../public/js/index.js';

const { network, flows } = makeGrid();
const eng = createEngine({ network, flows, readSigns: mockReadSigns });
const run = async plan => { await eng.prepare(plan); return eng.evaluate(plan); };

await t('act 1: one line of VMS text', async () => {
  for (const when of [{ date: '2026-10-06', hour: 8 }, WHEN]) {
    const p = await run({ when, worksites: [wsA([['ROADWORK', 'AHEAD']])] });
    const n = await run({ when, worksites: [wsA([['USE', 'RUSSELL ST', 'SAVE 4 MIN']])] });
    ok(n.delay_min < p.delay_min && n.approaches[0].queue_m < p.approaches[0].queue_m,
      `act 1 at ${when.hour}:00: sign changed from ROADWORK AHEAD to USE RUSSELL ST / SAVE 4 MIN, total delay ${p.delay_min} → ${n.delay_min}, queue ${p.approaches[0].queue_m} → ${n.approaches[0].queue_m} m`);
    ok(n.approaches[0].routes.find(r => r.name === 'Russell St').share > p.approaches[0].routes.find(r => r.name === 'Russell St').share, `${when.hour}:00: the named Russell St gets more vehicles`);
  }
  const n = await run({ when: WHEN, worksites: [wsA([['USE', 'RUSSELL ST', 'SAVE 4 MIN']])] });
  const b = n.approaches[0].by_type;
  ok(b.commuter.detour > b.delivery.detour && b.commuter.told.includes('Russell St'), 'by persona: commuters divert more than delivery drivers; the reading says the sign names Russell St');
  ok(n.calib.method === 'two_point' && n.calib.src === 'rule', 'mock: two-point calibration used rule readings (labelled an estimate in the UI)');
});

await t('sign position matters', async () => {
  const late = wsA([['USE', 'SPRING ST']]); late.equipment[0].at_m = 300; // the Spring St turn is 400 m before the works and the sign at 300 m: too late to turn when seen
  const early = wsA([['USE', 'SPRING ST']]); early.equipment[0].at_m = 500;
  const sp = r => r.approaches[0].routes.find(x => x.name === 'Spring St').share;
  const a = await run({ when: WHEN, worksites: [late] }), b = await run({ when: WHEN, worksites: [early] });
  ok(sp(b) > sp(a) && a.approaches[0].routes.find(x => x.name === 'Spring St').turn_m === 400, `a sign after the turn has no effect: Spring St gets ${sp(a)} with the sign at 300 m, ${sp(b)} once moved to 500 m`);
});

await t('act 2 and 3: two worksites', async () => {
  const a = wsA([['USE', 'RUSSELL ST', 'SAVE 4 MIN']]);
  await eng.prepare({ when: WHEN, worksites: [a, wsB()] }, { whens: windowWhens([a, wsB()], [17]) });
  const c = eng.conflict(a, wsB(), { hours: [17] });
  ok(c.overlap && c.cost > 0 && c.cost < 20 * (c.a + c.b), `act 2 (A names Russell St, and that detour passes through B): A ${c.a} + B ${c.b} ≠ A+B ${c.ab}, clash cost ${c.cost} (${c.whens} moments)`);
  const bs = shiftWorksite(wsB(), 5);
  await eng.prepare({ when: WHEN, worksites: [a, bs] }, { whens: windowWhens([a, bs], [17]) });
  const s = eng.conflict(a, bs, { hours: [17] });
  ok(!s.overlap && s.cost === 0, `act 3: B postponed 5 days, clash cost ${s.cost}`);
});

await t('step 7: advisor re-runs every suggestion', async () => {
  const res = await advise(eng, { when: WHEN, worksites: [wsA(), wsB()] }, { askAdvisor: mockAdvise, hours: [17] });
  ok(res.options.length >= 2 && res.options.every(o => o.skipped || (Number.isFinite(o.delta_min) && o.result && o.better === (o.delta_min < 0))), `rule-based advisor gives ${res.options.length} suggestions (${res.options.map(o => o.suggestion.kind).join(' / ')}), each re-run by the engine and marked better`);
  const shift = res.options.find(o => o.suggestion.kind === 'shift');
  const c = eng.conflict(wsA(), wsB(), { hours: [17] });
  ok(shift && shift.better && Math.abs(-shift.delta_min - c.cost) <= Math.max(5, 0.05 * c.cost), `benefit of staggering ≈ clash cost (${-shift?.delta_min} vs ${c.cost}): before and after compared over the same period`);
  const noon = { date: '2026-10-06', hour: 12 };
  const calm = await advise(eng, { when: noon, worksites: [wsA([['ROADWORK', 'AHEAD']], { time: { from: '2026-10-05', to: '2026-10-09', hours: [11, 14] } })] }, { askAdvisor: mockAdvise });
  ok(!calm.options.some(o => o.suggestion.kind === 'text'), 'midday, no congestion, detour not faster: the rule-based advisor does not suggest a reword');
});

await t('real CBD network', async () => {
  const dir = new URL('../../roads/public/cbd/', import.meta.url);
  if (!existsSync(new URL('network.json', dir))) { ok(false, 'apps/roads/public/cbd/network.json not found'); return; }
  const rn = JSON.parse(readFileSync(new URL('network.json', dir), 'utf8'));
  const rf = JSON.parse(readFileSync(new URL('flows.json', dir), 'utf8'));
  const real = createEngine({ network: rn, flows: rf, readSigns: mockReadSigns });
  const link = 'l2177124610_2190478926'; // Bourke Street eastbound, two lanes, about 1,300 veh/h at 17:00
  ok(real.net.links.has(link) && real.net.links.get(link).name === 'Bourke Street', 'real network: 1,513 links load, including the Bourke Street eastbound demo link');
  const [ap] = affected(real.net, rf, { id: 'R', links: [link], closes: { lanes: 1 } }, WHEN, capFactors(real.net, [{ links: [link], closes: { lanes: 1 } }]));
  ok(ap && ap.alts.length >= 2 && ap.volume > 0, `real network step 1: ${ap.alts.length} detours (${ap.alts.map(r => r.name).join(' / ')}), ${ap.volume} veh/h affected`);
  const best = ap.alts[0].name.split(' ')[0].toUpperCase();
  const mk = fr => ({ id: 'R', links: [link], closes: { lanes: 1 }, time: { from: '2026-10-05', to: '2026-10-09', hours: [7, 19] },
    equipment: [{ id: 'vms1', type: 'vms', at_m: Math.round(ap.alts[0].diverge_m) + 100, frames: fr }] });
  const pPlan = { when: WHEN, worksites: [mk([['ROADWORK', 'AHEAD']])] }, nPlan = { when: WHEN, worksites: [mk([['USE', best.slice(0, 10), 'SAVE 3 MIN']])] };
  await real.prepare(pPlan); await real.prepare(nPlan);
  const t0 = performance.now();
  const p = real.evaluate(pPlan);
  const ms = performance.now() - t0;
  const n = real.evaluate(nPlan);
  ok(ms < 100 && p.links.length === rn.links.length, `real network single evaluate ${ms.toFixed(1)} ms (target < 100), result covers all ${p.links.length} links`);
  ok(p.delay_min > 0 && n.approaches[0].routes[1].share > p.approaches[0].routes[1].share && n.approaches[0].queue_m <= p.approaches[0].queue_m,
    `real network act 1: sign names ${ap.alts[0].name}, its share ${p.approaches[0].routes[1].share} → ${n.approaches[0].routes[1].share}, queue ${p.approaches[0].queue_m} → ${n.approaches[0].queue_m} m`);
  // the web page's demo scene: Lonsdale Street westbound one block from the La Trobe / Swanston junction, about 1,100 veh/h at 08:00
  const lon = 'l595594354_9756035316';
  const [lap] = affected(real.net, rf, { id: 'L', links: [lon], closes: { lanes: 1 } }, { date: '2026-10-06', hour: 8 }, capFactors(real.net, [{ links: [lon], closes: { lanes: 1 } }]));
  ok(lap && lap.street === 'Lonsdale Street' && lap.alts.length >= 1 && lap.alts.every(r => r.links.every(id => !['living_street', 'service'].includes(real.net.links.get(id).highway))),
    `real-network detours avoid CBD laneways (living_street such as Heffernan Lane): Lonsdale Street westbound detours = ${lap?.alts.map(r => r.name).join(' / ')}`);
});

done();
