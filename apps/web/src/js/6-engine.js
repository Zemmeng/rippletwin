'use strict';
/* ============================================================
   Engine wiring (T13, docs/hackathon/specs/T13-web-wiring-PRD.md): the plan on the real CBD network → /engine/public/js/backend.js
   → numbers the panel shows (queue, detour split, per-type delay, advisor, before / after).
   Backend not reachable (file://, a static server that only serves apps/web/public, offline) → BE.err is set and
   the panel says there are no numbers to show (no preset numbers). No other host is ever contacted.
   ============================================================ */

/* pure:begin — tests/test_engine.py runs this block in node */
// Real lat/lon → page world metres (x east, y north along the Hoddle grid). Least-squares affine on the 24 main-grid
// intersections Queen…Exhibition × Bourke…La Trobe in /roads/public/cbd/network.json (max error 1.4 m). North of La Trobe
// the page draws its blocks taller than real: Little La Trobe 55 m → 100, A'Beckett 109 m → 200.
const GEO_X=[71450.68617987254,32740.96975681178,-9119842.750837393],GEO_Y=[-26214.61073382881,89740.68366610732,7193228.539331512];
function geoToWorld(lat,lon){const x=GEO_X[0]*lon+GEO_X[1]*lat+GEO_X[2],v=GEO_Y[0]*lon+GEO_Y[1]*lat+GEO_Y[2];return[x,v<=0?v:v<55?v*100/55:v<109?100+(v-55)*100/54:200+(v-109)*100/54];}
// Streets a work zone can't sit on (same list the engine won't detour through)
const NO_WORKS=new Set(['living_street','pedestrian','service','track','footway','cycleway','path']);
function linkPts(l){const g=l&&l.geometry;if(!Array.isArray(g)||g.length<2)return null;return g.map(p=>geoToWorld(p[0],p[1]));}
// Compass letter of a link's direction of travel on the page grid
function dirOf(P){const dx=P[P.length-1][0]-P[0][0],dy=P[P.length-1][1]-P[0][1];return Math.abs(dx)>=Math.abs(dy)?(dx>=0?'E':'W'):(dy>=0?'N':'S');}
// Nearest link to world point (x, y) within tol metres. cands = [{ id, pts, hw }].
// A two-way street is two links on one line; traffic keeps left, so a click left of a link's direction of travel picks that link.
function pickLink(cands,x,y,tol){
  let best=null,bs=Infinity;
  for(const c of cands){
    if(!c.pts||NO_WORKS.has(c.hw))continue;const P=c.pts;
    for(let i=0;i<P.length-1;i++){
      const ax=P[i][0],ay=P[i][1],dx=P[i+1][0]-ax,dy=P[i+1][1]-ay,L2=dx*dx+dy*dy||1e-9;
      let t=((x-ax)*dx+(y-ay)*dy)/L2;t=t<0?0:t>1?1:t;
      const d=Math.hypot(ax+t*dx-x,ay+t*dy-y);if(d>tol)continue;
      const sc=d+(dx*(y-ay)-dy*(x-ax)>0?0:3);
      if(sc<bs){bs=sc;best=c.id;}
    }
  }
  return best;
}
// One VMS frame from a textarea: one line per row, upper case, single spaces, blank rows dropped
function parseFrame(text){return String(text||'').toUpperCase().split('\n').map(s=>s.trim().replace(/\s+/g,' ')).filter(Boolean);}
const WORKS_TIME={from:'2026-10-05',to:'2026-10-09',hours:[7,19]};
// Page state → the plan the engine takes (docs/reference/interfaces.md §Worksite plan). An empty VMS / sign is left out, not sent blank.
function planFrom(ep){
  const frames=[parseFrame(ep.f1),parseFrame(ep.f2)].filter(f=>f.length),eq=[];
  if(frames.length)eq.push({id:'VMS-1',type:'vms',at_m:ep.vmsAt,frames});
  const sign=String(ep.sign||'').toUpperCase().trim().replace(/\s+/g,' ');
  if(sign)eq.push({id:'S-1',type:'sign',at_m:ep.signAt,text:sign});
  eq.push({id:'A-1',type:'arrow',at_m:ep.arrowAt},{id:'B-1',type:'barrier',at_m:0});
  const tm=ep.time||WORKS_TIME;
  const closes={lanes:ep.lanes};if(ep.foot==='left'||ep.foot==='right'||ep.foot==='both')closes.footpath=ep.foot; // absent = footpath open
  return{when:{date:'2026-10-06',hour:ep.hour},worksites:[{id:'W-1',name:`${ep.street||'Road'} lane closure`,links:[ep.link],closes,
    time:{from:tm.from,to:tm.to,hours:[tm.hours[0],tm.hours[1]]},equipment:eq}]};
}
// A whole plan (e.g. an advisor option) → the form fields planFrom() reads. By type, not id: the advisor adds a VMS of
// its own (id vms-new) when the plan had none. Only fields the plan has are returned.
function formFromPlan(plan){
  const ws=plan&&plan.worksites&&plan.worksites[0],out={};if(!ws)return out;const eq=ws.equipment||[];
  const vms=eq.find(e=>e.id==='VMS-1')||eq.find(e=>e.type==='vms');
  if(vms){out.vmsAt=vms.at_m;out.f1=(vms.frames&&vms.frames[0]||[]).join('\n');out.f2=(vms.frames&&vms.frames[1]||[]).join('\n');}
  const sign=eq.find(e=>e.id==='S-1')||eq.find(e=>e.type==='sign');if(sign){out.signAt=sign.at_m;out.sign=sign.text||'';}
  const arrow=eq.find(e=>e.type==='arrow');if(arrow)out.arrowAt=arrow.at_m;
  if(ws.time)out.time={from:ws.time.from,to:ws.time.to,hours:[ws.time.hours[0],ws.time.hours[1]]};
  if(ws.closes)out.foot=ws.closes.footpath||'none';
  return out;
}
// Page units per real metre: geoToWorld() draws 1 m of the Hoddle grid as ~0.862 units (network.json south of La Trobe:
// east–west 0.8645, north–south 0.8600). The scale bar and anything given in metres go through it (T27)
const K_UPM=0.862;
const unitV=(a,b)=>{const dx=b[0]-a[0],dy=b[1]-a[1],l=Math.hypot(dx,dy)||1;return[dx/l,dy/l];};
// Links by the node they end at — upstreamPath() walks it
function upstreamIndex(links){const m=new Map();for(const l of links){const a=m.get(l.to);if(a)a.push(l);else m.set(l.to,[l]);}return m;}
// The queue's road (T27): from the works link's start, walk upstream along links of the same street (the one that carries on
// straightest), adding their real length len_m, until maxM metres or the street runs out in the network. pts = page points
// from the works start going upstream; cum = metres at each point; reach = metres the street allows (the sum of the links'
// len_m); end = the cross street where it runs out (null if it didn't). A line drawn on it is never longer than those links.
function upstreamPath(byTo,link,maxM){
  const P0=linkPts(link);if(!P0)return{pts:[],cum:[],reach:0,end:null,ids:[]};
  const pts=[P0[0]],cum=[0],ids=[];let cur=link,m=0,dir=unitV(P0[0],P0[P0.length-1]),ran=true;
  for(let guard=0;m<maxM&&guard<80;guard++){
    const ups=(byTo.get(cur.from)||[]).filter(u=>u.name===link.name&&u.from!==cur.to&&u.id!==cur.id);
    let U=null,best=0,G=null;
    for(const u of ups){const g=linkPts(u);if(!g)continue;const d=unitV(g[0],g[g.length-1]),dot=d[0]*dir[0]+d[1]*dir[1];if(dot>best){best=dot;U=u;G=g;}}
    if(!U){ran=false;break;} // no same-street link carrying on: the street ends here in the network
    let tot=0;for(let i=1;i<G.length;i++)tot+=Math.hypot(G[i][0]-G[i-1][0],G[i][1]-G[i-1][1]);
    let acc=0;for(let i=G.length-1;i>0;i--){acc+=Math.hypot(G[i][0]-G[i-1][0],G[i][1]-G[i-1][1]);pts.push(G[i-1]);cum.push(m+(tot?acc/tot:1)*(+U.len_m||0));}
    m+=+U.len_m||0;ids.push(U.id);dir=unitV(G[0],G[G.length-1]);cur=U;
  }
  let end=null;if(!ran)for(const u of byTo.get(cur.from)||[])if(u.name&&u.name!==link.name){end=u.name;break;}
  return{pts,cum,reach:m,end,ids}; // ids: the links walked, whose len_m add up to reach
}
// Links drawn as this plan's ripple (T27 + T28): ≥ 2 vehicle-minutes over the same hour without the works (extra_min), not the
// works link itself. sev 2 = red (a queue on it, or ≥ 60), 1 = amber (≥ 10), 0 = faint. Background queues (Flinders / King St
// every morning) have extra_min ≈ 0 and are left out, however long they are against free flow
function rippleLinks(links,worksId){const out=[];for(const l of links||[]){const ex=+l.extra_min;if(!(ex>=2)||l.id===worksId)continue;out.push({id:l.id,ex,sev:ex>=60?2:ex>=10?1:0});}return out;}
// Point m metres up the path (clamped to its end), and the path from the works start to that point
function pathAt(p,m){const{pts,cum}=p;if(!pts.length)return null;if(m<=0)return pts[0];for(let i=1;i<pts.length;i++)if(cum[i]>=m){const t=(m-cum[i-1])/((cum[i]-cum[i-1])||1);return[pts[i-1][0]+(pts[i][0]-pts[i-1][0])*t,pts[i-1][1]+(pts[i][1]-pts[i-1][1])*t];}return pts[pts.length-1];}
function pathSub(p,m){const out=[p.pts[0]];for(let i=1;i<p.pts.length&&p.cum[i]<m;i++)out.push(p.pts[i]);const e=pathAt(p,m);if(e&&out.length&&(e[0]!==out[out.length-1][0]||e[1]!==out[out.length-1][1]))out.push(e);return out;}
/* pure:end */

const BE={api:null,err:null};
const EP={preset:'lonsdale',link:null,pts:null,street:null,dir:null,lanes:1,lanesMax:1,all:false,hour:8,time:null,
  f1:'ROADWORK\nAHEAD',f2:'',vmsAt:300,sign:'RIGHT LANE CLOSED',signAt:100,arrowAt:60,foot:'none',walkGeo:null,walkLoading:false,
  sum:null,busy:false,seq:0,runErr:null,checks:[],badText:false,tab3:'net',view3:'traffic',tab1:'site',budget:3500,keep:{foot:true,transit:true,emerg:true},mix:null,idx:null,alts:[],altsKey:'',
  adv:null,advKey:'',advBusy:false,pick:-1,cmp:null,cmpKey:'',cmpBusy:false};
BE.ready=import('/engine/public/js/backend.js')
  .then(m=>m.connect()) // road network + flows + T12 parameters + T5 sign reader + engine, loaded once
  .then(api=>{BE.api=api;console.info('backend ready',api.status());})
  .catch(e=>{BE.err=e;console.warn('backend not connected, no engine numbers',e);})
  .then(engAfterConnect);

const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtN=n=>Math.round(Number(n)||0).toLocaleString('en-AU');
const pctS=x=>`${Math.round((Number(x)||0)*100)}%`;
const engHour=h=>`${String(h).padStart(2,'0')}:00`;
// T48: the engine's queue is where its point queue stands at the END of the scored hour (D/D/1 over 60 min): 08:00 → "09:00"
const engEndH=s=>engHour((clamp(Math.floor(+(s&&s.when?s.when.hour:EP.hour)||0),0,23)+1)%24);
const shortSt=n=>String(n||'').replace(/ Street\b/,' St');
const TYPES4=['commuter','local','tourist','delivery'];
const TYPE_L={commuter:['Commuters','通勤者'],local:['Locals','本地人'],tourist:['Visitors','游客'],delivery:['Delivery','送货车']};
const TYPE_C={commuter:'var(--a-car)',local:'var(--a-tram)',tourist:'var(--a-ped)',delivery:'var(--a-bus)'};
const DIR_L={N:['northbound','北行'],S:['southbound','南行'],E:['eastbound','东行'],W:['westbound','西行']};
const dirL=d=>DIR_L[d]?L(DIR_L[d][0],DIR_L[d][1]):'';
const cap=t=>t?t[0].toUpperCase()+t.slice(1):'';
const engNet=()=>BE.api&&BE.api.engine&&BE.api.engine.net;
const engOn=()=>!!(BE.api&&EP.link);

/* ---------- connect, presets, links ---------- */
function engAfterConnect(){
  try{
    if(BE.api){
      engPreset(EP.preset,true);
      import('/engine/public/js/index.js').then(m=>{EP.idx=m;EP.altsKey='';if(EP.sum&&!EP.badText){engAlts(planFrom(EP),EP.sum);if(S.booted&&S.step===3&&EP.tab3==='net')engFly(.6);}}).catch(()=>{}); // same module backend.js already loaded: detour paths for the map
      fetch('/params/public/params.json').then(r=>r.ok?r.json():null).then(p=>{if(p&&p.mix){EP.mix=p.mix;if(S.booted&&S.step===3)renderPanel();}}).catch(()=>{});
    }
    if(S.booted){renderPanel();if(S.step===1||(S.step===3&&EP.tab3==='net'))engFly(.9);if(S.step===4)engStep4();}
    if(BE.api)engRun();
  }catch(e){BE.err=BE.err||e;console.warn('engine wiring failed, no engine numbers',e);}
}
// The two demo plans backend.js ships (lonsdale = main demo, 08:00 queue; latrobe = this junction, 17:00, barely queues)
function engPreset(name,quiet){
  const d=BE.api.demo(name),ws=d.worksites[0];EP.preset=name;EP.hour=d.when.hour;EP.all=false;
  const s=ws.equipment.find(e=>e.type==='sign');if(s&&!EP.sign)EP.sign=s.text;
  engSetLink(ws.links[0]);if(!quiet)engChanged(0);
}
function engSetLink(id){
  const net=engNet(),l=net&&net.links.get(id),pts=linkPts(l);if(!pts)return false;
  EP.link=id;EP.pts=pts;EP.street=l.name||'';EP.dir=dirOf(pts);EP.lanesMax=Math.max(1,l.lanes||1);EP.lanes=EP.all?EP.lanesMax:1;
  // everything computed for the previous street is void (else its queue / detours get drawn on this one)
  EP.sum=null;EP.runErr=null;EP.alts=[];EP.altsKey='';EP.adv=null;EP.advKey='';EP.cmp=null;EP.cmpKey='';EP.pick=-1;
  return true;
}
// Advisor / compare hand back whole plans: copy the worksite's equipment and dates back into the form
function engLoadPlan(plan){Object.assign(EP,formFromPlan(plan));}
let candCache=null;
function engCands(){
  const net=engNet();if(!net)return[];if(candCache&&candCache.net===net)return candCache.list;
  const list=[];for(const l of net.links.values()){const pts=linkPts(l);if(!pts)continue;if(pts.every(p=>p[0]<CITY.x0||p[0]>CITY.x1||p[1]<CITY.y0||p[1]>CITY.y1))continue;list.push({id:l.id,pts,hw:l.highway});}
  candCache={net,list};return list;
}
const geoCache=new Map();
function engGeo(id){if(geoCache.has(id))return geoCache.get(id);const net=engNet(),pts=net?linkPts(net.links.get(id)):null;geoCache.set(id,pts);return pts;}

/* ---------- run: check on every keystroke, engine after a pause ---------- */
let engTimer=0;
function engChanged(ms){engCheckNow();clearTimeout(engTimer);engTimer=setTimeout(engRun,ms==null?350:ms);}
function engCheckNow(){
  if(!engOn())return;let c=[];
  try{c=BE.api.check(planFrom(EP));}catch(e){c=[{ok:false,error:{code:'check_threw',msg:String(e&&e.message||e)},warnings:[]}];}
  EP.checks=c;EP.badText=c.some(x=>!x.ok);engRenderCheck();
}
async function engRun(){
  if(!engOn())return;
  engCheckNow();const seq=++EP.seq;
  if(EP.badText){EP.busy=false;engRenderOut();return;} // PRD §3: text that breaks the sign rules never goes to run()
  EP.busy=true;engRenderOut();
  const plan=planFrom(EP);
  const first=!EP.sum; // first numbers for this street: frame its queue and detours too (T20 addendum 1)
  try{const s=await BE.api.run(plan);if(seq!==EP.seq)return;EP.sum=s;EP.runErr=null;engAlts(plan,s);if(first&&(S.step===1||(S.step===3&&EP.tab3==='net')))engFly(.7);}
  catch(e){if(seq!==EP.seq)return;EP.runErr=e;console.warn('engine run failed',e);}
  EP.busy=false;engRenderOut();vlAfterRun();
  if(S.step===3)renderPanel();
  if(S.step===2)gridRebuild(); // 2×2 grid sim follows the plan (works link, lanes, hour)
  if(S.step===4)engStep4();
}
async function engStep4(){
  if(!engOn()||EP.badText){EP.adv=null;EP.advKey='';EP.advBusy=false;EP.cmp=null;EP.cmpKey='';EP.cmpBusy=false;EP.pick=-1;engRender4();return;}
  const plan=planFrom(EP),key=JSON.stringify(plan);
  if(EP.advKey!==key){
    EP.advKey=key;EP.adv=null;EP.cmp=null;EP.cmpKey='';EP.pick=-1;EP.advBusy=true;engRender4();
    let a=null;try{a=await BE.api.advise(plan);}catch(e){console.warn('advisor failed',e);}
    if(EP.advKey!==key)return;
    if(!a)EP.advKey=''; // let the next visit retry
    EP.adv=a;EP.advBusy=false;EP.pick=a&&a.flags.ok?a.options.findIndex(o=>o.better&&o.plan&&!o.skipped&&o.kind!=='shift'):-1; // untrusted savings: don't pre-pick
  }
  await engCompare();
}
async function engCompare(){
  const plan=planFrom(EP),o=EP.adv&&EP.adv.options[EP.pick],key=JSON.stringify(plan)+'|'+EP.pick;
  if(EP.badText||EP.advKey!==JSON.stringify(plan)){EP.cmp=null;EP.cmpKey='';EP.cmpBusy=false;engRender4();return;} // PRD §3: never score invalid or stale text
  if(!o||!o.plan||o.kind==='shift'){EP.cmp=null;EP.cmpKey=key;EP.cmpBusy=false;engRender4();return;} // a date shift only shows over the whole works period
  if(EP.cmpKey===key&&EP.cmp){engRender4();return;}
  EP.cmpKey=key;EP.cmp=null;EP.cmpBusy=true;engRender4();
  let c=null;try{c=await BE.api.compare(plan,o.plan);}catch(e){console.warn('compare failed',e);}
  if(EP.cmpKey!==key)return;EP.cmp=c;EP.cmpBusy=false;engRender4();
}
function engApply(){
  const o=EP.adv&&EP.adv.options[EP.pick];if(!o||!o.plan)return;
  engLoadPlan(o.plan);toast(L('Advisor change applied to the plan','已把顾问的改法用到方案上'));
  EP.advKey='';engRun();
}

/* ---------- panel pieces ---------- */
function engStatusPill(){return BE.api?`<span class="pill ok">${L('Live engine','引擎实时')}</span>`:BE.err?`<span class="pill warn">${L('Engine offline','引擎未连接')}</span>`:`<span class="pill">${L('Connecting…','连接中…')}</span>`;}
function engOfflineCard(){
  return BE.err?`<div class="card eng-note warn"><b>${L('Engine offline — no numbers to show','引擎未连接 —— 暂时没有数字')}</b><span>${L('Open the page from the site (same address as /engine/ and /roads/) to get engine numbers.','从部署网址打开（和 /engine/、/roads/ 同一个地址）才能拿到引擎的数字。')}</span></div>`
    :`<div class="card eng-note"><b>${L('Loading the CBD road network and engine…','正在加载 CBD 路网和引擎…')}</b><span>${L('1,513 road links · real hourly flows · about a second','1513 个路段 · 真实逐时车流 · 大约一秒')}</span></div>`;
}
// Where the numbers come from (PRD §5): yellow when they shouldn't be taken at face value
function engBadges(f,s){
  if(!f)return'';const b=[];
  if(!f.ok)b.push(`<span class="pill warn" title="${esc(L('Missing readings, calibration miss, sign-rule error or a full closure with no way round','读数没拿到、校准没命中、屏上文字不合规范，或全封又无路可绕'))}">${L('Check inputs','输入待核')}</span>`);
  if(f.inactive)b.push(`<span class="pill warn">${L('No works this hour','此时段不施工')}</span>`);
  if(f.blocked_vph>0)b.push(`<span class="pill risk">${fmtN(f.blocked_vph)} ${L('veh/h stuck','辆/时 无路可走')}</span>`);
  const rs=aiPlanSrc(s,f); // this plan's persona readings, not the calibration anchors in f.reading_src (9-ai.js)
  b.push(`<span class="pill ${rs.tone}">${L('Sign reading','读屏')} · ${esc(aiSrcLabel(rs.src))}</span>`);
  b.push(f.params==='params'?`<span class="pill">${L('Parameters · T12 (trust is assumed)','参数 · T12（信任度是假设值）')}</span>`:`<span class="pill warn">${L('Parameters are assumptions','参数为假设值')}</span>`);
  return`<div class="chips eng-badges">${b.join('')}</div>`;
}
// Worst queue anywhere this hour: on the closed street, or (full closure) on the streets the detours pile onto
function engWorstQ(s){let q={m:s.queue_m||0,name:s.street};for(const h of s.hot||[])if((h.queue_m||0)>q.m)q={m:h.queue_m,name:h.name};return q;}
const engFull=s=>(s.detour_share||0)>=.99||(s.blocked_vph||0)>0;
function engMetrics(s){
  const top=s.routes.filter(r=>r.id!=='stay').sort((a,b)=>(b.share||0)-(a.share||0))[0],q=engWorstQ(s),elsewhere=q.m>(s.queue_m||0);
  return`<div class="metrics">
    <div class="metric"><span class="eyebrow">${elsewhere?L('Worst queue','最长排队'):L('Queue','排队')}</span><div class="v" style="color:${q.m>0?'var(--risk)':engFull(s)?'var(--fg)':'var(--accent)'}">${fmtN(q.m)}<small>m${elsewhere?' · '+esc(shortSt(q.name)):''}</small></div></div>
    <div class="metric"><span class="eyebrow">${L('Extra per vehicle','每车多等')}</span><div class="v" style="color:var(--works)">+${fmtN(s.mean_delay_s)}<small>s · ${L('main approach','主进口道')} ${fmtN(s.vehicles)} ${L('veh/h','辆/时')}</small></div></div>
    <div class="metric"><span class="eyebrow">${L('Detouring','绕行')}</span><div class="v">${pctS(s.detour_share)}<small>${top?esc(shortSt(top.name))+' '+pctS(top.share):''}</small></div></div>
    <div class="metric"><span class="eyebrow">${L('Network delay','全网延误')}</span><div class="v">${fmtN(s.delay_min)}<small>${L('veh·min / h','车·分钟 / 时')}</small></div></div></div>`;
}
// T20 addendum 5: what the detour share rests on, and why there is a queue (demand vs capacity past the works)
function engInformed(s){const a=s.approaches&&s.approaches[s.main];if(!a)return null;let v=0,n=0;for(const t of TYPES4){const k=(s.by_type[t]||{}).vehicles||0,x=a.by_type&&a.by_type[t];if(!x||!k)continue;v+=k*(x.informed||0);n+=k;}return n?v/n:null;}
function engWhy(s){
  const l=((s.raw&&s.raw.links)||[]).find(x=>x.id===EP.link),inf=engInformed(s),st=esc(shortSt(EP.street)),ap=s.approaches&&s.approaches[s.main],out=[];
  // total flow still using the works section (after detours) against what fits past it: the gap is the queue
  if(l&&l.cap>0&&l.v>0){const over=l.v>l.cap;out.push(L(`${st}: ${fmtN(l.v)} veh/h arrive, ${fmtN(l.cap)} veh/h get past${over?' → the rest queue':' → no queue'}.`,`${st}：来车 ${fmtN(l.v)} 辆/时，只能过 ${fmtN(l.cap)} 辆/时${over?' → 多出的排队':' → 不排队'}。`));}
  // full closure: nothing fits past the works (cap 0) — say where the queue comes from instead of dropping the line (T26 2.5)
  else if(EP.all||(l&&l.cap===0)){const vol=ap&&ap.volume>0?fmtN(ap.volume)+' ':'';out.push(L(`${st} fully closed: ${vol}veh/h must detour${s.blocked_vph>0?` (${fmtN(s.blocked_vph)} veh/h have no way round)`:''} → queues on the detour streets.`,`${st} 施工段全封：${vol}辆/时全部绕行${s.blocked_vph>0?`（${fmtN(s.blocked_vph)} 辆/时无路可绕）`:''} → 排队出在绕行的街上。`));}
  // inf = the share who read and understand the sign — not who obey it. Whether they turn is the route-choice model's call, and
  // how far drivers trust signs has no source yet (T12 sign_trust is null): an assumed value (D-0929-1536)
  out.push(L(`${inf!=null?`${pctS(inf)} of drivers understand the sign · `:''}${pctS(s.detour_share)} detour (route-choice model; trust in signs is an assumed value).`,`${inf!=null?`${pctS(inf)} 的司机读懂屏上的字 · `:''}${pctS(s.detour_share)} 绕行（路线选择模型算；对标志的信任度是假设值）。`));
  return`<div class="eng-assume">${out.map(t=>`<p>${t}</p>`).join('')}</div>`;
}
const MODE_L={tram:['Tram','电车'],bus:['Bus','公交']};
const hasTransit=s=>!!(s&&s.transit&&s.transit.src);
const hasPeds=s=>!!(s&&s.peds&&s.peds.src);
// One line each for trams / buses and people on foot, under the car numbers
function engImpacts(s){
  const rows=[];
  if(hasTransit(s)){
    const t=s.transit,n=(t.routes||[]).length;
    if(!n)rows.push(['var(--a-bus)',L('No tram or bus route uses the affected streets','没有电车 / 公交线路经过受影响的路段'),'']);
    else rows.push([t.blocked_routes>0?'var(--risk)':'var(--a-bus)',L(`${n} tram/bus route${n===1?'':'s'} · ${fmtN(t.trips_h)} trips/h · ${fmtN(t.pax_h)} riders/h`,`${n} 条电车 / 公交线 · 每小时 ${fmtN(t.trips_h)} 班 · ${fmtN(t.pax_h)} 名乘客`),
      t.blocked_routes>0?L(`${t.blocked_routes} blocked`,`${t.blocked_routes} 条停运`):`+${fmtN(t.pax_min)} ${L('rider·min','人·分钟')}`]);
  }
  if(hasPeds(s)){
    const p=s.peds;
    if(p.footpath==='none'||!(p.closed||[]).length)rows.push(['var(--a-ped)',L('Footpath stays open','人行道照常通行'),'']);
    else if(p.blocked)rows.push(['var(--risk)',L(`${fmtN(p.ped_h)} people/h on the closed footpath — no way round`,`封闭的人行道上每小时 ${fmtN(p.ped_h)} 人 —— 无路可绕`),L('blocked','走不通')]);
    else rows.push(['var(--a-ped)',L(`${fmtN(p.ped_h)} people/h walk round · +${fmtN(p.detour_m)} m each${p.crossings?` · ${p.crossings} extra crossing${p.crossings===1?'':'s'}`:''}`,`每小时 ${fmtN(p.ped_h)} 人绕行 · 每人多走 ${fmtN(p.detour_m)} 米${p.crossings?` · 多过 ${p.crossings} 次马路`:''}`),`+${fmtN(p.extra_min)} ${L('ped·min','人·分钟')}`]);
  }
  if(!rows.length)return'';
  return`<div class="list eng-impacts">${rows.map(([c,t,v])=>`<div><i class="dot" style="background:${c}"></i><span class="grow">${t}</span>${v?`<span class="val">${v}</span>`:''}</div>`).join('')}</div>`;
}
function engOutHTML(){
  if(!BE.api)return engOfflineCard();
  if(!EP.link)return`<div class="card eng-note warn"><b>${L('Click a street on the map to place the work zone','在地图上点一条街来放施工区')}</b></div>`;
  if(EP.runErr&&!EP.sum)return`<div class="card eng-note warn"><b>${L('The engine could not score this plan','引擎算不了这个方案')}</b><span>${esc(EP.runErr.message||EP.runErr)}</span></div>`;
  const s=EP.sum;if(!s)return`<div class="card eng-note"><b>${L('Calculating…','计算中…')}</b></div>`;
  const stale=EP.busy||EP.badText||!!EP.runErr;
  return`<div class="eng-out${stale?' stale':''}">${EP.runErr&&!EP.badText?`<p class="small" style="color:var(--risk)">${L('The engine could not score the latest change — these numbers are from before it.','引擎算不了最新的改动 —— 下面是改之前的数字。')} ${esc(EP.runErr.message||EP.runErr)}</p>`:''}${EP.badText?`<p class="small" style="color:var(--risk)">${L('Fix the sign text to update the numbers.','把屏上文字改合规范，数字才会更新。')}</p>`:''}${engMetrics(s)}</div>`;
}
// Step 1, under the sign text: why there is a queue, trams / people on foot, where the numbers come from (T26 2.3)
function engMoreHTML(){
  if(typeof sumo3More==='function'&&sumoPlanOn())return sumo3More(); // SUMO plan: no engine flows or minutes, only the AI sign reading (6e-sumo3.js)
  const s=BE.api&&EP.link?EP.sum:null;if(!s)return'';
  const stale=EP.busy||EP.badText||!!EP.runErr;
  return`<div class="eng-out${stale?' stale':''}">${engWhy(s)}${engImpacts(s)}${engBadges(s.flags,s)}${s.flags.inactive?`<p class="small muted">${L(`Works run ${engHour(WORKS_TIME.hours[0])}–${engHour(WORKS_TIME.hours[1])}; at ${engHour(s.when.hour)} nothing is closed.`,`施工时段 ${engHour(WORKS_TIME.hours[0])}–${engHour(WORKS_TIME.hours[1])}；${engHour(s.when.hour)} 没有封路。`)}</p>`:''}</div>`;
}
function engRenderOut(){for(const[id,f]of[['engOut',engOutHTML],['engMore',engMoreHTML],['engState',engStateHTML]]){const el=document.getElementById(id);if(!el)continue;const h=f();if(el.dataset.sig!==h){el.innerHTML=h;el.dataset.sig=h;}}}
// T5's check messages are Chinese (PRD §3): English mode maps the code and keeps the quoted line
const CHECK_EN={line_too_long:'A line is longer than 10 characters',too_many_lines:'A frame has more than 4 lines',too_many_frames:'Only 2 frames fit on the sign',
  too_many_words:'More than 8 words in total',bad_chars:'Use A–Z, 0–9 and basic punctuation only',empty_frame:'A frame is empty',empty_sign:'The sign is empty',
  many_lines:'More than 3 lines per frame is hard to read',long_line:'Lines over 8 characters are hard to read',frames_too_fast:'Not enough time to read both frames at this speed',
  short_read:'Too many words to read at this speed',odd_abbrev:'Non-standard abbreviation — visitors may not get it',check_threw:'The sign check failed'};
function checkMsg(code,msg){if(LANG.cur==='zh'||!CHECK_EN[code])return msg||code;const q=/「([^」]*)」/.exec(msg||'');return CHECK_EN[code]+(q?`: “${q[1]}”`:'');}
function engRenderCheck(){
  const el=document.getElementById('engCheck');if(!el)return;
  const rows=[];
  for(const c of EP.checks||[]){if(!c.ok&&c.error)rows.push(['err',checkMsg(c.error.code,c.error.msg)]);for(const w of c.warnings||[])rows.push(['warn',checkMsg(w.code,w.msg)]);}
  const h=rows.map(([k,m])=>`<div class="eng-msg ${k}">${k==='err'?'✕':'!'} ${esc(m)}</div>`).join('');
  if(el.dataset.sig!==h){el.innerHTML=h;el.dataset.sig=h;}
}

// Step 1: the plan form. Every change re-checks the sign text at once and re-runs the engine after a pause
function engPanel1(){if(!BE.api)return engOfflineCard();return engSiteHTML()+engOutSec()+engSignsHTML()+'<div id="engMore" class="stack eng-more"></div>';}
// 01 Configure (6-step UI): Site tab = where / when / how much is closed; Signs tab = VMS + sign; both show the live figures
function engSiteHTML(){
  const presets=[['lonsdale',L('Lonsdale St · 08:00','Lonsdale St · 08:00')],['latrobe',L('La Trobe St · 17:00','La Trobe St · 17:00')]];
  return`<div class="stack"><div class="row between"><span class="eyebrow">${L('Work zone','施工区')}</span><span class="eyebrow">${L('click a street to move it','点地图上的街可以挪')}</span></div>
    <div class="chips">${presets.map(([k,t])=>`<button type="button" data-preset="${k}" aria-pressed="${EP.preset===k}">${t}</button>`).join('')}${EP.preset==='custom'?`<button type="button" aria-pressed="true">${L('Picked on map','地图上选的')}</button>`:''}</div>
    <div class="row eng-zone"><i class="sw" style="background:var(--works)"></i><span class="grow"><b>${esc(EP.street||L('Unnamed road','无名道路'))}</b> · ${dirL(EP.dir)}</span></div>
    <div class="opt-rows">
    <div class="opt-row"><span class="opt-k">${L('Lanes','车道')}</span><div class="chips">${[[false,L('1 lane','封 1 条道')],[true,L('All lanes','全封')]].map(([v,t])=>`<button type="button" data-all="${v}" aria-pressed="${EP.all===v}">${t}</button>`).join('')}</div></div>
    <div class="opt-row"><span class="opt-k">${L('Hour','时段')}</span><div class="chips">${[7,8,12,17].map(h=>`<button type="button" data-hour="${h}" aria-pressed="${EP.hour===h}">${engHour(h)}</button>`).join('')}</div></div>
    <div class="opt-row"><span class="opt-k">${L('Footpath','人行道')}</span><div class="chips">${[['none',L('Open','照常')],['left',L('Works side closed','施工侧封')],['both',L('Both sides closed','两侧都封')]].map(([k,t])=>`<button type="button" data-foot="${k}" aria-pressed="${EP.foot===k}">${t}</button>`).join('')}</div></div></div></div>`;
}
// 01 Site / Signs (09-30 @unicornnnnnny): the four engine figures are off these two tabs; only what needs doing shows here
// (no street picked yet, or the engine could not score the plan). The figures are in 03 Impact and 04 Compare.
function engStateSec(){return'<div id="engState" class="stack"></div>';}
function engStateHTML(){
  if(!BE.api)return'';
  if(!EP.link)return`<div class="card eng-note warn"><b>${L('Click a street on the map to place the work zone','在地图上点一条街来放施工区')}</b></div>`;
  if(EP.runErr)return`<div class="card eng-note warn"><b>${L('The engine could not score this plan','引擎算不了这个方案')}</b><span>${esc(EP.runErr.message||EP.runErr)}</span></div>`;
  return'';
}
function engOutSec(){return`<div class="stack eng-sec"><div class="row between"><span class="eyebrow">${L('Engine · real CBD flows','引擎 · 真实 CBD 车流')}</span><span class="eyebrow">${engHour(EP.hour)}</span></div><div id="engOut"></div></div>`;}
function engSignsHTML(){return`<div class="stack"><div class="row between"><span class="eyebrow">VMS-1 · ${L('message sign','可变信息屏')}</span><span class="eyebrow" id="vmsAtLbl">${EP.vmsAt} m ${L('upstream','上游')}</span></div>
    <div class="eng-vms"><textarea id="vmsF1" rows="4" spellcheck="false" aria-label="${L('VMS frame 1','屏幕第 1 帧')}" placeholder="${L('FRAME 1','第 1 帧')}">${esc(EP.f1)}</textarea><textarea id="vmsF2" rows="4" spellcheck="false" aria-label="${L('VMS frame 2','屏幕第 2 帧')}" placeholder="${L('FRAME 2 (optional)','第 2 帧（可空）')}">${esc(EP.f2)}</textarea></div>
    <input type="range" id="vmsAt" min="40" max="${Math.max(1000,EP.vmsAt)}" step="10" value="${EP.vmsAt}" aria-label="${L('VMS distance upstream of the works','屏距施工起点的上游距离')}">
    <p class="small muted">${L('One line per row · ≤ 4 lines × 10 characters per frame. Try adding a second frame: USE / RUSSELL ST.','每行一句 · 每帧 ≤ 4 行 × 10 个字符。试试加第 2 帧：USE / RUSSELL ST。')}</p>
    <label class="eng-field"><span class="eyebrow">S-1 · ${L('sign','标志牌')} · ${EP.signAt} m</span><input type="text" id="signTxt" maxlength="40" spellcheck="false" value="${esc(EP.sign)}"></label>
    <div id="engCheck" class="stack"></div></div>`;
}
function engBind1(){
  const P=document.getElementById('panel');if(!P||!BE.api)return;
  P.querySelectorAll('[data-preset]').forEach(b=>b.onclick=()=>{engPreset(b.dataset.preset);renderPanel();engFly(.7);});
  P.querySelectorAll('[data-all]').forEach(b=>b.onclick=()=>{EP.all=b.dataset.all==='true';EP.lanes=EP.all?EP.lanesMax:1;renderPanel();engChanged(0);});
  P.querySelectorAll('[data-hour]').forEach(b=>b.onclick=()=>{EP.hour=+b.dataset.hour;renderPanel();engChanged(0);});
  P.querySelectorAll('[data-foot]').forEach(b=>b.onclick=()=>{EP.foot=b.dataset.foot;renderPanel();engChanged(0);});
  const f1=document.getElementById('vmsF1'),f2=document.getElementById('vmsF2'),at=document.getElementById('vmsAt'),sg=document.getElementById('signTxt');
  if(f1)f1.oninput=()=>{EP.f1=f1.value;engChanged();};
  if(f2)f2.oninput=()=>{EP.f2=f2.value;engChanged();};
  if(sg)sg.oninput=()=>{EP.sign=sg.value;engChanged();};
  if(at)at.oninput=()=>{EP.vmsAt=+at.value;const l=document.getElementById('vmsAtLbl');if(l)l.textContent=`${EP.vmsAt} m ${L('upstream','上游')}`;engChanged(250);};
  engRenderCheck();engRenderOut();
}

// Step 3, network tab: where the queue goes, who is hit and why (why = T5 reading, always set with textContent)
function engTabs3(){
  if(!BE.api)return'';
  return`<div class="eng-seg eng-seg3" role="tablist" aria-label="${L('Impact view','影响视图')}">${[['traffic',L('Traffic','交通影响')],['clash',L('Nearby works','施工叠加')],['evidence',L('Evidence','依据假设')]].map(([k,t])=>`<button type="button" role="tab" data-view3="${k}" aria-selected="${EP.tab3==='net'&&EP.view3===k}">${t}</button>`).join('')}</div>`;
}
function engBindTabs3(){document.querySelectorAll('#panel [data-view3]').forEach(b=>b.onclick=()=>{const was=EP.tab3;EP.tab3='net';EP.view3=b.dataset.view3;renderPanel();if(was!=='net')engFly(.7);});}
function engHeadline(s){
  const st=esc(shortSt(s.street)),q=engWorstQ(s);
  if(s.flags&&s.flags.inactive)return L(`No works on ${st} at ${engHour(s.when.hour)}`,`${engHour(s.when.hour)} ${st} 不施工`);
  if(engFull(s))return q.m>0?L(`Closing ${st} sends ${pctS(s.detour_share)} round — ${esc(shortSt(q.name))} queues ${fmtN(q.m)} m`,`${st} 全封，${pctS(s.detour_share)} 的车绕行 —— ${esc(shortSt(q.name))} 排队 ${fmtN(q.m)} 米`):L(`Closing ${st} sends ${pctS(s.detour_share)} of drivers round`,`${st} 全封，${pctS(s.detour_share)} 的车绕行`);
  return s.queue_m>0?L(`One lane on ${st} backs up ${fmtN(s.queue_m)} m`,`${st} 封一条道，排队 ${fmtN(s.queue_m)} 米`):L(`One lane on ${st}: no queue this hour`,`${st} 封一条道：这个小时不排队`);
}
function engPanel3(){
  if(typeof sumoPanel3==='function'&&sumoPlanOn())return sumo3Top()+(EP.view3==='evidence'?sumo3Evidence():EP.view3==='clash'?sumo3Clash():sumoPanel3())+navHTML(); // SUMO plan: every traffic number in 03 is SUMO's; the engine stays behind the scenes (6e-sumo3.js)
  const s=EP.badText||(EP.runErr&&!EP.busy)?null:EP.sum;
  if(EP.runErr&&!EP.busy&&!EP.badText)return`<div class="row between"><span class="eyebrow" style="color:var(--sun-ink)">${L('Impact · network','影响 · 路网')}</span>${engStatusPill()}</div>${engTabs3()}<div class="card eng-note warn"><b>${L('The engine could not score this plan','引擎算不了这个方案')}</b><span>${esc(EP.runErr.message||EP.runErr)}</span></div>${navHTML()}`;
  if(!s)return`<div class="row between"><span class="eyebrow" style="color:var(--sun-ink)">${L('Impact · network','影响 · 路网')}</span>${engStatusPill()}</div>${engTabs3()}${EP.badText?`<div class="card eng-note warn"><b>${L('Fix the sign text in step 1 first','先回第 1 步把屏上文字改合规范')}</b></div>`:`<div class="card eng-note"><b>${L('Calculating…','计算中…')}</b></div>`}${navHTML()}`;
  const tot=s.routes.reduce((a,r)=>a+(r.share||0),0)||1;
  const routes=s.routes.map(r=>{const stay=r.id==='stay',w=(r.share/tot*100).toFixed(0);return`<div class="eng-route${stay?' stay':''}"><span class="nm">${stay?L('Stay on ','留在 ')+esc(shortSt(r.name)):esc(shortSt(r.name))}</span><span class="track"><i style="width:${w}%"></i></span><span class="n">${pctS(r.share)}</span><span class="t">${(+r.now_min).toFixed(1)} ${L('min','分')}${r.now_min>r.usual_min+.05?`<s>${(+r.usual_min).toFixed(1)}</s>`:''}</span></div>`;}).join('');
  const mix=EP.mix,mixTxt=mix?TYPES4.map(t=>`${Math.round((mix[t]&&mix[t].value||0)*100)}`).join(' / '):'';
  const lowConf=mix&&TYPES4.some(t=>mix[t]&&(mix[t].confidence==='low'||mix[t].confidence==='none'));
  const types=TYPES4.map(t=>{const b=s.by_type[t]||{},a=(s.approaches[s.main]||{}).by_type,x=a&&a[t]||{},r=mix&&mix[t]&&mix[t].range;
    return`<div class="eng-type"><i class="dot" style="background:${TYPE_C[t]}"></i><div class="grow"><b>${L(TYPE_L[t][0],TYPE_L[t][1])}</b> <span class="mono small muted">${fmtN(b.vehicles)} ${L('veh','辆')}${r?` · ${L('mix','占比')} ${Math.round(r[0]*100)}–${Math.round(r[1]*100)}%`:''}</span><small data-why="${t}"></small></div><div class="eng-tv"><b>+${(+(b.per_capita_min||0)).toFixed(1)}</b><span>${L('min each','分钟/人')}</span><span>${pctS(x.detour)} ${L('detour','绕行')}</span></div></div>`;}).join('');
  const hot=(s.hot||[]).map((h,i)=>`<div class="eng-hot" data-hot="${i}" tabindex="0"><span class="rk">${i+1}</span><span class="grow">${esc(shortSt(h.name)||L('Unnamed road','无名道路'))}</span><span class="val">+${fmtN(h.extra_min)} ${L('veh·min','车·分钟')}${h.queue_m>0?` · ${fmtN(h.queue_m)} m`:''}</span></div>`).join('');
  const f=s.flags,top=`<div class="row between"><span class="eyebrow" style="color:var(--sun-ink)">${L('Impact · network','影响 · 路网')}</span>${engStatusPill()}</div>${engTabs3()}`;
  if(EP.view3==='clash')return top+`<div class="stack"><h2>${L('Other works on the same dates','同期的其他施工')}</h2><p class="small eng-assume">${L('Registered works that overlap this plan, scored together with it on the real network: the clash cost is the delay that exists only because both run at once.','登记表里和本方案时间重叠的施工，和本方案一起在真实路网上算：叠加冲突 = 只因两处同时施工才多出来的延误。')}</p></div>${navHTML()}`;
  if(EP.view3==='evidence')return top+engEvidence(s,f)+navHTML();
  return top+`
  ${typeof sumoImpactHTML==='function'?sumoImpactHTML(s):''}
  <div class="stack"><span class="eyebrow">${L(`Engine estimate · whole CBD · queue at ${engEndH(s)}`,`引擎估算 · 整个 CBD · ${engEndH(s)} 时的排队`)}</span><h2>${engHeadline(s)}</h2><p class="muted small">${L(`${cap(dirL(EP.dir))} · weekday ${engHour(s.when.hour)} · real hourly flows on 1,513 CBD links. Every number below is recomputed by the engine.`,`${dirL(EP.dir)} · 工作日 ${engHour(s.when.hour)} · 1513 个 CBD 路段的真实逐时车流。下面每个数都是引擎现算的。`)}</p></div>
  ${engMetrics(s)}${engWhy(s)}${engBadges(f,s)}
  <div class="eng-legend"><span><i style="background:var(--risk)"></i>${L('Queue','排队')}</span><span><i style="background:var(--works)"></i>${L('Slower links','变慢的路段')}</span><span><i style="background:var(--accent)"></i>${L('Detours · width = share','绕行 · 线宽 = 占比')}</span></div>
  <div class="stack eng-where"><div class="row between"><span class="eyebrow">${L('Where drivers go','车往哪走')}</span><span class="eyebrow">${L('now vs usual','现在 vs 平时')}</span></div><div class="eng-routes">${routes}</div></div>
  <div class="stack"><div class="row between"><span class="eyebrow">${L('Who is hit · and why','谁受影响 · 为什么')}</span><span class="eyebrow">${L('per person','人均')}</span></div><div class="list eng-types">${types}</div>
    ${mix?`<p class="small muted">${L(`Road-user mix ${mixTxt} (%)${lowConf?' is an assumption — T12 confidence low; ranges shown per type.':'.'}`,`路人占比 ${mixTxt}（%）${lowConf?'是假设值 —— T12 置信度低，每类后面是区间。':'。'}`)}</p>`:''}</div>
  ${engTransit3(s)}${engPeds3(s)}
  ${hot?`<div class="stack"><div class="row between"><span class="eyebrow">${L('Worst links · on the map','最堵的路段 · 地图上')}</span><span class="eyebrow">${L('extra this hour','这一小时多出')}</span></div><div class="list">${hot}</div></div>`:''}
  <p class="legend-src">${L(`Flows: T3 network + hourly counts. Sign reading: ${esc(aiSrcLabel(aiPlanSrc(s,f).src))}. Behaviour parameters: ${f.params==='params'?'T12 (trust is an assumed value)':'assumed defaults'}.`,`车流：T3 路网 + 逐时流量。读屏：${esc(aiSrcLabel(aiPlanSrc(s,f).src))}。行为参数：${f.params==='params'?'T12（信任度是假设值）':'默认假设值'}。`)}</p>
  ${navHTML()}`;
}
// 03 Impact · Evidence: what each number is made from and which inputs are assumed (every line is a fact about the run)
function engEvidence(s,f){
  const t=s.transit||{},pp=(t.assumed&&t.assumed.pax_per_trip)||{},p=s.peds||{},n=engNet(),row=(k,v,warn)=>`<div><i class="dot" style="background:${warn?'var(--works)':'var(--accent)'}"></i><span class="grow">${k}</span><span class="val">${v}</span></div>`;
  return`<div class="stack"><h2>${L('What the numbers rest on','这些数字的依据')}</h2></div>
  <div class="stack"><div class="row between"><span class="eyebrow">${L('Data','数据')}</span><span class="eyebrow">${L('real','真实')}</span></div><div class="list eng-evd">
    ${row(L('Road network','路网'),n?`${fmtN(n.links.size)} ${L('CBD links','个 CBD 路段')}`:'—')}
    ${row(L('Traffic','车流'),L(`SCATS hourly counts · ${engHour(s.when.hour)}`,`SCATS 逐时流量 · ${engHour(s.when.hour)}`))}
    ${hasTransit(s)?row(L('Trams & buses','电车公交'),L('PTV timetable (GTFS)','PTV 官方时刻表（GTFS）')):''}
    ${hasPeds(s)?row(L('People on foot','行人'),p.measured?L('City of Melbourne counts','墨尔本市行人计数'):L('estimated','估算')):''}
    ${row(L('Sign reading','读屏'),esc(aiSrcLabel(aiPlanSrc(s,f).src)))}</div></div>
  <div class="stack"><div class="row between"><span class="eyebrow">${L('Assumed','假设值')}</span><span class="eyebrow">${L('no source yet','暂无来源')}</span></div><div class="list eng-evd">
    ${row(L('Trust in signs','对标志的信任度'),f.params==='params'?L('T12 · assumed value','T12 · 假设值'):L('default · assumed','默认 · 假设值'),1)}
    ${hasTransit(s)?row(L('Riders per trip','每班乘客'),L(`tram ${fmtN(pp.tram)} · bus ${fmtN(pp.bus)}`,`电车 ${fmtN(pp.tram)} · 公交 ${fmtN(pp.bus)}`),1):''}
    ${row(L('Weather','天气'),L('illustrative · not in the engine','示意 · 不进引擎'),1)}</div></div>
  ${engWhy(s)}
  <p class="small eng-assume">${L('Model estimates on real CBD flows · not field-validated. The language model only reads the signs; every number above is the engine’s.','真实 CBD 车流上的模型估算 · 未经实地验证。大模型只读屏上的字，上面每个数都是引擎算的。')}</p>`;
}
function engTransit3(s){
  if(!hasTransit(s))return'';const t=s.transit,rs=(t.routes||[]).slice(0,6),a=t.assumed||{},pp=a.pax_per_trip||{};
  const rows=rs.map(r=>`<div class="eng-tr"><span class="md" style="background:${r.mode==='tram'?'var(--a-tram)':'var(--a-bus)'}">${esc(r.short)}</span><div class="grow"><b>${L(MODE_L[r.mode]?MODE_L[r.mode][0]:'',MODE_L[r.mode]?MODE_L[r.mode][1]:'')} ${esc(r.short)}</b> <span class="mono small muted">→ ${esc(r.headsign)}</span>${(r.stops_closed||[]).length?`<small style="color:var(--works)">${L('Stop closed','车站封闭')}: ${r.stops_closed.map(x=>esc(x.name)).join(', ')}</small>`:''}</div><div class="eng-tv">${r.blocked?`<b style="color:var(--risk)">${L('blocked','停运')}</b><span>${fmtN(r.pax_h)} ${L('riders/h','人/时')}</span>`:`<b>+${fmtN(r.delay_s)}<small> s</small></b><span>${fmtN(r.trips_h)} ${L('trips/h','班/时')}${r.diverted?' · '+L('diverted','改线'):''}</span>`}</div></div>`).join('');
  return`<div class="stack"><div class="row between"><span class="eyebrow">${L('Trams & buses','电车 · 公交')}</span><span class="eyebrow">${(t.routes||[]).length} ${L('routes','条线')} · +${fmtN(t.pax_min)} ${L('rider·min','人·分钟')}</span></div>
  ${rs.length?`<div class="list eng-trs">${rows}</div>`:`<div class="card eng-note"><b>${L('No tram or bus route uses the affected streets','没有电车 / 公交线路经过受影响的路段')}</b></div>`}
  <p class="small muted">${L(`Timetabled trips from PTV GTFS. Riders per trip are assumed (tram ${fmtN(pp.tram)}, bus ${fmtN(pp.bus)}).`,`班次来自 PTV 官方时刻表（GTFS）。每班乘客数是假设值（电车 ${fmtN(pp.tram)}、公交 ${fmtN(pp.bus)}）。`)}</p></div>`;
}
function engPeds3(s){
  if(!hasPeds(s))return'';const p=s.peds;
  if(p.footpath==='none'||!(p.closed||[]).length)return`<div class="row between"><span class="eyebrow">${L('People on foot','行人')}</span><span class="eyebrow">${L('Footpath open · no detour','人行道照常 · 不用绕')}</span></div>`;
  const sensorTxt=p.sensor?L(`nearest counter ${esc(p.sensor.name)}: ${fmtN(p.sensor.ped_h)}/h`,`最近的计数器 ${esc(p.sensor.name)}：每小时 ${fmtN(p.sensor.ped_h)} 人`):'';
  return`<div class="stack"><div class="row between"><span class="eyebrow">${L('People on foot','行人')}</span><span class="eyebrow">${p.measured?L('measured','实测'):L('estimated','估算')}</span></div>
  <div class="metrics"><div class="metric"><span class="eyebrow">${L('On the closed footpath','封闭段人流')}</span><div class="v">${fmtN(p.ped_h)}<small>${L('people/h','人/时')}</small></div></div>
  <div class="metric"><span class="eyebrow">${L('Walk round','绕行')}</span><div class="v" style="color:${p.blocked?'var(--risk)':'var(--works)'}">${p.blocked?L('none','无路'):'+'+fmtN(p.detour_m)}<small>${p.blocked?'':'m'}${p.crossings?` · ${p.crossings} ${L('crossings','次过街')}`:''}</small></div></div></div>
  <p class="small muted">${L(`City of Melbourne pedestrian counts; ${fmtN(p.extra_min)} extra person-minutes this hour at ${(p.assumed&&p.assumed.walk_mps)||1.3} m/s.`,`墨尔本市行人计数；这一小时共多走 ${fmtN(p.extra_min)} 人·分钟（按每秒 ${(p.assumed&&p.assumed.walk_mps)||1.3} 米）。`)}${sensorTxt?' '+sensorTxt+L('.','。'):''} ${L('Step-free access unknown (no steps data).','无障碍情况未知（数据里没有台阶信息）。')}</p></div>`;
}
function engBind3(){
  const s=EP.sum;if(!s)return;
  document.querySelectorAll('#panel [data-why]').forEach(el=>{const w=s.why&&s.why[el.dataset.why];el.textContent=w||'';});
  document.querySelectorAll('#panel [data-hot]').forEach(el=>{const go=()=>{const h=s.hot[+el.dataset.hot],P=h&&engGeo(h.id);if(!P)return;const m=P[Math.floor(P.length/2)];flyTo(m[0],m[1],Math.max(V.s,3.2),.6);};el.onclick=go;el.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();go();}};});
}

// Step 4: advisor options (each re-scored by the engine) + before / after for the picked one
function engPanel4(){return BE.api?`<div id="eng4" class="stack eng4"></div><div id="cmp4" class="stack cmp4"></div>`:'';} // cmp4 = T23 compare / choose / export (8-compare.js)
function eng4HTML(){
  if(!engOn())return engOfflineCard();
  if(EP.badText)return`<div class="card eng-note warn"><b>${L('Fix the sign text in step 1 first','先回第 1 步把屏上文字改合规范')}</b></div>`;
  if(typeof sumo3Eng4==='function'&&sumoPlanOn())return sumo3Eng4(); // SUMO plan: the advisor only suggests wordings; their effect is in the SUMO table below (6e-sumo3.js)
  const a=EP.adv;
  const n=a?a.options.length:0,rule=!a||a.src==='rule';
  let h=`<div class="row between"><span class="eyebrow" style="color:var(--sun-ink)">${rule?L('Planning advisor · rules · engine-checked','规划顾问 · 规则 · 引擎复核'):L('AI planning advisor · engine-checked','AI 规划顾问 · 引擎复核')}</span><span class="eyebrow">${a?`${n} ${n===1?L('option','个改法'):L('options','个改法')}`:''}</span></div>`;
  if(!a)return h+`<div class="card eng-note"><b>${EP.advBusy?L('Trying alternatives across the works period…','正在把整个施工期的改法逐个试一遍…'):L('The advisor could not run','顾问没跑起来')}</b></div>`;
  const kindL={text:L('Edit sign','改字'),move:L('Move sign','挪位置'),shift:L('Reschedule','错开日期')};
  const opts=a.options.map((o,i)=>{
    const what=o.kind==='text'&&o.frames?o.frames.map(f=>f.join(' / ')).join('  ▸  '):o.kind==='move'?`${esc(o.equipment||'')} → ${fmtN(o.at_m)} m ${L('upstream','上游')}`:o.kind==='shift'?`${o.days>0?'+':''}${fmtN(o.days)} ${L('days','天')}`:'';
    const d=Number(o.delta_min),hrs=Math.round(Math.abs(d)/60),gain=o.better&&Number.isFinite(d)&&a.flags.ok;
    return`<button type="button" class="eng-opt" data-opt="${i}" aria-pressed="${EP.pick===i}" ${o.plan&&!o.skipped?'':'disabled'}><span class="k">${kindL[o.kind]||esc(o.kind)}</span><span class="w"><b data-optwhy="${i}"></b><span class="mono">${esc(what)}</span></span><span class="d" style="color:${gain?'var(--accent)':'var(--fg-3)'}">${o.skipped?L('skipped','跳过'):!Number.isFinite(d)?'—':hrs===0?L('no change','没变化'):`${d<0?'−':'+'}${fmtN(hrs)} ${L('veh·h','车·时')}<small>${a.window.single_hour?L('this hour','这一小时'):L('whole works','全施工期')}</small>`}</span></button>`;}).join('');
  if(!a.flags.ok)h+=`<div class="card eng-note warn"><b>${L('Some sign readings are missing — savings below are not reliable','有读数没拿到 —— 下面的节省量不可信')}</b><span>${L(`missing ${a.flags.missing} · failed ${a.flags.failed}`,`缺 ${a.flags.missing} 条 · 失败 ${a.flags.failed} 条`)}</span></div>`;
  h+=`<div class="stack eng-opts">${opts||`<div class="card eng-note"><b>${L('No change beats this plan','没有比现在更好的改法')}</b><span>${L('The advisor tried rewording and moving the signs; none reduced total delay.','顾问试过改字和挪屏，都没让总延误变少。')}</span></div>`}</div>
  <p class="eng-assume eng-units">${engWindowTxt(a.window)}</p>`;
  const o=a.options[EP.pick];
  if(o){
    const c=EP.cmp;
    h+=`<div class="stack"><div class="row between"><span class="eyebrow">${L('Before → after · engine','修改前 → 修改后 · 引擎')}</span><span class="eyebrow">${L(`this hour · ${engHour(EP.hour)}`,`这一小时 · ${engHour(EP.hour)}`)}</span></div>`;
    if(o.kind==='shift')h+=`<div class="card eng-note"><b>${L('A date shift changes which days overlap — see the saving above.','错开日期改变的是哪几天重叠 —— 看上面的节省量。')}</b></div>`;
    else if(!c)h+=`<div class="card eng-note"><b>${EP.cmpBusy?L('Recomputing both plans…','两份方案都在重算…'):L('Comparison unavailable','对比没算出来')}</b></div>`;
    else{
      const B=c.before,A=c.after,D=c.delta,qa=Math.max(0,B.queue_m+D.queue_m),da=B.detour_share+D.detour_share;
      const row=(k,x,y,better)=>`<div><span class="muted">${k}</span><span class="o">${x}</span><span class="ar">→</span><span class="a" style="color:${better==null?'var(--fg)':better?'var(--accent)':'var(--works)'}">${y}</span></div>`; // better null = neither good nor bad
      h+=`<div class="table eng-table">${row(L('Extra per vehicle','每车多等'),`${fmtN(B.mean_delay_s)} s`,`${fmtN(A.mean_delay_s)} s`,D.mean_delay_s<=0)}${row(L(`Queue on ${esc(shortSt(D.street))}`,`${esc(shortSt(D.street))} 排队`),`${fmtN(B.queue_m)} m`,`${fmtN(qa)} m`,D.queue_m<=0)}${row(L('Drivers detouring','绕行的车'),pctS(B.detour_share),pctS(da),null)}${row(L('Network delay · veh·min this hour','全网延误 · 车·分钟（这一小时）'),fmtN(B.delay_min),fmtN(A.delay_min),D.delay_min<=0)}${hasTransit(B)&&hasTransit(A)?row(L('Tram & bus riders · rider·min','电车公交乘客 · 人·分钟'),fmtN(B.transit.pax_min),fmtN(A.transit.pax_min),A.transit.pax_min<=B.transit.pax_min):''}</div>
      <p class="eng-assume">${L(`Detour ${pctS(B.detour_share)} → ${pctS(da)} is a route-choice model prediction (trust in signs is an assumed value); fewer followers, smaller gain.`,`绕行 ${pctS(B.detour_share)} → ${pctS(da)} 的前提：路线选择模型推算（对标志的信任度是假设值）；照做的人少，收益就小。`)}</p>
      ${D.main_changed?`<p class="small" style="color:var(--works)">${L(`After the change the worst street is ${esc(shortSt(A.street))}; the queue row still compares ${esc(shortSt(D.street))}.`,`改完以后最堵的换成了 ${esc(shortSt(A.street))}；排队那一行仍然比的是 ${esc(shortSt(D.street))}。`)}</p>`:''}
      ${engBadges(A.flags,A)}<button type="button" class="btn ghost" id="applyBtn">${L('Apply to my plan','用到我的方案上')}</button>`;
    }
    h+='</div>';
  }
  return h;
}
// "−1,580 veh·h" is summed over every sampled hour of the works; the before/after table is one hour in veh·min (T20 addendum 3)
function engWindowTxt(w){
  if(!w||w.single_hour)return L('Savings: this hour only (veh·h).','节省量只算这一小时（车·时）。');
  const days=Math.round((Date.parse(WORKS_TIME.to)-Date.parse(WORKS_TIME.from))/864e5)+1,per=w.whens%days?0:w.whens/days;
  return per?L(`Savings: whole works, ${days} days × ${per} sampled h = ${w.whens} h (veh·h). Table below: one hour (veh·min).`,`节省量：全施工期 ${days} 天 × 每天采样 ${per} 小时 = ${w.whens} 小时（车·时）；下表只算一小时（车·分钟）。`)
    :L(`Savings: ${w.whens} sampled hours of the works (veh·h). Table below: one hour (veh·min).`,`节省量：施工期采样的 ${w.whens} 个小时（车·时）；下表只算一小时（车·分钟）。`);
}
function engRender4(){
  cmpRender(); // T23: follows the advisor (8-compare.js)
  const el=document.getElementById('eng4');if(!el)return;const h=eng4HTML();if(el.dataset.sig===h)return;el.innerHTML=h;el.dataset.sig=h;
  const a=EP.adv;
  el.querySelectorAll('[data-optwhy]').forEach(b=>{const o=a&&a.options[+b.dataset.optwhy];b.textContent=o&&o.why||'';});
  el.querySelectorAll('[data-opt]').forEach(b=>b.onclick=()=>{EP.pick=+b.dataset.opt;engCompare();});
  const ap=document.getElementById('applyBtn');if(ap)ap.onclick=engApply;
}
// Extra lines for the copied playbook (engine numbers, when there are any)
function engPlaybook(){
  if(typeof sumo3Playbook==='function'&&sumoPlanOn())return sumo3Playbook(); // SUMO plan: the exported text uses SUMO's numbers (6e-sumo3.js)
  const s=engSumFor('now');if(!BE.api||!s)return['',''];
  const o=EP.adv&&EP.adv.options[EP.pick],c=EP.cmp;
  const en=`\n\nNetwork impact (engine, real CBD flows, ${engHour(s.when.hour)})\n${s.street} ${dirL(EP.dir)}: queue ${fmtN(s.queue_m)} m · +${fmtN(s.mean_delay_s)} s per affected vehicle · ${pctS(s.detour_share)} detour`+(o&&c?`\nAdvisor: ${o.why||o.kind} → queue ${fmtN(c.before.queue_m)} → ${fmtN(Math.max(0,c.before.queue_m+c.delta.queue_m))} m, +${fmtN(c.before.mean_delay_s)} → +${fmtN(c.after.mean_delay_s)} s per vehicle`:'')+(hasTransit(s)&&(s.transit.routes||[]).length?`\nTrams & buses: ${s.transit.routes.length} routes, ${fmtN(s.transit.pax_h)} riders/h, +${fmtN(s.transit.pax_min)} rider-min${s.transit.blocked_routes?`, ${s.transit.blocked_routes} blocked`:''}`:'')+(hasPeds(s)&&(s.peds.closed||[]).length?`\nPedestrians: ${fmtN(s.peds.ped_h)}/h walk round, +${fmtN(s.peds.detour_m)} m each`:'')+(s.flags.reading_src==='rule'?'\n(Sign reading estimated with keyword rules.)':'');
  const zh=`\n\n路网影响（引擎，真实 CBD 车流，${engHour(s.when.hour)}）\n${s.street} ${dirL(EP.dir)}：排队 ${fmtN(s.queue_m)} 米 · 受影响的车每辆多 ${fmtN(s.mean_delay_s)} 秒 · 绕行 ${pctS(s.detour_share)}`+(o&&c?`\n顾问：${o.why||o.kind} → 排队 ${fmtN(c.before.queue_m)} → ${fmtN(Math.max(0,c.before.queue_m+c.delta.queue_m))} 米，每车 +${fmtN(c.before.mean_delay_s)} → +${fmtN(c.after.mean_delay_s)} 秒`:'')+(hasTransit(s)&&(s.transit.routes||[]).length?`\n电车公交：${s.transit.routes.length} 条线，每小时 ${fmtN(s.transit.pax_h)} 名乘客，多 ${fmtN(s.transit.pax_min)} 人·分钟${s.transit.blocked_routes?`，${s.transit.blocked_routes} 条停运`:''}`:'')+(hasPeds(s)&&(s.peds.closed||[]).length?`\n行人：每小时 ${fmtN(s.peds.ped_h)} 人绕行，每人多走 ${fmtN(s.peds.detour_m)} 米`:'')+(s.flags.reading_src==='rule'?'\n（读屏为关键词规则估算。）':'');
  return[en,zh];
}

/* ---------- map ---------- */
// Detour paths of the main approach, from the engine's own affected() (the same routes run() scores): only the part off the
// closed street is drawn. Route ids (r1, r2 …) match summary.routes, whose shares set the line width.
function engAlts(plan,s){
  const key=`${EP.link}|${EP.lanes}|${plan.when.hour}`;if(!EP.idx||EP.altsKey===key)return;
  try{
    const net=engNet(),main=s.approaches[s.main];EP.alts=[];EP.altsKey=key;if(!main)return;
    const aps=EP.idx.affected(net,BE.api.engine.flows,plan.worksites[0],plan.when,EP.idx.capFactors(net,plan.worksites)),a=aps.find(x=>x.entry===main.entry);if(!a)return;
    const stay=new Set(a.stayLinks||[]);
    EP.alts=(a.alts||[]).map(r=>({id:r.id,name:r.name,polys:r.links.filter(id=>!stay.has(id)).map(engGeo).filter(Boolean)}));
  }catch(e){EP.alts=[];console.warn('detour paths unavailable',e);}
}
// Frame the work zone, its queue and every detour taking ≥ 1 % (clamped to CITY), sized to the part of the map the
// glass leaves open (insets()); flyTo() then centres it there. No other junction is pulled in (T20 addendum 1)
function engFit(){
  if(!EP.pts)return null;const xs=[],ys=[],add=p=>{xs.push(clamp(p[0],CITY.x0,CITY.x1));ys.push(clamp(p[1],CITY.y0,CITY.y1));};
  EP.pts.forEach(add);const s=engSumFor('now'),sh=new Map(((s&&s.routes)||[]).map(r=>[r.id,r.share||0]));
  if(s&&s.queue_m>0)engSub(Math.min(s.queue_m,engReach())).forEach(add);
  if(typeof sumo3Fit==='function')sumo3Fit().forEach(add); // SUMO plan: the 03 framing includes SUMO's queue
  // every detour drawn clearly (≥ 1 %) is framed: with sign readings the three Lonsdale detours sit at 4–5 %, and a line cut at
  // the window edge reads as a bug (T27 acceptance) — the old ≥ 5 % cut them off
  for(const r of EP.alts)if((sh.get(r.id)||0)>=.01)for(const P of r.polys)P.forEach(add);
  return fitView(Math.min(...xs)-40,Math.max(...xs)+40,Math.min(...ys)-40,Math.max(...ys)+60,3.6);
}
// [cx, cy, scale] that fits the world box x0–x1 × y0–y1 in the open map, for flyTo(): clear of the glass insets and
// (T49: shared by engFit and gridFit) —
// phones have no glass insets, but the weather bar sits on top of the map and the legend at its foot: keep clear of both
// desktop: the weather legend (folded) and the credits line sit at the foot of the open map — keep the framing above them
function fitView(x0,x1,y0,y1,maxS){
  const mob=!matchMedia('(min-width: 821px)').matches,lg=document.getElementById('legend'),mt=mob?96:0,mb=mob?104:(lg&&lg.offsetHeight?lg.offsetHeight+52:0);
  const I=insets(),vw=Math.max(120,V.w-I.l-I.r),vh=Math.max(120,V.h-I.t-I.b-mt-mb);
  const sc=clamp(Math.min(vw/(x1-x0),vh/(y1-y0)),cityMinS(),maxS);
  return[(x0+x1)/2,(y0+y1)/2+(mt-mb)/(2*sc),sc];
}
function engFly(d){const f=engFit();if(f)flyTo(f[0],f[1],f[2],d);}
// A polyline shifted to the left of its direction of travel (traffic keeps left), so the two directions of a street separate
function engOffset(P,off){
  const out=[];for(let i=0;i<P.length;i++){const a=P[Math.max(0,i-1)],b=P[Math.min(P.length-1,i+1)],dx=b[0]-a[0],dy=b[1]-a[1],l=Math.hypot(dx,dy)||1;out.push([P[i][0]-dy/l*off,P[i][1]+dx/l*off]);}
  return out;
}
function engLine(P,off){const Q=engOffset(P,off);ctx.beginPath();Q.forEach((p,i)=>i?ctx.lineTo(V.X(p[0]),V.Y(p[1])):ctx.moveTo(V.X(p[0]),V.Y(p[1])));}
// The works street upstream of the works, cached per link (T27): the queue, the signs and their tags sit on it
const NET_UP=new WeakMap();
function engPath(){
  const net=engNet();if(!net||!EP.link)return null;if(EP.pathFor===EP.link)return EP.path;
  let ix=NET_UP.get(net);if(!ix){ix=upstreamIndex(net.links.values());NET_UP.set(net,ix);}
  const l=net.links.get(EP.link);EP.path=l?upstreamPath(ix,l,3000):null;EP.pathFor=EP.link;return EP.path;
}
// Point m metres upstream of the works start, along the street; straight back along the works link only if there is no path
function engUp(m){const p=engPath();if(p&&p.pts.length>1)return pathAt(p,Math.max(0,m));const P=EP.pts,a=P[0],b=P[P.length-1],l=Math.hypot(b[0]-a[0],b[1]-a[1])||1,u=m*K_UPM;return[a[0]-(b[0]-a[0])/l*u,a[1]-(b[1]-a[1])/l*u];}
// The street from the works start to m metres upstream (works start first)
function engSub(m){const p=engPath();return p&&p.pts.length>1?pathSub(p,Math.max(0,m)):[engUp(0),engUp(m)];}
// Numbers that belong to what is on screen: none while the sign text is invalid or the last run failed
function engSumFor(which){if(EP.badText||EP.runErr||(typeof sumoPlanOn==='function'&&sumoPlanOn()))return null;return which==='before'?(EP.cmp&&EP.cmp.before)||EP.sum:which==='after'?(EP.cmp&&EP.cmp.after)||EP.sum:EP.sum;} // SUMO plan: no engine numbers (the map draws no engine queue / ripple / detours or their tags)
// Walk-link geometry for the pedestrian detour, fetched only once a plan closes a footpath (same file the engine reads)
function engWalkGeo(){
  if(EP.walkGeo||EP.walkLoading)return EP.walkGeo;EP.walkLoading=true;
  fetch('/roads/public/cbd/walk.json').then(r=>r.ok?r.json():null).then(w=>{const m=new Map();for(const l of (w&&w.links)||[])if(Array.isArray(l.geometry)&&l.geometry.length>1)m.set(l.id,l.geometry.map(p=>geoToWorld(p[0],p[1])));EP.walkGeo=m;}).catch(()=>{EP.walkGeo=new Map();});
  return null;
}
function engPedDraw(s,faint){
  const p=s&&s.peds;if(!hasPeds(s)||!(p.closed||[]).length)return;const G=engWalkGeo();if(!G)return;const k=clamp(V.s/2.4,.7,1.6);
  ctx.save();ctx.lineCap='round';ctx.globalAlpha=faint?.6:.95;
  ctx.strokeStyle=TK.risk;ctx.lineWidth=4*k;for(const id of p.closed){const P=G.get(id);if(!P)continue;ctx.beginPath();P.forEach((q,i)=>i?ctx.lineTo(V.X(q[0]),V.Y(q[1])):ctx.moveTo(V.X(q[0]),V.Y(q[1])));ctx.stroke();}
  ctx.strokeStyle=TK.aPed;ctx.lineWidth=3*k;ctx.setLineDash([5,4]);for(const id of p.detour||[]){const P=G.get(id);if(!P)continue;ctx.beginPath();P.forEach((q,i)=>i?ctx.lineTo(V.X(q[0]),V.Y(q[1])):ctx.moveTo(V.X(q[0]),V.Y(q[1])));ctx.stroke();}
  ctx.restore();
}
function engTransitDraw(s,faint){
  if(!hasTransit(s))return;const k=clamp(V.s/2.4,.7,1.6);
  ctx.save();ctx.lineCap='round';ctx.setLineDash([7,5]);
  for(const r of (s.transit.routes||[]).slice(0,8)){ctx.globalAlpha=faint?.5:.9;ctx.strokeStyle=r.blocked?TK.risk:r.mode==='tram'?TK.aTram:TK.aBus;ctx.lineWidth=(r.blocked?3.4:2.4)*k;for(const id of [...(r.links||[]),...(r.detour_links||[])]){const P=engGeo(id);if(!P)continue;engLine(P,-2.5);ctx.stroke();}}
  ctx.restore();
}
// Ripple (every link that got slower), the queue, the closed link and the signs. Drawn under the road users.
function engDraw(which){
  if(!engOn()||!EP.pts||!S.layers.works||!TK.works)return;
  const s=engSumFor(which),k=clamp(V.s/2.4,.7,1.6),off=3.5;
  ctx.save();ctx.lineCap='round';ctx.lineJoin='round';
  if(!s&&typeof sumo3QueueDraw==='function')sumo3QueueDraw(which,k,off); // SUMO plan: 03 draws SUMO's end-of-hour queue (the works segment is drawn on top)
  if(s&&S.step!==2){
    const faint=S.step===1,share=new Map((s.routes||[]).map(r=>[r.id,r.share||0]));
    for(const r of EP.alts){const sh=share.get(r.id)||0;if(sh<.005)continue;ctx.globalAlpha=faint?.55:.85;ctx.strokeStyle=TK.accent;ctx.lineWidth=(2+10*sh)*k;for(const P of r.polys){engLine(P,off);ctx.stroke();}}
    for(const{id,sev}of rippleLinks(s.raw.links,EP.link)){ // extra_min (T28), not v·delay_s against free flow
      const P=engGeo(id);if(!P)continue;
      ctx.globalAlpha=(faint?.5:.9)*(sev?1:.7);ctx.strokeStyle=sev===2?TK.risk:TK.works;ctx.lineWidth=(sev===2?5:sev?3.6:2.6)*k;engLine(P,off);ctx.stroke();
    }
    if(s.queue_m>0){const Q=engSub(Math.min(s.queue_m,engReach())).reverse();ctx.globalAlpha=.85;ctx.strokeStyle=TK.risk;ctx.lineWidth=7*k;engLine(Q,off);ctx.stroke();ctx.globalAlpha=1;ctx.strokeStyle=TK.light?'#fff':'#1b0507';ctx.lineWidth=1.2;ctx.setLineDash([2,5]);engLine(Q,off);ctx.stroke();ctx.setLineDash([]);}
    if(S.step===4&&EP.cmp){const vis=engVisible(),q=engUp(Math.min(s.queue_m,vis));drawTag(ctx,V.X(q[0]),V.Y(q[1]),engDx(V.X(q[0]),24),which==='before'?-40:40,`${which==='before'?L('BEFORE','修改前'):L('AFTER','修改后')} · ${engQueueTxt(s,vis)}`,which==='before'?TK.risk:TK.accent);}
  }
  if(s&&S.step!==2){engTransitDraw(s,S.step===1);engPedDraw(s,S.step===1);}
  ctx.globalAlpha=1;ctx.strokeStyle=TK.works;ctx.lineWidth=9*k;engLine(EP.pts,off);ctx.stroke();
  ctx.strokeStyle=TK.light?'#1b1b1b':'#101010';ctx.lineWidth=2;ctx.setLineDash([4,4]);engLine(EP.pts,off);ctx.stroke();ctx.setLineDash([]);
  if(S.step<=2){
    const vm=[];if(parseFrame(EP.f1).length||parseFrame(EP.f2).length)vm.push(['VMS-1',EP.vmsAt]);if(String(EP.sign||'').trim())vm.push(['S-1',EP.signAt]);vm.push(['A-1',EP.arrowAt]);
    for(const[,m]of vm){const q=engOffset([engUp(m+.1),engUp(m)],off+6)[1],px=V.X(q[0]),py=V.Y(q[1]);ctx.fillStyle=TK.works;ctx.strokeStyle=TK.light?'#fff':'#000';ctx.lineWidth=1.2;ctx.beginPath();ctx.rect(px-4.5,py-4.5,9,9);ctx.fill();ctx.stroke();}
  }
  ctx.restore();
}
// Tags drawn above the weather layers
function engLabels(){
  if(!engOn()||!EP.pts||!S.layers.works||!TK.works||S.step===2||S.step===4||(S.step===3&&EP.tab3!=='net'))return;
  const s=engSumFor('now'),off=engOffset(EP.pts,3.5),a=off[0],b=off[off.length-1],mx=V.X((a[0]+b[0])/2),my=V.Y((a[1]+b[1])/2),vis=engVisible();
  // each tag goes clear of the map controls, of the works itself and of the tags before it (5-app.js tagSpot); inked together at the end
  const wx=off.map(p=>V.X(p[0])),wy=off.map(p=>V.Y(p[1])),wx0=Math.min(...wx)-8,wy0=Math.min(...wy)-8;
  TAGS.boxes=[[wx0,wy0,Math.max(...wx)+8-wx0,Math.max(...wy)+8-wy0]];TAGS.q=[];TAGS.on=true;
  // works near the foot of the open map (phones: the legend sits there) → the tag goes above the works instead of under the legend
  drawTag(ctx,mx,my,engDx(mx,36),my+80>V.h-GL.ins.b-(matchMedia('(min-width: 821px)').matches?0:104)?-50:54,`W-1 · ${shortSt(EP.street||L('Unnamed road','无名道路')).toUpperCase()} ${L(EP.dir+'B',dirL(EP.dir))} · ${EP.all?L('CLOSED','全封'):L('1 LANE','封 1 道')}`,TK.works);
  if(s&&s.queue_m>0){const q=engUp(Math.min(s.queue_m,vis)),px=V.X(q[0]);drawTag(ctx,px,V.Y(q[1]),engDx(px,24),-40,engQueueTxt(s,vis,true),TK.risk);}
  if(S.step===1){
    if(parseFrame(EP.f1).length||parseFrame(EP.f2).length){const q=engUp(Math.min(EP.vmsAt,vis)),px=V.X(q[0]);drawTag(ctx,px,V.Y(q[1]),engDx(px,20),46,`VMS-1 · ${EP.vmsAt} m${EP.vmsAt>vis?' →':''}`,TK.works);}
  }
  if(S.step===3&&s){
    const share=new Map((s.routes||[]).map(r=>[r.id,r.share||0]));let k2=0;
    for(const r of EP.alts){const sh=share.get(r.id)||0;if(sh<.05||k2>=2||!r.polys.length)continue;const P=r.polys[Math.min(r.polys.length-1,1)],c=P[Math.floor(P.length/2)];if(c[0]<CITY.x0||c[0]>CITY.x1||c[1]<CITY.y0||c[1]>CITY.y1)continue;drawTag(ctx,V.X(c[0]),V.Y(c[1]),k2?-50:50,k2?40:-36,`${L('DETOUR','绕行')} ${shortSt(r.name).toUpperCase()} ${pctS(sh)}`,TK.accent);k2++;}
    let n=0;for(const h of s.hot||[]){if(h.id===EP.link||n>=3)continue;const P=engGeo(h.id);if(!P)continue;const c=P[Math.floor(P.length/2)];if(c[0]<CITY.x0||c[0]>CITY.x1||c[1]<CITY.y0||c[1]>CITY.y1)continue;const o=[[46,-44],[-46,46],[50,40]][n++];drawTag(ctx,V.X(c[0]),V.Y(c[1]),o[0],o[1],`${shortSt(h.name).toUpperCase()} +${fmtN(h.extra_min)} ${L('veh·min','车·分钟')}`,h.extra_min>=60?TK.risk:TK.works);}}
  if(!s&&typeof sumo3QueueTag==='function')sumo3QueueTag(vis); // SUMO plan: 03 tags it “SUMO queue at 09:00 · X m”
  tagFlush();
}
// How far upstream the queue can be drawn: along its street to where the street runs out in the network, and inside CITY.
// The engine's queue is a point queue on the works link (engine assign.js) — it is drawn back along the street as far as the
// street goes, never stretched further; the tag keeps the engine's number and says where the line stops
function engReach(){
  const p=engPath(),R=p&&p.pts.length>1?p.reach:2000,inC=q=>q[0]>=CITY.x0&&q[0]<=CITY.x1&&q[1]>=CITY.y0&&q[1]<=CITY.y1;
  if(inC(engUp(R)))return R;let lo=0,hi=R;for(let i=0;i<24;i++){const mid=(lo+hi)/2;if(inC(engUp(mid)))lo=mid;else hi=mid;}return lo;
}
// at: the tag says when (T48: "· 09:00" — the queue at the end of the hour, as SUMO's 09:00 number in step 3)
function engQueueTxt(s,vis,at){
  const p=engPath(),cut=s.queue_m>engReach()+1,end=p&&p.end?shortSt(p.end):null;
  return`${L('QUEUE','排队')} ${fmtN(s.queue_m)} m`+(at?L(` · ${engEndH(s)}`,` · ${engEndH(s)} 时`):'')+(cut?L(` · drawn to ${end||'the edge of the network'}`,end?` · 画到 ${end} 为止`:' · 画到路网边上为止'):s.queue_m>vis?' →':'');
}
// How far upstream stays on screen (for placing tags): inside the world and the current view, with room for the tag
function engVisible(){
  const x0=Math.max(CITY.x0,V.wx(24)),x1=Math.min(CITY.x1,V.wx(V.w-24)),y0=Math.max(CITY.y0,V.wy(V.h-24)),y1=Math.min(CITY.y1,V.wy(70));
  let lo=0,hi=2000;for(let i=0;i<24;i++){const mid=(lo+hi)/2,p=engUp(mid);if(p[0]>x0&&p[0]<x1&&p[1]>y0&&p[1]<y1)lo=mid;else hi=mid;}return Math.max(0,lo-4);
}
// Tag offset that keeps the box on screen: point it back toward the middle of the view
const engDx=(px,d)=>px>V.w*.55?-d:d;
// Step 1: a click (not a drag) on a street moves the work zone there
function engBindMap(){
  let down=null,pending=0;const ptrs=new Set();
  const cancel=()=>{clearTimeout(pending);pending=0;};
  cv.addEventListener('pointerdown',e=>{ptrs.add(e.pointerId);cancel();down=ptrs.size===1?[e.offsetX,e.offsetY,e.pointerId]:null;});
  const lift=e=>ptrs.delete(e.pointerId);
  cv.addEventListener('pointercancel',e=>{lift(e);down=null;});
  cv.addEventListener('dblclick',cancel);
  cv.addEventListener('pointerup',e=>{
    lift(e);const d=down;down=null;if(!d||d[2]!==e.pointerId||Math.hypot(e.offsetX-d[0],e.offsetY-d[1])>5)return;
    if(S.step!==1||!BE.api||V.s<1)return; // zoomed out, the pick tolerance (≥ 14 px) spans whole blocks: don't move the works
    const x=V.wx(e.offsetX),y=V.wy(e.offsetY),tol=Math.max(9,14/V.s);
    pending=setTimeout(()=>{ // wait out a double-click (that one zooms)
      pending=0;const id=pickLink(engCands(),x,y,tol);
      if(!id||id===EP.link||S.step!==1)return;
      if(engSetLink(id)){EP.preset='custom';renderPanel();engChanged(0);toast(L(`Work zone moved to ${shortSt(EP.street)||'this road'} ${dirL(EP.dir)}`,`施工区挪到 ${shortSt(EP.street)||'这条路'} ${dirL(EP.dir)}`));}
    },280);
  });
}
