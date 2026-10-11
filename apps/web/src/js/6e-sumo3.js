'use strict';
/* ============================================================
   SUMO-primary mode (decision D-1001-0045 in docs/decisions.md): on the plan SUMO covers — the Lonsdale demo works, one lane closed
   (EP.link===SUMO_LINK && !EP.all && EP.lanes===1, the same test as sumoWant() in 5-app.js / suPlan() in 8-compare.js) —
   every traffic number on screen is SUMO's, from the step-2 run (SU.index / SU.src, 5-app.js). The engine still runs behind
   the scenes: it reads the signs (AI) and gives SUMO its detour share p. From it the page may show that reading only (seen /
   understood / trusts, p), labelled as the AI reading / SUMO's input — never its queue, delay, veh·min, person·min, network
   delay, per-type minutes, tram / bus / pedestrian minutes or clash cost, and no comparison with them.
   Hooks, one line each in 6-engine.js: engPanel3 → sumo3Top + sumoPanel3 / sumo3Evidence / sumo3Clash (03, all three tabs);
   eng4HTML → sumo3Eng4 (04 advisor); engPlaybook → sumo3Playbook (05 copied text); engMoreHTML → sumo3More (01 Checks);
   engSumFor → null (no engine queue, ripple, detours, trams / people on foot or their tags on the map in any step);
   engFit / engDraw / engLabels → SUMO's physical queue at the end of its hour (03 only). 9-ai.js: who computes the numbers.
   ============================================================ */

/* sumo3-pure:begin — tests/sumo3_glue.mjs runs this block in node */
const S3N=v=>v!=null&&v!==''&&typeof v!=='boolean'&&isFinite(+v);
// Vehicles held up by the works at the end of SUMO's hour: an explicit count when the run has one (works_held_end…), else the
// T48 breakdown works_queue_equiv_end_vehicles (queued on Lonsdale up to Albert St + side streets + still waiting to enter),
// summed. No count field at all → back from the queue counted the engine's way, works_queue_equiv_end_m = vehicles × 7 m ÷ 2
// lanes, so N = round(m × 2 / 7). null = the run has none of these (the 12-minute runs before T48)
function sumo3Held(m){
  if(!m||typeof m!=='object')return null;
  for(const k of['works_held_end','works_held_end_veh','works_held_end_vehicles'])if(S3N(m[k]))return Math.round(+m[k]);
  const v=m.works_queue_equiv_end_vehicles;
  if(v&&typeof v==='object'){const xs=Object.values(v).filter(S3N);if(xs.length)return Math.round(xs.reduce((a,x)=>a+(+x),0));}
  return S3N(m.works_queue_equiv_end_m)?Math.round(+m.works_queue_equiv_end_m*2/7):null;
}
// SUMO's hour [from, to]: params.hour_window of the run, else index.hour → +1 h, else 8–9
function sumo3Win(idx){
  const w=idx&&idx.params&&idx.params.hour_window;
  if(Array.isArray(w)&&w.length===2&&S3N(w[0])&&S3N(w[1]))return[+w[0],+w[1]];
  const h=idx&&S3N(idx.hour)?+idx.hour:8;return[h,h+1];
}
// The run's 1-hour fields (T48): the physical queue at the end of the hour. Without them the run is an older ~12-minute one
const sumo3Hour=m=>!!m&&S3N(m.works_queue_end_m);
function sumo3Metrics(idx,id){const s=((idx&&idx.scenarios)||[]).find(x=>x&&x.id===id);return s&&s.metrics&&typeof s.metrics==='object'?s.metrics:null;}
// p of a scenario (drivers who detour — the engine's AI sign reading, SUMO's input): the scenario's diversion_share (T48),
// else its metrics', else params.p_<id> (what the run was asked for). null = unknown
function sumo3P(idx,id){
  const s=((idx&&idx.scenarios)||[]).find(x=>x&&x.id===id)||{},m=s.metrics||{},P=(idx&&idx.params)||{};
  for(const v of[s.diversion_share,m.diversion_share,P['p_'+id]])if(S3N(v)&&+v>=0&&+v<=1)return+v;
  return null;
}
// The SUMO scenario that matches the plan on screen (default 'original'): the one whose p is nearest the plan's own detour
// share p (the engine's AI reading of its signs, behind the scenes); without that reading, a sign naming Russell St = the AI plan
function sumo3Scen(idx,p,signText){
  const has=id=>!!sumo3Metrics(idx,id);
  if(!has('ai'))return'original';if(!has('original'))return'ai';
  const po=sumo3P(idx,'original'),pa=sumo3P(idx,'ai');
  if(S3N(p)&&po!=null&&pa!=null&&po!==pa)return Math.abs(+p-pa)<Math.abs(+p-po)?'ai':'original';
  return/\bRUSSELL\b/i.test(String(signText||''))?'ai':'original';
}
/* sumo3-pure:end */

function sumoPlanOn(){return typeof SUMO_LINK==='string'&&!!EP.link&&EP.link===SUMO_LINK&&!EP.all&&EP.lanes===1;}
// Short row label for the two-row table (the full name is its title and in the input line under it)
const sumo3Short=id=>id==='original'?L('Original','原方案'):id==='ai'?L('AI plan','AI 方案'):String(id);
const SUMO3_NAME={original:['Original plan · ROADWORK AHEAD','原方案 · ROADWORK AHEAD'],ai:['AI plan · USE RUSSELL','AI 方案 · USE RUSSELL']};
function sumo3Name(idx,id){
  const s=((idx&&idx.scenarios)||[]).find(x=>x&&x.id===id),lb=s&&s.label;
  if(lb&&typeof lb==='object'&&(lb.en||lb.zh))return L(String(lb.en||lb.zh),String(lb.zh||lb.en));
  const k=SUMO3_NAME[id];return k?L(k[0],k[1]):String(id);
}
// The plan's own detour share: only from a current engine run (same rule as engPanel3 / aiState)
function sumo3PlanP(){const s=EP.sum;return s&&!EP.badText&&!(EP.runErr&&!EP.busy)&&S3N(s.detour_share)?+s.detour_share:null;}
// What 03 / the map show: the step-2 run, the scenario matching the plan and its metrics. null = no SUMO run yet
function sumo3Cur(){
  const idx=SU.index;if(!idx||!Array.isArray(idx.scenarios))return null;
  const sid=sumo3Scen(idx,sumo3PlanP(),[EP.f1,EP.f2,EP.sign].join(' ')),m=sumo3Metrics(idx,sid);if(!m)return null;
  const w=sumo3Win(idx);return{idx,sid,m,hour:sumo3Hour(m),w,end:engHour(((w[1]%24)+24)%24),win:`${engHour(((w[0]%24)+24)%24)}–${engHour(((w[1]%24)+24)%24)}`};
}
const s3r=v=>S3N(v)?fmtN(Math.round(+v)):'—';
const s3ex=m=>m?(S3N(m.works_traffic_extra_s)?+m.works_traffic_extra_s:S3N(m.mean_extra_s)?+m.mean_extra_s:null):null;
const s3sgn=v=>v==null?'—':`${v>0?'+':v<0?'−':''}${fmtN(Math.abs(Math.round(v)))}`;
// Source of the run: live in the cloud (seconds · seed) or the pre-computed copy (+ why the cloud run did not happen)
function sumo3Pill(){
  const idx=SU.index||{},src=SU.src||{},live=src.source==='live'&&isFinite(src.elapsedMs),sd=S3N(src.seed)?+src.seed:S3N(idx.seed)?+idx.seed:null,seed=sd!=null?` · seed ${sd}`:'';
  if(live)return`<span class="pill ok" data-sumo3-src="live">${L('Cloud SUMO · computed live','云端 SUMO · 现场计算')} · ${(src.elapsedMs/1000).toFixed(1)} s${seed}</span>`;
  const why=src.reason?(typeof sumoReason==='function'?sumoReason(src.reason):src.reason):'';
  return`<span class="pill" data-sumo3-src="baked">${L('SUMO · pre-computed','SUMO · 预先跑好的')}${seed}</span>${why?`<span class="small muted">${esc(why)}</span>`:''}`;
}
const sumo3NotCovered=()=>`<p class="small sumo3-nc" style="color:var(--fg-2)">${L('Trams, buses and people on foot: not covered by SUMO.','电车、公交和行人：SUMO 暂不覆盖。')}</p>`;

/* ---------- 03 Impact ---------- */
// Header of all three tabs (engTabs3 kept); the engine's "Live engine" pill stays off this plan
function sumo3Top(){return`<div class="row between"><span class="eyebrow" style="color:var(--sun-ink)">${L('Impact · SUMO','影响 · SUMO')}</span><span class="eyebrow">${L('real CBD network','真实 CBD 路网')}</span></div>${engTabs3()}`;}
// 03 · Traffic: the step-2 SUMO run for the scenario matching the plan — headline, four tiles, original vs AI plan, the AI
// reading's detour shares as SUMO's input. The AI road-users section (9-ai.js aiMount) goes in under it, before the nav
function sumoPanel3(){
  const st=esc(shortSt(EP.street)||'Lonsdale St'),c=sumo3Cur();
  if(!c)return`<div class="card eng-note sumo3-none"><b>${SU.busy?L('SUMO is computing this plan in step 2…','SUMO 正在第 2 步计算这个方案…'):L('Run SUMO in step 2 first','先在第 2 步跑一次 SUMO')}</b><span>${L('The traffic numbers for this plan come from SUMO on the real CBD network, run in step 2.','这个方案的交通数字来自 SUMO（真实 CBD 路网），在第 2 步运行。')}</span><button type="button" class="btn" data-sumo3-go="2">${L('Go to step 2 · run SUMO','去第 2 步 · 运行 SUMO')}</button></div>${sumo3NotCovered()}`;
  const{idx,sid,m,hour,end,win}=c,P=idx.params||{},held=sumo3Held(m),ex=s3ex(m),mins=S3N(P.shown_s)?Math.round(+P.shown_s/60):null;
  const head=hour?(held!=null?L(`At ${end}, ${fmtN(held)} vehicles are held up by the works; the queue on ${st} is ${s3r(m.works_queue_end_m)} m`,`${end} 时，被施工拦住的车有 ${fmtN(held)} 辆；${st} 上排队 ${s3r(m.works_queue_end_m)} 米`)
      :L(`At ${end}, the queue on ${st} is ${s3r(m.works_queue_end_m)} m`,`${end} 时，${st} 上排队 ${s3r(m.works_queue_end_m)} 米`))
    :L(`In SUMO's ${mins?mins+'-minute ':''}run the works queue on ${st} reaches ${s3r(m.works_queue_max_m)} m`,`SUMO ${mins?`这 ${mins} 分钟`:'这一次'}里 ${st} 施工排队最长 ${s3r(m.works_queue_max_m)} 米`);
  const heldHow=!hour||held==null?'':m.works_held_end!=null||m.works_held_end_veh!=null||m.works_held_end_vehicles!=null?''
    :m.works_queue_equiv_end_vehicles&&typeof m.works_queue_equiv_end_vehicles==='object'?L(`Held up = queued behind the works on ${st} and the side streets feeding it, plus vehicles still waiting to enter because the queue reached the edge of SUMO's network.`,`被拦住 = 在 ${st} 和汇入的小街上排在施工后面的车，加上排队排到 SUMO 路网边上、还没进来的车。`)
    :L('Held up = the queue behind the works counted at 7 m per vehicle over 2 lanes.','被拦住 = 施工后面的排队按每车 7 米、2 条道折算。');
  const tile=(k,v,u,col)=>`<div class="metric"><span class="eyebrow">${k}</span><div class="v"${col?` style="color:${col}"`:''}>${v}<small>${u}</small></div></div>`;
  const tiles=hour?tile(L('Get past the works','通过施工段'),s3r(m.works_throughput_vph),L('veh/h','辆/时'))+tile(L('Extra time per vehicle','每车多花'),s3sgn(ex),L('s · through the works','秒 · 过施工段'),'var(--works)')
      +tile(L('Detoured','绕行的车'),s3r(m.detour_vehicles),L('vehicles','辆'))+tile(L('Longest queue','最长排队'),s3r(m.works_queue_max_m),L(`m · ${win}`,`米 · ${win}`),'var(--risk)')
    :tile(L('Longest queue','最长排队'),s3r(m.works_queue_max_m),'m','var(--risk)')+tile(L('Mean queue','平均排队'),s3r(m.works_queue_mean_m),'m')
      +tile(L('Extra time per vehicle','每车多花'),s3sgn(ex),L('s · through the works','秒 · 过施工段'),'var(--works)')+tile(L('Detoured','绕行的车'),s3r(m.detour_vehicles),L('vehicles','辆'));
  const ids=['original','ai'].filter(id=>sumo3Metrics(idx,id));
  const cols=hour?[[L(`Held up ${end}`,`${end} 被拦`),x=>s3r(sumo3Held(x))],[L(`Queue ${end} · m`,`${end} 排队 · 米`),x=>s3r(x.works_queue_end_m)],[L('Past works · veh/h','通过 · 辆/时'),x=>s3r(x.works_throughput_vph)],
      [L('Extra / veh · s','每车多花 · 秒'),x=>s3sgn(s3ex(x))],[L('Detoured','绕行'),x=>s3r(x.detour_vehicles)],[L('Longest · m','最长 · 米'),x=>s3r(x.works_queue_max_m)]]
    :[[L('Queue max / mean','排队 最长 / 平均'),x=>`${s3r(x.works_queue_max_m)} / ${s3r(x.works_queue_mean_m)} m`],[L('Extra / veh','每车多花'),x=>s3sgn(s3ex(x))+' s'],[L('Detoured','绕行'),x=>s3r(x.detour_vehicles)]];
  const table=ids.length>1?`<div class="stack"><div class="row between"><span class="eyebrow">${L('Original vs AI plan · SUMO','原方案 vs AI 方案 · SUMO')}</span><span class="eyebrow">${L('same run, same seed','同一次运行 · 同一种子')}</span></div>
    <div class="sumo-imp-wrap"><table class="sumo-imp sumo3-t"><thead><tr><th></th>${cols.map(([k])=>`<th>${k}</th>`).join('')}</tr></thead>
    <tbody>${ids.map(id=>{const x=sumo3Metrics(idx,id);return`<tr${id===sid?' class="cur"':''}><th scope="row" style="white-space:nowrap" title="${esc(sumo3Name(idx,id))}">${esc(sumo3Short(id))}</th>${cols.map(([,f])=>`<td>${f(x)}</td>`).join('')}</tr>`;}).join('')}</tbody></table></div></div>`:'';
  const ps=ids.map(id=>[id,sumo3P(idx,id)]).filter(([,p])=>p!=null);
  const pIn=ps.length?`<p class="small sumo3-in">${L('Drivers who detour — AI sign reading, SUMO’s input:','会绕行的司机 —— AI 读牌，SUMO 的输入：')} ${ps.map(([id,p])=>`${esc(sumo3Name(idx,id))} <b>${pctS(p)}</b>`).join(' · ')}</p>`:'';
  const pp=sumo3PlanP(),po=sumo3P(idx,sid),off=pp!=null&&po!=null&&Math.abs(pp-po)>=.02;
  const notes=[EP.badText?`<p class="small" style="color:var(--risk)">${L('The sign text in step 1 breaks the VMS rules — fix it there. SUMO’s runs below are for the two plans it ran.','第 1 步的屏上文字不合规范 —— 回去改。下面是 SUMO 跑过的两套方案。')}</p>`:'',
    SU.busy?`<p class="small" style="color:var(--fg-2)">${L('A new SUMO run is computing in step 2; these numbers are from the previous run.','第 2 步正在跑新的一次 SUMO；下面是上一次的数。')}</p>`:'',
    off?`<p class="small" style="color:var(--fg-2)">${L(`This plan’s signs read as ${pctS(pp)} detouring; the nearest SUMO run (${pctS(po)}) is shown. Re-run SUMO in step 2 or compare plans in 04 for this share.`,`这份方案的牌读下来 ${pctS(pp)} 的车绕行；这里显示最接近的 SUMO 运行（${pctS(po)}）。要这个比例，回第 2 步重跑或到 04 比较。`)}</p>`:''].join('');
  const legend=hour?`<div class="eng-legend"><span><i style="background:var(--risk)"></i>${L(`SUMO queue at ${end}`,`SUMO ${end} 排队`)}</span><span><i style="background:var(--works)"></i>${L('Works','施工段')}</span></div>`:'';
  const ver=(/(\d+\.\d+\.\d+)/.exec(String(idx.engine||''))||[0,''])[1],dem=S3N(P.demand_veh_per_h)?fmtN(+P.demand_veh_per_h):null;
  const span=hour?L(`weekday ${win}`,`工作日 ${win}`):L(`${mins?mins+' minutes of ':''}weekday ${engHour(c.w[0]%24)}`,`工作日 ${engHour(c.w[0]%24)}${mins?` 起 ${mins} 分钟`:''}`);
  return`<div class="stack sumo3"><div class="row between"><span class="eyebrow">SUMO · ${esc(sumo3Name(idx,sid))}</span></div><div class="row sumo-src">${sumo3Pill()}</div>
    <h2>${head}</h2><p class="muted small">${L(`${cap(dirL(EP.dir))}, one lane closed · SUMO simulates ${span} on the real CBD network (OSM) with SCATS counts.`,`${dirL(EP.dir)}、封一条道 · SUMO 在真实 CBD 路网（OSM）上按 SCATS 流量模拟${span}。`)}</p>${heldHow?`<p class="small eng-assume">${heldHow}</p>`:''}</div>
    ${notes}<div class="metrics">${tiles}</div>${legend}${table}${pIn}${sumo3NotCovered()}
    <p class="legend-src">${L(`SUMO${ver?' '+ver:''} · network from OSM · demand: SCATS weekday counts${dem?` (${dem} veh/h)`:''} · signal timing and turn shares assumed · detour shares from the AI sign reading. A model, not a field measurement.`,`SUMO${ver?' '+ver:''} · 路网取自 OSM · 需求：SCATS 工作日流量${dem?`（${dem} 辆/时）`:''} · 信号配时和转弯比例是假设值 · 绕行比例来自 AI 读牌。这是模型，不是实测。`)}</p>`;
}
// 03 · Evidence: what SUMO's numbers rest on (data, assumptions, the run's own assumption list) — no engine outcome
function sumo3Evidence(){
  const idx=SU.index,P=(idx&&idx.params)||{},row=(k,v,warn)=>`<div><i class="dot" style="background:${warn?'var(--works)':'var(--accent)'}"></i><span class="grow">${k}</span><span class="val">${v}</span></div>`;
  const w=sumo3Win(idx),win=`${engHour(((w[0]%24)+24)%24)}–${engHour(((w[1]%24)+24)%24)}`,ver=idx?(/(\d+\.\d+\.\d+)/.exec(String(idx.engine||''))||[0,''])[1]:'';
  const g0=S3N(P.green_2935)?+P.green_2935:S3N(P.signal_2935_green)?+P.signal_2935_green:null,g=g0==null?null:Math.round(g0<=1?g0*100:g0);
  const capv=idx?sumo3Metrics(idx,'original'):null,capa=capv&&S3N(capv.works_capacity_assumption_vph)?fmtN(+capv.works_capacity_assumption_vph):null;
  const ps=['original','ai'].map(id=>[id,idx?sumo3P(idx,id):null]).filter(([,p])=>p!=null);
  const rs=EP.sum&&typeof aiPlanSrc==='function'?aiPlanSrc(EP.sum,EP.sum.flags):null;
  const A=idx&&idx.assumptions,as=A&&(LANG.cur==='zh'?A.zh:A.en);
  return`<div class="stack"><h2>${L('What SUMO’s numbers rest on','SUMO 的数字依据什么')}</h2>${idx?`<div class="row sumo-src">${sumo3Pill()}</div>`:''}</div>
  <div class="stack"><div class="row between"><span class="eyebrow">${L('Data','数据')}</span><span class="eyebrow">${L('real','真实')}</span></div><div class="list eng-evd">
    ${row(L('Road network','路网'),S3N(P.network_links)?L(`${fmtN(+P.network_links)} links · OSM`,`${fmtN(+P.network_links)} 个路段 · OSM`):'OSM')}
    ${row(L('Traffic','车流'),L(`SCATS weekday counts · ${win}`,`SCATS 工作日流量 · ${win}`))}
    ${row(L('Model','模型'),`Eclipse SUMO${ver?' '+ver:''}`)}
    ${row(L('Sign reading','读屏'),rs?esc(aiSrcLabel(rs.src)):L('AI · each plan’s signs','AI · 每套方案的牌'))}</div></div>
  <div class="stack"><div class="row between"><span class="eyebrow">${L('Assumed','假设值')}</span><span class="eyebrow">${L('no source yet','暂无来源')}</span></div><div class="list eng-evd">
    ${row(L('Signal timing','信号配时'),L('fixed 90 s plan (SCATS has no timings)','固定 90 秒周期（SCATS 没有配时）'),1)}
    ${g!=null?row(L('Signal 2935 at the works','施工处 2935 信号'),L(`${g}% green for Lonsdale St`,`Lonsdale St ${g}% 绿灯`),1):''}
    ${row(L('Works lane','施工段'),L(`one lane${S3N(P.works_lane_speed_kmh)?` at ${fmtN(+P.works_lane_speed_kmh)} km/h`:''}${capa?` · capacity ${capa} veh/h`:''}`,`剩一条道${S3N(P.works_lane_speed_kmh)?`、限速 ${fmtN(+P.works_lane_speed_kmh)} km/h`:''}${capa?` · 通行能力 ${capa} 辆/时`:''}`),1)}
    ${ps.length?row(L('Drivers who detour · AI reading → SUMO input','会绕行的司机 · AI 读牌 → SUMO 输入'),ps.map(([id,p])=>`${esc(sumo3Name(idx,id))} ${pctS(p)}`).join(' · '),1):''}
    ${row(L('Trust in signs','对标志的信任度'),L('assumed value','假设值'),1)}
    ${row(L('Trams, buses, people on foot','电车、公交、行人'),L('not covered by SUMO','SUMO 暂不覆盖'),1)}
    ${row(L('Weather','天气'),L('illustrative · not in SUMO','示意 · 不进 SUMO'),1)}</div></div>
  ${Array.isArray(as)&&as.length?`<div class="eng-assume">${as.map(t=>`<p>${esc(t)}</p>`).join('')}</div>`:''}
  ${idx?'':`<div class="card eng-note"><b>${L('Run SUMO in step 2 first','先在第 2 步跑一次 SUMO')}</b><button type="button" class="btn" data-sumo3-go="2">${L('Go to step 2 · run SUMO','去第 2 步 · 运行 SUMO')}</button></div>`}
  <p class="small eng-assume">${L('Model estimates on the real CBD network · not field-validated. The language model only reads the signs; the traffic numbers are SUMO’s.','真实 CBD 路网上的模型估算 · 未经实地验证。大模型只读屏上的字，交通数字都是 SUMO 算的。')}</p>`;
}
// 03 · Nearby works: which works overlap (8-clash.js mounts the list under this); SUMO runs this plan's works on its own
function sumo3Clash(){return`<div class="stack"><h2>${L('Other works on the same dates','同期的其他施工')}</h2><p class="small eng-assume">${L('Registered works whose dates overlap this plan. SUMO runs this plan’s works on its own, so their combined effect on traffic is not covered by SUMO.','登记表里和本方案日期重叠的施工。SUMO 只算本方案这一处施工，两处叠加对交通的影响 SUMO 暂不覆盖。')}</p></div>`;}

/* ---------- 01 Checks, 04 advisor, 05 playbook ---------- */
// 01 Checks (engMoreHTML): the AI reading of this plan's signs as SUMO's input — no engine flows, capacities or minutes
function sumo3More(){
  const s=BE.api&&EP.link?EP.sum:null,stale=EP.busy||EP.badText||!!EP.runErr;
  const inf=s&&typeof engInformed==='function'?engInformed(s):null,p=s&&S3N(s.detour_share)?+s.detour_share:null;
  const rs=s&&typeof aiPlanSrc==='function'?aiPlanSrc(s,s.flags):null;
  const read=s&&(inf!=null||p!=null)?`<div class="eng-assume"><p>${L(`AI sign reading: ${inf!=null?`${pctS(inf)} of drivers understand the sign`:''}${inf!=null&&p!=null?' · ':''}${p!=null?`${pctS(p)} detour (SUMO’s input)`:''}. The traffic numbers for this plan come from SUMO in step 2.`,`AI 读牌：${inf!=null?`${pctS(inf)} 的司机读懂屏上的字`:''}${inf!=null&&p!=null?' · ':''}${p!=null?`${pctS(p)} 绕行（SUMO 的输入）`:''}。这个方案的交通数字由第 2 步的 SUMO 算。`)}</p></div>`:'';
  return`<div class="eng-out${stale?' stale':''}">${read}<div class="list eng-impacts"><div><i class="dot" style="background:var(--a-bus)"></i><span class="grow">${L('Trams, buses and people on foot','电车、公交和行人')}</span><span class="val">${L('not covered by SUMO','SUMO 暂不覆盖')}</span></div></div>${rs?`<div class="chips eng-badges"><span class="pill ${rs.tone}">${L('Sign reading','读屏')} · ${esc(aiSrcLabel(rs.src))}</span></div>`:''}</div>`;
}
// What an advisor option changes (sign text / position / dates) — the advisor's suggestion itself, never its engine saving
function sumo3What(o){return o.kind==='text'&&o.frames?o.frames.map(f=>f.join(' / ')).join('  ▸  '):o.kind==='move'?`${o.equipment||''} → ${fmtN(o.at_m)} m ${L('upstream','上游')}`:o.kind==='shift'?`${o.days>0?'+':''}${fmtN(o.days)} ${L('days','天')}`:'';}
// 04 advisor (eng4HTML): the suggested sign wording / position, the AI reading's detour share before → after (SUMO's input);
// the effect on traffic is SUMO's, in the comparison table below (8-compare.js). Same data-opt / #applyBtn as eng4HTML, so
// engRender4's binding is unchanged; no data-optwhy — the advisor's why quotes engine minutes / veh·min
function sumo3Eng4(){
  const a=EP.adv,n=a?a.options.length:0,rule=!a||a.src==='rule';
  let h=`<div class="row between"><span class="eyebrow" style="color:var(--sun-ink)">${rule?L('Planning advisor · rules · suggested wording','规划顾问 · 规则 · 建议写法'):L('AI planning advisor · suggested wording','AI 规划顾问 · 建议写法')}</span><span class="eyebrow">${a?`${n} ${n===1?L('option','个改法'):L('options','个改法')}`:''}</span></div>`;
  if(!a)return h+`<div class="card eng-note"><b>${EP.advBusy?L('Trying other sign wordings and positions…','正在试别的写法和摆放位置…'):L('The advisor could not run','顾问没跑起来')}</b></div>`;
  const kindL={text:L('Edit sign','改字'),move:L('Move sign','挪位置'),shift:L('Reschedule','错开日期')};
  const say={text:L('Name the detour on the sign','在屏上写明绕行路线'),move:L('Put the sign before the turn','把屏挪到拐口之前'),shift:L('Start the other works later','把另一处施工往后挪')};
  const opts=a.options.map((o,i)=>`<button type="button" class="eng-opt" data-opt="${i}" aria-pressed="${EP.pick===i}" ${o.plan&&!o.skipped?'':'disabled'}><span class="k">${kindL[o.kind]||esc(o.kind)}</span><span class="w"><b>${say[o.kind]||''}</b><span class="mono">${esc(sumo3What(o))}</span></span><span class="d" style="color:var(--fg-3)">${o.skipped?L('skipped','跳过'):L('effect: SUMO ↓','效果：见下方 SUMO')}</span></button>`).join('');
  if(!a.flags.ok)h+=`<div class="card eng-note warn"><b>${L('Some sign readings are missing — the detour shares below may be off','有读数没拿到 —— 下面的绕行比例可能不准')}</b><span>${L(`missing ${a.flags.missing} · failed ${a.flags.failed}`,`缺 ${a.flags.missing} 条 · 失败 ${a.flags.failed} 条`)}</span></div>`;
  h+=`<div class="stack eng-opts">${opts||`<div class="card eng-note"><b>${L('No other wording or position to suggest','没有别的写法或位置可建议')}</b></div>`}</div>
  <p class="small">${L('The effect of each suggestion on traffic is computed by SUMO — see the comparison table below.','每个建议对交通的影响由 SUMO 计算 —— 看下面的对比表。')}</p>`;
  const o=a.options[EP.pick];
  if(o){
    h+=`<div class="stack"><div class="row between"><span class="eyebrow">${L('Picked change · AI sign reading','选中的改法 · AI 读牌')}</span><span class="eyebrow">${engHour(EP.hour)}</span></div>`;
    if(o.kind==='shift')h+=`<div class="card eng-note"><b>${L('A date shift changes which days overlap with other works. SUMO runs this plan’s works on its own, so it does not score a shift.','错开日期改变的是和别的施工重叠的日子。SUMO 只算本方案这一处施工，不评错开日期。')}</b></div>`;
    else if(!EP.cmp)h+=`<div class="card eng-note"><b>${EP.cmpBusy?L('Reading both plans’ signs…','两份方案的牌都在读…'):L('Reading unavailable','读数没拿到')}</b></div>`;
    else{
      const B=EP.cmp.before,D=EP.cmp.delta,pb=+B.detour_share,pa=pb+(+D.detour_share),A=EP.cmp.after,rs=A&&typeof aiPlanSrc==='function'?aiPlanSrc(A,A.flags):null;
      h+=`<div class="table eng-table"><div><span class="muted">${L('Drivers who detour · AI reading → SUMO input','会绕行的司机 · AI 读牌 → SUMO 输入')}</span><span class="o">${S3N(pb)?pctS(pb):'—'}</span><span class="ar">→</span><span class="a">${S3N(pa)?pctS(pa):'—'}</span></div></div>
      <p class="eng-assume">${L('The share comes from the AI reading of each plan’s signs (trust in signs is an assumed value). What it does to traffic is SUMO’s job — see the table below.','这个比例来自 AI 读每套方案的牌（对标志的信任度是假设值）。它对交通的影响由 SUMO 算 —— 看下面的表。')}</p>
      ${rs?`<div class="chips eng-badges"><span class="pill ${rs.tone}">${L('Sign reading','读屏')} · ${esc(aiSrcLabel(rs.src))}</span></div>`:''}<button type="button" class="btn ghost" id="applyBtn">${L('Apply to my plan','用到我的方案上')}</button>`;
    }
    h+='</div>';
  }
  return h;
}
// 05 copied playbook (engPlaybook): SUMO's numbers for the two plans it ran, the AI reading's shares, and what it doesn't cover
function sumo3Playbook(){
  const idx=SU.index;
  if(!idx||!Array.isArray(idx.scenarios))return['\n\nTraffic impact (SUMO): no run yet — run SUMO in step 2.','\n\n交通影响（SUMO）：还没跑 —— 请在第 2 步运行 SUMO。'];
  const src=SU.src||{},live=src.source==='live'&&isFinite(src.elapsedMs),sd=S3N(src.seed)?+src.seed:idx.seed,w=sumo3Win(idx),win=`${engHour(w[0]%24)}–${engHour(w[1]%24)}`,end=engHour(w[1]%24);
  const st=shortSt(EP.street)||'Lonsdale St',nm=(id,zh)=>{const s=idx.scenarios.find(x=>x&&x.id===id),lb=s&&s.label;return lb&&typeof lb==='object'&&(zh?lb.zh:lb.en)||(SUMO3_NAME[id]||[id,id])[zh?1:0];};
  const one=(id,zh)=>{const m=sumo3Metrics(idx,id);if(!m)return'';const p=sumo3P(idx,id),ex=s3ex(m),held=sumo3Held(m);
    if(zh)return`\n${nm(id,1)}${p!=null?`（AI 读牌 ${pctS(p)} 绕行）`:''}：`+(sumo3Hour(m)?`${end} 时被施工拦住 ${held!=null?fmtN(held):'—'} 辆，${st} 排队 ${s3r(m.works_queue_end_m)} 米 · 每小时 ${s3r(m.works_throughput_vph)} 辆通过施工段 · 过施工段每车多花 ${s3sgn(ex)} 秒 · 绕行 ${s3r(m.detour_vehicles)} 辆 · 最长排队 ${s3r(m.works_queue_max_m)} 米`:`施工排队最长 ${s3r(m.works_queue_max_m)} 米 / 平均 ${s3r(m.works_queue_mean_m)} 米 · 过施工段每车多花 ${s3sgn(ex)} 秒 · 绕行 ${s3r(m.detour_vehicles)} 辆`);
    return`\n${nm(id,0)}${p!=null?` (AI sign reading: ${pctS(p)} detour)`:''}: `+(sumo3Hour(m)?`at ${end} ${held!=null?fmtN(held):'—'} vehicles held up by the works, queue ${s3r(m.works_queue_end_m)} m on ${st} · ${s3r(m.works_throughput_vph)} veh/h get past the works · ${s3sgn(ex)} s per vehicle through the works · ${s3r(m.detour_vehicles)} vehicles detoured · longest queue ${s3r(m.works_queue_max_m)} m`:`works queue max ${s3r(m.works_queue_max_m)} m / mean ${s3r(m.works_queue_mean_m)} m · ${s3sgn(ex)} s per vehicle through the works · ${s3r(m.detour_vehicles)} vehicles detoured`);};
  const o=EP.adv&&EP.adv.options[EP.pick],adv=o&&o.kind!=='shift'?sumo3What(o):'';
  const en=`\n\nTraffic impact (SUMO on the real CBD network, weekday ${win}, seed ${sd}, ${live?'computed live in the cloud':'pre-computed'})`+one('original',0)+one('ai',0)+(adv?`\nAdvisor suggestion: ${adv} (its effect on traffic is computed by SUMO)`:'')+'\nTrams, buses and pedestrians: not covered by SUMO.';
  const zh=`\n\n交通影响（SUMO，真实 CBD 路网，工作日 ${win}，seed ${sd}，${live?'云端现场计算':'预先跑好的'}）`+one('original',1)+one('ai',1)+(adv?`\n顾问建议：${adv}（对交通的影响由 SUMO 计算）`:'')+'\n电车、公交和行人：SUMO 暂不覆盖。';
  return[en,zh];
}

/* ---------- map: SUMO's physical queue at the end of its hour (03 · network only) ---------- */
// Metres to draw: works_queue_end_m of the scenario matching the plan, along the works street upstream (engSub / engReach,
// the same path the engine's queue used), never further than the street runs in the network or CITY. 0 = nothing to draw
function sumo3QueueM(){
  if(!sumoPlanOn()||S.step!==3||EP.tab3!=='net'||EP.view3!=='traffic'||!EP.pts)return 0;
  const c=sumo3Cur();return c&&c.hour&&+c.m.works_queue_end_m>0?+c.m.works_queue_end_m:0;
}
function sumo3Fit(){const m=sumo3QueueM();return m?engSub(Math.min(m,engReach())):[];}
function sumo3QueueDraw(which,k,off){
  const m=sumo3QueueM();if(!m||which!=='now')return;
  const Q=engSub(Math.min(m,engReach())).reverse();if(Q.length<2)return;
  ctx.save();ctx.globalAlpha=.85;ctx.strokeStyle=TK.risk;ctx.lineWidth=7*k;engLine(Q,off);ctx.stroke();
  ctx.globalAlpha=1;ctx.strokeStyle=TK.light?'#fff':'#1b0507';ctx.lineWidth=1.2;ctx.setLineDash([2,5]);engLine(Q,off);ctx.stroke();ctx.restore();
}
function sumo3QueueTag(vis){
  const m=sumo3QueueM();if(!m)return;const c=sumo3Cur(),q=engUp(Math.min(m,vis,engReach())),px=V.X(q[0]);
  drawTag(ctx,px,V.Y(q[1]),engDx(px,24),-40,L(`SUMO queue at ${c.end} · ${fmtN(Math.round(m))} m`,`SUMO ${c.end} 排队 · ${fmtN(Math.round(m))} m`),TK.risk);
}
// "Run SUMO in step 2 first" (03): one delegated listener, so the panel's re-renders need no binding
if(typeof document!=='undefined'&&document.addEventListener)document.addEventListener('click',e=>{const b=e.target&&e.target.closest&&e.target.closest('[data-sumo3-go]');if(b&&typeof goStep==='function'){e.preventDefault();goStep(2);}});
