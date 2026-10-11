// conflict.test.mjs — regression: a single worksite must never make network total delay negative ("closing a road saves time").
// Root cause: side streets (Little Bourke St etc., 20 km/h) are usually slower than detouring via a parallel main street; flows.json is counts, not an equilibrium,
// so the engine counted vehicles pushed onto a detour by a closure as "saving time". Fix: the credit term in pipeline.js evaluate() measures extra time from the faster of "stay route / detour, usually".
// Real network (apps/roads/public/cbd/) + mock readings, offline and free.
import { readFileSync, existsSync } from 'node:fs';
import { ok, t, done } from './_t.mjs';
import { createEngine, mockReadSigns, windowWhens, applyParams } from '../public/js/index.js';
import { demoPlan } from '../public/js/backend.js';

const dir = new URL('../../roads/public/cbd/', import.meta.url);
const pfile = new URL('../../params/public/params.json', import.meta.url);
const LB = 'l26034673_245532558'; // Little Bourke St, 1 lane (the link @jinmingq reported)
const ws = (id, links, lanes) => ({ id, name: id, links, closes: { lanes }, time: { from: '2026-10-05', to: '2026-10-09', hours: [7, 19] },
  equipment: [{ id: 'V', type: 'vms', at_m: 200, frames: [['ROADWORK', 'AHEAD']] }] });

await t('a single full closure gives no negative delay', async () => {
  if (!existsSync(new URL('network.json', dir))) { ok(false, 'apps/roads/public/cbd/network.json not found'); return; }
  const rn = JSON.parse(readFileSync(new URL('network.json', dir), 'utf8'));
  const rf = JSON.parse(readFileSync(new URL('flows.json', dir), 'utf8'));
  const params = existsSync(pfile) ? applyParams(JSON.parse(readFileSync(pfile, 'utf8'))) : applyParams(null);
  const eng = createEngine({ network: rn, flows: rf, readSigns: mockReadSigns, params });

  const b = ws('LB', [LB], 1);
  for (const hour of [8, 17]) {
    const plan = { when: { date: '2026-10-06', hour }, worksites: [b] };
    await eng.prepare(plan);
    const r = eng.evaluate(plan);
    const ap = r.approaches[0];
    ok(ap && ap.blocked && ap.routes.length > 0, `${hour}:00 Little Bourke St full closure: detours exist (${ap?.routes.map(x => x.name).join(' / ')})`);
    ok(r.delay_min >= 0, `${hour}:00 Little Bourke St closed on its own, total delay ${r.delay_min} ≥ 0 (before the fix −65 at 08:00, −100 at 17:00)`);
    ok(ap.routes.every(x => x.extra_min >= 0), `${hour}:00 every detour's extra time is ≥ 0 (${ap.routes.map(x => x.extra_min).join(' / ')})`);
    ok(Object.values(r.by_type).every(x => x.delay_min >= 0), `${hour}:00 every persona's delay is ≥ 0`);
  }

  // clash cost: the Lonsdale demo worksite + the Little Bourke full closure, same week
  const a = demoPlan('lonsdale').worksites[0];
  const W = windowWhens([a, b]);
  await eng.prepare({ when: W[0], worksites: [a, b] }, { whens: W });
  const c = eng.conflict(a, b, { whens: W });
  ok(c.b >= 0, `conflict(lonsdale, Little Bourke).b = ${c.b} ≥ 0 (before the fix −825)`);
  ok(c.a > 0 && c.ab > 0, `A and A+B are both positive (${c.a} / ${c.ab})`);
  ok(c.cost === c.ab - c.a - c.b, `clash cost = D(A+B) − D(A) − D(B) (${c.cost})`);

  // fully close each similar side-street link (Little … St / Flinders Lane) with traffic at 08:00 on its own: not a single negative allowed
  const lanes = rn.links.filter(l => /^(Little |Flinders Lane)/.test(l.name || '') && (rf.days.wd[l.id]?.[8] ?? 0) > 50);
  const bad = [];
  for (const l of lanes) {
    const plan = { when: { date: '2026-10-06', hour: 8 }, worksites: [ws('X', [l.id], l.lanes)] };
    await eng.prepare(plan);
    const r = eng.evaluate(plan);
    if (r.delay_min < 0) bad.push(`${l.name} ${l.id} ${r.delay_min}`);
  }
  ok(lanes.length >= 10, `${lanes.length} side-street links sampled`);
  ok(!bad.length, `no negative delay for any single side-street closure${bad.length ? ': ' + bad.slice(0, 5).join('; ') : ''}`);
});

done();
