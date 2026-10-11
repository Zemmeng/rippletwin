// VMS test bench: the pure block of src/js/6d-vmslab.js (vlab-pure:begin…end) + planFrom() from 6-engine.js, running backend.js on the real network.
// Called by tests/test_vlab.py as node tests/vlab_glue.mjs; one ✅ / ❌ line per assertion, no network access. Numbers are logged, not pinned; the assertions check relationships
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WEB = HERE + '../', APPS = WEB + '../';
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log('✅ ' + msg); } else { fail++; console.log('❌ ' + msg); } };

const block = (f, tag) => { const m = readFileSync(WEB + 'src/js/' + f, 'utf8').match(new RegExp(`/\\* ${tag}:begin[^\\n]*\\n([\\s\\S]*?)/\\* ${tag}:end \\*/`)); ok(!!m, `${f} has a ${tag}:begin / ${tag}:end block`); return m ? m[1] : ''; };
const ctx = {};
vm.createContext(ctx);
vm.runInContext(block('6-engine.js', 'pure') + '\n' + block('6d-vmslab.js', 'vlab-pure') + '\n;globalThis.G={planFrom,parseFrame,vlRoad,vlCands,vlBest,vlBestShare,vlText,VL_AT,VL_WARN};', ctx);
const { planFrom, vlRoad, vlCands, vlBest, vlBestShare, vlText, VL_AT, VL_WARN } = ctx.G;

// 1 Road name → one sign line (≤ 10 characters); too long gives null rather than cutting mid-word
ok(vlRoad('Russell Street') === 'RUSSELL' || vlRoad('Russell Street') === 'RUSSELL ST', `Russell Street → ${vlRoad('Russell Street')}`);
ok(vlRoad('Little Lonsdale Street') === null && vlRoad('') === null, 'negative: still over 10 characters without "Street" (LITTLE LONSDALE) → null, not cut to half a word');

// 2 Real network: the page default plan (Lonsdale westbound 08:00, VMS 300 m upstream)
const file = p => APPS + p.replace(/^\//, '');
const fakeFetch = async url => (existsSync(file(url)) ? { ok: true, status: 200, json: async () => JSON.parse(readFileSync(file(url), 'utf8')) } : { ok: false, status: 404 });
const importer = async url => { if (!existsSync(file(url))) throw new Error('404 ' + url); return import(pathToFileURL(file(url)).href); };
const { connect } = await import(pathToFileURL(APPS + 'engine/public/js/backend.js').href);
const be = await connect({ fetch: fakeFetch, importer });
const ws0 = be.demo('lonsdale').worksites[0];
const EP = { link: ws0.links[0], street: 'Lonsdale Street', hour: 8, lanes: 1, all: false, foot: 'none', f1: 'ROADWORK\nAHEAD', f2: '', vmsAt: 300, sign: 'RIGHT LANE CLOSED', signAt: 100, arrowAt: 60, time: null };
const plan = (frames, at) => planFrom({ ...EP, f1: frames[0].join('\n'), f2: (frames[1] || []).join('\n'), vmsAt: at == null ? EP.vmsAt : at });
const b = await be.run(plan(VL_WARN));
const cands = vlCands(b), ks = cands.map(c => c.k);
ok(ks[0] === 'base' && ks.includes('vague') && ks.includes('avoid') && ks.includes('use') && ks.includes('save'), `candidate wordings: ${cands.map(c => vlText(c.frames)).join(' | ')}`);

// 3 Negative assertions: the minutes on the sign can never exceed what the engine computed
const stay = b.routes.find(r => r.id === 'stay'), alts = b.routes.filter(r => r.id !== 'stay').sort((x, y) => x.now_min - y.now_min);
const save = cands.find(c => c.k === 'save'), delay = cands.find(c => c.k === 'delay');
const minOf = c => +/(\d+) MIN/.exec(c.frames.flat().join(' '))[1];
ok(save && save.road === alts[0].name && minOf(save) === Math.round(stay.now_min - alts[0].now_min), `SAVE minutes = engine's original route ${stay.now_min} min − ${alts[0].name} ${alts[0].now_min} min (sign says ${save && minOf(save)})`);
ok(!delay || minOf(delay) === Math.round(b.mean_delay_s / 60), `DELAYS minutes = the engine's extra wait per vehicle ${b.mean_delay_s} s rounded to minutes`);
ok(cands.every(c => c.frames.length <= 2 && c.frames.every(f => f.length <= 3 && f.every(l => l.length <= 10))), 'every candidate is ≤ 2 frames × ≤ 3 lines × ≤ 10 characters');

// 4 Each one passes the sign check and is run through the engine; recommended = shortest queue and shorter than the baseline
const rows = [];
for (const c of cands) {
  const p = plan(c.frames), chk = be.check(p);
  ok(chk.every(x => x.ok) && !chk.some(x => (x.warnings || []).some(w => w.code === 'long_line' || w.code === 'many_lines')), `"${vlText(c.frames)}" passes the sign check with no long-line / too-many-lines warnings`);
  const s = c.k === 'base' ? b : await be.run(p);
  rows.push({ ...c, q: s.queue_m, share: s.detour_share });
}
const bi = vlBest(rows), base = rows[0];
console.log('   ' + rows.map(r => `${vlText(r.frames)} → ${r.q} m`).join(' · '));
ok(bi >= 0 && rows[bi].q === Math.min(...rows.map(r => r.q)) && rows[bi].q < base.q, `recommended "${bi >= 0 && vlText(rows[bi].frames)}" queue ${bi >= 0 && rows[bi].q} m, the shortest and shorter than the baseline ${base.q} m`);
ok(rows.find(r => r.k === 'vague').q >= rows.find(r => r.k === 'use').q, 'a vague message (EXPECT DELAYS) is no better than naming the detour road');
ok(vlBest([{ k: 'base', frames: VL_WARN, q: 100 }, { k: 'vague', frames: [['EXPECT', 'DELAYS']], q: 100 }]) === -1, 'negative: no wording shorter than the baseline → no recommendation (-1)');
ok(vlBest([{ k: 'base', frames: VL_WARN, q: 500 }, { k: 'save', frames: [['USE', 'RUSSELL'], ['SAVE', '9 MIN']], q: 90 }, { k: 'use', frames: [['USE', 'RUSSELL']], q: 90 }]) === 2, 'on a tie the shorter wording is recommended');

// 5 Placement: the recommended wording at each VL_AT position; past the turn-off (at ≤ turn_m) it is too late to turn, so no better than 300 m
const w = rows[bi], spots = [];
for (const at of VL_AT) { const s = await be.run(plan(w.frames, at)); spots.push({ at, q: s.queue_m, share: s.detour_share }); }
console.log('   ' + spots.map(p => `${p.at} m → ${p.q} m`).join(' · ') + ` · turn-off ${w.turn_m} m`);
const late = spots.filter(p => Number.isFinite(w.turn_m) && p.at <= w.turn_m), far = spots.find(p => p.at === 300);
ok(Number.isFinite(w.turn_m) && late.length >= 1 && late.every(p => p.q > far.q), `placed past the turn-off (${w.turn_m} m), ${late.map(p => p.at + ' m').join(', ')} give a longer queue than 300 m: drivers see it after passing the junction`);

// 6 SUMO primary, engine behind the scenes (docs/decisions.md D-1001-0045): on plans SUMO covers (this stretch of Lonsdale, 1 lane closed) each bench row does not show the engine's queue in metres;
//   it shows "AI sign reading → drivers who detour" (SUMO's input) instead; the title / notes say the effect is computed by SUMO in step 2; the recommendation is called "Strongest detour signal" and never mentions queues.
//   Uses the page's real 6d-vmslab.js in full (vlHTML / vlSuHTML) + the formatting lines from 6-engine.js + suPlan() from 8-compare.js, with the DOM stubbed
{
  ok(vlBestShare([{ k: 'base', frames: VL_WARN, share: 0.14 }, { k: 'save', frames: [['USE', 'RUSSELL'], ['SAVE', '9 MIN']], share: 0.6 }, { k: 'use', frames: [['USE', 'RUSSELL']], share: 0.6 }]) === 2
    && vlBestShare([{ k: 'base', frames: VL_WARN, share: 0.14 }, { k: 'vague', frames: [['EXPECT', 'DELAYS']], share: 0.14 }]) === -1
    && vlBestShare([{ k: 'base', frames: VL_WARN }, { k: 'use', frames: [['USE', 'RUSSELL']], share: 0.5 }]) === -1,
    'strongest detour signal = highest detour share, ties go to the shorter wording; none above the baseline, or the baseline has no reading → no recommendation (-1)');
  const cs = vlCands(b, true);
  ok(!cs.some(x => x.k === 'delay') && cs.length === cands.length - (cands.some(x => x.k === 'delay') ? 1 : 0) && cs.some(x => x.k === 'save'),
    `SUMO plans do not try "DELAYS N MIN" (N is the engine's per-vehicle delay); the other wordings are unchanged: ${cs.map(x => vlText(x.frames)).join(' | ')}`);
  const bs = vlBestShare(rows);
  ok(bs >= 0 && rows[bs].share === Math.max(...rows.map(r => r.share)) && rows[bs].share > base.share, `real network: the strongest detour signal is "${bs >= 0 && vlText(rows[bs].frames)}", ${bs >= 0 && Math.round(rows[bs].share * 100)}% would detour (baseline ${Math.round(base.share * 100)}%)`);
  const read = f => readFileSync(WEB + 'src/js/' + f, 'utf8');
  const ENG = read('6-engine.js'), fmt = ENG.slice(ENG.indexOf('const esc='), ENG.indexOf('const TYPES4='));
  const suSrc = (/function suPlan\(\)\{[^\n]*\}/.exec(read('8-compare.js')) || [''])[0], SUMO_LINK = (/const SUMO_LINK='([^']+)'/.exec(read('4c-sumo.js')) || [])[1];
  ok(suSrc && SUMO_LINK === EP.link, '8-compare.js has suPlan(), and SUMO_LINK in 4c-sumo.js is the demo plan\'s link');
  const H = n => Math.round(Number(n) || 0).toLocaleString('en-AU');
  const mk = ep => {
    const c = { console, EP: { ...ep }, BE: { api: be }, S: { step: 1 }, LANG: { cur: 'en' }, SUMO_LINK, document: { getElementById: () => null }, renderPanel() {}, engChanged() {}, engOn: () => true };
    c.L = (en, zh) => (c.LANG.cur === 'zh' ? zh : en);
    vm.createContext(c);
    vm.runInContext(block('6-engine.js', 'pure') + '\n' + fmt + '\n' + suSrc + '\n' + read('6d-vmslab.js') + '\n;globalThis.X={VL,vlKey};', c);
    const rs = c.suPlan() ? rows.filter(r => vlCands(b, true).some(x => x.k === r.k && vlText(x.frames) === vlText(r.frames))) : rows; // what vlRun() scores in each mode
    Object.assign(c.X.VL, { key: c.X.vlKey(), at: ep.vmsAt, busy: false, rows: rs, spots: spots.map(p => ({ ...p })), base: b, err: null, src: (b.flags && b.flags.reading_src) || '' });
    c.X.VL.best = (c.suPlan() ? vlBestShare : vlBest)(rs);
    return c;
  };
  const c = mk(EP), html = c.vlHTML();
  // Engine queues that must not appear: the queue for every wording and every placement (except values that coincide with a placement / turn-off distance), plus the numbers seen live
  const geo = new Set([...VL_AT, EP.vmsAt, w.turn_m].map(H));
  const qs = new Set([...rows, ...spots].map(r => r.q).filter(q => Number.isFinite(q) && q >= 10).map(H).filter(q => !geo.has(q)));
  const leak = [...qs].filter(q => html.includes(`${q} m`)).concat(['918', '509', '10,493', '18,693', '33,015', '79'].filter(n => new RegExp(`(?<![\\d,.])${n}(?![\\d]|,\\d)`).test(html)));
  ok(c.suPlan() && !leak.length && !/class="n">[\d,]+ m</.test(html), `negative: the bench on a SUMO plan shows no engine queues (checked ${[...qs].join(' / ')} m and 918 / 509 / 10,493 / 18,693 / 33,015 / 79)${leak.length ? ' — leaked ' + leak : ''}`);
  const cells = [...html.matchAll(/class="n">([^<]+)</g)].map(m => m[1]);
  ok(cells.length === c.X.VL.rows.length && cells.every(x => /^\d+%$/.test(x)) && cells.includes(`${Math.round(base.share * 100)}%`) && !/DELAYS \d+ MIN/.test(html), `each row shows the detour share: ${cells.join(' / ')} (no DELAYS N MIN)`);
  ok(html.includes('VMS lab · which words get drivers to detour') && html.includes('drivers who detour (AI sign reading)') && html.includes('the traffic effect is computed by SUMO in step 2')
    && html.includes(`Strongest detour signal: <b>${vlText(rows[bs].frames)}</b>`) && html.includes('computed by SUMO in step 2') && !/queue/i.test(html),
    'title / notes say "the effect is computed by SUMO in step 2"; the recommendation is called "Strongest detour signal"; no mention of queue anywhere');
  const chips = [...html.matchAll(/data-vlat="(\d+)"[^>]*>([^<]+)</g)].map(m => m[2]);
  ok(chips.length === VL_AT.length && chips.every(t => /^\d+ m · \d+%/.test(t)), `placement chips show the distance and the detour share: ${chips.join(' | ')}`);
  c.LANG.cur = 'zh'; const zh = c.vlHTML();
  ok(zh.includes('绕行信号最强') && zh.includes('AI 读牌 → 会绕行的司机') && zh.includes('第 2 步的 SUMO') && !/排队/.test(zh), 'Chinese: "strongest detour signal", "AI sign reading → drivers who detour", "computed by SUMO in step 2", no mention of queues');
  const e = mk({ ...EP, lanes: 2 }), he = e.vlHTML();
  ok(!e.suPlan() && he.includes(`${H(rows[0].q)} m`) && he.includes('engine estimate') && he.includes('Recommended') && !he.includes('SUMO'), 'plans outside SUMO coverage: still show the engine\'s queue in metres and "Recommended", labelled "engine estimate"');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
