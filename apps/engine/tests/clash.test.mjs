// clash.test.mjs — clash() / stagger() in backend.js (overlapping works on the page, D-0929-2011 item 2).
// Real network (apps/roads/public/cbd/) + engine rule readings; URL fetches go through an injected fake fetch, offline and free.
// Worksite pair: the Lonsdale demo (B-12) + the register's seeded Little Bourke St full closure (W-LTLBOURKE, on Lonsdale's detour route, 3 days of overlap).
import { readFileSync, existsSync } from 'node:fs';
import { ok, t, done } from './_t.mjs';
import { connect, demoPlan, PATHS } from '../public/js/backend.js';
import { SEED_WORKSITES } from '../../api/public/js/worksites-seed.js';

const APPS = new URL('../../', import.meta.url);
const file = p => new URL('.' + p, APPS);
if (!existsSync(file(PATHS.network))) { ok(false, 'apps/roads/public/cbd/network.json not found'); done(); }
const fakeFetch = async url => (existsSync(file(url)) ? { ok: true, status: 200, json: async () => JSON.parse(readFileSync(file(url), 'utf8')) } : { ok: false, status: 404 });
const noImporter = async url => { throw new Error('404 ' + url); };
const clone = x => JSON.parse(JSON.stringify(x));
// register worksite → engine worksite (the same fields as toEngineWorksite in apps/api/public/js/worksites.js)
const seed = id => { const s = SEED_WORKSITES.find(w => w.id === id); return { id: s.id, name: s.title, links: [...s.links], closes: { lanes: s.closes.lanes }, time: clone(s.time), equipment: clone(s.equipment) }; };
const nonNeg = r => ['a', 'b', 'ab', 'cost'].every(k => Number.isFinite(r[k]) && r[k] >= 0);

await t('clash / stagger', async () => {
  const be = await connect({ fetch: fakeFetch, importer: noImporter });
  ok(typeof be.clash === 'function' && typeof be.stagger === 'function', 'connect() provides clash / stagger');
  const A = demoPlan('lonsdale').worksites[0], B = seed('W-LTLBOURKE');

  // 1 Lonsdale + Little Bourke: finite, ≥ 0, reliable, and equal to the engine's conflict() definition
  const c = await be.clash(A, B);
  ok(c.overlap.from === '2026-10-07' && c.overlap.to === '2026-10-09' && c.overlap.days === 3, `overlap ${c.overlap.from} → ${c.overlap.to}, ${c.overlap.days} days`);
  ok(c.whens === 6 && c.hours.join(',') === '8,17', `time window = 3 overlap days × peak hours 8 and 17 (${c.whens} moments, ${c.hours})`);
  ok(nonNeg(c) && c.cost > 0 && c.flags.reliable && !c.flags.negative_delay && !c.flags.substitutes, `clash cost ${c.cost} veh·min > 0, reliable (A ${c.a} / B ${c.b} / A+B ${c.ab})`);
  ok(c.cost === c.ab - c.a - c.b, 'clash cost = D(A+B) − D(A) − D(B)');
  const eng = be.engine.conflict(A, B, { whens: [{ date: '2026-10-07', hour: 8 }, { date: '2026-10-07', hour: 17 }, { date: '2026-10-08', hour: 8 }, { date: '2026-10-08', hour: 17 }, { date: '2026-10-09', hour: 8 }, { date: '2026-10-09', hour: 17 }] });
  ok(eng.cost === c.cost && eng.ab === c.ab, `same number as the engine's engine.conflict() (no separate implementation): ${eng.cost}`);
  ok(c.flags.reading_src === 'rule' && c.flags.failed === 0, `reading source ${c.flags.reading_src}, failures ${c.flags.failed}`);

  // 2 a whole plan works too; the plan is not modified
  const plan = demoPlan('lonsdale'), snap = JSON.stringify(plan);
  const c2 = await be.clash(plan, { when: plan.when, worksites: [B] });
  ok(c2.cost === c.cost && JSON.stringify(plan) === snap, 'passing a whole plan = passing the worksite; the plan is not modified');

  // 3 no overlap → 0, the engine is not run
  const far = { ...B, time: { from: '2026-11-01', to: '2026-11-03', hours: [7, 19] } };
  const c3 = await be.clash(A, far);
  ok(c3.cost === 0 && c3.whens === 0 && c3.overlap.days === 0 && c3.flags.reliable, 'times do not overlap: clash cost 0, no sampled moments');

  // 4 one-click stagger: shift later until no overlap, clash cost → 0; over the same period the saving equals the clash cost
  const st = await be.stagger(A, B);
  ok(st.best && st.best.cost === 0 && st.best.days === 3 && st.best.reliable, `stagger +${st.best?.days} days → clash cost ${st.best?.cost}`);
  ok(st.tries.map(x => x.days).join(',') === '1,2,3' && st.tries[0].cost > st.tries[1].cost && st.tries[1].cost > 0, `tries day by day, stops at 0: ${st.tries.map(x => `+${x.days}:${x.cost}`).join(' ')}`);
  ok(st.period.ab_before - st.period.ab_after === c.cost && st.best.ab === st.period.ab_after, `network delay over the whole period ${st.period.ab_before} → ${st.period.ab_after}; the reduction is exactly the clash cost`);
  ok(st.worksite.time.from === '2026-10-10' && B.time.from === '2026-10-07', 'returns the shifted worksite; the original is not modified');
  const st2 = await be.stagger(A, B, { maxDays: 7, back: true });
  ok(st2.tries.map(x => x.days).join(',').startsWith('1,-1,2') && st2.best.cost === 0, `back: true order +1, −1, +2 … (${st2.tries.map(x => x.days).join(',')})`);

  // 5 same input, same result
  const again = await be.clash(A, B), stAgain = await be.stagger(A, B);
  ok(JSON.stringify(again) === JSON.stringify(c) && JSON.stringify(stAgain) === JSON.stringify(st), 'determinism: a second run is byte-identical');

  // 6 negative test: Flinders St baseline flow exceeds capacity (#58), so a single closure gives negative delay → display fields must never be negative and are flagged unreliable
  const F = (id, link) => ({ id, name: id, links: [link], closes: { lanes: 1 }, time: { from: '2026-10-05', to: '2026-10-09', hours: [7, 19] }, equipment: [] });
  const fa = F('FA', 'l591392087_5880339363'), fb = F('FB', 'l1833110268_1833110277');
  const cf = await be.clash(fa, fb);
  ok(cf.raw.a < 0 || cf.raw.b < 0 || cf.raw.ab < 0 || cf.raw.cost < 0, `Flinders St raw numbers include negatives (A ${cf.raw.a} / B ${cf.raw.b} / A+B ${cf.raw.ab} / clash ${cf.raw.cost})`);
  ok(!cf.flags.reliable && cf.flags.negative_delay && !cf.flags.substitutes && cf.cost === 0 && nonNeg(cf), `→ reliable = false, negative_delay, all display fields ≥ 0, clash cost shown as 0 (${cf.a} / ${cf.b} / ${cf.ab} / ${cf.cost})`);
  const sf = await be.stagger(fa, fb, { maxDays: 5 });
  ok(sf.tries.every(x => x.cost >= 0) && sf.period.ab_before >= 0 && sf.period.ab_after >= 0, 'every stagger step and the whole-period numbers are ≥ 0 too');
  ok(sf.tries.slice(0, -1).every(x => !x.reliable && x.cost === 0) && sf.best.days === sf.tries.at(-1).days && sf.best.overlap_days === 0 && sf.best.reliable,
    `every step still overlapping is unreliable and not taken as best; it stops only once there is no overlap (+${sf.best.days}) (${sf.tries.map(x => `+${x.days}:${x.cost}${x.reliable ? '' : '?'}`).join(' ')})`);
  ok(!sf.period.reliable, 'unreliable before the shift → period.reliable = false (the whole-period before / after is not used as evidence)');

  // 6b all three D ≥ 0 and only D(A+B) < D(A) + D(B) (substitutes on one corridor) → clash cost shown as 0, flagged substitutes, still reliable, not "baseline over capacity"
  const S = { id: 'SUB', name: 'SUB', links: [A.links[0]], closes: { lanes: 1 }, time: clone(A.time), equipment: [] };
  const cs = await be.clash(A, S);
  ok(cs.raw.cost < 0 && [cs.raw.a, cs.raw.b, cs.raw.ab].every(x => x >= 0), `raw clash cost < 0, all three D ≥ 0 (A ${cs.raw.a} / B ${cs.raw.b} / A+B ${cs.raw.ab} / clash ${cs.raw.cost})`);
  ok(cs.cost === 0 && nonNeg(cs) && cs.flags.substitutes && !cs.flags.negative_delay && cs.flags.reliable, '→ cost shown as 0, substitutes = true, negative_delay = false, reliable = true');

  // 6c an unreliable stagger attempt (clamped to 0) must not pass as "cleared": add a Flinders St link to B so the +1 day step is unreliable; best must be a later reliable one
  const BF = { ...B, id: 'W-LTLBOURKE-F', links: [...B.links, 'l591392087_5880339363'] };
  const sb = await be.stagger(A, BF, { maxDays: 3 });
  ok(sb.tries.some(x => !x.reliable) && sb.best.reliable && sb.tries.filter(x => x.reliable).every(x => x.cost >= sb.best.cost),
    `best is a reliable attempt: +${sb.best.days} days, cost ${sb.best.cost} (${sb.tries.map(x => `+${x.days}:${x.cost}${x.reliable ? '' : '?'}`).join(' ')})`);
  ok(sb.period.reliable === (sb.base.flags.reliable && sb.best.reliable && sb.period.ab_before >= 0 && sb.period.ab_after >= 0 && !sb.period.failed), `period.reliable follows base / best (${sb.period.reliable})`);

  // 6d reader failure (an error with .code, counted by the engine as "nobody persuaded") → flags.failed > 0, reliable = false, the page does not show the number
  const failing = async () => { const e = new Error('reading failed (test)'); e.code = 'test_fail'; throw e; };
  const beF = await connect({ fetch: fakeFetch, importer: noImporter, readSigns: failing });
  const cx = await beF.clash(A, B);
  ok(cx.flags.failed > 0 && !cx.flags.reliable && !cx.flags.negative_delay, `${cx.flags.failed} reading failures → reliable = false`);

  // 7 invalid input throws instead of silently computing 0
  let threw = 0;
  try { await be.clash(A, null); } catch { threw++; }
  try { await be.clash(A, { ...B, time: undefined }); } catch { threw++; }
  try { await be.clash(A, { ...B, closes: { lanes: 1, footpath: 'up' } }); } catch (e) { if (e.code === 'bad_plan') threw++; }
  ok(threw === 3, 'missing worksite / missing time (and no when) / invalid worksite (validate) → throws');
});

done();
