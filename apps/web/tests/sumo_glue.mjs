// SUMO replay on the real network (src/js/4c-sumo.js): a v2-format replay built in memory (cars along Lonsdale St
// westbound through the works link, a bus, two signal heads, two chunks) drives SumoReplay through the surface the page
// draws from (all / agents, signalHeads, works, stats, minute, clock, loop, wait-for-chunk). When the baked copy exists
// (apps/sumo/public/real/index.json) its files are checked too: format, chunk sizes and sha256, the 16 junctions' signal
// heads, headings along the direction of travel and axis-aligned with the Hoddle grid. Harsh braking marks and the
// timeline from the 1 s samples (a second in-memory replay; on the baked copy, recounted straight from the samples).
// The whole hour 08:00–09:00 (a third in-memory replay: 2 s samples, 3 chunks of 20 minutes, a baseline without chunks) —
// loading as the page does (want()), holding at a chunk not in yet, the clock, 10-minute bars, the end of the hour, dropping
// chunks over the memory budget and asking for them again.
// Called by tests/test_sumo_wire.py; one ✅ / ❌ line per assertion, no network access.
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WEB = HERE + '../', APPS = WEB + '../';
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log('✅ ' + msg); } else { fail++; console.log('❌ ' + msg); } };

const block = (file, tag) => readFileSync(WEB + 'src/js/' + file, 'utf8').match(new RegExp(`/\\* ${tag}:begin[^\\n]*\\n([\\s\\S]*?)/\\* ${tag}:end \\*/`))[1];
const stubs = `const clamp=(v,a,b)=>v<a?a:v>b?b:v;
function rng(seed){let a=seed>>>0;return()=>{a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
const WXP={clear:{v:1,T:1,b:1,ped:1,bike:1,wob:0,rate:1}};
const WORLD={x0:-320,x1:320,y0:-300,y1:300};const RISK_CELL=4,RNX=(WORLD.x1-WORLD.x0)/RISK_CELL,RNY=(WORLD.y1-WORLD.y0)/RISK_CELL;`;
const ctx = {}; vm.createContext(ctx);
vm.runInContext(stubs + '\n' + block('6-engine.js', 'pure') + '\n' + block('4b-grid.js', 'grid') + '\n' + block('4c-sumo.js', 'sumo') +
  '\n;globalThis.X={geoToWorld,gridSpec,GridSim,GRID_K,GRID_P,GRID_VIEW,gridIn,SumoReplay,SUMO_LINK,sumoHeadState};', ctx);
const X = ctx.X;
const net = JSON.parse(readFileSync(APPS + 'roads/public/cbd/network.json', 'utf8'));
const flows = JSON.parse(readFileSync(APPS + 'roads/public/cbd/flows.json', 'utf8'));
const spec = X.gridSpec(net.links, flows, 8, { link: X.SUMO_LINK, lanes: 1 });
const polys = new X.GridSim(spec, { seed: 1 }).works().polys;
const works = net.links.find(l => l.id === X.SUMO_LINK);
ok(works && works.name === 'Lonsdale Street' && spec.close && polys.length === 1, 'the SUMO demo link is the Lonsdale St works link the grid sim closes (1 lane polygon)');

// ---- fixture: contract v2 replay in memory -------------------------------------------------------------------------------
// a line along the works link (east → west), metres ↔ lat / lon; SUMO angle of travel from the bearing
const [a, b] = works.geometry, mLat = 111320, mLon = 111320 * Math.cos(a[0] * Math.PI / 180);
const dN = (b[0] - a[0]) * mLat, dE = (b[1] - a[1]) * mLon, L0 = Math.hypot(dN, dE), uN = dN / L0, uE = dE / L0;
const ANG = ((Math.atan2(uE, uN) * 180 / Math.PI) + 360) % 360; // 0 = north, clockwise
const at = s => [a[0] + uN * s / mLat, a[1] + uE * s / mLon]; // s metres past the east end of the works link (negative = upstream)
const DUR = 120, CL0 = 180;
const AG = [{ id: 'c0', type: 'car', length_m: 5, width_m: 1.8 }, { id: 'c1', type: 'car', length_m: 5, width_m: 1.8 }, { id: 'c2', type: 'car', length_m: 5, width_m: 1.8 },
  { id: 'c3', type: 'car', length_m: 5, width_m: 1.8 }, { id: 'b0', type: 'bus', length_m: 12, width_m: 2.5 }];
// car 0 stops at the works from t 30; car 4 (bus) leaves the map at t 50; the rest drive 8 m/s westbound
const posOf = (i, t) => { if (i === 4 && t >= 50) return null; const v = i === 0 && t >= 30 ? 0 : 8, s0 = -40 * i - 60; return { s: i === 0 ? s0 + 8 * Math.min(t, 30) : s0 + 8 * t, v }; };
const tlsAt = t => t < 30 ? 'GGr' : t < 33 ? 'yyr' : 'rrG';
const frame = t => ({ t, a: AG.map((_, i) => { const p = posOf(i, t); if (!p) return null; const [lat, lon] = at(p.s); return [i, Math.round(lon * 1e6), Math.round(lat * 1e6), ANG, Math.round(p.v * 100)]; }).filter(Boolean),
  tls: { J1: tlsAt(t), J2: tlsAt(t) }, q: t * 0.5 });
const chunks = [0, 60].map(s0 => ({ frames: Array.from({ length: 60 }, (_, k) => frame(s0 + k)) }));
const [hLat, hLon] = at(-10);
const MAN = { version: 2, network: 'real', scenario: 'original', duration_s: DUR, sample_s: 1, clock0_s: CL0, agent_columns: ['i', 'lon_e6', 'lat_e6', 'angle_deg', 'speed_cms'], agents: AG,
  signal_heads: [{ id: 'h1', tls: 'J1', idx: [0, 1], lon_e6: Math.round(hLon * 1e6), lat_e6: Math.round(hLat * 1e6) }, { id: 'h2', tls: 'J2', idx: [2], lon_e6: Math.round(hLon * 1e6), lat_e6: Math.round(hLat * 1e6) }],
  chunks: [{ file: 'frames-000.json', start: 0, end: 60 }, { file: 'frames-001.json', start: 60, end: 120 }],
  metrics: { vehicles: 5, completed: 1, teleports: 0, collisions: 0, mean_timeloss_s: 20, mean_extra_s: 12.5, works_queue_max_m: 60, works_queue_mean_m: 30, detour_vehicles: 7 },
  per_minute: { halting: [1, 2], harsh: [2, 3] } };
const IDX = { version: 2, network: 'real', engine: 'Eclipse SUMO sumo 1.27.1', seed: 42, hour: 8, works: { link: X.SUMO_LINK, lanes_closed: 1 },
  scenarios: [{ id: 'original', label: { en: 'Original', zh: '原方案' }, diversion_share: 0.14, manifest: 'original/manifest.json', metrics: { mean_extra_s: 12.5 } }] };
const pg = (i, t) => { const p = posOf(i, t); const [lat, lon] = at(p.s); return X.geoToWorld(Math.round(lat * 1e6) / 1e6, Math.round(lon * 1e6) / 1e6); };
const near = (u, v, e = 1e-3) => Math.abs(u - v) <= e;

const R = new X.SumoReplay(IDX, 'original', MAN, { spec, polys, src: { source: 'baked' } });
ok(R.isGrid === true && R.isSumo === true && R.critical === null && Array.isArray(R.events) && R.minute.length === 60 && R.risk.length === 160 * 150 && 'riskVer' in R && R.spec === spec,
  'SumoReplay wears the GridSim surface: isGrid, isSumo, critical, events, minute, risk, riskVer, spec');
R.step(1); ok(!R.ready && R.t === 0 && R.all.length === 0, 'no chunk yet: not ready, step() does nothing');
R.addChunk(0, chunks[0]);
ok(R.ready && R.nLoaded === 60 && R.all.length === 5 && R.agents === R.all, `first chunk in: ready, ${R.all.length} vehicles at t 0, agents === all (what the page draws and counts)`);
R.step(0.5);
{ const c = R.all.find(o => o.id === 'c1'), p0 = pg(1, 0), p1 = pg(1, 1);
  ok(c && near(c.x, (p0[0] + p1[0]) / 2) && near(c.y, (p0[1] + p1[1]) / 2), `t 0.5: positions linear between the 1 s samples (${c && c.x.toFixed(2)}, ${c && c.y.toFixed(2)})`);
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1], n = Math.hypot(dx, dy);
  ok(c && near(Math.hypot(c.hx, c.hy), 1) && (c.hx * dx + c.hy * dy) / n > 0.999, `heading from SUMO's angle (${ANG.toFixed(1)}°, 0 = north, clockwise) points along the travel on the page: (${c.hx.toFixed(3)}, ${c.hy.toFixed(3)})`);
  ok(c && near(c.v, 8 * X.GRID_K, 1e-3) && c.kind === 'veh' && c.type === 'car' && near(c.len, 5 * X.GRID_K) && near(c.wid, 1.8 * X.GRID_K) && c.tag === null && c.blocked === false && Array.isArray(c.trail),
    'cars: kind veh, type car, v / len / wid in page units (× GRID_K), tag null, blocked false, trail');
  const bus = R.all.find(o => o.id === 'b0');
  ok(bus && bus.type === 'bus' && near(bus.len, 12 * X.GRID_K), 'the bus keeps type bus and its 12 m length');
}
// on the page the fixture cars drive through the grid sim's closed-lane polygon (same projection as the grid)
{ const P = polys[0], cx = P.reduce((s, p) => s + p[0], 0) / 4, cy = P.reduce((s, p) => s + p[1], 0) / 4, [lat, lon] = at(L0 / 2), q = X.geoToWorld(lat, lon);
  ok(Math.hypot(q[0] - cx, q[1] - cy) < 8, `the works link's midpoint lands on the grid sim's closure polygon (${Math.hypot(q[0] - cx, q[1] - cy).toFixed(1)} units)`); }
{ const H = R.signalHeads();
  ok(H.length === 2 && H[0].state === 'G' && H[1].state === 'R' && H.every(h => h.shown === true && isFinite(h.x) && isFinite(h.y)), `signal heads: G for idx 0–1 of "GGr", R for idx 2 (${H.map(h => h.state).join(' ')})`); }
R.step(30.7); // t 31.2
ok(R.signalHeads()[0].state === 'A', 'amber while its links show y');
ok(near(R.works().queue_m, 31.2 * 0.5, 1e-3) && R.works().polys === polys, `works(): queue from the frames' q, linear (${R.works().queue_m.toFixed(2)} m), closure polygon passed through`);
R.step(10); ok(R.signalHeads()[0].state === 'R' && R.signalHeads()[1].state === 'G', 'red / green after the switch');
{ const c0 = R.all.find(o => o.id === 'c0'); ok(c0 && c0.v === 0 && c0.acc === 0, 'car 0 stands at the works (v 0)'); }
ok(R.stats.harsh === 1 && R.minute[3] === 1 && R.minute.reduce((s, v) => s + v, 0) === 1 && R.stats.conflicts === null && R.stats.critical === null,
  `stats: harsh = braking episodes found in the samples so far, 2×2 only (car 0 stopping at the works, 8 m/s² → ${R.stats.harsh}), minute[] at 08:03 (clock0 ${CL0} s); conflicts / critical null — not computed, never 0`);
ok(near(R.clock(), CL0 + R.t), `clock() = clock0_s + t (${R.clock().toFixed(1)} s past 08:00)`);
R.step(100); ok(R.t === 59 && R.all.length === 4, `second chunk not in yet: holds at the last loaded sample (t ${R.t}), no loop; the bus has left`);
R.addChunk(1, chunks[1]); ok(R.complete && R.nLoaded === 120, 'second chunk in: complete');
R.step(3); ok(near(R.t, 62) && R.stats.harsh === 1 && R.minute[4] === 0, `plays on into it (t ${R.t}), nobody else brakes: harsh ${R.stats.harsh}`);
R.step(60); ok(R.t < 10 && R.stats.harsh === 0 && R.events.length === 0 && R.all.every(c => c.trail.length <= 4), `loops at the end (t ${R.t.toFixed(1)}), stats, marks and trails start again`);
R.seek(40); ok(R.t === 40 && R.all.every(c => c.trail.length <= 2) && R.stats.harsh === 1 && R.events.length === 1, 'seek(t) jumps there (histogram click), with the counts and marks of that moment');
ok(R.metrics.mean_extra_s === 12.5 && R.metrics.detour_vehicles === 7, 'metrics: manifest metrics over the index entry');
{ const [p, q] = [at(0), at(L0)], M2 = Object.assign({}, MAN, { works: { link: X.SUMO_LINK, lane_shape_e6: [[Math.round(p[1] * 1e6), Math.round(p[0] * 1e6)], [Math.round(q[1] * 1e6), Math.round(q[0] * 1e6)]] } });
  const P = new X.SumoReplay(IDX, 'original', M2, { spec, polys }).works().polys, c = P[0] && P[0].reduce((s, v) => [s[0] + v[0] / P[0].length, s[1] + v[1] / P[0].length], [0, 0]), [lat, lon] = at(L0 / 2), m = X.geoToWorld(lat, lon);
  ok(P.length === 1 && P[0].length === 4 && Math.hypot(c[0] - m[0], c[1] - m[1]) < 0.5 && P !== polys, `manifest works.lane_shape_e6 → the closure polygon is the lane SUMO closed (centroid ${Math.hypot(c[0] - m[0], c[1] - m[1]).toFixed(2)} units off its centre line)`); }
{ const B = new X.SumoReplay(IDX, 'baseline', MAN, { spec, polys }); ok(B.works().polys.length === 0 && B.src.source === 'baked', 'baseline has no works polygon; default source is baked, never live'); }
{ const O = new X.SumoReplay(IDX, 'original', MAN, { spec, polys }); O.addChunk(1, chunks[1]); const r1 = O.ready; O.addChunk(0, chunks[0]);
  ok(!r1 && O.nLoaded === 120 && O.complete, 'chunks may arrive out of order: playable only from t 0, complete once both are in'); }
ok(X.sumoHeadState('rrgr', [0, 2]) === 'G' && X.sumoHeadState('rYr', [1]) === 'A' && X.sumoHeadState('rrr', [0]) === 'R' && X.sumoHeadState(undefined, [0]) === 'R',
  'head colour: any G/g → green, else any y/Y → amber, else red');
let threw = false; try { new X.SumoReplay(IDX, 'original', { agents: 1 }, {}); } catch (e) { threw = true; }
ok(threw, 'reverse: a malformed manifest throws (the page then keeps the grid sim)');

// ---- Harsh braking marks and the timeline from the 1 s samples ----------------------------------------------------------
// Four cars on Lonsdale St westbound, 3 minutes (3 chunks): "in" brakes 10 → 5 → 0 m/s (5 m/s², one episode) at t 10 inside the
// 2×2, pulls away at t 41 and brakes again at t 49 (second episode, same car); "out" drives the same speeds 500 m further east,
// outside GRID_VIEW; "mild" slows 8 → 5 m/s (3 m/s², under the 3.5 threshold) inside it; "late" appears at t 125 east of the
// 2×2, drives in at t 136 (08:05:16) and brakes 10 → 4 m/s at t 150.
{
  const V = X.GRID_VIEW, inV = p => X.gridIn(V, p[0], p[1]);
  const vIn = t => t <= 10 ? 10 : t === 11 ? 5 : t <= 40 ? 0 : t <= 49 ? 10 : 5;
  const SP = { in: [vIn, -60, 0, 60], out: [vIn, -560, 0, 60], mild: [t => t <= 30 ? 8 : 5, -100, 0, 50], late: [t => t <= 150 ? 10 : 4, -295, 125, 179] };
  const ids = Object.keys(SP), sOf = {};
  for (const k of ids) { const [v, s0, t0, t1] = SP[k], s = {}; s[t0] = s0; for (let t = t0 + 1; t <= t1; t++) s[t] = s[t - 1] + (v(t - 1) + v(t)) / 2; sOf[k] = s; }
  const geo = (k, t) => at(sOf[k][t]), page = (k, t) => { const [lat, lon] = geo(k, t); return X.geoToWorld(Math.round(lat * 1e6) / 1e6, Math.round(lon * 1e6) / 1e6); };
  const fr2 = t => ({ t, a: ids.map((k, i) => { const [v, , t0, t1] = SP[k]; if (t < t0 || t > t1) return null; const [lat, lon] = geo(k, t); return [i, Math.round(lon * 1e6), Math.round(lat * 1e6), ANG, Math.round(v(t) * 100)]; }).filter(Boolean), tls: {}, q: 0 });
  const ch2 = [0, 60, 120].map(s0 => ({ frames: Array.from({ length: 60 }, (_, k) => fr2(s0 + k)) }));
  const M2 = Object.assign({}, MAN, { duration_s: 180, agents: ids.map(id => ({ id, type: 'car', length_m: 4.6, width_m: 1.8 })),
    chunks: ch2.map((_, k) => ({ file: `frames-00${k}.json`, start: 60 * k, end: 60 * k + 59 })), per_minute: { halting: [0, 0, 0], harsh: [9, 9, 9] } });
  ok(inV(page('in', 10)) && inV(page('in', 49)) && inV(page('mild', 30)) && inV(page('late', 150)) && !inV(page('late', 135)) && inV(page('late', 136))
    && ids.every(k => k === 'out' || k === 'late' || inV(page(k, SP[k][2]))) && Array.from({ length: 61 }, (_, t) => page('out', t)).every(p => !inV(p)),
    'fixture: "in" / "mild" drive inside GRID_VIEW, "out" never enters it, "late" enters it at t 136');
  const R2 = new X.SumoReplay(IDX, 'original', M2, { spec, polys });
  let scans = 0; const scan0 = R2._harsh; R2._harsh = function (n) { scans++; return scan0.call(this, n); };
  ch2.forEach((c, k) => R2.addChunk(k, c));
  ok(scans === 3 && R2.nScan === 180 && R2.evAll.length === 3, `found while the chunks are added (${scans} scans, one per chunk, ${R2.evAll.length} events in all)`);
  for (let i = 0; i < 400; i++) R2.step(0.45);
  ok(scans === 3, 'playing (400 steps, one loop) scans nothing again — step() only moves pointers');
  R2.seek(179);
  const E = R2.evAll, e0 = E[0], p10 = page('in', 10);
  ok(E.every(e => e.kind === 'harsh' && e.sev === 0 && e.type === 'car' && inV([e.x, e.y])) && E.map(e => e.t).join() === '10,49,150',
    `three harsh braking events, all in GRID_VIEW, at t ${E.map(e => e.t).join(' / ')} ("in" twice: two episodes; "out" outside, "mild" under 3.5 m/s² — none)`);
  ok(e0 && near(e0.x, p10[0], 1e-3) && near(e0.y, p10[1], 1e-3), `the mark sits where the drop starts (the t 10 sample of "in": ${e0 && e0.x.toFixed(1)}, ${e0 && e0.y.toFixed(1)})`);
  { const gs = new X.GridSim(spec, { seed: 4218 }); while (gs.t < 400 && !gs.events.some(e => e.kind === 'harsh')) gs.step(0.25);
    const g = gs.events.find(e => e.kind === 'harsh'), keys = o => Object.keys(o).sort().join();
    ok(g && keys(g) === keys(e0) && typeof e0.t === 'number' && typeof e0.x === 'number', `same event shape as the grid sim's harsh braking (${e0 && keys(e0)}), so drawEvents draws it unchanged`); }
  ok(R2.stats.harsh === 3 && R2.stats.conflicts === null && R2.stats.critical === null && R2.events.length === 1 && R2.events[0].t === 150,
    `at t 179 harsh ${R2.stats.harsh}; marks older than 2 minutes dropped (${R2.events.length} kept), the count keeps them; conflicts / critical null`);
  const sum = a => Array.from(a).reduce((x, y) => x + y, 0);
  ok(R2.mSeen[3] === 2 && R2.mHit[3] === 1 && R2.mSeen[5] === 1 && R2.mHit[5] === 1 && sum(R2.mSeen) === 3 && sum(R2.mHit) === 2,
    `timeline: vehicles into GRID_VIEW per entry minute — 08:03 ${R2.mSeen[3]} (of them braked ${R2.mHit[3]}: "in" once, although twice), 08:05 ${R2.mSeen[5]} / ${R2.mHit[5]} ("late"); "out" not counted`);
  ok(R2.bins && R2.bins.m0 === 3 && R2.bins.n === 2, `2-minute bars from the replay's first minute (08:0${R2.bins && R2.bins.m0}), on the hour axis of the page clock`);
  R2.seek(100); ok(R2.stats.harsh === 2 && R2.mSeen[5] === 0 && R2.events.length === 2, 'seek back to t 100 → counts and marks of that moment ("late" not there yet)');
  R2.seek(140); ok(R2.mSeen[5] === 1 && R2.mHit[5] === 0, 't 140 — "late" has entered, not braked yet: the bar fills as the replay plays');
  R2.seek(150); ok(R2.mHit[5] === 1 && R2.stats.harsh === 3 && R2.events[R2.events.length - 1].t === 150, 't 150 — its braking counts and its mark appears as it brakes');
  { const O = new X.SumoReplay(IDX, 'original', M2, { spec, polys }); O.addChunk(2, ch2[2]); O.addChunk(1, ch2[1]); const n1 = O.evAll.length; O.addChunk(0, ch2[0]);
    ok(n1 === 0 && O.evAll.map(e => `${e.t}:${e.x}:${e.y}`).join() === E.map(e => `${e.t}:${e.x}:${e.y}`).join(), 'chunks out of order → scanned once they join up from t 0, same events'); }
}


// ---- The whole hour — 2 s samples, 3 chunks of 20 minutes, loaded the way the page does ------------------------------
// "v0" / "v1" / "v2" drive in at 08:01:40 / 08:25:00 / 08:55:00 and brake 10 → 0 m/s between two samples (5 m/s² over 2 s)
// 10 s later inside the 2×2; "v3" drives in at 08:21:40 and does not brake; "park" stands 200 m upstream (outside the 2×2) all hour
{
  const V = X.GRID_VIEW, inV = p => X.gridIn(V, p[0], p[1]), DT = 2;
  const VH = { v0: 100, v1: 1500, v2: 3300, v3: 1300 }, ids = ['v0', 'v1', 'v2', 'v3', 'park'];
  const vAt = (k, t) => { if (k === 'park') return 0; const u = t - VH[k]; return k !== 'v3' && u > 10 ? 0 : 10; };
  const sAt = (k, t) => { if (k === 'park') return -200; const u = t - VH[k]; return -60 + 10 * Math.min(u, k === 'v3' ? u : 10); };
  const alive = (k, t) => k === 'park' || (t >= VH[k] && t <= VH[k] + 60);
  const fr = t => ({ t, a: ids.map((k, i) => { if (!alive(k, t)) return null; const [lat, lon] = at(sAt(k, t)); return [i, Math.round(lon * 1e6), Math.round(lat * 1e6), ANG, Math.round(vAt(k, t) * 100)]; }).filter(Boolean), tls: { J1: tlsAt(t % 60) }, q: t / 10 });
  const pg3 = (k, t) => { const [lat, lon] = at(sAt(k, t)); return X.geoToWorld(Math.round(lat * 1e6) / 1e6, Math.round(lon * 1e6) / 1e6); };
  ok(inV(pg3('v0', 100)) && inV(pg3('v0', 110)) && !inV(pg3('park', 0)), 'fixture: the drivers are inside GRID_VIEW when they brake, "park" stands outside it');
  const CH = [0, 1200, 2400].map(s0 => ({ frames: Array.from({ length: 600 }, (_, j) => fr(s0 + DT * j)) }));
  const MH = Object.assign({}, MAN, { duration_s: 3600, sample_s: DT, clock0_s: 0, agents: ids.map(id => ({ id, type: 'car', length_m: 4.6, width_m: 1.8 })),
    chunks: CH.map((c, k) => ({ file: `frames-00${k}.json`, start: 1200 * k, end: 1200 * k + 1198 })), per_minute: undefined });
  const IH = Object.assign({}, IDX, { params: { hour_window: [8, 9], green_2935: 0.5, network_extent: 'test', sim_s: 3600 } });
  const R3 = new X.SumoReplay(IH, 'original', MH, { spec, polys });
  ok(R3.bins.m0 === 0 && R3.bins.n === 10 && R3.loops === false && R3.nF === 1800 && R3.tEnd === 3598,
    `an hour of 2 s samples → ${R3.nF} samples to t ${R3.tEnd}, 10-minute bars from 08:00 (like the grid sim), no loop`);
  ok(!R3.ready && R3.want() === 0, 'nothing in yet: not ready, want() names chunk 0');
  R3.addChunk(0, CH[0]);
  ok(R3.ready && R3.nLoaded === 600 && !R3.complete && R3.want() === 1, `chunk 0 in → plays from 08:00 at once; want() names chunk 1 next (${R3.want()})`);
  R3.step(0.5); ok(near(R3.t, 0.5) && R3.all.length === 1 && R3.all[0].id === 'park', 'positions between 2 s samples (t 0.5: "park" on the map)');
  R3.step(5000); ok(R3.t === 1198 && !R3.waiting && near(R3.clock(), 1198), `hold: playing into chunk 1 before it is in stops on the last sample of chunk 0 (t ${R3.t}, 08:19:58) — no jump, no loop`);
  R3.step(1); ok(R3.t === 1198, 'hold: and stays there while it loads');
  R3.addChunk(1, CH[1]); R3.step(10); ok(near(R3.t, 1208) && R3.want() === 2, `chunk 1 in → plays on (t ${R3.t}); want() names chunk 2`);
  const before = R3.all.map(c => `${c.id}:${c.x}`).join();
  R3.seek(3000); ok(R3.t === 3000 && R3.waiting && !R3.ready && R3.want() === 2 && R3.all.map(c => `${c.id}:${c.x}`).join() === before,
    'seek ahead of the loading (timeline click at 08:50): t jumps there, waiting — the vehicles on screen stay as they were; want() names that chunk first');
  R3.step(5); ok(R3.t === 3000, 'waiting, step() does not move');
  R3.addChunk(2, CH[2]);
  ok(R3.complete && !R3.waiting && R3.ready && R3.all.length === 1 && near(R3.clock(), 3000) && R3.want() === -1, 'chunk 2 in → shows 08:50:00 ("park"), complete, nothing more wanted');
  R3.seek(1800); ok(R3.clock() === 1800 && near(R3.works().queue_m, 180), `clock: t 1800 ↔ 08:30:00 (clock0_s 0), works queue from the samples (${R3.works().queue_m.toFixed(1)} m)`);
  R3.seek(3598);
  const bar = b => { let se = 0, hi = 0; for (let m = b * 10; m < b * 10 + 10; m++) { se += R3.mSeen[m]; hi += R3.mHit[m]; } return [hi, se]; };
  const bars = [0, 1, 2, 3, 4, 5].map(bar);
  ok(R3.evAll.map(e => e.t).join() === '110,1510,3310' && R3.stats.harsh === 3 && R3.minute[1] === 1 && R3.minute[25] === 1 && R3.minute[55] === 1,
    `harsh braking over the hour (2 s samples, the drop read per second): ${R3.evAll.map(e => e.t).join(' / ')} s → minutes 1, 25, 55`);
  ok(bars.map(([h, se]) => `${h}/${se}`).join() === '1/1,0/0,1/2,0/0,0/0,1/1',
    `timeline: 10-minute bars braked / entered the 2×2 — ${bars.map(([h, se]) => `${h}/${se}`).join(' · ')} ("v3" enters at 08:21 without braking)`);
  ok(R3.atEnd && R3.clock() === 3598, 'at the last sample (08:59:58) the hour has played out (atEnd: the page pauses, as at 09:00 in the grid sim)');
  R3.step(30); ok(R3.t === 3598 && R3.stats.harsh === 3, 'the full hour does not loop — step() stays at the end');
  R3.seek(3590); for (let i = 0; i < 400 && !R3.atEnd; i++) R3.step(0.1 / 3); /* the page stops stepping once atEnd */ ok(R3.t === 3598 && R3.atEnd && R3.clock() === 3598, `small float steps land exactly on the last sample (t ${R3.t}: the clock reads 08:59:58, not 08:59:57)`);
  R3.seek(0); ok(R3.t === 0 && !R3.atEnd && R3.stats.harsh === 0, 'play again → seek(0) starts the counts over from 08:00');
  { const R5 = new X.SumoReplay(IH, 'original', Object.assign({}, MH, { clock0_s: 300, duration_s: 3300 }), { spec, polys }); R5.addChunk(0, CH[0]); R5.seek(100);
    ok(R5.clock() === 400 && R5.bins.n === 10 && R5.bins.m0 === 0 && R5.tEnd === 3298, `a 5-minute warm-up (clock0_s 300) → t 100 is 08:06:40; shown part ends at 09:00 (t ${R5.tEnd} + 300 + 2 s)`); }
  // baseline: metrics only
  { const B0 = new X.SumoReplay(IH, 'baseline', Object.assign({}, MH, { scenario: 'baseline', chunks: [] }), { spec, polys }); B0.step(5); B0.seek(100);
    ok(!B0.ready && B0.want() === -1 && B0.t === 0 && B0.all.length === 0 && B0.nChunks === 0, 'a manifest with "chunks": [] (baseline, metrics only) is never playable — not ready, nothing to load, step() / seek() do nothing'); }
  // truncated first pass: the page gave up on chunks 1–2
  { const R4 = new X.SumoReplay(IH, 'original', MH, { spec, polys }); R4.addChunk(0, CH[0]); R4.truncate(); R4.step(4000);
    ok(R4.complete && R4.tEnd === 1198 && R4.t === 1198 && R4.atEnd && R4.want() === -1, 'truncate() after 3 misses → the replay ends at what arrived (08:19:58) and stops there'); }
  // memory budget: over it, chunks far from the playhead are dropped once scanned, and named by want() again when it nears them
  { const R6 = new X.SumoReplay(IH, 'original', MH, { spec, polys, memBytes: 1 }), order = [];
    R6.seek(3500);
    for (let k = R6.want(), n = 0; k >= 0 && n < 10; k = R6.want(), n++) { order.push(k); R6.addChunk(k, CH[k]); if (k === 0) ok(R6.cHave[2] === 1 && R6.cHave[0] === 0 && R6.nDropped === 1, 'memory: chunk 0, scanned, is dropped at once (far from 08:58); chunk 2, not scanned yet, is kept'); }
    ok(order.join() === '2,0,1' && R6.complete && R6.nScan === 1800 && R6.evAll.length === 3 && R6.ready,
      `memory: loaded ${order.join(' → ')} (the playhead's chunk first, then in time order), all scanned: the same 3 harsh events`);
    R6.seek(100); ok(R6.waiting && R6.want() === 0, 'memory: seek back to 08:01:40 → waiting, want() asks for the dropped chunk 0 again');
    const sc0 = R6.evAll.length, ns0 = R6.nScan; R6.addChunk(0, CH[0]);
    ok(!R6.waiting && R6.all.some(c => c.id === 'v0') && R6.evAll.length === sc0 && R6.nScan === ns0 && R6.chunksIn === 3, 'memory: back in → shows 08:01:40 ("v0" there); not scanned twice (same events)'); }
}

// ---- the baked copy, once the backend has written it ---------------------------------------------------------------------
const REAL = process.env.SUMO_REAL_DIR ? process.env.SUMO_REAL_DIR.replace(/\/?$/, '/') : APPS + 'sumo/public/real/'; // SUMO_REAL_DIR: check another copy (e.g. a fresh bake) the same way
if (!existsSync(REAL + 'index.json')) console.log('   (apps/sumo/public/real/index.json not there yet: baked-copy checks skipped)');
else {
  const idx = JSON.parse(readFileSync(REAL + 'index.json', 'utf8'));
  ok(idx.version === 2 && idx.network === 'real' && idx.works && idx.works.link === X.SUMO_LINK && ['baseline', 'original', 'ai'].every(id => idx.scenarios.some(s => s.id === id)),
    `baked index.json: v2, real network, works on ${idx.works && idx.works.link}, scenarios ${idx.scenarios.map(s => s.id).join(' / ')}`);
  const P = idx.params || {}, hourRun = Array.isArray(P.hour_window);
  if (hourRun) ok(P.hour_window.join() === '8,9' && isFinite(P.green_2935) && typeof P.network_extent === 'string' && isFinite(P.sim_s),
    `baked index.params: hour_window ${P.hour_window}, green_2935 ${P.green_2935}, sim_s ${P.sim_s}, network_extent "${P.network_extent}"`);
  for (const sc of idx.scenarios) {
    const man = JSON.parse(readFileSync(REAL + sc.manifest, 'utf8')), dir = REAL + sc.id + '/', mt = Object.assign({}, sc.metrics, man.metrics);
    if (hourRun) {
      const qs = mt.queue_series;
      ok(['works_queue_end_m', 'works_queue_equiv_end_m', 'works_throughput_vph', 'works_capacity_assumption_vph'].every(k => isFinite(mt[k])) && Array.isArray(qs) && qs.length === 61
        && qs.every((r, i) => r[0] === i && isFinite(r[1]) && isFinite(r[2])) && Math.abs(qs[60][2] - mt.works_queue_equiv_end_m) < 1 && Math.abs(qs[60][1] - mt.works_queue_end_m) < 1,
        `${sc.id}: 09:00 queue ${Math.round(mt.works_queue_equiv_end_m)} m (engine method) / ${Math.round(mt.works_queue_end_m)} m physical, throughput ${mt.works_throughput_vph} veh/h vs ${mt.works_capacity_assumption_vph} assumed, queue_series 0…60`);
      ok((+man.clock0_s || 0) + (+man.duration_s) === 3600 && [1, 2].includes(+man.sample_s || 1), `${sc.id}: clock0_s ${man.clock0_s} + duration_s ${man.duration_s} = 3600 (ends at 09:00), sample_s ${man.sample_s}`);
    }
    if (!man.chunks.length) { ok(sc.id === 'baseline' && hourRun, `${sc.id}: no chunks — metrics only, never played`); continue; }
    const big = [], badSha = [];
    for (const c of man.chunks) { const f = dir + c.file; if (statSync(f).size >= 1.5e6) big.push(c.file); if (c.sha256 && createHash('sha256').update(readFileSync(f)).digest('hex') !== c.sha256) badSha.push(c.file); }
    ok(man.version === 2 && man.scenario === sc.id && !big.length && !badSha.length, `${sc.id}: ${man.chunks.length} chunks, each < 1.5 MB, sha256 match${big.length ? ' — big ' + big : ''}${badSha.length ? ' — sha ' + badSha : ''}`);
    const Rr = new X.SumoReplay(idx, sc.id, man, { spec, polys, memBytes: Infinity });
    const raw = man.chunks.map(c => JSON.parse(readFileSync(dir + c.file, 'utf8')));
    raw.forEach((d, k) => Rr.addChunk(k, d));
    let n = 0, bad = 0, axis = 0, mv = 0, along = 0, maxCars = 0, heads16 = 0;
    const prev = new Map();
    for (let t = 0; t < Math.min(Rr.nLoaded - 1, 600); t++) {
      Rr.seek(t); maxCars = Math.max(maxCars, Rr.all.length);
      for (const c of Rr.all) {
        n++; if (!isFinite(c.x) || !isFinite(c.y) || !near(Math.hypot(c.hx, c.hy), 1, 1e-3)) bad++;
        if (Math.abs(c.hx) > 0.9 || Math.abs(c.hy) > 0.9) axis++;
        const p = prev.get(c.id); if (p && c.v > 3) { const dx = c.x - p[0], dy = c.y - p[1], d = Math.hypot(dx, dy); if (d > 1) { mv++; if ((dx * c.hx + dy * c.hy) / d > 0.9) along++; } }
      }
      prev.clear(); for (const c of Rr.all) prev.set(c.id, [c.x, c.y]);
    }
    if (sc.id !== 'baseline') { const P = Rr.works().polys[0], G0 = polys[0], cen = Q => Q.reduce((s, v) => [s[0] + v[0] / Q.length, s[1] + v[1] / Q.length], [0, 0]), d = P ? Math.hypot(cen(P)[0] - cen(G0)[0], cen(P)[1] - cen(G0)[1]) : 1e9;
      ok(P && d < 8, `${sc.id}: closure polygon from the lane SUMO closed, ${d.toFixed(1)} units from the grid sim's (same link, other lane)`); }
    const H = Rr.signalHeads();
    heads16 = spec.junctions.filter(J => H.some(h => Math.hypot(h.x - J.x, h.y - J.y) < 45)).length;
    ok(maxCars > 20 && bad === 0, `${sc.id}: up to ${maxCars} vehicles on the page, positions finite, headings unit length (${n} samples)`);
    ok(mv > 50 && along / mv > 0.95, `${sc.id}: heading follows the movement between samples for ${(100 * along / Math.max(1, mv)).toFixed(1)} % of ${mv} moving samples (angle convention and centre positions right)`);
    ok(axis / n > 0.8, `${sc.id}: ${(100 * axis / n).toFixed(0)} % of headings lie along the page axes (Hoddle grid streets)`);
    ok(heads16 === 16, `${sc.id}: signal heads at ${heads16} of the 16 grid junctions`);
    // Harsh braking on the real run — recounted here straight from the samples (m/s, the same rule), all marks in the 2×2
    { const VW = X.GRID_VIEW, inV = p => X.gridIn(VW, p[0], p[1]), last = new Map(), hb = new Map(), dt = +man.sample_s || 1; let n2 = 0;
      for (const d of raw) for (const f of d.frames) for (const r of f.a) {
        const p = X.geoToWorld(r[2] / 1e6, r[1] / 1e6), v = r[4] / 100, q = last.get(r[0]);
        if (q && q.t === f.t - dt) { const a = (v - q.v) / dt; if (a < -3.5) { if (!hb.get(r[0])) { hb.set(r[0], 1); if (inV(q.p)) n2++; } } else if (a > -1 / X.GRID_K) hb.set(r[0], 0); } else hb.set(r[0], 0);
        last.set(r[0], { t: f.t, v, p });
      }
      Rr.seek(Rr.tEnd);
      const E = Rr.evAll, sum = a => Array.from(a).reduce((x, y) => x + y, 0), B = Rr.bins, bars = [];
      for (let m0 = B.m0; m0 < 60; m0 += B.n) { let se = 0, hi = 0; for (let m = m0; m < m0 + B.n && m < 60; m++) { se += Rr.mSeen[m]; hi += Rr.mHit[m]; } if (se) bars.push([hi, se]); }
      ok(E.length > 0 && E.every(e => e.kind === 'harsh' && inV([e.x, e.y]) && e.t >= 0 && e.t <= Rr.tEnd) && Rr.stats.harsh === E.length && Math.abs(E.length - n2) <= Math.max(2, Math.ceil(0.02 * n2)),
        `${sc.id}: ${E.length} harsh braking marks (> 3.5 m/s² over ${dt} s), all inside GRID_VIEW; recounted from the samples: ${n2} (float32 speeds: a drop of exactly 3.5 m/s² may fall either side — within 2 or 2 %)`);
      ok(sum(Rr.mSeen) === Rr.vIn.length && sum(Rr.mHit) === Rr.vHit.length && Rr.vHit.length > 0 && bars.length === 6 && bars.every(([h, s]) => h >= 0 && h <= s) && bars.some(([h]) => h > 0)
        && B.n === (Rr.dur >= 1800 ? 10 : 2),
        `${sc.id}: timeline, ${B.n}-minute bars from 08:${String(B.m0).padStart(2, '0')} — ${bars.map(([h, s]) => `${h}/${s}`).join(' · ')} vehicles braked / entered the 2×2; ${Rr.vHit.length} of ${Rr.vIn.length} in all, each once`);
      ok(Rr.stats.conflicts === null && Rr.stats.critical === null, `${sc.id}: conflicts / critical not computed (null), never 0`); }
  }
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
