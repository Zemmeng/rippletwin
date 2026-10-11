// Grid micro-sim (src/js/4b-grid.js) on the real network: 4×4 computed, the 2×2 at the works shown. Gridlock, works queue,
// red lights, overlaps, determinism, flows entering the 2×2, and that `agents` (the stats) stay inside the 2×2 while the
// page draws `all` and the signal heads of all 16 junctions.
// Called by tests/test_grid.py; one ✅ / ❌ line per assertion, no network access.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WEB = HERE + '../', APPS = WEB + '../';
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log('✅ ' + msg); } else { fail++; console.log('❌ ' + msg); } };

const eng = readFileSync(WEB + 'src/js/6-engine.js', 'utf8').match(/\/\* pure:begin[^\n]*\n([\s\S]*?)\/\* pure:end \*\//)[1];
const grid = readFileSync(WEB + 'src/js/4b-grid.js', 'utf8').match(/\/\* grid:begin \*\/\n([\s\S]*?)\/\* grid:end \*\//)[1];
const stubs = `const clamp=(v,a,b)=>v<a?a:v>b?b:v;
function rng(seed){let a=seed>>>0;return()=>{a=(a+0x6D2B79F5)|0;let t=Math.imul(a^(a>>>15),1|a);t=(t+Math.imul(t^(t>>>7),61|t))^t;return((t^(t>>>14))>>>0)/4294967296;};}
const WXP={clear:{v:1,T:1,b:1,ped:1,bike:1,wob:0,rate:1},storm:{v:.82,T:1.4,b:.72,ped:1.12,bike:.85,wob:.15,rate:.9}};
const WORLD={x0:-320,x1:320,y0:-300,y1:300};const RISK_CELL=4,RNX=(WORLD.x1-WORLD.x0)/RISK_CELL,RNY=(WORLD.y1-WORLD.y0)/RISK_CELL;`;
const ctx = {}; vm.createContext(ctx);
vm.runInContext(stubs + '\n' + eng + '\n' + grid + '\n;globalThis.geoToWorld=geoToWorld;globalThis.G={gridSpec,GridSim,GRID_BOX,GRID_SIM,GRID_VIEW,gridSigState,GRID_K,GRID_W};', ctx);
const G = ctx.G;
const net = JSON.parse(readFileSync(APPS + 'roads/public/cbd/network.json', 'utf8'));
const flows = JSON.parse(readFileSync(APPS + 'roads/public/cbd/flows.json', 'utf8'));
const B = G.GRID_BOX, SB = G.GRID_SIM, VW = G.GRID_VIEW, W = { x0: -320, x1: 320, y0: -300, y1: 300 };
const SHOWN = ['2913', '2912', '2904', '2903'];
const WORKS = { link: 'l595594354_9756035316', lanes: 1 };
// crossing street of junction q for direction D, and how far its zebra reaches from the junction centre (2-basemap.js: w/2 + 4)
const crossOf = (spec, D, q) => { const J = spec.junctions[q.j]; return D.axis === 'EW' ? J.ns : J.ew; };
const zebraEnd = (spec, D, q) => G.GRID_W[crossOf(spec, D, q)] / 2 + 4;

const sp8 = G.gridSpec(net.links, flows, 8, null), sp8w = G.gridSpec(net.links, flows, 8, WORKS);
ok(B.x0 >= W.x0 && B.x1 <= W.x1 && B.y0 >= W.y0 && B.y1 <= W.y1, 'GRID_BOX lies inside WORLD');
ok(SB.x0 < B.x0 && SB.x1 > B.x1 && SB.y0 < B.y0 && SB.y1 > B.y1 && VW.x0 >= B.x0 && VW.x1 <= B.x1 && VW.y0 >= B.y0 && VW.y1 <= B.y1,
  'GRID_SIM (computed) contains GRID_BOX (shown), GRID_VIEW (cars drawn) lies inside GRID_BOX');
ok(sp8.junctions.length === 16 && sp8.junctions.every(J => J.x > SB.x0 && J.x < SB.x1 && J.y > SB.y0 && J.y < SB.y1),
  '16 junctions computed inside GRID_SIM: ' + sp8.junctions.map(J => `${J.id} (${Math.round(J.x)},${Math.round(J.y)})`).join(' '));
const shown = sp8.junctions.filter(J => J.shown).map(J => J.id);
ok(shown.length === 4 && SHOWN.every(id => shown.includes(id)) && sp8.junctions.filter(J => J.shown).every(J => J.x > B.x0 && J.x < B.x1 && J.y > B.y0 && J.y < B.y1),
  `exactly the 2×2 at the works is shown: ${shown.join(' ')}`);
const sites = JSON.parse(readFileSync(APPS + 'roads/public/cbd/signals.json', 'utf8')).sites;
const far = sp8.junctions.filter(J => { const st = sites.find(x => x.site === J.id); if (!st) return true; const [x, y] = ctx.geoToWorld(st.lat, st.lon); return Math.hypot(x - J.x, y - J.y) > 15; });
ok(far.length === 0, `every junction sits on its real SCATS site (signals.json, ≤ 15 units): ${far.map(J => J.id).join(' ') || 'all 16'}`);
console.log('   dirs: ' + sp8.dirs.map(D => `${D.street.replace(' Street', '')} ${D.dir} ${D.lanes}L ${Math.round(D.vph)}/h`).join(' · '));
ok(sp8w.close && sp8w.dirs[sp8w.close.di].street === 'Lonsdale Street' && sp8w.dirs[sp8w.close.di].dir === 'W' && sp8w.close.n === 1,
  `works link maps to Lonsdale St westbound kerb lane, s ${sp8w.close && Math.round(sp8w.close.s0)}..${sp8w.close && Math.round(sp8w.close.s1)}`);

function run(spec, seed, secs, opt = {}) {
  const sim = new G.GridSim(spec, { seed }); const r = { red: 0, overlap: 0, inPoly: 0, outBox: 0, outer: 0, heads: new Set(), maxStop: 0, q: [], samples: 0, boxMax: 0, boxWho: '', tramBox: 0 };
  const cnt = spec.dirs.map(() => 0), prev = new WeakMap();
  sim.onCross = (c, ln, q, t) => { if (G.gridSigState(spec, q.j, ln.D.axis, t) === 'R') r.red++; };
  const polys = sim.works().polys;
  const pip = (x, y, P) => { let inside = false; for (let i = 0, j = P.length - 1; i < P.length; j = i++) { const [xi, yi] = P[i], [xj, yj] = P[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside; } return inside; };
  const t0 = Date.now();
  for (let k = 0; k < secs / 0.25; k++) {
    sim.step(0.25);
    for (const ln of sim.lanes) for (let i = 1; i < ln.cars.length; i++) if (ln.cars[i - 1].s - ln.cars[i - 1].len - ln.cars[i].s < 0) r.overlap++;
    // how long each vehicle has been standing (v < 0.5) with any part of it inside a junction or on one of its zebras
    for (const ln of sim.lanes) for (const c of ln.cars) {
      const q = c.v < 0.5 && ln.D.jn.find(q => c.s > q.s - zebraEnd(spec, ln.D, q) && c.s - c.len < q.s + zebraEnd(spec, ln.D, q));
      c._box = q ? (c._box || 0) + 0.25 : 0;
      if (q && c.type === 'tram') r.tramBox++;
      if (c._box > r.boxMax) { r.boxMax = c._box; r.boxWho = `${c.type} ${ln.D.street.replace(' Street', '')} ${ln.D.dir} @${spec.junctions[q.j].id}, front ${(c.s - q.s).toFixed(1)} from centre`; }
    }
    for (const a of sim.agents) if (a.x < VW.x0 || a.x > VW.x1 || a.y < VW.y0 || a.y > VW.y1) r.outBox++;
    for (const a of sim.all) {
      if (a.x < B.x0 || a.x > B.x1 || a.y < B.y0 || a.y > B.y1) r.outer++;
      for (const P of polys) if (pip(a.x, a.y, P)) r.inPoly++;
    }
    if (sim.t > 300) for (const ln of sim.lanes) for (const c of ln.cars) {
      if (c.type !== 'car') continue; const p = prev.get(c), sV = ln.D.sV;
      if (p ? (p.ln === ln && p.s < sV && c.s >= sV) : (c.s >= sV && c.s < sV + 8 && !c.arc)) cnt[ln.di]++;
      prev.set(c, { s: c.s, ln });
    }
    if (k % 40 === 0) for (const h of sim.signalHeads()) r.heads.add(h.id);
    if (k % 40 === 0 && sim.t > 300) {
      const n = sim.agents.length, st = sim.agents.filter(a => a.v < 0.5).length;
      if (n >= 10) r.maxStop = Math.max(r.maxStop, st / n);
      r.q.push(opt.qAt ? sim.queueAt(opt.qAt.di, opt.qAt.s0) : sim.works().queue_m); r.samples++;
    }
  }
  r.ms = Date.now() - t0; r.sim = sim; r.cnt = cnt; r.secs = secs - 300; r.qAvg = r.q.reduce((a, b) => a + b, 0) / Math.max(1, r.q.length); return r;
}
const served = sim => sim.entry.filter(e => e.arr > 0).map(e => ({ e, f: e.ins / e.arr }));

// 1 hour 8, no works
const A = run(sp8, 7, 3600, { qAt: sp8w.close });
const sA = served(A.sim);
console.log(`   1 simulated hour took ${A.ms} ms (${(3600 / (A.ms / 1000)).toFixed(0)}× real time), ${A.sim.stats.done} cars done`);
ok(sA.every(x => x.f >= 0.8), '08:00 no works: every entry served ≥ 80 % of demand — ' + sA.map(x => `${x.e.street.replace(' Street', '')} ${x.e.dir} ${x.e.ins}/${x.e.arr}`).join(', '));
ok(A.maxStop < 0.9 && A.sim.stats.done > 1000, `08:00 no works: no gridlock — stopped share peaks at ${(A.maxStop * 100).toFixed(0)} % (< 90 %), ${A.sim.stats.done} cars through`);
ok(A.ms < 20000, `1 simulated hour runs in ${A.ms} ms (< 20 s)`);
const inflow = R => R.sim.spec.dirs.map((D, i) => ({ D, got: R.cnt[i] * 3600 / R.secs })).filter(x => x.D.target != null && x.D.entry);
const fA = inflow(A);
ok(fA.length === 7 && fA.every(x => Math.abs(x.got - x.D.target) <= Math.max(45, 0.15 * x.D.target)),
  '08:00: cars entering the 2×2 match flows.json at its edge (±15 %) — ' + fA.map(x => `${x.D.street.replace(' Street', '')} ${x.D.dir} ${Math.round(x.got)}/${Math.round(x.D.target)}`).join(', '));
ok(A.outer > 0 && A.sim.all.length > A.sim.agents.length, `the outer ring is computed: ${A.sim.all.length} cars in the 4×4, ${A.sim.agents.length} handed to the page`);

// 2 hour 8 with the demo works (Lonsdale St westbound, 1 lane)
const Bw = run(sp8w, 7, 3600);
const sB = served(Bw.sim);
ok(Bw.qAvg > A.qAvg && Bw.sim.stats.merges > 20, `works: mean queue at the works ${Bw.qAvg.toFixed(0)} m vs ${A.qAvg.toFixed(0)} m without, ${Bw.sim.stats.merges} zipper merges`);
ok(Bw.maxStop < 0.9 && sB.every(x => x.f >= 0.8), `works: no gridlock — stopped share peaks at ${(Bw.maxStop * 100).toFixed(0)} %, every entry served ≥ 80 % (` + sB.map(x => `${x.e.dir}${x.e.street[0]} ${(x.f * 100).toFixed(0)}%`).join(' ') + ')');
ok(Bw.sim.works().polys.length === 1, 'works() returns one closed-lane polygon for lanes: 1');

// 3–5, 8 reverse assertions over both runs
ok(A.inPoly + Bw.inPoly === 0, `reverse: no car centre ever inside a closed-lane polygon (${Bw.inPoly} hits)`);
ok(A.red + Bw.red === 0 && A.sim.redRun + Bw.sim.redRun === 0, `reverse: no car crosses a stop line on red (${A.red + Bw.red} independent, ${A.sim.redRun + Bw.sim.redRun} self-reported)`);
ok(A.overlap + Bw.overlap === 0, `reverse: no overlaps on any lane (gap ≥ 0) — ${A.overlap + Bw.overlap} violations`);
ok(A.outBox + Bw.outBox === 0, `reverse: the page is never handed a car outside the 2×2 view (${A.outBox + Bw.outBox} outside GRID_VIEW)`);
ok(A.heads.size === 16 && Bw.heads.size === 16, `signal heads at all 16 junctions — the page draws the whole 4×4 (${[...A.heads].join(' ')})`);
{ const hs = A.sim.signalHeads(), sh = new Set(hs.filter(h => h.shown).map(h => h.id));
  ok(sh.size === 4 && SHOWN.every(id => sh.has(id)) && hs.every(h => h.shown === SHOWN.includes(h.id)), `signalHeads() flags exactly the 2×2 at the works as shown: ${[...sh].join(' ')}`); }

// 6 determinism
const d1 = run(sp8w, 42, 600), d2 = run(sp8w, 42, 600);
ok(JSON.stringify(d1.sim.stats) === JSON.stringify(d2.sim.stats) && d1.sim.agents.length === d2.sim.agents.length, `same seed → same stats (${JSON.stringify(d1.sim.stats)})`);

// 7 hour 17
const sp17 = G.gridSpec(net.links, flows, 17, null), C = run(sp17, 3, 3600), sC = served(C.sim);
const fC = inflow(C);
ok(fC.every(x => Math.abs(x.got - x.D.target) <= Math.max(45, 0.15 * x.D.target)), '17:00: cars entering the 2×2 match flows.json (±15 %) — ' + fC.map(x => `${x.D.dir}${x.D.street[0]} ${Math.round(x.got)}/${Math.round(x.D.target)}`).join(' '));
ok(C.maxStop < 0.9 && sC.every(x => x.f >= 0.8) && C.red + C.overlap + C.outBox === 0, `17:00: no gridlock — stopped share peaks at ${(C.maxStop * 100).toFixed(0)} %, ${C.sim.stats.done} cars, entries ≥ 80 %`);
const Cw = run(G.gridSpec(net.links, flows, 17, WORKS), 3, 1800);
ok(Cw.maxStop < 0.9 && Cw.inPoly + Cw.red + Cw.overlap === 0, `17:00 with works: no gridlock (${(Cw.maxStop * 100).toFixed(0)} %), no car in the works, none on red`);

// stop lines: behind the zebra, on the stop line 2-basemap.js draws (w/2 + 4.6 … w/2 + 5.0 from the crossing street's centre)
const world = readFileSync(WEB + 'src/js/1-world.js', 'utf8');
const wOf = n => { const m = world.match(new RegExp(`name:'${n.replace(' Street', ' St')}'[^}]*?\\bw:(\\d+)`)); return m ? +m[1] : NaN; };
const drawn = Object.entries(G.GRID_W).filter(([n]) => !isNaN(wOf(n)));
ok(drawn.length >= 6 && drawn.every(([n, w]) => wOf(n) === w) && sp8.junctions.every(J => J.ew in G.GRID_W && J.ns in G.GRID_W),
  'GRID_W has every computed street and matches 1-world.js where it draws them: ' + drawn.map(([n, w]) => `${n.replace(' Street', '')} ${w}/${wOf(n)}`).join(', '));
const stops = sp8w.dirs.flatMap(D => D.jn.map(q => ({ D, q, w: G.GRID_W[crossOf(sp8w, D, q)] })));
ok(stops.length >= 8 && stops.every(({ q, w }) => q.s - q.stop >= w / 2 + 4.6 && q.s - q.stop <= w / 2 + 5.2),
  'reverse: every stop line sits behind its zebra — ' + [...new Set(stops.map(({ D, q, w }) => `${crossOf(sp8w, D, q).replace(' Street', '')} w ${w}: ${(q.s - q.stop).toFixed(1)}`))].join(', '));
const R4 = [A, Bw, C, Cw].sort((u, w) => w.boxMax - u.boxMax)[0];
ok(R4.boxMax <= 6, `reverse: nobody waits inside a junction or on a zebra — longest stand there ${R4.boxMax} s (≤ 6 s; ${R4.boxWho})`);
ok(A.tramBox + Bw.tramBox + C.tramBox + Cw.tramBox === 0, `reverse: no tram ever stands with its tail in a junction or on a zebra (${A.tramBox + Bw.tramBox + C.tramBox + Cw.tramBox} samples)`);

// API shape the page codes against
const s = Bw.sim, a0 = s.agents[0], h = s.signalHeads();
ok(s.isGrid === true && s.risk.constructor.name === "Float32Array" && s.risk.length === 160 * 150 && s.minute.length === 60 && Array.isArray(s.events) && 'riskVer' in s && 'clock0' in s && s.critical === null,
  'GridSim fields: isGrid, agents, events, risk, riskVer, stats, minute, critical, t, clock0');
ok(a0 && ['id', 'kind', 'type', 'x', 'y', 'hx', 'hy', 'v', 'acc', 'len', 'wid', 'trail', 'tag', 'blocked'].every(k => k in a0) && a0.trail.length <= 24,
  'agents carry id, kind, type, x, y, hx, hy, v, acc, len, wid, trail (≤ 24), tag, blocked');
ok(h.length >= 8 && h.every(x => (x.axis === 'EW' || x.axis === 'NS') && 'GAR'.includes(x.state)), `signalHeads(): ${h.length} heads with axis and G / A / R`);
ok(s.all.some(a => a.type === 'tram'), 'trams run on Swanston St');
s.setWeather('storm', null); s.step(5); ok(s.wxk === 'storm', 'setWeather switches the weather multipliers');

// Safety events with a place on the map (sim.events): harsh braking and TTC conflicts, 2×2 only, old ones forgotten
{
  const sim = new G.GridSim(G.gridSpec(net.links, flows, 8, WORKS), { seed: 4218 });
  while (sim.t < 180) sim.step(0.25); sim.resetStats();
  while (sim.t < 280) sim.step(0.25); // 100 s < evKeep: every event is still kept
  const ev = sim.events, hb = ev.filter(e => e.kind === 'harsh'), cf = ev.filter(e => e.kind === 'conflict');
  ok(hb.length > 0 && hb.length === sim.stats.harsh && cf.length === sim.stats.conflicts && cf.filter(e => e.sev === 2).length === sim.stats.critical,
    `every harsh braking / conflict / critical counted has a mark on the map (${hb.length} / ${cf.length} / ${sim.stats.critical} in 100 s)`);
  ok(ev.every(e => Number.isFinite(e.x) && Number.isFinite(e.y) && e.x >= VW.x0 && e.x <= VW.x1 && e.y >= VW.y0 && e.y <= VW.y1), 'the marks sit inside the 2×2 (GRID_VIEW), where the counts are taken');
  // a follower forced onto a stopped leader in the same lane → one critical conflict (TTC < 1 s), marked between the two
  const inV = c => c.x >= VW.x0 + 20 && c.x <= VW.x1 - 20 && c.y >= VW.y0 + 20 && c.y <= VW.y1 - 20 && !c.arc && c.turn === null;
  let pair = null;
  for (const l of sim.lanes) { for (let i = 1; i < l.cars.length && !pair; i++) if (l.cars[i - 1].type === 'car' && inV(l.cars[i - 1]) && inV(l.cars[i])) pair = [l.cars[i - 1], l.cars[i]]; if (pair) break; }
  if (!pair) ok(false, 'found two cars one behind the other inside the 2×2');
  else {
    const [ld, c] = pair, n0 = sim.stats.conflicts, k0 = sim.stats.critical;
    ld.v = 0; ld.acc = 0; c.s = ld.s - ld.len - 5 * G.GRID_K; c.v = 10 * G.GRID_K;
    sim.step(0.25);
    const e = sim.events.filter(x => x.kind === 'conflict').pop();
    ok(sim.stats.conflicts === n0 + 1 && sim.stats.critical === k0 + 1 && e && e.sev === 2 && e.ttc < 1, `closing at 10 m/s on a stopped car 5 m ahead → 1 critical conflict (TTC ${e ? e.ttc.toFixed(2) : '?'} s)`);
    sim.step(0.25);
    ok(sim.stats.conflicts === n0 + 1, 'the same pair is counted once (within 6 s)');
  }
  ok(cf.every(e => e.ttc < 1.5 && (e.sev === 2) === (e.ttc < 1)), 'conflict = TTC < 1.5 s, critical = TTC < 1.0 s');
  { const sum = a => a.reduce((x, y) => x + y, 0), seen = sum(sim.mSeen), hit = sum(sim.mHit);
    ok(seen > 0 && hit > 0 && hit <= seen && hit <= sim.stats.harsh + sim.stats.conflicts,
      `timeline shares — ${hit} of ${seen} vehicles into the 2×2 braked harshly or were in a conflict (${(hit / seen * 100).toFixed(1)} %); a vehicle counts once`); }
  while (sim.t < 600) sim.step(0.25);
  ok(sim.events.every(e => sim.t - e.t <= 120) && sim.stats.harsh > sim.events.filter(e => e.kind === 'harsh').length, 'marks older than 2 minutes are dropped; the counts keep them');
}
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
