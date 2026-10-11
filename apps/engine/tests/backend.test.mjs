// The backend.js wiring layer: network + flows + params + sign reader → the numbers the page needs.
// Uses the real files in the repo (road network, apps/api reader.js / check.js, params.json when present); URL fetches go through an injected fake fetch / importer, offline
import { readFileSync, existsSync } from 'node:fs';
import { ok, t, done } from './_t.mjs';
import { connect, demoPlan, summarize, PATHS, DEMO_NAMES } from '../public/js/backend.js';
const clone = x => JSON.parse(JSON.stringify(x));

const APPS = new URL('../../', import.meta.url); // apps/
const file = p => new URL('.' + p, APPS); // '/roads/public/…' → apps/roads/public/…
const has = p => existsSync(file(p));
if (!has(PATHS.network)) { ok(false, 'apps/roads/public/cbd/network.json not found'); done(); }
const fakeFetch = async url => (existsSync(file(url)) ? { ok: true, status: 200, json: async () => JSON.parse(readFileSync(file(url), 'utf8')) } : { ok: false, status: 404 });
const repoImporter = async url => { if (!existsSync(file(url))) throw new Error('404 ' + url); return import(file(url).href); };
const noImporter = async url => { throw new Error('404 ' + url); };
const T5 = has(PATHS.reader) && has(PATHS.check);

await t('connect: falls back when nothing loads (except the network)', async () => {
  const be = await connect({ fetch: async url => (url.includes('/roads/') ? fakeFetch(url) : { ok: false, status: 404 }), importer: noImporter });
  const st = be.status();
  ok(st.network === 'fetched' && st.reader === 'engine-mock' && st.check === 'none' && st.params === 'default' && st.errors.length === 3 && st.errors.some(e => e.startsWith('params: ')), `fallbacks: reader → engine rules, checkSigns → none, params → assumed values (${st.errors.length} status.errors)`);
  const s = await be.run(be.demo('lonsdale'));
  ok(s.queue_m > 0 && s.mean_delay_s > 0 && s.flags.ok && s.flags.reading_src === 'rule', `fallbacks still give numbers: queue ${s.queue_m} m, +${s.mean_delay_s} s per vehicle`);
  let threw = false;
  try { await connect({ fetch: async () => ({ ok: false, status: 404 }), importer: noImporter }); } catch { threw = true; }
  ok(threw, 'network unavailable → connect throws (nothing can be computed without it; must not pretend otherwise)');
});

await t('connect: same-origin paths + the repo sign reader and rule check (apps/api)', async () => {
  if (!T5) { ok(true, '(skipped: apps/api/public/js/reader.js not in the repo)'); return; }
  const be = await connect({ fetch: fakeFetch, importer: repoImporter });
  const st = be.status();
  ok(st.reader === 't5' && st.check === 't5' && st.params === (has(PATHS.params) ? 'params' : 'default'), `reader = apps/api, rule check = apps/api, params = ${st.params}`);
  const s = await be.run(be.demo('lonsdale'));
  ok(s.flags.failed === 0 && s.flags.missing === 0 && s.flags.sign_errors.length === 0 && be.demo('lonsdale').worksites[0].equipment.some(e => e.type === 'arrow'), `demo plan (with arrow board, readable by the apps/api reader): all readings obtained (failed ${s.flags.failed}, missing ${s.flags.missing}), sign text valid`);
  const c = await be.compare(be.demo('lonsdale', { frames: [['ROADWORK', 'AHEAD']] }), be.demo('lonsdale'));
  ok(c.delta.queue_m < 0 && c.delta.affected_min < 0 && c.after.routes.find(r => r.name === 'Russell Street').share > c.before.routes.find(r => r.name === 'Russell Street').share,
    `act 1: adding a USE / RUSSELL ST frame, queue ${c.before.queue_m} → ${c.after.queue_m} m, per vehicle ${c.before.mean_delay_s} → ${c.after.mean_delay_s} s`);
  const bad = await be.run(be.demo('lonsdale', { frames: [['ROADWORKSAHEAD']] }));
  ok(bad.flags.ok === false && bad.flags.sign_errors.length >= 1 && bad.flags.sign_errors[0].code, `a 14-character sign line → rule check error (${bad.flags.sign_errors[0]?.code}), flags.ok = false`);
  ok(be.check(be.demo('lonsdale')).every(c => c.ok), 'check(plan) can be called on its own (used while typing sign text)');
});

await t('summary definitions', async () => {
  const be = await connect({ fetch: fakeFetch, importer: noImporter });
  const s = await be.run(be.demo('lonsdale'));
  const veh = Object.values(s.by_type).reduce((a, x) => a + x.vehicles, 0);
  const aff = Object.values(s.by_type).reduce((a, x) => a + x.delay_min, 0);
  ok(Math.abs(s.mean_delay_s - Math.round((aff / veh) * 60)) <= 1 && s.affected_min + s.others_min >= s.delay_min - 2 && s.affected_min < s.delay_min,
    `seconds per vehicle count affected vehicles only (${s.affected_min} veh·min ÷ ${s.vehicles} vehicles); background traffic ${s.others_min} counted separately`);
  ok(s.routes[0].id === 'stay' && Math.abs(s.routes.reduce((a, r) => a + r.share, 0) - 1) < 0.01 && Math.abs(s.detour_share - (1 - s.routes[0].share)) < 0.002, 'route shares sum to 1; detour_share = 1 − stay');
  ok(['commuter', 'local', 'tourist', 'delivery'].every(k => typeof s.approaches[0].by_type[k].why === 'string'), 'one "why" per persona (the reading\'s why)');
  ok(s.raw && s.raw.links.length > 1000 && Array.isArray(s.hot), 'raw result in .raw (all links), the most congested in .hot');
  const late = await be.run(be.demo('latrobe'));
  ok(late.queue_m === 0 && late.mean_delay_s < 30, `second scene, La Trobe St westbound at 17:00: barely congested (+${late.mean_delay_s} s per vehicle)`);
});

await t('reader failures are reported, never silently miscounted (negative test)', async () => {
  const be = await connect({ fetch: fakeFetch, importer: noImporter, readSigns: async req => { if (req.persona === 'tourist') { const e = new Error('bad'); e.code = 'bad_kind'; throw e; } return (await import('../public/js/index.js')).mockReadSigns(req); } });
  const s = await be.run(be.demo('lonsdale'));
  ok(s.flags.ok === false && s.flags.failed > 0 && s.flags.missing > 0 && be.status().reader_errors.bad_kind > 0, `every tourist reading throws → flags.ok = false, failed ${s.flags.failed}, status records bad_kind`);
  ok(s.approaches[0].by_type.tourist.informed === 0, 'a persona without readings counts as "nobody persuaded" (per the interface spec)');
});

await t('advisor: every suggestion re-run and marked better', async () => {
  const be = await connect({ fetch: fakeFetch, importer: noImporter });
  const a = await be.advise(be.demo('lonsdale', { frames: [['ROADWORK', 'AHEAD']] }));
  ok(a.options.length >= 1 && a.options.every(o => typeof o.better === 'boolean' && (o.skipped || Number.isFinite(o.delta_min))) && a.window.whens > 1, `rule-based advisor gives ${a.options.length} suggestions: ${a.options.map(o => `${o.kind} ${o.delta_min}`).join(' · ')} (summed over ${a.window.whens} hours of the works period)`);
  const txt = a.options.find(o => o.kind === 'text');
  ok(!txt || (txt.plan && !JSON.stringify(txt.frames).includes('HEFFERNAN')), 'the advisor never suggests naming a laneway on a sign');
});

await t('demo plans', async () => {
  ok(DEMO_NAMES.join() === 'lonsdale,latrobe', 'two demo plans: lonsdale (main demo), latrobe (second scene)');
  const p = demoPlan('lonsdale', { frames: [['X']], at_m: 180, hour: 17 });
  ok(p.worksites[0].equipment[0].frames[0][0] === 'X' && p.worksites[0].equipment[0].at_m === 180 && p.when.hour === 17 && demoPlan('lonsdale').worksites[0].equipment[0].at_m === 300, 'demo(name, { frames, at_m, hour }) returns a fresh copy each time, original unchanged');
  let threw = false; try { demoPlan('nope'); } catch { threw = true; }
  ok(threw && typeof summarize === 'function', 'unknown plan name → throws');
});

await t('7 confirmed review findings (review-backend-logic / browser)', async () => {
  const be = await connect({ fetch: fakeFetch, importer: noImporter });
  // 1 full closure: every vehicle on the closed link reroutes; none may be silently counted as stuck, making a full closure look better
  const all = be.demo('lonsdale'); all.worksites[0].closes.lanes = 2;
  const full = await be.run(all);
  const closed = full.raw.links.find(l => l.id === 'l595594354_9756035316');
  ok(full.blocked_vph === 0 && closed.v === 0 && full.vehicles >= 1100 && full.raw.links.every(l => l.v >= 0) && full.flags.ok,
    `full closure: ${closed.v} vehicles left on the closed link, ${full.blocked_vph} stuck, ${full.vehicles} rerouted (all traffic on the link, not just the 513 end-to-end vehicles), no negative flow`);
  const line = { version: 1, nodes: ['a', 'b', 'c', 'd'].map((id, i) => ({ id, lat: -37.81, lon: 144.95 + i * 0.002 })),
    links: [['a', 'b'], ['b', 'c'], ['c', 'd']].map(([x, y]) => ({ id: x + y, from: x, to: y, name: 'Solo St', len_m: 200, lanes: 2, speed_kmh: 40, cap_vph: 1800, t0_s: 18 })) };
  const lineFlows = { days: { wd: Object.fromEntries(line.links.map(l => [l.id, Array(24).fill(500)])), we: Object.fromEntries(line.links.map(l => [l.id, Array(24).fill(500)])) } };
  const bl = await connect({ network: line, flows: lineFlows, fetch: null, importer: noImporter });
  const stuck = await bl.run({ when: { date: '2026-10-06', hour: 8 }, worksites: [{ id: 'X', links: ['bc'], closes: { lanes: 2 }, time: { from: '2026-10-05', to: '2026-10-09', hours: [7, 19] }, equipment: [] }] });
  ok(stuck.blocked_vph > 0 && stuck.flags.blocked_vph === stuck.blocked_vph && stuck.flags.ok === false, `full closure with no detour: ${stuck.blocked_vph} veh/h stuck → flags.ok = false (negative test: must not pass as fine)`);
  // 2 several worksites: "why", queue and split come from the same approach
  const two = be.demo('lonsdale', { frames: [['ROADWORK', 'AHEAD'], ['USE', 'RUSSELL ST']] });
  two.worksites.unshift({ ...be.demo('latrobe', { frames: [['ROADWORK', 'AHEAD']] }).worksites[0], id: 'C-7' });
  const s2 = await be.run(two);
  const m = s2.approaches[s2.main];
  ok(s2.approaches.length === 2 && m.worksite === 'B-12' && s2.why.commuter === m.by_type.commuter.why && s2.routes === m.routes && s2.street === m.street,
    `two worksites: main approach ${m.street}; why / routes / queue_m all come from it (why = ${s2.why.commuter})`);
  // 3 before / after compared on the same stretch
  const king = { id: 'K-1', links: ['l9146197565_8955976454'], closes: { lanes: 1 }, time: { from: '2026-10-05', to: '2026-10-09', hours: [7, 19] }, equipment: [] };
  const pre = be.demo('lonsdale', { frames: [['ROADWORK', 'AHEAD']] }), post = be.demo('lonsdale');
  pre.worksites.push(king); post.worksites.push(clone(king));
  const c3 = await be.compare(pre, post);
  const lonB = c3.before.approaches.find(x => x.worksite === 'B-12'), lonA = c3.after.approaches.find(x => x.worksite === 'B-12');
  ok(c3.delta.street === 'Lonsdale Street' && c3.delta.queue_m === +(lonA.queue_m - lonB.queue_m).toFixed(3) && c3.delta.queue_m < 0,
    `before / after uses the before-plan's main approach: Lonsdale queue ${lonB.queue_m} → ${lonA.queue_m} (delta ${c3.delta.queue_m}, main_changed ${c3.delta.main_changed})`);
  // 4 the sign text check does not depend on time; inactive hours are flagged
  const bt = T5 ? await connect({ fetch: fakeFetch, importer: repoImporter }) : null;
  const off = be.demo('lonsdale', { frames: [['ROADWORKSAHEAD']], hour: 22 });
  const s4 = await be.run(off);
  ok(s4.flags.inactive && s4.active.length === 0 && (!bt || (bt.check(off).some(c => !c.ok) && (await bt.run(off)).flags.ok === false)), 'no works at 22:00: flags.inactive = true; invalid text is still caught (apps/api checkSigns)');
  // 5 worksite without dates: the advisor compares this one hour instead of scoring every suggestion 0
  const noTime = be.demo('lonsdale', { frames: [['ROADWORK', 'AHEAD']] }); delete noTime.worksites[0].time;
  const a5 = await be.advise(noTime);
  ok(a5.window.single_hour && a5.options.some(o => o.better && o.delta_min < 0), `worksite without dates: advisor compares this one hour (${a5.options.map(o => o.kind + ' ' + o.delta_min).join(' · ')})`);
  // 6 the advisor reports reading failures too
  const sign = err => { const e = new Error(err); e.code = err; return e; };
  const bad = await connect({ fetch: fakeFetch, importer: noImporter, readSigns: async req => { if (req.persona === 'tourist') throw sign('bad_kind'); return (await import('../public/js/index.js')).mockReadSigns(req); } });
  const a6 = await bad.advise(bad.demo('lonsdale', { frames: [['ROADWORK', 'AHEAD']] }));
  ok(a6.flags.ok === false && a6.flags.failed > 0, `advisor: rejected readings → flags.ok = false (failed ${a6.flags.failed})`);
  // 7 on a non-https page the reader throws a plain error computing its cache key: that call falls back to the engine's rule reader instead of silently becoming "nobody persuaded"
  const noCrypto = await connect({ fetch: fakeFetch, importer: noImporter, readSigns: async () => { throw new TypeError("Cannot read properties of undefined (reading 'digest')"); } });
  const s7 = await noCrypto.run(noCrypto.demo('lonsdale'));
  const ref = await be.run(be.demo('lonsdale'));
  ok(s7.flags.failed === 0 && s7.flags.missing === 0 && s7.queue_m === ref.queue_m && Object.keys(noCrypto.status().reader_errors).every(k => k.startsWith('fallback')),
    `reader throws a plain error (no crypto.subtle) → engine rules used, queue ${s7.queue_m} m matches the rule reading, status records fallback`);
});

done();
