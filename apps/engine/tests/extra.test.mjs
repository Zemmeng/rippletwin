// raw.links carry extra_min — extra veh·min on each link versus the same hour with no works (can be < 0).
// The page filters "slowed links" by it, not by v·delay_s/60 (delay_s is versus free flow): otherwise the queues Flinders / King St have at the morning peak anyway
// would be drawn as ripples of the works in every plan. Real network + demo plan (Lonsdale westbound 08:00, one lane closed), engine rule reader, offline
import { readFileSync, existsSync } from 'node:fs';
import { ok, t, done } from './_t.mjs';
import { connect, PATHS } from '../public/js/backend.js';

const APPS = new URL('../../', import.meta.url); // apps/
const file = p => new URL('.' + p, APPS);
if (!existsSync(file(PATHS.network))) { ok(false, 'apps/roads/public/cbd/network.json not found'); done(); }
const fakeFetch = async url => (existsSync(file(url)) ? { ok: true, status: 200, json: async () => JSON.parse(readFileSync(file(url), 'utf8')) } : { ok: false, status: 404 });
const noImporter = async url => { throw new Error('404 ' + url); };

await t('raw.links.extra_min (Lonsdale westbound 08:00, one lane closed)', async () => {
  const be = await connect({ fetch: fakeFetch, importer: noImporter });
  const plan = be.demo('lonsdale');
  const s = await be.run(plan);
  const L = s.raw.links, net = be.engine.net, name = id => (net.links.get(id) || {}).name || '';

  ok(L.length > 0 && L.every(l => typeof l.extra_min === 'number' && Number.isFinite(l.extra_min)), `all ${L.length} raw.links have a numeric extra_min`);
  ok(L.every(l => ['id', 'v', 'cap', 'delay_s', 'queue_m'].every(k => k in l)), 'no original field missing (delay_s is still used elsewhere)');

  const works = new Set(plan.worksites[0].links), w = L.filter(l => works.has(l.id));
  ok(w.length > 0 && w.every(l => l.extra_min > 0), `the works links themselves have extra_min > 0 (${w.map(l => l.extra_min).join(', ')} veh·min)`);

  // negative: Flinders / King St queue at the morning peak anyway — large versus free flow, almost unchanged versus the same hour with no works
  const bg = L.filter(l => /^(Flinders|King) (Street|St)$/i.test(name(l.id)) && (l.v || 0) * (l.delay_s || 0) / 60 >= 60);
  ok(bg.length > 0, `${bg.length} Flinders / King St links have large delay versus free flow (v·delay_s/60 ≥ 60 veh·min, max ${Math.round(Math.max(0, ...bg.map(l => l.v * l.delay_s / 60)))})`);
  ok(bg.every(l => l.extra_min < 2), `negative: these links all have extra_min < 2 (max ${Math.max(...bg.map(l => l.extra_min))}) — not caused by the works, so the page must not draw them as ripples`);

  ok(L.some(l => l.extra_min < 0), `some links have extra_min < 0 (traffic diverted away, min ${Math.min(...L.map(l => l.extra_min))}), reported as is, not clipped to 0`);
  const byId = new Map(L.map(l => [l.id, l]));
  ok(s.raw.hot.length > 0 && s.raw.hot.every(h => byId.has(h.id) && Math.abs(byId.get(h.id).extra_min - h.extra_min) <= 0.5),
    `hot (most congested links) extra_min matches raw.links (hot rounded, links to one decimal)`);
});

done();
