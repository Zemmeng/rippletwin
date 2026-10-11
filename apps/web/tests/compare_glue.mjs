// Plan comparison (pure:begin…pure:end in src/js/8-compare.js) + the real backend.js / advisor + the pack.js execution pack, all run in node.
// Called by tests/test_compare.py as node tests/compare_glue.mjs; one ✅ / ❌ line per assertion, no network access
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WEB = HERE + '../';
const APPS = WEB + '../';
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log('✅ ' + msg); } else { fail++; console.log('❌ ' + msg); } };
const pure = f => { const m = readFileSync(WEB + 'src/js/' + f, 'utf8').match(/\/\* pure:begin[^\n]*\n([\s\S]*?)\/\* pure:end \*\//); ok(!!m, `${f} has a pure:begin / pure:end block`); return m ? m[1] : ''; };

const ctx = {};
vm.createContext(ctx);
vm.runInContext(pure('6-engine.js') + '\n' + pure('8-compare.js') + '\n;globalThis.G={planFrom,cmpSources,cmpNumbers,cmpBest,cmpVms,cmpFromOptions,cmpKit,cmpDocHTML,cmpSameAs,cmpSpan,cmpClashOther,cmpClashWhen,cmpWin,cmpP,cmpSuParse,cmpSuNums,cmpSameP,cmpSuAsk,cmpSuKey,cmpLeaner,CMP_MAX};', ctx);
const { planFrom, cmpSources, cmpNumbers, cmpBest, cmpVms, cmpFromOptions, cmpKit, cmpDocHTML, cmpSameAs, cmpSpan, cmpClashOther, cmpClashWhen, cmpWin, cmpP, cmpSuParse, cmpSuNums, cmpSameP, cmpSuAsk, cmpSuKey, cmpLeaner, CMP_MAX } = ctx.G;

// 1 Which plans to compare (pure functions)
const P = { worksites: [{ id: 'W-1', links: ['x'], equipment: [{ id: 'VMS-1', type: 'vms', at_m: 300, frames: [['ROADWORK', 'AHEAD'], ['USE', 'RUSSELL ST']] }] }] };
const adv = { options: [
  { kind: 'shift', plan: P, days: 5 },
  { kind: 'text', plan: P, frames: [['USE', 'RUSSELL ST']] },
  { kind: 'move', plan: null, skipped: 'no_vms' },
  { kind: 'move', plan: P, equipment: 'VMS-1', at_m: 450 },
  { kind: 'text', plan: P, frames: [['A']] },
] };
const src = cmpSources(P, adv);
ok(CMP_MAX === 3 && src.length === 3, 'at most 3 plans');
ok(src.map(x => x.id).join('') === 'ABC' && src[0].kind === 'now', 'the first plan is the one currently in the form; labelled A B C');
ok(!src.some(x => x.kind === 'shift'), 'date staggering is not compared (it is computed over the whole works period, not this hour)');
ok(src[1].kind === 'text' && src[2].kind === 'move' && src[2].at_m === 450, 'changes without a plan are skipped (skipped / empty plan)');
ok(cmpSources(P, null).length === 1, 'only A when the advisor has no result');
ok(cmpVms(P) === 'ROADWORK / AHEAD  ▸  USE / RUSSELL ST' && cmpVms({ worksites: [{ equipment: [] }] }) === '', 'VMS lines joined with /, frames separated by ▸; no VMS gives an empty string');

// 1b be.options() results → cards
const fake = { days: 5, options: [
  { id: 'o1', label: 'Cheapest', label_zh: '最省', plan: P, result: { delay_min: 9 }, hire: { total_aud: 100 }, flags: { stock_ok: true } },
  { id: 'o2', label: 'Standard', label_zh: '标准', plan: P, result: { delay_min: 8 }, hire: { total_aud: 150 }, flags: { stock_ok: false } },
  { id: 'o3', label: 'Guided', label_zh: '引导', plan: P, result: null, hire: null },
  { id: 'o4', label: 'x', plan: P, result: {}, hire: {} },
] };
const kr = cmpFromOptions(fake);
ok(kr.length === 3 && kr.map(r => r.id).join('') === 'ABC' && kr[0].tier === 'o1' && kr[0].kind === 'kit', 'options() → at most 3 cards, labelled A B C, keeping the original tier');
ok(kr[0].hire === 100 && kr[0].days === 5 && kr[2].hire === null && kr[2].s === null, 'hire cost and days as given by the engine; anything not computed is null');
ok(kr[1].flags.stock_ok === false && JSON.stringify(kr[2].flags) === '{}', 'stock-check flags carried over');
ok(cmpFromOptions(null).length === 0, 'options() with no result → no cards');
const kit = cmpKit({ worksites: [{ equipment: [{ type: 'vms' }, { type: 'barrier', qty: 22 }, { type: 'sign', qty: 2 }, { type: 'sign' }, { type: 'arrow' }] }] });
ok(kit.vms === 1 && kit.barrier === 22 && kit.sign === 3 && kit.arrow === 1, 'equipment counted by type (using qty where given)');

// 2 Numbers and the "fewest" marker (pure functions)
ok(JSON.stringify(cmpNumbers(null)) === '{"car":null,"transit":null,"peds":null}', 'not computed → all null');
ok(cmpNumbers({ delay_min: 12, transit: { src: null }, peds: { src: 'peds', extra_min: 0 } }).transit === null, 'no transit data → null (not 0)');
ok(cmpNumbers({ delay_min: 12, transit: { src: null }, peds: { src: 'peds', extra_min: 0 } }).peds === 0, 'footpath open → pedestrians 0');
const b = cmpBest([{ car: 10, hire: 5 }, { car: 4, hire: 5 }, { car: 4, hire: null }], ['car', 'hire', 'peds']);
ok(JSON.stringify(b.car) === '[1,2]', 'all plans tied for fewest are marked');
ok(!('hire' in b), 'two plans equal: not marked');
ok(!('peds' in b), 'none has this number: not marked');

// 2b "Same result, but costs more" (pure functions): same traffic numbers (extra wait per vehicle / queue / network / tram and bus / pedestrians) and footpath, higher hire cost → mark the cheaper plan and the difference
const R = (md, q, car, hire, flags = {}) => ({ s: { mean_delay_s: md, queue_m: q, delay_min: car, transit: { src: 'gtfs', pax_min: 40 }, peds: { src: 'peds', extra_min: 0 } }, hire, flags: { footpath: 'none', ...flags } });
{
  const sa = cmpSameAs([R(60, 300, 900, 100), R(60, 300, 900.2, 340), R(12, 50, 200, 340)]);
  ok(sa[0] === null && sa[1] && sa[1].of === 0 && sa[1].extra === 240 && sa[2] === null, 'the dearer plan has the same result as the cheaper one (at on-screen precision) → marked "same as A · costs the difference more"; the cheaper one and plans with different results are not marked');
  const sb = cmpSameAs([R(60, 300, 900, 300), R(60, 300, 900, 100), R(60, 300, 900, 200)]);
  ok(sb[1] === null && sb[0].of === 1 && sb[0].extra === 200 && sb[2].of === 1 && sb[2].extra === 100, 'when several are the same, compare against the cheapest; the difference is computed per column (not only column B)');
  ok(cmpSameAs([R(60, 300, 900, 100), R(60, 300, 900, 100)]).every(x => x === null), 'same hire cost → not marked');
  ok(cmpSameAs([R(60, 300, 900, 100), R(60, 300, 900, 200, { footpath: 'left' })])[1] === null, 'different footpath → not the same result');
  ok(cmpSameAs([R(0, 0, 0, 100, { inactive: true }), R(0, 0, 0, 200, { inactive: true })]).every(x => x === null), 'no works in this time window (all 0) → not marked');
  ok(cmpSameAs([R(60, 300, 900, null), { ...R(60, 300, 900, 200), s: null }, R(60, 300, 900, 200)]).every(x => x === null), 'no hire cost or not computed → left out of the comparison');
  ok(cmpSpan('2026-10-07', '2026-10-09', false) === '7–9 Oct' && cmpSpan('2026-10-07', '2026-10-09', true) === '10/7–9', 'overlap dates: day first in English (Melbourne style), 10/7–9 in Chinese');
  ok(cmpSpan('2026-09-30', '2026-10-02', false) === '30 Sep – 2 Oct' && cmpSpan('2026-09-30', '2026-10-02', true) === '9/30–10/2' && cmpSpan('2026-10-07', '2026-10-07', false) === '7 Oct' && cmpSpan(null, null, true) === '', 'across months, same day, no dates');
}

// 2c Decided by the team lead: 04's clash row follows 03's "Stagger N days" (pure functions), using 03's stagger().worksite; the row name shows the shifted date + "staggered N days"
{
  const hr = h => String(h).padStart(2, '0') + ':00';
  const x = { o: { id: 'W-X', title: 'X' }, ws: { id: 'W-X', links: ['x'], time: { from: '2026-10-07', to: '2026-10-12', hours: [7, 19] } }, r: { cost: 900, hours: [8, 17], overlap: { from: '2026-10-07', to: '2026-10-09', days: 3 } } };
  const moved = { ...x.ws, time: { ...x.ws.time, from: '2026-10-10', to: '2026-10-15' } };
  const st = { best: { days: 3, cost: 0, overlap_days: 0, reliable: true }, worksite: moved };
  const y = cmpClashOther(x, st);
  ok(y.ws === moved && y.days === 3 && y.o === x.o && y.r === x.r && x.ws.time.from === '2026-10-07', '03 staggered (reliably) → 04 uses the same worksite 03 shifted and records N; the works 03 picked is not modified');
  ok(cmpClashOther(x, null) === x && cmpClashOther(x, { best: null, worksite: null }) === x && cmpClashOther(x, { ...st, best: { ...st.best, reliable: false } }) === x && cmpClashOther(null, st) === null,
    'not staggered / no reliable stagger found (03 says so and the dates stay) / no concurrent works → unchanged, not shifted');
  ok(cmpClashWhen(x, false, hr) === '7–9 Oct · 08:00 & 17:00' && cmpClashWhen(x, true, hr) === '10/7–9 · 08:00 & 17:00', 'not staggered: row name unchanged (overlap dates · sampled hours)');
  ok(cmpClashWhen(y, false, hr) === '10–15 Oct · staggered 3 days' && cmpClashWhen(y, true, hr) === '10/10–15 · 已错开 3 天', 'after staggering: the row name shows the shifted dates of that works + "staggered 3 days" (EN and ZH); no sampled hours once there is no overlap');
  const y1 = cmpClashOther(x, { best: { days: 1, cost: 400, overlap_days: 2, reliable: true }, worksite: { ...x.ws, time: { ...x.ws.time, from: '2026-10-08', to: '2026-10-13' } } });
  ok(cmpClashWhen(y1, false, hr) === '8–13 Oct · 08:00 & 17:00 · staggered 1 day', 'still overlapping after staggering: sampled hours still shown, singular for 1 day');
}

// 3 Real network: page default plan (ROADWORK / AHEAD only) → advisor → run() per plan → pack.js execution pack
const file = p => APPS + p.replace(/^\//, '');
const fakeFetch = async url => (existsSync(file(url)) ? { ok: true, status: 200, json: async () => JSON.parse(readFileSync(file(url), 'utf8')) } : { ok: false, status: 404 });
const importer = async url => { if (!existsSync(file(url))) throw new Error('404 ' + url); return import(pathToFileURL(file(url)).href); };
const { connect } = await import(pathToFileURL(APPS + 'engine/public/js/backend.js').href);
const be = await connect({ fetch: fakeFetch, importer });
const EP = { link: 'l595594354_9756035316', street: 'Lonsdale Street', lanes: 1, hour: 8, f1: 'ROADWORK\nAHEAD', f2: '', vmsAt: 300, sign: 'RIGHT LANE CLOSED', signAt: 100, arrowAt: 60, foot: 'none' };
const plan = planFrom(EP);
const a = await be.advise(plan);
const rows = cmpSources(plan, a);
ok(rows.length >= 2, `Lonsdale at 08:00: the advisor offers comparable changes, ${rows.length} plans in total`);
for (const r of rows) r.s = await be.run(r.plan);
const nums = rows.map(r => cmpNumbers(r.s));
ok(nums.every(n => Number.isFinite(n.car) && n.car > 0), `every plan has a car delay: ${nums.map(n => Math.round(n.car)).join(' / ')} veh·min`);
ok(nums.every(n => n.transit !== null && n.peds !== null), 'trams and buses, and pedestrians all have numbers (all data loaded)');
const best = cmpBest(nums, ['car']);
ok(best.car && !best.car.includes(0), `the advisor's changes have less car delay than the current plan (fewest: ${best.car && best.car.map(i => rows[i].id).join(',')})`);

const packUrl = APPS + 'api/public/js/pack.js', exUrl = APPS + 'api/public/js/explain.js';
if (!existsSync(packUrl) || !existsSync(exUrl)) {
  console.log('⏭ skipping the execution-pack section: apps/api pack.js / explain.js not found');
} else {
  const pack = await import(pathToFileURL(packUrl).href), ex = await import(pathToFileURL(exUrl).href);
  const inventory = await pack.loadInventory({ fetch: fakeFetch });
  const net = be.engine.net, ws = rows[1].plan.worksites[0];
  const links = new Map(ws.links.map(id => [id, net.links.get(id)]));
  const q = pack.quote(ws, inventory, { links });
  ok(q.total_aud > 0 && q.days === 5 && q.unmatched.length === 0, `hire cost of the chosen plan: A$${q.total_aud} (5 days, all equipment matched to stock)`);
  const impacts = ex.optionFromRun(rows[1].id, 'plan', rows[1].s).metrics;
  const p = pack.buildPack({ ...ws, title: ws.name, status: 'decided', decision: { option: rows[1].id, by: 'council', reason: 'shorter queue', at: '2026-09-30T00:00:00.000Z' } }, { inventory, links, impacts });
  const zh = pack.packText(p, 'zh'), en = pack.packText(p, 'en');
  ok(/选 B（市政，2026-09-30）：shorter queue/.test(zh), 'the execution pack records that B was chosen, by whom and why');
  ok(/假设值，以 RPM Hire 正式报价为准/.test(zh) && /assumptions; RPM Hire's formal quote applies/.test(en), 'negative: the execution pack states that day rates are assumptions');
  ok(/Frame 1:/.test(en) && /Lonsdale Street/.test(en), 'the execution pack has the VMS schedule and road names');
  ok(p.notify.some(n => n.who === 'transit'), 'tram and bus riders affected → notify the operator');
}

// 4 Three real plans (equipment from stock, with hire cost) → cards → match the pack.js quote → export
if (typeof be.options !== 'function') {
  ok(false, 'backend.js has options()');
} else {
  const res = await be.options(plan, { n: 3 });
  const kits = cmpFromOptions(res);
  ok(kits.length === 3 && kits.every(k => k.s && Number.isFinite(k.s.delay_min)), `options() gives 3 plans, each with an engine-computed delay: ${kits.map(k => `${k.tier} ${Math.round(k.s.delay_min)}`).join(' / ')}`);
  ok(kits.every(k => Number.isFinite(k.hire) && k.hire > 0), `every plan has a hire cost: ${kits.map(k => 'A$' + k.hire).join(' / ')}`);
  const kn = kits.map(k => cmpNumbers(k.s));
  ok(kn.every(n => n.transit !== null && n.peds !== null), 'the options() results also have tram/bus and pedestrian numbers');

  // The Standard plan's VMS used to say only ROADWORK / AHEAD, giving the same result as Cheapest; now the Standard tier has two VMS reporting the delay (the sign checker can read the minutes), so all three results differ
  const sa = cmpSameAs(kits);
  ok(sa.every(x => x === null) && kits[1].s.delay_min !== kits[0].s.delay_min && kits[0].hire < kits[2].hire && kits[2].hire < kits[1].hire,
    `A and B no longer have the same result (network ${Math.round(kits[0].s.delay_min)} / ${Math.round(kits[1].s.delay_min)} veh·min), so none is marked "same result as A"; hire cost A < C < B (A$${kits.map(k => k.hire).join(' / ')})`);
  // The comparison table's "nearby works" row is computed per plan, with the same works and the same method as the 03 view (the plan in the form)
  const wsUrl = APPS + 'api/public/js/worksites.js';
  if (!existsSync(wsUrl)) console.log('⏭ skipping the clash section: apps/api worksites.js not found');
  else {
    const W = await import(pathToFileURL(wsUrl).href), cur = plan.worksites[0];
    const same = o => o.links.length === cur.links.length && o.links.every(id => cur.links.includes(id));
    const sc = [];
    for (const o of W.overlapping(cur, W.SEEDS).filter(o => !same(o)).slice(0, 3)) { const ws = W.toEngineWorksite(o); sc.push({ o, ws, r: await be.clash(cur, ws) }); }
    sc.sort((x, y) => (y.r.flags.reliable - x.r.flags.reliable) || (y.r.cost - x.r.cost) || (x.o.id < y.o.id ? -1 : 1));
    const other = sc[0];
    ok(other && other.r.flags.reliable && other.r.cost > 0, `the demo register has works concurrent with Lonsdale with a clash cost > 0: ${other ? other.o.id + ' +' + other.r.cost : 'none'}`);
    if (other) {
      const cells = [];
      for (const k of kits) cells.push((await be.clash(k.plan.worksites[0], other.ws)).cost);
      ok(cells[0] === other.r.cost && cells[1] !== other.r.cost, `default wording: 03 clash +${other.r.cost}, the same in table column A; B reports the delay, so its clash differs (${cells.join(' / ')})`);
      const cf = kits[2].plan.worksites[0].equipment.find(e => e.type === 'vms').frames;
      const curC = planFrom({ ...EP, f1: cf[0].join('\n'), f2: (cf[1] || []).join('\n') }).worksites[0];
      const rc = await be.clash(curC, other.ws);
      ok(cells[2] === rc.cost && rc.cost < other.r.cost, `with the form changed to C's sign text, 03 clash +${rc.cost}, the same as table column C and less than ROADWORK / AHEAD alone`);

      // Decided by the team lead: after "Stagger N days" in 03, 04's clash row is computed with the staggered works, so 03 and 04 agree. Runs the page's real 03
      // (the whole of 8-clash.js: clashRun / clashStagger / clashHTML) and 04 (cmpClashUpdate / cmpClashRow from 8-compare.js),
      // with the real formatting lines from 6-engine.js and a stubbed DOM (getElementById → null); the cmpRender stub only does what the real cmpRender does for this row
      {
        const ENG = readFileSync(WEB + 'src/js/6-engine.js', 'utf8'), CLS = readFileSync(WEB + 'src/js/8-clash.js', 'utf8'), CMS = readFileSync(WEB + 'src/js/8-compare.js', 'utf8');
        const fmt = ENG.slice(ENG.indexOf('const esc='), ENG.indexOf('const TYPES4=')), rowFns = CMS.slice(CMS.indexOf('async function cmpClashUpdate()'), CMS.indexOf('// Independent of scoring'));
        const pend = [], drain = async () => { while (pend.length) await pend.shift(); };
        // This part tests the engine path (plans outside SUMO coverage are unchanged), so suPlan is stubbed to false; for the SUMO-plan path see section 5 near the end of the file
        const c = { planFrom, cmpSpan, cmpBest, cmpClashOther, cmpClashWhen, cmpWin, suPlan: () => false, console, EP: { ...EP }, BE: { api: be }, S: { ui: 4 }, LANG: { cur: 'en' },
          CP: { key: 'k1', busy: false, rows: kits, cl: null }, document: { getElementById: () => null }, engOn: () => true, engNet: () => be.engine.net };
        c.L = (en, zh) => (c.LANG.cur === 'zh' ? zh : en);
        c.cmpRender = () => { pend.push(c.cmpClashUpdate()); };
        vm.createContext(c);
        vm.runInContext(fmt + '\n' + CLS + '\n' + rowFns + '\n;globalThis.T46={CL};', c);
        const CL = c.T46.CL;
        const costs = () => c.CP.cl.cells.map(r => (r && r !== 'err' ? r.cost : r));
        const row = () => c.cmpClashRow(() => '');
        const nums04 = () => [...row().matchAll(/<span class="cmp-num"[^>]*>([^<]+)<\/span>/g)].map(m => +m[1].replace(/[+,]/g, ''));
        const show = async () => { await c.cmpClashUpdate(); await drain(); }; // go to 04: renderPanel → cmpRender → cmpClashUpdate

        CL.m = W; CL.src = 'seed'; CL.listP = Promise.resolve(W.SEEDS); // demo register (no network)
        CL.key = JSON.stringify(c.clashCur()); await c.clashRun();      // 03 opens: these two steps are what clashMount() does
        ok(CL.other && CL.other.o.id === other.o.id && CL.other.r.cost === other.r.cost, `03 picks ${CL.other && CL.other.o.id}, clash +${CL.other && CL.other.r.cost}`);
        await show();
        const before = costs(), row0 = row(), span0 = cmpSpan(other.r.overlap.from, other.r.overlap.to, false);
        ok(before.join() === cells.join() && row0.includes(`${span0} · 08:00 & 17:00`) && !row0.includes('staggered'),
          `not staggered: 04 unchanged; cells ${before.join(' / ')}, row name "${span0} · 08:00 & 17:00"`);

        c.S.ui = 3; await c.clashStagger(); await drain(); // click "Stagger N days" in 03
        const st = CL.st, b = st && st.best, n = b && b.days;
        ok(b && b.reliable && n >= 1 && st.worksite && st.worksite.time.from > other.ws.time.from && !/No reliable stagger/.test(c.clashHTML()),
          `03 staggers by ${n} days → clash ${b && b.cost} (was +${other.r.cost}); that works moves to ${st && st.worksite.time.from} → ${st && st.worksite.time.to}`);
        c.S.ui = 4; await show(); // go to 04
        const m03 = /Stagger by \+(\d+) days? → clash cost ([\d,]+) veh·min/.exec(c.clashHTML()), v03 = m03 && +m03[2].replace(/,/g, ''), after = costs(), n04 = nums04();
        ok(c.CP.cl.other.ws === st.worksite && c.CP.cl.other.days === n, '04 uses exactly the worksite 03 shifted (same object, same dates), same N');
        ok(m03 && +m03[1] === n && after[0] === b.cost && after[1] === b.cost && n04[0] === v03 && n04[1] === v03,
          `04 == 03: 03 shows "stagger +${n} days → clash ${m03 && m03[2]}", 04 cells A and B ${n04.slice(0, 2).join(' / ')} (before staggering ${before.slice(0, 2).join(' / ')})`);
        ok(after.every(v => typeof v === 'number') && after[0] !== before[0], `negative: after staggering, 04 no longer shows the pre-stagger +${before[0]} (cells ${after.join(' / ')})`);
        const span1 = cmpSpan(st.worksite.time.from, st.worksite.time.to, false), row1 = row();
        c.LANG.cur = 'zh'; const row1zh = row(); c.LANG.cur = 'en';
        ok(row1.includes(`${span1}${b.overlap_days ? ' · 08:00 & 17:00' : ''} · staggered ${n} day`) && !row1.includes(span0) && row1zh.includes(`${cmpSpan(st.worksite.time.from, st.worksite.time.to, true)}`) && row1zh.includes(`已错开 ${n} 天`),
          `04 row name shows the shifted dates + staggered N days ("${span1} · staggered ${n} day${n === 1 ? '' : 's'}"), no longer the original ${span0}`);

        await c.clashRun(); await show(); // 03 recomputes (clears CL.st; the page has no separate "undo" button, this is the only way)
        ok(!CL.st && costs().join() === before.join() && row().includes(`${span0} · 08:00 & 17:00`) && !row().includes('staggered'), '03 stagger gone → 04 returns to the original dates and numbers');

        await c.clashStagger(); await drain(); // already on 04 when 03's stagger finishes: cmpRender() at the end of clashStagger brings 04 up to date
        ok(c.CP.cl.other.ws === CL.st.worksite && costs()[0] === CL.st.best.cost && row().includes(`staggered ${CL.st.best.days} day`), 'the user is already on 04 when staggering finishes → 04 updates itself, no need to switch pages again');

        Object.assign(c.EP, { f1: cf[0].join('\n'), f2: (cf[1] || []).join('\n') }); c.CP.key = 'k2'; await show(); // back on 01 the plan changed, and 03 was not visited again
        ok(c.CP.cl.other && c.CP.cl.other.ws.time.from === other.ws.time.from && c.CP.cl.other.days == null && c.CP.cl.other.o.id === other.o.id && !row().includes('staggered') && costs().join() === cells.join(),
          `negative: the plan changed (03's stagger belongs to the previous plan) → 04 does not apply it and recomputes with that works' original dates (cells ${costs().join(' / ')}, same as unstaggered)`);
      }
    }
  }
  if (existsSync(packUrl)) {
    const pack = await import(pathToFileURL(packUrl).href), ex = await import(pathToFileURL(exUrl).href);
    const inventory = await pack.loadInventory({ fetch: fakeFetch });
    const net = be.engine.net;
    const same = kits.every(k => { const ws = k.plan.worksites[0]; const q = pack.quote(ws, inventory, { links: new Map(ws.links.map(id => [id, net.links.get(id)])) }); return q.total_aud === k.hire && q.unmatched.length === 0; });
    ok(same, 'negative: the options() hire cost matches the pack.js quote for every plan (same stock, same day rates, so the export never shows two figures)');
    const g = kits[2], ws = g.plan.worksites[0];
    const p = pack.buildPack({ ...ws, title: ws.name, status: 'decided', decision: { option: g.id, by: 'contractor', reason: 'guided detour', at: '2026-09-30T00:00:00.000Z' } }, { inventory, links: new Map(ws.links.map(id => [id, net.links.get(id)])), impacts: ex.optionFromRun(g.id, 'plan', g.s).metrics });
    const txt = pack.packText(p, 'en');
    // Formatted execution pack (the page's "Export"): real packDoc → cmpDocHTML (skipped if apps/api pack.js has no packDoc)
    if (typeof pack.packDoc !== 'function') console.log('⏭ skipping the formatted-pack section: apps/api pack.js has no packDoc yet');
    else {
    const H = { L: (en) => en, esc: (x) => String(x == null ? '' : x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])), fmt: (n) => Math.round(Number(n) || 0).toLocaleString('en-AU') };
    const rowsX = kits.map((k, i) => ({ id: k.id, label: ['Minimum', 'Standard', 'Guided'][i], ...cmpNumbers(k.s), hire: k.hire }));
    const html = cmpDocHTML(pack.packDoc(p, 'en'), { rows: rowsX, pick: 2, by: 'Contractor', hour: '08:00', date: '30 Sep 2026' }, H);
    ok(html.includes('<b>C · Guided</b><small>Contractor</small>') && /<b>2026-10-\d\d to 2026-10-\d\d \(\d+ days\)<\/b><small>daily 07:00–19:00<\/small>/.test(html), 'the decision cell says "C · Guided" + who chose it; the time cell puts dates and daily hours on two lines');
    ok(html.includes(`A$${H.fmt(g.hire)}`) && (html.match(/class="pd-led"/g) || []).length === 2 && html.includes('USE<br>RUSSELL'), `formatted pack: total A$${H.fmt(g.hire)}, both VMS frames drawn as LED signs`);
    ok(/<tr class="pick"><td>C · Guided <em>chosen<\/em>/.test(html) && (html.match(/<tr/g) || []).length >= 3 + p.quote.lines.length, 'the 3 compared plans in one table with the chosen row highlighted; equipment line by line');
    ok(/assumptions; RPM Hire&#39;s formal quote applies/.test(html) && /not field measurements/.test(html), 'negative: the formatted pack also states the assumptions and that it is a simulation');
    const evil = pack.packDoc(pack.buildPack({ ...ws, name: '<img src=x onerror=alert(1)>', title: '<script>alert(1)</script>', status: 'decided', decision: { option: 'C', by: 'council', reason: '</blockquote><script>alert(2)</script>' } }, { inventory, links: new Map(ws.links.map(id => [id, net.links.get(id)])) }), 'en');
    const evilHtml = cmpDocHTML(evil, { rows: [{ id: 'A', label: '<b>x</b>', car: 1, transit: null, peds: null, hire: null }], pick: 0, hour: '08:00', date: '<i>' }, H);
    ok(!/<script|<img|<b>x|<i>/.test(evilHtml) && evilHtml.includes('&lt;script&gt;alert(2)'), 'negative: < > in the works name, reason, plan name and date are all escaped and never become executable markup');
    }
    ok(/chose C \(contractor, 2026-09-30\): guided detour/.test(txt) && new RegExp(`Total: A\\$${g.hire.toLocaleString('en-US')}`).test(txt), `exporting with C (Guided) chosen: the decision and the total A$${g.hire} are both in the execution pack`);
  }
}

// Asynchronous explanation: repaint dedupe and out-of-order language responses.
{
  const source=readFileSync(WEB+'src/js/8-compare.js','utf8');
  const pending=[],requests=[];
  const state={key:'plan',rows:[{id:'a',s:{delay_min:937},hire:1765,days:5}],exSeq:0,mod:{ex:{
    optionFromRun:(id,label,run,extra)=>({id,label,metrics:{delay_veh_min:run.delay_min,...extra}}),
    explainOptions:req=>{requests.push(req);return new Promise(resolve=>pending.push(resolve));}
  }}};
  const language={cur:'en'};
  const c={CP:state,LANG:language,cmpLabel:()=>language.cur,cmpRender:()=>{},suPlan:()=>false,console};vm.createContext(c);
  vm.runInContext(source.slice(source.indexOf('function cmpExplainUpdate()'),source.indexOf('function cmpExplainRender(')),c);
  c.cmpExplainUpdate();c.cmpExplainUpdate();await new Promise(r=>setImmediate(r));
  ok(requests.length===1&&requests[0].options[0].metrics.hire_aud===1765,'redrawing the AI explanation does not repeat the request; hire cost comes from the existing plans');
  language.cur='zh';c.cmpExplainUpdate();await new Promise(r=>setImmediate(r));
  pending[0]({lang:'en'});await new Promise(r=>setImmediate(r));
  ok(state.explain===null,'a stale response after switching language must not overwrite the new explanation');
  pending[1]({lang:'zh',src:'rule'});await new Promise(r=>setImmediate(r));
  ok(state.explain.lang==='zh'&&!state.exBusy,'the rules fallback for the current language completes normally');
  state.key='new plan';state.busy=true;c.cmpExplainUpdate();
  ok(state.explain===null&&!state.exKey,'recomputing the plans clears the old explanation immediately');
}

// 5 SUMO primary, engine behind the scenes (docs/decisions.md D-1001-0045): plans SUMO covers (this stretch of Lonsdale, 1 lane closed) show no engine traffic results in 04 compare / 05 export / 03 nearby works
//   (queue m, s per vehicle, veh·min, rider·min, clash cost): SUMO's numbers where it has them, otherwise "not covered by SUMO";
//   the engine only works behind the scenes, reading the sign text into the share p of "drivers who detour" (SUMO's input). Uses the page's real 8-compare.js / 8-clash.js in full + the formatting lines of 6-engine.js,
//   with the DOM stubbed and a fake SUMO client runOptions (sumo-client.js runOptions was written separately; this tests the agreed calling convention)
{
  // 5a Pure functions
  ok(cmpP({ routes: [{ id: 'stay', share: 0.86 }, { id: 'r1', share: 0.14 }] }) === 0.14 && cmpP({ routes: [{ id: 'stay', share: 0.395 }] }) === 0.605
    && cmpP({ detour_share: 0.3, routes: [] }) === 0.3 && cmpP(null) === null && cmpP({}) === null, 'p = 1 − share staying on the original route (stay); without routes use detour_share; rounded to 0.1%; no reading → null');
  const M1 = { works_queue_max_m: 1 };
  const shapes = [[{ id: 'A', metrics: M1 }], { options: [{ id: 'opt-A', metrics: M1 }] }, { index: { scenarios: [{ id: 'baseline', metrics: {} }, { id: 'option_A', metrics: M1 }] } }, { scenarios: [{ id: 'a', works_queue_max_m: 1 }] }, { metrics: { A: M1 } }];
  ok(shapes.every(s => { const r = cmpSuParse(s, ['A', 'B']); return r.A && r.A.works_queue_max_m === 1 && r.B === null; }) && JSON.stringify(cmpSuParse(null, ['A'])) === '{"A":null}',
    'every runOptions result shape is accepted (array / options / index.scenarios / metrics inline on the entry / metrics keyed by id); missing plans → null');
  const n1 = cmpSuNums({ works_queue_equiv_end_m: 120.4, works_queue_max_m: 160, works_traffic_extra_s: 38.3, mean_extra_s: 6.9, cohort_vehicles: 1565, vehicles: 1764, detour_vehicles: 5 });
  ok(n1.q === 120.4 && !n1.qMax && n1.ex === 38.3 && Math.abs(n1.tot - 6.9 * 1565 / 60) < 1e-9 && n1.totEst && n1.dv === 5, '09:00 queue uses works_queue_equiv_end_m; total delay = mean_extra_s × cohort_vehicles / 60 (veh·min, marked ≈)');
  const n2 = cmpSuNums({ works_queue_max_m: 160.8, total_extra_veh_min: 200, detour_vehicles: 0 });
  ok(n2.q === 160.8 && n2.qMax && n2.tot === 200 && !n2.totEst && n2.ex === null && n2.dv === 0 && cmpSuNums(null) === null, 'no 09:00 queue → use this run\'s maximum (flagged); if SUMO gives a total itself, use it; missing values are null, not 0');
  const sp = cmpSameP([{ p: 0.14, hire: 515 }, { p: 0.14, hire: 1765 }, { p: 0.605, hire: 1765 }]);
  ok(sp[0] === null && sp[1] && sp[1].of === 0 && sp[1].extra === 1765 - 515 && sp[2] === null, 'same p = same SUMO result (by construction) → the dearer plan is compared with the cheaper one and the difference recorded');
  ok(cmpSameP([{ p: 0.14, hire: 515, flags: { inactive: true } }, { p: 0.14, hire: 900, flags: { inactive: true } }]).every(x => x === null) && cmpSameP([{ p: null, hire: 1 }, { p: null, hire: 2 }]).every(x => x === null), 'no works / no reading → not marked');
  // Pure functions: SUMO request + cache key; C has one VMS fewer than B, is cheaper and gets more detours → one neutral note in column C
  const K = (tier, stay, hire, vms, flags = {}) => ({ id: { o1: 'A', o2: 'B', o3: 'C' }[tier], tier, s: { routes: [{ id: 'stay', share: stay }] }, hire, flags, plan: { worksites: [{ equipment: Array.from({ length: vms }, () => ({ type: 'vms' })) }] } });
  const kk = [K('o1', 0.86, 515, 0), K('o2', 0.508, 2515, 2), K('o3', 0.395, 1765, 1)];
  ok(JSON.stringify(cmpSuAsk(kk)) === '[{"id":"A","p":0.14},{"id":"B","p":0.492},{"id":"C","p":0.605}]' && cmpSuAsk([{ id: 'A', s: null }]).length === 0 && cmpSuKey(cmpSuAsk(kk), 42) === '42|A:0.14,B:0.492,C:0.605' && cmpSuKey(cmpSuAsk(kk), 7) !== cmpSuKey(cmpSuAsk(kk), 42),
    'cmpSuAsk → [{id, p}] (plans without a reading are not asked); cache key = seed + each plan\'s id:p (the key changes with the seed)');
  const le = cmpLeaner(kk);
  ok(le[0] === null && le[1] === null && le[2] && le[2].of === 1 && le[2].save === 750 && le[2].fewer === 1, 'C is A$750 cheaper than B, has one VMS fewer and more detours → marked in column C only');
  ok(cmpLeaner([kk[0], kk[1], K('o3', 0.508, 1765, 1)]).every(x => x === null) && cmpLeaner([kk[0], kk[1], K('o3', 0.395, 2515, 1)]).every(x => x === null)
    && cmpLeaner([kk[0], kk[1], K('o3', 0.395, 1765, 1, { inactive: true })]).every(x => x === null) && cmpLeaner([kk[0], kk[2]]).every(x => x === null) && cmpLeaner(null).length === 0,
    'negative: C detours no more than B / is not cheaper than B / no works / no B → not marked');
  ok(cmpWin(3, 2, false) === '3 days × 2 peak hours' && cmpWin(1, 1, false) === '1 day × 1 peak hour' && cmpWin(3, 2, true) === '3 天 × 2 个高峰小时' && cmpWin(0, 2, false) === '', 'the clash window is written as "3 days × 2 peak hours" (other rows are one hour); no overlap after staggering → empty');

  // 5b Real network + the page's real 04 / 03 code
  const wsUrl = APPS + 'api/public/js/worksites.js';
  const W = existsSync(wsUrl) ? await import(pathToFileURL(wsUrl).href) : null;
  const res5 = await be.options(plan, { n: 3 }), kits5 = cmpFromOptions(res5);
  const ENG = readFileSync(WEB + 'src/js/6-engine.js', 'utf8'), CLS = readFileSync(WEB + 'src/js/8-clash.js', 'utf8'), CMS = readFileSync(WEB + 'src/js/8-compare.js', 'utf8');
  const fmt = ENG.slice(ENG.indexOf('const esc='), ENG.indexOf('const TYPES4='));
  const SUMO_LINK = 'l595594354_9756035316';
  ok(EP.link === SUMO_LINK && EP.lanes === 1 && kits5.length === 3, 'the demo plan is the stretch SUMO covers (Lonsdale, 1 lane closed); options() gives 3 plans');
  const page = (client, ep = EP) => {
    const c = { console, EP: { ...ep, all: false }, BE: { api: be }, S: { ui: 4, step: 4 }, LANG: { cur: 'en' }, SUMO_LINK, SU: { seed: 42, mod: null, index: null },
      document: { getElementById: () => null, querySelector: () => null }, compactPanel() {}, toast() {}, creditLines: () => [], engOn: () => true, engNet: () => be.engine.net,
      setInterval: () => 1, clearInterval() {}, sumoErr: e => String((e && e.message) || e), sumoReason: k => 'why:' + k, sumoClient: client };
    c.L = (en, zh) => (c.LANG.cur === 'zh' ? zh : en);
    vm.createContext(c);
    vm.runInContext(pure('6-engine.js') + '\n' + fmt + '\n' + CLS + '\n' + CMS + '\n;globalThis.X={CP,CL};', c);
    Object.assign(c.X.CP, { rows: kits5, key: 'k5', src: 'kits', busy: false });
    if (W) Object.assign(c.X.CL, { m: W, src: 'seed', listP: Promise.resolve(W.SEEDS) });
    return c;
  };
  // Engine numbers that must not appear: the ones seen live + those the engine computed for these 3 plans (queue, extra wait per vehicle, network delay, tram and bus, pedestrians)
  const H = n => Math.round(Number(n) || 0).toLocaleString('en-AU');
  const engNums = new Set(['918', '509', '10,493', '18,693', '33,015', '79']);
  for (const k of kits5) { const s = k.s; for (const v of [s.queue_m, s.mean_delay_s, s.delay_min, s.transit && s.transit.pax_min, s.peds && s.peds.extra_min]) if (Number.isFinite(v) && Math.round(v) >= 10) engNums.add(H(v)); }
  const leaks = html => [...engNums].filter(n => new RegExp(`(?<![\\d,.$])${n}(?![\\d]|,\\d)`).test(html.replace(/A\$[\d,]+/g, 'A$')));
  const metricsFor = p => ({ works_queue_equiv_end_m: 300 - 200 * p + 0.4, works_queue_max_m: 400, works_traffic_extra_s: 40 - 10 * p, mean_extra_s: 7 + 2 * p, cohort_vehicles: 1565, detour_vehicles: Math.round(p * 100) });
  const calls = [];
  let release;
  const gate = new Promise(r => { release = r; });
  const cli = { runOptions: async (opts, params) => { calls.push({ opts, params }); await gate; return { source: 'live', runId: 'x', elapsedMs: 61234, index: { hour: 8, seed: params.seed, options: opts.map(o => ({ id: o.id, p: o.p, metrics: metricsFor(o.p) })) } }; } };
  const c = page(async () => cli);
  const pend = c.cmpSuUpdate();
  const busyHtml = c.cmpHTML();
  ok(/SUMO computing the options in the cloud · <span data-cmpsuel>\d+<\/span> s \(about 1 min\)/.test(busyHtml) && busyHtml.includes('class="spin"') && !leaks(busyHtml).length,
    `while SUMO computes: one spinner row in the table, "SUMO computing the options in the cloud · X s (about 1 min)", no engine numbers${leaks(busyHtml).length ? ' (leaked ' + leaks(busyHtml) + ')' : ''}`);
  const pRow = /Drivers who detour \(AI sign reading\)[\s\S]*?<\/tr>/.exec(busyHtml);
  ok(pRow && pRow[0].includes('>14%<') && pRow[0].includes('>49%<') && pRow[0].includes('>61%<') && pRow[0].includes('SUMO’s input'), `the "AI sign reading → drivers who detour" row: p from the engine's sign reading (14% / 49% / 61%), labelled as SUMO's input`);
  release(); await pend;
  ok(calls.length === 1 && JSON.stringify(calls[0].opts) === JSON.stringify([{ id: 'A', p: 0.14 }, { id: 'B', p: cmpP(kits5[1].s) }, { id: 'C', p: cmpP(kits5[2].s) }]) && calls[0].params.seed === 42,
    `calls runOptions([{id,p}…], {seed: SU.seed}): ${calls[0] && calls[0].opts.map(o => o.id + ' ' + o.p).join(' / ')} · seed ${calls[0] && calls[0].params.seed}`);
  const html = c.cmpHTML(), lk = leaks(html);
  ok(!lk.length, `negative: no engine traffic numbers anywhere in the 04 table (checked ${[...engNums].join(' / ')})${lk.length ? ' — leaked ' + lk.join(', ') : ''}`);
  const cell = (row) => { const m = new RegExp(`${row}[\\s\\S]*?</tr>`).exec(html); return m ? [...m[0].matchAll(/<span class="cmp-num">([^<]+)<\/span>/g)].map(x => x[1]) : []; };
  const q = cell('Works queue at 09:00'), ex = cell('Extra per vehicle through the works'), tot = cell('Total extra delay in the SUMO area'), dv = cell('Detoured vehicles');
  const want = kits5.map(k => metricsFor(cmpP(k.s)));
  ok(q.join() === want.map(m => H(m.works_queue_equiv_end_m)).join() && ex.join() === want.map(m => H(m.works_traffic_extra_s)).join()
    && tot.join() === want.map(m => H(m.mean_extra_s * m.cohort_vehicles / 60)).join() && dv.join() === want.map(m => H(m.detour_vehicles)).join(),
    `SUMO numbers fill the table cell by cell: 09:00 queue ${q.join(' / ')} m · per vehicle ${ex.join(' / ')} s · total delay ${tot.join(' / ')} veh·min · detours ${dv.join(' / ')} vehicles`);
  ok(html.includes('≈ mean × vehicles') && !/Trams &amp; buses|Trams & buses/.test(html) && !/Pedestrians/.test(html) && !html.includes('not covered by SUMO') && html.includes('SUMO on the real CBD network around the works · cars only'),
    'the SUMO 04 table no longer has tram/bus and pedestrian rows and does not say "not covered by SUMO"; the footer says "cars only"; total delay is marked "≈ mean × vehicles"');
  const amt = H(kits5[1].hire - kits5[2].hire);
  ok(html.includes(`<i class="cmp-dup" data-eq data-lean>One VMS fewer than B, A$${amt} cheaper · just better wording</i>`) && !html.includes('Same traffic effect') && !html.includes('Same result as'),
    `C's marker: "One VMS fewer than B, A$${amt} cheaper · just better wording"; all p differ → no "Same traffic effect"`);
  ok(/SUMO computed live in the cloud · 61\.2 s · seed 42/.test(html) && html.includes('Traffic 08:00–09:00 weekday · SUMO on the real CBD network') && !/engine on real CBD flows|Car, tram &amp; bus and on-foot numbers|Car, tram & bus and on-foot numbers/.test(html),
    'the table footer credits SUMO (computed live · seconds · seed), no longer "engine on real CBD flows"');
  c.LANG.cur = 'zh'; const zh = c.cmpHTML(); c.LANG.cur = 'en';
  ok(zh.includes(`比 B 少一块 VMS、便宜 A$${amt} · 只靠写对屏上的字`) && zh.includes('AI 读牌 → 会绕行的司机') && !zh.includes('SUMO 暂不覆盖') && zh.includes('只含机动车') && !leaks(zh).length, 'Chinese: the "one VMS fewer than B, A$… cheaper · just better wording" marker, the "AI sign reading → drivers who detour" row, "cars only", and no "not covered by SUMO"');
  // "Same traffic effect" appears only when p is equal (here B's reading is replaced with A's); B has two more VMS + an arrow board than A → says "extra equipment", not just the arrow board
  const eqP = page(async () => cli); Object.assign(eqP.X.CP, { rows: [kits5[0], { ...kits5[1], s: kits5[0].s }, kits5[2]], key: 'k5eq' });
  const he2 = eqP.cmpHTML(), amtBA = H(kits5[1].hire - kits5[0].hire);
  ok(he2.includes(`<i class="cmp-dup" data-eq>Same traffic effect as A · models don't value the extra equipment's safety role · +A$${amtBA}</i>`) && !he2.includes('arrow board&#39;s') && !he2.includes("arrow board's"),
    `"Same traffic effect as A" only when p is equal (B adds two VMS + an arrow board → says "extra equipment", not just the arrow board · +A$${amtBA})`);

  // Nearby-works row: which works, dates, window, suggested stagger days; no engine clash cost and no be.clash per plan
  if (W) {
    await c.cmpClashUpdate();
    const x = c.X.CP.cl && c.X.CP.cl.other, row = c.cmpClashRow(() => '');
    const sug = x && Math.max(1, Math.min(14, (Date.parse(c.clashCur().time.to) - Date.parse(x.ws.time.from)) / 864e5 + 1));
    ok(x && x.r.flags.reliable && x.r.cost > 0 && c.X.CP.cl.cells.length === 0, `04 clash row: picks ${x && x.o.id} (the engine picks behind the scenes), no per-plan clash cost any more`);
    ok(x && row.includes(cmpSpan(x.r.overlap.from, x.r.overlap.to, false)) && row.includes(cmpWin(x.r.overlap.days, x.r.hours.length, false)) && row.includes(`suggest staggering it ${sug} day`)
      && (row.match(new RegExp(`suggest staggering it ${sug} day`, 'g')) || []).length === 3 && !row.includes('not covered by SUMO') && !row.includes(H(x.r.cost)) && !leaks(row).length,
      `04 clash row: dates, "${x && cmpWin(x.r.overlap.days, x.r.hours.length, false)}", each cell says "suggest staggering it ${sug} days" (no longer "combined impact not covered by SUMO"), no +${x && H(x.r.cost)}`);
    if (x) for (const v of [x.r.cost, x.r.a, x.r.b, x.r.ab]) if (Math.abs(v) >= 100) engNums.add(H(v));
    const full = c.cmpHTML();
    ok(!leaks(full).length && !full.includes('not covered by SUMO'), `negative: with the clash row filled in, the whole 04 table still has no engine numbers (also checked the clash D(A) / D(B) / D(A+B) / cost)${leaks(full).length ? ' — leaked ' + leaks(full) : ''}`);
    // The 03 nearby-works tab (8-clash.js) uses the same method
    c.S.ui = 3; c.X.CL.key = JSON.stringify(c.clashCur()); await c.clashRun();
    const h3 = c.clashHTML(), o3 = c.X.CL.other;
    ok(o3 && h3.includes(`Suggestion: stagger ${o3.o.title} by ${sug} day`) && h3.includes('Combined impact not covered by SUMO') && h3.includes(cmpWin(o3.r.overlap.days, o3.r.hours.length, false))
      && ![o3.r.cost, o3.r.a, o3.r.b, o3.r.ab].filter(v => Math.abs(v) >= 100).some(v => new RegExp(`(?<![\\d,])${H(v)}(?![\\d]|,\\d)`).test(h3)) && !/veh·min/.test(h3) && c.clashBtnHTML() === '',
      `03 nearby works: name, dates, window, suggested stagger of ${sug} days; no D(A) / D(B) / D(A+B) / clash cost, and no engine "Stagger" button`);
    const e3 = page(async () => cli, { ...EP, lanes: 2 });
    Object.assign(e3.X.CL, { other: o3, more: [], key: 'x' });
    const h3e = e3.clashHTML();
    ok(h3e.includes('Engine estimate.') && h3e.includes(H(o3.r.cost)) && e3.clashBtnHTML().includes('Stagger by'), 'plans outside SUMO coverage: 03 still gives the engine clash cost and the stagger button, labelled "Engine estimate"');
    c.S.ui = 4;
  } else console.log('⏭ skipping the clash section: apps/api worksites.js not found');

  // 05 export (C chosen): the cards show SUMO's total delay, with no tram/bus or pedestrian cells
  c.S.ui = 5; c.X.CP.pick = 2;
  const h5 = c.cmpHTML();
  ok(h5.includes('Extra delay · SUMO area') && h5.includes(H(want[2].mean_extra_s * 1565 / 60)) && !h5.includes('Tram & bus') && !h5.includes('On foot') && !h5.includes('not covered by SUMO') && h5.includes('model estimates of car traffic') && !leaks(h5).length && h5.includes('Traffic numbers: SUMO'),
    `05 export cards: extra delay in the SUMO area ${H(want[2].mean_extra_s * 1565 / 60)} veh·min, no tram/bus or pedestrian cells, no "not covered by SUMO" (the pre-delivery confirmation says "model estimates of car traffic"), no engine numbers`);
  c.S.ui = 4; c.X.CP.pick = null;
  // AI explanation: not requested on SUMO plans (explain.js reads engine numbers), and no "leaning" either
  let asked = 0; c.X.CP.mod = { ex: { explainOptions: () => { asked++; return Promise.resolve({}); }, optionFromRun: () => ({}) } };
  c.cmpExplainUpdate(); await new Promise(r => setImmediate(r));
  ok(asked === 0 && c.X.CP.explain === null, 'SUMO plans do not call explainOptions (it would quote engine numbers); hidden, not fed');
  // The execution pack's "plans compared" table (cmpDocHTML src:'sumo')
  const packUrl5 = APPS + 'api/public/js/pack.js';
  if (existsSync(packUrl5)) {
    const pack = await import(pathToFileURL(packUrl5).href);
    if (typeof pack.packDoc === 'function') {
      const inventory = await pack.loadInventory({ fetch: fakeFetch }), net = be.engine.net, ws = kits5[2].plan.worksites[0];
      const pk = pack.buildPack({ ...ws, title: ws.name, status: 'decided', decision: { option: 'C', by: 'council', reason: 'r', at: '2026-10-01T00:00:00.000Z' } }, { inventory, links: new Map(ws.links.map(id => [id, net.links.get(id)])) });
      const Hh = { L: en => en, esc: x => String(x == null ? '' : x).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])), fmt: H };
      const rowsX = kits5.map((k, i) => ({ id: k.id, label: k.label, car: want[i].mean_extra_s * 1565 / 60, transit: null, peds: null, hire: k.hire }));
      const doc = cmpDocHTML(pack.packDoc(pk, 'en'), { rows: rowsX, src: 'sumo', pick: 2, by: 'Council', hour: '08:00', date: '1 Oct 2026' }, Hh);
      ok(doc.includes('Extra delay · SUMO area') && (doc.match(/not covered by SUMO/g) || []).length >= 6 && doc.includes('Traffic numbers: SUMO') && !doc.includes('simulation engine') && !leaks(doc).length,
        'execution pack "plans compared": extra delay in the SUMO area, tram/bus and pedestrians say "not covered by SUMO", credited to SUMO, not the engine');
    }
  }

  // runOptions missing (client not updated yet) / throws / client not loaded / no result → every cell —, with the reason, never engine numbers standing in
  const bad = async (client, re, what) => {
    const f = page(client); await f.cmpSuUpdate(); const h = f.cmpHTML(), q5 = /Works queue at 09:00[\s\S]*?<\/tr>/.exec(h);
    ok(re.test(h) && q5 && [...q5[0].matchAll(/<span class="cmp-num">([^<]+)<\/span>/g)].every(m => m[1] === '—') && h.includes('data-cmpsure') && !leaks(h).length && !/<b>boom/.test(h),
      `${what} → the SUMO rows are —, with the reason and a "Retry", no engine numbers`);
  };
  await bad(async () => ({ runReal() {} }), /SUMO numbers unavailable: this SUMO client has no runOptions yet/, 'client has no runOptions yet');
  await bad(async () => ({ runOptions: async () => { throw new Error('<b>boom</b>'); } }), /the SUMO options run failed \(&lt;b&gt;boom&lt;\/b&gt;\)/, 'runOptions throws (error text escaped)');
  await bad(async () => { throw new Error('404'); }, /the SUMO client did not load \(404\)/, 'sumo-client.js failed to load');
  await bad(async () => ({ runOptions: async () => ({ source: 'none', reason: 'health_down', index: null }) }), /SUMO gave no result for these plans \(why:health_down\)/, 'runOptions returns no result for these plans');
  await bad(undefined, /this SUMO client has no runOptions yet/, 'the page has no sumoClient (5-app.js not loaded)');

  // Plans outside SUMO coverage (here only the lane count changes to 2): 04 still shows engine numbers, labelled "engine estimate", and does not call runOptions
  const n = [];
  const e = page(async () => ({ runOptions: async () => { n.push(1); return {}; } }), { ...EP, lanes: 2 });
  await e.cmpSuUpdate();
  const he = e.cmpHTML();
  ok(n.length === 0 && he.includes(`>${H(kits5[0].s.queue_m)}<`) && he.includes(`>${H(kits5[0].s.delay_min)}<`) && !he.includes('Same result as A') && he.includes(`One VMS fewer than B, A$${amt} cheaper · just better wording`) && he.includes('engine estimate on real CBD flows') && !he.includes('not covered by SUMO'),
    `outside SUMO coverage: engine numbers as before (queue ${H(kits5[0].s.queue_m)} m, network ${H(kits5[0].s.delay_min)} veh·min), C still marked "One VMS fewer than B…", labelled "engine estimate", no runOptions call`);

  // 6 Background prefetch: a successful live SUMO run in step 2 (sumoRerun in 5-app.js) → immediately builds the three plans as 04 does, reads p, calls runOptions (no rendering); when 04 opens,
  //   a cache hit shows numbers at once and a run still in progress is joined (the spinner continues from the seconds already elapsed); if step 2 is still running, 04 queues behind it; at most one cloud job per page at a time.
  //   Runs the page's real 8-compare.js + sumoLane / sumoRerun from 5-app.js, with a fake SUMO client (runReal / runOptions can both be held, and concurrency is counted)
  {
    const APPX = readFileSync(WEB + 'src/js/5-app.js', 'utf8');
    const laneSrc = APPX.slice(APPX.indexOf('let sumoTail='), APPX.indexOf('\n', APPX.indexOf('function sumoLane(')) + 1);
    const i0 = APPX.indexOf('async function sumoRerun(){'), rerunSrc = APPX.slice(i0, APPX.indexOf('\n}\n', i0) + 3);
    ok(laneSrc.includes('function sumoLane(fn)') && rerunSrc.includes('cmpPrefetch(seed)'), '5-app.js has sumoLane / sumoRerun (this section runs them)');
    const settle = async (n = 30, until = () => false) => { for (let i = 0; i < n && !until(); i++) await new Promise(r => setImmediate(r)); };
    const mkCli = () => {
      const log = { real: 0, opts: 0, active: 0, max: 0, last: null }, gates = [];
      const busy = async () => { log.active++; log.max = Math.max(log.max, log.active); await new Promise(r => gates.push(r)); log.active--; };
      const cli = {
        runReal: async params => { log.real++; await busy(); return { source: 'live', runId: 'r' + log.real, elapsedMs: 50000, index: { hour: 8, seed: params.seed } }; },
        runOptions: async (opts, params) => { log.opts++; log.last = { opts, params }; await busy(); return { source: 'live', runId: 'o' + log.opts, elapsedMs: 61234, index: { hour: 8, seed: params.seed, options: opts.map(o => ({ id: o.id, p: o.p, metrics: metricsFor(o.p) })) } }; },
      };
      return { cli, log, open: () => { const g = gates.shift(); if (g) g(); return !!g; } };
    };
    const nOpt = { n: 0 }, beApi = { ...be, options: (...a) => { nOpt.n++; return be.options(...a); } };
    const page2 = cli => {
      const c = { console, EP: { ...EP, all: false }, BE: { api: beApi }, S: { ui: 2, step: 2, sim: null }, LANG: { cur: 'en' }, SUMO_LINK,
        SU: { cli, seed: 42, mod: null, index: null, busy: false, tok: 0, ref: { source: 'baked' }, src: { source: 'baked' }, failed: false },
        document: { getElementById: () => null, querySelector: () => null }, compactPanel() {}, toast() {}, creditLines: () => [], engOn: () => true, engNet: () => be.engine.net,
        setInterval: () => 1, clearInterval() {}, sumoErr: e => String((e && e.message) || e), sumoReason: k => 'why:' + k, sumoClient: async () => cli,
        sumoWant: () => true, renderPanel() {}, gridShown: () => false, sumoPAi: () => 0.53, sumoKey: () => 'k', performance: { now: () => Date.now() }, sumoBaked: async () => {}, sumoPlay: async () => {} };
      c.L = (en, zh) => (c.LANG.cur === 'zh' ? zh : en);
      vm.createContext(c);
      vm.runInContext(pure('6-engine.js') + '\n' + fmt + '\n' + CLS + '\n' + CMS + '\n' + laneSrc + '\n' + rerunSrc + '\n;globalThis.X={CP,CL,CSU};', c);
      const pf = [], orig = c.cmpPrefetch; c.cmpPrefetch = seed => { const p = orig(seed); pf.push({ seed, p }); return p; }; // record how many times sumoRerun prefetches
      return { c, pf };
    };
    const open04 = c => { Object.assign(c.X.CP, { rows: kits5, key: 'k5', src: 'kits', busy: false }); c.S.ui = 4; };
    const nums04 = html => { const m = /Works queue at 09:00[\s\S]*?<\/tr>/.exec(html); return m ? [...m[0].matchAll(/<span class="cmp-num">([^<]+)<\/span>/g)].map(x => x[1]) : []; };
    const wantQ = kits5.map(k => H(metricsFor(cmpP(k.s)).works_queue_equiv_end_m)).join();

    // 6a step 2 succeeds → one prefetch; 04 opens while it is still running → joins it; later visits to 04 → cache hit, numbers at once
    {
      const f = mkCli(), { c, pf } = page2(f.cli);
      const run = c.sumoRerun(); await settle(30, () => f.log.real === 1);
      ok(f.log.real === 1 && c.SU.busy && pf.length === 0, 'no prefetch while step 2 is computing in the cloud');
      f.open(); await run;
      ok(pf.length === 1 && pf[0].seed === 42, 'step 2 live run succeeds (source live) → one cmpPrefetch(this seed, 42) call, not awaited');
      const job = await pf[0].p; await settle(60, () => f.log.opts === 1);
      ok(job && f.log.opts === 1 && JSON.stringify(f.log.last.opts) === JSON.stringify(cmpSuAsk(kits5)) && f.log.last.params.seed === 42 && nOpt.n === 1,
        `prefetch: builds the three plans as 04 does (be.options once), p = 1 − original-route share, calls runOptions(${f.log.last && f.log.last.opts.map(o => o.id + ' ' + o.p).join(' / ')}, {seed: 42}) in the background`);
      ok(await c.cmpOptions(c.planFrom(c.EP)) && nOpt.n === 1, '04 builds its plans from the same be.options() result (cmpOptions), not computed again');
      const run2 = c.sumoRerun(); await settle(30);
      ok(f.log.real === 1 && c.SU.busy, 'clicking "Run SUMO" again while the prefetch is computing → step 2 queues behind it; no second concurrent job');
      open04(c); job.t1 -= 30000; // the prefetch has been running for 30 s
      const u = c.cmpSuUpdate(), h = c.cmpHTML();
      ok(c.X.CP.su.job === job && /SUMO computing the options in the cloud · <span data-cmpsuel>3\d<\/span> s/.test(h) && f.log.opts === 1,
        '04 opens while the prefetch is running → joins the same job: the spinner continues from the 30 s already elapsed, no new runOptions');
      f.open(); await u; await settle(30, () => f.log.real === 2);
      const h2 = c.cmpHTML();
      ok(f.log.opts === 1 && nums04(h2).join() === wantQ && !h2.includes('class="spin"'), `prefetch finishes → 04 shows SUMO numbers straight away (09:00 queue ${nums04(h2).join(' / ')} m), runOptions called once in total`);
      ok(f.log.real === 2, 'step 2\'s re-run runReal waits until the prefetch finishes');
      f.open(); await run2; await settle(60);
      ok(pf.length === 2 && f.log.opts === 1, 'after step 2 re-runs (same seed, same p) another prefetch → cache hit, not run again');
      c.X.CP.su = null; c.X.CP.key = 'k5b';
      c.cmpSuUpdate(); const h3 = c.cmpHTML();
      ok(nums04(h3).join() === wantQ && !h3.includes('class="spin"') && f.log.opts === 1, 'entering 04 again (cache hit) → numbers at once: no spinner, no new runOptions');
      c.SU.seed = 7; c.X.CP.su = null; const u7 = c.cmpSuUpdate(); await settle(30, () => f.log.opts === 2);
      ok(f.log.opts === 2 && f.log.last.params.seed === 7 && c.cmpHTML().includes('class="spin"'), 'seed changed → new key → recomputed');
      f.open(); await u7;
      ok(f.log.max === 1, `at most 1 concurrent cloud job throughout (max ${f.log.max})`);
    }

    // 6b entering 04 while step 2 is still running → 04 queues for it (saying it is waiting for step 2); 04 runs after step 2 finishes; the prefetch computes the same key → joins it, no second run
    {
      const f = mkCli(), { c, pf } = page2(f.cli);
      const run = c.sumoRerun(); await settle(30, () => f.log.real === 1);
      open04(c);
      const drew = [], r0 = c.cmpRender; c.cmpRender = () => { drew.push(!!(c.X.CP.su && c.X.CP.su.job && c.X.CP.su.job.wait)); return r0(); }; // the real page relies on a redraw to change the text
      const u = c.cmpSuUpdate(); await settle(30, () => c.X.CP.su.job && c.X.CP.su.job.wait);
      const h = c.cmpHTML();
      ok(f.log.opts === 0 && c.X.CP.su.job.wait && drew.includes(true) && h.includes('Waiting for step 2’s SUMO run to finish, then these plans') && h.includes('(one cloud run at a time)'),
        'step 2 still computing in the cloud → 04 queues behind it (redrawn once when queuing starts), says it is waiting for step 2\'s SUMO run before these plans, no second concurrent job');
      c.LANG.cur = 'zh'; ok(c.cmpHTML().includes('等第 2 步的 SUMO 算完，再算这几套方案'), 'Chinese: waiting for step 2\'s SUMO run, then these plans'); c.LANG.cur = 'en';
      f.open(); await run; await settle(30, () => f.log.opts === 1);
      ok(f.log.opts === 1 && !c.X.CP.su.job.wait && c.X.CP.su.job.t1 > 0 && c.cmpHTML().includes('SUMO computing the options in the cloud'), 'step 2 finishes → 04\'s job starts (spinner changes to "SUMO computing the options in the cloud")');
      const pj = await pf[0].p; await settle(30);
      ok(pf.length === 1 && pj === c.X.CP.su.job && f.log.opts === 1, 'the prefetch triggered by step 2 finishing computes the same key (seed + p) → joins 04\'s job, no second run');
      f.open(); await u;
      ok(nums04(c.cmpHTML()).join() === wantQ && f.log.real === 1 && f.log.opts === 1 && f.log.max === 1, 'numbers shown; runReal once, runOptions once, at most 1 at a time');
    }

    // 6c a failed prefetch is not cached (04's "Retry" really re-runs); no prefetch when step 2 did not compute live (pre-computed fallback)
    {
      const f = mkCli(), { c, pf } = page2(f.cli);
      let fails = 1; const ro = f.cli.runOptions; f.cli.runOptions = async (o, p) => (fails-- > 0 ? (f.log.opts++, { source: 'none', reason: 'sumo_busy', index: null }) : ro(o, p));
      const j = await c.cmpPrefetch(42); await j.p;
      ok(j.out && !j.out.r.index && !c.X.CSU.has(j.key), 'prefetch failed (source none) → not kept in the cache');
      open04(c); const u = c.cmpSuUpdate(); await settle(30, () => f.log.opts === 2);
      ok(f.log.opts === 2 && c.X.CP.su.job !== j, 'entering 04 afterwards → recomputes rather than using the failed run');
      f.open(); await u;
      const g = mkCli(), p2 = page2(g.cli); g.cli.runReal = async () => { g.log.real++; return { source: 'baked', reason: 'sumo_busy', index: { hour: 8, seed: 42 } }; };
      await p2.c.sumoRerun(); await settle(10);
      ok(g.log.real === 1 && p2.pf.length === 0 && g.log.opts === 0, 'step 2 used the pre-computed run (cloud run failed) → no prefetch');
    }
  }
}

console.log(`${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
