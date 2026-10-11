// transit.js — how much trams and buses are affected by the works. Pure functions, no DOM; called by run() in backend.js, result in summary.transit.
// Data: transit.json from apps/roads (PTV GTFS timetables: 47 tram / bus routes in the CBD, with the matched links[] per direction, stops[],
// and hourly trips trips.wd|we[24]; a stop's road_link = the link it sits on).
// Model (every item is an assumption; also described in docs/reference/interfaces.md (Trams and buses: s.transit) and apps/engine/README.md):
//   1 List only routes that "pass a fully closed link in this direction" or are "slower than with no works by > SLOWER_S s per trip"; routes with no trips this hour are not listed.
//     trips = trips[wd|we][hour], weekday / weekend from the engine's dayType.
//   2 Buses run with general traffic on fixed routes: extra seconds per trip = sum over the route's links of (travel time under this plan − travel time in the same hour with no works).
//     Both use the engine's linkTime (BPR + deterministic queueing): under the plan from result.links v and cap, with no works from this hour's flows.json flow and the original capacity
//     (rounded the same way, so unchanged links differ by exactly 0). result.links[].delay_s is extra time versus free flow, not versus no works, so it cannot be summed directly.
//     Some links get faster because traffic diverts away: a non-diverting bus whose whole trip adds ≤ SLOWER_S s is not listed (works never make a bus "faster", see 7).
//   3 A fully closed link on a bus route → it must detour: turn off at a route node within DIVERT_M m before the closure, take the shortest path (by travel time under this plan,
//     avoiding fully closed links and U-turns back up the route), and rejoin within DIVERT_M m after it; pick the fastest option over the whole trip (comparing "route up to the turn-off + detour + route from
//     the rejoin point to the same point", so early and late turns are treated alike). Main roads (BUS_ROADS) first, then side streets if needed; laneways (NO_DETOUR) never;
//     if nothing works nearby, search the whole route; if still nothing = blocked.
//     extra seconds per trip = detoured trip − trip with no works; diverted = true, detour_links = the detour, stops_skipped = stops on the bypassed part of the route.
//   3b Network edge: transit.json routes are cut to the CBD network. If a full closure is within DIVERT_M m of where the route enters / leaves the network (or of its terminus) and there is no detour inside the network
//     → the bus reroutes outside the network and the detour time cannot be computed here: edge = true, diverted = true, delay_s / pax_min = null; not counted as cancelled (not in blocked_*),
//     counted separately in edge_routes. Otherwise the network cut-off would be reported as a cancellation and ranked first.
//   4 Trams in the CBD run in their own lanes / the road centre: partial lane closures and slower traffic beside them do not delay them (not listed);
//     a full closure of a link a tram uses = blocked (trams cannot detour), reporting this hour's lost trips trips_h and riders pax_h, with minutes null (not invented).
//   5 Riders per trip are assumed (PAX_PER_TRIP; PTV has no per-route, per-hour loading data): weekdays 7–9 and 16–18 are peak, the rest off-peak;
//     pax_h = trips × riders per trip, pax_min = pax_h × extra seconds per trip ÷ 60 (rider-minutes this hour).
//   6 transit.json links[] were matched by 10 m sampling, so short links inside junctions are often skipped: where two consecutive links do not connect, the shortest path within GAP_FILL_M m fills the gap
//     (trams only through tram = true links); if it cannot be filled (route leaves the network, or matched to the opposite direction) it is left as is and that gap adds no time.
//   7 A detour that takes a shortcut (the route normally loops round to serve a stop, and the detour skips the loop) can come out faster than usual: extra seconds per trip are never below 0.
//     Buses run to a timetable and wait at stops if early; the riders' loss is the skipped stops (stops_skipped), not "time saved".

import { linkTime, dijkstra, treePath } from './net.js';
import { dayType, isActive, capFactors } from './worksite.js';
import { NO_DETOUR } from './routes.js';

// average riders per trip: assumed values (D-0929-1536: the UI labels them as assumptions and shows a range). Peak tram 60 (an E-class tram holds about 210 when full), bus 25 in a ~60-place bus
export const PAX_PER_TRIP = { peak: { tram: 60, bus: 25 }, offpeak: { tram: 30, bus: 12 } };
export const PAX_RANGE = { peak: { tram: [40, 120], bus: [15, 45] }, offpeak: { tram: [15, 60], bus: [5, 25] } };
export const TRANSIT_PEAK_HOURS = [7, 8, 9, 16, 17, 18]; // weekdays only
export const GAP_FILL_M = 60; // fill gaps between consecutive route links with the shortest path within this distance (short links inside junctions)
export const DIVERT_M = 400; // bus detours: turn off / rejoin within this many metres before / after the closure (same order as UP_M in routes.js)
export const SLOWER_S = 0.1; // a link counts as slower only beyond this many seconds versus no works (result.links precision is 0.1 s)
// bus detours use only these road classes first (OSM highway); if that fails, unclassified / residential side streets are allowed; NO_DETOUR laneways never
export const BUS_ROADS = new Set(['motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link']);

const round1 = x => Math.round(x * 10) / 10;
const TRAM = 'tram';
const NOTE = 'Riders per trip are assumed (no per-route PTV loading data). Trams run in their own lanes in the CBD: a partial lane closure does not delay them; only a full closure stops them. Buses run with traffic on fixed routes and take the nearest detour around a full closure, never counted below 0 s. Minutes cannot be computed for buses that reroute outside the network when the closure is at its edge (edge).';
const NOTE_ZH = '每趟载客人数是假设值（没有 PTV 分线路载客数据）；电车在 CBD 走自己的车道，封部分车道不耽误电车，全封才停；公交跟车流走固定线路，全封就近绕行，绕行最少记 0 秒；封在路网边上、在路网外换路的公交分钟数算不出（edge）';

// route direction → link sequence (with junction gaps filled). Cached per transit object × network: the same data is indexed once
const idxCache = new WeakMap();
function indexTransit(net, transit) {
  let byNet = idxCache.get(transit);
  if (!byNet) idxCache.set(transit, (byNet = new WeakMap()));
  if (byNet.has(net)) return byNet.get(net);
  const trees = new Map();
  // trams fill gaps only through links with tracks (network.json tram field; no restriction if the network lacks it)
  const fill = (a, b, tram) => {
    const k = (tram ? 't|' : 'b|') + a;
    if (!trees.has(k)) trees.set(k, dijkstra(net, a, { cost: l => l.len_m, maxCost: GAP_FILL_M, linkOk: l => !tram || l.tram !== false }));
    return treePath(trees.get(k), a, b);
  };
  const dirs = [];
  for (const route of transit.routes || []) {
    for (const dir of route.dirs || []) {
      const path = [];
      for (const id of dir.links || []) {
        const l = net.links.get(id);
        if (!l) continue; // not on this network (a different network does not crash it)
        const last = path.length ? net.links.get(path[path.length - 1]) : null;
        if (last && last.to !== l.from) { const f = fill(last.to, l.from, route.mode === TRAM); if (f) path.push(...f); }
        path.push(id);
      }
      if (path.length) dirs.push({ route, dir, path });
    }
  }
  const idx = { dirs, stops: new Map((transit.stops || []).map(s => [s.id, s])) };
  byNet.set(net, idx);
  return idx;
}

export function isTransit(x) {
  return Boolean(x && Array.isArray(x.routes));
}

// link sequence of each route direction on this network (gaps filled; the same one busTrip uses) → [{ id, dir, path }]; tests use it to check whole-trip detour times
export function routePaths(net, transit) {
  if (!isTransit(transit)) return [];
  return indexTransit(net, transit).dirs.map(({ route, dir, path }) => ({ id: route.id, dir: dir.dir, path }));
}

// riders per trip this hour (assumed)
export function paxPerTrip(when) {
  const period = dayType(when) === 'wd' && TRANSIT_PEAK_HOURS.includes(when.hour) ? 'peak' : 'offpeak';
  return { period, ...PAX_PER_TRIP[period], range: PAX_RANGE[period] };
}

// net = loadNetwork() result (engine.net); flows = flows.json; transit = transit.json; plan = works plan; result = engine.evaluate(plan)
// → summary.transit (format in the file header and docs/reference/interfaces.md). Invalid transit → { src: null }
export function transitImpact(net, flows, transit, plan, result) {
  if (!isTransit(transit)) return { src: null };
  const when = plan.when;
  const day = dayType(when), hour = when.hour;
  const P = paxPerTrip(when);
  const assumed = { pax_per_trip: { tram: P.tram, bus: P.bus }, period: P.period, range: P.range, note: NOTE, note_zh: NOTE_ZH };

  const active = (plan.worksites || []).filter(ws => isActive(ws, when));
  const factors = capFactors(net, active);
  const closed = new Set([...factors].filter(([, x]) => x.f === 0).map(([id]) => id));
  const X = new Map((result?.links || []).map(x => [x.id, x]));
  const memoB = new Map(), memoP = new Map();
  // no works: this hour's flows.json flow + original capacity. Under the plan: result.links v, cap (link absent = unchanged)
  const baseT = id => {
    if (!memoB.has(id)) {
      const l = net.links.get(id);
      memoB.set(id, linkTime(l.t0_s, Math.round(flows?.days?.[day]?.[id]?.[hour] ?? 0), Math.round(l.cap_vph)));
    }
    return memoB.get(id);
  };
  const planT = id => {
    if (!memoP.has(id)) {
      const x = X.get(id), l = net.links.get(id);
      memoP.set(id, x ? linkTime(l.t0_s, x.v, x.cap) : baseT(id));
    }
    return memoP.get(id);
  };
  // roads detours may not use: main roads only first (strict), side streets if that fails (relaxed); fully closed links and laneways (NO_DETOUR) never
  const ls = [...net.links.values()];
  const banned = {
    strict: new Set([...closed, ...ls.filter(l => !BUS_ROADS.has(l.highway)).map(l => l.id)]),
    relaxed: new Set([...closed, ...ls.filter(l => NO_DETOUR.has(l.highway)).map(l => l.id)]),
  };
  const trees = new Map(); // detour shortest-path trees: computed once per start node + banned node set (many buses share the same stretch of Lonsdale St)

  // whole-trip time of this bus under the plan (detouring around full closures) → { t, detour: detour links, skipped: bypassed route links };
  // no detour inside the network and the closure within DIVERT_M m of where the route enters / leaves it → { edge: true } (reroutes outside the network, model 3b); no detour at all → null
  function busTrip(path) {
    const n = path.length;
    const L = path.map(id => net.links.get(id));
    const pt = path.map(id => (closed.has(id) ? 0 : planT(id)));
    const pre = [0];
    for (let i = 0; i < n; i++) pre.push(pre[i] + pt[i]);
    const sum = (a, b) => pre[b] - pre[a]; // time of path[a..b-1]
    const plen = [0];
    for (let i = 0; i < n; i++) plen.push(plen[i] + L[i].len_m);
    const len = (a, b) => plen[b] - plen[a]; // length of path[a..b-1] (m)
    const node = k => (k < n ? L[k].from : L[n - 1].to);
    let t = 0, q = 0, lo = 0;
    const detour = [], skipped = [];
    while (q < n) {
      if (!closed.has(path[q])) { t += pt[q]; q++; continue; }
      let j = q;
      while (j + 1 < n && closed.has(path[j + 1])) j++;
      const pick = (near, mode) => {
        // turn off at node(m), m ∈ [lo, q], skipping ≤ DIVERT_M m of route; rejoin at node(k), k ∈ (j, n], skipping ≤ DIVERT_M m and not past the next full closure
        const ms = [], ks = [];
        for (let m = q, d = 0; m >= lo; m--) { if (m < q) d += L[m].len_m; if (near && d > DIVERT_M) break; ms.push(m); }
        for (let k = j + 1, d = 0; k <= n; k++) {
          if (k > j + 1) d += L[k - 1].len_m;
          if (near && d > DIVERT_M) break;
          ks.push(k);
          if (k < n && closed.has(path[k])) break;
        }
        const hi = ks[ks.length - 1];
        let best = null;
        for (const m of ms) {
          const s = node(m);
          const up = new Set(); // no U-turn back up the route: route nodes within DIVERT_M m before the turn-off are banned
          for (let x = m - 1, d = 0; x >= 0 && d <= DIVERT_M; x--) { up.add(node(x)); d += L[x].len_m; }
          const key = mode + '|' + s + '|' + [...up].sort().join(',');
          if (!trees.has(key)) trees.set(key, dijkstra(net, s, { cost: l => planT(l.id), banned: banned[mode], bannedNodes: up }));
          const tree = trees.get(key);
          for (const k of ks) {
            const d = tree.dist.get(node(k));
            if (d == null) continue;
            const c = sum(lo, m) + d + sum(k, hi); // whole trip from lo to hi: route to node(m) + detour + route from node(k) to hi
            if (!best || c < best.c - 1e-9) best = { c, m, k, hi, tree, s };
          }
        }
        return best;
      };
      // try main roads near the closure → nearby side streets → main roads along the whole route → side streets along the whole route
      const b = pick(true, 'strict') || pick(true, 'relaxed') || pick(false, 'strict') || pick(false, 'relaxed');
      if (!b) return (lo === 0 && len(0, q) <= DIVERT_M) || len(j + 1, n) <= DIVERT_M ? { edge: true } : null;
      t += b.c - sum(lo, q); // t already includes path[lo..q-1] (including path[m..q-1], which the bus did not actually drive); replace it with the actual lo → hi trip
      detour.push(...treePath(b.tree, b.s, node(b.k)));
      skipped.push(...path.slice(b.m, b.k));
      q = b.hi;
      lo = b.hi;
    }
    return { t, detour, skipped };
  }

  const idx = indexTransit(net, transit);
  const routes = [];
  for (const { route, dir, path } of idx.dirs) {
    const trips = dir.trips?.[day]?.[hour] ?? 0;
    if (!(trips > 0)) continue;
    const tram = route.mode === TRAM;
    const isClosed = path.some(id => closed.has(id));
    const slower = new Set(tram ? [] : path.filter(id => !closed.has(id) && planT(id) - baseT(id) > SLOWER_S));
    if (!isClosed && !slower.size) continue;
    const ppt = tram ? P.tram : P.bus;
    const pax_h = trips * ppt;
    const links = [...new Set(path.filter(id => closed.has(id) || slower.has(id)))];
    const stops = [...new Set(dir.stops || [])].map(id => idx.stops.get(id)).filter(Boolean);
    const stopsOn = set => stops.filter(s => set.has(s.road_link)).map(s => ({ id: s.id, name: s.name }));
    let delay = null, diverted = false, blocked = false, edge = false, detour_links = [], stops_skipped = [];
    if (tram) blocked = isClosed; // a tram that gets here must have hit a full closure
    else {
      const trip = busTrip(path);
      if (!trip) blocked = true;
      else if (trip.edge) { diverted = true; edge = true; } // model 3b: reroutes outside the network, minutes unknown (null), not a cancellation
      else {
        const raw = trip.t - path.reduce((s, id) => s + baseT(id), 0);
        if (!isClosed && round1(raw) <= SLOWER_S) continue; // model 2: not diverting and the whole trip (at the reported 0.1 s) is no slower than usual (other links got faster) → not listed
        delay = Math.max(0, raw); // model 7: a detour shortcut still counts as at least 0 (timetabled, early buses wait; skipped stops are in stops_skipped)
        diverted = isClosed;
        detour_links = trip.detour;
        const on = new Set(trip.detour);
        stops_skipped = stopsOn(new Set(trip.skipped.filter(id => !on.has(id))));
      }
    }
    routes.push({
      id: route.id, short: route.short, mode: route.mode, dir: dir.dir, headsign: dir.headsign,
      trips_h: trips, pax_per_trip: ppt, pax_h,
      delay_s: delay == null ? null : round1(delay),
      pax_min: delay == null ? null : round1((pax_h * delay) / 60),
      diverted, blocked, edge, stops_closed: stopsOn(closed), links, detour_links, stops_skipped,
    });
  }
  // blocked first (by pax_h), the rest by pax_min descending, rerouted outside the network (edge, minutes null) last (by pax_h)
  routes.sort((a, b) => (b.blocked - a.blocked) || (a.edge - b.edge)
    || (a.blocked || a.edge ? b.pax_h - a.pax_h : b.pax_min - a.pax_min)
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : a.dir - b.dir));
  const tot = k => routes.reduce((s, r) => s + (r[k] ?? 0), 0);
  const blockedR = routes.filter(r => r.blocked);
  return {
    src: 'gtfs', day, hour, routes,
    trips_h: tot('trips_h'), pax_h: tot('pax_h'), pax_min: Math.round(tot('pax_min')),
    blocked_routes: blockedR.length, blocked_pax_h: blockedR.reduce((s, r) => s + r.pax_h, 0),
    edge_routes: routes.filter(r => r.edge).length,
    assumed,
  };
}
