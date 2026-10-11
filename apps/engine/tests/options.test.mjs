// Inventory-constrained options: be.options(worksite | plan) → Minimum / Standard / Guided, each run by the engine with hire cost and a stock check.
// Real network + real equipment.json (URL fetches go through an injected fake fetch, offline). All numbers come from the engine; which kit congests less is recorded, not asserted
import { readFileSync, existsSync } from 'node:fs';
import { ok, t, done } from './_t.mjs';
import { connect, PATHS } from '../public/js/backend.js';
import { vmsTextOk, daysOf, resolveNeeds, hireOf, TIERS, tierNeeds, vmsRead, guidedFrames, WARN_FRAME, delayFrames, vms2At, VMS2_AT_M, DELAY_HEAD } from '../public/js/options.js';
import { signsOn } from '../public/js/reading.js';
const clone = x => JSON.parse(JSON.stringify(x));

const APPS = new URL('../../', import.meta.url); // apps/
const file = p => new URL('.' + p, APPS);
const has = p => existsSync(file(p));
if (!has(PATHS.network) || !has(PATHS.equipment)) { ok(false, 'apps/roads/public/cbd/network.json or equipment.json not found'); done(); }
const fakeFetch = async url => (existsSync(file(url)) ? { ok: true, status: 200, json: async () => JSON.parse(readFileSync(file(url), 'utf8')) } : { ok: false, status: 404 });
const repoImporter = async url => { if (!existsSync(file(url))) throw new Error('404 ' + url); return import(file(url).href); };
const noImporter = async url => { throw new Error('404 ' + url); };
const INV = JSON.parse(readFileSync(file(PATHS.equipment), 'utf8'));
const stockOfItem = (inv, id) => inv.items.find(i => i.id === id)?.qty ?? 0;
const usedByItem = plan => {
  const m = new Map();
  for (const ws of plan.worksites) for (const e of ws.equipment || []) if (e.item) m.set(e.item, (m.get(e.item) || 0) + e.qty);
  return m;
};
const vmsOf = o => o.plan.worksites[0].equipment.find(e => e.type === 'vms');
const vmsAll = o => o.plan.worksites[0].equipment.filter(e => e.type === 'vms');
const pOf = o => { const st = o.result.routes.find(r => r.id === 'stay'); return +(1 - st.share).toFixed(3); }; // detour share = 1 − stay share (SUMO's input)

const be = await connect({ fetch: fakeFetch, importer: noImporter });
const LON = be.demo('lonsdale');

await t('lonsdale: shape of the 3 kits', async () => {
  const r = await be.options(LON);
  ok(r.options.map(o => o.id).join() === 'o1,o2,o3' && r.options.map(o => o.label).join() === 'Minimum,Standard,Guided', 'fixed tier ids / labels: o1 Minimum, o2 Standard, o3 Guided');
  ok(r.worksite === 'B-12' && r.when.hour === 8 && r.days === 5 && r.site.len_m > 0 && r.inventory.assumed === true, `built for B-12 at 08:00, ${r.days} hire days, ${r.site.len_m} m closed`);
  ok(r.options.every(o => be.validate(o.plan).length === 0 && o.plan.worksites[0].equipment.every(e => typeof e.item === 'string' && INV.items.some(i => i.id === e.item) && Number.isInteger(e.qty) && e.qty >= 1 && e.qty <= 500)),
    'every kit plan runs in the engine; every item carries item (equipment.json id) and qty (1–500), so pack.js can quote the same plan');
  const [o1, o2, o3] = r.options;
  ok(!vmsOf(o1) && !o1.plan.worksites[0].equipment.some(e => e.type === 'arrow') && o1.plan.worksites[0].equipment.some(e => e.type === 'barrier') && o1.plan.worksites[0].equipment.some(e => e.text === 'END ROADWORK'),
    'Minimum: barriers + static signs (including END ROADWORK), no VMS, no arrow board');
  const want2 = JSON.stringify([DELAY_HEAD, [`${o2.delay.min} MIN`]]);
  ok(vmsAll(o2).length === 2 && vmsAll(o2).every(v => JSON.stringify(v.frames) === want2) && o2.plan.worksites[0].equipment.some(e => e.type === 'arrow'),
    `Standard: adds an arrow board + two VMS reporting delay without naming a road: ${vmsAll(o2).map(v => `${v.id} ${v.at_m} m ${v.frames.map(f => f.join(' / ')).join(' ▸ ')}`).join('; ')}`);
  ok(vmsAll(o3).length === 1 && o3.flags.guided && vmsOf(o3).frames.flat().includes('USE') && vmsOf(o3).at_m === vmsOf(o2).at_m, `Guided: one VMS at the same position as Standard's first (${vmsOf(o3).at_m} m), naming the fastest detour: ${vmsOf(o3).frames.map(f => f.join(' / ')).join(' | ')}`);
  const barrier = o1.plan.worksites[0].equipment.find(e => e.type === 'barrier');
  const unit = INV.items.find(i => i.id === barrier.item).unit_len_m;
  ok(barrier.item === 'barrier_water' && barrier.qty === Math.ceil(r.site.len_m / unit), `barrier count = ⌈${r.site.len_m} m ÷ ${unit} m per section⌉ = ${barrier.qty}`);
  ok(r.options.every(o => ['queue_m', 'delay_min', 'affected_min', 'mean_delay_s', 'detour_share'].every(k => Number.isFinite(o.result[k]) && o.result[k] >= 0) && !('raw' in o.result)),
    'each kit\'s result is engine numbers (queue, delay, detour share), without raw');
  ok(r.options.every(o => o.result.transit?.src && Number.isFinite(o.result.transit.pax_min)), 'transit summary included (transit.json loaded)');
});

await t('hire: qty × day rate × days, labelled assumed (negative test: never unlabelled)', async () => {
  const r = await be.options(LON);
  ok(daysOf({ from: '2026-10-05', to: '2026-10-09' }) === 5 && daysOf({ from: '2026-10-05', to: '2026-10-05' }) === 1 && daysOf(undefined) === 1, 'days = calendar days inclusive; no dates = 1 day');
  ok(r.options.every(o => o.hire.assumed === true && /assumed/i.test(o.hire.note) && o.flags.assumed.includes('hire.day_rate_aud') && o.flags.assumed.includes('stock.qty')), 'every kit has hire.assumed = true, a note saying the values are assumed, and flags.assumed listing hire rate and stock (D-0929-1536)');
  ok(r.options.every(o => o.hire.lines.every(l => l.cost_aud === l.qty * l.day_rate_aud * l.days && l.days === 5) && o.hire.total_aud === o.hire.lines.reduce((s, l) => s + l.cost_aud, 0)), 'each line cost = qty × day_rate × days, total = sum of lines');
  ok(r.options.every(o => { const u = usedByItem(o.plan); return o.hire.lines.length === u.size && o.hire.lines.every(l => u.get(l.item) === l.qty); }), 'quote lines match the kit equipment one to one (one line per item)');
  ok(r.options[1].hire.total_aud > r.options[0].hire.total_aud && r.options[1].vs.hire_aud === r.options[1].hire.total_aud - r.options[0].hire.total_aud, `Standard costs A$${r.options[1].vs.hire_aud} more than Minimum (two VMS + arrow board)`);
});

await t('never over stock (negative test)', async () => {
  const r = await be.options(LON);
  ok(r.options.every(o => [...usedByItem(o.plan)].every(([id, q]) => q <= stockOfItem(INV, id)) && o.stock.ok && o.stock.short.length === 0), 'real stock: every item quantity ≤ stock, stock.ok');
  const tiny = clone(INV);
  const set = (id, q) => { tiny.items.find(i => i.id === id).qty = q; };
  set('barrier_water', 5); set('barrier_klemmfix', 0); set('barrier_steel', 0); set('arrow_board', 0); set('vms_a', 0); set('vms_c', 1);
  const be2 = await connect({ fetch: fakeFetch, importer: noImporter, equipment: tiny });
  const r2 = await be2.options(be2.demo('lonsdale'));
  ok(r2.options.every(o => [...usedByItem(o.plan)].every(([id, q]) => q <= stockOfItem(tiny, id))), 'with very little stock every item quantity is still ≤ stock (nothing forced in)');
  const o3 = r2.options[2];
  ok(!o3.stock.ok && !o3.flags.ok && o3.stock.short.some(s => s.item === 'barrier_water' && s.got === 5 && s.need > 5) && o3.stock.short.some(s => s.item === 'arrow_board' && s.got === 0),
    `shortfalls go into stock.short (${o3.stock.short.find(s => s.item === 'barrier_water')?.need} barriers needed, only 5; 0 arrow boards), flags.ok = false`);
  ok(vmsOf(o3)?.item === 'vms_c' && !o3.plan.worksites[0].equipment.some(e => e.type === 'arrow'), 'no type A VMS in stock → type C; no arrow board in stock → none in the kit');
  set('vms_c', 0);
  const r3 = await (await connect({ fetch: fakeFetch, importer: noImporter, equipment: tiny })).options(LON);
  ok(!vmsOf(r3.options[2]) && r3.options[2].stock.short.some(s => s.equipment === 'VMS-1' && s.got === 0), 'no VMS in stock at all → Guided has no VMS, VMS-1 recorded in short');
  const { equipment, short } = resolveNeeds([{ id: 'X', type: 'sign', at_m: 0, text: 'ROADWORK AHEAD', items: ['no_such_item'] }], INV);
  ok(equipment.length === 0 && short[0].why === 'not_in_inventory', 'items not in the inventory are not placed, recorded as not_in_inventory');
  ok(hireOf([{ id: 'X', item: 'no_such_item', qty: 1 }], INV, 3).unpriced[0] === 'no_such_item', 'equipment without a price goes into unpriced, not counted as $0');
  // several needs competing for the same stock: lane + both footpaths closed, 5 water-filled barriers, 1 FOOTPATH CLOSED sign
  set('sign_footpath_closed', 1);
  const fpT = be.demo('lonsdale'); fpT.worksites[0].closes = { lanes: 1, footpath: 'both' };
  const o4 = (await (await connect({ fetch: fakeFetch, importer: noImporter, equipment: tiny })).options(fpT, { n: 1 })).options[0];
  ok([...usedByItem(o4.plan)].every(([id, q]) => q <= stockOfItem(tiny, id)), `competing needs still total ≤ stock: ${JSON.stringify(Object.fromEntries(usedByItem(o4.plan)))}`);
  ok(['B-1', 'B-FL', 'B-FR', 'S-FR'].every(id => o4.stock.short.some(s => s.equipment === id)) && o4.stock.short.find(s => s.equipment === 'B-FL').got === 5 && !o4.flags.ok,
    'shortfalls recorded per need: the footpath gets the 5 water-filled barriers first; the right footpath, lane barrier and second FOOTPATH CLOSED all go into stock.short');
});

await t('barrier allocation: footpaths only use footpath-capable barriers and are served first (negative test)', async () => {
  const site = (len_m, footpath) => ({ len_m, lanes: 2, close_lanes: 1, full: false, footpath, missing: [] });
  const noWater = clone(INV); noWater.items.find(i => i.id === 'barrier_water').qty = 0;
  const a = resolveNeeds(tierNeeds(TIERS[0], {}, site(43, 'left')), noWater);
  ok(!a.equipment.some(e => e.id === 'B-FL') && a.short.some(s => s.equipment === 'B-FL' && s.item === 'barrier_water' && s.got === 0) && a.equipment.find(e => e.id === 'B-1')?.item === 'barrier_klemmfix',
    'no water-filled barriers: footpaths do not substitute plastic / steel barriers (can_close lacks footpath), shortfall goes into short; the lane still uses plastic barriers');
  const b = resolveNeeds(tierNeeds(TIERS[0], {}, site(300, 'left')), INV);
  ok(b.short.length === 0 && b.equipment.find(e => e.id === 'B-FL').item === 'barrier_water' && b.equipment.find(e => e.id === 'B-1').item === 'barrier_klemmfix' && b.equipment[0].id === 'B-1',
    '300 m + one footpath closed: the footpath takes 150 water-filled barriers, the lane switches to plastic barriers, no false shortfall; output order unchanged');
  const c = resolveNeeds(tierNeeds(TIERS[0], {}, site(150, 'both')), INV);
  ok(c.short.length === 0 && c.equipment.filter(e => e.item === 'barrier_water').reduce((n, e) => n + e.qty, 0) <= 200, '150 m + both footpaths closed: real stock suffices, no false shortfall');
});

await t('END ROADWORK takes no reading slot: a distant VMS is still read (negative test)', async () => {
  const site = { len_m: 43, lanes: 2, close_lanes: 1, full: false, footpath: 'both', missing: [] };
  const eq = tierNeeds(TIERS[2], {}, site, { vmsAt: 400, frames: [['ROADWORK', 'AHEAD'], ['USE', 'RUSSELL']] }).map(({ items, close, len_m, ...e }) => e);
  const seen = signsOn({ kmh: 40 }, { equipment: eq });
  ok(eq.some(e => e.text === 'END ROADWORK' && e.at_m < 0) && !seen.some(x => x.text === 'END ROADWORK') && seen.some(x => x.kind === 'vms' && x.m === 400) && seen.length === 6 && vmsRead(eq),
    'both footpaths + VMS at 400 m: END ROADWORK at the end of the works (at_m < 0) is not in the reading request; all 6 upstream signs are read');
  ok(!vmsRead([...eq, { id: 'X', type: 'sign', at_m: 10, text: 'ROADWORK AHEAD' }]), 'a 7th upstream sign pushes out the farthest VMS → vmsRead = false');
  const fp = be.demo('lonsdale'); fp.worksites[0].closes = { lanes: 1, footpath: 'both' };
  const [, o2, o3] = (await be.options(fp)).options;
  ok(o3.flags.vms_read, 'both footpaths: o3\'s VMS is in the reading request (flags.vms_read)');
  const seen2 = signsOn({ kmh: 40 }, o2.plan.worksites[0]);
  ok(!o2.flags.vms_read && !o2.flags.ok && seen2.length === 6 && seen2.some(x => x.kind === 'vms' && x.m === vmsAll(o2)[0].at_m) && !seen2.some(x => x.kind === 'vms' && x.m === vmsAll(o2)[1].at_m),
    `both footpaths: Standard has 7 upstream signs and the farthest, VMS-2 (${vmsAll(o2)[1].at_m} m), is pushed out by the 6-sign limit → flags.vms_read = false, flags.ok = false, reported truthfully (reader rules unchanged)`);
  ok(!o3.flags.guided || o3.result.queue_m !== o2.result.queue_m || o3.result.delay_min !== o2.result.delay_min, `both footpaths: Guided names a detour, so its engine result differs from Standard (o2 ${o2.result.queue_m} m · o3 ${o3.result.queue_m} m)`);
  if (o3.flags.guided) {
    const far = clone(o3.plan); far.worksites[0].equipment.find(e => e.type === 'vms').at_m = 400;
    const s = await be.run(far);
    ok(s.queue_m !== o2.result.queue_m || s.delay_min !== o2.result.delay_min, `the same Guided kit with its VMS moved to 400 m still works (${s.queue_m} m, Standard ${o2.result.queue_m} m)`);
  }
});

await t('time-overlapping worksites in the same plan share stock (negative test)', async () => {
  const other = { ...clone(be.demo('latrobe').worksites[0]), id: 'C-1', time: clone(LON.worksites[0].time) };
  other.equipment = [...(other.equipment || []), { id: 'V-C', type: 'vms', at_m: 300, frames: [['ROADWORK', 'AHEAD']], item: 'vms_a', qty: 4 }];
  const two = { when: clone(LON.when), worksites: [clone(LON.worksites[0]), other] };
  const r = await be.options(two);
  ok(r.options.every(o => [...usedByItem(o.plan)].every(([id, q]) => q <= stockOfItem(INV, id))), 'whole-plan totals (including the 4 type A VMS held by C-1) ≤ stock for every item');
  ok(vmsOf(r.options[1]).item === 'vms_c' && r.options.every(o => o.stock.shared_with.includes('C-1')), 'type A VMS used up by C-1 → this worksite uses type C; stock.shared_with records C-1');
  const later = clone(two); later.worksites[1].time = { from: '2026-11-02', to: '2026-11-03', hours: [7, 19] };
  const rl = await be.options(later);
  ok(vmsOf(rl.options[1]).item === 'vms_a' && rl.options.every(o => o.stock.shared_with.length === 0), 'the other worksite is on different days → no shared stock, type A as usual');
});

await t('Guided VMS text is valid (negative test)', async () => {
  const r = await be.options(LON);
  const f = vmsOf(r.options[2]).frames;
  ok(vmsTextOk(f) && f.length <= 2 && f.every(fr => fr.length <= 4 && fr.every(l => l.length <= 10 && l === l.toUpperCase())) && f.flat().join(' ').split(/\s+/).length <= 8, `≤ 2 frames × ≤ 4 lines × ≤ 10 characters, ≤ 8 words, upper case: ${JSON.stringify(f)}`);
  ok(!vmsTextOk([['ROADWORKSAHEAD']]) && !vmsTextOk([['use', 'russell']]) && !vmsTextOk([['A'], ['B'], ['C']]) && !vmsTextOk([['ONE TWO', 'THREE FOUR', 'FIVE SIX', 'SEVEN'], ['EIGHT', 'NINE']]), 'vmsTextOk rejects: a 14-character line, lower case, 3 frames, 9 words');
  if (!has(PATHS.check)) { ok(true, '(skipped checkSigns: apps/api/public/js/check.js not in the repo)'); return; }
  const beT5 = await connect({ fetch: fakeFetch, importer: repoImporter });
  const r5 = await beT5.options(LON);
  ok(r5.options.every(o => o.flags.sign_errors.length === 0 && o.flags.failed === 0 && beT5.check(o.plan).every(c => c.ok)), 'apps/api checkSigns finds no errors in the three kits (including the END ROADWORK sign), and no reading failed');
});

await t('same input, same output, input unchanged (determinism)', async () => {
  const input = be.demo('lonsdale');
  const before = JSON.stringify(input);
  const a = JSON.stringify(await be.options(input));
  const b = JSON.stringify(await be.options(input));
  const c = JSON.stringify(await (await connect({ fetch: fakeFetch, importer: noImporter })).options(input));
  ok(a === b && a === c, 'two calls on one be and one on a fresh connect give byte-identical output');
  ok(JSON.stringify(input) === before, 'the input plan is unchanged');
});

await t('which kit congests less: engine numbers recorded, not asserted', async () => {
  for (const name of be.demos) {
    const r = await be.options(be.demo(name));
    const line = r.options.map(o => `${o.id} queue ${o.result.queue_m} m · network ${o.result.delay_min} veh·min · A$${o.hire.total_aud}`).join('; ');
    ok(true, `record ${name} ${r.when.hour}:00: ${line}${r.options[2].flags.no_faster_detour ? ' (no faster detour; the Guided VMS falls back to ROADWORK / AHEAD)' : ''}`);
    const [, o2, o3] = r.options;
    ok(o3.flags.no_faster_detour ? JSON.stringify(vmsOf(o3).frames) === JSON.stringify([WARN_FRAME]) && !o3.flags.guided : o3.flags.guided, `${name}: no faster detour ⇔ Guided names no road and shows ROADWORK / AHEAD (no_faster_detour = ${o3.flags.no_faster_detour})`);
    ok(o2.flags.no_delay_min ? vmsAll(o2).every(v => JSON.stringify(v.frames) === JSON.stringify([WARN_FRAME])) && o2.delay.min === null : vmsAll(o2).every(v => JSON.stringify(v.frames) === JSON.stringify([DELAY_HEAD, [`${o2.delay.min} MIN`]])),
      `${name}: Standard's two VMS ${o2.flags.no_delay_min ? 'under 1 extra minute on the stay route → show ROADWORK / AHEAD (no_delay_min)' : `report ${o2.delay.min} min`}`);
  }
});

await t('input forms: single worksite, when, n, worksite', async () => {
  const ws = clone(LON.worksites[0]);
  const r = await be.options(ws);
  ok(r.when.date === ws.time.from && r.when.hour === 8, `worksite only → start date and the first sampled hour (${r.when.date} ${r.when.hour}:00)`);
  const r17 = await be.options(ws, { when: { date: '2026-10-06', hour: 17 } });
  ok(r17.when.hour === 17 && r17.options.every(o => o.plan.when.hour === 17), 'a given when is used');
  ok((await be.options(LON, { n: 1 })).options.map(o => o.id).join() === 'o1' && (await be.options(LON, { n: 2 })).options.map(o => o.id).join() === 'o1,o2' && (await be.options(LON, { n: 9 })).options.length === TIERS.length, 'n = 1 / 2 / 9 → 1 / 2 / 3 kits');
  const two = { when: LON.when, worksites: [clone(LON.worksites[0]), { ...clone(be.demo('latrobe').worksites[0]), id: 'C-1' }] };
  const rc = await be.options(two, { worksite: 'C-1' });
  ok(rc.worksite === 'C-1' && rc.options.every(o => JSON.stringify(o.plan.worksites[0]) === JSON.stringify(two.worksites[0])), 'whole plan + named worksite → only that worksite\'s equipment changes; the others are computed as they are');
  const bad = async (x, o) => { try { await be.options(x, o); return null; } catch (e) { return e.code; } };
  ok(await bad({ ...ws, links: [ws.links[0], 'no-such-link'] }) === 'bad_plan', 'only some links missing from the network → still bad_plan (no 0 m barrier under-count)');
  ok(await bad({ ...ws, time: { ...ws.time, from: '2026-10-09', to: '2026-10-05' } }) === 'bad_plan' && await bad({ ...ws, time: { ...ws.time, from: '2026-13-01' } }) === 'bad_plan'
    && await bad({ ...ws, time: { ...ws.time, hours: [] } }) === 'bad_plan' && await bad(ws, { when: { date: '2026-10-06', hour: null } }) === 'bad_plan',
    'from after to, a non-existent date, empty hours, when.hour not 0–23 → bad_plan (no more silent 1 day / 0 queue)');
  const off = await be.options(ws, { when: { date: '2026-10-06', hour: 3 } });
  ok(off.options.every(o => o.flags.inactive && !o.flags.ok), `works inactive at when (03:00, hours ${JSON.stringify(ws.time.hours)}) → flags.inactive, flags.ok = false`);
  ok(await bad({ ...ws, links: ['no-such-link'] }) === 'bad_plan' && await bad({ ...ws, time: undefined }) === 'bad_plan' && await bad(two, { worksite: 'nope' }) === 'bad_plan' && await bad({ ...ws, closes: { lanes: 1, footpath: 'north' } }) === 'bad_plan',
    'links not in the network, no time and no when, named worksite missing, malformed closes.footpath → bad_plan');
  const noInv = await connect({ fetch: async url => (url.endsWith('equipment.json') ? { ok: false, status: 404 } : fakeFetch(url)), importer: noImporter });
  ok(await (async () => { try { await noInv.options(LON); return null; } catch (e) { return e.code; } })() === 'no_inventory', 'inventory unavailable → throws no_inventory (not a pretend $0)');
});

await t('full closure, footpath closure', async () => {
  const full = be.demo('lonsdale'); full.worksites[0].closes = { lanes: 2 };
  const rf = await be.options(full);
  const eq = rf.options[1].plan.worksites[0].equipment;
  ok(rf.site.full && rf.options.every(o => o.flags.full_closure) && eq.some(e => e.item === 'sign_detour_straight') && !eq.some(e => e.type === 'arrow'), 'full closure: the lane sign becomes DETOUR AHEAD, no arrow board, flags.full_closure');
  const fp = be.demo('lonsdale'); fp.worksites[0].closes = { lanes: 1, footpath: 'both' };
  const rp = await be.options(fp, { n: 1 });
  const e1 = rp.options[0].plan.worksites[0].equipment;
  const fb = e1.filter(e => e.type === 'barrier' && e.id.startsWith('B-F'));
  ok(fb.length === 2 && fb.every(e => INV.items.find(i => i.id === e.item).can_close.includes('footpath')) && e1.filter(e => e.item === 'sign_footpath_closed').length === 2, 'both footpaths: per side a row of footpath-capable barriers + one FOOTPATH CLOSED');
  ok(rp.options[0].result.peds && Number.isFinite(rp.options[0].result.peds.extra_min), `footpath closed → result includes the pedestrian detour (+${rp.options[0].result.peds?.extra_min} person-minutes)`);
});

await t('Guided VMS text passes the real apps/api check: the advisor\'s own suggestion must not trigger our own warnings (negative test)', async () => {
  ok(JSON.stringify(guidedFrames([['USE', 'RUSSELL'], ['SAVE', '9 MIN']])) === '[["USE","RUSSELL"],["SAVE","9 MIN"]]', 'two frames from the advisor → used as given, no ROADWORK / AHEAD added (a VMS has at most two frames; the S-1 static sign already says ROADWORK AHEAD)');
  ok(JSON.stringify(guidedFrames(['USE', 'RUSSELL'])) === JSON.stringify([WARN_FRAME, ['USE', 'RUSSELL']]) && JSON.stringify(guidedFrames([['USE', 'RUSSELL']])) === JSON.stringify([WARN_FRAME, ['USE', 'RUSSELL']]), 'a single frame (older form) → ROADWORK / AHEAD added in front');
  ok(guidedFrames([['USE', 'RUSSELL'], ['SAVE', '9 MIN'], ['NOW']]) === null && guidedFrames([['TOO LONG LINE']]) === null && guidedFrames(null) === null && guidedFrames([]) === null, 'three frames, a line over 10 characters, empty → null');
  if (!has('/api/public/js/check.js')) { ok(false, 'apps/api/public/js/check.js not found'); return; }
  const bt = await connect({ fetch: fakeFetch, importer: repoImporter });
  ok(bt.status().check === 't5', `uses the real apps/api checkSigns (status().check = ${bt.status().check})`);
  const r = await bt.options(LON), o3 = r.options[2];
  ok(o3.flags.guided, `Lonsdale at 08:00 has a faster detour, which Guided names: ${vmsOf(o3).frames.map(f => f.join(' / ')).join(' ▸ ')}`);
  const fr = vmsOf(o3).frames;
  ok(fr.length === 2 && fr.every(f => f.length <= 3) && fr[1].every(l => l.length <= 8) && fr[1][0] === 'SAVE' && /^\d{1,2} MIN$/.test(fr[1][1]), 'two frames, ≤ 3 lines each; second frame SAVE / N MIN with ≤ 8 characters per line');
  const warns = bt.check(o3.plan).flatMap(c => [...(c.ok ? [] : [c.error?.code]), ...(c.warnings || []).map(w => w.code)]);
  ok(!warns.some(c => ['long_line', 'many_lines', 'frames_too_fast', 'line_too_long', 'too_many_lines', 'too_many_words'].includes(c)), `the Guided VMS has no too-long / too-many-lines / too-fast warnings (actual: ${JSON.stringify(warns)})`);
  const adv = await bt.advise(be.demo('lonsdale'));
  const texts = (adv.options || adv.suggestions || []).filter(o => o.kind === 'text' && o.frames);
  ok(texts.length >= 1 && texts.every(o => o.frames.length <= 2 && o.frames.every(f => f.length <= 3)), `the step 4 advisor's reword suggestions are also ≤ 2 frames × ≤ 3 lines (${texts.map(o => o.frames.map(f => f.join(' / ')).join(' ▸ ')).join('; ')})`);
});

await t('three tiers: A Minimum < C Guided (one VMS naming a detour) < B Standard (two VMS reporting delay); A and B no longer identical', async () => {
  // pure functions: delayFrames / vms2At / tierNeeds
  const sum = (stay, delay_min = 100, worksite = 'W') => ({ approaches: [{ worksite, delay_min, routes: [{ id: 'stay', usual_min: 1.2, now_min: 1.2 + stay }, { id: 'r1', usual_min: 2, now_min: 2 }] }] });
  ok(JSON.stringify(delayFrames(sum(9.7), 'W')) === JSON.stringify({ min: 10, frames: [['EXPECT', 'DELAYS'], ['10 MIN']] }) && delayFrames(sum(0.4), 'W') === null && delayFrames(sum(9.7), 'X') === null
    && delayFrames(sum(250), 'W').min === 99 && delayFrames(null, 'W') === null && delayFrames({ approaches: [] }, 'W') === null,
    'delayFrames: 9.7 extra minutes on the stay route → EXPECT / DELAYS ▸ 10 MIN; under 1 minute / another worksite / no summary → null; capped at 99');
  const two = { approaches: [sum(3, 50).approaches[0], sum(12, 900).approaches[0]] };
  ok(delayFrames(two, 'W').min === 12, 'several approaches: like the advisor, the one with the largest delay first');
  ok(vms2At(200, 436) === 400 && vms2At(200, null) === VMS2_AT_M && vms2At(300, 1000) === VMS2_AT_M && vms2At(450, 436) === 500 && vms2At(200, 180) === 250,
    'vms2At: upstream stretch 436 m → 400 m; unknown / long enough → 500 m; at least 50 m beyond the first');
  const site = { len_m: 43, lanes: 2, close_lanes: 1, full: false, footpath: 'none', missing: [], up_m: 436 };
  const fr = [['EXPECT', 'DELAYS'], ['10 MIN']];
  const nB = tierNeeds(TIERS[1], {}, site, { vmsAt: 200, frames: fr }).filter(e => e.type === 'vms'), nC = tierNeeds(TIERS[2], {}, site, { vmsAt: 200, frames: fr }).filter(e => e.type === 'vms');
  ok(nB.map(e => `${e.id}@${e.at_m}`).join() === 'VMS-1@200,VMS-2@400' && nB.every(e => JSON.stringify(e.frames) === JSON.stringify(fr)) && nC.map(e => e.id).join() === 'VMS-1'
    && !tierNeeds(TIERS[0], {}, site).some(e => e.type === 'vms'), 'tierNeeds: Standard VMS-1 (200 m) + VMS-2 (400 m) with the same text; Guided only VMS-1; Minimum no VMS');

  // real network, Lonsdale at 08:00, apps/api reader (the page's chain: wordings not in the answers file use its keyword rules) + apps/api checkSigns
  if (!has(PATHS.check)) { ok(false, 'apps/api/public/js/check.js not found'); return; }
  const bt = await connect({ fetch: fakeFetch, importer: repoImporter });
  const r = await bt.options(LON), [A, B, C] = r.options;
  const n = B.delay.min, st = A.result.routes.find(x => x.id === 'stay');
  ok(Number.isInteger(n) && n >= 1 && Math.abs(n - st.extra_min) <= 0.6, `N on B's VMS = the Minimum kit's ${st.extra_min} extra minutes per vehicle on the stay route → ${n} MIN (whole minutes, ≥ 1)`);
  ok(vmsAll(B).length === 2 && vmsAll(B)[1].at_m > vmsAll(B)[0].at_m && vmsAll(B).every(v => JSON.stringify(v.frames) === JSON.stringify([DELAY_HEAD, [`${n} MIN`]]) && !v.frames.flat().some(l => /USE|VIA|AVOID|RUSSELL|EXHIBITION|SPRING/.test(l))),
    `B: both VMS (${vmsAll(B).map(v => v.at_m + ' m').join(', ')}) show EXPECT / DELAYS ▸ ${n} MIN and name no road`);
  ok(vmsAll(B)[1].at_m === 400 && vmsAll(B)[1].at_m < 436, 'B\'s VMS-2 is 400 m upstream: before the Exhibition St turn (298 m) and within the modelled upstream stretch (to Spring St, 436 m)');
  ok(vmsAll(C).length === 1 && C.flags.guided && /^USE$/.test(vmsOf(C).frames[0][0]) && vmsOf(C).frames[1][0] === 'SAVE', `C: one VMS naming the fastest detour + minutes saved: ${vmsOf(C).frames.map(f => f.join(' / ')).join(' ▸ ')}`);
  const [hA, hB, hC] = r.options.map(o => o.hire.total_aud), vmsRate = INV.items.find(i => i.id === vmsOf(B).item).day_rate_aud;
  ok(hA < hC && hC < hB && hB - hC === vmsRate * r.days, `hire A$${hA} < C A$${hC} < B A$${hB}; B − C = one VMS × ${r.days} days = A$${vmsRate * r.days}`);
  ok(r.options.every(o => vmsAll(o).every(v => vmsTextOk(v.frames)) && o.flags.vms_text_ok !== false && o.stock.ok && o.flags.ok) && [...usedByItem(B.plan)].every(([id, q]) => q <= stockOfItem(INV, id)),
    'all three kits\' VMS text passes vmsTextOk, within stock, flags.ok');
  const warns = r.options.flatMap(o => bt.check(o.plan).flatMap(c => [...(c.ok ? [] : [c.error?.code]), ...(c.warnings || []).map(w => w.code)]));
  ok(warns.length === 0 && r.options.every(o => o.flags.sign_errors.length === 0), `apps/api checkSigns on the three kits: no errors and no warnings such as "over 8 characters" (actual: ${JSON.stringify(warns)})`);
  const [pA, pB, pC] = r.options.map(pOf);
  ok(pA < pB && pB < pC, `detour share (1 − stay share, SUMO's input) A ${pA} < B ${pB} < C ${pC} (apps/api reader: B reads a ${n} min delay, C reads a named road + minutes saved)`);
  // the engine's own keyword rules (fallback when the apps/api reader does not load) only match "N MIN DELAY" and cannot read "DELAYS / N MIN": recorded as is, reader rules not changed to fix the order
  const rm = await be.options(LON);
  ok(true, `record: with the engine's own rule reader A ${pOf(rm.options[0])} · B ${pOf(rm.options[1])} · C ${pOf(rm.options[2])} (these rules cannot read the minutes in B's "EXPECT DELAYS / ${n} MIN")`);

  // stock: only 1 VMS left → B places 1, the shortfall goes into stock.short (nothing forced in)
  const one = clone(INV); one.items.find(i => i.id === 'vms_a').qty = 1; one.items.find(i => i.id === 'vms_c').qty = 0;
  const r1 = await (await connect({ fetch: fakeFetch, importer: noImporter, equipment: one })).options(LON), B1 = r1.options[1];
  ok(vmsAll(B1).length === 1 && B1.stock.short.some(s => s.equipment === 'VMS-2' && s.got === 0) && !B1.flags.ok && r1.options.every(o => [...usedByItem(o.plan)].every(([id, q]) => q <= stockOfItem(one, id))),
    'only 1 VMS in stock: B places only VMS-1, VMS-2 goes into stock.short, flags.ok = false; every kit within stock');
});
done();
