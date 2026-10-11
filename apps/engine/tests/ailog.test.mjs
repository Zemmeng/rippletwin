// AI call log (the page's "AI road users · what each one read" and "AI call log" panels): aiLog() / onAiLog() / readingsOf() / lastReadings() in backend.js.
// Uses a fake reader (returns file / llm / kv by persona; delivery throws a plain error → rule fallback), offline, no LLM calls
import { readFileSync, existsSync } from 'node:fs';
import { ok, t, done } from './_t.mjs';
import { connect, PATHS, AI_LOG_MAX } from '../public/js/backend.js';
import { mockReadSigns } from '../public/js/index.js';

const APPS = new URL('../../', import.meta.url);
const file = p => new URL('.' + p, APPS);
if (!existsSync(file(PATHS.network))) { ok(false, 'apps/roads/public/cbd/network.json not found'); done(); }
const noImporter = async url => { throw new Error('404 ' + url); };
function counting() {
  const calls = [];
  const f = async url => { calls.push(String(url)); return existsSync(file(url)) ? { ok: true, status: 200, json: async () => JSON.parse(readFileSync(file(url), 'utf8')) } : { ok: false, status: 404 }; };
  return { f, calls };
}
const SRC = { commuter: 'file', local: 'llm', tourist: 'kv' };
let readerCalls = 0;
const fakeReader = async req => {
  readerCalls++;
  if (req.persona === 'delivery') throw new Error('crypto.subtle missing'); // no .code → the wiring layer switches to the rule reader
  const r = await mockReadSigns(req);
  return { ...r, src: SRC[req.persona], model: 'fake-model', prompt_v: 'p1', range: { notice: [0.5, 0.9], understand: [0.6, 1], trust: [0.4, 0.8] } };
};

await t('aiLog: one entry per reader call, rule fallbacks recorded truthfully', async () => {
  readerCalls = 0;
  const { f, calls } = counting();
  const seen = [];
  const be = await connect({ fetch: f, importer: noImporter, readSigns: fakeReader, onAiLog: e => seen.push(e) });
  await be.pedsReady();
  const n0 = calls.length;
  const s = await be.run(be.demo('lonsdale'));
  const log = be.aiLog();
  ok(log.length === readerCalls && readerCalls > 0 && seen.length === log.length, `log entries = reader calls (${log.length} = ${readerCalls}), onAiLog received ${seen.length}`);
  ok(log.every((e, i) => e.seq === i + 1 && typeof e.t === 'string' && !Number.isNaN(Date.parse(e.t)) && Number.isFinite(e.ms) && e.ms >= 0), 'each entry has an increasing seq, ISO time and ms');
  ok(log.every(e => ['commuter', 'local', 'tourist', 'delivery'].includes(e.persona) && Array.isArray(e.signs) && e.signs.length && Array.isArray(e.roads) && Number.isFinite(e.kmh) && e.read_s.length === e.signs.length),
    'each entry carries persona / signs / roads / kmh / read_s (seconds per sign)');
  const bySrc = p => log.filter(e => e.persona === p).map(e => e.src);
  ok(bySrc('commuter').every(x => x === 'file') && bySrc('local').every(x => x === 'llm') && bySrc('tourist').every(x => x === 'kv'), 'src recorded as the reading gives it (file / llm / kv), not rewritten');
  const dl = log.filter(e => e.persona === 'delivery');
  ok(dl.length > 0 && dl.every(e => e.src === 'rule' && e.fallback === 'crypto.subtle missing' && e.reading?.src === 'rule'), `negative: reader throws a plain error, rules used → recorded as src: rule + fallback reason (${dl.length} entries), never passed off as the LLM`);
  ok(calls.length === n0, `negative: run() + aiLog() send no extra requests (fetch calls ${n0} → ${calls.length})`);
  const rd = be.readingsOf(s);
  ok(calls.length === n0, 'negative: readingsOf() sends no requests');
  ok(rd && rd.street === s.street && rd.worksite === s.approaches[s.main].worksite, `readingsOf(s): main approach ${rd?.street}`);
  const c = rd?.personas?.commuter;
  ok(c && c.src === 'file' && c.reading.why && c.reading.range.notice[0] === 0.5 && c.model === 'fake-model' && Number.isFinite(c.ms), 'commuter: reading carries range / model / ms, src = file');
  ok(c && c.signs.map(x => x.kind).join(',') === 'vms,sign,arrow', `signs in driving order (far → near): ${c?.signs.map(x => x.kind)}`);
  ok(rd.personas.local.src === 'llm' && rd.personas.tourist.src === 'kv' && rd.personas.delivery.src === 'rule' && rd.personas.delivery.fallback, 'each persona\'s source (delivery is the rule fallback, with fallback)');
  ok(c.reading.why === s.why.commuter, 'the reading\'s why equals summary.why (same approach, same request)');
  rd.personas.commuter.reading.why = 'MUTATED';
  ok(be.readingsOf(s).personas.commuter.reading.why !== 'MUTATED' && be.aiLog()[0].reading?.why !== 'MUTATED', 'returns copies: page changes do not affect the next call');
  ok(be.lastReadings()?.street === rd.street && be.readingsOf({}) === null && be.readingsOf(null) === null, 'lastReadings() = the latest run; a summary not from run() → null');
  const before = be.aiLog().length;
  await be.run(be.demo('lonsdale'));
  ok(be.aiLog().length === before, 'same plan run again: the engine cached the readings, so no new requests or entries');
});

await t('aiLog: bounded ring buffer; unsubscribe works; callback errors do not affect readings', async () => {
  readerCalls = 0;
  const { f } = counting();
  const got = [];
  const be = await connect({ fetch: f, importer: noImporter, readSigns: fakeReader, aiLogMax: 5 });
  const off = be.onAiLog(e => got.push(e.seq));
  be.onAiLog(() => { throw new Error('page bug'); });
  const s = await be.run(be.demo('lonsdale'));
  const log = be.aiLog();
  ok(readerCalls > 5 && log.length === 5 && log[4].seq === readerCalls && log[0].seq === readerCalls - 4, `limit 5: ${readerCalls} calls, only the last 5 kept (seq ${log[0]?.seq}–${log[4]?.seq})`);
  ok(got.length === readerCalls && s.flags.failed === 0, `subscriber received ${got.length}; another callback threw, all readings still obtained (failed ${s.flags.failed})`);
  off();
  const n = got.length;
  await be.run(be.demo('latrobe'));
  ok(readerCalls > n && got.length === n, `nothing received after unsubscribing (${readerCalls - n} more calls, subscriber still at ${got.length})`);
  ok(AI_LOG_MAX === 200, 'default limit 200 entries');
});

await t('aiLog: an invalid request (SignError) is logged as src: error and rethrown', async () => {
  const be = await connect({ fetch: counting().f, importer: noImporter, readSigns: async req => { if (req.persona === 'tourist') { const e = new Error('bad'); e.code = 'bad_kind'; throw e; } return mockReadSigns(req); } });
  const s = await be.run(be.demo('lonsdale'));
  const bad = be.aiLog().filter(e => e.persona === 'tourist');
  ok(bad.length > 0 && bad.every(e => e.src === 'error' && e.error === 'bad_kind' && e.reading === null) && s.flags.failed > 0, `every tourist request throws bad_kind → ${bad.length} entries with src: error, flags.failed = ${s.flags.failed}`);
  const tr = be.readingsOf(s).personas.tourist;
  ok(tr.reading === null && tr.src === 'error', 'readingsOf: a persona without a reading has reading = null, src = error');
});

done();
