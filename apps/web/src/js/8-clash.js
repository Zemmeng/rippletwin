/* ============================================================
   T21 · Nearby works · clash check (D-0929-2011 ②).
   Step 3, network tab: other works in the register (T5 /api/worksites, seed fallback) that overlap this plan
   in time → be.clash() = D(A+B) − D(A) − D(B) on the real CBD network, and a one-click be.stagger().
   Every number comes from the engine; nothing here calls an LLM. Text from the register goes through esc().
   Hooks (one call each): 5-app.js renderPanel() step 3 → clashMount(); draw loop step 3 → clashDraw().
   ============================================================ */
const CL={m:null,listP:null,src:null,key:'',seq:0,busy:false,err:null,other:null,more:[],st:null,stBusy:false,stErr:null};
const CL_MAX=3; // score at most this many overlapping works; the costliest reliable one is shown
const clDay=s=>Date.UTC(+s.slice(0,4),+s.slice(5,7)-1,+s.slice(8,10))/864e5;
function clashCur(){return planFrom(EP).worksites[0];}
function clashLoad(){
  if(!CL.listP)CL.listP=import('/api/public/js/worksites.js')
    .then(async m=>{CL.m=m;const r=await m.listWorksites();CL.src=r.src;return r.worksites||[];});
  return CL.listP;
}
// Days to push the other works so it starts the day after this plan ends (the button's N; stagger() may stop earlier)
function clashDays(ws){const cur=clashCur();return Math.max(1,Math.min(14,clDay(cur.time.to)-clDay(ws.time.from)+1));}
// Registered works that overlap plan `cur` in time (not the same works), at most CL_MAX, each scored by be.clash(), the
// costliest reliable one first. alive() false = the caller moved on → null. 04 Compare's "Nearby works" row uses the same pick (T43)
async function clashPick(cur,alive){
  const list=await clashLoad();if(!alive())return null;
  const same=o=>o.links.length===cur.links.length&&o.links.every(id=>cur.links.includes(id)); // the same works already in the register
  const cands=CL.m.overlapping(cur,list).filter(o=>!same(o)).slice(0,CL_MAX),scored=[];
  for(const o of cands){const ws=CL.m.toEngineWorksite(o),r=await BE.api.clash(cur,ws);if(!alive())return null;scored.push({o,ws,r});}
  return scored.sort((x,y)=>(y.r.flags.reliable-x.r.flags.reliable)||(y.r.cost-x.r.cost)||(x.o.id<y.o.id?-1:1));
}
async function clashRun(){
  const seq=++CL.seq;Object.assign(CL,{busy:true,err:null,other:null,more:[],st:null,stBusy:false,stErr:null});clashRender();
  try{const scored=await clashPick(clashCur(),()=>seq===CL.seq);if(!scored)return;CL.other=scored[0]||null;CL.more=scored.slice(1);}
  catch(e){if(seq!==CL.seq)return;CL.err=e;console.warn('clash check failed',e);}
  CL.busy=false;clashRender();
}
async function clashStagger(){
  const x=CL.other,seq=CL.seq;if(!x||CL.stBusy)return;
  CL.stBusy=true;CL.stErr=null;clashRender();
  try{const st=await BE.api.stagger(clashCur(),x.ws,{maxDays:clashDays(x.ws)});if(seq!==CL.seq)return;CL.st=st;}
  catch(e){if(seq!==CL.seq)return;CL.stErr=e;console.warn('stagger failed',e);}
  CL.stBusy=false;clashRender();
  cmpRender(); // T46: 04's Nearby works row follows the stagger (cmpClashOther) — if the user already moved on to 04 while this re-scored
}
function clashHTML(){
  const one=t=>`<p class="small muted">${L('Nearby works','附近施工')} · ${t}</p>`;
  if(!engOn())return one(L('clash check needs the live engine.','叠加检查要等引擎连上。'));
  if(EP.badText)return one(L('fix the sign text in step 1 first.','先回第 1 步把屏上文字改合规范。'));
  if(CL.busy)return one(L('checking the works register for overlaps…','正在查登记表里同期的施工…'));
  if(CL.err)return one(L('clash check unavailable right now.','叠加检查暂时用不了。'));
  if(!CL.other)return one(L('no other registered works overlap this plan’s dates.','登记表里没有和本方案同期的其他施工。'));
  if(suPlan())return clashSuHTML(); // SUMO plan (D-1001-0045): no engine clash cost
  const{o,ws,r}=CL.other,net=engNet(),l0=net&&net.links.get(ws.links[0]),street=esc(shortSt(l0&&l0.name||'')),title=esc(o.title);
  const U=L('veh·min','车·分钟'),hrs=r.hours.map(engHour).join(', '),days=r.overlap.days;
  const head=`<div class="row between"><span class="eyebrow">${L('Nearby works · clash check','附近施工 · 叠加检查')}</span><span class="eyebrow"${r.flags.reliable&&r.cost>0?' style="color:var(--risk)"':''}>${r.flags.reliable&&r.cost>0?`+${fmtN(r.cost)} ${U}`:L(`${days} day${days===1?'':'s'} overlap`,`重叠 ${days} 天`)}</span></div>
  <div class="card eng-note"><b>${title}</b><span class="small muted">${street?street+' · ':''}${r.overlap.from} → ${r.overlap.to}${CL.src==='seed'?L(' · demo register (offline)',' · 演示登记表（离线）'):''}</span></div>`;
  const more=CL.more.length?`<p class="small muted">${L('Also overlapping: ','同期还有：')}${CL.more.map(x=>`${esc(x.o.title)} (${x.r.flags.reliable&&x.r.cost>0?'+'+fmtN(x.r.cost):'≈ 0'} ${U})`).join(' · ')}</p>`:'';
  // Not reliable: negative delay (baseline over capacity, #58) or failed sign readings — never show a number
  if(!r.flags.reliable)return`${head}<div class="card eng-note warn"><b>${r.flags.negative_delay?L('≈ 0 · baseline flow on this street exceeds capacity; result not reliable','≈ 0 · 这段路的基线车流超出通行能力，结果不可信'):L(`≈ 0 · ${r.flags.failed} sign reading${r.flags.failed===1?'':'s'} failed; result not reliable`,`≈ 0 · 有 ${r.flags.failed} 条屏上文字没读成，结果不可信`)}</b></div>${more}`;
  // Same corridor: D(A+B) < D(A) + D(B) with every D ≥ 0 → shown as 0, still reliable
  const sub=r.flags.substitutes?`<div class="card eng-note"><b>${L('≈ 0 · both works sit on the same corridor; together they add no extra delay','≈ 0 · 两处施工在同一走廊，叠加不额外增加延误')}</b></div>`:'';
  const m=(lab,v,col)=>`<div class="metric"><span class="eyebrow">${lab}</span><div class="v"${col?` style="color:${col}"`:''}>${v}<small>${U}</small></div></div>`;
  const metrics=`<div class="metrics">${m(L('This plan alone','本方案单独'),fmtN(r.a))}${m(L('Other works alone','那处施工单独'),fmtN(r.b))}${m(L('Both at once','两处同时'),fmtN(r.ab))}${m(L('Clash cost','叠加冲突'),(r.cost>0?'+':'')+fmtN(r.cost),r.cost>0?'var(--risk)':'var(--accent)')}</div>`;
  const why=`<p class="small muted">${L(`Engine estimate. Clash cost = D(A+B) − D(A) − D(B): network delay that exists only because both run at once. Summed over ${r.whens} sampled hours (${hrs} on each overlapping day), all CBD links.`,`引擎估算。叠加冲突 = D(A+B) − D(A) − D(B)：只因两处同时施工才多出来的全网延误。按 ${r.whens} 个采样小时加总（每个重叠日的 ${hrs}），全部 CBD 路段。`)}</p>
  <div class="eng-legend"><span><i style="background:var(--a-bike)"></i>${L('Dashed · the other works','虚线 · 那处施工')}</span></div>`;
  let act='';
  const st=CL.st,b=st&&st.best;
  if(b&&!b.reliable)act=`<div class="card eng-note warn"><b>${L(`No reliable stagger within ${clashDays(ws)} day${clashDays(ws)===1?'':'s'}`,`${clashDays(ws)} 天内没找到可信的错开方案`)}</b><span class="small muted">${L('The engine flags every shifted date it tried as not reliable (baseline flow over capacity or failed sign readings).','引擎把试过的每个挪后日子都标成不可信（基线车流超出通行能力，或屏上文字没读成）。')}</span></div>`;
  else if(b){const p=st.period;act=`<div class="card eng-note"><b>${L(`Stagger by ${b.days>0?'+':''}${b.days} day${Math.abs(b.days)===1?'':'s'} → clash cost ${fmtN(b.cost)} ${U}`,`错开 ${b.days>0?'+':''}${b.days} 天 → 叠加冲突 ${fmtN(b.cost)} ${U}`)}</b><span class="small muted">${L(`Was +${fmtN(r.cost)}. Moves ${title} later; this plan keeps its dates.${p&&p.reliable?` Whole period ${p.from} → ${p.to}: network delay ${fmtN(p.ab_before)} → ${fmtN(p.ab_after)} ${U}.`:''}`,`原来 +${fmtN(r.cost)}。挪的是「${title}」，本方案日期不变。${p&&p.reliable?`整段时间 ${p.from} → ${p.to} 全网延误 ${fmtN(p.ab_before)} → ${fmtN(p.ab_after)} ${U}。`:''}`)}</span></div>`;}
  else if(r.cost>0){const n=clashDays(ws);act=`<p class="small muted">${CL.stErr?L('Stagger failed — try again (button at the bottom of the panel).','错开没算成，再点一次面板底部的按钮。'):L(`“Stagger by ${n} day${n===1?'':'s'}” at the bottom of the panel moves ${title} later, re-scored by the engine day by day.`,`面板底部的「错开 ${n} 天」把「${title}」往后挪，引擎逐天重算。`)}</p>`;}
  return`${head}${metrics}${sub}${why}${act}${more}`;
}
// SUMO-primary mode (D-1001-0045): on the SUMO plan the section names the overlapping works, the dates and the
// window, and suggests a stagger in days worked out from the dates alone (clashDays: start the day after this plan ends) — no
// engine clash cost, no engine stagger (its result is a cost), and SUMO does not model two works at once (“Combined impact not covered by SUMO”)
function clashSuHTML(){
  const{o,ws,r}=CL.other,net=engNet(),l0=net&&net.links.get(ws.links[0]),street=esc(shortSt(l0&&l0.name||'')),title=esc(o.title);
  const days=r.overlap.days,n=clashDays(ws),win=cmpWin(days,r.hours.length,LANG.cur==='zh');
  const more=CL.more.length?`<p class="small muted">${L('Also overlapping: ','同期还有：')}${CL.more.map(x=>esc(x.o.title)).join(' · ')}</p>`:'';
  return`<div class="row between"><span class="eyebrow">${L('Nearby works · clash check','附近施工 · 叠加检查')}</span><span class="eyebrow">${L(`${days} day${days===1?'':'s'} overlap`,`重叠 ${days} 天`)}</span></div>
  <div class="card eng-note"><b>${title}</b><span class="small muted">${street?street+' · ':''}${r.overlap.from} → ${r.overlap.to}${win?` · ${win}`:''}${CL.src==='seed'?L(' · demo register (offline)',' · 演示登记表（离线）'):''}</span></div>
  <div class="card eng-note"><b>${L(`Suggestion: stagger ${title} by ${n} day${n===1?'':'s'}`,`建议：把「${title}」错开 ${n} 天`)}</b><span class="small muted">${L(`It would then start the day after this plan ends — the dates no longer overlap. This plan keeps its dates.`,`这样它在本方案结束后的第二天才开工，日期不再重叠。本方案日期不变。`)}</span></div>
  <div class="card eng-note"><b>${L('Combined impact not covered by SUMO','叠加影响 SUMO 暂不覆盖')}</b><span class="small muted">${L('SUMO runs this plan’s works on its own, so no clash number is shown for this plan.','SUMO 只算本方案这一处施工，所以这里不给叠加的数。')}</span></div>
  <div class="eng-legend"><span><i style="background:var(--a-bike)"></i>${L('Dashed · the other works','虚线 · 那处施工')}</span></div>${more}`;
}
// The stagger button lives in the panel's sticky footer next to "Find a better plan" (09-30: always in reach, no scrolling),
// shown in exactly the case clashHTML() explains it: a reliable clash cost > 0 and no stagger result yet (never on the SUMO plan, T49)
function clashBtnHTML(){
  const x=CL.other,st=CL.st;
  if(!x||!engOn()||EP.badText||CL.busy||CL.err||!x.r.flags.reliable||(st&&st.best)||!(x.r.cost>0)||suPlan())return'';
  const n=clashDays(x.ws);
  return`<button type="button" class="btn ghost" id="clashStagger"${CL.stBusy?' disabled':''}>${CL.stBusy?L('Re-scoring…','重算中…'):L(`Stagger by ${n} day${n===1?'':'s'}`,`错开 ${n} 天`)}</button>`;
}
function clashRender(){
  const el=document.getElementById('clashBox');if(!el)return;
  const h=clashHTML();if(el.dataset.sig!==h){el.innerHTML=h;el.dataset.sig=h;compactPanel();} // signature guard: same state → keep the DOM;
  // the section fills in after the panel was laid out (async engine calls): let the brief / full folding see it (7-glass.js)
  const a=document.getElementById('clashAct'),b=clashBtnHTML();if(!a||a.dataset.sig===b)return; // same guard: the button under the pointer stays
  a.innerHTML=b;a.dataset.sig=b;const x=a.querySelector('#clashStagger');if(x)x.onclick=clashStagger;
}
// Called by renderPanel() after the step-3 network panel is built: add the section above the CTA, (re)score when the plan changed
function clashMount(){
  const P=document.getElementById('panel');if(!P||S.step!==3||EP.tab3!=='net'||EP.view3!=='clash')return; // 03 Impact · Nearby works tab
  const box=document.createElement('div');box.id='clashBox';box.className='stack';
  const cta=P.querySelector('.cta');if(cta&&cta.parentNode)cta.parentNode.insertBefore(box,cta);else P.appendChild(box);
  if(cta){const a=document.createElement('div');a.id='clashAct';a.className='cta-act';cta.prepend(a);} // slot for the stagger button
  if(engOn()&&!EP.badText){const key=JSON.stringify(clashCur());if(key!==CL.key){CL.key=key;clashRun();return;}}
  clashRender();
}
// Map: the other works' links, dashed, only while the section is on screen
function clashDraw(){
  const x=CL.other;if(!x||S.step!==3||EP.tab3!=='net'||!engOn()||!S.layers.works||!document.getElementById('clashBox'))return;
  const k=clamp(V.s/2.4,.7,1.6);
  ctx.save();ctx.lineCap='round';ctx.lineJoin='round';ctx.globalAlpha=.95;ctx.strokeStyle=TK.aBike||TK.accent;ctx.lineWidth=5*k;ctx.setLineDash([7,6]);
  for(const id of x.ws.links){const P=engGeo(id);if(P){engLine(P,3.5);ctx.stroke();}}
  ctx.restore();
}
