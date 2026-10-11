// demo.mjs — run the three demo acts + the planning advisor and print the numbers (readings from the engine's built-in mock reader: offline, no cost)
// Usage: node apps/engine/tools/demo.mjs [--real] [--params apps/params/public/params.json]
//   --params: use the apps/params parameter file (missing or invalid items fall back to assumed values one by one; the first line lists which items came from the file)
//   default: toy grid (Hoddle Grid street names, assumed flows); --real also runs act 1 on the real CBD network (apps/roads/public/cbd/)
// Numbers come from assumed parameters + keyword readings: use them for direction and magnitude only, not as findings. The web page uses the apps/api reader instead of mockReadSigns.
import { readFileSync } from 'node:fs';
import { makeGrid, createEngine, mockReadSigns, advise, mockAdvise, shiftWorksite, windowWhens, affected, capFactors, TYPES, applyParams } from '../public/js/index.js';

const pct = x => (x * 100).toFixed(1) + '%';
const when = { date: '2026-10-06', hour: 17 };
const A = frames => ({ id: 'A', name: 'La Trobe St westbound lane closure', links: ['L-n0_6-n0_5'], closes: { lanes: 1 },
  time: { from: '2026-10-05', to: '2026-10-09', hours: [7, 19] },
  equipment: [{ id: 'vms1', type: 'vms', at_m: 300, frames }, { id: 's1', type: 'sign', at_m: 100, text: 'RIGHT LANE CLOSED' }] });
const B = { id: 'B', name: 'Lonsdale St westbound lane closure', links: ['L-n1_6-n1_5'], closes: { lanes: 1 },
  time: { from: '2026-10-07', to: '2026-10-12', hours: [7, 19] }, equipment: [{ id: 'vmsB', type: 'vms', at_m: 300, frames: [['ROADWORK', 'AHEAD']] }] };

const pi = process.argv.indexOf('--params');
const params = pi > 0 ? applyParams(JSON.parse(readFileSync(process.argv[pi + 1], 'utf8'))) : applyParams(null);
if (pi > 0) {
  const u = params.used, fromFile = [u.mix === 'params' && 'mix', u.anchors === 'params' && 'anchors',
    ...TYPES.flatMap(t => Object.entries(u.persona[t]).filter(([, v]) => v !== 'default').map(([k, v]) => `${t}.${k}${v === 'sign_trust' ? '(sign_trust)' : ''}`))].filter(Boolean);
  console.log(`Params: ${process.argv[pi + 1]} · from the file: ${fromFile.join(' ') || '(none)'}${u.errors.length ? ' · invalid: ' + u.errors.join('; ') : ''}\n`);
}

const { network, flows } = makeGrid();
const eng = createEngine({ network, flows, readSigns: mockReadSigns, params });
const c0 = (await eng.prepare({ when, worksites: [A([['ROADWORK', 'AHEAD']])] })).calib;
console.log(`Toy grid (assumed flows) · ${when.date} ${when.hour}:00 · readings = mock keyword rules · two-point calibration A ${c0.A} / B ${c0.B} (ROADWORK AHEAD → ${pct(c0.lo_detour)}, USE RUSSELL ST → ${pct(c0.hi_detour)})\n`);
console.log('Act 1: same equipment and positions, only the sign text changes (La Trobe St westbound, one lane closed)');
for (const fr of [[['ROADWORK', 'AHEAD']], [['USE', 'RUSSELL ST', 'SAVE 4 MIN']]]) {
  const plan = { when, worksites: [A(fr)] };
  await eng.prepare(plan);
  const r = eng.evaluate(plan), a = r.approaches[0];
  console.log(`  "${fr.flat().join(' / ')}" queue ${a.queue_m} m · total delay ${r.delay_min} veh·min · detour ${pct(1 - a.share.stay)}`);
  for (const t of TYPES) {
    const x = a.by_type[t], y = r.by_type[t];
    console.log(`      ${t.padEnd(8)} persuaded ${pct(x.informed)} · detour ${pct(x.detour)} · ${y.per_capita_min} extra min per person · ${x.reading?.why ?? ''}`);
  }
}
const a = A([['USE', 'RUSSELL ST', 'SAVE 4 MIN']]);
const W = windowWhens([a, B], [17]);
await eng.prepare({ when, worksites: [a, B] }, { whens: W });
const c = eng.conflict(a, B, { whens: W });
console.log(`\nAct 2: add another worksite nearby (Lonsdale St westbound, 3 days overlapping A), evening peaks summed\n  A ${c.a} + B ${c.b} = ${c.a + c.b}, together ${c.ab} veh·min → clash cost ${c.cost}`);
const bs = shiftWorksite(B, 5);
const W2 = windowWhens([a, bs], [17]);
await eng.prepare({ when, worksites: [a, bs] }, { whens: W2 });
const s = eng.conflict(a, bs, { whens: W2 });
console.log(`\nAct 3: B postponed by 5 days\n  A ${s.a} + B ${s.b}, together ${s.ab} → clash cost ${s.cost}`);
const adv = await advise(eng, { when, worksites: [A([['ROADWORK', 'AHEAD']]), B] }, { askAdvisor: mockAdvise, hours: [17] });
console.log(`\nPlanning advisor (rule-based): every suggestion re-run by the engine\n  now: ${adv.before.delay_min} veh·min (sum over ${adv.whens} evening-peak hours)`);
for (const o of adv.options) console.log(`  · ${o.suggestion.kind}: ${o.suggestion.why} → ${o.delay_min ?? '-'} (${o.delta_min >= 0 ? '+' : ''}${o.delta_min ?? o.skipped})${o.better ? '' : ' not recommended'}`);

if (process.argv.includes('--real')) {
  const dir = new URL('../../roads/public/cbd/', import.meta.url);
  const rn = JSON.parse(readFileSync(new URL('network.json', dir), 'utf8'));
  const rf = JSON.parse(readFileSync(new URL('flows.json', dir), 'utf8'));
  const real = createEngine({ network: rn, flows: rf, readSigns: mockReadSigns, params });
  const link = 'l2177124610_2190478926';
  const [ap] = affected(real.net, rf, { id: 'R', links: [link], closes: { lanes: 1 } }, when, capFactors(real.net, [{ links: [link], closes: { lanes: 1 } }]));
  const best = ap.alts[0];
  console.log(`\nReal network (${rn.links.length} links): Bourke Street eastbound, one lane closed, ${ap.volume} veh/h at 17:00, detours: ${ap.alts.map(r => `${r.name} (turn at ${Math.round(r.diverge_m)} m)`).join(' / ')}`);
  for (const fr of [[['ROADWORK', 'AHEAD']], [['USE', best.name.split(' ')[0].toUpperCase().slice(0, 10), 'SAVE 3 MIN']]]) {
    const plan = { when, worksites: [{ id: 'R', links: [link], closes: { lanes: 1 }, time: { from: '2026-10-05', to: '2026-10-09', hours: [7, 19] },
      equipment: [{ id: 'vms1', type: 'vms', at_m: Math.round(best.diverge_m) + 100, frames: fr }] }] };
    await real.prepare(plan);
    const t0 = performance.now();
    const r = real.evaluate(plan);
    console.log(`  "${fr.flat().join(' / ')}" queue ${r.approaches[0].queue_m} m · total delay ${r.delay_min} veh·min · ${best.name} gets ${pct(r.approaches[0].routes[1].share)} · evaluate ${(performance.now() - t0).toFixed(1)} ms`);
  }
}
