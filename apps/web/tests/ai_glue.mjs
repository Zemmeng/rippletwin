// AI panel (pure:begin…pure:end in src/js/9-ai.js): source labels, reading cards, call log, the downloaded JSON;
// then the real backend.js (fake sign reading: file / llm / kv / rules fallback) feeds aiLog() / readingsOf() into those pure functions. No network, no LLM calls
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WEB = HERE + '../';
const APPS = WEB + '../';
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log('✅ ' + msg); } else { fail++; console.log('❌ ' + msg); } };

const src = readFileSync(WEB + 'src/js/9-ai.js', 'utf8');
const eng = readFileSync(WEB + 'src/js/6-engine.js', 'utf8');
const m = src.match(/\/\* pure:begin[^\n]*\n([\s\S]*?)\/\* pure:end \*\//);
ok(!!m, '9-ai.js has a pure:begin / pure:end block');
// Take the page's own esc / TYPE_L / L (6-engine.js, 0-i18n.js) rather than writing a second copy in the test
const escLine = eng.match(/^const esc=.*$/m)?.[0], typeLine = eng.match(/^const TYPE_L=.*$/m)?.[0];
const i18n = readFileSync(WEB + 'src/js/0-i18n.js', 'utf8').replace("'use strict';", '');
ok(!!escLine && !!typeLine, 'esc() and TYPE_L taken from 6-engine.js');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(i18n + '\n' + escLine + '\n' + typeLine + '\n' + m[1] +
  '\n;globalThis.G={LANG,aiSrcLabel,aiSrcTone,aiExplainLabel,aiExplainTone,aiPct,aiSigns,aiAdvice,aiLabel,aiPersonaHTML,aiTileHTML,aiLogRowHTML,aiLogJSON,AI_LOG_KEEP,aiSrcOf,aiState};', ctx);
const G = ctx.G;
const zh = f => { G.LANG.cur = 'zh'; try { return f(); } finally { G.LANG.cur = 'en'; } };

// 1 Source labels (the step 3 cards, the log, and the pill / legend in 6-engine.js all use this one)
const lab = { file: 'LLM · precomputed', kv: 'LLM · cached', llm: 'LLM · live', rule: 'Rules · fallback' };
ok(Object.entries(lab).every(([k, v]) => G.aiSrcLabel(k) === v), `English labels: ${Object.values(lab).join(' / ')}`);
ok(zh(() => [G.aiSrcLabel('file'), G.aiSrcLabel('kv'), G.aiSrcLabel('llm'), G.aiSrcLabel('rule')].join('/')) === '大模型 · 预先算好/大模型 · 缓存/大模型 · 现场/规则 · 兜底', 'Chinese labels');
ok(G.aiSrcLabel('llm', 842.4) === 'LLM · live · 842 ms' && G.aiSrcLabel('file', 12) === 'LLM · precomputed', 'only live calls carry a duration');
ok(G.aiSrcLabel('mixed') === 'Mixed sources' && G.aiSrcLabel(null) === 'Unknown' && G.aiSrcLabel('deepseek-x') === 'deepseek-x', 'mixed / empty / unknown values passed through as is (the caller escapes them)');
ok(['file', 'kv', 'llm'].every(k => G.aiSrcTone(k) === 'ok') && G.aiSrcTone('rule') === 'warn' && G.aiSrcTone('error') === 'risk' && G.aiSrcTone('mixed') === 'warn', 'colours: LLM green, rules amber, error red');
ok(G.aiExplainLabel('llm') === 'AI explanation · LLM' && G.aiExplainLabel('kv') === 'AI explanation · LLM cached' && G.aiExplainLabel('rule') === 'AI explanation · rules' && G.aiExplainTone('rule') === 'warn', 'step 4 explanation source: LLM / cached / rules');
ok(!/'Sign reading · estimate'|LLM reader pending|大模型读屏待接/.test(eng) && (eng.match(/esc\(aiSrcLabel\(rs\.src\)\)/g) || []).length === 1 && (eng.match(/esc\(aiSrcLabel\(aiPlanSrc\(s,f\)\.src\)\)/g) || []).length === 3, 'the pill, the legend (EN and ZH) and the "assumptions" view in 6-engine.js all use aiSrcLabel(aiPlanSrc(…)) and no longer print the raw reading_src');
ok(!/aiSrcLabel\(f\.reading_src\)|aiSrcTone\(f\.reading_src\)/.test(eng), 'negative: the pill / legend no longer use flags.reading_src (that is the source of the 8 calibration readings, not of the plan on screen)');
ok(!/engBadges\([^)s]*\.flags\)|engBadges\(f\)/.test(eng), 'every engBadges() call passes the summary (source computed from this plan\'s readings)');

// 1b Sign-reading source for this plan: all 4 types agree → that source; disagree → mixed; any rules / failed reading → amber
const P = (...xs) => ({ personas: Object.fromEntries(['commuter', 'local', 'tourist', 'delivery'].map((t, i) => [t, xs[i] === null ? null : { src: xs[i], reading: xs[i] === 'none' ? null : { src: xs[i] } }])) });
ok(G.aiSrcOf(P('file', 'file', 'file', 'file')).src === 'file' && G.aiSrcOf(P('file', 'file', 'file', 'file')).tone === 'ok', 'all 4 types file → file, green');
ok(G.aiSrcOf(P('rule', 'rule', 'rule', 'rule')).src === 'rule' && G.aiSrcOf(P('rule', 'rule', 'rule', 'rule')).tone === 'warn', 'all 4 types rules → rules, amber');
ok(G.aiSrcOf(P('file', 'kv', 'llm', 'file')).src === 'mixed' && G.aiSrcOf(P('file', 'kv', 'llm', 'file')).tone === 'ok', 'a mix of LLM sources → mixed, still green');
ok(G.aiSrcOf(P('file', 'file', 'rule', 'file')).src === 'mixed' && G.aiSrcOf(P('file', 'file', 'rule', 'file')).tone === 'warn' && G.aiSrcOf(P('file', 'file', 'rule', 'file')).rule, 'one type on the rules fallback → mixed, amber');
ok(G.aiSrcOf(P('file', 'none', 'file', null)).tone === 'warn', 'one type failed to read → amber; a type with no signs does not count');
ok(G.aiSrcOf(P(null, null, null, null)).src === 'none' && G.aiSrcOf(null) === null, 'no signs on this road → none; no readings object → null (the caller decides)');
ok(G.aiSrcLabel('none') === 'None this hour' && zh(() => G.aiSrcLabel('none')) === '这个小时没有', 'label for none');
// 1c Panel state: same test as engPanel3; no road-user cards on error / invalid sign text / unfinished run
ok(G.aiState({ sum: {}, runErr: null, busy: false, badText: false }) === 'ok', 'current numbers present → ok');
ok(G.aiState({ sum: {}, runErr: new Error('x'), busy: false, badText: false }) === 'err', 'negative: run() failed but the previous EP.sum is kept → err (the previous plan\'s readings are not drawn)');
ok(G.aiState({ sum: {}, runErr: new Error('x'), busy: true, badText: false }) === 'ok', 're-running after an error → show the previous one, like the panel does');
ok(G.aiState({ sum: {}, runErr: null, busy: false, badText: true }) === 'bad' && G.aiState({ sum: null, runErr: null, busy: true, badText: false }) === 'wait', 'invalid sign text → bad; not finished → wait');

// 2 Sign text, advice, percentages
const signs = [{ kind: 'vms', frames: [['ROADWORK', 'AHEAD'], ['USE', 'RUSSELL ST']], read_s: 5 }, { kind: 'sign', text: 'RIGHT LANE CLOSED' }, { kind: 'arrow', text: 'ARROW LEFT' }];
ok(G.aiSigns(signs).map(s => s.text).join(' | ') === 'ROADWORK AHEAD ▸ USE RUSSELL ST | RIGHT LANE CLOSED | ARROW LEFT', 'VMS frames joined with ▸, in the order passed in');
ok(G.aiAdvice({ advice: { 'Russell Street': 'use' }, saving_min: 9 }) === 'use Russell St · save 9 min', `advice: ${G.aiAdvice({ advice: { 'Russell Street': 'use' }, saving_min: 9 })}`);
ok(G.aiAdvice({ advice: {}, saving_min: null, delay_min: null }) === 'no route advice' && zh(() => G.aiAdvice({ advice: {} })) === '没给路线建议', 'no route advice → "no route advice" (EN) / Chinese equivalent');
ok(G.aiAdvice({ advice: { 'Lonsdale Street': 'avoid', X: 'maybe' }, delay_min: 10 }) === 'avoid Lonsdale St · 10 min delay', 'avoid + minutes of delay; unknown advice values dropped');
ok(G.aiPct(0.853) === 85 && G.aiPct(1.7) === 100 && G.aiPct(-2) === 0 && G.aiPct('50%;background:url(x)') === null && G.aiPct(null) === null, 'percentages clamped to 0–100; non-numbers → null (never reach a style attribute)');
ok(G.aiLabel('<b>Guided</b> kit') === 'bGuided/b kit' && G.aiLabel('x'.repeat(80)).length === 60, 'plan names lose < > and are cut to 60 characters (the explain.js rule)');

// 3 Negative assertions (injection): sign text, road names and the model's reasoning never reach HTML unescaped
const evil = '<img src=x onerror=alert(1)>';
const card = G.aiPersonaHTML('commuter', { signs: [{ kind: 'vms', frames: [[evil]] }, { kind: 'sign', text: '<script>x()</script>' }], src: 'llm', ms: 900,
  reading: { notice: '0.8"><i onmouseover=1', understand: 0.9, trust: 0.7, advice: { [evil]: 'use' }, saving_min: 3, why: 'WHY<svg onload=1>TEXT', range: { notice: [0.6, 0.9], understand: ['<', 1], trust: [0.5, 0.8] } } });
ok(!/<img|<script|<svg|onmouseover=1/.test(card) && card.includes('&lt;img'), 'reading card: sign text / road names / reading fields all escaped, no executable tags');
ok(!card.includes('WHY') && card.includes('data-aiwhy="commuter"'), 'the reasoning (why) stays out of the HTML and is left for textContent (data-aiwhy)');
ok(card.includes('LLM · live · 900 ms') && card.includes('50–80%') && !card.includes('NaN'), 'card shows source + duration and the trust range; a broken range is not drawn');
ok(G.aiPersonaHTML('tourist', null).includes('No signs on this road') && G.aiPersonaHTML('delivery', { signs, src: 'error', reading: null }).includes('not persuaded'), 'no signs / failed reading each get a one-line message');
const row = G.aiLogRowHTML({ t: '2026-09-29T12:00:00Z', persona: '<b>x</b>', signs: [{ kind: 'sign', text: evil }], src: '<i>', ms: 5, reading: { advice: { [evil]: 'avoid' } } });
ok(!/<img|<b>x|<i>/.test(row), 'log row: persona, sign text, source and advice all escaped');
ok(!G.aiPersonaHTML('__proto__', null).includes('undefined'), 'an unknown persona type does not resolve up the prototype chain');
const tile = G.aiTileHTML('commuter', { signs: [{ kind: 'vms', frames: [[evil]] }], src: 'llm', ms: 900,
  reading: { notice: 0.98, understand: '0.9"><i onmouseover=1', trust: 0.92, advice: { [evil]: 'use' }, saving_min: 3, why: 'WHY<svg onload=1>TEXT' } }, true);
ok(!/<img|<svg|onmouseover=1/.test(tile) && tile.includes('98<small>%</small>') && tile.includes('92<small>%</small>') && tile.includes('—') && !tile.includes('WHY'),
  'tile: three readings (a broken one shows —), route advice escaped; the reasoning stays out of the tile (only the opened card writes it via textContent)');
ok(tile.includes('class="metric ai-tile on"') && tile.includes('aria-expanded="true"') && tile.includes('data-aip="commuter"')
  && G.aiTileHTML('tourist', null, false).includes(' disabled') && G.aiTileHTML('delivery', { signs, src: 'error', reading: null }, false).includes('not persuaded'),
  'tile: the selected one has .on / aria-expanded; types with no signs cannot be clicked; a failed reading gets a line');
ok(!G.aiTileHTML('local', { src: 'llm', reading: { notice: .9, understand: .9, trust: .9 } }, false, false).includes('ai-tadv') && G.aiTileHTML('local', { src: 'llm', reading: { notice: .9, understand: .9, trust: .9 } }, false).includes('ai-tadv'),
  'when none of the four types got route advice, the tiles do not each repeat it (adv=false); by default it is shown');

// 4 Downloaded JSON: allow-listed fields only (negative: extra header / token fields on a log entry never reach the file)
const fake = 'sk' + '-' + 'Z'.repeat(24);
const log = [{ seq: 1, t: '2026-09-29T12:00:00Z', persona: 'commuter', signs, roads: ['Lonsdale St', 'Russell St'], kmh: 40, read_s: [5, 4, 4], src: 'llm', model: 'm1', ms: 812,
  reading: { notice: 0.8, understand: 0.9, trust: 0.7, advice: { 'Russell St': 'use' }, saving_min: 9, delay_min: null, why: 'Told to use Russell.', src: 'llm', model: 'm1', prompt_v: 'r1', raw: fake },
  authorization: 'Bearer ' + fake, headers: { 'x-api-key': fake }, token: fake }];
let parsed = null;
try { parsed = JSON.parse(G.aiLogJSON(log, { exported_at: '2026-09-29T12:01:00Z', lang: 'en', secret: fake })); } catch { parsed = null; }
ok(parsed && parsed.count === 1 && parsed.entries[0].reading.why === 'Told to use Russell.' && parsed.entries[0].signs[1].text === 'RIGHT LANE CLOSED' && parsed.entries[0].ms === 812, 'the download is valid JSON with the count, readings, sign text and duration');
const txt = G.aiLogJSON(log, { secret: fake });
ok(!txt.includes(fake) && !/authorization|headers|token|x-api-key|"raw"|"secret"/i.test(txt), 'negative: extra authorization / headers / token / raw / meta.secret never reach the file');
ok(JSON.parse(G.aiLogJSON(null)).count === 0 && G.AI_LOG_KEEP === 200, 'an empty log still exports; the page keeps at most 200 entries (same as backend.js)');

// 5 Real backend.js: fake sign reading → aiLog() / readingsOf() → the page's pure functions
const file = p => APPS + p.replace(/^\//, '');
const fakeFetch = async url => (existsSync(file(url)) ? { ok: true, status: 200, json: async () => JSON.parse(readFileSync(file(url), 'utf8')) } : { ok: false, status: 404 });
const noImporter = async url => { throw new Error('404 ' + url); };
if (!existsSync(file('/roads/public/cbd/network.json'))) ok(false, 'apps/roads/public/cbd/network.json not found');
else {
  const { connect } = await import(pathToFileURL(APPS + 'engine/public/js/backend.js').href);
  const { mockReadSigns } = await import(pathToFileURL(APPS + 'engine/public/js/index.js').href);
  const S = { commuter: 'file', local: 'llm', tourist: 'kv' };
  const be = await connect({ fetch: fakeFetch, importer: noImporter, readSigns: async req => {
    if (req.persona === 'delivery') throw new Error('no crypto.subtle');
    return { ...(await mockReadSigns(req)), src: S[req.persona], model: 'fake', range: { notice: [0.5, 0.9], understand: [0.6, 1], trust: [0.4, 0.8] } };
  } });
  const s = await be.run(be.demo('lonsdale'));
  const rd = be.readingsOf(s), lg = be.aiLog();
  const cards = ['commuter', 'local', 'tourist', 'delivery'].map(t => G.aiPersonaHTML(t, rd.personas[t]));
  ok(rd && cards[0].includes('LLM · precomputed') && cards[1].includes('LLM · live') && cards[2].includes('LLM · cached') && cards[3].includes('Rules · fallback') && cards[3].includes('Reader error'),
    `sources on the 4 cards: file / llm / kv / rules fallback (main link ${rd?.street})`);
  ok(cards[0].indexOf('VMS') < cards[0].indexOf('RIGHT LANE CLOSED'), 'signs on a card are in passing order: VMS first, then the static sign');
  const out = JSON.parse(G.aiLogJSON(lg, {}));
  ok(lg.length > 0 && out.count === lg.length && out.entries.every(e => e.persona && e.src && Array.isArray(e.signs)), `real log ${lg.length} entries → download file ${out.count} entries`);
  ok(lg.map(G.aiLogRowHTML).every(h => h.includes('class="ai-row"')), 'every log entry renders as a row');
  ok(G.aiSrcOf(rd).src === 'mixed' && G.aiSrcOf(rd).tone === 'warn', 'real backend: file / llm / kv / rules mixed → badge says mixed, amber');

  // Review reproduction: the 8 calibration readings come from file, while every reading for the plan on screen goes through rules → flags.reading_src says file, the badge must say rules
  const { anchorRequest } = await import(pathToFileURL(APPS + 'engine/public/js/calibrate.js').href);
  const calib = new Set(['lo', 'hi'].flatMap(w => ['commuter', 'local', 'tourist', 'delivery'].map(t => JSON.stringify(anchorRequest(w, t).signs))));
  const be2 = await connect({ fetch: fakeFetch, importer: noImporter, readSigns: async req => ({ ...(await mockReadSigns(req)), src: calib.has(JSON.stringify(req.signs)) ? 'file' : 'rule' }) });
  const s2 = await be2.run(be2.demo('lonsdale')), rs2 = G.aiSrcOf(be2.readingsOf(s2));
  ok(s2.flags.reading_src === 'file' && rs2 && rs2.src === 'rule' && rs2.tone === 'warn', `calibration readings ${s2.flags.reading_src}, plan readings ${rs2 && rs2.src} → the badge follows the plan (rules · fallback, amber)`);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
