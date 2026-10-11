'use strict';
/* ============================================================
   Compare · choose · export (T23 · D-0929-2011 ④ · #48 steps ④⑦⑧), under the advisor in step 4.
   Up to 3 plans side by side. Normally they are T22's be.options(): cheapest / standard / guided kits drawn from the RPM
   inventory, each run by the engine for this hour, with hire and stock checks — every number comes from backend.js.
   If options() is missing or fails (e.g. no inventory), fall back to the plan in the form + the advisor's alternatives,
   each re-run by run(), with hire from /api/public/js/pack.js quote() (same inventory, same assumed day rates).
   A person picks one and writes why; the one-page pack is pack.js buildPack() + packText(), shown with textContent to
   print or copy. Nothing here computes a traffic number itself.
   ============================================================ */

/* pure:begin — tests/compare_glue.mjs runs this block in node */
const CMP_MAX=3;
// Plans to compare: the form's plan first, then advisor alternatives that change this hour (a date shift is judged over
// the whole works period, so it stays in the advisor list above). Ids A, B, C are what the pack's decision line shows.
function cmpSources(plan,adv){
  const out=[{id:'A',kind:'now',plan}];
  for(const o of (adv&&adv.options)||[]){
    if(out.length>=CMP_MAX)break;
    if(!o||!o.plan||o.skipped||o.kind==='shift')continue;
    out.push({id:String.fromCharCode(65+out.length),kind:o.kind,plan:o.plan,frames:o.frames||null,equipment:o.equipment||null,at_m:o.at_m==null?null:o.at_m});
  }
  return out;
}
// run() summary → the three traffic numbers on a card (null = the engine has no data for it)
function cmpNumbers(s){
  if(!s)return{car:null,transit:null,peds:null};
  return{car:Number.isFinite(s.delay_min)?s.delay_min:null,
    transit:s.transit&&s.transit.src&&Number.isFinite(s.transit.pax_min)?s.transit.pax_min:null,
    peds:s.peds&&s.peds.src&&Number.isFinite(s.peds.extra_min)?s.peds.extra_min:null};
}
// Lowest per metric → { key: [row indexes] }. Nothing is marked when fewer than 2 plans have the number or all are equal.
function cmpBest(rows,keys){
  const out={};
  for(const k of keys){
    const vs=rows.map((r,i)=>[i,r&&r[k]]).filter(([,v])=>Number.isFinite(v));
    if(vs.length<2)continue;const lo=Math.min(...vs.map(([,v])=>v)),hi=Math.max(...vs.map(([,v])=>v));
    if(lo===hi)continue;out[k]=vs.filter(([,v])=>v===lo).map(([i])=>i);
  }
  return out;
}
// A plan that buys nothing (T43): every traffic number the table shows (extra per vehicle, queue, network delay, trams &
// buses, on foot) and the footpath are the same as a cheaper plan's, at the precision on screen → { of: that plan's index,
// extra: hire difference A$ }, else null. The cheapest such plan is named (then the first). Needs an engine result and a hire
// figure; an hour with no works (all zeros) is never flagged.
function cmpSameAs(rows){
  const sig=r=>{const s=r&&r.s,f=(r&&r.flags)||{};if(!s||!Number.isFinite(r.hire)||f.inactive)return null;
    const n=cmpNumbers(s),v=x=>Number.isFinite(x)?Math.round(x):null;
    return JSON.stringify([v(s.mean_delay_s),v(s.queue_m),v(n.car),v(n.transit),v(n.peds),f.footpath==null?null:f.footpath]);};
  const k=rows.map(sig);
  return rows.map((r,j)=>{if(k[j]==null)return null;let of=-1;
    rows.forEach((x,i)=>{if(i!==j&&k[i]===k[j]&&x.hire<r.hire&&(of<0||x.hire<rows[of].hire))of=i;});
    return of<0?null:{of,extra:r.hire-rows[of].hire};});
}
// Overlap dates, short: en "7–9 Oct" (day first, as read in Melbourne), zh "10/7–9". from / to are yyyy-mm-dd
function cmpSpan(from,to,zh){
  if(!from||!to)return'';
  const M=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'],p=s=>[+s.slice(5,7),+s.slice(8,10)],[m0,d0]=p(from),[m1,d1]=p(to),one=from.slice(0,7)===to.slice(0,7);
  if(zh)return from===to?`${m0}/${d0}`:one?`${m0}/${d0}–${d1}`:`${m0}/${d0}–${m1}/${d1}`;
  return from===to?`${d0} ${M[m0-1]}`:one?`${d0}–${d1} ${M[m0-1]}`:`${d0} ${M[m0-1]} – ${d1} ${M[m1-1]}`;
}
// 04 "Nearby works" follows 03 (T46, lead): once 03 has staggered the other works ("Stagger by N days" gave a reliable
// be.stagger() best), every plan is scored against the same shifted works 03 shows (stagger().worksite), not the register's
// dates. x = 03's pick { o, ws, r }, st = its be.stagger() result (CL.st). No stagger, or none reliable (03 keeps the dates) → x
function cmpClashOther(x,st){
  const b=st&&st.best;
  return x&&b&&b.reliable&&st.worksite?{...x,ws:st.worksite,days:b.days,overlapDays:b.overlap_days}:x;
}
// Under the row name, after the street: overlap dates · sampled hours; once staggered, the other works' shifted dates
// (· hours if they still overlap) · "staggered N days". hour = engHour
// T51: SUMO plan, nearby works cell — what to do about it (dates only, same for every plan), not "not covered by SUMO"
function cmpSuStagger(x){
  if(x.days!=null)return L('staggered','已错开');
  const n=clashDays(x.ws);return`<span class="cmp-sug">${L(`suggest staggering it ${n} day${n===1?'':'s'}`,`建议错开 ${n} 天`)}</span>`;
}
function cmpClashWhen(x,zh,hour){
  const hrs=x.r.hours.map(hour).join(' & ');
  if(x.days==null)return`${cmpSpan(x.r.overlap.from,x.r.overlap.to,zh)} · ${hrs}`;
  const t=x.ws.time,n=x.days;
  return`${cmpSpan(t.from,t.to,zh)}${x.overlapDays>0&&hrs?' · '+hrs:''} · ${zh?`已错开 ${n} 天`:`staggered ${n} day${Math.abs(n)===1?'':'s'}`}`;
}
// T49: the window a clash number is summed over, next to the dates (the other rows are one hour): "3 days × 2 peak hours".
// days < 1 (staggered apart) → ''
function cmpWin(days,hours,zh){
  const d=Math.round(+days||0),h=Math.round(+hours||0);if(d<1||h<1)return'';
  return zh?`${d} 天 × ${h} 个高峰小时`:`${d} day${d===1?'':'s'} × ${h} peak hour${h===1?'':'s'}`;
}
// ---- SUMO-primary mode (D-1001-0045): on the SUMO plan 04's traffic numbers come from SUMO, never the engine ----
// The engine only reads each option's signs into p, the share of drivers who detour = 1 − the 'stay' route's share in the
// option's summary (options() brief or run() summary; detour_share when there are no routes), to 0.1 % — SUMO's input. null = no reading
function cmpP(s){
  if(!s)return null;
  const st=Array.isArray(s.routes)?s.routes.find(r=>r&&r.id==='stay'):null;
  const p=st&&Number.isFinite(st.share)?1-st.share:Number.isFinite(s.detour_share)?s.detour_share:NaN;
  return Number.isFinite(p)?Math.round(Math.min(1,Math.max(0,p))*1000)/1000:null;
}
// runOptions() result → { id: SUMO metrics | null } for the ids asked. The client is written elsewhere (T49-a), so accept the
// shapes it may take: an array, { options }, { index: { options | scenarios } } or { scenarios } of { id (A, opt-A, option_A…), metrics }
// (or the metrics inline), or { metrics: { A: {…} } }
function cmpSuParse(res,ids){
  const r=res&&typeof res==='object'?res:{},ix=r.index&&typeof r.index==='object'?r.index:{},arr=a=>Array.isArray(a)?a:null;
  const list=arr(res)||arr(r.options)||arr(ix.options)||arr(ix.scenarios)||arr(r.scenarios)||[];
  const key=x=>x&&typeof x==='object'?String(x.id!=null?x.id:x.option!=null?x.option:'').replace(/^opt(ion)?[-_ ]?/i,'').toUpperCase():'';
  const out={};
  for(const id of ids){
    const x=list.find(o=>key(o)===String(id).toUpperCase());
    let m=x?(x.metrics&&typeof x.metrics==='object'?x.metrics:x):null;
    if(!m&&r.metrics&&typeof r.metrics==='object'&&r.metrics[id]&&typeof r.metrics[id]==='object')m=r.metrics[id];
    out[id]=m||null;
  }
  return out;
}
// One option's SUMO metrics → the table's numbers (null = SUMO did not give it). q: works queue at the end of the hour
// (works_queue_equiv_end_m, T48's hour run), else the run's longest (qMax); ex: extra seconds per vehicle through the works;
// dv: vehicles detoured. tot: total extra delay in the SUMO area in veh·min — SUMO's own total when the run has one
// (total_extra_veh_min), else mean_extra_s (extra time per vehicle against the no-works run, over the vehicles both runs
// share) × cohort_vehicles (the vehicles counted; vehicles if missing) / 60, flagged totEst so the table says "≈ mean × vehicles"
function cmpSuNums(m){
  if(!m||typeof m!=='object')return null;
  const n=v=>v!=null&&v!==''&&Number.isFinite(+v)?+v:null;
  const qe=n(m.works_queue_equiv_end_m),qm=n(m.works_queue_max_m),t0=n(m.total_extra_veh_min),me=n(m.mean_extra_s),nv=n(m.cohort_vehicles)!=null?n(m.cohort_vehicles):n(m.vehicles);
  return{q:qe!=null?qe:qm,qMax:qe==null&&qm!=null,ex:n(m.works_traffic_extra_s),tot:t0!=null?t0:me!=null&&nv!=null?me*nv/60:null,totEst:t0==null&&me!=null&&nv!=null,dv:n(m.detour_vehicles)};
}
// Same p → same SUMO run by construction (T49): { of: the cheapest such plan, extra: hire difference } per plan, as cmpSameAs.
// rows = [{ p, hire, flags }]; a plan with no reading, no hire or no works this hour is never flagged
function cmpSameP(rows){
  const ok=r=>!!r&&Number.isFinite(r.p)&&Number.isFinite(r.hire)&&!(r.flags&&r.flags.inactive);
  return rows.map((r,j)=>{if(!ok(r))return null;let of=-1;
    rows.forEach((x,i)=>{if(i!==j&&ok(x)&&x.p===r.p&&x.hire<r.hire&&(of<0||x.hire<rows[of].hire))of=i;});
    return of<0?null:{of,extra:r.hire-rows[of].hire};});
}
// T50: rows → the SUMO options request [{ id, p }] (plans with a reading only), and the key a run is cached under: seed + each
// id:p (same p and seed = the same SUMO run by construction, whatever else differs in the plan)
function cmpSuAsk(rows){return(rows||[]).map(r=>({id:r&&r.id,p:r?cmpP(r.s):null})).filter(o=>o.id&&o.p!=null);}
function cmpSuKey(ask,seed){return`${seed}|${(ask||[]).map(o=>o.id+':'+o.p).join(',')}`;}
// T50 (lead): the guided kit (o3: one VMS naming the fastest detour) next to the standard kit (o2: two VMS reporting the delay) —
// when it costs less yet moves more drivers off the works route (p, the engine's sign reading) → on its column
// { of: o2's index, save: A$ less, fewer: VMS fewer }, else null. A neutral note, not a verdict; works hours only
function cmpLeaner(rows){
  const out=(rows||[]).map(()=>null),iB=out.length?rows.findIndex(r=>r&&r.tier==='o2'):-1,iC=out.length?rows.findIndex(r=>r&&r.tier==='o3'):-1;
  if(iB<0||iC<0)return out;
  const B=rows[iB],C=rows[iC],pB=cmpP(B.s),pC=cmpP(C.s),off=r=>!!(r.flags&&r.flags.inactive);
  if(!Number.isFinite(B.hire)||!Number.isFinite(C.hire)||!(C.hire<B.hire)||pB==null||pC==null||!(pC>pB)||off(B)||off(C))return out;
  out[iC]={of:iB,save:B.hire-C.hire,fewer:Math.max(0,cmpKit(B.plan).vms-cmpKit(C.plan).vms)};
  return out;
}
// be.options() result → card rows (A, B, C); result is the engine's brief summary for this hour, hire is over the works period
function cmpFromOptions(res){
  return ((res&&res.options)||[]).slice(0,CMP_MAX).map((o,i)=>({id:String.fromCharCode(65+i),tier:o.id,kind:'kit',label:o.label,label_zh:o.label_zh,plan:o.plan,s:o.result||null,
    hire:o.hire&&Number.isFinite(o.hire.total_aud)?o.hire.total_aud:null,days:res.days==null?null:res.days,flags:o.flags||{}}));
}
// Equipment in a plan by type → { vms, sign, arrow, barrier } counts (qty when the kit gives one)
function cmpKit(plan){
  const ws=plan&&plan.worksites&&plan.worksites[0],k={vms:0,sign:0,arrow:0,barrier:0};
  for(const e of (ws&&ws.equipment)||[])if(e.type in k)k[e.type]+=Number.isInteger(e.qty)&&e.qty>0?e.qty:1;
  return k;
}
// What a plan puts on the VMS, frame by frame (for the card; set with textContent)
function cmpVms(plan){
  const ws=plan&&plan.worksites&&plan.worksites[0],v=ws&&(ws.equipment||[]).find(e=>e.type==='vms');
  return v&&v.frames?v.frames.map(f=>f.join(' / ')).join('  ▸  '):'';
}
// Execution pack → one printable page. d = pack.js packDoc(p, lang); x = { rows: [{ id, label, car, transit, peds, hire }], pick, by, hour, date, credits, src }
// (credits = creditLines(): data attribution the licences ask for, printed above the footer; src 'sumo' (T49, the SUMO plan):
// car = SUMO's total extra delay in its area, trams & buses / on foot not covered by SUMO — never the engine's)
// (the plans compared, numbers from the engine); h = { L, esc, fmt } passed in so tests/compare_glue.mjs runs this in node.
// Every string goes through esc(), every number through fmt(). The page is paper-white in both themes.
function cmpDocHTML(d,x,h){
  const{L,esc,fmt}=h,lb=d.labels,c=lb.cols,aud=v=>v==null?'—':'A$'+fmt(v),su=x.src==='sumo',na=v=>v==null?(su?esc(L('not covered by SUMO','SUMO 暂不覆盖')):'—'):fmt(v);
  const ch=(x.rows||[])[x.pick],wp=String(d.when||'').split(' · ');
  const facts=[[lb.when,esc(wp[0]),esc(wp.slice(1).join(' · '))],[lb.decision,ch?esc(ch.id)+' · '+esc(ch.label):esc(d.decision||'—'),ch?esc(x.by||''):''],
    [lb.total,d.quote.total_aud==null?esc(d.quote.at_least)+' '+aud(d.quote.partial_aud):aud(d.quote.total_aud),esc(L('assumed day rates','日租价为假设值'))]];
  const opts=(x.rows||[]).map((r,i)=>`<tr${i===x.pick?' class="pick"':''}><td>${esc(r.id)} · ${esc(r.label)}${i===x.pick?` <em>${esc(L('chosen','已选'))}</em>`:''}</td><td class="n">${r.car==null?'—':fmt(r.car)}</td><td class="n">${na(r.transit)}</td><td class="n">${na(r.peds)}</td><td class="n">${aud(r.hire)}</td></tr>`).join('');
  const eq=d.quote.lines.map(l=>`<tr><td>${esc(l.name||l.item)}${l.over?`<div class="pd-over">${esc(l.over)}</div>`:''}</td><td class="n">${l.qty==null?'?':fmt(l.qty)}</td><td class="n">${l.rate==null?'—':'A$'+fmt(l.rate)+esc(d.quote.per_day)}</td><td class="n">${fmt(l.days)}</td><td class="n">${aud(l.cost)}</td></tr>`).join('');
  const vms=d.vms.map(v=>`<div class="pd-vms"><div class="pd-vms-meta"><b>${esc(v.id)}</b><span>${esc(v.at)}</span><span>${esc(v.when)}</span></div><div class="pd-frames">${v.frames.map(f=>`<figure><figcaption>${esc(f.label)}</figcaption><div class="pd-led">${f.lines.map(esc).join('<br>')}</div></figure>`).join('')}</div></div>`).join('');
  const signs=d.signs.map(g=>`<li><b>${esc(g.id)}</b> · ${esc(g.at)}${g.text?` · <span class="pd-mono">${esc(g.text)}</span>`:''}</li>`).join('');
  const checks=d.checks.length?d.checks.map(k=>`<li>${esc(k)}</li>`).join(''):`<li class="pd-ok">${esc(lb.none)}</li>`;
  const notify=d.notify.map(n=>`<tr><td><b>${esc(n.who)}</b></td><td>${esc(n.why)}</td></tr>`).join('');
  return`<article class="pack-doc" lang="${d.lang==='zh'?'zh-CN':'en'}">
<header class="pd-head"><span>RippleTwin · ${esc(d.head)}</span><span>${esc(x.date||'')}</span></header>
<div class="pd-title"><h1>${esc(d.title)}</h1>${d.status?`<span class="pd-pill">${esc(d.status.text)}</span>`:''}</div>
<p class="pd-sub">${esc(d.id||'')} · ${esc(d.where)}</p>
<div class="pd-facts">${facts.map(([k,v,n])=>`<div><span>${esc(k)}</span><b>${v}</b>${n?`<small>${n}</small>`:''}</div>`).join('')}</div>
${d.reason?`<blockquote class="pd-reason"><span>${esc(lb.reason)}</span>${esc(d.reason)}</blockquote>`:''}
${opts?`<section><h2>${esc(L('Plans compared','比较过的方案'))}</h2><div class="pd-scroll"><table class="pd-t"><thead><tr><th>${esc(L('Plan','方案'))}</th><th class="n">${esc(su?L('Extra delay · SUMO area','SUMO 范围延误增量'):L('Car delay','车延误'))}<small>${esc(L('veh·min','车·分钟'))}</small></th><th class="n">${esc(L('Tram & bus','电车公交'))}<small>${esc(L('rider·min','人·分钟'))}</small></th><th class="n">${esc(L('On foot','行人'))}<small>${esc(L('ped·min','人·分钟'))}</small></th><th class="n">${esc(L('Hire','租金'))}<small>${esc(L('works period','整个工期'))}</small></th></tr></thead><tbody>${opts}</tbody></table></div><p class="pd-note">${esc(su?L(`Traffic numbers: SUMO on the real CBD network around the works, weekday ${x.hour}, one hour; trams, buses and pedestrians are not covered by SUMO. Hire: whole works period.`,`车流数字：SUMO 在施工附近的真实 CBD 路网上算的工作日 ${x.hour} 这一小时；电车公交和行人 SUMO 暂不覆盖。租金：整个工期。`):L(`Traffic numbers: simulation engine, weekday ${x.hour}, one hour. Hire: whole works period.`,`车流数字：仿真引擎，工作日 ${x.hour} 这一小时。租金：整个工期。`))}</p></section>`:''}
<section><h2>${esc(lb.quote)}</h2><div class="pd-scroll"><table class="pd-t"><thead><tr><th>${esc(c.item)}</th><th class="n">${esc(c.qty)}</th><th class="n">${esc(c.rate)}</th><th class="n">${esc(c.days)}</th><th class="n">${esc(c.cost)}</th></tr></thead><tbody>${eq}</tbody><tfoot><tr><td colspan="4">${esc(lb.total)}</td><td class="n">${d.quote.total_aud==null?esc(d.quote.at_least)+' '+aud(d.quote.partial_aud):aud(d.quote.total_aud)}</td></tr></tfoot></table></div><p class="pd-note">${esc(d.quote.note)}</p></section>
<section><h2>${esc(lb.vms)}</h2>${vms||`<p class="pd-note">${esc(lb.none)}</p>`}</section>
${signs?`<section><h2>${esc(lb.signs)}</h2><ul class="pd-list">${signs}</ul></section>`:''}
<section class="pd-two"><div><h2>${esc(lb.checks)}</h2><ul class="pd-list pd-checks">${checks}</ul></div><div><h2>${esc(lb.notify)}</h2><table class="pd-t pd-notify"><tbody>${notify}</tbody></table></div></section>
${(x.credits||[]).length?`<section class="pd-src"><h2>${esc(L('Data sources','数据来源'))}</h2><ul class="pd-list">${x.credits.map(c=>`<li>${esc(c)}</li>`).join('')}</ul></section>`:''}
<footer class="pd-foot"><span>${esc(su?cmpSuFoot(L):d.foot)}</span><span>RippleTwin</span></footer>
</article>`;
}
// The pack's footer on the SUMO plan (T49): pack.js says the figures come from the engine; here the traffic figures are SUMO's
function cmpSuFoot(L){return L('Traffic figures come from SUMO (a model, not field measurements); trams, buses and pedestrians are not covered by SUMO; hire rates are assumptions.','交通数字来自 SUMO（模型，不是实测）；电车公交和行人 SUMO 暂不覆盖；租金是假设值。');}
/* pure:end */

const CP={key:'',seq:0,busy:false,rows:[],src:'',pick:null,cl:null,by:'contractor',reason:'',mod:null,inv:null,invErr:null,loading:null,exKey:'',exSeq:0,exBusy:false,explain:null,exError:false,su:null};
// T49: the plan SUMO covers (the Lonsdale demo works, one lane closed — as sumoImpactHTML in 5-app.js). On it no engine traffic
// outcome is shown in 04 / 05, 03's nearby works or the VMS lab: SUMO's numbers, or “not covered by SUMO” where SUMO has none
function suPlan(){return typeof SUMO_LINK==='string'&&EP.link===SUMO_LINK&&!EP.all&&EP.lanes===1;}

// Execution pack, AI explanation and inventory; all model text is rendered as textContent.
function cmpLoad(){
  if(CP.loading)return CP.loading;
  CP.loading=Promise.all([import('/api/public/js/pack.js'),import('/api/public/js/explain.js')])
    .then(async([pack,ex])=>{CP.mod={pack,ex};try{CP.inv=await pack.loadInventory();}catch(e){CP.invErr=e;console.warn('equipment inventory not loaded',e);}})
    .catch(e=>{CP.invErr=e;console.warn('pack module not loaded',e);});
  return CP.loading;
}
// The engine's own link records carry len_m / name / lanes / tram, which is all pack.js reads
function cmpLinks(ws){const net=engNet(),m=new Map();if(!net||!ws)return m;for(const id of ws.links||[]){const l=net.links.get(id);if(l)m.set(id,l);}return m;}
function cmpLabel(r){return r.kind==='kit'?L(r.label||r.tier,r.label_zh||r.label||r.tier):r.kind==='now'?L('Your plan','现在的方案'):r.kind==='text'?L('Edit the sign text','改屏上的字'):r.kind==='move'?L('Move the VMS','挪 VMS'):r.kind;}
function cmpWhat(r){ // textContent only
  if(r.kind==='move')return(r.equipment||'VMS')+' → '+r.at_m+' m '+L('upstream','上游');
  const v=cmpVms(r.plan)||L('No VMS','没有 VMS');if(r.kind!=='kit')return v;
  const k=cmpKit(r.plan);
  return v+' · '+[[k.vms,'VMS','VMS','VMS'],[k.barrier,'barrier','barriers','护栏'],[k.sign,'sign','signs','标志牌'],[k.arrow,'arrow board','arrow boards','箭头板']].filter(x=>x[0]>0).map(x=>x[0]+' '+L(x[0]===1?x[1]:x[2],x[3])).join(' · ');
}

// T50: be.options() for a plan, shared by 04 (cmpUpdate) and the step-2 prefetch (cmpPrefetch), so the plans are built once.
// The latest plan only; a failure is not kept (the next call builds again)
const CPO={key:'',p:null};
function cmpOptions(plan){
  const key=JSON.stringify(plan);
  if(CPO.key!==key||!CPO.p){const p=Promise.resolve().then(()=>BE.api.options(plan,{n:CMP_MAX}));CPO.key=key;CPO.p=p;p.catch(()=>{if(CPO.p===p){CPO.key='';CPO.p=null;}});}
  return CPO.p;
}
async function cmpUpdate(){
  if(!engOn()||EP.badText)return;
  const plan=planFrom(EP),kits=typeof BE.api.options==='function';
  if(!kits&&!EP.adv)return; // fallback path waits for the advisor
  const key=JSON.stringify(plan)+(kits?'|kits':'|adv|'+JSON.stringify(EP.adv.options.map(o=>o.plan)));
  if(key===CP.key)return;
  CP.key=key;CP.rows=[];CP.pick=null;CP.busy=true;const seq=++CP.seq;
  let rows=null,src='';
  if(kits){try{rows=cmpFromOptions(await cmpOptions(plan));src='kits';}catch(e){console.warn('compare: options() failed, using the advisor instead',e);}}
  if(!rows||!rows.length){
    if(!EP.adv){if(seq===CP.seq){CP.key='';CP.busy=false;}return;} // retried when the advisor lands (engRender4 → cmpRender)
    rows=[];src='advisor';
    for(const x of cmpSources(plan,EP.adv)){let s=null;try{s=await BE.api.run(x.plan);}catch(e){console.warn('compare: run failed',e);}rows.push({...x,s});}
  }
  await cmpLoad();
  if(src==='advisor')for(const r of rows){
    const ws=r.plan.worksites[0];r.hire=null;r.days=null;
    if(CP.mod&&CP.inv){try{const q=CP.mod.pack.quote(ws,CP.inv,{links:cmpLinks(ws)});r.hire=q.total_aud;r.days=q.days;}catch(e){console.warn('compare: quote failed',e);}}
  }
  if(seq!==CP.seq)return;
  CP.rows=rows;CP.src=src;CP.busy=false;cmpRender();
}

// 04 Compare, "Nearby works" row (T43): each plan against the one overlapping works 03 Impact shows for this plan (same pick,
// clashPick in 8-clash.js), by be.clash(). Filled in after the table is on screen, cell by cell; never holds the table up.
// CP.cl = { key, other: undefined (still picking) | null (none overlap) | { o, ws, r, days? }, cells: [clash result | 'err'], err }
// T46: 03 staggered the other works → other.ws is 03's shifted works and other.days its N (cmpClashOther); the key carries N,
// so staggering in 03 re-scores this row, and 03 dropping the stagger (re-scored, CL.st = null) puts the original dates back
async function cmpClashUpdate(){
  if(S.ui!==4||CP.busy||CP.rows.length<2||!engOn()||EP.badText)return;
  const cur=clashCur(),in3=CL.m&&CL.key===JSON.stringify(cur)&&!CL.busy&&!CL.err; // 03 already picked it for this same plan
  const x3=in3?cmpClashOther(CL.other,CL.st):null,key=CP.key+(x3&&x3.days!=null?`|+${x3.days}`:'');
  if(CP.cl&&CP.cl.key===key)return;
  const st=CP.cl={key,other:undefined,cells:[],err:false},alive=()=>CP.cl===st;
  try{
    let x;
    if(in3)x=x3; // 03's pick, shifted if 03 staggered it
    else{const sc=await clashPick(cur,alive);if(!sc)return;x=sc[0]||null;}
    st.other=x;cmpRender();
    for(let i=0;x&&!suPlan()&&i<CP.rows.length;i++){ // T49: the SUMO plan shows no engine clash cost → not scored per plan
      const r=CP.rows[i];let v='err';
      if(r.s)try{v=await BE.api.clash(r.plan.worksites[0],x.ws);}catch(e){console.warn('compare: clash check failed for plan',r.id,e);}
      if(!alive())return;st.cells[i]=v;cmpRender();
    }
  }catch(e){if(!alive())return;st.err=true;console.warn('compare: nearby works check failed',e);cmpRender();}
}
function cmpClashRow(rc){
  const c=CP.cl,x=c&&c.other,U=L('veh·min','车·分钟');
  const vals=CP.rows.map((_,i)=>{const r=c&&c.cells[i];return r&&r!=='err'&&r.flags.reliable?r.cost:null;}),best=cmpBest(vals.map(v=>({v})),['v']);
  let wlab='…';
  if(c&&c.err)wlab='—';
  else if(x===null)wlab=L('no other registered works overlap','登记表里没有同期的其他施工');
  else if(x){const net=engNet(),l=net&&net.links.get(x.ws.links[0]);wlab=`${esc(shortSt(l&&l.name||x.o.title))} · ${cmpClashWhen(x,LANG.cur==='zh',engHour)}`;
    const w=cmpWin(x.days==null?x.r.overlap.days:x.overlapDays,x.r.hours.length,LANG.cur==='zh');if(w)wlab+=` · ${w}`; // T49: the clash number is summed over this window
    if(!suPlan())wlab+=` · ${L('engine estimate','引擎估算')}`;}
  // T49: the SUMO plan — which works overlap, when, and the stagger suggestion (days, from the dates alone); no engine clash cost
  if(suPlan())return`<tr><th scope="row"${x?` title="${esc(x.o.title)}"`:''}>${L('Nearby works','和附近施工叠加')}<small>${wlab}</small></th>${CP.rows.map((r,i)=>`<td${rc(i)}>${c&&c.err?'—':x===null?L('none','无'):x?cmpSuStagger(x):'…'}</td>`).join('')}</tr>`;
  const cell=i=>{
    if(c&&c.err)return'—';
    if(x===null)return L('none','无');
    const r=x&&c.cells[i];if(!r)return'…';if(r==='err')return'—';
    if(!r.flags.reliable)return`<span class="cmp-num">≈ 0</span><small class="cmp-u">${L('not reliable','结果不可信')}</small>`;
    return`<span class="cmp-num"${r.cost>0?' style="color:var(--risk)"':''}>${r.cost>0?'+':''}${fmtN(r.cost)}</span><small class="cmp-u">${U}</small>${best.v&&best.v.includes(i)?`<i class="cmp-best">${L('lowest','最少')}</i>`:''}`;
  };
  return`<tr><th scope="row"${x?` title="${esc(x.o.title)}"`:''}>${L('Nearby works','和附近施工叠加')}<small>${wlab}</small></th>${CP.rows.map((r,i)=>`<td${rc(i)}>${cell(i)}</td>`).join('')}</tr>`;
}

// Independent of scoring: never delay choosing/exporting a plan for AI text.
function cmpExplainUpdate(){
  const lang=LANG.cur==='zh'?'zh':'en';
  const key=CP.key+'|'+lang;
  // T49: on the SUMO plan the AI explanation is not asked for — explain.js reads the engine's numbers (optionFromRun) and would
  // quote them; hidden rather than fed SUMO's, whose metrics it has no fields for (safer: nothing it says can carry an engine number)
  if(CP.busy||!CP.rows.length||suPlan()){
    if(CP.exKey){CP.exKey='';++CP.exSeq;CP.explain=null;CP.exBusy=false;}
    return;
  }
  if(!CP.mod||CP.exKey===key)return;
  CP.exKey=key;CP.explain=null;CP.exError=false;CP.exBusy=true;
  const seq=++CP.exSeq;
  const options=CP.rows.filter(r=>r.s).map(r=>CP.mod.ex.optionFromRun(r.id,cmpLabel(r),r.s,{hire_aud:r.hire,days:r.days}));
  Promise.resolve().then(()=>CP.mod.ex.explainOptions({lang,options})).then(result=>{
    if(seq!==CP.exSeq||key!==CP.key+'|'+(LANG.cur==='zh'?'zh':'en'))return;
    CP.explain=result;
  }).catch(e=>{if(seq===CP.exSeq)CP.exError=true;console.warn('compare: explanation unavailable',e);})
    .finally(()=>{if(seq===CP.exSeq){CP.exBusy=false;cmpRender();}});
}
function cmpExplainRender(el){
  if(suPlan()){ // T49: no AI explanation, no "leaning" on the SUMO plan (cmpExplainUpdate) — say why once, where the advice line goes
    el.querySelectorAll('[data-cmpexplain],[data-cmplean]').forEach(b=>b.replaceChildren());
    const hd=el.querySelector('[data-cmphead]'),dc=el.querySelector('[data-cmpdecide]');if(hd)hd.textContent=engHour(EP.hour);
    if(dc)dc.textContent=L('No AI explanation for this plan: it would quote the engine’s numbers, and here the traffic numbers come from SUMO. The person responsible chooses the plan and records why.','这套方案不显示 AI 解读：它会引用引擎的数，而这里的交通数字来自 SUMO。由负责人选择方案并记录理由。');
    return;
  }
  const result=CP.explain;
  el.querySelectorAll('[data-cmpexplain]').forEach(box=>{
    box.replaceChildren();
    const r=CP.rows[+box.dataset.cmpexplain];
    const item=result?.options.find(o=>o.id===r.id);
    const add=(tag,text)=>{const node=document.createElement(tag);node.textContent=text;box.appendChild(node);};
    add('b',L('AI explanation','AI 解读'));
    if(!item){add('p',CP.exBusy?L('Reading these plans…','正在解读这些方案…'):L('Explanation unavailable; you can still choose a plan.','解读暂不可用，仍可选择方案。'));return;}
    add('small',result.src==='rule'?L('Rule fallback','规则兜底'):result.src==='kv'?L('AI · cached','AI · 缓存'):L('AI interpretation','AI 解读'));
    add('p',item.summary);
    for(const [title,items] of [[L('Pros','优点'),item.pros],[L('Cons','缺点'),item.cons]]){
      add('b',title);const list=document.createElement('ul');
      for(const text of items.length?items:[L('None listed','未列出')]){const li=document.createElement('li');li.textContent=text;list.appendChild(li);}box.appendChild(list);
    }
  });
  const lean=el.querySelector('[data-cmplean]'),decide=el.querySelector('[data-cmpdecide]');
  // the pick in bold; its reason (model text, often long) only in Details mode (.cmp-lean-why, styles.css)
  if(lean){const row=CP.rows.find(r=>r.id===result?.lean?.option);lean.replaceChildren();
    if(row){const b=document.createElement('b'),w=document.createElement('span');b.textContent=L('Leaning toward ','倾向：')+cmpLabel(row);w.className='cmp-lean-why';w.textContent=' · '+result.lean.why;lean.append(b,w);}
    const hd=el.querySelector('[data-cmphead]');if(hd)hd.textContent=row?L('Leaning: ','倾向：')+cmpLabel(row):engHour(EP.hour);} // the folded header says the pick
  if(decide)decide.textContent=result?.decide||L('This is advice only. The person responsible chooses the plan and records why.','这只是建议，由负责人选择方案并记录理由。');
}

// ---- SUMO plan (D-1001-0045): 04 / 05 traffic numbers come from SUMO ----
// Each option's p (cmpP: the engine's sign reading, behind the scenes) → the SUMO client's runOptions([{ id, p }…], { seed })
// (sumo-client.js, T49-a; loaded by 5-app.js sumoClient(), feature-detected). Missing, failing or empty → '—' + the reason,
// never engine numbers. CP.su = { key, busy, t0, job, res: { id: metrics | null } | null, err, src: { source, elapsedMs, why (the client's reason, labelled), seed, hour }, tick }
// T50: runs go through CSU (below), shared with the prefetch that starts right after step 2's live run — 04 joins it
const CSU=new Map(),CSU_MAX=8;
// T50: the SUMO options run for ask + seed, one per cmpSuKey: started once, joined by whoever asks next (04, the step-2
// prefetch, a second visit). job = { key, t0 (asked), wait (queued in sumoLane behind another cloud run — never two at once
// from this page), t1 (its cloud call began), p: Promise<out>, out: { r } | { fail: 'load' | 'fn' | 'run', why } once settled }.
// Only a run that gave results stays cached (the newest CSU_MAX); a failure is dropped, so "Try again" really runs again
function cmpSuJob(ask,seed){
  const key=cmpSuKey(ask,seed),hit=CSU.get(key);if(hit)return hit;
  const job={key,t0:Date.now(),t1:0,wait:false,out:null,p:null};CSU.set(key,job);
  while(CSU.size>CSU_MAX)CSU.delete(CSU.keys().next().value);
  const why=e=>typeof sumoErr==='function'?sumoErr(e):String((e&&e.message)||e).slice(0,160); // plain text: esc() when shown (cmpSuRows)
  const ping=()=>{if(CP.su&&CP.su.job===job&&typeof cmpRender==='function')cmpRender();}; // queued → computing: the spinner's words change
  job.p=(async()=>{
    let fn=null;
    try{const cli=typeof sumoClient==='function'?await sumoClient():null,mod=typeof SU==='object'&&SU?SU.mod:null;
      fn=cli&&typeof cli.runOptions==='function'?cli.runOptions.bind(cli):mod&&typeof mod.runOptions==='function'?mod.runOptions:null;}
    catch(e){return{fail:'load',why:why(e)};}
    if(!fn)return{fail:'fn'};
    const go=()=>{job.wait=false;job.t1=Date.now();ping();return fn(ask,{seed});};
    try{if(typeof sumoLane!=='function')return{r:await go()};job.wait=true;const run=sumoLane(go);ping();return{r:await run};} // lane free → go() runs before the next paint
    catch(e){job.wait=false;return{fail:'run',why:why(e)};}
  })().then(out=>{job.out=out;if(!(out.r&&Object.values(cmpSuParse(out.r,ask.map(o=>o.id))).some(Boolean))&&CSU.get(key)===job)CSU.delete(key);return out;});
  return job;
}
// T50: right after step 2's live SUMO run (sumoRerun in 5-app.js, seed = that run's), build 04's plans exactly as 04 does
// (cmpOptions → cmpFromOptions → cmpP) and start their options run in the background; nothing is rendered. 04 then finds it
// in CSU: finished → shown at once, still running → joined. Off the SUMO plan / no options() / plan or seed changed while the
// plans were built → nothing. → the job, or null
async function cmpPrefetch(seed){
  try{
    if(!suPlan()||!engOn()||EP.badText||!BE.api||typeof BE.api.options!=='function')return null;
    const plan=planFrom(EP),key=JSON.stringify(plan),sd=Number.isFinite(seed)?seed:typeof SU==='object'&&SU?SU.seed:42;
    const rows=cmpFromOptions(await cmpOptions(plan));
    if(!suPlan()||JSON.stringify(planFrom(EP))!==key||(typeof SU==='object'&&SU&&SU.seed!==sd)||rows.length<2)return null;
    const ask=cmpSuAsk(rows);
    return ask.length?cmpSuJob(ask,sd):null;
  }catch(e){console.info('04 prefetch skipped:',(e&&e.message)||e);return null;}
}
// seconds the spinner shows: since the cloud call began, or since it was asked while it waits / the client loads
function cmpSuEl(su){const j=su&&su.job,t=j?(j.t1||j.t0):su&&su.t0;return Math.max(0,Math.round((Date.now()-(t||Date.now()))/1000));}
async function cmpSuUpdate(){
  if(!suPlan()||(S.ui!==4&&S.ui!==5)||CP.busy||CP.rows.length<2||!engOn()||EP.badText)return;
  const ps=CP.rows.map(r=>cmpP(r.s)),seed=typeof SU==='object'&&SU?SU.seed:42,key=`${CP.key}|${ps.join(',')}|${seed}`;
  if(CP.su&&CP.su.key===key)return;
  if(CP.su&&CP.su.tick)clearInterval(CP.su.tick);
  const st=CP.su={key,busy:true,t0:Date.now(),job:null,res:null,err:null,src:null,tick:0},alive=()=>CP.su===st;
  const ask=cmpSuAsk(CP.rows);
  const done=err=>{if(!alive())return;st.busy=false;if(err)st.err=err;clearInterval(st.tick);st.tick=0;cmpRender();};
  if(!ask.length)return done(L('the engine read no sign for these plans, so SUMO has no input','引擎没读出这几套方案的牌，SUMO 没有输入'));
  const fin=out=>{
    if(!alive())return;
    if(out.fail==='load')return done(L(`the SUMO client did not load (${out.why})`,`SUMO 客户端没加载上（${out.why}）`));
    if(out.fail==='fn')return done(L('this SUMO client has no runOptions yet — the options run is not deployed','这个版本的 SUMO 客户端还没有 runOptions —— 多方案计算还没上线'));
    if(out.fail)return done(L(`the SUMO options run failed (${out.why})`,`SUMO 多方案计算失败（${out.why}）`));
    const r=out.r,res=cmpSuParse(r,ask.map(o=>o.id)),ix=r&&r.index&&typeof r.index==='object'?r.index:{},rs=r&&r.reason?String(typeof sumoReason==='function'?sumoReason(r.reason):r.reason):'';
    st.src={source:r&&r.source||'',elapsedMs:r&&r.elapsedMs,why:rs,seed:Number.isFinite(+ix.seed)?+ix.seed:seed,hour:Number.isFinite(+ix.hour)?+ix.hour:null};
    if(!Object.values(res).some(Boolean))return done(rs?L(`SUMO gave no result for these plans (${rs})`,`SUMO 没给出这几套方案的结果（${rs}）`):L('SUMO gave no result for these plans','SUMO 没给出这几套方案的结果'));
    st.res=res;done(null);
  };
  // T50: the run the step-2 prefetch (or an earlier visit) started is joined — finished: shown at once, no spinner;
  // still running: the spinner goes on from its elapsed time; waiting behind step 2's run: says so
  const job=st.job=cmpSuJob(ask,seed);
  if(job.out)return fin(job.out);
  // the seconds tick in place (the table itself is not rebuilt every second)
  st.tick=setInterval(()=>{if(!alive()||!st.busy){clearInterval(st.tick);return;}const e=document.querySelector('[data-cmpsuel]');if(e)e.textContent=String(cmpSuEl(st));},1000);
  cmpRender();
  fin(await job.p);
}
// cmpSuNums per row (null = no SUMO number for that column yet)
function cmpSuAll(){const su=CP.su,res=su&&su.res;return CP.rows.map(r=>res?cmpSuNums(res[r.id]):null);}
// SUMO's hour: the run's own (index.hour), else the pre-computed replay's, else 8 (SUMO runs weekday 08:00–09:00)
function cmpSuHour(){const h=CP.su&&CP.su.src&&CP.su.src.hour;return Number.isFinite(h)?h:typeof SU==='object'&&SU&&SU.index&&Number.isFinite(+SU.index.hour)?+SU.index.hour:8;}
// Where the numbers came from, for the caption: live (seconds, seed) / pre-computed (+ why) / '' while nothing
function cmpSuSrc(){
  const s=CP.su&&CP.su.res&&CP.su.src;if(!s)return'';const sd=Number.isFinite(s.seed)?` · seed ${s.seed}`:'';
  if(s.source==='live')return L(`SUMO computed live in the cloud${Number.isFinite(s.elapsedMs)?` · ${(s.elapsedMs/1000).toFixed(1)} s`:''}${sd}`,`云端 SUMO 现场计算${Number.isFinite(s.elapsedMs)?` · ${(s.elapsedMs/1000).toFixed(1)} s`:''}${sd}`);
  return L(`SUMO · pre-computed (cloud unavailable)${s.why?` · ${esc(s.why)}`:''}${sd}`,`SUMO · 预先跑好的（云端没算成）${s.why?` · ${esc(s.why)}`:''}${sd}`);
}
// 04's traffic rows on the SUMO plan: p (SUMO's input), then SUMO's numbers — a spinner row while the cloud runs, '—' + the
// reason when it could not — then trams & buses / pedestrians, which SUMO does not cover. rc = the column attributes
function cmpSuRows(rc){
  const su=CP.su,ps=CP.rows.map(r=>cmpP(r.s)),sn=cmpSuAll(),n=CP.rows.length,H=cmpSuHour();
  const best=cmpBest(sn.map(x=>x||{}),['q','ex','tot']),lo=(k,i)=>!!(k&&best[k]&&best[k].includes(i));
  const tr=(lab,sub,cells)=>`<tr><th scope="row">${lab}${sub?`<small>${sub}</small>`:''}</th>${cells}</tr>`;
  let h=tr(L('Drivers who detour (AI sign reading)','AI 读牌 → 会绕行的司机'),L('SUMO’s input · the engine reads each plan’s signs','SUMO 的输入 · 引擎读每套方案的牌'),CP.rows.map((r,i)=>`<td${rc(i)}><span class="cmp-num">${ps[i]==null?'—':pctS(ps[i])}</span></td>`).join(''));
  const M=[[L(`Works queue at ${engHour(H+1)}`,`${engHour(H+1)} 施工排队`),'m','q',x=>x.q,x=>x.qMax?L('longest in the run','本次最长'):''],
    [L('Extra per vehicle through the works','过施工段每车多花'),L('s vs no works','秒 · 比不施工'),'ex',x=>x.ex,null],
    [L('Total extra delay in the SUMO area','SUMO 范围内总延误增量'),L('veh·min','车·分钟'),'tot',x=>x.tot,x=>x.totEst?L('≈ mean × vehicles','≈ 平均 × 车数'):''],
    [L('Detoured vehicles','绕行的车'),L('vehicles · this run','辆 · 本次'),'',x=>x.dv,null]];
  // T50: queued behind another cloud run (one at a time from this page) → says whose, then these plans
  const q=su&&su.busy&&su.job&&su.job.wait,s2=typeof SU==='object'&&SU&&SU.busy;
  if(su&&su.busy)h+=`<tr class="cmp-su-wait"><td colspan="${n+1}"><div class="sumo-wait" role="status"><span class="spin" aria-hidden="true"></span><span>${q?(s2?L('Waiting for step 2’s SUMO run to finish, then these plans','等第 2 步的 SUMO 算完，再算这几套方案'):L('Waiting for the previous SUMO run to finish, then these plans','等上一次 SUMO 计算结束，再算这几套方案'))+` · <span data-cmpsuel>${cmpSuEl(su)}</span> s ${L('(one cloud run at a time)','（云端一次只算一个）')}`:`${L('SUMO computing the options in the cloud','SUMO 正在云端计算这几套方案')} · <span data-cmpsuel>${cmpSuEl(su)}</span> s ${L('(about 1 min)','（约 1 分钟）')}`}</span></div></td></tr>`;
  else{
    h+=M.map(([lab,unit,k,g,note])=>tr(lab,unit,CP.rows.map((r,i)=>{const x=sn[i],v=x?g(x):null,t=x&&note?note(x):'';
      return`<td${rc(i)}><span class="cmp-num">${v==null?'—':fmtN(v)}</span>${t?`<small class="cmp-u">${t}</small>`:''}${v!=null&&lo(k,i)?`<i class="cmp-best">${L('lowest','最少')}</i>`:''}</td>`;}).join(''))).join('');
    if(!su||!su.res)h+=`<tr class="cmp-su-note"><td colspan="${n+1}">${su&&su.err?`${L('SUMO numbers unavailable','SUMO 数字暂时没有')}: ${esc(su.err)} · <button type="button" class="linkbtn" data-cmpsure>${L('Try again','重试')}</button>`:L('SUMO numbers appear once the plans are built.','方案配好后这里显示 SUMO 的数。')}</td></tr>`;
  }
  // T51 (@unicornnnnnny): no trams & buses / pedestrians rows — SUMO models cars only, so every cell read
  // "not covered by SUMO"; the caption says "cars only" and the execution pack keeps the full note
  return h;
}

function cmpHTML(){
  if(!engOn()||EP.badText)return'';
  const exp=S.ui===5; // 05 Export (6-step UI) shows the picked plan + the decision; 04 Compare shows all of them
  const head=`<div class="row between cmp-head"><span class="eyebrow" style="color:var(--sun-ink)">${exp?L('Confirm & export','确认导出'):L('Compare plans · choose one','方案对比 · 选一套')}</span><span class="eyebrow" data-cmphead>${engHour(EP.hour)}</span></div>`;
  if(CP.busy||!CP.rows.length)return head+`<div class="card eng-note"><b>${CP.busy||EP.advBusy?suPlan()?L('Building plans from the RPM inventory and reading each plan’s signs…','正在按 RPM 库存配方案，并逐套读屏上的字…'):L('Building plans from the RPM inventory and scoring each on the real CBD network…','正在按 RPM 库存配方案，并在真实 CBD 路网上逐套计算…'):L('No plans to compare yet','还没有可以对比的方案')}</b></div>`;
  if(CP.rows.length<2)return head+`<div class="card eng-note"><b>${L('The advisor found no alternative for this hour — only your plan to compare.','顾问这个时段没有别的改法 —— 只有现在这一套。')}</b></div>`;
  // T49: the SUMO plan's cards (05) carry SUMO's total extra delay in its area; trams & buses / on foot are not covered by SUMO
  const su=suPlan(),sn=su?cmpSuAll():null; // T51: no tram & bus / on foot cells on the SUMO plan's cards
  const nums=CP.rows.map((r,i)=>su?{car:sn[i]?sn[i].tot:null,transit:null,peds:null,hire:r.hire}:{...cmpNumbers(r.s),hire:r.hire}),best=cmpBest(nums,['car','transit','peds','hire']);
  const mark=(k,i)=>best[k]&&best[k].includes(i)?`<i class="cmp-best">${L('lowest','最少')}</i>`:'';
  const cell=(k,i,v,unit)=>`<div><span class="eyebrow">${{car:su?L('Extra delay · SUMO area','SUMO 范围延误增量'):L('Car delay','车延误'),transit:L('Tram & bus','电车公交'),peds:L('On foot','行人'),hire:L('Hire','租金')}[k]}</span><b>${v}</b><small>${unit}</small>${mark(k,i)}</div>`;
  const cardsA=CP.rows.map((r,i)=>{
    const n=nums[i],ok=!!r.s,picked=CP.pick===i,f=r.flags||{};
    const warn=[f.stock_ok===false?L('Not enough stock for this kit','库存不够配这一套'):'',f.inactive?L('No works this hour — numbers are 0','这个时段不施工 —— 数字是 0'):''].filter(Boolean);
    return`<div class="card cmp-card" aria-current="${picked}"><div class="cmp-hd"><b>${String.fromCharCode(65+i)} · ${esc(cmpLabel(r))}</b><span class="chips"><button type="button" data-cmppick="${i}" aria-pressed="${picked}" ${ok?'':'disabled'}>${picked?L('Chosen','已选'):L('Choose this','选这个')}</button></span></div>
      <span class="cmp-what" data-cmpwhat="${i}"></span>${warn.map(w=>`<span class="cmp-warn">! ${w}</span>`).join('')}
      ${ok?`<div class="cmp-nums">${cell('car',i,n.car==null?'—':fmtN(n.car),L('veh·min','车·分钟'))}${su?'':cell('transit',i,n.transit==null?'—':fmtN(n.transit),L('rider·min','人·分钟'))+cell('peds',i,n.peds==null?'—':fmtN(n.peds),L('ped·min','人·分钟'))}${cell('hire',i,r.hire==null?'—':'A$'+fmtN(r.hire),r.days?L(`${fmtN(r.days)} days · assumed`,`${fmtN(r.days)} 天 · 假设值`):L('no inventory','无库存数据'))}</div>`
        :`<p class="small" style="color:var(--risk)">${L('The engine could not score this plan.','引擎算不了这套方案。')}</p>`}<div class="cmp-explain" data-cmpexplain="${i}"></div></div>`;}),cards=cardsA.join('');
  // 04 Compare: one table, plans across and measures down (the team template's horizontal comparison); the panel widens for it
  const lean=CP.explain&&CP.explain.lean?CP.explain.lean.option:null,budget=+EP.budget||0,lo=(B,k,i)=>!!(B[k]&&B[k].includes(i));
  const ext=CP.rows.map(r=>({md:r.s&&Number.isFinite(r.s.mean_delay_s)?r.s.mean_delay_s:null,q:r.s&&Number.isFinite(r.s.queue_m)?r.s.queue_m:null})),best2=cmpBest(ext,['md','q']);
  // marks under a plan's name, all in the same small teal as "lowest": Recommended / Baseline here, Cheapest below
  const tag=(r,i)=>r.id===lean?L('Recommended','综合推荐'):i===0&&!lo(best,'hire',i)?L('Baseline','比较基准'):'';
  // the highlighted column: the plan picked (click anywhere in its column), else the recommended one
  const sel=CP.pick!=null&&CP.rows[CP.pick]?CP.pick:CP.rows.findIndex(r=>r.id===lean),rc=i=>` data-cmpcol="${i}"${i===sel?' class="cmp-sel"':''}`;
  const mRows=[[L('Extra per vehicle','每车多等'),'s',i=>ext[i].md,i=>lo(best2,'md',i)],[L('Queue','最长排队'),'m',i=>ext[i].q,i=>lo(best2,'q',i)],
    [L('Network delay','全网延误'),L('veh·min','车·分钟'),i=>nums[i].car,i=>lo(best,'car',i)],[L('Trams & buses','电车公交'),L('rider·min','人·分钟'),i=>nums[i].transit,i=>lo(best,'transit',i)]];
  const days=CP.rows[0].days,dup=cmpSameAs(CP.rows),dupL=d=>{const a=String.fromCharCode(65+d.of),amt=fmtN(d.extra);return L(`Same result as ${a} · +A$${amt}`,`结果和 ${a} 一样 · 多花 A$${amt}`);};
  // T49: on the SUMO plan the same p means the same SUMO run by construction — say the models can't value the extra kit (the arrow
  // board, when that is what it adds), not that the money is wasted
  // T50: the guided kit next to the standard one — one VMS fewer, cheaper, more drivers detour: a neutral note on its column
  const lean2=cmpLeaner(CP.rows),leanL=d=>{const b=String.fromCharCode(65+d.of),amt=fmtN(d.save),n=d.fewer;
    return n===1?L(`One VMS fewer than ${b}, A$${amt} cheaper · just better wording`,`比 ${b} 少一块 VMS、便宜 A$${amt} · 只靠写对屏上的字`)
      :n>1?L(`${n} VMS fewer than ${b}, A$${amt} cheaper · just better wording`,`比 ${b} 少 ${n} 块 VMS、便宜 A$${amt} · 只靠写对屏上的字`)
      :L(`A$${amt} cheaper than ${b} · just better wording`,`比 ${b} 便宜 A$${amt} · 只靠写对屏上的字`);};
  const dupP=su?cmpSameP(CP.rows.map(r=>({p:cmpP(r.s),hire:r.hire,flags:r.flags}))):null,dupS=(d,i)=>{const a=String.fromCharCode(65+d.of),amt=fmtN(d.extra);
    const kx=cmpKit(CP.rows[i].plan),ko=cmpKit(CP.rows[d.of].plan); // T50: the arrow-board wording only when that is all it adds (B also adds two VMS)
    return kx.arrow>ko.arrow&&kx.vms<=ko.vms&&kx.sign<=ko.sign?L(`Same traffic effect as ${a} · models don't value the arrow board's safety role · +A$${amt}`,`交通效果和 ${a} 相同 · 模型不评价箭头板的安全作用 · 多 A$${amt}`)
      :L(`Same traffic effect as ${a} · models don't value the extra equipment's safety role · +A$${amt}`,`交通效果和 ${a} 相同 · 模型不评价多出来的设备的安全作用 · 多 A$${amt}`);};
  const table=`<div class="cmp-table-wrap"><table class="cmp-table"><thead><tr><th scope="col">${L('Measure','评价维度')}</th>${CP.rows.map((r,i)=>`<th scope="col"${rc(i)}><b>${String.fromCharCode(65+i)} · ${esc(cmpLabel(r))}</b><small class="cmp-what" data-cmpwhat="${i}"></small>${tag(r,i)?`<i class="cmp-best">${tag(r,i)}</i>`:''}${lo(best,'hire',i)?`<i class="cmp-best">${L('Cheapest','最省')}</i>`:''}${su?dupP[i]?`<i class="cmp-dup" data-eq>${dupS(dupP[i],i)}</i>`:'':dup[i]?`<i class="cmp-dup">${dupL(dup[i])}</i>`:''}${lean2[i]?`<i class="cmp-dup" data-eq data-lean>${leanL(lean2[i])}</i>`:''}${(r.flags||{}).stock_ok===false?`<i class="cmp-over">${L('not enough stock','库存不够')}</i>`:''}</th>`).join('')}</tr></thead><tbody>
    ${su?cmpSuRows(rc):mRows.map(([n,u,g,l])=>`<tr><th scope="row">${n}<small>${u}</small></th>${CP.rows.map((r,i)=>{const v=g(i);return`<td${rc(i)}><span class="cmp-num">${v==null?'—':fmtN(v)}</span>${v!=null&&l(i)?`<i class="cmp-best">${L('lowest','最少')}</i>`:''}</td>`;}).join('')}</tr>`).join('')}
    ${cmpClashRow(rc)}
    <tr><th scope="row">${L('Hire','租金')}<small>${days?L(`A$ · ${fmtN(days)} days · rates assumed`,`澳元 · ${fmtN(days)} 天 · 日租价为假设`):'A$'}</small></th>${CP.rows.map((r,i)=>{const over=budget>0&&r.hire!=null&&r.hire>budget;return`<td${rc(i)}><span class="cmp-num"${over?' style="color:var(--risk)"':''}>${r.hire==null?'—':'A$'+fmtN(r.hire)}</span>${over?`<i class="cmp-over">${L('over budget','超预算')}</i>`:lo(best,'hire',i)?`<i class="cmp-best">${L('lowest','最少')}</i>`:''}</td>`;}).join('')}</tr>
    <tr><th scope="row">${L('Footpath','行人通道')}</th>${CP.rows.map((r,i)=>`<td${rc(i)}>${(r.flags||{}).footpath==='none'?L('kept','保留'):L('closed','封闭')}</td>`).join('')}</tr>
    <tr><th scope="row">${L('Choose','选定方案')}</th>${CP.rows.map((r,i)=>`<td${rc(i)}><button type="button" class="cmp-pickbtn" data-cmppick="${i}" aria-pressed="${CP.pick===i}" ${r.s?'':'disabled'}>${CP.pick===i?L('Chosen','已选择'):L('Choose','选择')}</button></td>`).join('')}</tr>
  </tbody></table><div class="cmp-cap">${su?L(`Traffic ${engHour(cmpSuHour())}–${engHour(cmpSuHour()+1)} weekday · SUMO on the real CBD network around the works · cars only${cmpSuSrc()?` · ${cmpSuSrc()}`:''} · hire over the works period${budget?` · budget A$${fmtN(budget)}`:''}`,`交通 ${engHour(cmpSuHour())}–${engHour(cmpSuHour()+1)} 工作日 · SUMO 在施工附近的真实 CBD 路网上算 · 只含机动车${cmpSuSrc()?` · ${cmpSuSrc()}`:''} · 租金按整个施工期${budget?` · 预算 A$${fmtN(budget)}`:''}`)
    :L(`Traffic ${engHour(EP.hour)}–${engHour(EP.hour+1)} · engine estimate on real CBD flows · hire over the works period${budget?` · budget A$${fmtN(budget)}`:''}`,`交通 ${engHour(EP.hour)}–${engHour(EP.hour+1)} · 引擎估算 · 真实 CBD 车流 · 租金按整个施工期${budget?` · 预算 A$${fmtN(budget)}`:''}`)}</div></div>`;
  if(exp&&!(CP.pick!=null&&CP.rows[CP.pick]))return head+`<div class="card eng-note"><b>${L('Choose a plan first','先选一套方案')}</b><span>${L('Pick one in 04 Compare, or here:','在 04 比较方案里选，或者直接在这里选：')}</span></div><div class="chips">${CP.rows.map((x,i)=>`<button type="button" data-cmppick="${i}" aria-pressed="false">${String.fromCharCode(65+i)} · ${esc(cmpLabel(x))}</button>`).join('')}</div><p class="cmp-lean" data-cmplean></p>`;
  const planNote=CP.src==='kits'?L('Plans: engine T22, three kits from the RPM inventory — cheapest (barriers and signs, no VMS) / standard (+ arrow board, two VMS giving the delay) / guided (+ arrow board, one VMS naming the fastest detour). ','方案：引擎 T22 按 RPM 库存配的三套 —— 最省（护栏 + 标志牌，没有 VMS）/ 标准（+ 箭头板、两块 VMS 报要堵几分钟）/ 引导（+ 箭头板、一块 VMS 点名最快的绕行）。'):L('Plans: your plan + the advisor’s alternatives. ','方案：现在的方案 + 顾问的改法。');
  let h=head+`${exp?`<div class="cmp-cards">${cardsA[CP.pick]}</div>`:table}<p class="cmp-lean" data-cmplean></p><p class="legend-src" data-cmpdecide></p>
    <p class="legend-src">${planNote}${su?L('Traffic numbers: SUMO, on the real CBD network around the works (cars only). The engine works behind the scenes: it only reads each plan’s signs into the share of drivers who detour, which is SUMO’s input. Hire: RPM inventory × day rate × works days — day rates and stock are assumptions, RPM Hire’s formal quote applies.','交通数字：SUMO 在施工附近的真实 CBD 路网上算（只有小汽车）。引擎退到幕后：只把每套方案的牌读成「会绕行的司机」比例，作为 SUMO 的输入。租金：RPM 库存 × 日租价 × 施工天数 —— 日租价和库存件数是假设值，以 RPM Hire 正式报价为准。')
      :L(`Car, tram & bus and on-foot numbers: engine estimate, this hour (${engHour(EP.hour)}), person- or vehicle-minutes. Hire: RPM inventory × day rate × works days — day rates and stock are assumptions, RPM Hire’s formal quote applies.`,`车、电车公交、行人：引擎估算的这一小时（${engHour(EP.hour)}），单位是车·分钟或人·分钟。租金：RPM 库存 × 日租价 × 施工天数 —— 日租价和库存件数是假设值，以 RPM Hire 正式报价为准。`)}</p>`;
  if(exp&&CP.pick!=null&&CP.rows[CP.pick]){
    h+=`<div class="stack cmp-choose"><div class="between cmp-head"><span class="eyebrow">${L('Decision','决定')} · ${String.fromCharCode(65+CP.pick)}</span><span class="eyebrow">${L('a person decides, not the tool','由人拍板，工具只给数字')}</span></div>
      <div class="chips">${[['contractor',L('Contractor','施工方')],['council',L('Council','市政')]].map(([k,t])=>`<button type="button" data-cmpby="${k}" aria-pressed="${CP.by===k}">${t}</button>`).join('')}</div>
      <textarea id="cmpReason" rows="2" maxlength="280" aria-label="${L('Why this plan','为什么选这套')}" placeholder="${L('Why this plan? e.g. shortest queue, trams keep running','为什么选这套？例如排队最短、电车照常运行')}"></textarea>
      <button type="button" class="btn" id="cmpExport" ${CP.mod&&CP.inv?'':'disabled'}>${L('Export one-page pack →','导出一页执行包 →')}</button>
      ${CP.invErr?`<p class="small" style="color:var(--risk)">${L('Equipment inventory not loaded — the pack needs it for the equipment list and hire quote.','设备库存没加载上 —— 执行包要用它列设备清单和报价。')}</p>`:''}</div>`;
  }
  if(exp){const row=(t,ok)=>`<div><i class="dot" style="background:${ok?'var(--accent)':'var(--works)'}"></i><span class="grow">${t}</span></div>`;
    h+=`<div class="stack"><div class="row between"><span class="eyebrow">${L('Before handing over','交付前确认')}</span><span class="eyebrow">${L('a person signs off','由人确认')}</span></div><div class="list eng-evd">
      ${row(su?L(`Traffic numbers: SUMO, weekday ${engHour(cmpSuHour())}, real CBD network around the works — model estimates of car traffic, not field-validated`,`交通数字：SUMO 在施工附近的真实 CBD 路网上算的工作日 ${engHour(cmpSuHour())} —— 只算机动车的模型估算，未经实地验证`)
        :L(`Numbers: engine estimate, ${engHour(EP.hour)}, real CBD flows — model estimates, not field-validated`,`数字：引擎估算，真实 CBD 车流上的 ${engHour(EP.hour)} —— 模型估算，未经实地验证`),1)}
      ${row(L('Trust in signs, riders per trip and hire day rates are assumed values','对标志的信任度、每班乘客、日租价是假设值'),0)}
      ${row(L('Traffic management plan and site checks by the responsible engineer','交通组织方案和现场条件由负责工程师复核'),0)}</div></div>`;}
  return h;
}

function cmpRender(){
  const el=document.getElementById('cmp4');if(!el)return;
  cmpUpdate();cmpExplainUpdate();cmpClashUpdate();cmpSuUpdate();
  const h=cmpHTML();if(el.dataset.sig===h){cmpExplainRender(el);return;}el.innerHTML=h;el.dataset.sig=h;cmpExplainRender(el);compactPanel(); // filled in after the panel was laid out: let the folding see it
  el.querySelectorAll('[data-cmpwhat]').forEach(x=>{const r=CP.rows[+x.dataset.cmpwhat];x.textContent=r?cmpWhat(r):'';});
  el.querySelectorAll('[data-cmppick]').forEach(b=>b.onclick=()=>{CP.pick=+b.dataset.cmppick;cmpRender();});
  el.querySelectorAll('[data-cmpcol]').forEach(c=>c.onclick=()=>{const i=+c.dataset.cmpcol;if(CP.pick!==i&&CP.rows[i]&&CP.rows[i].s){CP.pick=i;cmpRender();}});
  el.querySelectorAll('[data-cmpby]').forEach(b=>b.onclick=()=>{CP.by=b.dataset.cmpby;cmpRender();});
  const ta=document.getElementById('cmpReason');if(ta){ta.value=CP.reason;ta.oninput=()=>{CP.reason=ta.value;};}
  const ex=document.getElementById('cmpExport');if(ex)ex.onclick=cmpExport;
  const re=el.querySelector('[data-cmpsure]');if(re)re.onclick=()=>{CP.su=null;cmpRender();}; // T49: SUMO options run again
}

// Chosen plan → pack.js execution pack → a print / copy sheet. Every string goes in with textContent.
function cmpExport(){
  const r=CP.rows[CP.pick];if(!r||!r.s||!CP.mod||!CP.inv)return;
  const ws=r.plan.worksites[0],lang=LANG.cur==='zh'?'zh':'en';let txt='',doc='';
  try{
    const impacts=CP.mod.ex.optionFromRun(r.id,'plan',r.s).metrics,su=suPlan();
    const p=CP.mod.pack.buildPack({...ws,title:ws.name,status:'decided',decision:{option:r.id,by:CP.by,reason:CP.reason.trim(),at:new Date().toISOString()}},{inventory:CP.inv,links:cmpLinks(ws),impacts});
    // T49: the SUMO plan's pack names who to notify (the engine still decides that behind the scenes) without the engine's numbers
    if(su){p.impacts=null;for(const n of p.notify||[])if(n&&n.why)for(const k of ['pax_min','blocked_pax_h','blocked_vph','peds_extra_min'])if(k in n.why)n.why[k]=null;}
    txt=CP.mod.pack.packText(p,lang)+`\n\n${L('Data sources','数据来源')}\n`+creditLines().map(s=>'- '+s).join('\n');
    if(typeof CP.mod.pack.packDoc==='function'){ // older pack.js (before packDoc) → plain text below
      const sn=su?cmpSuAll():null,rows=CP.rows.map((x,i)=>({id:x.id,label:cmpLabel(x),...(su?{car:sn[i]?sn[i].tot:null,transit:null,peds:null}:cmpNumbers(x.s)),hire:x.hire}));
      const d=CP.mod.pack.packDoc(p,lang);
      if(su){ // T49: the text pack gets the same SUMO footer; a notify line whose reason was only the engine's number says so
        if(d.foot)txt=txt.split(d.foot).join(cmpSuFoot(L));
        for(const n of d.notify||[])if(n&&!n.why)n.why=L('affected — impact not covered by SUMO','受影响 —— 影响 SUMO 暂不覆盖');}
      doc=cmpDocHTML(d,{rows,src:su?'sumo':'engine',pick:CP.pick,by:CP.by==='council'?L('Council','市政'):L('Contractor','施工方'),hour:engHour(su?cmpSuHour():EP.hour),date:new Date().toLocaleString(lang==='zh'?'zh-CN':'en-AU',{dateStyle:'medium',timeStyle:'short'}),credits:creditLines()},{L,esc,fmt:fmtN});
    }
  }catch(e){console.warn('export failed',e);toast(L('Could not build the pack','执行包生成失败'));return;}
  let sh=document.getElementById('cmpSheet');
  if(!sh){sh=document.createElement('div');sh.id='cmpSheet';sh.className='cmp-sheet';sh.setAttribute('role','dialog');sh.setAttribute('aria-modal','true');document.body.appendChild(sh);}
  sh.innerHTML=`<div class="cmp-doc"><div class="between no-print cmp-bar"><b>${L('Execution pack','执行包')}</b><span class="cmp-acts"><button type="button" class="btn ghost" id="cmpCopy">${L('Copy text','复制文字')}</button><button type="button" class="btn" id="cmpPrint">${L('Print / save PDF','打印 / 存 PDF')}</button><button type="button" class="btn ghost" id="cmpClose">${L('Close','关闭')}</button></span></div><div id="cmpPaper"></div></div>`;
  const paper=document.getElementById('cmpPaper');
  if(doc)paper.innerHTML=doc; // cmpDocHTML esc()s every string it is given
  else{const pre=document.createElement('pre');pre.id='cmpText';pre.textContent=txt;paper.appendChild(pre);}
  const close=()=>{sh.hidden=true;document.removeEventListener('keydown',esc1);};
  const esc1=e=>{if(e.key==='Escape')close();};
  document.addEventListener('keydown',esc1);
  document.getElementById('cmpClose').onclick=close;
  sh.onclick=e=>{if(e.target===sh)close();};
  document.getElementById('cmpPrint').onclick=()=>window.print();
  document.getElementById('cmpCopy').onclick=()=>{const done=()=>toast(L('Pack copied','已复制执行包'));try{navigator.clipboard.writeText(txt).then(done,()=>toast(L('Copy failed — select the text and copy it','复制失败 —— 请手动选中复制')));}catch(e){toast(L('Copy failed — select the text and copy it','复制失败 —— 请手动选中复制'));}};
  sh.hidden=false;document.getElementById('cmpClose').focus();
}
