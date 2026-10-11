// Pure functions of the page's wiring layer (the /* pure:begin */…/* pure:end */ block in src/js/6-engine.js), plus running the engine on the real network with the plans they build.
// Called by tests/test_engine.py as node tests/engine_glue.mjs; one ✅ / ❌ line per assertion, no network access
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WEB = HERE + '../';
const APPS = WEB + '../';
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log('✅ ' + msg); } else { fail++; console.log('❌ ' + msg); } };

const src = readFileSync(WEB + 'src/js/6-engine.js', 'utf8');
const m = src.match(/\/\* pure:begin[^\n]*\n([\s\S]*?)\/\* pure:end \*\//);
ok(!!m, '6-engine.js has a pure:begin / pure:end block');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(m[1] + '\n;globalThis.G={geoToWorld,dirOf,pickLink,parseFrame,planFrom,formFromPlan,linkPts,NO_WORKS,WORKS_TIME};', ctx);
const { geoToWorld, dirOf, pickLink, parseFrame, planFrom, formFromPlan, linkPts, NO_WORKS } = ctx.G;

const net = JSON.parse(readFileSync(APPS + 'roads/public/cbd/network.json', 'utf8'));
const nodes = new Map(net.nodes.map(n => [n.id, n]));
const namesAt = new Map();
for (const l of net.links) for (const n of [l.from, l.to]) { if (!namesAt.has(n)) namesAt.set(n, new Set()); namesAt.get(n).add(l.name); }
const corner = (a, b) => { const ps = [...namesAt].filter(([, s]) => s.has(a) && s.has(b)).map(([id]) => nodes.get(id)); if (!ps.length) return null; return geoToWorld(ps.reduce((s, p) => s + p.lat, 0) / ps.length, ps.reduce((s, p) => s + p.lon, 0) / ps.length); };
const near = (p, x, y, tol) => p && Math.hypot(p[0] - x, p[1] - y) <= tol;

// 1 Real network coordinates → page world coordinates (the page draws an idealised Hoddle Grid: Swanston x=0, Russell 200, Elizabeth −200; La Trobe y=0, Lonsdale −200)
const c1 = corner('Swanston Street', 'La Trobe Street'), c2 = corner('Russell Street', 'Lonsdale Street'), c3 = corner('Elizabeth Street', 'Lonsdale Street');
// A'Beckett joins at an angle at the Swanston end (real geometry); the stretch to the west is straight, and the page draws it at y=200
const ab = net.links.filter(l => l.name === "A'Beckett Street").flatMap(l => linkPts(l) || []).filter(p => p[0] < -60 && p[0] > -320);
ok(near(c1, 0, 0, 3), `Swanston × La Trobe → (${c1?.map(v => v.toFixed(1))}) ≈ (0, 0)`);
ok(near(c2, 200, -200, 3), `Russell × Lonsdale → (${c2?.map(v => v.toFixed(1))}) ≈ (200, −200)`);
ok(near(c3, -200, -200, 3), `Elizabeth × Lonsdale → (${c3?.map(v => v.toFixed(1))}) ≈ (−200, −200)`);
ok(ab.length >= 4 && ab.every(p => Math.abs(p[1] - 200) < 8), `A'Beckett (the straight stretch west of Swanston, ${ab.length} points) lands at page y=200 ± 8`);

// 2 Link picking: drive on the left, so the side of the street you click picks the direction
const cands = net.links.map(l => ({ id: l.id, pts: linkPts(l), hw: l.highway })).filter(c => c.pts);
const byId = new Map(net.links.map(l => [l.id, l]));
// Lonsdale is a dual carriageway in OSM: one westbound line (y≈−206) and one eastbound line (y≈−195.5)
const south = pickLink(cands, 118, -209, 12), north = pickLink(cands, 118, -193, 12);
ok(south && byId.get(south).name === 'Lonsdale Street' && dirOf(linkPts(byId.get(south))) === 'W', `click the south side of Lonsdale St → westbound link (${south})`);
ok(north && byId.get(north).name === 'Lonsdale Street' && dirOf(linkPts(byId.get(north))) === 'E', `click the north side of Lonsdale St → eastbound link (${north})`);
// Two-way street drawn as a single line (both directions share the geometry): drive on the left, so clicking on the left of the travel direction picks that direction
const twin = net.links.find(l => { const r = net.links.find(x => x.from === l.to && x.to === l.from); const p = linkPts(l); return r && p && p.length === 2 && !NO_WORKS.has(l.highway) && Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]) > 40 && p.every(q => Math.abs(q[0]) < 300 && Math.abs(q[1]) < 280); });
if (twin) {
  const p = linkPts(twin), mx = (p[0][0] + p[1][0]) / 2, my = (p[0][1] + p[1][1]) / 2, dx = p[1][0] - p[0][0], dy = p[1][1] - p[0][1], l = Math.hypot(dx, dy);
  const left = pickLink(cands, mx - dy / l * 4, my + dx / l * 4, 12), right = pickLink(cands, mx + dy / l * 4, my - dx / l * 4, 12);
  ok(left === twin.id && right !== twin.id && byId.get(right)?.from === twin.to, `single-line two-way ${twin.name}: click left of the travel direction → this direction, right → the opposite one`);
} else ok(false, 'no single-line two-way link found to test drive-on-the-left picking');
ok(pickLink(cands, 100, -150, 12) === null, 'click in the middle of a block (> 12 m from any road) → nothing picked');
const lane = net.links.find(l => NO_WORKS.has(l.highway) && l.geometry?.length >= 2);
if (lane) { const p = linkPts(lane), mid = [(p[0][0] + p[1][0]) / 2, (p[0][1] + p[1][1]) / 2]; const got = pickLink(cands.filter(c => c.id === lane.id), mid[0], mid[1], 12); ok(got === null, `laneways / footways (${lane.highway}) cannot be a works link`); }

// 3 Building the plan (docs/reference/interfaces.md, works plan format)
const EP = { link: 'l595594354_9756035316', street: 'Lonsdale Street', lanes: 1, hour: 8, f1: ' roadwork \n\n ahead ', f2: '', vmsAt: 300, sign: 'right lane  closed', signAt: 100, arrowAt: 60 };
const before = JSON.stringify(EP);
const plan = planFrom(EP), ws = plan.worksites[0], vms = ws.equipment.find(e => e.type === 'vms');
ok(JSON.stringify(EP) === before, 'planFrom does not modify page state');
ok(JSON.stringify(vms.frames) === '[["ROADWORK","AHEAD"]]' && vms.at_m === 300, 'sign text: upper-cased, blank lines and extra spaces removed, an empty second frame is not sent');
ok(ws.equipment.find(e => e.type === 'sign').text === 'RIGHT LANE CLOSED' && ws.equipment.some(e => e.type === 'arrow') && ws.equipment.some(e => e.type === 'barrier'), 'static sign upper-cased; arrow board and barriers present');
ok(ws.links[0] === EP.link && ws.closes.lanes === 1 && plan.when.hour === 8 && /^\d{4}-\d\d-\d\d$/.test(ws.time.from) && ws.time.hours.length === 2, 'link, lanes closed, time window and date all follow the interface spec');
ok(!planFrom({ ...EP, f1: '  \n ', f2: '' }).worksites[0].equipment.some(e => e.type === 'vms') && !planFrom({ ...EP, sign: ' ' }).worksites[0].equipment.some(e => e.type === 'sign'), 'negative: a blank VMS / static sign is left out, no empty text is sent');
ok(JSON.stringify(parseFrame('use\nrussell   st\n\n')) === '["USE","RUSSELL ST"]', 'parseFrame: one line per row');
// Footpath closure (closes.footpath in the interface spec): not sent by default; sent only when chosen; invalid values are not sent
ok(!('footpath' in planFrom(EP).worksites[0].closes) && !('footpath' in planFrom({ ...EP, foot: 'none' }).worksites[0].closes), 'negative: footpath open by default, closes.footpath not sent');
ok(planFrom({ ...EP, foot: 'left' }).worksites[0].closes.footpath === 'left' && planFrom({ ...EP, foot: 'both' }).worksites[0].closes.footpath === 'both', 'choosing "works side / both sides closed" → closes.footpath = left / both');
ok(!('footpath' in planFrom({ ...EP, foot: '<x>' }).worksites[0].closes), 'negative: an unknown footpath value is not sent to the engine');
ok(formFromPlan(planFrom({ ...EP, foot: 'left' })).foot === 'left' && formFromPlan(planFrom(EP)).foot === 'none', 'formFromPlan puts the footpath state back into the form');

// 4 The plan the page builds goes to the real backend.js (real network + parameters + sign reading, no network access)
const file = p => APPS + p.replace(/^\//, '');
const fakeFetch = async url => (existsSync(file(url)) ? { ok: true, status: 200, json: async () => JSON.parse(readFileSync(file(url), 'utf8')) } : { ok: false, status: 404 });
const importer = async url => { if (!existsSync(file(url))) throw new Error('404 ' + url); return import(pathToFileURL(file(url)).href); };
const { connect } = await import(pathToFileURL(APPS + 'engine/public/js/backend.js').href);
const be = await connect({ fetch: fakeFetch, importer });
const s0 = await be.run(planFrom(EP));
ok(s0.street === 'Lonsdale Street' && s0.queue_m > 0 && s0.mean_delay_s > 0 && s0.flags.sign_errors.length === 0, `page default plan (ROADWORK / AHEAD only): queue ${s0.queue_m} m, +${s0.mean_delay_s} s per vehicle`);
const s1 = await be.run(planFrom({ ...EP, f2: 'USE\nRUSSELL ST' }));
ok(s1.queue_m < s0.queue_m && s1.detour_share > s0.detour_share, `add a second frame USE / RUSSELL ST: queue ${s0.queue_m} → ${s1.queue_m} m, detour ${(s0.detour_share * 100).toFixed(0)}% → ${(s1.detour_share * 100).toFixed(0)}%`);
const bad = be.check(planFrom({ ...EP, f1: 'ROADWORKSAHEAD' }));
ok(bad.some(c => !c.ok), `14 characters on one line → check reports an error (${bad.find(c => !c.ok)?.error?.code}) and the page does not pass it to run`);
const all = await be.run(planFrom({ ...EP, lanes: byId.get(EP.link).lanes }));
ok(all.queue_m === 0 && all.detour_share > 0.99, `full closure: every vehicle diverts (detour ${(all.detour_share * 100).toFixed(0)}%)`);
const off = await be.run(planFrom({ ...EP, hour: 22 }));
ok(off.flags.inactive && off.queue_m === 0, '22:00 is outside the works hours → flags.inactive, numbers are 0');
const adv = await be.advise(planFrom(EP));
ok(adv.options.some(o => o.better && o.plan), `the advisor offers at least one better change (${adv.options.map(o => o.kind + ' ' + o.delta_min).join(' · ')})`);

// 5 Applying the advisor's change back to the form ("apply to my plan"): for a plan with no VMS the advisor adds one whose id is not VMS-1, and that must round-trip too
const noVms = { ...EP, f1: '', f2: '' };
const adv2 = await be.advise(planFrom(noVms)), opt = adv2.options.find(o => o.better && o.plan && o.kind === 'text');
if (opt) {
  const form = { ...noVms, ...formFromPlan(opt.plan) }, back = planFrom(form).worksites[0].equipment.find(e => e.type === 'vms');
  ok(back && JSON.stringify(back.frames) === JSON.stringify(opt.plan.worksites[0].equipment.find(e => e.type === 'vms').frames), `plan with no VMS takes the advisor's "${opt.frames.map(f => f.join(' / ')).join(' ▸ ')}": after applying it to the form, the plan really has that VMS`);
  const s2 = await be.run(planFrom(form));
  ok(s2.queue_m < (await be.run(planFrom(noVms))).queue_m, `re-run after applying: the queue really is shorter (→ ${s2.queue_m} m)`);
} else ok(false, 'for a plan with no VMS the advisor offered no text change');
ok(JSON.stringify(formFromPlan(null)) === '{}' && JSON.stringify(formFromPlan({ worksites: [{ equipment: [] }] })) === '{}', 'formFromPlan: an empty plan leaves the form unchanged');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
