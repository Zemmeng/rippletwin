// SUMO primary (every on-screen traffic number comes from SUMO; the engine stays behind the scenes): the whole of 6-engine.js + 6e-sumo3.js run in node with a fake EP / SU / engine result,
// rendering 03 (engPanel3 → sumoPanel3 / evidence / nearby works), the 04 advisor (eng4HTML), the 05 export text (engPlaybook) and the 01 check (engMoreHTML);
// asserts that not one engine traffic number appears on the SUMO plan (918 / 509 / 10,493 / 18,693 / 33,015 / 79 m / 937 / 1,651 / 1,582),
// while other plans still show the engine's numbers. Called by tests/test_sumo_primary.py; one ✅ / ❌ line per assertion, no network access.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const WEB = HERE + '../', APPS = WEB + '../';
let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log('✅ ' + msg); } else { fail++; console.log('❌ ' + msg); } };

// The only top-level side effect in 6-engine.js is BE.ready=import(...) (connects to the backend): replace it with an empty Promise, keep the rest as is
const engSrc = readFileSync(WEB + 'src/js/6-engine.js', 'utf8');
const eng = engSrc.replace(/BE\.ready=import\([\s\S]*?\.then\(engAfterConnect\);/, 'BE.ready=Promise.resolve();');
ok(eng !== engSrc, 'BE.ready=import(...) in 6-engine.js replaced (no backend connection)');
const s3 = readFileSync(WEB + 'src/js/6e-sumo3.js', 'utf8');

const SUMO_LINK = 'l595594354_9756035316';
const stubs = `
const LANG={cur:'en'};const L=(en,zh)=>LANG.cur==='zh'?zh:en;
const clamp=(v,a,b)=>v<a?a:v>b?b:v;
const CITY={x0:-1150,x1:750,y0:-950,y1:450};
const S={step:3,ui:3,booted:true,layers:{works:true}};
const SUMO_LINK='${SUMO_LINK}';
const SU={index:null,src:{source:'baked'},busy:false,scen:'original',seed:42};
const navHTML=()=>'<div class="cta"></div>';
const sumoImpactHTML=()=>'';
const aiPlanSrc=()=>({src:'llm',tone:'ok',rule:false});
const aiSrcLabel=s=>'LLM · '+s;
const sumoReason=k=>'reason:'+k;
let wentTo=0;const goStep=n=>{wentTo=n;};
const toast=()=>{},renderPanel=()=>{},vlAfterRun=()=>{},gridRebuild=()=>{},cmpRender=()=>{};
`;
const ctx = {};
vm.createContext(ctx);
vm.runInContext(stubs + eng + '\n' + s3 + `
;globalThis.G={EP,BE,SU,S,LANG,engPanel3,eng4HTML,engPlaybook,engMoreHTML,engSumFor,sumoPanel3,sumo3Evidence,sumo3Clash,sumo3Eng4,sumo3Playbook,sumo3More,sumoPlanOn,sumo3Held,sumo3Win,sumo3Scen,sumo3P,sumo3Cur};`, ctx);
const G = ctx.G, { EP, BE, SU, LANG } = G;

// ---- Fake data: engine (none of these numbers may appear on the SUMO plan) ----
const BAD = ['918', '509', '10,493', '10493', '18,693', '18693', '33,015', '33015', '79 m', '937', '1,651', '1651', '1,582', '1582'];
const leaks = h => BAD.filter(x => String(h).includes(x));
const bt = (v, d) => ({ vehicles: v, per_capita_min: 33.015, detour: d, informed: .7 });
const SUM = {
  street: 'Lonsdale Street', when: { hour: 8 }, queue_m: 918, mean_delay_s: 509, delay_min: 10493, detour_share: .14, vehicles: 1144, blocked_vph: 0,
  routes: [{ id: 'stay', name: 'Lonsdale Street', share: .86, now_min: 12.3, usual_min: 3.1 }, { id: 'r1', name: 'Russell Street', share: .14, now_min: 4.2, usual_min: 4.0 }],
  by_type: { commuter: bt(500, .14), local: bt(300, .14), tourist: bt(200, .14), delivery: bt(144, .14) },
  approaches: [{ volume: 1144, by_type: { commuter: { detour: .14, informed: .7 }, local: { detour: .14, informed: .7 }, tourist: { detour: .14, informed: .7 }, delivery: { detour: .14, informed: .7 } } }], main: 0,
  hot: [{ id: 'h1', name: 'Spring Street', extra_min: 18693, queue_m: 918 }],
  flags: { ok: true, params: 'params', reading_src: 'llm' }, why: { commuter: 'x' },
  transit: { src: 'gtfs', routes: [{ mode: 'tram', short: '86', headsign: 'Docklands', trips_h: 12, pax_h: 1000, delay_s: 509, links: [] }], pax_min: 33015, trips_h: 12, pax_h: 1000, blocked_routes: 0, assumed: { pax_per_trip: { tram: 80, bus: 30 } } },
  peds: { src: 'x', footpath: 'left', closed: ['w1'], ped_h: 937, detour_m: 79, crossings: 1, extra_min: 1651, measured: true, assumed: { walk_mps: 1.3 } },
  raw: { links: [{ id: SUMO_LINK, v: 1144, cap: 810 }] },
};
const ADV = { src: 'rule', flags: { ok: true, missing: 0, failed: 0 }, window: { single_hour: false, whens: 30 },
  options: [{ kind: 'text', frames: [['USE', 'RUSSELL'], ['SAVE', '9 MIN']], why: 'Name the fastest detour (Russell Street) and the 9 min it saves, 18693 veh·min.', delta_min: -94920, better: true, plan: { worksites: [] } },
    { kind: 'shift', days: 5, why: 'removes about 33015 extra vehicle-minutes', delta_min: -600, better: true, plan: { worksites: [] } }] };
const CMP = { before: { queue_m: 918, mean_delay_s: 509, detour_share: .14, delay_min: 18693, street: 'Lonsdale Street', transit: { src: 'x', pax_min: 33015 }, flags: { ok: true, params: 'params' } },
  after: { queue_m: 79, mean_delay_s: 47, detour_share: .53, delay_min: 1651, street: 'Lonsdale Street', transit: { src: 'x', pax_min: 937 }, flags: { ok: true, params: 'params' } },
  delta: { queue_m: -839, mean_delay_s: -462, detour_share: .39, delay_min: -17042, street: 'Lonsdale Street', main_changed: false } };
// ---- Fake data: SUMO, one-hour fields (the shape of index.json) ----
const met = (o) => Object.assign({ vehicles: 6400, completed: 14300, collisions: 0, emergency_braking: 1, mean_timeloss_s: 217.2, works_queue_mean_m: 158.9, works_capacity_assumption_vph: 810, works_demand_vph: 1100 }, o);
const IDX = { version: 2, engine: 'Eclipse SUMO sumo 1.27.1', seed: 42, hour: 8, works: { link: SUMO_LINK, lanes_closed: 1 },
  params: { p_original: 0.14, p_ai: 0.53, hour_window: [8, 9], shown_s: 3600, green_2935: 0.5, works_lane_speed_kmh: 30, network_links: 356, demand_veh_per_h: 15677 },
  assumptions: { en: ['Model cross-check, not a field measurement.'], zh: ['模型之间的交叉检验，不是实测。'] },
  scenarios: [
    { id: 'baseline', diversion_share: 0, metrics: met({ works_queue_end_m: 22.7, works_queue_equiv_end_m: 15.2, works_throughput_vph: 1161, detour_vehicles: 0, works_queue_max_m: 152.1, works_traffic_extra_s: null }) },
    { id: 'original', label: { en: 'Original plan · ROADWORK AHEAD', zh: '原方案 · ROADWORK AHEAD' }, diversion_share: 0.14, metrics: met({ works_queue_end_m: 245.8, works_queue_equiv_end_m: 973.1, works_queue_equiv_end_vehicles: { lonsdale_albert: 22.2, side_streets: 15.0, waiting_to_enter: 240.8 }, works_throughput_vph: 805, works_traffic_extra_s: 533.3, mean_extra_s: 38.6, detour_vehicles: 73, works_queue_max_m: 373.2 }) },
    { id: 'ai', label: { en: 'AI plan · USE RUSSELL', zh: 'AI 方案 · USE RUSSELL' }, diversion_share: 0.53, metrics: met({ works_queue_end_m: 260.0, works_queue_equiv_end_m: 304.6, works_queue_equiv_end_vehicles: { lonsdale_albert: 7.6, side_streets: 1.0, waiting_to_enter: 78.4 }, works_throughput_vph: 788, works_traffic_extra_s: 396.4, mean_extra_s: 39.8, detour_vehicles: 287, works_queue_max_m: 278.2 }) }] };

const base = () => Object.assign(EP, { link: SUMO_LINK, lanes: 1, lanesMax: 2, all: false, street: 'Lonsdale Street', dir: 'W', hour: 8, f1: 'ROADWORK\nAHEAD', f2: '', sign: 'RIGHT LANE CLOSED',
  tab3: 'net', view3: 'traffic', badText: false, runErr: null, busy: false, sum: JSON.parse(JSON.stringify(SUM)), adv: JSON.parse(JSON.stringify(ADV)), advBusy: false, pick: 0, cmp: JSON.parse(JSON.stringify(CMP)), cmpBusy: false, mix: null });
BE.api = { engine: null }; LANG.cur = 'en';

// 1 Pure functions
ok(G.sumo3Held(IDX.scenarios[1].metrics) === 278 && G.sumo3Held(IDX.scenarios[2].metrics) === 87, 'vehicles held up = sum of works_queue_equiv_end_vehicles (original plan 278, AI plan 87)');
ok(G.sumo3Held({ works_queue_equiv_end_m: 973.1 }) === 278, 'no vehicle-count field → round(works_queue_equiv_end_m × 2 / 7) = 278');
ok(G.sumo3Held({ works_held_end: 301, works_queue_equiv_end_m: 973.1 }) === 301, 'works_held_end is used when present');
ok(G.sumo3Held({ works_queue_max_m: 160 }) === null, 'negative: the old 12-minute data has none of these fields → null (nothing invented)');
ok(JSON.stringify(G.sumo3Win(IDX)) === '[8,9]' && JSON.stringify(G.sumo3Win({ hour: 17 })) === '[17,18]', 'SUMO hour: hour_window, otherwise 1 hour from index.hour');
ok(G.sumo3Scen(IDX, .14, '') === 'original' && G.sumo3Scen(IDX, .5, '') === 'ai' && G.sumo3Scen(IDX, null, 'USE RUSSELL') === 'ai' && G.sumo3Scen(IDX, null, 'ROADWORK AHEAD') === 'original',
  'SUMO scenario matching the plan: nearest to this plan\'s AI-read detour share; with no reading, Russell on the sign = AI plan, otherwise the original plan');

// 2 SUMO plan · 03 traffic: SUMO not run → card + button to step 2
base(); SU.index = null;
ok(G.sumoPlanOn(), 'Lonsdale with 1 lane closed = SUMO plan');
let h = G.engPanel3();
ok(h.includes('Run SUMO in step 2 first') && h.includes('data-sumo3-go="2"') && h.includes('data-view3="traffic"'), 'SUMO not run: 03 shows "Run SUMO in step 2 first" + a button to step 2; the tabs are still there');
ok(!leaks(h).length, `negative: with SUMO not run, 03 still shows no engine numbers (leaked ${leaks(h).join(', ')})`);

// 3 SUMO plan · 03 traffic: one-hour data, pre-computed
SU.index = IDX; SU.src = { source: 'baked', reason: 'network', seed: 42 };
h = G.engPanel3();
ok(h.includes('At 09:00, 278 vehicles are held up by the works; the queue on Lonsdale St is 246 m'), 'headline: At 09:00, 278 vehicles are held up by the works; the queue on Lonsdale St is 246 m');
ok(['805', '+533', '>73<', '373'].every(x => h.includes(x)), 'four tiles: works throughput 805 veh/h, +533 s per vehicle, 73 vehicles detour, longest queue 373 m');
ok(h.includes('SUMO · pre-computed · seed 42') && h.includes('reason:network'), 'source: pre-computed · seed 42 + reason');
ok(h.includes('<tr class="cur"><th scope="row" style="white-space:nowrap" title="Original plan · ROADWORK AHEAD">Original</th>') && h.includes('<th scope="row" style="white-space:nowrap" title="AI plan · USE RUSSELL">AI plan</th>') && h.includes('>87<') && h.includes('<td>260</td>') && h.includes('>287<'), 'original plan vs AI plan in two rows with the same metrics; the current plan\'s row is marked');
ok(h.includes('SUMO’s input') && h.includes('<b>14%</b>') && h.includes('<b>53%</b>'), 'the AI-read detour share is labelled as SUMO\'s input (14% / 53%)');
ok(h.includes('not covered by SUMO') && !/<p class="[^"]*\bmuted\b[^"]*"[^>]*>Trams, buses/.test(h), 'trams / buses / pedestrians: not covered by SUMO (not muted, so visible in compact mode too)');
ok(!leaks(h).length, `negative: the 03 traffic view has no engine numbers at all (leaked ${leaks(h).join(', ')})`);
ok(!/engine/i.test(h.replace(/data-[a-z0-9-]+="[^"]*"/g, '')), 'negative: the 03 traffic view does not mention the engine (no comparison with engine numbers)');
ok(!h.includes('Live engine'), 'negative: no "Live engine" badge in the header');
SU.src = { source: 'live', elapsedMs: 15234, seed: 7 };
ok(G.engPanel3().includes('Cloud SUMO · computed live · 15.2 s · seed 7'), 'source: cloud, computed live · 15.2 s · seed 7');
EP.sum.detour_share = .53;
h = G.engPanel3();
ok(h.includes('At 09:00, 87 vehicles are held up by the works; the queue on Lonsdale St is 260 m') && h.includes('<tr class="cur"><th scope="row" style="white-space:nowrap" title="AI plan · USE RUSSELL">AI plan</th>'), 'the plan\'s signs read as 53% detour → shows the AI plan run (87 vehicles, 260 m)');
EP.sum.detour_share = .30;
ok(G.engPanel3().includes('nearest SUMO run'), 'the plan\'s share is far from both runs → notes that the nearest run is shown');
base(); LANG.cur = 'zh';
h = G.engPanel3();
ok(h.includes('09:00 时，被施工拦住的车有 278 辆；Lonsdale St 上排队 246 米') && h.includes('SUMO 暂不覆盖'), 'Chinese: headline and "not covered by SUMO"');
ok(!leaks(h).length, `negative: the Chinese 03 has no engine numbers either (leaked ${leaks(h).join(', ')})`);
LANG.cur = 'en';

// 4 Old data (12 minutes, no one-hour fields): use the fields that exist, show no engine numbers
const OLD = JSON.parse(readFileSync(APPS + 'sumo/public/real/index.json', 'utf8'));
SU.index = OLD; SU.src = { source: 'baked', seed: OLD.seed };
const oldHour = OLD.scenarios.some(s => s.metrics && s.metrics.works_queue_end_m != null);
h = G.engPanel3();
ok(oldHour ? h.includes('held up by the works') : h.includes('-minute run the works queue on Lonsdale St reaches'), `the SUMO data in the repo (${oldHour ? 'one hour' : '12 minutes'}) renders too: ${oldHour ? 'one-hour headline' : 'falls back to the "longest queue" headline'}`);
ok(!leaks(h).length, `negative: 03 on old data has no engine numbers either (leaked ${leaks(h).join(', ')})`);
SU.index = IDX; SU.src = { source: 'baked', seed: 42 };

// 5 03 evidence / nearby works
base(); EP.view3 = 'evidence';
h = G.engPanel3();
ok(h.includes('What SUMO’s numbers rest on') && h.includes('50% green') && h.includes('not covered by SUMO') && h.includes('Model cross-check'), 'evidence view: SUMO data and assumptions (50% green at 2935, not covered by SUMO, the run\'s own assumptions)');
ok(!leaks(h).length && !h.includes('veh/h arrive'), `negative: the evidence view shows no engine numbers (leaked ${leaks(h).join(', ')})`);
EP.view3 = 'clash'; h = G.engPanel3();
ok(h.includes('not covered by SUMO') && !/clash cost/i.test(h) && !leaks(h).length, 'nearby-works view: says SUMO does not cover overlapping works; no clash-cost numbers');

// 6 04 advisor
base(); h = G.eng4HTML();
ok(h.includes('USE / RUSSELL') && h.includes('SAVE / 9 MIN'), '04 advisor: the suggested sign text stays (USE / RUSSELL ▸ SAVE / 9 MIN)');
ok(h.includes('computed by SUMO') && h.includes('14%') && h.includes('53%') && h.includes('id="applyBtn"') && h.includes('data-opt="0"'), '04 advisor: says the effect is computed by the SUMO table below; detour share 14% → 53% labelled as AI sign reading / SUMO input; "apply to my plan" still there');
ok(!leaks(h).length && !h.includes('veh·h') && !h.includes('data-optwhy'), `negative: the 04 advisor has no 918 → 79 m, 509 → 47 s, 10,493, 18,693 → 1,651, −1,582 veh·h (leaked ${leaks(h).join(', ')}); no engine-computed advisor rationale`);
EP.pick = 1; h = G.eng4HTML();
ok(!leaks(h).length && h.includes('does not score a shift'), '04 advisor with date staggering selected: no clash vehicle-minutes');

// 7 05 export text, 01 check, engSumFor used by the map
base(); const pb = G.engPlaybook();
ok(pb[0].includes('Traffic impact (SUMO') && pb[0].includes('278 vehicles held up') && pb[0].includes('not covered by SUMO') && pb[1].includes('SUMO 暂不覆盖'), '05 export: SUMO numbers + the not-covered note (EN and ZH)');
ok(!leaks(pb.join('\n')).length, `negative: the 05 export text has no engine numbers (leaked ${leaks(pb.join('\n')).join(', ')})`);
h = G.engMoreHTML();
ok(h.includes('SUMO’s input') && h.includes('not covered by SUMO') && !h.includes('veh/h arrive') && !h.includes('rider·min') && !leaks(h).length, '01 check: only the AI sign reading (70% understand, 14% detour = SUMO input), no engine flow / capacity / minutes');
ok(G.engSumFor('now') === null && G.engSumFor('before') === null, 'map: engSumFor returns null on the SUMO plan (no engine queue / ripple / detours / labels drawn)');

// 8 Other plans unchanged: the engine numbers are all there
base(); EP.link = 'l_other'; EP.sum.raw.links[0].id = 'l_other'; SU.index = IDX;
ok(!G.sumoPlanOn(), 'another link is not a SUMO plan');
h = G.engPanel3();
ok(h.includes('918') && h.includes('509') && h.includes('10,493'), 'other plans: 03 still shows engine numbers (918 m, 509 s, 10,493)');
h = G.eng4HTML();
ok(h.includes('918 m') && h.includes('79 m') && h.includes('1,582') && h.includes('18,693'), 'other plans: the 04 advisor is unchanged (918 → 79 m, −1,582 veh·h, 18,693)');
ok(G.engPlaybook()[0].includes('queue 918 m'), 'other plans: the 05 export still shows engine numbers');
ok(G.engMoreHTML().includes('veh/h arrive') && G.engSumFor('now') === EP.sum, 'other plans: the 01 check and the map are unchanged');
EP.link = SUMO_LINK; EP.all = true; EP.lanes = 2;
ok(!G.sumoPlanOn() && G.engPanel3().includes('918'), 'negative: a full Lonsdale closure is not a SUMO plan (SUMO only ran the 1-lane closure), so engine numbers still show');

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
