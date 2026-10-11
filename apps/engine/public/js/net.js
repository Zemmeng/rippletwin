// net.js — network index, shortest paths and link travel time (BPR + deterministic queueing). Pure functions; imports directly in the browser and in Node.
// Usage: const net = loadNetwork(network); shortestPath(net, 'n0_8', 'n0_3', { banned });

export const BPR = { alpha: 0.15, beta: 4 }; // common parameters of the US Bureau of Public Roads (BPR) volume-delay function
export const PERIOD_S = 3600; // one-hour period
export const VEH_GAP_M = 7; // queue length per vehicle (vehicle length + gap)

export function loadNetwork(network) {
  if (!network || !Array.isArray(network.nodes) || !Array.isArray(network.links)) throw new Error('network must have nodes[] and links[]');
  const nodes = new Map(network.nodes.map(n => [n.id, n]));
  const links = new Map();
  const out = new Map(), inn = new Map();
  for (const l of network.links) {
    for (const k of ['id', 'from', 'to', 'len_m', 'lanes', 'speed_kmh', 'cap_vph', 't0_s']) {
      if (l[k] == null) throw new Error(`link ${l.id ?? '?'} is missing field ${k}`);
    }
    if (!('name' in l)) throw new Error(`link ${l.id} is missing field name (use null if unnamed)`);
    if (!nodes.has(l.from) || !nodes.has(l.to)) throw new Error(`link ${l.id} has an endpoint not in nodes`);
    links.set(l.id, l);
    if (!out.has(l.from)) out.set(l.from, []);
    out.get(l.from).push(l);
    if (!inn.has(l.to)) inn.set(l.to, []);
    inn.get(l.to).push(l);
  }
  for (const m of [out, inn]) for (const arr of m.values()) arr.sort((a, b) => (a.id < b.id ? -1 : 1)); // fixed traversal order → deterministic results
  return { nodes, links, out, inn, raw: network };
}

export function isNet(x) {
  return x && x.links instanceof Map && x.out instanceof Map;
}

// link direction: N / E / S / W (bearing from lat/lon)
export function bearing(net, link) {
  const a = net.nodes.get(link.from), b = net.nodes.get(link.to);
  const dy = b.lat - a.lat, dx = (b.lon - a.lon) * Math.cos((a.lat * Math.PI) / 180);
  const deg = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
  return ['N', 'E', 'S', 'W'][Math.round(deg / 90) % 4];
}

// cosine of the angle between two links' headings (to tell "continues along the same street")
export function headingDot(net, a, b) {
  const v = l => {
    const p = net.nodes.get(l.from), q = net.nodes.get(l.to);
    const x = (q.lon - p.lon) * Math.cos((p.lat * Math.PI) / 180), y = q.lat - p.lat, n = Math.hypot(x, y) || 1;
    return [x / n, y / n];
  };
  const [ax, ay] = v(a), [bx, by] = v(b);
  return ax * bx + ay * by;
}

// Deterministic queueing (D/D/1): arrivals v and discharge c over one hour, the queue grows linearly; a vehicle arriving at time t waits (v−c)t/c,
// so vehicles arriving this hour wait (v−c)·T/(2c) s on average (including the clearance time of those still queued at the end of the hour)
export function queueDelayS(v, c, T = PERIOD_S) {
  return v > c && c > 0 ? ((v - c) * T) / (2 * c) : 0;
}
export function queueVeh(v, c, T = PERIOD_S) {
  return v > c ? ((v - c) * T) / 3600 : 0;
}

// link travel time (s): BPR below capacity; the over-capacity part adds deterministic queueing delay
export function linkTime(t0, v, c) {
  if (!(c > 0)) return v > 0 ? Infinity : t0;
  const x = v / c;
  return t0 * (1 + BPR.alpha * Math.pow(Math.min(x, 1), BPR.beta)) + queueDelayS(v, c);
}

// min-heap (compares [cost, insertion order]; FIFO on ties → deterministic results)
class Heap {
  constructor() { this.a = []; this.n = 0; }
  push(cost, item) { this.a.push([cost, this.n++, item]); this.up(this.a.length - 1); }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) { a[0] = last; this.down(0); }
    return top;
  }
  get size() { return this.a.length; }
  less(i, j) { const x = this.a[i], y = this.a[j]; return x[0] < y[0] || (x[0] === y[0] && x[1] < y[1]); }
  up(i) { while (i > 0) { const p = (i - 1) >> 1; if (!this.less(i, p)) break; [this.a[i], this.a[p]] = [this.a[p], this.a[i]]; i = p; } }
  down(i) {
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < this.a.length && this.less(l, m)) m = l;
      if (r < this.a.length && this.less(r, m)) m = r;
      if (m === i) break;
      [this.a[i], this.a[m]] = [this.a[m], this.a[i]];
      i = m;
    }
  }
}

// Dijkstra. cost(link) defaults to t0_s; banned = set of link ids that may not be used; bannedNodes = nodes that may not be passed
export function shortestPath(net, from, to, { cost = l => l.t0_s, banned = new Set(), bannedNodes = new Set(), linkOk = () => true } = {}) {
  if (from === to) return { links: [], cost: 0 };
  const dist = new Map([[from, 0]]), prev = new Map();
  const h = new Heap();
  h.push(0, from);
  while (h.size) {
    const [d, , u] = h.pop();
    if (d > (dist.get(u) ?? Infinity)) continue;
    if (u === to) break;
    for (const l of net.out.get(u) || []) {
      if (banned.has(l.id) || (bannedNodes.has(l.to) && l.to !== to) || !linkOk(l)) continue;
      const c = cost(l);
      if (!Number.isFinite(c)) continue;
      const nd = d + c;
      if (nd < (dist.get(l.to) ?? Infinity)) { dist.set(l.to, nd); prev.set(l.to, l); h.push(nd, l.to); }
    }
  }
  if (!dist.has(to)) return null;
  const links = [];
  for (let n = to; n !== from; ) { const l = prev.get(n); links.push(l.id); n = l.from; }
  links.reverse();
  return { links, cost: dist.get(to) };
}

// Single-source Dijkstra: from `from` to every reachable node (used by transit.js for bus detours and route gap filling). Same options as shortestPath;
// nodes in bannedNodes are never entered; maxCost = stop expanding beyond this cost. → { dist: node → cost, prev: node → incoming link }
export function dijkstra(net, from, { cost = l => l.t0_s, banned = new Set(), bannedNodes = new Set(), linkOk = () => true, maxCost = Infinity } = {}) {
  const dist = new Map([[from, 0]]), prev = new Map();
  const h = new Heap();
  h.push(0, from);
  while (h.size) {
    const [d, , u] = h.pop();
    if (d > (dist.get(u) ?? Infinity)) continue;
    for (const l of net.out.get(u) || []) {
      if (banned.has(l.id) || bannedNodes.has(l.to) || !linkOk(l)) continue;
      const c = cost(l);
      if (!Number.isFinite(c)) continue;
      const nd = d + c;
      if (nd > maxCost) continue;
      if (nd < (dist.get(l.to) ?? Infinity)) { dist.set(l.to, nd); prev.set(l.to, l); h.push(nd, l.to); }
    }
  }
  return { dist, prev };
}

// dijkstra() result → list of link ids from `from` to `to` (null if unreachable)
export function treePath(tree, from, to) {
  if (!tree.dist.has(to)) return null;
  const links = [];
  for (let n = to; n !== from; ) { const l = tree.prev.get(n); links.push(l.id); n = l.from; }
  return links.reverse();
}

export function pathTime(net, ids, time = l => l.t0_s) {
  let s = 0;
  for (const id of ids) s += time(net.links.get(id));
  return s;
}
