// peds.js — impact of a footpath closure on pedestrians. Pure functions, no DOM; imports directly in the browser and in Node.
// Input: walk.json (OSM footpath network) and peds.json (pedestrians per footpath per hour) from apps/roads, the plan, and the road network (optional; used to find the opposite carriageway's footpath).
//   pedImpact(walk, peds, plan, { net }) → { src: 'peds', footpath, day, hour, closed, closed_m, ped_h, detour_m, extra_min, crossings,
//                                            blocked, step_free: null, measured, sensor, detour, assumed, … } (field list in docs/reference/interfaces.md, Pedestrians: summary.peds)
// Model (all assumptions, recorded in assumed):
//   1 Which footpaths close: those attached to the works links (walk.json road_link = works link, matching side, kind sidewalk / other / path).
//     'left' / 'right' are relative to the works link's driving direction, same convention as walk.json side (keep-left traffic: left = the kerb next to the closed lane).
//     Dual carriageways (two OSM ways, one per direction, as on Lonsdale and La Trobe): the right-hand footpath hangs off the opposite carriageway as its left,
//     so the opposite carriageway is found too (same name, opposite direction, close by), and its left = the works link's right;
//     only footpaths running alongside the works link for ≥ min(5 m, half their own length) are taken (by parallel overlap length, not by midpoint).
//   2 Per stretch (worksite × side × a chain of end-to-end works links whose headings differ by < 60°): origin and destination = the two nodes of the closed footpaths that are farthest apart
//     and can still reach the wider network while avoiding the closure (not a dead end, not a small island of a few links);
//     detour = shortest path on the (undirected) footpath network avoiding every closed footpath; extra metres = detour length − usual shortest path length.
//     Fewer than 2 such nodes = dead end (dead_end): nobody walks through, so no detour and not blocked either.
//   3 ped_h = the busiest closed footpath in this stretch this hour (peds.json, index = hour); assumes all of them walk the full stretch (upper bound).
//   4 extra_min = ped_h × extra metres ÷ (walking speed × 60), person-minutes per hour, the same unit basis as the vehicles' delay_min. Waiting at signals is not included.
//   5 No way round (origin and destination disconnected) = blocked; those pedestrians are not counted in extra_min but reported as blocked_ped_h (like blocked_vph for vehicles).
//   6 walk.json has no step / kerb-ramp data, so wheelchair access is not assessed: step_free is always null.
//   7 Crossings: consecutive crossing segments on the detour (a refuge island splits one crossing into several) count once, unless they cross differently named streets.
//   8 If the side the plan closes has no footpath in walk.json → unmatched = true + note, rather than pretending there is no impact.

import { isActive, dayType, footpathOf, validateWorksite } from './worksite.js';

export const WALK_MPS = 1.3; // walking speed m/s [assumed: average adult pace; Austroads uses 1.2 for signal timing, older people and prams are slower]
export const CLOSABLE_KINDS = new Set(['sidewalk', 'other', 'path']); // footpath kinds works can close; crossings and malls are never closed
export const OPPOSITE_M = 40; // max distance for the opposite carriageway to count as "the same street, other direction" [assumed: CBD dual-carriageway centrelines are about 10–25 m apart]
export const SENSOR_NEAR_M = 40; // max distance for a real counter to count as "on this stretch" (peds.json assumptions.sensor_m if present); it must also be on the same side
export const OVERLAP_MIN_M = 5; // an opposite-carriageway footpath counts as closed only if it runs alongside the works link for ≥ min(5 m, half its length) [assumed: less is a corner fragment]
export const MIN_REACH = 60; // reaching fewer than 60 footpath nodes while avoiding the closure = dead end / small island, not used as a detour endpoint [assumed: a CBD block perimeter has about 20–40 nodes]
const OPP_LAT_M = OPPOSITE_M + 25; // max distance of the opposite footpath from the works link centreline (opposite carriageway ≤ 40 m + road / footpath width)
const STEP_M = 1; // when measuring parallel overlap, cut footpath polylines into pieces ≤ 1 m

export const PEDS_NOTE = 'Assumes everyone counted on the closed footpath walks its full length (upper bound). Detour = shortest path on the OSM walk network avoiding the closed footpath; waiting at signals is not included. walk.json has no step or kerb-ramp data, so step-free access is not assessed (step_free: null).';
export const PEDS_NOTE_ZH = '假设封掉的这段人行道上数到的人都要走完整段（上限）。绕行 = OSM 人行道路网上避开封闭段的最短路，等红灯的时间没算。walk.json 没有台阶 / 坡道数据，不判断轮椅能不能走（step_free: null）。';

export const UNMATCHED_NOTE = 'walk.json has no footpath on this side of this link, so the closure could not be scored (not the same as "footpath open").';
export const UNMATCHED_NOTE_ZH = 'walk.json 里这条路段的这一侧没有人行道，封了也算不出来（不等于「人行道照常通行」）。';
export const DEAD_END_NOTE = 'The closed footpath is a dead end in walk.json (one end reaches no other footpath), so nobody walks through it and no detour is counted.';
export const DEAD_END_NOTE_ZH = '封掉的人行道在 walk.json 里是死胡同（有一头连不到别的人行道），没有穿过去的人，不算绕行。';

const DEG = Math.PI / 180;
const KY = 110574; // metres per degree of latitude (near Melbourne; a local planar approximation is enough)
const r1 = x => Math.round(x * 10) / 10;

// ---------- footpath network index (built once per walk object) ----------
const walkCache = new WeakMap();
function indexWalk(walk) {
  if (walkCache.has(walk)) return walkCache.get(walk);
  if (!walk || !Array.isArray(walk.nodes) || !Array.isArray(walk.links)) throw new Error('walk must have nodes[] and links[]');
  const nodes = new Map(walk.nodes.map(n => [n.id, n]));
  const links = new Map(), adj = new Map(), byRoad = new Map();
  for (const l of walk.links) {
    if (!nodes.has(l.a) || !nodes.has(l.b) || !(l.len_m >= 0)) continue;
    links.set(l.id, l);
    for (const [x, y] of [[l.a, l.b], [l.b, l.a]]) {
      if (!adj.has(x)) adj.set(x, []);
      adj.get(x).push({ to: y, link: l });
    }
    if (l.road_link) {
      if (!byRoad.has(l.road_link)) byRoad.set(l.road_link, []);
      byRoad.get(l.road_link).push(l);
    }
  }
  for (const arr of adj.values()) arr.sort((p, q) => (p.link.id < q.link.id ? -1 : p.link.id > q.link.id ? 1 : 0)); // fixed traversal order → deterministic results
  const ix = { nodes, links, adj, byRoad };
  walkCache.set(walk, ix);
  return ix;
}

// road network: accepts a loadNetwork() result (links is a Map) or raw network.json
const netCache = new WeakMap();
function roadIndex(net) {
  if (!net) return null;
  if (netCache.has(net)) return netCache.get(net);
  const links = net.links instanceof Map ? net.links : new Map((net.links || []).map(l => [l.id, l]));
  const nodes = net.nodes instanceof Map ? net.nodes : new Map((net.nodes || []).map(n => [n.id, n]));
  const ix = { links, nodes, all: [...links.values()] };
  netCache.set(net, ix);
  return ix;
}
function roadPts(rix, l) {
  if (Array.isArray(l.geometry) && l.geometry.length >= 2) return l.geometry;
  const a = rix.nodes.get(l.from), b = rix.nodes.get(l.to);
  return a && b ? [[a.lat, a.lon], [b.lat, b.lon]] : null;
}

// ---------- planar geometry (local equirectangular projection, metres) ----------
const xy = kx => ([lat, lon]) => [lon * kx, lat * KY];
function onSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy, len = Math.sqrt(L2);
  const t = L2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0;
  const tc = Math.max(0, Math.min(1, t));
  return { d: Math.hypot(p[0] - (a[0] + tc * dx), p[1] - (a[1] + tc * dy)), t, len };
}
// point to polyline: nearest distance + position along it (not clamped; can be < 0 or > total length)
function onLine(p, pts) {
  let best = null, acc = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const s = onSeg(p, pts[i], pts[i + 1]);
    if (!best || s.d < best.d) best = { d: s.d, along: acc + s.t * s.len, i };
    acc += s.len;
  }
  return best ? { ...best, total: acc } : null;
}
function lineLen(pts) { let s = 0; for (let i = 0; i + 1 < pts.length; i++) s += Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]); return s; }
function midpoint(pts) {
  const half = lineLen(pts) / 2;
  let acc = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const d = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    if (acc + d >= half && d > 0) { const t = (half - acc) / d; return [pts[i][0] + t * (pts[i + 1][0] - pts[i][0]), pts[i][1] + t * (pts[i + 1][1] - pts[i][1])]; }
    acc += d;
  }
  return pts[0];
}
const heading = pts => { const a = pts[0], b = pts[pts.length - 1], dx = b[0] - a[0], dy = b[1] - a[1], n = Math.hypot(dx, dy) || 1; return [dx / n, dy / n]; };
const compass = h => ['N', 'E', 'S', 'W'][Math.round((((Math.atan2(h[0], h[1]) / DEG) + 360) % 360) / 90) % 4];
// which side of the polylines a point is on: > 0 left, < 0 right (relative to their direction), judged on the nearest segment
function sideOf(p, lines) {
  let best = null;
  for (const pts of lines) for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1], s = onSeg(p, a, b);
    if (!best || s.d < best.d) best = { d: s.d, c: (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) };
  }
  return best ? Math.sign(best.c) : 0;
}
// how much of polyline g runs alongside polyline lp: cut into pieces ≤ 1 m and sum the pieces whose midpoint projects within [0, total length] of lp, lies ≤ lat m from lp,
// and is roughly parallel to that part of lp (angle < 45°; the crosswise bit at a corner does not count)
function besideM(g, lp, total, lat) {
  let m = 0;
  for (let i = 0; i + 1 < g.length; i++) {
    const a = g[i], b = g[i + 1], d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!d) continue;
    const n = Math.max(1, Math.ceil(d / STEP_M));
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n, q = onLine([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])], lp);
      if (!q || q.along < 0 || q.along > total || q.d > lat) continue;
      const s0 = lp[q.i], s1 = lp[q.i + 1], sl = Math.hypot(s1[0] - s0[0], s1[1] - s0[1]) || 1;
      if (Math.abs(((b[0] - a[0]) * (s1[0] - s0[0]) + (b[1] - a[1]) * (s1[1] - s0[1])) / (d * sl)) >= 0.7) m += d / n;
    }
  }
  return m;
}

// ---------- shortest path (undirected, Dijkstra + binary heap) ----------
function dijkstra(ix, from, to, banned) {
  if (from === to) return { m: 0, links: [] };
  const dist = new Map([[from, 0]]), prev = new Map(), done = new Set();
  const heap = [[0, from]];
  const push = e => { heap.push(e); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } }
    return top;
  };
  while (heap.length) {
    const [d, u] = pop();
    if (done.has(u)) continue;
    done.add(u);
    if (u === to) break;
    for (const { to: v, link } of ix.adj.get(u) || []) {
      if (banned && banned.has(link.id)) continue;
      const nd = d + link.len_m;
      if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prev.set(v, { u, link }); push([nd, v]); }
    }
  }
  if (!done.has(to)) return null;
  const links = [];
  for (let v = to; v !== from; v = prev.get(v).u) links.push(prev.get(v).link);
  return { m: dist.get(to), links: links.reverse() };
}
const isCrossing = l => l.kind === 'crossing' || l.crossing != null;
// number of street crossings: consecutive crossing segments count once (a refuge island splits a crossing into pieces), unless both have known, different street names (crossing two streets in a row at a corner)
function countCrossings(links, nameOf) {
  let n = 0, prev = null;
  for (const l of links) {
    if (!isCrossing(l)) { prev = null; continue; }
    const nm = nameOf(l);
    if (!prev || (prev.nm && nm && prev.nm !== nm)) n++;
    prev = { nm: nm ?? prev?.nm ?? null };
  }
  return n;
}
// can node n reach at least cap nodes while avoiding the closure (if not = dead end / small island)
function reachesMain(ix, n, banned, cap) {
  const seen = new Set([n]), stack = [n];
  while (stack.length && seen.size < cap) {
    for (const { to, link } of ix.adj.get(stack.pop()) || []) {
      if (banned.has(link.id) || seen.has(to)) continue;
      seen.add(to);
      stack.push(to);
    }
  }
  return seen.size >= cap;
}
const walkPts = (ix, l) => (Array.isArray(l.geometry) && l.geometry.length >= 2 ? l.geometry : [ix.nodes.get(l.a), ix.nodes.get(l.b)].map(n => [n.lat, n.lon]));

// ---------- which footpaths are closed ----------
// opposite carriageway: same name (when both are named), opposite direction, within OPPOSITE_M m of the works link, overlapping along its length
function oppositeLinks(rix, L, P, toXY) {
  const lp = P.map(toXY), h = heading(lp), total = lineLen(lp);
  const out = [];
  for (const M of rix.all) {
    if (M.id === L.id) continue;
    if (L.name && M.name && L.name !== M.name) continue;
    const mp0 = roadPts(rix, M);
    if (!mp0) continue;
    const mp = mp0.map(toXY), hm = heading(mp);
    if (h[0] * hm[0] + h[1] * hm[1] > -0.87) continue; // angle < 150° is not opposite
    const near = mp.map(p => onLine(p, lp)).filter(Boolean);
    if (!near.some(q => q.d <= OPPOSITE_M)) continue;
    const alongs = near.map(q => q.along);
    if (Math.max(...alongs) < 0 || Math.min(...alongs) > total) continue;
    out.push(M);
  }
  return out;
}

// chain a worksite's links that join end to end with headings differing by < 60°: one chain is one continuous closure, not split in two because the street's bearing crosses 45°;
// links coming back the other way (the opposite carriageway) form their own chain. Without a road network the whole worksite is one chain (as before)
function chainsOf(rix, ws, toXY) {
  const ids = ws.links || [];
  const info = ids.map(id => {
    const L = rix?.links.get(id), P = L && roadPts(rix, L);
    return P ? { L, P, lp: P.map(toXY), h: heading(P.map(toXY)) } : null;
  });
  const up = ids.map((_, i) => i);
  const root = i => (up[i] === i ? i : (up[i] = root(up[i])));
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    const a = info[i], b = info[j];
    if (!a || !b) { if (!a && !b) up[root(j)] = root(i); continue; }
    const share = [a.L.from, a.L.to].some(n => n != null && (n === b.L.from || n === b.L.to));
    if (share && a.h[0] * b.h[0] + a.h[1] * b.h[1] >= 0.5) up[root(j)] = root(i);
  }
  return ids.map((id, i) => ({ id, chain: root(i), ...(info[i] || {}) }));
}

// → [{ key, ws, worksite, side, dir, road, lines: [works link polylines in XY], links: [walk link] }]; each footpath belongs to one stretch only
function closedStretches(ix, rix, worksites, toXY) {
  const groups = new Map(), taken = new Set();
  const group = (wi, ws, side, c, chains) => {
    const key = `${wi}:${side}:${c.chain}`;
    if (!groups.has(key)) {
      const first = chains.find(x => x.chain === c.chain);
      groups.set(key, {
        key, ws, worksite: ws.id ?? null, side, dir: first.h ? compass(first.h) : '?', road: first.L?.name ?? null,
        lines: chains.filter(x => x.chain === c.chain && x.lp).map(x => x.lp), links: [],
      });
    }
    return groups.get(key);
  };
  const add = (g, wl) => { if (taken.has(wl.id)) return; taken.add(wl.id); g.links.push(wl); };
  const want = fp => (fp === 'both' ? ['left', 'right'] : [fp]);
  const chainsAll = worksites.map(ws => chainsOf(rix, ws, toXY));
  // first the footpaths attached to the works links themselves (their side in the data is relative to the link's driving direction)
  worksites.forEach((ws, wi) => {
    const sides = want(footpathOf(ws)), chains = chainsAll[wi];
    for (const c of chains) {
      for (const wl of ix.byRoad.get(c.id) || []) if (CLOSABLE_KINDS.has(wl.kind) && sides.includes(wl.side)) add(group(wi, ws, wl.side, c, chains), wl);
    }
  });
  // then those on the opposite carriageway: its left = the works link's right and vice versa; only those running alongside the works link long enough
  if (rix) {
    const flip = { left: 'right', right: 'left' };
    worksites.forEach((ws, wi) => {
      const sides = want(footpathOf(ws)), chains = chainsAll[wi];
      for (const c of chains) {
        if (!c.P) continue;
        const total = lineLen(c.lp);
        for (const M of oppositeLinks(rix, c.L, c.P, toXY)) {
          for (const wl of ix.byRoad.get(M.id) || []) {
            const side = flip[wl.side];
            if (!side || !sides.includes(side) || !CLOSABLE_KINDS.has(wl.kind) || taken.has(wl.id)) continue;
            const g = walkPts(ix, wl).map(toXY);
            if (besideM(g, c.lp, total, OPP_LAT_M) >= Math.min(OVERLAP_MIN_M, 0.5 * lineLen(g))) add(group(wi, ws, side, c, chains), wl);
          }
        }
      }
    });
  }
  return [...groups.values()].filter(g => g.links.length);
}

// ---------- impact of one stretch ----------
function stretchImpact(ix, g, closedSet, volOf, methodOf, nameOf, toXY) {
  const ids = g.links.map(l => l.id);
  const nodes = [...new Set(g.links.flatMap(l => [l.a, l.b]))];
  // origin and destination: the two farthest-apart nodes that still reach the wider network while avoiding the closure.
  // Connected at one end only (the other is a dead end / island of a few nodes) = nobody walks through: dead_end, no detour and not blocked
  const cap = Math.max(2, Math.min(MIN_REACH, Math.floor(ix.nodes.size / 2)));
  const anchors = nodes.filter(n => reachesMain(ix, n, closedSet, cap));
  const pool = anchors.length >= 2 ? anchors : nodes;
  const pt = n => toXY([ix.nodes.get(n).lat, ix.nodes.get(n).lon]);
  let from = pool[0], to = pool[1] ?? pool[0], far = -1;
  for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) {
    const a = pt(pool[i]), b = pt(pool[j]), d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (d > far) { far = d; from = pool[i]; to = pool[j]; }
  }
  let top = null;
  for (const l of g.links) { const v = volOf(l.id); if (!top || v > top.v) top = { v, id: l.id }; }
  const ped_h = top ? top.v : 0;
  const measured = g.links.some(l => methodOf(l.id) === 'sensor');
  const closed_m = g.links.reduce((s, l) => s + l.len_m, 0);
  const dead_end = anchors.length < 2;
  const base = dijkstra(ix, from, to, null);
  const alt = dead_end ? null : dijkstra(ix, from, to, closedSet);
  const blocked = !dead_end && !alt;
  const detour_m = !alt || !base ? 0 : Math.max(0, alt.m - base.m);
  return {
    worksite: g.worksite, side: g.side, dir: g.dir, street: g.road,
    closed: ids, closed_m: r1(closed_m), from, to,
    ped_h, method: top ? methodOf(top.id) : null, measured,
    base_m: base ? r1(base.m) : null, path_m: alt ? r1(alt.m) : null, detour_m: r1(detour_m),
    extra_min: alt ? r1((ped_h * detour_m) / (WALK_MPS * 60)) : 0,
    crossings: alt ? countCrossings(alt.links, nameOf) : 0,
    base_crossings: base ? countCrossings(base.links, nameOf) : 0,
    blocked, dead_end, detour: alt ? alt.links.map(l => l.id) : [],
  };
}

// nearest real counter: one on a closed footpath first; otherwise ≤ 40 m from the closure and on the same side of the works link centreline
// (a counter on the footpath across the road counts different people and is not a measurement of this stretch); none = null
function nearestSensor(ix, peds, groups, closedSet, day, hour, toXY) {
  const lim = Number.isFinite(peds?.assumptions?.sensor_m) ? peds.assumptions.sensor_m : SENSOR_NEAR_M;
  const closed = groups.flatMap(g => g.links.map(l => ({ l, g, line: walkPts(ix, l).map(toXY) })));
  let best = null;
  for (const s of peds?.sensors || []) {
    if (!s.walk_link || !Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
    const v = peds.days?.[day]?.[s.walk_link]?.[hour];
    if (!Number.isFinite(v)) continue;
    const p = toXY([s.lat, s.lon]);
    let near = null;
    for (const c of closed) { const d = onLine(p, c.line)?.d ?? Infinity; if (!near || d < near.d) near = { d, c }; }
    if (!near) continue;
    const on = closedSet.has(s.walk_link);
    if (!on) {
      if (near.d > lim || !near.c.g.lines.length) continue;
      const own = ix.links.get(s.walk_link), sp = own ? midpoint(walkPts(ix, own).map(toXY)) : p;
      const want = sideOf(midpoint(near.c.line), near.c.g.lines);
      if (!want || sideOf(sp, near.c.g.lines) !== want) continue;
    }
    const cand = { on, d: near.d, name: s.name ?? String(s.id), ped_h: v, id: s.id ?? null };
    if (!best || (cand.on && !best.on) || (cand.on === best.on && cand.d < best.d)) best = cand;
  }
  return best && { name: best.name, ped_h: best.ped_h, id: best.id, dist_m: r1(best.d), on_closed: best.on };
}

// footpath closure declared in the plan (whether or not the works are active this hour): none / left / right / both
export function plannedFootpath(worksites) {
  const s = new Set();
  for (const ws of worksites || []) { const f = footpathOf(ws); if (f === 'both') { s.add('left'); s.add('right'); } else if (f !== 'none') s.add(f); }
  return s.size === 2 ? 'both' : s.size === 1 ? [...s][0] : 'none';
}

// is any worksite closing a footpath this hour (if not, the pedestrian impact is 0 and no footpath data is needed)
export function footpathActive(plan) {
  return (plan?.worksites || []).some(w => footpathOf(w) !== 'none' && plan?.when && isActive(w, plan.when));
}

// shape of summary.peds when walk / peds are not loaded
export function pedsUnavailable(plan) {
  return { src: null, footpath: plannedFootpath(plan?.worksites) };
}

export function pedImpact(walk, peds, plan, { net = null } = {}) {
  const all = plan?.worksites || [];
  const bad = all.flatMap(validateWorksite).filter(e => e.includes('footpath'));
  if (bad.length) throw new Error(bad.join('; ')); // a direct pedImpact call also rejects a malformed footpath (backend.run throws bad_plan via validatePlan before this)
  const when = plan.when;
  const day = dayType(when), hour = when.hour;
  const footpath = plannedFootpath(all);
  const ws = all.filter(w => footpathOf(w) !== 'none' && isActive(w, when));
  const out = {
    src: 'peds', footpath, active: ws.length > 0, day, hour,
    closed: [], closed_m: 0, ped_h: 0, detour_m: 0, extra_min: 0, crossings: 0, blocked: false, blocked_ped_h: 0,
    dead_end: false, unmatched: false, unmatched_sides: [], note: null, note_zh: null,
    step_free: null, measured: false, method: null, sensor: null, detour: [], stretches: [],
    assumed: { walk_mps: WALK_MPS, note: PEDS_NOTE, note_zh: PEDS_NOTE_ZH },
  };
  if (!ws.length) return out; // no footpath closed, or works inactive this hour → all zeros (no footpath data needed)
  const ix = indexWalk(walk);
  const rix = roadIndex(net);
  const firstPts = rix && ws.flatMap(w => w.links || []).map(id => rix.links.get(id)).filter(Boolean).map(l => roadPts(rix, l)).find(Boolean);
  const lat0 = firstPts ? firstPts[0][0] : (walk.nodes[0]?.lat ?? -37.81);
  const toXY = xy(111320 * Math.cos(lat0 * DEG));
  const groups = closedStretches(ix, rix, ws, toXY);
  // no footpath found in walk.json on a side to be closed: report unmatched so the page does not read it as "footpath open as usual"
  const want = fp => (fp === 'both' ? ['left', 'right'] : [fp]);
  out.unmatched_sides = ws.flatMap(w => want(footpathOf(w)).filter(sd => !groups.some(g => g.ws === w && g.side === sd)).map(sd => ({ worksite: w.id ?? null, side: sd })));
  out.unmatched = out.unmatched_sides.length > 0;
  const notes = [], notesZh = [];
  if (out.unmatched) { notes.push(UNMATCHED_NOTE); notesZh.push(UNMATCHED_NOTE_ZH); }
  const finish = () => { out.note = notes.length ? notes.join(' ') : null; out.note_zh = notesZh.length ? notesZh.join('') : null; return out; };
  if (!groups.length) return finish();
  const closedLinks = groups.flatMap(g => g.links);
  const closedSet = new Set(closedLinks.map(l => l.id));
  const volOf = id => { const v = peds?.days?.[day]?.[id]?.[hour]; return Number.isFinite(v) ? v : 0; };
  const methodOf = id => peds?.method?.[id] ?? null;
  const nameOf = l => (l.road_link && rix?.links.get(l.road_link)?.name) || null;
  const st = groups.map(g => stretchImpact(ix, g, closedSet, volOf, methodOf, nameOf, toXY));
  const open = st.filter(s => !s.blocked && !s.dead_end);
  const pedOpen = open.reduce((a, s) => a + s.ped_h, 0);
  const main = st.reduce((b, s) => (s.ped_h > b.ped_h ? s : b), st[0]);
  if (st.some(s => s.dead_end)) { notes.push(DEAD_END_NOTE); notesZh.push(DEAD_END_NOTE_ZH); }
  Object.assign(out, {
    closed: closedLinks.map(l => l.id),
    closed_m: r1(closedLinks.reduce((a, l) => a + l.len_m, 0)),
    ped_h: st.reduce((a, s) => a + s.ped_h, 0), // sum over stretches (sides): with both sides closed these are two different groups
    detour_m: pedOpen ? r1(open.reduce((a, s) => a + s.ped_h * s.detour_m, 0) / pedOpen) : open.length ? r1(Math.max(...open.map(s => s.detour_m))) : 0, // weighted by pedestrians
    extra_min: r1(open.reduce((a, s) => a + s.extra_min, 0)),
    crossings: open.length ? Math.max(...open.map(s => s.crossings)) : 0, // crossings on the worst stretch's detour
    blocked: st.some(s => s.blocked),
    blocked_ped_h: st.filter(s => s.blocked).reduce((a, s) => a + s.ped_h, 0),
    dead_end: st.some(s => s.dead_end),
    measured: st.some(s => s.measured),
    method: main.method,
    sensor: nearestSensor(ix, peds, groups, closedSet, day, hour, toXY),
    detour: [...new Set(open.flatMap(s => s.detour))],
    stretches: st,
  });
  return finish();
}
