// Whole-CBD map on the real network: the queue's road (upstreamPath), metres ↔ page units (K_UPM), and the ripple filter (rippleLinks)
// on a real engine run of the demo plan (Lonsdale St westbound 08:00, one lane). Called by tests/test_t27.py; one ✅ / ❌ line
// per assertion, no network access.
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
const ctx = {};
vm.createContext(ctx);
vm.runInContext(m[1] + '\n;globalThis.G={geoToWorld,linkPts,K_UPM,upstreamIndex,upstreamPath,pathAt,pathSub,rippleLinks};', ctx);
const { linkPts, K_UPM, upstreamIndex, upstreamPath, pathAt, pathSub, rippleLinks } = ctx.G;

const net = JSON.parse(readFileSync(APPS + 'roads/public/cbd/network.json', 'utf8'));
const byId = new Map(net.links.map(l => [l.id, l]));
const byTo = upstreamIndex(net.links);
const plen = P => P.reduce((a, p, i) => i ? a + Math.hypot(p[0] - P[i - 1][0], p[1] - P[i - 1][1]) : 0, 0);

// 1 metres ↔ page units: the scale bar and every "m" on the map go through K_UPM
let pu = 0, mm = 0;
for (const l of net.links) { const P = linkPts(l); if (!P || !(l.len_m > 20) || P.some(p => p[1] > 0)) continue; pu += plen(P); mm += l.len_m; }
ok(Math.abs(pu / mm - K_UPM) / K_UPM < 0.01, `K_UPM ${K_UPM} = page units per real metre on network.json south of La Trobe (${(pu / mm).toFixed(4)}), within 1 %`);

// 2 the queue's road for the demo plan
const { demoPlan } = await import(pathToFileURL(APPS + 'engine/public/js/backend.js').href);
const worksId = demoPlan('lonsdale').worksites[0].links[0], works = byId.get(worksId);
ok(works && works.name === 'Lonsdale Street', `demo works link ${worksId} is on Lonsdale Street`);
const path = upstreamPath(byTo, works, 3000);
const sumLen = path.ids.reduce((a, id) => a + (+byId.get(id).len_m || 0), 0);
ok(path.ids.length > 0 && path.ids.every(id => byId.get(id).name === 'Lonsdale Street'), `the path walks ${path.ids.length} links, all Lonsdale Street`);
ok(Math.abs(path.reach - sumLen) < 1e-6, `reach ${Math.round(path.reach)} m = the sum of the walked links' len_m (${Math.round(sumLen)} m)`);
ok(path.end === 'Spring Street' && path.reach < 918, `the street runs out at ${path.end} after ${Math.round(path.reach)} m — a 918 m queue is drawn to there, not stretched`);
const drawn = Math.min(918, path.reach), Q = pathSub(path, drawn);
ok(drawn <= sumLen + 1e-6, `reverse: the drawn queue (${Math.round(drawn)} m) is not longer than the real links it passes (${Math.round(sumLen)} m)`);
ok(Math.abs(plen(Q) / K_UPM - drawn) / drawn < 0.06, `the drawn line is ${Math.round(plen(Q) / K_UPM)} m on the page for ${Math.round(drawn)} m of queue (within 6 %)`);
const P0 = linkPts(works), far = pathAt(path, path.reach);
ok(far[0] > P0[0][0] && far[0] < 750, `it runs upstream (east, the traffic comes from there) to x ${Math.round(far[0])}, inside CITY`);
ok(pathAt(path, 1e6)[0] === far[0], 'past the end the point stays at the end (never extrapolated)');

// 3 the ripple drawn for a real run: no background queues
const file = p => APPS + p.replace(/^\//, '');
const fakeFetch = async url => (existsSync(file(url)) ? { ok: true, status: 200, json: async () => JSON.parse(readFileSync(file(url), 'utf8')) } : { ok: false, status: 404 });
const noImporter = async url => { throw new Error('404 ' + url); };
const { connect } = await import(pathToFileURL(APPS + 'engine/public/js/backend.js').href);
const be = await connect({ fetch: fakeFetch, importer: noImporter });
const s = await be.run(be.demo('lonsdale'));
const L = s.raw.links, rip = new Set(rippleLinks(L, worksId).map(r => r.id));
const bg = L.filter(l => /^(Flinders|King) Street$/.test((byId.get(l.id) || {}).name || '') && (l.v || 0) * (l.delay_s || 0) / 60 >= 60);
ok(L.every(l => typeof l.extra_min === 'number'), `raw.links carry extra_min (computed by the engine) — ${L.length} links`);
ok(bg.length > 0 && bg.every(l => !rip.has(l.id)), `reverse: the ${bg.length} Flinders / King St links queued against free flow (up to ${Math.round(Math.max(...bg.map(l => l.v * l.delay_s / 60)))} veh·min) are not drawn as this plan's ripple`);
const R = rippleLinks(L, worksId), red = R.filter(r => r.sev === 2), qd = L.filter(l => l.queue_m > 0 && l.extra_min < 60 && l.id !== worksId);
ok(red.every(r => r.ex >= 60) && qd.length > 0 && qd.every(l => !red.some(r => r.id === l.id)), `reverse: red = ≥ 60 extra veh·min only (${red.length} links); the ${qd.length} links that queue anyway but gain < 60 are not red`);
ok(rip.size > 0 && !rip.has(worksId), `the ripple still has ${rip.size} links (≥ 2 extra veh·min), not the works link itself`);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
