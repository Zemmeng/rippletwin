// Trams and buses: transit.js + summary.transit in backend.js. Uses the real files from apps/roads (network / flows / transit.json),
// URL fetches go through an injected fake fetch, offline. Only directions, definitions and relations are asserted; riders per trip are assumed (PAX_PER_TRIP).
import { readFileSync, existsSync } from 'node:fs';
import { ok, t, done } from './_t.mjs';
import { connect, PATHS } from '../public/js/backend.js';
import { transitImpact, PAX_PER_TRIP, paxPerTrip, loadNetwork, shortestPath, NO_DETOUR, routePaths, linkTime, dayType } from '../public/js/index.js';
import { BUS_ROADS, TRANSIT_PEAK_HOURS, DIVERT_M, SLOWER_S } from '../public/js/transit.js';
const clone = x => JSON.parse(JSON.stringify(x));

const APPS = new URL('../../', import.meta.url); // apps/
const file = p => new URL('.' + p, APPS);
if (!existsSync(file(PATHS.transit))) { ok(false, 'apps/roads/public/cbd/transit.json not found'); done(); }
const J = p => JSON.parse(readFileSync(file(p), 'utf8'));
const fakeFetch = async url => (existsSync(file(url)) ? { ok: true, status: 200, json: async () => J(url) } : { ok: false, status: 404 });
const noImporter = async url => { throw new Error('404 ' + url); };
const TRANSIT = J(PATHS.transit);
const dirOf = (id, dir) => TRANSIT.routes.find(r => r.id === id).dirs.find(d => d.dir === dir);
const LONSDALE = 'l595594354_9756035316', LATROBE = 'l2187770692_2190483583';

const be = await connect({ fetch: fakeFetch, importer: noImporter });

await t('loading: transit.json is fetched with the network', async () => {
  const st = be.status();
  ok(st.transit === 'gtfs' && !st.errors.some(e => e.includes('Transit')), `status.transit = ${st.transit} (${TRANSIT.routes.length} routes)`);
});

await t('Lonsdale demo at 08:00 (one lane closed): passing buses are delayed too', async () => {
  const s = await be.run(be.demo('lonsdale'));
  const tr = s.transit;
  const bus = tr.routes.filter(r => r.mode === 'bus' && r.delay_s > 0 && r.pax_min > 0);
  ok(tr.src === 'gtfs' && tr.day === 'wd' && tr.hour === 8 && bus.length >= 10, `${bus.length} bus routes are > 0 s slower per trip (15 use this stretch)`);
  ok(tr.routes.every(r => r.links.includes(LONSDALE) && !r.blocked && !r.diverted), 'every listed route passes the works link; one lane closed means no detour and no stoppage');
  ok(tr.routes.every(r => r.mode !== 'tram'), 'negative: a partial lane closure lists no trams (CBD trams run in their own lanes)');
  const stay = s.routes.find(r => r.id === 'stay');
  const car = (stay.now_min - stay.usual_min) * 60;
  const b0 = tr.routes[0];
  ok(Math.abs(b0.delay_s - car) <= 0.25 * car, `bus +${b0.delay_s} s per trip ≈ cars staying on Lonsdale +${car.toFixed(0)} s (within 25%)`);
  ok(tr.routes.every(r => r.trips_h === dirOf(r.id, r.dir).trips.wd[8] && r.pax_per_trip === PAX_PER_TRIP.peak.bus && r.pax_h === r.trips_h * r.pax_per_trip),
    'trips = transit.json weekday trips at 08:00; peak 25 riders per trip (assumed); pax_h = trips × riders per trip');
  ok(tr.routes.every(r => Math.abs(r.pax_min - (r.pax_h * r.delay_s) / 60) <= (r.pax_h * 0.05) / 60 + 0.051), 'pax_min = pax_h × delay_s ÷ 60 (delay_s to 0.1 s)');
  const sum = tr.routes.reduce((a, r) => a + r.pax_min, 0);
  ok(Math.abs(tr.pax_min - sum) <= 1 && tr.trips_h === tr.routes.reduce((a, r) => a + r.trips_h, 0) && tr.pax_h === tr.routes.reduce((a, r) => a + r.pax_h, 0) && tr.blocked_routes === 0,
    `totals: ${tr.trips_h} trips/h, ${tr.pax_h} riders/h, ${tr.pax_min} rider-minutes`);
  ok(tr.routes.every((r, i, a) => i === 0 || a[i - 1].pax_min >= r.pax_min), 'sorted by pax_min, largest first');
  ok(tr.assumed.pax_per_trip.bus === PAX_PER_TRIP.peak.bus && tr.assumed.pax_per_trip.tram === PAX_PER_TRIP.peak.tram && tr.assumed.period === 'peak' && tr.assumed.range.bus.length === 2 && tr.assumed.note,
    'summary.transit.assumed reports riders per trip (assumed), range and note');
});

await t('negative: outside works hours (22:00) everything is 0', async () => {
  const s = await be.run(be.demo('lonsdale', { hour: 22 }));
  const tr = s.transit;
  ok(s.flags.inactive && tr.src === 'gtfs' && tr.routes.length === 0 && tr.pax_min === 0 && tr.trips_h === 0 && tr.pax_h === 0 && tr.blocked_routes === 0,
    `no works at 22:00: ${tr.routes.length} routes, ${tr.pax_min} rider-minutes`);
  // feed a "nothing changed" result for the same hour (works active but no capacity lost): no route may show delay
  const plan = be.demo('lonsdale', { hour: 22 }); delete plan.worksites[0].time; plan.worksites[0].closes.lanes = 0;
  const r = be.engine.evaluate(plan);
  const tr2 = transitImpact(be.engine.net, be.engine.flows, TRANSIT, plan, r);
  ok(r.active.length === 1 && tr2.routes.length === 0 && tr2.pax_min === 0, `works active but no lane closed: ${tr2.routes.length} routes listed (trips no slower than usual are not listed), 0 rider-minutes`);
});

await t('negative: delay is versus no works, not versus free flow', async () => {
  // push the 08:00 flow on a Victoria Parade link (on route 906, far from the works) well over capacity: it is congested anyway, but the works do not make it worse
  const VIC = 'l2096319051_6207152063';
  const flows2 = J(PATHS.flows); flows2.days.wd[VIC][8] = 8000;
  const be2 = await connect({ network: J(PATHS.network), flows: flows2, fetch: fakeFetch, importer: noImporter });
  const [a, b] = [await be.run(be.demo('lonsdale')), await be2.run(be2.demo('lonsdale'))];
  const pick = s => s.transit.routes.find(r => r.id === 'bus_906' && r.dir === 1);
  const vic = b.raw.links.find(l => l.id === VIC);
  const naive = dirOf('bus_906', 1).links.reduce((s, id) => s + (b.raw.links.find(l => l.id === id)?.delay_s || 0), 0);
  ok(vic.delay_s > 1000 && naive > 1000 && Math.abs(pick(b).delay_s - pick(a).delay_s) < 1,
    `Victoria Pde is already ${vic.delay_s} s slower than free flow: route 906 still gets +${pick(b).delay_s} s (was ${pick(a).delay_s}), not the summed delay_s of ${naive.toFixed(0)} s`);
});

await t('La Trobe full closure at 17:00: tram route 30 stops', async () => {
  const plan = be.demo('latrobe'); plan.worksites[0].closes.lanes = 2;
  const tr = (await be.run(plan)).transit;
  const t30 = tr.routes.find(r => r.id === 'tram_30');
  const trips = dirOf('tram_30', 1).trips.wd[17];
  ok(t30 && t30.blocked && t30.mode === 'tram' && t30.dir === 1 && t30.delay_s === null && t30.pax_min === null && !t30.diverted,
    `route 30 (towards ${t30?.headsign}) blocked, minutes null (not invented)`);
  ok(t30.trips_h === trips && t30.pax_h === trips * PAX_PER_TRIP.peak.tram && t30.links.includes(LATROBE), `${t30.trips_h} trips/h and ${t30.pax_h} riders/h stopped (${PAX_PER_TRIP.peak.tram} riders per trip, assumed)`);
  ok(tr.routes[0].blocked && tr.blocked_routes >= 1 && tr.blocked_pax_h >= t30.pax_h && Number.isFinite(tr.pax_min), `stopped routes first; blocked_routes ${tr.blocked_routes}, ${tr.blocked_pax_h} riders/h stopped; pax_min ${tr.pax_min} excludes nulls`);
  const part = (await be.run(be.demo('latrobe'))).transit;
  ok(!part.routes.some(r => r.id === 'tram_30'), 'negative: one lane closed on the same link, tram 30 not listed (trams unaffected)');
});

await t('Lonsdale full closure at 08:00: buses take the nearest detour', async () => {
  const plan = be.demo('lonsdale'); plan.worksites[0].closes.lanes = 2;
  const tr = (await be.run(plan)).transit;
  const net = be.engine.net;
  const b = tr.routes.find(r => r.id === 'bus_906' && r.dir === 1);
  ok(tr.routes.length >= 10 && tr.routes.every(r => r.diverted && !r.blocked && r.delay_s > 0 && r.links.includes(LONSDALE)), `all ${tr.routes.length} bus routes divert (diverted), +${b.delay_s} s per trip`);
  const d = b.detour_links.map(id => net.links.get(id));
  const joined = d.every((l, i) => i === 0 || d[i - 1].to === l.from);
  ok(d.length > 0 && joined && !b.detour_links.includes(LONSDALE) && d.every(l => !NO_DETOUR.has(l.highway)),
    `the detour is one connected path avoiding the closed link and laneways: ${[...new Set(d.map(l => l.name))].join(' → ')}`);
  ok(d.every(l => BUS_ROADS.has(l.highway)), 'main roads suffice here: main roads only (not the Swanston St tram street or side streets like Little Bourke St)');
  ok(Array.isArray(b.stops_closed) && b.stops_closed.length === 0 && b.stops_skipped.every(s => s.id && s.name), `no stops on the closed link; bypassed stops ${b.stops_skipped.map(s => s.name).join(', ') || 'none'}`);
});

await t('short junction links missing from transit.json still count when closed', async () => {
  // route 906's links in the Russell St junction are very short and were missed by transit.json's 10 m sampling; the engine fills the gap and still counts them
  const d906 = dirOf('bus_906', 1).links, net = be.engine.net;
  const i = d906.indexOf('l6696274751_9756035317');
  const gap = shortestPath(net, net.links.get(d906[i]).to, net.links.get(d906[i + 1]).from, { cost: l => l.len_m });
  ok(gap && gap.links.length >= 1 && gap.links.every(id => !d906.includes(id)), `gap of ${gap?.links.length} links (${gap?.cost.toFixed(0)} m), not in transit.json links`);
  const plan = be.demo('lonsdale'); plan.worksites[0].links = [gap.links[0]]; plan.worksites[0].closes.lanes = 9;
  const tr = transitImpact(net, be.engine.flows, TRANSIT, plan, be.engine.evaluate(plan));
  ok(tr.routes.some(r => r.id === 'bus_906' && r.dir === 1 && r.links.includes(gap.links[0])), 'closing a link in the gap → route 906 is still listed');
});

await t('weekend / off-peak: trips and riders per trip change accordingly', async () => {
  // weekend mornings Lonsdale is quiet and one closed lane barely queues: use a full closure (buses must detour) to check trips and riders
  const plan = be.demo('lonsdale'); plan.when.day = 'we'; plan.worksites[0].closes.lanes = 2;
  const tr = (await be.run(plan)).transit;
  ok(tr.day === 'we' && tr.assumed.period === 'offpeak' && tr.routes.length > 0 && tr.routes.every(r => r.trips_h === dirOf(r.id, r.dir).trips.we[8] && r.pax_per_trip === PAX_PER_TRIP.offpeak.bus),
    `weekend 08:00: trips from trips.we, ${PAX_PER_TRIP.offpeak.bus} riders per trip (off-peak, assumed)`);
  ok(paxPerTrip({ date: '2026-10-06', hour: 8 }).period === 'peak' && paxPerTrip({ date: '2026-10-06', hour: 12 }).period === 'offpeak' && paxPerTrip({ date: '2026-10-10', hour: 8 }).period === 'offpeak' && TRANSIT_PEAK_HOURS.includes(17),
    'peak means weekdays 7–9 and 16–18 only');
});

await t('before / after: delta.transit_pax_min = after − before', async () => {
  const c = await be.compare(be.demo('lonsdale', { frames: [['ROADWORK', 'AHEAD']] }), be.demo('lonsdale'));
  ok(c.delta.transit_pax_min === c.after.transit.pax_min - c.before.transit.pax_min && c.delta.transit_pax_min < 0,
    `sign names Russell St, Lonsdale queue shortens, bus riders ${c.before.transit.pax_min} → ${c.after.transit.pax_min} rider-minutes (delta ${c.delta.transit_pax_min})`);
});

await t('transit.json unavailable: numbers still come out, summary.transit.src = null', async () => {
  const miss = await connect({ fetch: async url => (url.endsWith('transit.json') ? { ok: false, status: 404 } : fakeFetch(url)), importer: noImporter });
  const st = miss.status();
  ok(st.transit === 'none' && st.errors.some(e => e.includes('Transit data not loaded')), `status.transit = none, one entry in errors`);
  const s = await miss.run(miss.demo('lonsdale'));
  ok(s.queue_m > 0 && s.transit.src === null && !('routes' in s.transit), `vehicle numbers still come out (queue ${s.queue_m} m), summary.transit = { src: null }`);
  const c = await miss.compare(miss.demo('lonsdale', { frames: [['ROADWORK', 'AHEAD']] }), miss.demo('lonsdale'));
  ok(c.delta.transit_pax_min === null, 'before / after: delta.transit_pax_min = null');
  const bad = await connect({ fetch: fakeFetch, importer: noImporter, transit: { version: 1 } });
  ok(bad.status().transit === 'none' && (await bad.run(bad.demo('lonsdale'))).transit.src === null, 'injected transit invalid (no routes[]) → treated as absent');
  const broken = await connect({ fetch: fakeFetch, importer: noImporter, transit: { routes: [{ id: 'x', mode: 'bus', dirs: [{ dir: 0, links: 5 }] }] } });
  const sb = await broken.run(broken.demo('lonsdale'));
  ok(sb.queue_m > 0 && sb.transit.src === null && typeof sb.transit.error === 'string', `a transit failure does not break the page: vehicle numbers still come out, transit = { src: null, error: "${sb.transit.error}" }`);
  const given = await connect({ fetch: fakeFetch, importer: noImporter, transit: clone(TRANSIT) });
  ok(given.status().transit === 'given' && (await given.run(given.demo('lonsdale'))).transit.routes.length >= 10, 'opts.transit can be passed directly');
});

await t('pure function: a different network does not crash it, same input gives the same result', async () => {
  const net = loadNetwork(J(PATHS.network));
  const plan = be.demo('lonsdale');
  const r = be.engine.evaluate(plan);
  const a = transitImpact(net, be.engine.flows, TRANSIT, plan, r), b = transitImpact(net, be.engine.flows, TRANSIT, plan, r);
  ok(JSON.stringify(a) === JSON.stringify(b) && a.routes.length >= 10, 'same input, same result');
  const tiny = loadNetwork({ nodes: [{ id: 'a', lat: 0, lon: 0 }, { id: 'b', lat: 0, lon: 0.001 }], links: [{ id: 'ab', from: 'a', to: 'b', name: null, len_m: 100, lanes: 1, speed_kmh: 40, cap_vph: 900, t0_s: 9 }] });
  const x = transitImpact(tiny, { days: {} }, TRANSIT, { when: { date: '2026-10-06', hour: 8 }, worksites: [] }, { links: [] });
  ok(x.src === 'gtfs' && x.routes.length === 0 && transitImpact(tiny, null, null, plan, r).src === null, 'route links not on the network → not listed; empty transit → { src: null }');
});

// ---- review fixes: detour trip counted twice, network edge treated as cancellation, detours coming out "faster" ----
// small network: a straight line + two branches. All links 10 m/s with no traffic → travel time = length ÷ 10
const toyNet = (links, extraNodes = []) => {
  const ids = new Set(links.flatMap(l => [l[1], l[2]]).concat(extraNodes));
  return loadNetwork({
    nodes: [...ids].map((id, i) => ({ id, lat: 0, lon: i * 0.001 })),
    links: links.map(([id, from, to, len]) => ({ id, from, to, name: id, len_m: len, lanes: 1, speed_kmh: 36, cap_vph: 900, t0_s: len / 10, highway: 'secondary' })),
  });
};
const toyTransit = (links, stops = []) => ({
  routes: [{ id: 'bus_x', short: 'X', mode: 'bus', dirs: [{ dir: 0, headsign: 'E', links, stops: stops.map(s => s.id), trips: { wd: Array(24).fill(4), we: Array(24).fill(2) } }] }],
  stops,
});
const toyPlan = (closedLinks, lanes = 1) => ({ when: { date: '2026-10-06', hour: 8 }, worksites: closedLinks.length ? [{ id: 'W', links: closedLinks, closes: { lanes } }] : [] });
const NOFLOW = { days: { wd: {}, we: {} } };

await t('negative: the detour trip is not double-counted and an early turn is not penalised (small network)', async () => {
  // route A→B→C→D→E, 100 m (10 s) per link, C→D fully closed. Early turn: B→X→D 30 s; late turn: C→Y→D 34 s
  // early trip 10 + 30 + 10 = 50 s (+10 s); late trip 10 + 10 + 34 + 10 = 64 s (+24 s)
  const net = toyNet([['AB', 'A', 'B', 100], ['BC', 'B', 'C', 100], ['CD', 'C', 'D', 100], ['DE', 'D', 'E', 100], ['BX', 'B', 'X', 150], ['XD', 'X', 'D', 150], ['CY', 'C', 'Y', 170], ['YD', 'Y', 'D', 170]]);
  const tr = toyTransit(['AB', 'BC', 'CD', 'DE'], [{ id: 's1', name: 'Stop on BC', road_link: 'BC' }]);
  const r = transitImpact(net, NOFLOW, tr, toyPlan(['CD']), { links: [] }).routes[0];
  ok(r && r.diverted && !r.blocked && !r.edge && r.delay_s === 10 && r.detour_links.join() === 'BX,XD',
    `turn early when that is faster: +${r?.delay_s} s per trip (correct: 10), via ${r?.detour_links.join(' → ')} (the old algorithm picked the late turn and reported 24 s)`);
  ok(r.stops_skipped.length === 1 && r.stops_skipped[0].id === 's1' && r.pax_min === Math.round(((r.pax_h * 10) / 60) * 10) / 10, 'the early turn skips the stop on B→C, listed in stops_skipped; pax_min = pax_h × 10 ÷ 60');
});

await t('negative: a detour shortcut never makes a bus "faster", delay_s ≥ 0 (small network)', async () => {
  // same route, the early branch takes only 10 s (faster than B→C→D at 20 s): computes −10 s, recorded as 0
  const net = toyNet([['AB', 'A', 'B', 100], ['BC', 'B', 'C', 100], ['CD', 'C', 'D', 100], ['DE', 'D', 'E', 100], ['BX', 'B', 'X', 50], ['XD', 'X', 'D', 50]]);
  const x = transitImpact(net, NOFLOW, toyTransit(['AB', 'BC', 'CD', 'DE']), toyPlan(['CD']), { links: [] });
  ok(x.routes.length === 1 && x.routes[0].diverted && x.routes[0].delay_s === 0 && x.routes[0].pax_min === 0 && x.pax_min === 0,
    `detour 10 s faster than usual: delay_s = ${x.routes[0]?.delay_s}, pax_min = ${x.pax_min} (floored at 0, still marked diverted)`);
  // no detour: A→B a little slower, D→E much faster with less traffic, the whole trip faster than usual → not listed (rather than a negative row)
  const flows = { days: { wd: { DE: Array(24).fill(1200) }, we: {} } };
  const res = { links: [{ id: 'AB', v: 700, cap: 900 }, { id: 'DE', v: 0, cap: 900 }] };
  const slowAB = linkTime(10, 700, 900) - 10, fastDE = linkTime(10, 1200, 900) - 10;
  const y = transitImpact(net, flows, toyTransit(['AB', 'BC', 'CD', 'DE']), toyPlan([]), res);
  ok(slowAB > SLOWER_S && fastDE > slowAB && y.routes.length === 0 && y.pax_min === 0,
    `A→B ${slowAB.toFixed(1)} s slower, D→E ${fastDE.toFixed(1)} s faster: whole trip no slower than usual → not listed (${y.routes.length} routes)`);
});

await t('full closure at the network edge: counted as rerouting outside the network (edge), not a cancellation; only a closure in the middle with no detour is (small network)', async () => {
  // a straight 6-link road, 500 m per link, no branches: closing the first / last link → the bus reroutes outside the network; closing a middle one → genuinely impassable
  const line = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6'];
  const ls = line.slice(1).map((b, i) => [line[i] + b, line[i], b, 500]);
  const net = toyNet(ls), tr = toyTransit(ls.map(l => l[0]));
  const at = id => transitImpact(net, NOFLOW, tr, toyPlan([id]), { links: [] });
  for (const id of ['P0P1', 'P5P6']) {
    const x = at(id), r = x.routes[0];
    ok(r && r.edge && r.diverted && !r.blocked && r.delay_s === null && r.pax_min === null && x.blocked_routes === 0 && x.blocked_pax_h === 0 && x.edge_routes === 1 && x.pax_min === 0,
      `closing ${id} (where the route ${id === 'P0P1' ? 'enters' : 'leaves'} the network): edge, minutes null, not a cancellation`);
  }
  const mid = at('P2P3'), m = mid.routes[0];
  ok(m && m.blocked && !m.edge && m.delay_s === null && mid.blocked_routes === 1 && mid.edge_routes === 0,
    `negative: closing a middle link (> ${DIVERT_M} m from both ends) with no detour → still blocked`);
});

// real data: fully close every link used by buses, one at a time, at 08:00
const net = be.engine.net, flows = be.engine.flows;
const RP = new Map(routePaths(net, TRANSIT).map(x => [x.id + '/' + x.dir, x.path]));
const busLinks = [...new Set(TRANSIT.routes.filter(r => r.mode === 'bus').flatMap(r => r.dirs.flatMap(d => d.links)))].filter(id => net.links.has(id));
const fullAt = (id, hour = 8, lanes = 9) => {
  const p = be.demo('lonsdale', { hour }); p.worksites[0].links = [id]; p.worksites[0].closes.lanes = lanes; p.worksites[0].equipment = [];
  const r = be.engine.evaluate(p);
  return { r, tr: transitImpact(net, flows, TRANSIT, p, r) };
};
const day = dayType({ date: '2026-10-06' });
const baseT = (id, hour) => { const l = net.links.get(id); return linkTime(l.t0_s, Math.round(flows.days[day][id]?.[hour] ?? 0), Math.round(l.cap_vph)); };
// a bus's whole trip "route to node(m) + detour + route after node(k)" (travel times under the plan); correct if some turn-off matches delay_s + the usual trip
function tripMatches(row, closedId, r, hour) {
  const path = RP.get(row.id + '/' + row.dir), X = new Map(r.links.map(x => [x.id, x]));
  const planT = id => { const x = X.get(id), l = net.links.get(id); return x ? linkTime(l.t0_s, x.v, x.cap) : baseT(id, hour); };
  const n = path.length, L = path.map(id => net.links.get(id)), node = k => (k < n ? L[k].from : L[n - 1].to);
  const q = path.indexOf(closedId), D = row.detour_links.map(id => net.links.get(id));
  if (q < 0 || path.lastIndexOf(closedId) !== q || !D.length) return null; // only check routes closed at a single place
  const s = D[0].from, e = D[D.length - 1].to, dT = D.reduce((a, l) => a + planT(l.id), 0);
  const base = path.reduce((a, id) => a + baseT(id, hour), 0), want = row.delay_s + base;
  let best = Infinity;
  for (let m = 0; m <= q; m++) if (node(m) === s) for (let k = q + 1; k <= n; k++) if (node(k) === e) {
    const tot = path.slice(0, m).reduce((a, id) => a + planT(id), 0) + dT + path.slice(k).reduce((a, id) => a + planT(id), 0);
    best = Math.min(best, Math.abs(tot - want));
  }
  return best;
}

await t('negative: detour seconds per trip = the actual path\'s whole trip − the usual trip (real data, each link fully closed)', async () => {
  // Victoria St full closure: the old algorithm reported a 1,270 s trip for route 402 (+1,198 s), while its own chosen path takes only 574 s
  const vic = fullAt('l277089910_1691676471'), b402 = vic.tr.routes.find(r => r.id === 'bus_402' && r.dir === 0);
  const m402 = tripMatches(b402, 'l277089910_1691676471', vic.r, 8);
  ok(b402.diverted && b402.delay_s > 0 && b402.delay_s < 600 && m402 <= 0.06, `Victoria St full closure: route 402 +${b402.delay_s} s per trip (old algorithm 1197.7), matching its detour path (off by ${m402?.toFixed(2)} s)`);
  let checked = 0;
  const bad = [];
  for (const id of busLinks) {
    const { r, tr } = fullAt(id);
    for (const row of tr.routes) {
      if (!row.diverted || row.edge || !(row.delay_s > 0)) continue;
      const d = tripMatches(row, id, r, 8);
      if (d == null) continue;
      checked++;
      if (!(d <= 0.06)) bad.push(`${id} ${row.id}/${row.dir} off by ${d.toFixed(1)} s`);
    }
  }
  ok(checked > 200 && bad.length === 0, `${busLinks.length} links fully closed one at a time, ${checked} diverted bus trips checked: all whole trips match${bad.length ? '; mismatches: ' + bad.slice(0, 3).join('; ') : ''}`);
});

await t('negative: works never make buses faster; the network edge is not a cancellation (real data, each link fully closed at 08:00)', async () => {
  // A'Beckett St is a one-lane street, so the page's default one-lane closure = full closure: the old algorithm reported −2.1 s for route 220's detour, total pax_min = −6
  const ab = fullAt('l2189145409_33085559', 8, 1).tr, b220 = ab.routes.find(r => r.id === 'bus_220' && r.dir === 1);
  ok(b220 && b220.diverted && b220.delay_s >= 0 && b220.pax_min >= 0 && ab.pax_min >= 0, `A'Beckett St one lane closed (full closure): route 220 detour ${b220?.delay_s} s per trip, total ${ab.pax_min} rider-minutes (not negative)`);
  // this Spencer St link is route 216's first link inside the network (41.7 m) and its start connects only to a minor road: the old algorithm called route 216 cancelled
  const sp = fullAt('l3215192040_332549400').tr, b216 = sp.routes.find(r => r.id === 'bus_216' && r.dir === 1);
  ok(b216 && b216.edge && b216.diverted && !b216.blocked && b216.delay_s === null && sp.blocked_routes === 0 && sp.blocked_pax_h === 0 && sp.edge_routes >= 1 && sp.routes[sp.routes.length - 1].edge,
    `Spencer St full closure: route 216 reroutes outside the network (edge), not a cancellation (blocked_routes ${sp.blocked_routes}), sorted last`);
  let negRows = 0, negTot = 0, flat = 0, farEdge = 0, busBlocked = 0, edges = 0;
  const len = ids => ids.reduce((a, x) => a + net.links.get(x).len_m, 0);
  for (const id of busLinks) {
    const { tr } = fullAt(id);
    if (tr.pax_min < 0) negTot++;
    for (const row of tr.routes) {
      if (row.delay_s != null && row.delay_s < 0) negRows++;
      if (row.mode === 'bus' && !row.diverted && !(row.delay_s > SLOWER_S)) flat++;
      if (row.mode === 'bus' && row.blocked) busBlocked++;
      if (row.edge) {
        edges++;
        const path = RP.get(row.id + '/' + row.dir), i = path.indexOf(id);
        if (!(len(path.slice(0, i)) <= DIVERT_M || len(path.slice(i + 1)) <= DIVERT_M)) farEdge++;
      }
    }
  }
  ok(negRows === 0 && negTot === 0, `${busLinks.length} links fully closed one at a time: no route with delay_s < 0 (${negRows}), no plan with total pax_min < 0 (${negTot})`);
  ok(flat === 0, `every listed non-diverting bus is > ${SLOWER_S} s slower per trip (trips no slower are not listed)`);
  ok(edges > 0 && farEdge === 0 && busBlocked === 0, `all ${edges} edge cases are within ${DIVERT_M} m of where the route enters / leaves the network; buses judged cancelled ${busBlocked} times (network cut-off no longer counts as cancellation)`);
});

done();
