// routes.js — step 1: find the affected vehicles and the roads they could take instead (with their usual travel times). Pure functions.
// Method: chain the works links in driving direction into one approach; walk about UP_M metres upstream along the same street for the origin and about DOWN_M downstream for the destination
// (real links are split at every OSM node and are often only 10–20 m long, so walk by distance, not by link count).
// The origin → destination path through the works is the stay route. Detours = turn off at each junction before the works, then take the shortest path to the destination;
// each is named after the street it turns into ("Russell St" = turn into Russell St); only the fastest per name is kept, at most MAX_ALTS.
// Affected vehicles = this hour's flow on the first works link (veh/h).

import { bearing, headingDot, shortestPath, pathTime } from './net.js';
import { dayType } from './worksite.js';

export const UP_M = 400; // how far upstream to start (signs are usually within this range)
export const DOWN_M = 300;
const MAX_WALK = 80; // safety cap by link count: stop if the walk does not finish
export const MAX_ALTS = 3;
export const MAX_RATIO = 3; // detours more than 3× slower than the usual stay route are dropped
// Roads detours never use (OSM highway): CBD laneways (living_street such as Heffernan Lane, pedestrian-priority, with capacities set too high in the network data) and similar.
// They still count if the stay route uses them; they are just never offered as detours, so a sign never names a laneway
export const NO_DETOUR = new Set(['living_street', 'pedestrian', 'service', 'track', 'footway', 'cycleway', 'path']);
const noDetourCache = new WeakMap();
function noDetourLinks(net) {
  if (!noDetourCache.has(net)) noDetourCache.set(net, new Set([...net.links.values()].filter(l => NO_DETOUR.has(l.highway)).map(l => l.id)));
  return noDetourCache.get(net);
}

// same street: same name (unnamed links only chain with unnamed ones) and nearly the same heading
const same = (a, b) => (a.name ?? null) === (b.name ?? null);
function sameStreetNext(net, link) {
  const c = (net.out.get(link.to) || []).filter(l => same(l, link) && l.to !== link.from && headingDot(net, link, l) > 0.7);
  return c.sort((a, b) => headingDot(net, link, b) - headingDot(net, link, a))[0] || null;
}
function sameStreetPrev(net, link) {
  const c = (net.inn.get(link.from) || []).filter(l => same(l, link) && l.from !== link.to && headingDot(net, l, link) > 0.7);
  return c.sort((a, b) => headingDot(net, b, link) - headingDot(net, a, link))[0] || null;
}

// works links → approaches (consecutive works links in one direction form one approach; works in both directions give two)
export function approaches(net, ws) {
  const set = new Set((ws.links || []).filter(id => net.links.has(id)));
  const out = [];
  for (const id of set) {
    const entry = net.links.get(id);
    const p = sameStreetPrev(net, entry);
    if (p && set.has(p.id)) continue; // not the first link of this approach
    const chain = [entry];
    for (let n = sameStreetNext(net, entry); n && set.has(n.id) && !chain.includes(n); n = sameStreetNext(net, n)) chain.push(n);
    const up = [];
    let upM = 0;
    for (let u = sameStreetPrev(net, entry); u && upM < UP_M && up.length < MAX_WALK && !set.has(u.id) && !up.includes(u); u = sameStreetPrev(net, u)) { up.unshift(u); upM += u.len_m; }
    const down = [];
    let downM = 0;
    for (let d = sameStreetNext(net, chain[chain.length - 1]); d && downM < DOWN_M && down.length < MAX_WALK && !set.has(d.id) && !down.includes(d); d = sameStreetNext(net, d)) { down.push(d); downM += d.len_m; }
    out.push({ entry, chain, up, down });
  }
  return out.sort((a, b) => (a.entry.id < b.entry.id ? -1 : 1));
}

function crossName(net, node, street) {
  const ls = [...(net.out.get(node) || []), ...(net.inn.get(node) || [])].filter(l => l.name && l.name !== street);
  return ls.length ? ls.sort((a, b) => (a.name < b.name ? -1 : 1))[0].name : street || 'Unnamed road';
}

const truckOk = (net, ids) => ids.every(id => net.links.get(id).truck !== false);

// factors = capFactors(all active worksites): fully closed links are off limits to everyone
export function affected(net, flows, ws, when, factors = new Map()) {
  const dt = dayType(when);
  const closedAll = new Set([...factors].filter(([, x]) => x.f === 0).map(([id]) => id));
  const res = [];
  for (const { entry, chain, up, down } of approaches(net, ws)) {
    const stayLinks = [...up, ...chain, ...down].map(l => l.id);
    const origin = (up[0] || entry).from;
    const dest = (down[down.length - 1] || chain[chain.length - 1]).to;
    const street = entry.name || 'Unnamed road';
    const banned = new Set([...closedAll, ...(ws.links || []), ...noDetourLinks(net)]);
    const prefixNodes = [origin, ...up.map(l => l.to)]; // junctions before the works where a vehicle can turn off; the last one = the works start
    const prefixSet = new Set(prefixNodes);
    const stayT = pathTime(net, stayLinks);
    const best = new Map();
    prefixNodes.forEach((u, k) => {
      const diverge_m = up.slice(k).reduce((s, l) => s + l.len_m, 0);
      for (const l of net.out.get(u) || []) {
        if (l.id === stayLinks[k] || banned.has(l.id)) continue;
        if (k > 0 && l.to === prefixNodes[k - 1]) continue; // U-turn
        if (prefixSet.has(l.to)) continue;
        const rest = shortestPath(net, l.to, dest, { banned, bannedNodes: prefixSet });
        if (!rest) continue;
        const links = [...stayLinks.slice(0, k), l.id, ...rest.links];
        const t = pathTime(net, links);
        if (t > MAX_RATIO * stayT) continue;
        // name after the street turned into; if that is unnamed, use the first named road along the way that is not this street
        const named = [l.id, ...rest.links].map(id => net.links.get(id).name).find(n => n && n !== street);
        const name = named || `${street || 'Unnamed road'} (${bearing(net, l)})`;
        const prev = best.get(name);
        if (!prev || t < prev.t) best.set(name, { name, links, t, diverge_m });
      }
    });
    const alts = [...best.values()].sort((a, b) => a.t - b.t || (a.name < b.name ? -1 : 1)).slice(0, MAX_ALTS)
      .map((r, i) => ({ id: 'r' + (i + 1), name: r.name, links: r.links, usual_min: r.t / 60, truck: truckOk(net, r.links), diverge_m: r.diverge_m }));
    const blocked = factors.get(entry.id)?.f === 0;
    res.push({
      ws: ws.id,
      entry: entry.id,
      chain: chain.map(l => l.id),
      street,
      dir: bearing(net, entry),
      kmh: entry.speed_kmh,
      to: crossName(net, dest, street),
      volume: flows?.days?.[dt]?.[entry.id]?.[when.hour] ?? 0,
      blocked,
      stayLinks,
      stay: blocked ? null : { id: 'stay', name: street, links: stayLinks, usual_min: stayT / 60, truck: truckOk(net, stayLinks), diverge_m: null },
      alts,
    });
  }
  return res;
}
