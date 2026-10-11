// ui.js — canvas, controls and readouts. Uses the engine only through the sim.js exports (see the API table in README.md).
import { Sim, HALF, HOUR, DT, WZ, sigState, pathAt, hashStr } from './sim.js?v=5';

const DATA = await fetch('demand/demand_2921.json?v=5').then(r => { if (!r.ok) throw new Error('Cannot load demand/demand_2921.json: ' + r.status); return r.json(); });
const $ = s => document.querySelector(s);
const cv = $('#map'), ctx = cv.getContext('2d');
const base = document.createElement('canvas'), bctx = base.getContext('2d');
const trail = document.createElement('canvas'), tctx = trail.getContext('2d');
const COL = {};
let S = 600, K = S / 180, DPR = 1;
let sim = null, playing = false, speed = 180, budget = 0, lastTs = 0, lastUi = 0;
const RESULTS = {};
const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const pulses = [];
let seenEvents = 0;
const X = x => (x + HALF) * K, Y = y => (HALF - y) * K;
const pad = n => String(n).padStart(2, '0');
const MODES = [['car', 'Car'], ['bike', 'Bike'], ['tram', 'Tram'], ['ped', 'Pedestrian']];

function readColors() {
  const cs = getComputedStyle(document.documentElement);
  for (const n of ['block', 'footpath', 'road', 'mark', 'bikelane', 'platform', 'c-car', 'c-bike', 'c-tram', 'c-ped', 'c-conf', 'c-barrier', 'sig-g', 'sig-y', 'sig-r', 'ink', 'muted', 'panel']) COL[n] = cs.getPropertyValue('--' + n).trim();
}
function R(g, x0, x1, y0, y1, col) { g.fillStyle = col; g.fillRect(X(x0), Y(y1), (x1 - x0) * K, (y1 - y0) * K); }
function L(g, x0, y0, x1, y1) { g.beginPath(); g.moveTo(X(x0), Y(y0)); g.lineTo(X(x1), Y(y1)); g.stroke(); }

function drawBase() {
  const g = bctx; g.setTransform(DPR, 0, 0, DPR, 0, 0); g.clearRect(0, 0, S, S); g.globalAlpha = 1;
  R(g, -90, 90, -90, 90, COL.block);
  R(g, -90, 90, -15, 15, COL.footpath); R(g, -15, 15, -90, 90, COL.footpath);
  R(g, -90, 90, -9, 9, COL.road); R(g, -9, 9, -90, 90, COL.road);
  for (const [a, b] of [[-90, -9], [9, 90]]) { R(g, a, b, 7, 9, COL.bikelane); R(g, a, b, -9, -7, COL.bikelane); R(g, -9, -7, a, b, COL.bikelane); R(g, 7, 9, a, b, COL.bikelane); }
  R(g, -6.6, -3.9, 22, 55, COL.platform); R(g, 3.9, 6.6, -55, -22, COL.platform);
  g.strokeStyle = COL.mark; g.globalAlpha = 0.28; g.lineWidth = Math.max(0.6, 0.12 * K);
  for (const c of [-1.8, 1.8]) for (const o of [-0.72, 0.72]) { L(g, -90, c + o, 90, c + o); L(g, c + o, -90, c + o, 90); }
  g.globalAlpha = 0.55; g.lineWidth = Math.max(0.8, 0.15 * K);
  g.setLineDash([3 * K, 3 * K]);
  for (const y of [-3.6, 3.6]) { L(g, -90, y, -15, y); L(g, 15, y, 90, y); }
  L(g, 3.6, 15, 3.6, 90);
  g.setLineDash([]);
  for (const y of [-7, 7]) { L(g, -90, y, -15, y); L(g, 15, y, 90, y); }
  for (const x of [-7, 7]) { L(g, x, -90, x, -15); L(g, x, 15, x, 90); }
  g.globalAlpha = 0.8; g.fillStyle = COL.mark;
  for (let y = -8.75; y < 9; y += 1) { R(g, -13.5, -9.5, y, y + 0.5, COL.mark); R(g, 9.5, 13.5, y, y + 0.5, COL.mark); }
  for (let x = -8.75; x < 9; x += 1) { R(g, x, x + 0.5, 9.5, 13.5, COL.mark); R(g, x, x + 0.5, -13.5, -9.5, COL.mark); }
  g.globalAlpha = 0.9; g.lineWidth = Math.max(1, 0.4 * K);
  L(g, -14, 0.2, -14, 9); L(g, 14, -9, 14, -0.2); L(g, 0.2, 14, 9, 14); L(g, -9, -14, -0.2, -14);
  g.globalAlpha = 1;
  if (sim && sim.wz) drawWorkZone(g);
  const fs = Math.max(10, Math.min(15, 3.4 * K));
  g.fillStyle = COL.muted; g.textBaseline = 'middle';
  g.font = `600 ${fs}px Barlow Condensed, sans-serif`;
  g.textAlign = 'left'; g.fillText('LA TROBE ST', X(-86), Y(18.5));
  g.save(); g.translate(X(18.5), Y(86)); g.rotate(Math.PI / 2); g.fillText('SWANSTON ST', 0, 0); g.restore();
  g.font = `500 ${fs}px Barlow, sans-serif`; g.textAlign = 'center';
  g.fillText('Melbourne Central', X(-52), Y(-52)); g.fillText('State Library Victoria', X(52), Y(-70)); g.fillText('RMIT', X(52), Y(52));
  g.font = `600 ${fs * 0.8}px Barlow, sans-serif`; g.fillText('Tram stop', X(-22), Y(38)); g.fillText('Tram stop', X(22), Y(-38)); g.fillText('N ↑', X(83), Y(84));
}
function drawWorkZone(g) {
  const n = Math.round((WZ.x1 - WZ.x0) / 2);
  for (let i = 0; i < n; i++) { const x = WZ.x0 + i * 2; R(g, x, x + 2, -8.9, -7.1, i % 2 ? COL.mark : COL['c-barrier']); }
  g.fillStyle = COL['c-barrier'];
  for (let i = 0; i <= 5; i++) { const f = i / 5, x = 74 - 12 * f, y = -8.8 + 1.6 * f; g.beginPath(); g.arc(X(x), Y(y), Math.max(1.5, 0.45 * K), 0, Math.PI * 2); g.fill(); }
  R(g, 70, 82, -14, -11, '#1b1f22');
  if (K > 2.6) { g.fillStyle = '#ffb000'; g.font = `600 ${Math.max(8, 1.9 * K)}px IBM Plex Mono, monospace`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('BIKES MERGE', X(76), Y(-12.5)); }
}

function resize() {
  const w = $('#cw').clientWidth; S = Math.max(240, Math.floor(w)); DPR = Math.min(2, window.devicePixelRatio || 1);
  for (const c of [cv, base, trail]) { c.width = Math.round(S * DPR); c.height = Math.round(S * DPR); }
  cv.style.width = S + 'px'; cv.style.height = S + 'px'; K = S / 180;
  readColors(); drawBase(); clearTrail(); draw(0);
}
function clearTrail() { tctx.setTransform(1, 0, 0, 1, 0, 0); tctx.clearRect(0, 0, trail.width, trail.height); if (sim) for (const a of sim.agents) a.px = undefined; }

const tmp = { x: 0, y: 0, hx: 0, hy: 0 }, tmp2 = { x: 0, y: 0, hx: 0, hy: 0 };
function sDraw(a, f) { return a.sPrev + (a.s - a.sPrev) * f; }
function updateTrail(f) {
  tctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  tctx.globalCompositeOperation = 'destination-out'; tctx.globalAlpha = 1; tctx.fillStyle = 'rgba(0,0,0,0.16)'; tctx.fillRect(0, 0, S, S);
  tctx.globalCompositeOperation = 'source-over'; tctx.lineCap = 'round';
  for (const a of sim.agents) {
    pathAt(a.P, sDraw(a, f), tmp);
    if (a.px !== undefined) {
      tctx.strokeStyle = COL['c-' + a.mode]; tctx.globalAlpha = a.mode === 'ped' ? 0.3 : 0.42;
      tctx.lineWidth = Math.max(1, (a.mode === 'ped' ? 0.5 : a.w * 0.7) * K);
      tctx.beginPath(); tctx.moveTo(X(a.px), Y(a.py)); tctx.lineTo(X(tmp.x), Y(tmp.y)); tctx.stroke();
    }
    a.px = tmp.x; a.py = tmp.y;
  }
  tctx.globalAlpha = 1;
}
function draw(f) {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0); ctx.clearRect(0, 0, S, S);
  ctx.drawImage(base, 0, 0, S, S);
  if (!sim) return;
  ctx.fillStyle = COL['c-conf'];
  sim.events.forEach((e, i) => { const j = ((i * 7919) % 100) / 100 - 0.5, k = ((i * 104729) % 100) / 100 - 0.5; ctx.globalAlpha = 0.45; ctx.beginPath(); ctx.arc(X(e.x + j * 3), Y(e.y + k * 3), Math.max(2, 0.7 * K), 0, Math.PI * 2); ctx.fill(); });
  ctx.globalAlpha = 1;
  ctx.drawImage(trail, 0, 0, S, S);
  const sigPos = [['C', -16.5, 10.5], ['C', 16.5, -10.5], ['AB', 10.5, 16.5], ['A', -10.5, -16.5]];
  for (const [ph, x, y] of sigPos) { const s = sigState(ph, sim.t); ctx.fillStyle = s === 'G' ? COL['sig-g'] : s === 'Y' ? COL['sig-y'] : COL['sig-r']; ctx.beginPath(); ctx.arc(X(x), Y(y), Math.max(3, 1.1 * K), 0, Math.PI * 2); ctx.fill(); }
  ctx.lineCap = 'round';
  for (const a of sim.agents) {
    const s = sDraw(a, f);
    if (a.mode === 'ped') { pathAt(a.P, s, tmp); ctx.fillStyle = COL['c-ped']; ctx.beginPath(); ctx.arc(X(tmp.x), Y(tmp.y), Math.max(1.2, 0.33 * K), 0, Math.PI * 2); ctx.fill(); continue; }
    pathAt(a.P, s, tmp); pathAt(a.P, s - a.len, tmp2);
    ctx.strokeStyle = COL['c-' + a.mode]; ctx.lineWidth = Math.max(a.mode === 'bike' ? 1.6 : 2.5, a.w * K);
    ctx.lineCap = a.mode === 'tram' ? 'butt' : 'round';
    ctx.beginPath(); ctx.moveTo(X(tmp2.x), Y(tmp2.y)); ctx.lineTo(X(tmp.x), Y(tmp.y)); ctx.stroke();
  }
  const now = performance.now();
  for (let i = pulses.length - 1; i >= 0; i--) {
    const p = pulses[i], age = (now - p.at) / 1000; if (age > 1.2) { pulses.splice(i, 1); continue; }
    ctx.strokeStyle = COL['c-conf']; ctx.globalAlpha = 1 - age / 1.2; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(X(p.x), Y(p.y), (1.5 + 7 * age) * K, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function fmtClock(t) { const T = Math.max(0, Math.min(HOUR, t)); const h = sim.hour + Math.floor(T / 3600); return `${pad(h % 24)}:${pad(Math.floor(T / 60) % 60)}:${pad(Math.floor(T) % 60)}`; }
const fmtD = v => v == null ? '—' : v.toFixed(1) + ' s';
const fmtN = v => Math.round(v).toLocaleString('en-AU');
function ui() {
  $('#clock').textContent = fmtClock(sim.t);
  $('#prog').style.width = (Math.max(0, Math.min(1, sim.t / HOUR)) * 100).toFixed(2) + '%';
  const sm = sim.summary();
  $('#tb').innerHTML = MODES.map(([k, n]) => `<tr><td><span class="sw" style="background:var(--c-${k})"></span>${n}</td><td>${fmtN(sm.expected[k])}</td><td>${fmtN(sm.spawned[k])}</td><td>${fmtD(sm.delay[k])}</td></tr>`).join('');
  $('#queue').textContent = `${Math.round(sm.qEB)} / ${Math.round(sm.qWB)} m`;
  $('#outside').textContent = sm.outside;
  $('#nconf').textContent = sm.conflicts;
  $('#confby').innerHTML = Object.keys(sm.byLabel).length ? Object.entries(sm.byLabel).map(([l, n]) => `<div class="kv"><span>${l}</span><b>${n}</b></div>`).join('') : '<p class="hint">No conflicts yet.</p>';
  $('#evlist').innerHTML = sim.events.slice(-4).reverse().map(e => `<li><time>${fmtClock(e.t)}</time><span>${e.label}</span><span class="pill ${e.val < 0.5 ? 'sev' : 'mid'}">${e.kind === 'ttc' ? 'TTC' : 'PET'} ${e.val.toFixed(1)} s</span></li>`).join('');
}
function cmpCard() {
  const key = w => `${sim.day}-${sim.hour}-${w}`, a = RESULTS[key(0)], b = RESULTS[key(1)];
  if (!a || !b) { $('#cmp').innerHTML = '<p class="hint">After a full hour, turn on Work zone mode and run the same hour again to compare the two side by side here. Both runs see exactly the same arriving traffic and pedestrians; only the work zone differs.</p>'; return; }
  const rows = [['Average car delay', x => fmtD(x.delay.car)], ['Average bike delay', x => fmtD(x.delay.bike)], ['Average westbound car delay', x => fmtD(x.delayCarWB)], ['Cars queued off-screen, not yet entered', x => String(x.outside)], ['Conflicts', x => String(x.conflicts)], ['of which severe (< 0.5 s)', x => String(x.severe)]];
  $('#cmp').innerHTML = `<table><thead><tr><th>Metric</th><th>Normal</th><th>Work zone</th></tr></thead><tbody>${rows.map(([n, f]) => `<tr><td>${n}</td><td>${f(a)}</td><td>${f(b)}</td></tr>`).join('')}</tbody></table>`;
}
function finish() {
  playing = false; $('#play').textContent = 'Play';
  const sm = sim.summary(); RESULTS[`${sim.day}-${sim.hour}-${sim.wz ? 1 : 0}`] = sm;
  const d = $('#done'); d.hidden = false;
  d.innerHTML = `<b>${pad(sim.hour)}:00–${pad((sim.hour + 1) % 24)}:00 finished</b><br>Cars ${fmtN(sm.spawned.car)} · bikes ${fmtN(sm.spawned.bike)} · trams ${fmtN(sm.spawned.tram)} · pedestrians ${fmtN(sm.spawned.ped)}; average car delay ${fmtD(sm.delay.car)} · conflicts ${sm.conflicts}.${sim.wz ? '' : '<br>Turn on Work zone mode and run it again to see what changes.'}`;
  cmpCard(); ui();
}

function newSim(autoplay) {
  const hour = +$('#hour').value, day = document.querySelector('input[name=day]:checked').value, wz = $('#wz').checked;
  sim = new Sim({ data: DATA, hour, day, wz, seed: hashStr(day + ':' + hour) });
  while (sim.t < 0) sim.step();
  for (const a of sim.agents) a.sPrev = a.s;
  budget = 0; pulses.length = 0; seenEvents = 0;
  $('#done').hidden = true; $('#wzflag').hidden = !wz;
  $('#tl0').textContent = `${pad(hour)}:00`; $('#tl1').textContent = `${pad((hour + 1) % 24)}:00`;
  $('#meta').textContent = `${day === 'wd' ? 'Weekday average' : 'Weekend average'} · ${speedLabel()}`;
  drawBase(); clearTrail(); draw(0); ui();
  cmpCard();
  playing = !!autoplay; $('#play').textContent = playing ? 'Pause' : 'Play';
}
function speedLabel() { return { 180: '20 s / hour', 60: '1 min / hour', 10: '10× speed', 1: 'Real time' }[speed]; }

function tick(ts) {
  requestAnimationFrame(tick);
  const dtr = lastTs ? Math.min(0.25, (ts - lastTs) / 1000) : 0; lastTs = ts;
  if (!sim) return;
  let stepped = false;
  if (playing && sim.t < HOUR) {
    budget += dtr * speed; let n = 0;
    while (budget >= DT && sim.t < HOUR && n < 240) { sim.step(); budget -= DT; n++; stepped = true; }
    if (budget > DT * 4) budget = DT * 4;
    if (sim.t >= HOUR) { budget = 0; finish(); }
  }
  for (; seenEvents < sim.events.length; seenEvents++) { const e = sim.events[seenEvents]; pulses.push({ x: e.x, y: e.y, at: performance.now() }); }
  const f = playing ? Math.min(1, budget / DT) : 1;
  if (stepped || playing) updateTrail(f);
  draw(f);
  if (ts - lastUi > 200) { lastUi = ts; ui(); }
}

// controls
const hs = $('#hour');
for (let h = 0; h < 24; h++) { const o = document.createElement('option'); o.value = h; o.textContent = `${pad(h)}:00 – ${pad((h + 1) % 24)}:00`; if (h === 17) o.selected = true; hs.appendChild(o); }
hs.addEventListener('change', () => newSim(true));
document.querySelectorAll('input[name=day]').forEach(r => r.addEventListener('change', () => newSim(true)));
$('#wz').addEventListener('change', () => newSim(true));
document.querySelectorAll('input[name=spd]').forEach(r => r.addEventListener('change', () => { speed = +r.value; $('#meta').textContent = `${sim.day === 'wd' ? 'Weekday average' : 'Weekend average'} · ${speedLabel()}`; }));
$('#play').addEventListener('click', () => { if (sim.t >= HOUR) { newSim(true); return; } playing = !playing; $('#play').textContent = playing ? 'Pause' : 'Play'; });
$('#restart').addEventListener('click', () => newSim(true));

new ResizeObserver(() => resize()).observe($('#cw'));
const mq = window.matchMedia('(prefers-color-scheme: dark)');
const rethem = () => { readColors(); drawBase(); clearTrail(); };
mq.addEventListener && mq.addEventListener('change', rethem);
new MutationObserver(rethem).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

readColors();
newSim(false);
resize();
requestAnimationFrame(tick);
if (!reduce) setTimeout(() => { playing = true; $('#play').textContent = 'Pause'; }, 500);
