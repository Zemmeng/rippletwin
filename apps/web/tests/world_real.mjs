// Real buildings: /roads/public/cbd/buildings.json → polygons on the page grid (buildWorldReal in src/js/1-world.js), then the 2 m ground-class / shadow / wind-shadow rasters.
// Called by tests/test_world.py as node tests/world_real.mjs; one ✅ / ❌ line per assertion, no network access
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WEB = HERE + '../';
const APPS = WEB + '../';
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log('✅ ' + msg); } else { fail++; console.log('❌ ' + msg); } };

// 1-world.js does not touch the DOM anywhere; geoToWorld comes from the pure block of 6-engine.js (the page passes the same one into buildWorldReal)
const world = readFileSync(WEB + 'src/js/1-world.js', 'utf8');
const pure = readFileSync(WEB + 'src/js/6-engine.js', 'utf8').match(/\/\* pure:begin[^\n]*\n([\s\S]*?)\/\* pure:end \*\//)[1];
const ctx = { L: a => a, console };
vm.createContext(ctx);
vm.runInContext(world + '\n' + pure + '\n;globalThis.T={WORLD,STREETS,CLS,NX,NY,CELL,streetRect,buildWorld,buildWorldReal,buildGrids,clipSide,clipStreets,inPoly,polyArea,bboxOf,geoToWorld,REAL_MIN,SYN_LANDMARKS,LANDMARK_HOST,STREET_SPAN,CLIP_EPS,MIN_PIECE_W};', ctx);
const T = ctx.T;
const data = JSON.parse(readFileSync(APPS + 'roads/public/cbd/buildings.json', 'utf8'));
const net = JSON.parse(readFileSync(APPS + 'roads/public/cbd/network.json', 'utf8'));
// Point (x, y) lies on a page street (carriageway + footpath, edges included), and that stretch really exists in the real network (Little La Trobe / A'Beckett have only one stretch each, see STREET_SPAN)
const onRealStreet = (s, x, y) => {
  const r = T.streetRect(s), sp = T.STREET_SPAN[s.id], u = s.axis === 'h' ? x : y;
  return x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1 && (!sp || (u >= sp[0] && u <= sp[1]));
};

// 1 Clipping: a U-shaped building cut by a street gives two pieces with no zero-width bridge along the cut; parts over a street are cut off, buildings entirely inside a street are dropped
const U = [[0, 0], [30, 0], [30, 20], [20, 20], [20, 5], [10, 5], [10, 20], [0, 20]];
const top = T.clipSide(U, 1, 12, 1), bot = T.clipSide(U, 1, 12, -1);
const areas = r => r.map(q => Math.abs(T.polyArea(q))).sort((a, b) => a - b);
ok(top.length === 2 && areas(top).every(a => Math.abs(a - 80) < 1e-6) && top.every(q => { const xs = q.map(p => p[0]); return Math.max(...xs) - Math.min(...xs) <= 10 + 1e-9; }),
  `U-shaped building, lower half cut off: one piece per leg, 80 m² each (got ${top.length} pieces ${areas(top).join(' / ')})`);
ok(bot.length === 1 && Math.abs(areas(bot)[0] - 290) < 1e-6, `U-shaped building, upper half cut off: one piece of 290 m² (got ${bot.length} pieces ${areas(bot).join(' / ')})`);
const trimmed = T.clipStreets([[-40, -40], [-12, -40], [-12, -20], [-40, -20]]), edge = -15 - T.CLIP_EPS;
ok(trimmed.length === 1 && Math.abs(Math.abs(T.polyArea(trimmed[0])) - (edge + 40) * 20) < 1e-6 && Math.abs(Math.max(...trimmed[0].map(p => p[0])) - edge) < 1e-9 && T.CLIP_EPS > 0 && T.CLIP_EPS < 0.5,
  `building reaching 3 m into the Swanston footpath: cut to ${T.CLIP_EPS} m outside the street edge (x = ${edge}), so the cell whose centre is exactly on the edge x = −15 stays footpath`);
// Clip only where the real network has the street: Little La Trobe only between Elizabeth and Swanston, A'Beckett only west of Swanston (network.json)
const box = (x0, x1, y0, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const llE = T.clipStreets(box(30, 60, 80, 120)), llW = T.clipStreets(box(-100, -70, 80, 120));
const abE = T.clipStreets(box(30, 60, 180, 220)), abW = T.clipStreets(box(-100, -70, 180, 220));
const whole = r => r.length === 1 && Math.abs(Math.abs(T.polyArea(r[0])) - 1200) < 1e-6;
ok(whole(llE) && whole(abE), "buildings east of Swanston (RMIT) spanning the page's Little La Trobe / A'Beckett are not cut (the real network has neither street there)");
ok(llW.length === 2 && abW.length === 2 && llW.concat(abW).every(q => q.every(p => !T.STREETS.some(s => onRealStreet(s, p[0], p[1])))),
  `negative: the same building between Elizabeth and Swanston is still cut in two by Little La Trobe / A'Beckett (${llW.length} / ${abW.length} pieces)`);
const sliver = T.clipStreets(box(-100, -60, -105.7, -80));
ok(sliver.length === 1 && Math.min(...sliver[0].map(p => p[1])) > -95,
  `a leftover 0.65 m sliver (< ${T.MIN_PIECE_W} m, assumed value) is dropped, leaving only the piece north of Little Lonsdale (${sliver.length} piece)`);
// STREET_SPAN matches network.json: both x ends of these streets' links inside the page extent fall within "real stretch ends ± junction half-width"
for (const [id, name] of [['llatrobe', 'Little La Trobe Street'], ['abeckett', "A'Beckett Street"]]) {
  const sp = T.STREET_SPAN[id], xs = [];
  if (!sp) { ok(false, `${id} missing from STREET_SPAN (${name} has only one stretch in the real network)`); continue; }
  for (const l of net.links) {
    if (l.name !== name) continue;
    const gx = l.geometry.map(g => T.geoToWorld(g[0], g[1])[0]), a0 = Math.min(...gx), a1 = Math.max(...gx);
    if (a1 > T.WORLD.x0 && a0 < T.WORLD.x1) xs.push(Math.max(a0, T.WORLD.x0), Math.min(a1, T.WORLD.x1)); // links clipped to the page extent
  }
  const lo = Math.min(...xs), hi = Math.max(...xs), a = isFinite(sp[0]) ? sp[0] : T.WORLD.x0;
  ok(xs.length > 1 && Math.abs(lo - a) <= 16 && Math.abs(hi - sp[1]) <= 16, `${name} spans x = ${lo.toFixed(0)}…${hi.toFixed(0)} in the real network, matching STREET_SPAN ${sp.join('…')}`);
}
ok(T.clipStreets([[-5, -60], [5, -60], [5, -40], [-5, -40]]).length === 0, 'negative: a building entirely on the Swanston carriageway is dropped');

// 2 Real data converted to the page
const t0 = Date.now();
const W = T.buildWorldReal(data, T.geoToWorld);
const tBuild = Date.now() - t0;
const ids = new Set(W.buildings.map(b => b.id));
ok(W.real === true && W.count > 150 && ids.size === W.count, `${W.count} real buildings inside the page extent (> 150), cut into ${W.buildings.length} pieces, in ${tBuild} ms`);
ok(W.count >= T.REAL_MIN, `enough for the page to replace the procedurally generated city (REAL_MIN = ${T.REAL_MIN})`);
const bad = W.buildings.filter(b => !(b.pts.length >= 3 && b.pts.every(p => isFinite(p[0]) && isFinite(p[1])) && b.h > 0 && isFinite(b.h) && b.area >= 4
  && b.x0 <= b.x1 && b.y0 <= b.y1 && b.x1 >= T.WORLD.x0 - 80 && b.x0 <= T.WORLD.x1 + 80 && T.inPoly(b.pts, b.cx, b.cy)));
ok(bad.length === 0, `every piece has ≥ 3 finite vertices, height > 0, area ≥ 4 m² and its label point inside it (${bad.length} invalid)`);
const src = data.buildings.filter(b => { const P = b.footprint.map(p => T.geoToWorld(p[0], p[1])); return P.some(p => p[0] > T.WORLD.x0 && p[0] < T.WORLD.x1 && p[1] > T.WORLD.y0 && p[1] < T.WORLD.y1); });
ok(W.count >= src.length * 0.95, `${src.length} buildings in the data have a vertex inside the page; ${W.count} are drawn (≥ 95 %)`);

// 3 Negative assertions: no buildings on the La Trobe × Swanston junction or on any street (carriageway + footpath)
const onBox = [];
for (let x = -15; x <= 15; x += 1) for (let y = -15; y <= 15; y += 1) for (const b of W.buildings) if (x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1 && T.inPoly(b.pts, x, y)) onBox.push(b.name || b.id);
ok(onBox.length === 0, `no buildings in the 30 × 30 m La Trobe × Swanston junction (overlapping: ${[...new Set(onBox)].slice(0, 3).join(', ') || 0})`);
const onStreet = [];
for (const s of T.STREETS) for (const b of W.buildings) for (const p of b.pts) if (onRealStreet(s, p[0], p[1])) onStreet.push(`${b.name || b.id}@${s.id}`);
ok(onStreet.length === 0, `no building vertex falls on the carriageway / footpath of the 8 streets, nor on a street edge (edges included: ${onStreet.slice(0, 3).join(', ') || 0})`);
const thin = W.buildings.filter(b => b.area / Math.max(b.x1 - b.x0, b.y1 - b.y0) < T.MIN_PIECE_W);
ok(thin.length === 0, `no leftover slivers (mean width < ${T.MIN_PIECE_W} m: ${thin.slice(0, 3).map(b => b.name || b.id).join(', ') || 0})`);
// The street stretches drawn on the page that do not exist in the real network (Little La Trobe / A'Beckett east of Swanston, Little La Trobe west of Elizabeth): real buildings are drawn as they are
const fict = [];
for (const s of T.STREETS) {
  if (!T.STREET_SPAN[s.id]) continue;
  const r = T.streetRect(s);
  for (let x = T.WORLD.x0 + 0.5; x < T.WORLD.x1; x += 1) for (let y = r.y0 + 0.5; y < r.y1; y += 1) if (!T.STREETS.some(o => onRealStreet(o, x, y))) fict.push([x, y]);
}
const srcP = data.buildings.map(b => { const P = b.footprint.map(p => T.geoToWorld(p[0], p[1])); return { P, bb: T.bboxOf(P) }; });
const wP = W.buildings.map(b => ({ P: b.pts, bb: b }));
const covered = (list, x, y) => list.some(q => x >= q.bb.x0 && x <= q.bb.x1 && y >= q.bb.y0 && y <= q.bb.y1 && T.inPoly(q.P, x, y));
let srcIn = 0, wIn = 0;
for (const [x, y] of fict) if (covered(srcP, x, y)) { srcIn++; if (covered(wP, x, y)) wIn++; }
ok(srcIn > 2000 && wIn >= srcIn * 0.98, `negative: on the street stretches that do not exist in the real network, ${srcIn} m² of real buildings → ${wIn} m² drawn (≥ 98 %; RMIT Building 8 and Storey Hall are no longer cut)`);

// 4 Ground-class / shadow / wind-shadow rasters
const t1 = Date.now();
const G = T.buildGrids(W);
const tGrid = Date.now() - t1;
let roof = 0, roofOnStreet = 0, foot = 0, footShade = 0, wake = 0, boxRoof = 0;
for (let j = 0; j < T.NY; j++) for (let i = 0; i < T.NX; i++) {
  const k = j * T.NX + i, c = G.cls[k], x = T.WORLD.x0 + (i + 0.5) * T.CELL, y = T.WORLD.y1 - (j + 0.5) * T.CELL;
  const isRoof = c === T.CLS.ROOF || c === T.CLS.HERITAGE;
  if (isRoof) roof++;
  if (isRoof && T.STREETS.some(s => onRealStreet(s, x, y))) roofOnStreet++; // edges included: a cell whose centre sits exactly on a street edge counts as street
  if (isRoof && Math.abs(x) < 15 && Math.abs(y) < 15) boxRoof++;
  if (c === T.CLS.FOOT) { foot++; if (G.shade[k]) footShade++; }
  if (G.wake[k]) wake++;
}
const n = T.NX * T.NY;
ok(roof / n > 0.25 && roof / n < 0.75, `roof cells ${(roof / n * 100).toFixed(1)}% (25–75 %), rasters in ${tGrid} ms`);
ok(roofOnStreet === 0 && boxRoof === 0, `negative: no roof cells on streets / the junction, including cells centred on a street edge (street ${roofOnStreet}, junction ${boxRoof})`);
// Narrowest footpath: north side of Little Lonsdale is a single row of cells at y = −95; both the Elizabeth–Swanston and Swanston–Russell stretches must stay footpath (except the State Library lawn, which is drawn as lawn anyway)
let llFoot = 0, llAll = 0;
{
  const j = Math.round((T.WORLD.y1 + 95) / T.CELL - 0.5);
  for (let i = 0; i < T.NX; i++) { const x = T.WORLD.x0 + (i + 0.5) * T.CELL; if (((x > -185 && x < -15) || (x > 15 && x < 185)) && !W.parks.some(q => x >= q.x0 && x <= q.x1)) { llAll++; if (G.cls[j * T.NX + i] === T.CLS.FOOT) llFoot++; } }
}
ok(llAll > 100 && llFoot === llAll, `the footpath on the north side of Little Lonsdale (the y = −95 row) is not covered by roofs (${llFoot} / ${llAll} cells are footpath)`);
ok(footShade > 0 && footShade < foot, `part of the footpath is in building shadow (${footShade} / ${foot} cells)`);
ok(wake > 1000, `there is a wind shadow behind buildings (${wake} cells)`);
ok(tBuild + tGrid < 4000, `conversion + rasters ${tBuild + tGrid} ms < 4 s (run once on page load)`);
// Shadows point south-east (sun in the north-west at 292°): the south-east side of a building is more often in shadow than the north-west side
let se = 0, nw = 0;
for (const b of W.buildings) { if (b.h < 20) continue; const d = 6; se += G.shadeAt(b.cx + 0.93 * (b.x1 - b.x0) / 2 + d, b.cy - 0.37 * (b.y1 - b.y0) / 2 - d); nw += G.shadeAt(b.cx - 0.93 * (b.x1 - b.x0) / 2 - d, b.cy + 0.37 * (b.y1 - b.y0) / 2 + d); }
ok(se > nw, `shadows fall on the south-east side of buildings (south-east ${se} > north-west ${nw})`);

// 5 Real names, outline heights, landmarks
const has = name => data.buildings.some(b => b.name === name);
for (const [name, t] of [['State Library Victoria', 'STATE LIBRARY VICTORIA'], ['Melbourne Central', 'MELBOURNE CENTRAL']]) {
  if (!has(name)) { ok(true, `${name} not in the data, skipped`); continue; }
  const l = W.labels.find(q => q.t === t);
  ok(l && W.buildings.some(b => b.name === name && T.inPoly(b.pts, l.x, l.y)) && l.zh !== t, `label "${t}" uses the real name, sits on that building and has a Chinese name`);
}
ok(W.labels.every(l => !T.STREETS.some(s => { const r = T.streetRect(s); return l.x > r.x0 && l.x < r.x1 && l.y > r.y0 && l.y < r.y1; })), `none of the ${W.labels.length} building labels sits on a street`);
ok(!W.labels.some(l => /^BUILDING \w+$/.test(l.t)), 'no numbered names like "BUILDING 8" (the RMIT campus gets a single RMIT UNIVERSITY label)');
const mcOutline = W.buildings.filter(b => b.name === 'Melbourne Central' && b.area > 5000), mcTower = W.buildings.find(b => b.name === 'Melbourne Central office tower');
if (data.buildings.some(b => b.name === 'Melbourne Central' && b.height_m >= 200) && mcTower) {
  ok(mcOutline.length && mcOutline.every(b => b.h < 60) && mcTower.h >= 200, `the Melbourne Central complex outline is no longer drawn at 211 m (${mcOutline.map(b => b.h).join(' / ')} m); the tower inside is still ${mcTower.h} m`);
} else ok(true, 'no 211 m Melbourne Central outline in the data, skipped');
ok(W.landmarks.every(l => W.buildings.some(b => b.name === T.LANDMARK_HOST[l.kind] && T.inPoly(b.pts, l.x, l.y))), `the kept landmarks (${W.landmarks.map(l => l.kind).join(', ') || 'none'}) all sit inside their real buildings`);
ok(W.parks.some(p => p.kind === 'lawn' && p.x0 === 15), 'the State Library forecourt lawn is kept');

// 6 Fallback: bad / missing data → the page keeps the procedurally generated city
let threw = false, empties = [];
try { empties = [null, {}, { buildings: 'x' }, { buildings: [{ footprint: [[1, 2]] }, { footprint: [['a', 'b'], [1, 2], [3, 4]] }, null] }].map(d => T.buildWorldReal(d, T.geoToWorld).buildings.length); } catch (e) { threw = e.message; }
ok(!threw && empties.every(v => v === 0) && 0 < T.REAL_MIN, `bad data does not throw and draws no buildings (${empties.join(',')}); the page falls back to the procedurally generated city via REAL_MIN${threw ? ': ' + threw : ''}`);
const S = T.buildWorld(), GS = T.buildGrids(S);
ok(S.buildings.length > 100 && S.buildings.every(b => !b.pts) && !S.real && GS.cls.length === n, `the procedurally generated city still works (${S.buildings.length} rectangular buildings, no pts)`);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
