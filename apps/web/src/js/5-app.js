'use strict';
/* ============================================================
   App: view, rendering pipeline, workflow and UI
   ============================================================ */
const $=s=>document.querySelector(s);
const ls={get(k){try{return localStorage.getItem(k);}catch(e){return null;}},set(k,v){try{localStorage.setItem(k,v);}catch(e){}}};
const IMPACT={
  clear:['Reference run. Every stress test is compared against it.','基准情景，所有压力测试都与它对比。'],
  storm:['Braking distance +38% · cyclist merge risk ×2.1','制动距离 +38% · 骑行者并道风险 ×2.1'],
  flood:['Wheelchair users cut off · vehicles slow to walking pace in water','轮椅使用者被阻断 · 车辆涉水降至步行速度'],
  fog:['VMS-1 is read after the merge point · late lane changes ×3.4','驾驶员驶过并道点后才看清 VMS-1 · 临时变道 ×3.4'],
  heat:['Pedestrians detour to shade · crossing compliance −22%','行人绕行寻找阴影 · 按信号过街比例 −22%'],
  wind:['Water barrier may slide 0.4 m · cyclist lateral drift 0.6 m','注水护栏可能滑移 0.4 m · 骑行者横向偏移 0.6 m']};

/* W / G start as the synthetic city (drawn at once, and the fallback when buildings.json can't be fetched);
   loadBuildings() swaps in the real footprints once they arrive → rebuildWorld() */
let W=buildWorld(),G=buildGrids(W);const WX=new Weather(W,G);
const TK={};
function readTokens(){const cs=getComputedStyle(document.documentElement);for(const k of['bg','panel','raised','line','line-2','fg','fg-2','fg-3','accent','on-accent','works','risk','delta','glass','glass-line','tint','tint-line','works-tint','risk-tint','a-car','a-bike','a-ped','a-wc','a-bus','a-tram','map-mode'])TK[k.replace(/-(\w)/g,(m,c)=>c.toUpperCase())]=cs.getPropertyValue('--'+k).trim();TK.light=TK.mapMode==='light';}

const S={step:1,wx:'clear',ui:0,basemap:'imagery',layers:{agents:true,weather:true,risk:false,works:true,grid:true,labels:true},playing:true,speed:2,clock:0,swipe:.5,slow:0,alertShown:false,replayT:0,chainHover:-1,sim:null,simAfter:null,stress:null,event:null,nodes:[],mouse:null,fly:null};
const IMG={};
function imagery(k){if(!IMG[k])IMG[k]=renderImagery(W,k==='nir'?PAL_NIR:PAL_RGB);return IMG[k];}

/* ---------- data credits ----------
   The licences ask for attribution: OpenStreetMap (ODbL), OpenMapTiles (CC BY 4.0), DataVic (CC BY 4.0), City of Melbourne
   (CC BY). One list, the same sources apps/roads/public/cbd/*.json record, shown on the page (renderCredits), in the
   execution pack and in the playbook (creditLines). The hosts are plain links for people to follow — nothing is fetched
   from them: the vector basemap tiles are pulled at build time by tools/fetch_vectormap.py, not by the page. */
const CREDITS=[
  {href:'https://www.openstreetmap.org/copyright',short:['© OpenStreetMap contributors','© OpenStreetMap contributors'],
    full:['© OpenStreetMap contributors, ODbL — road and walking network, building outlines','© OpenStreetMap contributors，ODbL 许可 —— 路网、人行网、建筑轮廓']},
  {href:'https://openfreemap.org',short:['Vector basemap © OpenMapTiles / OpenFreeMap','矢量底图 © OpenMapTiles / OpenFreeMap'],
    full:['Vector basemap layers (water, green space, land use, rail) from the OpenMapTiles schema © OpenMapTiles (CC BY 4.0), vector tiles served by OpenFreeMap, data © OpenStreetMap contributors (ODbL)','矢量底图图层（水域、绿地、用地、铁路）来自 OpenMapTiles schema © OpenMapTiles（CC BY 4.0），矢量瓦片由 OpenFreeMap 提供，数据 © OpenStreetMap contributors（ODbL）']},
  {href:'https://discover.data.vic.gov.au/dataset/traffic-signal-volume-data',short:['SCATS volumes © State of Victoria (DTP), DataVic CC BY 4.0','SCATS 车流 © 维多利亚州交通与规划部，DataVic CC BY 4.0'],
    full:['Traffic Signal Volume Data (SCATS) and Victorian traffic signals © State of Victoria (Department of Transport and Planning), DataVic, CC BY 4.0 — hourly traffic at signals','交通信号车流数据（SCATS）和维州信号灯站点（Traffic Signal Volume Data、Victorian traffic signals）© 维多利亚州交通与规划部，DataVic，CC BY 4.0 —— 路口逐时车流']},
  {href:'https://discover.data.vic.gov.au/dataset/gtfs-schedule',short:['PTV GTFS, DataVic CC BY 4.0','PTV 时刻表，DataVic CC BY 4.0'],
    full:['PTV GTFS Schedule © State of Victoria (Department of Transport and Planning), DataVic, CC BY 4.0 — tram and bus timetables','PTV GTFS Schedule 时刻表 © 维多利亚州交通与规划部，DataVic，CC BY 4.0 —— 电车、公交班次']},
  {href:'https://data.melbourne.vic.gov.au/',short:['City of Melbourne open data, CC BY','墨尔本市开放数据，CC BY'],
    full:['City of Melbourne open data, CC BY — Pedestrian Counting System, 2018 Building Footprints, CLUE building information','City of Melbourne 开放数据，CC BY —— 行人计数（Pedestrian Counting System）、2018 建筑轮廓（Building Footprints）、CLUE 建筑信息']}];
function creditLines(){return CREDITS.map(c=>`${L(c.full[0],c.full[1])} · ${c.href}`);}
function renderCredits(){const el=$('#credits');if(!el)return;el.innerHTML=`<span class="cr-k">${L('Data','数据')}</span>`+CREDITS.map(c=>`<a href="${c.href}" target="_blank" rel="noopener noreferrer">${L(c.short[0],c.short[1])}</a>`).join('<span class="cr-sep">·</span>');}

/* The La Trobe × Swanston micro-model (scripted road users, barrier B-12, the 17:00 timeline) is its own scene. It is drawn
   only where it is the subject: step 2, the junction-replay tab of step 3, a plan that is on La Trobe St, or when the engine
   is offline. Everywhere else the screen shows one works zone — the engine's (T20 addendum 4). */
function microOn(){
  if(S.step===2||(S.step===3&&!(BE.api&&EP.tab3==='net')))return true;
  if(BE.err&&!BE.api)return true;
  if(!BE.api)return false; // still connecting: don't flash the other junction first
  return /la trobe/i.test(EP.street||'');
}
// Top bar + map label name the scene on screen: the engine's works zone, or the La Trobe × Swanston micro-model (T26 2.1)
function updateScene(){
  const el=$('#sceneName'),micro=microOn();if(!el)return;
  const st=shortSt(EP.street)||L('Unnamed road','无名道路'),on=engOn()&&!micro;
  const t=gridShown()?L('Swanston / Russell × Lonsdale / Little Lonsdale · Melbourne CBD','Swanston / Russell × Lonsdale / Little Lonsdale · 墨尔本 CBD'):micro?L('Swanston St × La Trobe St · Melbourne CBD','Swanston St × La Trobe St · 墨尔本 CBD'):on?L(`${st} ${dirL(EP.dir)} · ${engHour(EP.hour)} · Melbourne CBD`,`${st} ${dirL(EP.dir)} · ${engHour(EP.hour)} · 墨尔本 CBD`):L('Melbourne CBD','墨尔本 CBD');
  if(el.textContent!==t)el.textContent=t;
  cv.setAttribute('aria-label',micro?L('Map of Swanston St and La Trobe St with simulated road users and weather layers','Swanston St 与 La Trobe St 路口地图，含模拟道路使用者与天气图层'):on?L(`Map of the ${st} ${dirL(EP.dir)} works at ${engHour(EP.hour)} on real CBD streets, with the engine's queue and detours`,`${st} ${dirL(EP.dir)} 施工地图（${engHour(EP.hour)}）：真实 CBD 路网上引擎算出的排队和绕行`):L('Map of the Melbourne CBD','墨尔本 CBD 地图'));
}
function syncMicro(){const on=microOn(),app=$('#app');if(app&&app.classList.contains('no-time')===on){app.classList.toggle('no-time',!on);readInsets();}}

/* ---------- view ---------- */
const V={cx:-22,cy:-6,s:3.6,w:800,h:600,dpr:1,ver:0,X(x){return this.w/2+(x-this.cx)*this.s;},Y(y){return this.h/2-(y-this.cy)*this.s;},wx(p){return this.cx+(p-this.w/2)/this.s;},wy(p){return this.cy-(p-this.h/2)/this.s;}};
/* the view may pan until the map's edge meets the edge of the part the glass leaves open (insets), not the canvas edge —
   otherwise the east / south end of the map can never come out from under the panels; a map smaller than that part is centred in it */
// Smallest zoom: the whole CITY fits the part of the map the glass leaves open (T27; ~0.5 on a 1440 desktop, ~0.2 on a phone)
function cityMinS(){const I=GL.ins,vw=Math.max(120,V.w-I.l-I.r),vh=Math.max(120,V.h-I.t-I.b);return Math.min(1.1,vw/(CITY.x1-CITY.x0),vh/(CITY.y1-CITY.y0));}
function setView(cx,cy,s){V.s=clamp(s,cityMinS(),14);const I=GL.ins,hw=V.w/2/V.s,hh=V.h/2/V.s;
  const x0=CITY.x0+hw-I.l/V.s,x1=CITY.x1-hw+I.r/V.s,y0=CITY.y0+hh-I.b/V.s,y1=CITY.y1-hh+I.t/V.s;
  V.cx=x0>x1?(x0+x1)/2:clamp(cx,x0,x1);V.cy=y0>y1?(y0+y1)/2:clamp(cy,y0,y1);V.ver++;}
function flyTo(cx,cy,s,d=.9,raw){if(!raw){const I=insets();s=clamp(s,cityMinS(),14);cx+=(I.r-I.l)/(2*s);cy+=(I.t-I.b)/(2*s);}S.fly={a:[V.cx,V.cy,V.s],b:[cx,cy,s],t:0,d:matchMedia('(prefers-reduced-motion: reduce)').matches?.01:d};}
function stepFly(dt){const f=S.fly;f.t+=dt;const k=smooth(Math.min(1,f.t/f.d)),ls1=Math.log(f.a[2]),ls2=Math.log(f.b[2]);setView(lerp(f.a[0],f.b[0],k),lerp(f.a[1],f.b[1],k),Math.exp(lerp(ls1,ls2,k)));if(f.t>=f.d)S.fly=null;}
const HOME={cx:-22,cy:-6,s:3.6};

const cv=$('#mapCanvas'),ctx=cv.getContext('2d'),base=document.createElement('canvas'),bctx=base.getContext('2d');
let baseVer=-1,baseKey='';
function resize(){readInsets();const r=$('#map').getBoundingClientRect();V.w=Math.max(1,r.width);V.h=Math.max(1,r.height);V.dpr=Math.min(2,window.devicePixelRatio||1);for(const c of[cv,base]){c.width=Math.round(V.w*V.dpr);c.height=Math.round(V.h*V.dpr);}setView(V.cx,V.cy,V.s);}

/* ---------- drawing helpers ---------- */
function rr(c,x,y,w,h,r){c.beginPath();c.moveTo(x+r,y);c.arcTo(x+w,y,x+w,y+h,r);c.arcTo(x+w,y+h,x,y+h,r);c.arcTo(x,y+h,x,y,r);c.arcTo(x,y,x+w,y,r);c.closePath();}
// Tag placement (T27): with the whole CBD in view, more tags share less room (375 px: the works tag ran under the zoom buttons
// and off the screen). While TAGS.on (engLabels), a tag tries its own spot, then mirrored and farther ones, each slid onto the
// open map, and takes the one that covers the least of the map controls and of the tags already drawn this frame.
// Other callers draw exactly where they ask.
const TAGS={on:false,boxes:[],q:[],obst:[],t:0},TAG_TRY=[[1,1],[-1,1],[1,-1],[-1,-1],[1,1.8],[-1,1.8],[1,-1.8],[-1,-1.8]];
function tagObst(){ // the glass controls over the canvas, in canvas px; re-read at most twice a second
  const now=performance.now();if(now-TAGS.t<500)return TAGS.obst;TAGS.t=now;const r0=cv.getBoundingClientRect();
  TAGS.obst=[...document.querySelectorAll('header.top,#rail,#wx,#basemap,.zoom,#legend,#probe,#credits,#panelOpen')].map(e=>e.getBoundingClientRect())
    .filter(r=>r.width&&r.height).map(r=>[r.left-r0.left,r.top-r0.top,r.width,r.height]);
  return TAGS.obst;
}
function tagSpot(px,py,dx,dy,w,h){
  const I=GL.ins,x0=I.l+4,x1=V.w-I.r-4,y0=I.t+4,y1=V.h-I.b-4,obs=tagObst();
  const ov=(a,b)=>Math.max(0,Math.min(a[0]+a[2],b[0]+b[2])-Math.max(a[0],b[0]))*Math.max(0,Math.min(a[1]+a[3],b[1]+b[3])-Math.max(a[1],b[1]));
  let best=null,bs=Infinity;
  TAG_TRY.forEach(([sx,sy],i)=>{
    const ddx=dx*sx,ax=ddx<0?px+ddx-w:px+ddx,ay=py+dy*sy-h/2,b=[clamp(ax,x0,Math.max(x0,x1-w)),clamp(ay,y0,Math.max(y0,y1-h)),w,h];
    let sc=(Math.abs(b[0]-ax)+Math.abs(b[1]-ay))*.5+i*.1;for(const o of obs)sc+=ov(b,o);for(const o of TAGS.boxes)sc+=ov(b,o);
    if(sc<bs){bs=sc;best=b;}
  });
  TAGS.boxes.push(best);return best;
}
function drawTag(c,px,py,dx,dy,text,color,T){
  T=T||TK;c.save();c.font=`500 10px ${FONT_MONO}`;const tw=c.measureText(text).width,w=tw+14,h=19;
  const[bx,by]=TAGS.on?tagSpot(px,py,dx,dy,w,h):[dx<0?px+dx-w:px+dx,py+dy-h/2];
  // the leader runs from the point to the nearest side of the box (the side it points from when the box sits where asked)
  const ex=px<bx?bx:px>bx+w?bx+w:px,ey=ex===px?(py<by?by:by+h):by+h/2,t=[c,px,py,ex,ey,bx,by,w,h,text,color,T];c.restore();
  if(TAGS.on)TAGS.q.push(t);else{tagInk(t,1);tagInk(t,2);}
}
// pass 1 = leader and dot, pass 2 = box and text; tagFlush() inks every leader first so no dot lands on another tag's text
function tagInk([c,px,py,ex,ey,bx,by,w,h,text,color,T],pass){
  c.save();
  if(pass===1){c.strokeStyle=color;c.lineWidth=1;c.beginPath();c.moveTo(px,py);c.lineTo(ex,ey);c.stroke();c.fillStyle=color;c.beginPath();c.arc(px,py,2.6,0,Math.PI*2);c.fill();}
  else{c.font=`500 10px ${FONT_MONO}`;c.fillStyle=T.glass;c.strokeStyle=color;rr(c,bx,by,w,h,3);c.fill();c.stroke();c.fillStyle=T.fg;c.textBaseline='middle';c.textAlign='left';c.fillText(text,bx+7,by+h/2+.5);}
  c.restore();
}
function tagFlush(){const q=TAGS.q;TAGS.on=false;TAGS.q=[];for(const p of[1,2])for(const t of q)tagInk(t,p);}
function colOf(t){return(t==='car'||t==='unf')?TK.aCar:t==='bike'?TK.aBike:t==='ped'?TK.aPed:t==='wc'?TK.aWc:t==='bus'?TK.aBus:TK.aTram;}
const PAT={};
function makePatterns(){
  const h=document.createElement('canvas');h.width=h.height=10;const g=h.getContext('2d');g.strokeStyle=TK.works;g.globalAlpha=.55;g.lineWidth=2;g.beginPath();g.moveTo(-2,12);g.lineTo(12,-2);g.moveTo(-2,2);g.lineTo(2,-2);g.moveTo(8,12);g.lineTo(12,8);g.stroke();PAT.hatch=ctx.createPattern(h,'repeat');
  const b=document.createElement('canvas');b.width=b.height=12;const q=b.getContext('2d');q.fillStyle='#1b1b1b';q.fillRect(0,0,12,12);q.fillStyle=TK.works;q.beginPath();q.moveTo(0,0);q.lineTo(6,0);q.lineTo(0,6);q.fill();q.beginPath();q.moveTo(12,0);q.lineTo(12,6);q.lineTo(6,12);q.lineTo(0,12);q.fill();PAT.barrier=ctx.createPattern(b,'repeat');
}

/* ---------- base map ---------- */
function renderBase(){
  const key=S.basemap+TK.mapMode+(S.layers.labels?1:0)+cityKey();if(baseVer===V.ver&&baseKey===key)return;baseVer=V.ver;baseKey=key;
  bctx.setTransform(V.dpr,0,0,V.dpr,0,0);
  /* T27: the whole CBD (6c-city.js) first, then the fine window clipped to WORLD on top, then a dashed seam round it */
  bctx.fillStyle=VEC[TK.light?'light':'dark'].land;bctx.fillRect(0,0,V.w,V.h);const city=cityDraw(bctx,V);
  bctx.save();bctx.beginPath();bctx.rect(V.X(WORLD.x0),V.Y(WORLD.y1),(WORLD.x1-WORLD.x0)*V.s,(WORLD.y1-WORLD.y0)*V.s);bctx.clip();
  if(S.basemap==='streets')drawVector(bctx,V,W,VEC[TK.light?'light':'dark']);
  else{const img=imagery(S.basemap);bctx.fillStyle='#1d1d1a';bctx.fillRect(0,0,V.w,V.h);bctx.imageSmoothingEnabled=true;bctx.imageSmoothingQuality='high';bctx.drawImage(img,V.X(WORLD.x0),V.Y(WORLD.y1),(WORLD.x1-WORLD.x0)*V.s,(WORLD.y1-WORLD.y0)*V.s);}
  emphasizeRoads(bctx,V,W,S.basemap,TK.light);
  if(S.layers.labels)drawLabels(bctx,V,W,S.basemap==='streets'?VEC[TK.light?'light':'dark']:{label:'#EEF2F4',halo:'rgba(8,10,12,.82)',poi:'#D5DEE3'});
  bctx.restore();if(city)citySeam(bctx,V,TK.light);
}

/* ---------- overlays ---------- */
function drawWorks(layout){
  if(!S.layers.works)return;const Z=LAYOUTS[layout],R=(x0,y0,x1,y1)=>[V.X(x0),V.Y(y1),(x1-x0)*V.s,(y1-y0)*V.s];
  ctx.save();
  if(layout==='after'){ctx.fillStyle=TK.light?'rgba(46,140,80,.55)':'rgba(63,155,90,.6)';ctx.beginPath();[[Z.bike0,-10.5],[Z.bike0,-8.25],[Z.bike1,Z.lane+.9],[Z.bike1,Z.lane-.9]].forEach((p,i)=>i?ctx.lineTo(V.X(p[0]),V.Y(p[1])):ctx.moveTo(V.X(p[0]),V.Y(p[1])));ctx.closePath();ctx.fill();
    ctx.strokeStyle=TK.light?'#1d2a2e':'#fff';ctx.setLineDash([3,3]);ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(V.X(Z.bike0+1),V.Y(-10.5));ctx.lineTo(V.X(Z.bike0+1),V.Y(-8.25));ctx.stroke();ctx.setLineDash([]);}
  let q=R(Z.bx0,-10.5,Z.bx1,Z.by);ctx.fillStyle=TK.worksTint;ctx.fillRect(...q);ctx.fillStyle=PAT.hatch;ctx.fillRect(...q);ctx.strokeStyle=TK.works;ctx.lineWidth=1;ctx.strokeRect(...q);
  q=R(Z.bx0,Z.by-.75,Z.bx1,Z.by);ctx.fillStyle=PAT.barrier;ctx.fillRect(...q);
  q=R(Z.bx0,-15,Z.bx1,Z.hoard);ctx.fillStyle=TK.worksTint;ctx.fillRect(...q);ctx.fillStyle=PAT.hatch;ctx.fillRect(...q);ctx.setLineDash([4,3]);ctx.strokeStyle=TK.works;ctx.strokeRect(...q);ctx.setLineDash([]);
  const vx=V.X(Z.vms),vy=V.Y(-12.2);ctx.fillStyle=TK.works;ctx.fillRect(vx-Math.max(6,2.2*V.s),vy-Math.max(2.5,.8*V.s),Math.max(12,4.4*V.s),Math.max(5,1.6*V.s));
  ctx.restore();
}
function planNotes(){
  const Z=LAYOUTS.before;ctx.save();
  const a=[V.X(AOI.x0),V.Y(AOI.y1),(AOI.x1-AOI.x0)*V.s,(AOI.y1-AOI.y0)*V.s];ctx.strokeStyle=TK.accent;ctx.setLineDash([6,4]);ctx.globalAlpha=.8;ctx.strokeRect(...a);ctx.setLineDash([]);ctx.globalAlpha=1;
  ctx.font=`700 9.5px ${FONT_MONO}`;const t=L('AOI · 0.029 km² · 4 approaches','分析范围 AOI · 0.029 km² · 4 个进口道'),tw=ctx.measureText(t).width;ctx.fillStyle=TK.accent;ctx.fillRect(a[0],a[1]+a[3],tw+12,17);ctx.fillStyle=TK.onAccent;ctx.textBaseline='middle';ctx.fillText(t,a[0]+6,a[1]+a[3]+9);
  const y=V.Y(-3.2),x0=V.X(Z.bx0),x1=V.X(Z.bx1);ctx.strokeStyle=TK.fg;ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(x0,y-5);ctx.lineTo(x0,y+5);ctx.moveTo(x1,y-5);ctx.lineTo(x1,y+5);ctx.moveTo(x0,y);ctx.lineTo(x1,y);ctx.stroke();
  const lab=`${(Z.bx1-Z.bx0).toFixed(1)} m`;ctx.font=`500 9.5px ${FONT_MONO}`;const lw=ctx.measureText(lab).width+8;ctx.fillStyle=TK.panel;ctx.fillRect((x0+x1)/2-lw/2,y-8,lw,16);ctx.fillStyle=TK.fg;ctx.textAlign='center';ctx.fillText(lab,(x0+x1)/2,y+.5);ctx.restore();
  drawTag(ctx,V.X((Z.bx0+Z.bx1)/2),V.Y(-7.8),-70,-70,L('B-12 · BARRIER 40 m','B-12 · 护栏 40 m'),TK.works);
  drawTag(ctx,V.X((Z.bx0+Z.bx1)/2),V.Y(-12.4),-40,64,L('HOARDING · CORRIDOR 1.1 m','施工围挡 · 通道仅 1.1 m'),TK.works);
  drawTag(ctx,V.X(Z.vms),V.Y(-12.2),30,58,L('VMS-1 · "LANE CLOSED AHEAD"','VMS-1 ·「前方车道封闭」'),TK.works);
  drawTag(ctx,V.X(-95),V.Y(-13.6),-30,40,L('BUS STOP 250','250 路公交站'),TK.aBus);
  drawTag(ctx,V.X(10),V.Y(-9.4),40,-86,L('CYCLE LANE ENDS 11 m AFTER CROSSING','自行车道在过街后 11 m 中断'),TK.aBike);
}
function drawAgents(sim,alpha=1){
  if(!sim||!S.layers.agents)return;ctx.save();ctx.lineWidth=1.2;
  const list=sim.isGrid&&sim.all?sim.all:sim.agents; // T38: the grid sim draws all 16 junctions, not just the 2×2 at the works
  for(const a of list){if(a.kind!=='veh'||a.trail.length<4)continue;ctx.globalAlpha=alpha*.35;ctx.strokeStyle=colOf(a.type);ctx.beginPath();for(let k=0;k<a.trail.length;k+=2){const px=V.X(a.trail[k]),py=V.Y(a.trail[k+1]);k?ctx.lineTo(px,py):ctx.moveTo(px,py);}ctx.lineTo(V.X(a.x),V.Y(a.y));ctx.stroke();}
  ctx.globalAlpha=alpha;
  const heat=S.layers.weather&&S.wx==='heat';
  for(const pass of['ped','bike','veh'])for(const a of list){const k=a.kind==='ped'?'ped':a.type==='bike'?'bike':'veh';if(k!==pass)continue;
    if(heat&&a.kind==='ped'){const t=WX.sample('heat',a.x,a.y);if(t>55){ctx.fillStyle='rgba(255,106,61,.35)';ctx.beginPath();ctx.arc(V.X(a.x),V.Y(a.y),Math.max(4,.9*V.s),0,7);ctx.fill();}}
    drawBody(a);
    if(a.blocked){const px=V.X(a.x),py=V.Y(a.y);ctx.strokeStyle=TK.risk;ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(px-5,py-5);ctx.lineTo(px+5,py+5);ctx.moveTo(px+5,py-5);ctx.lineTo(px-5,py+5);ctx.stroke();}
  }
  ctx.restore();
  for(const a of sim.agents)if(a.tag){const px=V.X(a.x),py=V.Y(a.y);if(px>0&&py>0&&px<V.w&&py<V.h)drawTag(ctx,px,py,a.tag==='C-17'?-18:18,a.tag==='C-17'?30:-26,`${a.tag} · ${(a.v*3.6).toFixed(0)} km/h`,colOf(a.type));}
}
function drawBody(a){
  const px=V.X(a.x),py=V.Y(a.y);if(px<-60||py<-60||px>V.w+60||py>V.h+60)return;
  if(a.type==='ped'||a.type==='wc'){const r=Math.max(a.type==='wc'?2.6:1.9,.34*V.s);ctx.fillStyle=colOf(a.type);ctx.beginPath();ctx.arc(px,py,r,0,7);ctx.fill();ctx.strokeStyle=TK.light?'rgba(255,255,255,.85)':'rgba(0,0,0,.55)';ctx.lineWidth=a.type==='wc'?1.5:.8;ctx.stroke();return;}
  const z=V.s<1?.55:1,L=Math.max(a.len*V.s,(a.type==='bike'?4.5:7)*z),Wd=Math.max(a.wid*V.s,(a.type==='bike'?2.4:3.6)*z);
  ctx.save();ctx.translate(px,py);ctx.rotate(Math.atan2(-a.hy,a.hx));
  if(a.acc<-3&&a.type!=='bike'){ctx.fillStyle='rgba(255,40,50,.9)';ctx.shadowColor='#ff2a3a';ctx.shadowBlur=8;ctx.fillRect(-L/2-1.5,-Wd/2,2.5,Wd);ctx.shadowBlur=0;}
  ctx.fillStyle=colOf(a.type);ctx.strokeStyle=TK.light?'rgba(255,255,255,.9)':'rgba(0,0,0,.6)';ctx.lineWidth=1;rr(ctx,-L/2,-Wd/2,L,Wd,Math.min(2,Wd/2));ctx.fill();ctx.stroke();
  if(a.type==='tram'){ctx.strokeStyle=TK.light?'rgba(255,255,255,.75)':'rgba(0,0,0,.4)';for(let k=1;k<5;k++){const x=-L/2+L*k/5;ctx.beginPath();ctx.moveTo(x,-Wd/2);ctx.lineTo(x,Wd/2);ctx.stroke();}}
  else if(a.type!=='bike'){ctx.fillStyle='rgba(255,255,255,.55)';ctx.fillRect(L/2-Math.max(2,L*.24),-Wd/2+1,Math.max(1,L*.08),Wd-2);}
  ctx.restore();
}
const EV_KEEP_GRID=60; // step 2 (4×4): safety marks stay this many sim seconds (conflicts are rare there)
// A safety mark is a diamond, never a dot (signal heads are red / amber / green dots); a dark rim keeps it readable on any basemap
function evDiamond(px,py,r,fill){ctx.fillStyle=fill;ctx.strokeStyle=TK.bg;ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(px,py-r);ctx.lineTo(px+r,py);ctx.lineTo(px,py+r);ctx.lineTo(px-r,py);ctx.closePath();ctx.fill();ctx.stroke();}
function drawEvents(sim){
  if(!sim)return;ctx.save();const keep=sim.isGrid?EV_KEEP_GRID:25;
  for(const e of sim.events){const age=sim.t-e.t;if(age>keep||age<0)continue;const px=V.X(e.x),py=V.Y(e.y);if(px<-40||py<-40||px>V.w+40||py>V.h+40)continue;
    if(e.kind==='noroute'){ctx.strokeStyle=TK.aWc;ctx.lineWidth=2;ctx.globalAlpha=Math.max(.3,1-age/25);ctx.beginPath();ctx.arc(px,py,8,0,7);ctx.stroke();if(age<7){ctx.globalAlpha=1;drawTag(ctx,px,py,-30,-40,L('NO STEP-FREE ROUTE','无障碍路线中断'),TK.aWc);}continue;}
    if(e.kind==='harsh'){ // T44: harsh braking — a diamond in the text colour, one ring as it happens
      if(age<1.6){const f=age/1.6;ctx.globalAlpha=1-f;ctx.strokeStyle=TK.fg;ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(px,py,6+f*16,0,7);ctx.stroke();}
      ctx.globalAlpha=Math.max(.25,1-age/keep);evDiamond(px,py,6,TK.fg);continue;}
    const col=e.sev===2?TK.risk:TK.works; // conflict amber, critical red — diamonds like harsh braking
    if(age<2.4){const f=age/2.4;ctx.strokeStyle=col;ctx.lineWidth=2;for(const k of[0,.33,.66]){const ff=(f+k)%1;ctx.globalAlpha=(1-ff)*(1-f*.5);ctx.beginPath();ctx.arc(px,py,4+ff*34,0,7);ctx.stroke();}}
    ctx.globalAlpha=Math.max(.2,1-age/keep);evDiamond(px,py,sim.isGrid?(e.sev===2?7.5:6.5):(e.sev===2?5:4),col);
    if(sim.isGrid&&e.ttc!=null&&age<8){ctx.globalAlpha=1;drawTag(ctx,px,py,-24,-30,`TTC ${e.ttc.toFixed(1)} s`,col);}
  }
  ctx.restore();
}
const riskCv=document.createElement('canvas');riskCv.width=RNX;riskCv.height=RNY;const riskG=riskCv.getContext('2d');let riskVer=-1,riskSim=null;
function drawRisk(sim){
  if(!sim||sim.isGrid)return; // the 2×2 grid sim's risk field is not on the La Trobe WORLD raster
 if(riskSim!==sim||riskVer!==sim.riskVer){riskSim=sim;riskVer=sim.riskVer;const img=riskG.createImageData(RNX,RNY);for(let q=0;q<RNX*RNY;q++){const v=sim.risk[q];if(v<.05)continue;const c=RAMPS.risk(Math.min(1,v/3)),o=q*4;img.data[o]=c[0];img.data[o+1]=c[1];img.data[o+2]=c[2];img.data[o+3]=Math.min(230,60+v*90);}riskG.putImageData(img,0,0);}
  ctx.save();ctx.globalAlpha=.75;ctx.imageSmoothingEnabled=true;ctx.drawImage(riskCv,V.X(WORLD.x0),V.Y(WORLD.y1),(WORLD.x1-WORLD.x0)*V.s,(WORLD.y1-WORLD.y0)*V.s);ctx.restore();
}
function drawReticle(ev){
  const px=V.X(ev.x),py=V.Y(ev.y),t=performance.now()/1000;ctx.save();ctx.strokeStyle=TK.risk;ctx.lineWidth=2;
  const s=26;for(const[sx,sy]of[[-1,-1],[1,-1],[1,1],[-1,1]]){ctx.beginPath();ctx.moveTo(px+sx*s,py+sy*(s-9));ctx.lineTo(px+sx*s,py+sy*s);ctx.lineTo(px+sx*(s-9),py+sy*s);ctx.stroke();}
  for(let k=0;k<3;k++){const f=((t*.8)+k/3)%1;ctx.globalAlpha=1-f;ctx.beginPath();ctx.arc(px,py,6+f*40,0,7);ctx.stroke();}ctx.restore();
}
function fogRings(sim){
  if(!sim||sim.isGrid||S.wx!=='fog'||!S.layers.weather)return; // reads LAYOUTS[sim.layout]: La Trobe scene only
  let car=sim.agents.find(a=>a.tag==='D-42');if(!car)car=sim.agents.find(a=>(a.p.id==='WB'||a.p.id==='WBU')&&a.x>10&&a.x<170);
  const Z=LAYOUTS[sim.layout];ctx.save();ctx.setLineDash([6,5]);ctx.lineWidth=1.5;
  if(car){const r=WX.visibility(car.x,car.y);ctx.strokeStyle=TK.light?'#1d2a2e':'#fff';ctx.beginPath();ctx.arc(V.X(car.x),V.Y(car.y),r*V.s,0,7);ctx.stroke();ctx.setLineDash([]);drawTag(ctx,V.X(car.x),V.Y(car.y-r),30,-16,`${L('SIGHT RANGE','视距')} ${r.toFixed(0)} m`,TK.light?'#1d2a2e':'#FFFFFF');ctx.setLineDash([6,5]);}
  const vr=Math.min(120,WX.visibility(Z.vms,-6));ctx.strokeStyle=TK.works;ctx.beginPath();ctx.arc(V.X(Z.vms),V.Y(-12.2),vr*V.s,0,7);ctx.stroke();ctx.setLineDash([]);
  drawTag(ctx,V.X(Z.vms),V.Y(-12.2+vr),20,-18,`VMS-1 ${L('LEGIBLE','可读距离')} ≤ ${vr.toFixed(0)} m`,TK.works);ctx.restore();
}
function drawGrid(){
  const lat0=ORIGIN.lat+V.wy(V.h)/MLAT,lat1=ORIGIN.lat+V.wy(0)/MLAT,lon0=ORIGIN.lon+V.wx(0)/MLON,lon1=ORIGIN.lon+V.wx(V.w)/MLON;
  const pick=(mPerDeg)=>{for(const d of[.0001,.0002,.0005,.001,.002,.005])if(d*mPerDeg*V.s>=120)return d;return .01;};
  const dl=pick(MLAT),dn=pick(MLON);ctx.save();ctx.strokeStyle=TK.accent;ctx.globalAlpha=.24;ctx.setLineDash([2,6]);ctx.lineWidth=1;
  ctx.beginPath();for(let a=Math.ceil(lat0/dl)*dl;a<lat1;a+=dl){const y=V.Y((a-ORIGIN.lat)*MLAT);ctx.moveTo(0,y);ctx.lineTo(V.w,y);}for(let o=Math.ceil(lon0/dn)*dn;o<lon1;o+=dn){const x=V.X((o-ORIGIN.lon)*MLON);ctx.moveTo(x,0);ctx.lineTo(x,V.h);}ctx.stroke();
  ctx.setLineDash([]);ctx.globalAlpha=.9;ctx.font=`500 9px ${FONT_MONO}`;ctx.fillStyle=TK.accent;ctx.lineWidth=3;ctx.strokeStyle=TK.light?'rgba(255,255,255,.9)':'rgba(6,9,12,.85)';ctx.textBaseline='top';
  for(let a=Math.ceil(lat0/dl)*dl;a<lat1;a+=dl){const y=V.Y((a-ORIGIN.lat)*MLAT);if(y<GL.ins.t+70||y>V.h-GL.ins.b-80)continue;const t=dms(a,'N','S');ctx.strokeText(t,GL.ins.l+6,y+3);ctx.fillText(t,GL.ins.l+6,y+3);}
  for(let o=Math.ceil(lon0/dn)*dn;o<lon1;o+=dn){const x=V.X((o-ORIGIN.lon)*MLON);if(x<GL.ins.l+20||x>V.w-GL.ins.r-110)continue;const t=dms(o,'E','W');ctx.strokeText(t,x+4,GL.ins.t+4);ctx.fillText(t,x+4,GL.ins.t+4);}
  ctx.restore();
}
function drawScale(){
  // metres, not page units: geoToWorld draws 1 m as K_UPM (~0.862) units (T27)
  const target=110/(V.s*K_UPM),pw=Math.pow(10,Math.floor(Math.log10(target)));let m=pw;for(const k of[1,2,5])if(k*pw<=target)m=k*pw;
  const px=m*K_UPM*V.s,x=GL.ins.l+22,y=V.h-GL.ins.b-(GL.ins.cr||0)-20;ctx.save();ctx.fillStyle=TK.glass;ctx.strokeStyle=TK.glassLine;rr(ctx,x-10,y-18,px+64,30,5);ctx.fill();ctx.stroke();
  ctx.fillStyle=TK.fg;ctx.fillRect(x,y,px/2,4);ctx.strokeStyle=TK.fg;ctx.lineWidth=1;ctx.strokeRect(x+.5,y+.5,px-1,3);
  ctx.font=`500 9px ${FONT_MONO}`;ctx.textAlign='center';ctx.textBaseline='alphabetic';ctx.fillText('0',x,y-4);ctx.fillText(String(m/2),x+px/2,y-4);ctx.fillText(`${m} m`,x+px,y-4);
  const nx=x+px+30,ny=y-1;ctx.beginPath();ctx.moveTo(nx,ny-13);ctx.lineTo(nx+6,ny+4);ctx.lineTo(nx,ny);ctx.lineTo(nx-6,ny+4);ctx.closePath();ctx.fill();ctx.font=`700 8.5px ${FONT_MONO}`;ctx.fillText('N',nx+13,ny-4);ctx.restore();
}
function drawDeltas(){
  const A=LAYOUTS.after,B=LAYOUTS.before;ctx.save();ctx.beginPath();ctx.rect(S.swipe*V.w,0,V.w,V.h);ctx.clip();ctx.strokeStyle=TK.risk;ctx.setLineDash([4,3]);ctx.lineWidth=1.3;ctx.strokeRect(V.X(B.bx0),V.Y(B.by),(B.bx1-B.bx0)*V.s,(B.by+10.5)*V.s);
  ctx.strokeStyle=TK.delta;ctx.beginPath();ctx.moveTo(V.X(B.vms),V.Y(-12.2));ctx.lineTo(V.X(A.vms),V.Y(-12.2));ctx.stroke();ctx.setLineDash([]);ctx.restore();
  const ax=Math.max(V.wx(S.swipe*V.w)+4,A.bx0+4);
  drawTag(ctx,V.X(Math.min(ax,A.bx1-2)),V.Y(-8),-40,-78,L('Δ1 BARRIER 8 m WEST · 0.9 m NARROWER','Δ1 护栏西移 8 m · 收窄 0.9 m'),TK.delta);
  drawTag(ctx,V.X((A.bike0+A.bike1)/2),V.Y(-8.5),40,-100,L('Δ2 17 m CYCLE TRANSITION + GIVE-WAY','Δ2 17 m 自行车过渡段 + 让行线'),TK.delta);
  drawTag(ctx,V.X(Math.min(ax,A.bx1-2)),V.Y(-11.4),-20,70,L('Δ3 STEP-FREE CORRIDOR 1.8 m','Δ3 保留 1.8 m 无障碍通道'),TK.delta);
  drawTag(ctx,V.X(A.vms),V.Y(-12.2),24,54,L('Δ4 VMS-1 +80 m UPSTREAM','Δ4 VMS-1 上游移 80 m'),TK.delta);
}
function drawReplay(dt){
  const ev=S.event;if(!ev||!ev.snaps.length)return;const sn=ev.snaps,t0=sn[0].t,t1=sn[sn.length-1].t;
  S.replayT+=dt*.4;if(S.replayT>t1-t0+1.4)S.replayT=0;const tt=t0+Math.min(S.replayT,t1-t0);
  let i=0;while(i<sn.length-1&&sn[i+1].t<=tt)i++;const h=sn[i];
  ctx.save();ctx.fillStyle=TK.light?'rgba(232,237,240,.74)':'rgba(3,6,9,.66)';ctx.beginPath();ctx.rect(0,0,V.w,V.h);const cx=V.X(ev.x+18),cy=V.Y(ev.y+1),rx=64*V.s,ry=26*V.s;ctx.ellipse(cx,cy,rx,ry,0,0,Math.PI*2);ctx.fill('evenodd');
  ctx.setLineDash([3,5]);ctx.strokeStyle=TK.accent;ctx.globalAlpha=.7;ctx.beginPath();ctx.ellipse(cx,cy,rx,ry,0,0,Math.PI*2);ctx.stroke();ctx.restore();
  for(const tag of['BUS 250','D-42','C-17']){const pts=sn.map(q=>q.a.find(o=>o.tag===tag)).filter(Boolean);if(pts.length<2)continue;ctx.save();ctx.strokeStyle=colOf(pts[0].ty);ctx.lineWidth=2.5;ctx.globalAlpha=.9;ctx.beginPath();pts.forEach((p,k)=>k?ctx.lineTo(V.X(p.x),V.Y(p.y)):ctx.moveTo(V.X(p.x),V.Y(p.y)));ctx.stroke();ctx.restore();}
  const fut=sn.filter(q=>q.t>tt&&q.t<=tt+2.05&&Math.abs(((q.t-tt)%1))<.06);
  ctx.save();ctx.setLineDash([2,2]);for(const q of fut)for(const a of q.a)if(a.tag){ctx.strokeStyle=colOf(a.ty);ctx.globalAlpha=.7;ctx.beginPath();ctx.arc(V.X(a.x),V.Y(a.y),Math.max(4,a.l*V.s*.45),0,7);ctx.stroke();}ctx.restore();
  ctx.save();for(const a of h.a){ctx.globalAlpha=a.tag?1:.3;drawBody({x:a.x,y:a.y,hx:a.hx,hy:a.hy,len:a.l,wid:a.w,type:a.ty,acc:a.acc});}ctx.restore();
  if(Math.abs(tt-ev.t)<1.2)drawReticle(ev);
  S.nodes.forEach((n,k)=>{const px=V.X(n.x),py=V.Y(n.y),on=S.chainHover===k;ctx.save();ctx.fillStyle=k===3?TK.risk:TK.panel;ctx.strokeStyle=n.c;ctx.lineWidth=on?3:2;ctx.beginPath();ctx.arc(px,py,on?13:10,0,7);ctx.fill();ctx.stroke();ctx.fillStyle=k===3?'#fff':n.c;ctx.font=`700 10px ${FONT_MONO}`;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(String(k+1),px,py+.5);ctx.restore();});
  for(const a of h.a)if(a.tag){drawTag(ctx,V.X(a.x),V.Y(a.y),a.tag==='C-17'?-20:22,a.tag==='C-17'?34:-30,`${a.tag} · ${(a.v*3.6).toFixed(0)} km/h`,colOf(a.ty));}
  drawTag(ctx,V.X(ev.x),V.Y(ev.y),-70,52,`TTC ${ev.ttc.toFixed(2)} s`,TK.risk);
  const lab=`${L('REPLAY','回放')} ${(tt-ev.t>=0?'+':'')}${(tt-ev.t).toFixed(1)} s · 0.4×`;ctx.save();ctx.font=`600 10.5px ${FONT_MONO}`;const w=ctx.measureText(lab).width+20;ctx.fillStyle=TK.glass;ctx.strokeStyle=TK.glassLine;const mx=(GL.ins.l+V.w-GL.ins.r)/2,by=V.h-GL.ins.b;rr(ctx,mx-w/2,by-40,w,24,4);ctx.fill();ctx.stroke();ctx.fillStyle=TK.accent;ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(lab,mx,by-28);ctx.restore();
}

/* ---------- frame ---------- */
function render(dt){
  renderBase();
  ctx.setTransform(V.dpr,0,0,V.dpr,0,0);ctx.clearRect(0,0,V.w,V.h);ctx.drawImage(base,0,0,V.w,V.h);
  WX.dim=S.step===3?.35:1;
  const fine=V.s>=1,wx=S.layers.weather&&fine; // T27: zoomed out to the city, the fine window's layers step aside
  if(wx)WX.drawGround(ctx,V);
  if(S.layers.risk&&S.step>=2&&S.sim&&fine)drawRisk(S.sim);
  const micro=microOn(),walkers=micro&&(fine||gridShown()); // T38: the grid sim keeps its cars when zoomed out (T27 hid them below 1×)
  if(S.step===4){
    const sx=S.swipe*V.w;
    ctx.save();ctx.beginPath();ctx.rect(0,0,sx,V.h);ctx.clip();engDraw('before');if(micro)drawWorks('before');if(walkers){drawAgents(S.sim);drawEvents(S.sim);}ctx.restore();
    ctx.save();ctx.beginPath();ctx.rect(sx,0,V.w-sx,V.h);ctx.clip();engDraw('after');if(micro&&S.simAfter)drawWorks('after');if(walkers&&S.simAfter){drawAgents(S.simAfter);drawEvents(S.simAfter);}ctx.restore();
  }else if(S.step===3){engDraw('now');if(micro)drawWorks('before');}
  else{const grid=gridShown(),wait=grid&&sumoWaiting();engDraw('now');if(micro&&!grid)drawWorks('before');if(walkers&&!wait){drawAgents(S.sim);drawEvents(S.sim);}if(grid)drawJunctions(S.sim,wait);if(wait)drawSumoWait();}
  if(wx)WX.drawAtmos(ctx,V,dt);
  if(S.step===3&&!(engOn()&&EP.tab3==='net'))drawReplay(dt);
  clashDraw(); // T21: dashes the nearby works' links; draws only in step 3 · network tab
  if(wx)WX.drawNotes(ctx,V,TK);
  if(S.step===1&&S.layers.works&&walkers)planNotes();
  if(S.step<=2&&walkers&&wx)fogRings(S.sim);
  if(S.step===2&&S.sim&&S.sim.critical)drawReticle(S.sim.critical);
  if(S.step===4&&S.simAfter&&S.layers.works&&micro)drawDeltas();
  engLabels();
  if(S.layers.grid&&fine)drawGrid();
  drawScale();
  if(wx)WX.drawFlash(ctx,V);
}

// T42: spinner in the middle of the visible map while the cloud SUMO run computes (T48: the whole hour, about a minute)
function drawSumoWait(){
  const I=GL.ins,mx=(I.l+V.w-I.r)/2,my=(I.t+V.h-I.b)/2,el=SU.busy?Math.round((performance.now()-SU.t0)/1000):0,w0=sumoWin();
  const t1=L(`SUMO simulating ${w0} in the cloud · ${el} s (about 1 min)`,`SUMO 正在云端模拟 ${w0} · ${el} s（约 1 分钟）`),t2=L(`real CBD network · seed ${SU.seed}`,`真实 CBD 路网 · seed ${SU.seed}`);
  ctx.save();ctx.font=`600 12px ${FONT_MONO}`;const w=Math.max(ctx.measureText(t1).width,ctx.measureText(t2).width)+72,h=58;
  ctx.fillStyle=TK.glass;ctx.strokeStyle=TK.glassLine;rr(ctx,mx-w/2,my-h/2,w,h,10);ctx.fill();ctx.stroke();
  const cx=mx-w/2+28,a=performance.now()/1000*5;ctx.lineWidth=3;ctx.strokeStyle=TK.line2||TK.fg3;ctx.beginPath();ctx.arc(cx,my,11,0,7);ctx.stroke();
  ctx.strokeStyle=TK.works;ctx.beginPath();ctx.arc(cx,my,11,a,a+1.9);ctx.stroke();
  ctx.fillStyle=TK.fg||TK.accent;ctx.textAlign='left';ctx.textBaseline='middle';ctx.fillText(t1,cx+22,my-9);
  ctx.font=`400 10.5px ${FONT_MONO}`;ctx.fillStyle=TK.fg3;ctx.fillText(t2,cx+22,my+10);ctx.restore();
}

/* ---------- workflow ---------- */
const CLOCK_EVENT=23*60+40;
function newStress(layout){const s=new Sim(layout,{script:true,t0:45,seed:4218,clock0:CLOCK_EVENT-45});s.setWeather(S.wx,WX);while(s.t<44.95)s.step(.05);s.resetStats();return s;}
/* Junction micro-sim (4b-grid.js): in step 2, when the plan's works link lies inside GRID_BOX, the page runs a 4×4 grid of
   real junctions around it and shows only the 2×2 at the works, instead of the scripted La Trobe scene. Missing file or a
   throw → the La Trobe scene, as before. */
function gridOn(){return typeof GridSim==='function'&&!!(BE.api&&engNet())&&S.step===2&&!!EP.pts&&EP.pts.every(p=>p[0]>=GRID_BOX.x0&&p[0]<=GRID_BOX.x1&&p[1]>=GRID_BOX.y0&&p[1]<=GRID_BOX.y1);}
function newGrid(){try{const s=new GridSim(gridSpec([...engNet().links.values()],BE.api.engine.flows,EP.hour,{link:EP.link,lanes:EP.lanes}),{seed:4218});s.setWeather(S.wx,WX);while(s.t<180)s.step(.25);s.resetStats();s.clock0=CLOCK_EVENT-s.t;return s;}catch(e){console.warn('grid sim failed, showing the La Trobe scene',e);return null;}}
function gridShown(){return S.step===2&&!!(S.sim&&S.sim.isGrid);}
// Step 2 framing (T49): the whole 4×4 the sim runs — all 16 junctions (Elizabeth–Exhibition × La Trobe–Little Bourke) and
// their crossings — clear of the panels (fitView); no spec yet → the 2×2 at the works as before
function gridFit(){
  const J=(S.sim&&S.sim.spec&&S.sim.spec.junctions)||[];if(!J.length)return null;
  const xs=J.map(j=>j.x),ys=J.map(j=>j.y),m=34; // m: half a street + the zebra, so the edge streets show whole
  return fitView(Math.min(...xs)-m,Math.max(...xs)+m,Math.min(...ys)-m,Math.max(...ys)+m,3);
}
function gridFly(d){S.gridJ=null;const f=gridFit();if(f)flyTo(f[0],f[1],f[2],d);else flyTo((GRID_BOX.x0+GRID_BOX.x1)/2,(GRID_BOX.y0+GRID_BOX.y1)/2,Math.max(1,Math.min(3,(V.w-420)/420)),d);}
function gridRebuild(){if(S.step!==2)return;if(S.sim&&S.sim.isSumo&&sumoWant())return; // engine plan changed while on step 2 (T40: the SUMO replay only depends on the works link)
  const was=gridShown(),g=gridOn()&&newGrid();if(!g){if(S.sim&&S.sim.isSumo&&SU.grid){SU.tok++;S.sim=SU.grid;renderPanel();}return;}g.clock0=S.clock-g.t;S.sim=g;if(!was)gridFly(.7);renderPanel();sumoStart();}
function gridNote(){const w=S.sim.works(),q=w&&isFinite(w.queue_m)?w.queue_m:null,hr=engHour(EP.hour);return L(`Micro-sim · 16 junctions (La Trobe – Little Bourke × Elizabeth – Exhibition), weekday ${hr} flows · counts below cover the 2×2 at the works · signal timing and turn shares are assumed`,`微观仿真 · 16 个路口（La Trobe – Little Bourke × Elizabeth – Exhibition），工作日 ${hr} 车流 · 下面的计数只算施工处 2×2 · 信号配时和转弯比例是假设值`)+(q==null?'':` · ${L('works queue','施工排队')} <span data-live="gq">${Math.round(q)}</span> m`);}
// closed-lane polygons (works hatch, T38: halo + pulsing outline + a label so the closure stands out among 16 junctions)
// and signal heads (green / amber / red) of all 16 junctions
function drawJunctions(sim,noHeads){
  if(!sim||!sim.isGrid)return;ctx.save();
  if(S.layers.works){
    const w=sim.works(),polys=((w&&w.polys)||[]).filter(p=>p&&p.length>=3),pulse=.5+.5*Math.sin(performance.now()/380);let cx=0,cy=0,n=0;
    const path=poly=>{ctx.beginPath();poly.forEach((p,i)=>i?ctx.lineTo(V.X(p[0]),V.Y(p[1])):ctx.moveTo(V.X(p[0]),V.Y(p[1])));ctx.closePath();};
    for(const poly of polys){
      path(poly);ctx.lineJoin='round';ctx.strokeStyle=TK.works;ctx.globalAlpha=.18+.22*pulse;ctx.lineWidth=Math.max(10,4*V.s);ctx.stroke();ctx.globalAlpha=1;
      ctx.fillStyle=TK.worksTint;ctx.fill();ctx.fillStyle=PAT.hatch;ctx.fill();ctx.strokeStyle=TK.works;ctx.lineWidth=2;ctx.stroke();
      for(const p of poly){cx+=p[0];cy+=p[1];n++;}
    }
    if(n){const cl=sim.spec.close,px=V.X(cx/n),py=V.Y(cy/n);drawTag(ctx,px,py,0,-34,L(`WORKS · ${shortSt(EP.street)||'Lonsdale'} · ${cl&&cl.all?'all lanes':(cl?cl.n:1)+((cl?cl.n:1)>1?' lanes':' lane')} closed`,`施工 · ${shortSt(EP.street)||'Lonsdale'} · ${cl&&cl.all?'全封':'封 '+(cl?cl.n:1)+' 条道'}`),TK.works);}
  }
  const r=Math.max(2.5,.9*V.s),col={G:TK.light?'#2e8c50':'#3f9b5a',A:TK.works,R:TK.risk};
  if(!noHeads)for(const h of sim.signalHeads()){const px=V.X(h.x),py=V.Y(h.y);if(px<-20||py<-20||px>V.w+20||py>V.h+20)continue;ctx.fillStyle=col[h.state]||TK.fg3;ctx.strokeStyle=TK.light?'#fff':'#0b1215';ctx.lineWidth=1;ctx.beginPath();ctx.arc(px,py,r,0,7);ctx.fill();ctx.stroke();}
  // hovered junction: ring + name + "click to zoom"; the one zoomed in on: its name (gridBindMap)
  const J=id=>id&&sim.spec.junctions.find(j=>j.id===id),fo=J(S.gridJ),I=GL.ins,on=fo&&V.s>=2.5&&Math.hypot(V.X(fo.x)-(I.l+V.w-I.r)/2,V.Y(fo.y)-(I.t+V.h-I.b)/2)<160,hv=J(S.gridHover); // on: still zoomed in on it (near the middle of the open map)
  const nm=j=>`${shortSt(j.ew)} × ${shortSt(j.ns)}`.toUpperCase();
  if(hv&&!(on&&hv===fo)){const px=V.X(hv.x),py=V.Y(hv.y),ring=Math.max(14,24*V.s);ctx.setLineDash([5,4]);ctx.strokeStyle=TK.fg;ctx.globalAlpha=.85;ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(px,py,ring,0,7);ctx.stroke();ctx.setLineDash([]);ctx.globalAlpha=1;
    drawTag(ctx,px,py-ring,0,-18,`${nm(hv)} · ${L('click to zoom','点击放大')}`,TK.fg);}
  if(on)drawTag(ctx,V.X(fo.x),V.Y(fo.y)-Math.max(14,24*V.s),0,-18,`${nm(fo)} · SCATS ${fo.id} · ${L('click again to zoom out','再点一次缩小')}`,TK.fg);
  ctx.restore();
}
// Step 2 (4×4): a click (not a drag) on a junction flies in on it; ⌖ (gridFly) goes back to all 16 (09-30 ask). Junctions sit
// 100+ page units apart, so anything within 45 of one is that junction, at any zoom
function gridPick(px,py){
  if(!gridShown()||!S.sim.spec)return null;const x=V.wx(px),y=V.wy(py);let best=null,bd=45;
  for(const j of S.sim.spec.junctions){const d=Math.hypot(j.x-x,j.y-y);if(d<bd){bd=d;best=j;}}return best;
}
function gridFocus(j){const I=GL.ins;S.gridJ=j.id;flyTo(j.x,j.y,clamp((V.w-I.l-I.r)/150,3,9),.8);}
function gridBindMap(){
  let down=null,pending=0;
  cv.addEventListener('pointermove',e=>{const j=e.buttons?null:gridPick(e.offsetX,e.offsetY),id=j?j.id:null;if(id!==S.gridHover){S.gridHover=id;cv.style.cursor=id?'pointer':'';}});
  cv.addEventListener('pointerleave',()=>{S.gridHover=null;cv.style.cursor='';});
  cv.addEventListener('pointerdown',e=>{clearTimeout(pending);down=[e.offsetX,e.offsetY];});
  cv.addEventListener('dblclick',()=>clearTimeout(pending)); // a double-click zooms (bindInput), not a pick
  cv.addEventListener('pointerup',e=>{const d=down;down=null;if(!d||Math.hypot(e.offsetX-d[0],e.offsetY-d[1])>5)return;
    const j=gridPick(e.offsetX,e.offsetY);if(j)pending=setTimeout(()=>{if(!gridShown())return;if(S.gridJ===j.id&&V.s>=2.5)gridFly(.8);else gridFocus(j);},250);}); // again → back out
}
/* Step 2 on the real network (T40, 4c-sumo.js): on the Lonsdale demo works the grid sim above starts at once, then the page
   swaps in a SUMO replay on the real CBD network — the baked run (/sumo/public/real/) first; "Re-run live" asks the cloud for
   a fresh one (sumo-client.js falls back to the baked copy on any failure and says why). Chips switch the shown scenario.
   Missing client / baked index / a throw → the grid sim stays, one console.info line. The pill reads the source of the replay
   on screen (S.sim.src, set from what the client returned), so a baked replay is never labelled live. */
const SU={cli:null,cliP:null,mod:null,ref:{source:'baked'},src:{source:'baked'},index:null,baked:null,scen:'original',grid:null,tok:0,busy:false,t0:0,liveKey:'',liveAt:0,seed:42,failed:false};
const sumoErr=e=>e&&e.code?`${e.code}: ${String(e.message||'').slice(0,120)}`:String((e&&e.message)||e).slice(0,160); // one short line (a 404 page body is long)
function sumoWant(){return typeof SumoReplay==='function'&&gridOn()&&EP.link===SUMO_LINK&&!EP.all&&EP.lanes===1;} // the replay closes 1 lane of this link
// T48: the hour SUMO simulates, "08:00–09:00" — index.params.hour_window of the run on hand, else index.hour, else 8
function sumoWin(idx){const I=idx||SU.index,w=I&&I.params&&I.params.hour_window,h=I&&isFinite(+I.hour)?+I.hour:8,a=Array.isArray(w)&&w.length===2&&isFinite(+w[0])&&isFinite(+w[1])?[+w[0],+w[1]]:[h,h+1];
  return`${engHour(a[0]%24)}–${engHour(a[1]%24)}`;}
const sumoNap=ms=>new Promise(r=>setTimeout(r,ms));
// T50: one cloud SUMO job at a time from this page — step 2's runReal and 04's runOptions (8-compare.js cmpSuJob) queue here:
// fn starts once the job before it has settled (the Worker answers 429 sumo_busy at 2 active jobs, and two runs share the
// container's 4 cores). A step-2 run in progress → 04's run waits for it, then runs
let sumoTail=Promise.resolve();
function sumoLane(fn){const run=sumoTail.then(()=>fn());sumoTail=run.then(()=>{},()=>{});return run;}
function sumoClient(){
  if(!SU.cliP)SU.cliP=import('/sumo/public/js/sumo-client.js').then(m=>{SU.mod=m;SU.cli=typeof m.createSumoClient==='function'?m.createSumoClient():m;return SU.cli;},e=>{SU.cliP=null;throw e;});
  return SU.cliP;
}
async function sumoStart(){
  if(!sumoWant())return;SU.failed=false;const tok=++SU.tok;
  try{await sumoClient();}catch(e){if(tok!==SU.tok)return;SU.failed=true;renderPanel();console.info('SUMO client unavailable, keeping the browser grid sim:',sumoErr(e));return;}
  if(tok!==SU.tok)return;
  if(!sumoStale()){try{await sumoPlay(tok);return;}catch(e){if(tok!==SU.tok)return;}} // this plan + seed ran live in the last 10 min
  return sumoRerun(); // T42: nothing pre-computed first — spinner until the cloud run is done, then play that run
}
// Pre-computed copy, only when the cloud run failed (labelled with the reason on screen)
async function sumoBaked(reason){
  const r=await SU.cli.loadReal();if(!r||!r.index)throw new Error('no baked index');
  SU.index=SU.baked=r.index;SU.ref={source:'baked'};SU.src={source:'baked',reason:reason||'network',seed:r.index.seed};
}
// Manifest + the chunk at the playhead of SU.scen → swap S.sim (same camera), then the rest of the hour in the background (sumoFeed)
async function sumoPlay(tok){
  const c=SU.cli,ref=SU.ref,scen=SU.scen,idx=SU.index,base=S.sim&&S.sim.isGrid&&!S.sim.isSumo?S.sim:SU.grid;
  if(!c||!idx||!base||!base.spec)throw new Error('no client, index or grid spec');
  if(idx.works&&idx.works.link&&idx.works.link!==EP.link)throw new Error('the replay is for another works link');
  const man=await c.realManifest(ref,scen);if(tok!==SU.tok)return;
  const ch=man&&man.chunks;if(!Array.isArray(ch)||!ch.length)throw new Error('manifest has no chunks'); // T48: baseline is metrics only ("chunks": []) — never played
  const R=new SumoReplay(idx,scen,man,{spec:base.spec,polys:base.works().polys,src:Object.assign({},SU.src)});
  // switching plan (chips) keeps the moment on screen: the replay seeks there first, so want() names the chunk holding it
  const keepT=S.sim&&S.sim.isSumo?S.sim.t:0;if(keepT)R.seek(keepT);
  for(let n=0;!R.ready&&n<=ch.length;n++){const k=R.want();if(k<0)break;R.addChunk(k,await c.realChunk(ref,scen,ch[k]));if(tok!==SU.tok)return;} // the chunk entry: the client checks its sha256
  if(!gridShown()||!sumoWant())return;
  if(!R.ready)throw new Error('first chunk has no frames');
  SU.grid=base;S.sim=R;S.clock=R.clock();renderPanel();
  sumoFeed(R,tok,ref,scen,ch).catch(e=>console.info('SUMO: loading stopped:',sumoErr(e)));
}
// T48: loads what the replay on screen names (R.want(): the playhead's chunk and the two after it, then the rest of the hour in
// time order; later, chunks it dropped to save memory as the playhead nears them again) until it leaves the screen or a newer
// request takes over. The first pass missing 3 times in a row → the replay ends at what arrived; a dropped chunk that will not
// come back → the playhead waits there (the timeline still seeks elsewhere)
async function sumoFeed(R,tok,ref,scen,ch){
  let miss=0;
  while(tok===SU.tok&&S.sim===R){
    const k=R.want();
    if(k<0){if(R.complete&&!R.nDropped)return;await sumoNap(400);continue;}
    try{const d=await SU.cli.realChunk(ref,scen,ch[k]);if(tok!==SU.tok||S.sim!==R)return;R.addChunk(k,d);miss=0;}
    catch(e){if(tok!==SU.tok)return;miss++;
      if(miss>=3&&!R.cF[k]){R.truncate();miss=0;console.info('SUMO: later chunks unavailable, playing what arrived:',sumoErr(e));}
      else await sumoNap(Math.min(5000,500*miss));}
  }
}
function sumoScen(id){if(id===SU.scen)return;SU.scen=id;renderPanel();const tok=++SU.tok;sumoPlay(tok).catch(e=>{if(tok===SU.tok)console.info('SUMO scenario switch failed:',sumoErr(e));});}
// Detour share for the AI plan: the engine's advisor comparison when it has one (step 04), else 0.53 (USE RUSSELL / SAVE 9 MIN)
function sumoPAi(){const c=EP.cmp,p=c&&c.before&&c.delta?c.before.detour_share+c.delta.detour_share:NaN;return isFinite(p)&&p>=0&&p<=1?Math.round(p*1000)/1000:.53;}
// T41: a live run is due unless this plan (its AI detour share) was computed live in the cloud in the last 10 minutes
const sumoKey=()=>`${SU.seed}|${sumoPAi()}`;
function sumoStale(){return !(SU.ref.source==='live'&&SU.index&&SU.liveKey===sumoKey()&&performance.now()-SU.liveAt<600000);}
async function sumoRerun(){
  if(SU.busy||!sumoWant())return;
  if(!SU.cli){try{await sumoClient();}catch(e){SU.failed=true;renderPanel();return;}}
  if(typeof SU.cli.runReal!=='function'){SU.failed=true;renderPanel();return;}
  const tok=++SU.tok,seed=SU.seed;SU.busy=true;SU.failed=false;SU.t0=performance.now();
  if(S.sim&&S.sim.isSumo&&SU.grid)S.sim=SU.grid; // T42: the old run leaves the screen while the new one computes
  renderPanel();
  let r=null;
  try{r=await sumoLane(()=>SU.cli.runReal({seed,p_original:.14,p_ai:sumoPAi()},{timeoutMs:180000}));} // T48: the whole hour takes ~40–60 s in the cloud; T50: after any 04 run in flight
  catch(e){console.info('SUMO run failed:',sumoErr(e));}
  SU.busy=false;if(tok!==SU.tok)return;
  try{
    if(r&&r.index&&r.source==='live'&&r.runId){SU.index=r.index;SU.ref={source:'live',runId:r.runId};SU.src={source:'live',elapsedMs:r.elapsedMs,seed};SU.liveKey=sumoKey();SU.liveAt=performance.now();
      if(typeof cmpPrefetch==='function')cmpPrefetch(seed);} // T50: 04's options run starts now in the background (not awaited), so 04 opens on it
    else if(r&&r.index){SU.index=SU.baked=r.index;SU.ref={source:'baked'};SU.src={source:'baked',reason:r.reason||'network',seed:r.index.seed};}
    else await sumoBaked(r&&r.reason);
    if(!gridShown()||!sumoWant())return;
    try{await sumoPlay(tok);}
    catch(e){if(SU.ref.source!=='live')throw e;console.info('SUMO live files unavailable, playing the pre-computed run:',sumoErr(e));await sumoBaked('not_found');await sumoPlay(tok);}
  }catch(e){if(tok!==SU.tok)return;SU.failed=true;console.info('SUMO unavailable, keeping the browser grid sim:',sumoErr(e));}
  renderPanel();
}
// T48: the queue through the hour, minute by minute (metrics.queue_series [[minute, physical m, engine-method m] …]), next to
// the engine's point queue — constant demand over constant capacity, so it grows in a straight line to its number at the end
// of the hour (eg). Inline SVG, colours from the theme; '' when the series is missing or too short
function sumoQChart(qs,eg,w0){
  if(!Array.isArray(qs)||qs.length<2)return'';
  const Q=qs.filter(r=>Array.isArray(r)&&isFinite(+r[0])&&isFinite(+r[1])&&isFinite(+r[2])).map(r=>[+r[0],+r[1],+r[2]]);if(Q.length<2)return'';
  const W=240,H=56,m1=Math.max(60,Q[Q.length-1][0]),top=Math.max(1,eg>0?eg:0,...Q.map(r=>Math.max(r[1],r[2])))*1.08;
  const X=v=>(v/m1*W).toFixed(1),Y=v=>(H-v/top*H).toFixed(1),pl=k=>Q.map(r=>`${X(r[0])},${Y(r[k])}`).join(' '),[a,b]=w0.split('–');
  return`<svg class="sumo-qchart" viewBox="0 0 ${W} ${H+12}" role="img" aria-label="${L(`Works queue ${w0}: SUMO counted the engine's way, SUMO on Lonsdale, and the engine`,`${w0} 施工排队：SUMO（引擎算法）、SUMO（Lonsdale 上实际）、引擎`)}">
    <line x1="0" y1="${H}" x2="${W}" y2="${H}" class="ax"/>${eg>0?`<line x1="0" y1="${H}" x2="${W}" y2="${Y(eg)}" class="eng"/>`:''}
    <polyline points="${pl(1)}" class="phys"/><polyline points="${pl(2)}" class="equiv"/>
    <text x="0" y="${H+10}">${a}</text><text x="${W}" y="${H+10}" text-anchor="end">${b}</text></svg>
    <div class="sumo-qkey small"><span><i class="equiv"></i>${L('SUMO · engine method','SUMO · 引擎算法')}</span><span><i class="phys"></i>${L('SUMO · on Lonsdale','SUMO · Lonsdale 上实际')}</span>${eg>0?`<span><i class="eng"></i>${L('Engine (point queue)','引擎（点排队）')}</span>`:''}</div>`;
}
// T47: step 3 shows the SUMO run from step 2 (the one on screen: live or pre-computed, with its seed) above the engine's
// numbers, so a SUMO run is visibly used and the two models are not confused. T48: SUMO runs the whole hour too, so the table
// leads with its 09:00 queue counted the engine's way (works_queue_equiv_end_m) and the physical queue on Lonsdale then,
// and one sentence sets it against the engine's queue at 09:00 (s: the engine summary step 3 shows) — all from the data. The
// sentence sits outside the foldable block, so the compact panel (7-glass.js folds tall blocks) still shows it; an older
// replay without those fields (12 minutes) keeps the T47 columns and note
function sumoImpactHTML(s){
  if(EP.link!==SUMO_LINK||EP.all||EP.lanes!==1)return'';
  const idx=SU.index,src=SU.src||{};
  if(!idx||!Array.isArray(idx.scenarios))return`<div class="card eng-note sumo-impact"><b>${L('SUMO','SUMO')}</b><span>${L('Run SUMO in step 2 to see its result for this plan here, next to the engine estimate.','在第 2 步跑一次 SUMO，这里会并排显示它对这个方案的结果。')}</span></div>`;
  const sc=id=>idx.scenarios.find(x=>x.id===id)||{},m=id=>sc(id).metrics||null,n=v=>v!=null&&isFinite(+v),r=v=>n(v)?fmtN(Math.round(+v)):'—';
  const live=src.source==='live'&&isFinite(src.elapsedMs),sd=isFinite(src.seed)?src.seed:idx.seed;
  const tag=live?L(`Cloud SUMO · computed live · ${(src.elapsedMs/1000).toFixed(1)} s · seed ${sd}`,`云端 SUMO · 现场计算 · ${(src.elapsedMs/1000).toFixed(1)} s · seed ${sd}`):L(`SUMO · pre-computed · seed ${sd}`,`SUMO · 预先跑好 · seed ${sd}`);
  const P=idx.params||{},mo=m('original'),hour=!!(mo&&n(mo.works_queue_equiv_end_m)),w0=sumoWin(idx),end=w0.split('–')[1];
  const ex=x=>{const e=n(x.works_traffic_extra_s)?x.works_traffic_extra_s:x.mean_extra_s;return n(e)?(e>0?'+':'')+Math.round(e)+' s':'—';};
  const row=(id,name)=>{const x=m(id);if(!x)return'';
    const q=hour?`<td class="k">${r(x.works_queue_equiv_end_m)} m</td><td>${r(x.works_queue_end_m)} m</td><td>${r(x.works_queue_max_m)} m</td>`:`<td>${r(x.works_queue_max_m)} / ${r(x.works_queue_mean_m)} m</td>`;
    return`<tr${id===SU.scen?' class="cur"':''}><th scope="row">${name}</th>${q}<td>${ex(x)}</td><td>${r(x.detour_vehicles)}</td></tr>`;};
  const th=hour?`<th>${L(`${end} queue (engine method)`,`${end} 排队（引擎算法）`)}</th><th>${L(`Physical queue on Lonsdale at ${end}`,`${end} Lonsdale 上实际排队`)}</th><th>${L('Max (physical)','最长（实际）')}</th>`:`<th>${L('Works queue max / mean','施工排队 最长 / 平均')}</th>`;
  let note,cmpP='';
  if(hour){
    const eq=+mo.works_queue_equiv_end_m,eg=s&&n(s.queue_m)?+s.queue_m:null,ps=n(sc('original').diversion_share)?pctS(+sc('original').diversion_share):null,pe=s&&n(s.detour_share)?pctS(+s.detour_share):null;
    const cmp=eg==null?'':eg>0?L(`At ${end}, SUMO's original plan holds ${fmtN(Math.round(eq))} m of queue counted the engine's way (vehicles held up by the works × 7 m ÷ 2 lanes) — ${Math.round(eq/eg*100)}% of the engine's ${fmtN(Math.round(eg))} m below${ps&&pe&&ps!==pe?` (detour share: SUMO ${ps}, engine ${pe})`:''}.`,`${end} 时，SUMO 原方案按引擎算法（被施工拦住的车 × 7 m ÷ 2 条道）排队 ${fmtN(Math.round(eq))} m，是下面引擎 ${fmtN(Math.round(eg))} m 的 ${Math.round(eq/eg*100)}%${ps&&pe&&ps!==pe?`（绕行比例：SUMO ${ps}，引擎 ${pe}）`:''}。`)
      :L(`At ${end}, SUMO's original plan holds ${fmtN(Math.round(eq))} m of queue counted the engine's way; the engine below has no queue this hour.`,`${end} 时，SUMO 原方案按引擎算法排队 ${fmtN(Math.round(eq))} m；下面的引擎这个小时不排队。`);
    const cap=n(mo.works_capacity_assumption_vph)?fmtN(Math.round(+mo.works_capacity_assumption_vph)):null,thr=n(mo.works_throughput_vph)?fmtN(Math.round(+mo.works_throughput_vph)):null;
    const g=n(P.green_2935)?Math.round(+P.green_2935<=1?+P.green_2935*100:+P.green_2935):null,ext=P.network_extent?esc(String(L(P.network_extent,P.network_extent_zh||P.network_extent))):'';
    const how=L(`SUMO simulated ${w0} in full${ext?` (network: ${ext})`:''}${g!=null?`, signal 2935 at ${g}% green`:''}${cap?`; works capacity assumed ${cap} veh/h, as in the engine`:''}${thr?`, ${thr} vehicles actually got through the works in the hour`:''}.`,
      `SUMO 完整模拟了 ${w0}${ext?`，路网：${ext}`:''}${g!=null?`，2935 信号 ${g}% 绿灯`:''}${cap?`；施工段通行能力按 ${cap} 辆/时假设，和引擎一样`:''}${thr?`，这一小时实际过了施工段 ${thr} 辆`:''}。`);
    note=`<p class="small eng-assume">${how} ${L('Both are models — a cross-check, not measured proof.','两个都是模型，是交叉验证，不是实测证据。')}</p>`;
    if(cmp)cmpP=`<div class="sumo-cmp"><p class="small">${cmp}</p>${sumoQChart(mo.queue_series,eg,w0)}</div>`;
  }else note=`<p class="small eng-assume">${L('Why the engine says more: SUMO covers the 16 junctions around the works for ~12 minutes with signal 2935 assumed 70% green; the engine below covers the whole CBD for a full hour at 50% green, so its queue keeps growing through the hour. Both are models — a cross-check, not measured proof.','为什么引擎的数大：SUMO 只算施工附近 16 个路口、约 12 分钟，2935 信号按 70% 绿灯假设；下面的引擎算整个 CBD、整整 1 小时、50% 绿灯，排队会在这一小时里一直变长。两个都是模型，是交叉验证，不是实测证据。')}</p>`;
  return`<div class="stack sumo-impact"><div class="row between"><span class="eyebrow">${L('SUMO · this run from step 2','SUMO · 第 2 步这一次的结果')}</span><span class="pill${live?' ok':''}">${tag}</span></div>
    <div class="sumo-imp-wrap"><table class="sumo-imp${hour?' hour':''}"><thead><tr><th></th>${th}<th>${L('Extra per vehicle through the works','过施工段每车多花')}</th><th>${L('Detoured','绕行的车')}</th></tr></thead>
    <tbody>${row('original',L('Original · ROADWORK AHEAD','原方案 · ROADWORK AHEAD'))}${row('ai',L('AI plan · USE RUSSELL','AI 方案 · USE RUSSELL'))}</tbody></table></div>
    ${note}</div>${cmpP}`;
}
// T47: pick the seed BEFORE the run — on 01 Configure, right above “Save & simulate”; entering step 2 runs SUMO with it
function sumoPreHTML(){
  if(!BE.api||EP.link!==SUMO_LINK||EP.all||EP.lanes!==1)return'';
  return`<div class="stack sumo-pre"><span class="eyebrow">${L('SUMO · step 2 runs in the cloud with this seed','SUMO · 第 2 步用这个种子在云端算')}</span>
    <div class="row sumo-seed"><label class="eyebrow" for="sumoSeedPre">${L('Seed','种子')}</label><input id="sumoSeedPre" type="number" inputmode="numeric" min="0" max="2147483647" step="1" value="${SU.seed}"><button type="button" class="btn ghost" id="sumoDicePre">${L('Random','随机')}</button></div>
    <p class="small muted">${L('Same seed, same run (42 matches the pre-computed copy); change it to see how much the result varies.','同一个种子结果一样（42 和预先跑好的那份一致）；换种子看结果波动多大。')}</p></div>`;
}
function sumoPreBind(){
  const si=$('#sumoSeedPre');if(!si)return;
  const set=()=>{const v=Math.floor(+si.value);if(isFinite(v)&&v>=0&&v<=2147483647)SU.seed=v;else si.value=SU.seed;};
  si.onchange=set;si.oninput=set;
  const dz=$('#sumoDicePre');if(dz)dz.onclick=()=>{SU.seed=Math.floor(Math.random()*2147483647);si.value=SU.seed;};
}
const sumoReason=k=>SU.mod&&typeof SU.mod.reasonLabel==='function'?SU.mod.reasonLabel(k,LANG.cur):k;
function sumoNote(){const R=S.sim,v=(/(\d+\.\d+\.\d+)/.exec((R.index&&R.index.engine)||'')||[0,'1.27.1'])[1],h=String(R.hour).padStart(2,'0'),A=R.index&&R.index.assumptions,as=A&&(LANG.cur==='zh'?A.zh:A.en);
  const full=R.dur>=1800?` · ${sumoWin(R.index)}`:''; // T48: the whole hour
  return`<p class="eng-assume"${Array.isArray(as)&&as.length?` title="${esc(as.join(' · '))}"`:''}>${L(`SUMO ${v} · real CBD network (OSM) + SCATS ${h}:00 flows${full} · signal timing and turn shares assumed`,`SUMO ${v} · 真实 CBD 路网（OSM）+ SCATS ${h}:00 车流${full} · 信号配时和转弯比例是假设值`)}</p>`;}
// Source of the replay on screen: live only when the client said so for this very run
function sumoPill(){const s=S.sim.src||{},sd=isFinite(s.seed)?` · seed ${s.seed}`:'';
  if(s.source==='live'&&isFinite(s.elapsedMs))return`<span class="pill ok" data-sumo-src="live">${L('Cloud SUMO · computed live','云端 SUMO · 现场计算')} · ${(s.elapsedMs/1000).toFixed(1)} s${sd}</span>`;
  return`<span class="pill" data-sumo-src="baked">${L('SUMO · pre-computed (cloud unavailable)','SUMO · 预先跑好的（云端没算成）')}${sd}</span>${s.reason?`<span class="small muted">${esc(sumoReason(s.reason))}</span>`:''}`;}
// Seed box + run button (T42): the lead picks the random seed; the same seed gives the same run
function sumoSeedHTML(){const dis=SU.busy?' disabled':'';
  return`<div class="row sumo-seed"><label class="eyebrow" for="sumoSeed">${L('Seed','种子')}</label><input id="sumoSeed" type="number" inputmode="numeric" min="0" max="2147483647" step="1" value="${SU.seed}"${dis}><button type="button" class="btn ghost" id="sumoDice"${dis}>${L('Random','随机')}</button><button type="button" class="btn sumo-run" id="sumoRerun"${dis}>${SU.busy?L('Computing…','计算中…'):L('▶ Run SUMO (~1 min)','▶ 运行 SUMO（约 1 分钟）')}</button></div>`;}
// While the cloud run computes: no cars from anywhere else, just a spinner (panel + map)
function sumoWaiting(){return gridShown()&&!!S.sim&&!S.sim.isSumo&&sumoWant()&&!SU.failed;}
function sumoWaitHTML(){const w0=sumoWin();return`<p class="eng-assume">${L('SUMO 1.27.1 · real CBD network (OSM) + SCATS 08:00 flows · signal timing and turn shares assumed','SUMO 1.27.1 · 真实 CBD 路网（OSM）+ SCATS 08:00 车流 · 信号配时和转弯比例是假设值')}</p>
    <div class="sumo-wait" role="status"><span class="spin" aria-hidden="true"></span><span>${L(`SUMO simulating ${w0} in the cloud`,`SUMO 正在云端模拟 ${w0}`)} · <span data-live="suEl">0</span> s ${L('(about 1 min)','（约 1 分钟）')}</span></div>${sumoSeedHTML()}`;}
function sumoCtl(){
  const have=new Set(((S.sim.index&&S.sim.index.scenarios)||[]).map(x=>x.id)),ch=[['original',L('Original plan · ROADWORK AHEAD','原方案 · ROADWORK AHEAD')],['ai',L('AI plan · USE RUSSELL','AI 方案 · USE RUSSELL')]].filter(([k])=>have.has(k));
  return`<div class="row sumo-src">${sumoPill()}</div>
    ${ch.length?`<div class="eng-seg sumo-seg" role="tablist" aria-label="${L('Plan shown','显示的方案')}">${ch.map(([k,n])=>`<button type="button" role="tab" data-sumo="${k}" aria-selected="${SU.scen===k}">${n}</button>`).join('')}</div>`:''}
    ${sumoSeedHTML()}`;
}
function sumoTiles(){const m=S.sim.metrics,ex=m.mean_extra_s,dv=m.detour_vehicles,okN=v=>v!=null&&isFinite(+v);
  return`<div class="metric"><span class="eyebrow">${L('Vehicles on map','地图上的车')}</span><div class="v"><span data-live="agents">0</span></div></div>
      <div class="metric"><span class="eyebrow">${L('Works queue now','施工排队（现在）')}</span><div class="v" style="color:var(--works)"><span data-live="gq">0</span><small>m</small></div></div>
      <div class="metric"><span class="eyebrow">${L('Extra time per vehicle','每车多花时间')}</span><div class="v">${okN(ex)?(ex>0?'+':'')+Math.round(ex):'—'}<small>${L('s vs no works','秒 · 比不施工')}</small></div></div>
      <div class="metric"><span class="eyebrow">${L('Detoured vehicles','绕行的车')}</span><div class="v">${okN(dv)?fmtN(dv):'—'}<small>${L('this run','本次')}</small></div></div>
      <div class="metric"><span class="eyebrow">${L('Harsh braking','急刹')}</span><div class="v"><span data-live="harsh">0</span><small>&gt; ${fmtN(-GRID_P.harsh/GRID_K*10)/10} m/s² · 2×2</small></div></div>
      <div class="metric"><span class="eyebrow">${L('Conflicts · critical','冲突 · 严重')}</span><div class="v" style="color:var(--fg-3)">—<small>${L('SUMO: not computed','SUMO 不算冲突')}</small></div></div>`;}
// T46: the replay's map marks (4c-sumo.js) — harsh braking only; conflicts / critical need the lanes the v2 samples lack: —, never 0
function sumoEvLegend(){const n=(S.sim.bins&&S.sim.bins.n)||2;
  return`<div class="eng-legend ev-legend"><span><i class="ev-dia"></i>${L('Harsh braking','急刹')}</span><span style="opacity:.6"><i class="ev-dia" style="background:var(--works)"></i>${L('Conflict','冲突')} — <i class="ev-dia" style="background:var(--risk)"></i>${L('Critical','严重')} — · ${L('SUMO: not computed','SUMO 不算冲突')}</span><span>${L(`map: last ${EV_KEEP_GRID} s · timeline: share of vehicles, per ${n} min`,`地图标最近 ${EV_KEEP_GRID} 秒 · 时间轴：每 ${n} 分钟车辆占比`)}</span></div>`;}
function sumoBind(){
  document.querySelectorAll('[data-sumo]').forEach(b=>b.onclick=()=>sumoScen(b.dataset.sumo));
  const si=$('#sumoSeed'),seedIn=()=>{const v=Math.floor(+(si&&si.value));if(isFinite(v)&&v>=0&&v<=2147483647)SU.seed=v;else if(si)si.value=SU.seed;};
  if(si)si.onchange=seedIn;
  const dz=$('#sumoDice');if(dz)dz.onclick=()=>{SU.seed=Math.floor(Math.random()*2147483647);if(si)si.value=SU.seed;};
  const rb=$('#sumoRerun');if(rb)rb.onclick=()=>{seedIn();sumoRerun();};
}
function activeSims(){if(!microOn())return[];return S.step===4?[S.sim,S.simAfter].filter(Boolean):S.sim?[S.sim]:[];}
function goStep(n){
  if(UI_STEP[S.ui]!==n)S.ui=UI_STEP.indexOf(n);S.step=n;S.booted=true;S.slow=0;$('#alert').hidden=true;$('#swipe').hidden=n!==4;S.simAfter=null;
  if(n===1){S.sim=new Sim('before',{seed:7});S.sim.setWeather(S.wx,WX);for(let i=0;i<1200;i++)S.sim.step(.05);S.sim.resetStats();S.sim.clock0=-S.sim.t;S.clock=0;S.playing=true;S.speed=2;if(engOn())engFly();else flyTo(HOME.cx,HOME.cy,HOME.s);}
  if(n===2){const g=gridOn()&&newGrid();if(g){S.sim=g;S.stress=null;S.event=null;S.alertShown=false;S.clock=CLOCK_EVENT;S.playing=true;S.speed=2;gridFly();sumoStart();}
    else{S.stress=newStress('before');S.sim=S.stress;S.event=null;S.alertShown=false;S.clock=CLOCK_EVENT;S.playing=true;S.speed=2;flyTo(-8,-4,4.2);}}
  if(n===3){
    if(!S.stress||!S.stress.critical){S.stress=S.stress&&S.stress.script?S.stress:newStress('before');let guard=0;while((!S.stress.critical||!S.stress.critical.frozen)&&guard++<3000)S.stress.step(.05);S.clock=CLOCK_EVENT+(S.stress.t-45);}
    else{let g2=0;while(!S.stress.critical.frozen&&g2++<200)S.stress.step(.05);}
    S.sim=S.stress;S.event=S.stress.critical;S.playing=false;S.replayT=0;if(S.event)S.nodes=causal(S.event);
    if(engOn()&&EP.tab3==='net')engFly();else if(S.event)flyTo(S.event.x+16,S.event.y+2,Math.min(8,V.w/150));
  }
  if(n===4){S.sim=newStress('before');S.simAfter=newStress('after');S.clock=CLOCK_EVENT;S.playing=true;S.speed=2;S.swipe=visibleMid();if(engOn())engFly();else flyTo(-48,-6,Math.max(3.2,Math.min(4.8,V.w/220)));engStep4();}
  updateSteps();renderPanel();
}
function causal(ev){
  const sn=ev.snaps,f=tag=>sn.map(h=>({t:h.t,a:h.a.find(q=>q.tag===tag)})).filter(o=>o.a);
  const C=f('C-17'),D=f('D-42'),B=f('BUS 250'),Z=LAYOUTS.before;
  const cm=(C.find(o=>o.a.y>-9)||C[0]||{a:{x:-22,y:-8,v:5}}).a;
  const dAt=(D.reduce((b,o)=>(!b||Math.abs(o.t-ev.t)<Math.abs(b.t-ev.t))?o:b,null)||{a:{x:-10,y:-6.6,v:13}}).a;
  let bmin=0,bp=null;for(const o of B){if(o.a.acc<bmin){bmin=o.a.acc;bp=o.a;}}if(!bp)bp=(B[B.length-1]||{a:{x:20,y:-6.6}}).a;
  ev.cv=cm.v;ev.dv=dAt.v;ev.bmin=bmin;
  const lane=Math.abs(Z.bx1+19).toFixed(0),cv=(cm.v*3.6).toFixed(0),dv=(dAt.v*3.6).toFixed(0),ttc=ev.ttc.toFixed(2),ins=Math.abs(ev.x-Z.bx1).toFixed(0),bk=(-bmin).toFixed(1);
  return[
    {x:Z.bx1,y:-7.8,c:TK.works,t:L('Barrier B-12 cuts the cycle lane','护栏 B-12 截断自行车道'),s:L(`Protected lane ends ${lane} m after the crossing`,`受保护车道在过街后 ${lane} m 处中断`)},
    {x:cm.x,y:cm.y,c:TK.aBike,t:L('Cyclist C-17 is pushed into traffic','骑行者 C-17 被迫并入机动车道'),s:L(`Merges at ${cv} km/h with no gap check`,`以 ${cv} km/h 并道，未判断车距`)},
    {x:dAt.x,y:dAt.y,c:TK.aCar,t:L('Unfamiliar driver D-42 reads VMS-1 late','不熟路的司机 D-42 看到 VMS-1 太晚'),s:L(`Sign sits ${Z.vms} m upstream · closes at ${dv} km/h`,`标志仅在上游 ${Z.vms} m · 以 ${dv} km/h 逼近`)},
    {x:ev.x,y:ev.y,c:TK.risk,t:L('Conflict point','冲突点'),s:L(`TTC ${ttc} s · ${ins} m inside the squeeze`,`TTC ${ttc} s · 位于收窄段内 ${ins} m`)},
    {x:bp.x,y:bp.y,c:TK.aBus,t:L('Bus 250 brakes hard behind','后方 250 路公交急刹'),s:bmin<-.5?L(`Peak braking ${bk} m/s² · queue spills into the junction`,`峰值减速 ${bk} m/s² · 排队溢入路口`):L('Queue spills back toward the junction','排队向路口回溢')}];
}
function onCritical(){
  const ev=S.sim.critical;flyTo(ev.x+18,ev.y+4,Math.min(6.4,V.w/140));
  $('#alert').hidden=false;renderAlert();renderPanel();
}
function renderAlert(){
  const al=$('#alert');if(al.hidden||!S.sim||!S.sim.critical)return;const ev=S.sim.critical;
  al.innerHTML=`<div class="h"><i></i>${L('CRITICAL RIPPLE DETECTED','检测到严重涟漪')}</div><div class="ttl">${L('Cyclist × car × bus conflict','骑行者 × 小汽车 × 公交冲突')}</div><div class="m"><div><span>TTC</span><b>${ev.ttc.toFixed(2)} s</b></div><div><span>${L('CLOSING','接近速度')}</span><b>${((ev.v[0]-ev.v[1])*3.6).toFixed(0)} km/h</b></div></div><button type="button" class="btn danger" id="alertBtn" style="padding:10px 12px;font-size:13px">${L('Explain why →','查看原因 →')}</button>`;
  $('#alertBtn').onclick=()=>goStep(3);
}
function placeAlert(){const al=$('#alert');if(al.hidden||!S.sim||!S.sim.critical)return;const ev=S.sim.critical;let x=V.X(ev.x)+60,y=V.Y(ev.y)+40;const I=insets();x=clamp(x,I.l+14,V.w-I.r-al.offsetWidth-14);y=clamp(y,I.t+70,V.h-I.b-al.offsetHeight-14);al.style.left=x+'px';al.style.top=y+'px';}

/* ---------- panel ---------- */
const icon=(k,sz=16)=>`<svg width="${sz}" height="${sz}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${WX_ICON[k]}</svg>`;
const wxCol=k=>WX_META[k][TK.light?'light':'dark'];
function renderPanel(){
  const P=$('#panel'),wl=wxLabel(S.wx);syncMicro();updateScene();setWide(S.ui===4);
  if(S.step===1&&S.ui===0){ // 00 Overview
    P.innerHTML=overviewHTML()+navHTML();
    P.querySelectorAll('[data-preset]').forEach(b=>b.onclick=()=>{if(BE.api)engPreset(b.dataset.preset);goUi(1);});
  }else if(S.step===1){ // 01 Configure: Site / Signs / Checks
    const eng=!!BE.api&&!!EP.link,t=EP.tab1;
    const tabs1=`<div class="eng-seg eng-seg3" role="tablist" aria-label="${L('Plan setup','方案设置')}">${[['site',L('Site','施工信息')],['signs',L('Signs','设备诱导')],['checks',L('Checks','约束检查')]].map(([k,n])=>`<button type="button" role="tab" data-tab1="${k}" aria-selected="${t===k}">${n}</button>`).join('')}</div>`;
    P.innerHTML=`<div class="row between"><span class="eyebrow" style="color:var(--sun-ink)">${L('Roadwork plan · draft','施工方案 · 草稿')}</span>${engStatusPill()}</div>
    <div class="stack"><h2>${eng?L(`${esc(shortSt(EP.street)||'Unnamed road')} ${dirL(EP.dir)} ${EP.all?'full closure':'lane closure'}`,`${esc(shortSt(EP.street)||'无名道路')} ${dirL(EP.dir)}${EP.all?'全封':'封道'}`):L('La Trobe St westbound cycle-lane closure','La Trobe St 西行自行车道封闭')}</h2><p class="muted small">${eng?L('Place the closure, write the sign, pick the hour. The engine re-scores the plan on real CBD traffic as you type.','放好封道、写好屏上的字、选好时段，边改边由引擎在真实 CBD 车流上重算。'):L('40 m water-filled barrier and site hoarding outside Melbourne Central. Weekday peak 17:00–18:00, four-week programme.','在 Melbourne Central 门前设置 40 m 注水护栏和施工围挡。工作日晚高峰 17:00–18:00，工期四周。')}</p></div>
    ${BE.api?tabs1+(t==='signs'?engSignsHTML()+engStateSec()+vlabHTML():t==='checks'?checksHTML()+'<div id="engMore" class="stack eng-more"></div>':engSiteHTML()+engStateSec()):engOfflineCard()}
    ${microOn()&&t==='site'?`<div class="stack"><div class="row between"><span class="eyebrow">${L('Junction micro-model · La Trobe × Swanston','路口微观模型 · La Trobe × Swanston')}</span><span class="eyebrow">${L('4 items','4 项')}</span></div><div class="list">
      <div><i class="sw" style="background:var(--works)"></i><span class="grow">${L('Barrier B-12','护栏 B-12')}</span><span class="val">${L('40 m · bike lane + 1.4 m','40 m · 自行车道 + 1.4 m')}</span></div>
      <div><i class="sw" style="background:var(--works)"></i><span class="grow">${L('Site hoarding','施工围挡')}</span><span class="val">${L('leaves 1.1 m footpath','人行道只剩 1.1 m')}</span></div>
      <div><i class="sw" style="background:var(--works)"></i><span class="grow">VMS-1</span><span class="val">${L('60 m upstream','上游 60 m')}</span></div>
      <div><i class="sw" style="background:var(--a-bus)"></i><span class="grow">${L('Bus stop 250','250 路公交站')}</span><span class="val">${L('at the squeeze exit','位于收窄段出口')}</span></div></div></div>
    <div class="stack"><div class="row between"><span class="eyebrow">${L('Road users on the map now','地图上的道路使用者')}</span><span class="eyebrow" style="color:var(--sun-ink)" data-live="popTotal">—</span></div><div class="bars" id="popBars"></div></div>`:''}
    ${typeof sumoPreHTML==='function'?sumoPreHTML():''}${navHTML()}`;
    P.querySelectorAll('[data-tab1]').forEach(b=>b.onclick=()=>{EP.tab1=b.dataset.tab1;renderPanel();});
    const bi=$('#budgetIn');if(bi)bi.oninput=()=>{EP.budget=Math.max(0,+bi.value||0);};
    P.querySelectorAll('[data-keep]').forEach(c=>c.onchange=()=>{EP.keep[c.dataset.keep]=c.checked;renderPanel();});
    engBind1();vlMount();sumoPreBind();
  }else if(S.step===2){
    const crit=S.sim&&S.sim.critical,grid=gridShown(),su=grid&&!!S.sim.isSumo,wait=sumoWaiting();
    P.innerHTML=`<div class="row"><span class="dot pulse" id="stDot" style="background:var(--works)"></span><span class="eyebrow" id="stLabel" style="color:var(--works)"></span></div>
    <div class="stack"><h2>${L('Junction micro-simulation','路口微观仿真')}</h2>${su?sumoNote()+sumoCtl():wait?sumoWaitHTML():`<p class="eng-assume">${grid?gridNote():L(`La Trobe × Swanston, weekday 17:00, weather: ${wl.toLowerCase()} (illustrative). Road users follow a scripted scene; the counts below come from this one run — they are not the engine's numbers for the plan.`,`La Trobe × Swanston 路口，工作日 17:00，天气：${wl}（示意）。道路使用者按预设场景行动；下面的计数来自这一次仿真，不是方案的引擎数字。`)}</p>`}</div>
    <div class="metrics">${su?sumoTiles():wait?'':`
      <div class="metric"><span class="eyebrow">${L('Road users','道路使用者')}</span><div class="v"><span data-live="agents">0</span></div></div>
      <div class="metric"><span class="eyebrow">${L('Conflicts','冲突')}</span><div class="v" style="color:var(--works)"><span data-live="conf">0</span><small>TTC &lt; 1.5 s</small></div></div>
      <div class="metric"><span class="eyebrow">${L('Critical','严重')}</span><div class="v" style="color:var(--risk)"><span data-live="crit">0</span><small>TTC &lt; 1.0 s</small></div></div>
      <div class="metric"><span class="eyebrow">${L('Harsh braking','急刹')}</span><div class="v"><span data-live="harsh">0</span><small>&gt; ${grid?fmtN(-GRID_P.harsh/GRID_K*10)/10:'4.2'} m/s²</small></div></div>`}</div>
    ${grid&&!su&&!wait?`<div class="eng-legend ev-legend"><span><i class="ev-dia" style="background:var(--works)"></i>${L('Conflict','冲突')}</span><span><i class="ev-dia" style="background:var(--risk)"></i>${L('Critical','严重')}</span><span><i class="ev-dia"></i>${L('Harsh braking','急刹')}</span><span>${L(`map: last ${EV_KEEP_GRID} s · timeline: share of vehicles, per 10 min`,`地图标最近 ${EV_KEEP_GRID} 秒 · 时间轴：每 10 分钟车辆占比`)}</span></div>`:''}${su?sumoEvLegend():''}
    ${navHTML()}`;if(su||wait)sumoBind();
  }else if(S.step===3&&BE.api&&EP.tab3==='net'){
    P.innerHTML=engPanel3();engBindTabs3();engBind3();clashMount();aiMount();const rb=$('#repairBtn');if(rb)rb.onclick=()=>goStep(4);
  }else if(S.step===3){
    const ev=S.event;
    P.innerHTML=`<div class="row between"><span class="eyebrow" style="color:var(--sun-ink)">${L('Impact · R-03','影响 · R-03')}</span><span class="pill risk">${L('Critical','严重')} · TTC ${ev?ev.ttc.toFixed(2):'—'} s</span></div>${engTabs3()}
    <h2>${L('One barrier, three road users, one hidden conflict','一道护栏、三类道路使用者、一个隐藏冲突')}</h2>
    <div class="stack"><div class="row between"><span class="eyebrow">${L('Causal chain','因果链')}</span><span class="eyebrow">${L('replay −6 s → +2 s','回放 −6 s → +2 s')}</span></div><div class="chain" id="chain">${S.nodes.map((c,k)=>`<div class="c" data-k="${k}" tabindex="0"><div class="rail2"><span class="badge" style="--bc:${c.c}">${k+1}</span>${k<4?'<span class="ln"></span>':''}</div><div class="tx"><b${k===3?' style="color:var(--risk)"':''}>${c.t}</b><span>${c.s}</span></div></div>`).join('')}</div></div>
    <div class="stack"><span class="eyebrow">${L('Road users involved','涉及的道路使用者')}</span><div class="agents3">
      <div><b style="color:var(--a-bike)"><i class="dot" style="background:var(--a-bike)"></i>C-17</b><span>${L('Cyclist','骑行者')}</span><small>${ev&&ev.cv?(ev.cv*3.6).toFixed(0):'19'} km/h ${L('at merge','并道时')}</small></div>
      <div><b style="color:var(--a-car)"><i class="dot" style="background:var(--a-car)"></i>D-42</b><span>${L('Unfamiliar driver','不熟路的司机')}</span><small>${ev&&ev.dv?(ev.dv*3.6).toFixed(0):'48'} km/h ${L('at conflict','冲突时')}</small></div>
      <div><b style="color:var(--a-bus)"><i class="dot" style="background:var(--a-bus)"></i>BUS 250</b><span>${L('12.5 m rigid','12.5 m 单节公交')}</span><small>${ev&&ev.bmin<-.5?(-ev.bmin).toFixed(1)+L(' m/s² braking',' m/s² 减速'):L('follows 34 m back','跟随在后方 34 m')}</small></div></div></div>
    ${navHTML()}`;engBindTabs3();
    P.querySelectorAll('.chain .c').forEach(el=>{const k=+el.dataset.k;el.onmouseenter=el.onfocus=()=>{S.chainHover=k;el.classList.add('on');};el.onmouseleave=el.onblur=()=>{S.chainHover=-1;el.classList.remove('on');};el.onclick=()=>{const nd=S.nodes[k];flyTo(nd.x,nd.y,Math.max(V.s,7),.6);};});
  }else if(S.ui===5){ // 05 Export
    P.innerHTML=`${BE.api?'<div id="cmp4" class="stack cmp4"></div>':''}<div id="copyFallback"></div>${navHTML(`<button type="button" class="btn ghost" id="copyBtn">${L('Copy playbook','复制处置手册')}</button>`,L('Model estimates on real CBD flows · not field-validated','真实 CBD 车流上的模型估算 · 未经实地验证'))}`;
    $('#copyBtn').onclick=copyPlaybook;engRender4();
  }else{ // 04 Compare
    const micro=microOn();
    P.innerHTML=`${engPanel4()}${micro?`<div class="stack"><div class="row between"><span class="eyebrow" style="color:var(--sun-ink)">${L('Junction layout v2 · La Trobe × Swanston','路口方案 v2 · La Trobe × Swanston')}</span><span class="eyebrow">${L('micro-model','微观仿真')}</span></div><div class="stack" style="gap:8px">
      <div class="row"><span class="delta">Δ1</span><span class="small">${L('Shift barrier B-12 8 m west and narrow it by 0.9 m','护栏 B-12 西移 8 m，并收窄 0.9 m')}</span></div>
      <div class="row"><span class="delta">Δ2</span><span class="small">${L('Add a 17 m tapered cycle transition with a give-way line','增设 17 m 渐变自行车过渡段和让行线')}</span></div>
      <div class="row"><span class="delta">Δ3</span><span class="small">${L('Keep a 1.8 m step-free footpath corridor','保留 1.8 m 无障碍人行通道')}</span></div>
      <div class="row"><span class="delta">Δ4</span><span class="small">${L('Move VMS-1 80 m further upstream','VMS-1 再往上游移 80 m')}</span></div></div></div>
    <div class="card" style="padding:10px 12px"><div class="row between"><span class="eyebrow">${L('Conflicts in this run · before vs v2','本次仿真冲突数 · 原方案 vs v2')}</span><span class="mono small"><span style="color:var(--risk)" data-live="liveB">0</span> vs <span style="color:var(--accent)" data-live="liveA">0</span></span></div></div>`:''}
    ${navHTML(`<button type="button" class="btn ghost" id="swipeBtn" aria-pressed="${!$('#swipe').hidden}">${L('Swipe','滑动对比')}</button>`)}`;
    engRender4();$('#swipeBtn').onclick=()=>{const sw=$('#swipe');sw.hidden=!sw.hidden;S.swipe=sw.hidden?0:visibleMid();$('#swipeBtn').setAttribute('aria-pressed',String(!sw.hidden));};
  }
  P.querySelectorAll('.cta [data-go]').forEach(b=>b.onclick=()=>goUi(+b.dataset.go));
  updateLive(true);
}
// ---- 6-step workbench (09-30): Overview → Configure → Simulate →
// Impact → Compare → Export. S.ui is the step on screen; S.step (1–4) stays the map / engine / simulation mode under it
const UI_STEP=[1,1,2,3,4,4],UI_NEXT=[['Set up the plan →','配置施工 →'],['Save & simulate →','保存并进入仿真 →'],['See the impact →','查看影响分析 →'],['Compare plans →','比较方案 →'],['Confirm & export →','确认方案并导出 →'],null];
function goUi(n){n=clamp(n,0,5);S.ui=n;const st=UI_STEP[n];if(S.step===st){updateSteps();renderPanel();}else goStep(st);}
// the foot of every step: ← Back · (extra) · Next →
function navHTML(extra='',note=''){const n=S.ui,nx=UI_NEXT[n];return`<div class="cta"><div class="row nav-row">${n>0?`<button type="button" class="btn ghost nav-back" data-go="${n-1}">← ${L('Back','上一步')}</button>`:''}${extra}${nx?`<button type="button" class="btn nav-next" data-go="${n+1}">${L(nx[0],nx[1])}</button>`:''}</div>${note?`<span class="note">${note}</span>`:''}</div>`;}
// 04 Compare: the panel widens to the left for the comparison table (desktop); the glass insets follow, so the map and its
// controls stay in the open part
function setWide(on){
  const a=$('#app');on=on&&matchMedia('(min-width: 821px)').matches;
  if(on){const w=Math.round(Math.min(900,innerWidth-(GL.ins.l||84)-60));a.style.setProperty('--panel-w',w+'px');a.style.setProperty('--safe-r',(w+24)+'px');}
  else if(a.classList.contains('ui-wide')){a.style.removeProperty('--panel-w');a.style.removeProperty('--safe-r');}
  a.classList.toggle('ui-wide',on);readInsets();
}
function worksDates(){const loc=LANG.cur==='zh'?'zh-CN':'en-AU',o={day:'numeric',month:'short'},d=x=>new Date(x+'T00:00:00').toLocaleDateString(loc,o);return`${d(WORKS_TIME.from)} – ${d(WORKS_TIME.to)}`;}
// 00 Overview: where the next works go, the plans to pick up (the two demo plans) and the data under the map
function overviewHTML(){
  const n=typeof engNet==='function'&&engNet(),row=(k,v)=>`<div><i class="dot" style="background:var(--accent)"></i><span class="grow">${k}</span><span class="val">${v}</span></div>`;
  const kpi=(k,v,u)=>`<div class="metric"><span class="eyebrow">${k}</span><div class="v">${v}<small>${u}</small></div></div>`;
  const plans=[['lonsdale',L('Lonsdale St · 1 lane closed','Lonsdale St · 封一条道'),L(`weekday 08:00 · ${worksDates()}`,`工作日 08:00 · ${worksDates()}`)],['latrobe',L('La Trobe St · 1 lane closed','La Trobe St · 封一条道'),L(`weekday 17:00 · ${worksDates()}`,`工作日 17:00 · ${worksDates()}`)]];
  return`<div class="row between"><span class="eyebrow" style="color:var(--sun-ink)">${L('Planning workspace','规划工作台')}</span>${engStatusPill()}</div>
  <div class="stack"><h2>${L('Start from the network, plan the next works','从路网开始，规划下一处施工')}</h2><p class="muted small">${L('Pick a street on the map, then set up, simulate, compare and export the plan.','在地图上选路段，然后配置、仿真、比较、导出方案。')}</p></div>
  <div class="metrics">${kpi(L('Work zone','施工范围'),esc(shortSt(EP.street)||'—'),dirL(EP.dir))}${kpi(L('Scored hour','评价时段'),engHour(EP.hour),'– '+engHour(EP.hour+1))}</div>
  <div class="stack"><div class="row between"><span class="eyebrow">${L('Pick up a plan','继续一个方案')}</span></div><div class="ov-plans">${plans.map(([k,t,d])=>`<button type="button" class="card ov-plan" data-preset="${k}" aria-pressed="${EP.preset===k}"><b>${t}</b><small>${d}</small></button>`).join('')}</div></div>
  <div class="stack"><div class="row between"><span class="eyebrow">${L('Data under the map','地图背后的数据')}</span><span class="eyebrow">${L('real','真实')}</span></div><div class="list eng-evd">
    ${row(L('Roads','路网'),n?`${fmtN(n.links.size)} ${L('CBD links','个路段')}`:'—')}${row(L('Traffic','车流'),L('SCATS hourly counts','SCATS 逐时流量'))}${row(L('Trams & buses','电车公交'),L('PTV timetable','PTV 时刻表'))}${row(L('People on foot','行人'),L('City of Melbourne counts','墨尔本市计数'))}</div></div>`;
}
// 01 Configure · Checks: what has to hold before simulating — every line is the plan's current state
function checksHTML(){
  const s=EP.sum,row=(ok,k,v)=>`<div><i class="dot" style="background:${ok==null?'var(--fg-3)':ok?'var(--accent)':'var(--risk)'}"></i><span class="grow">${k}</span><span class="val">${v}</span></div>`;
  const foot={none:L('open','照常'),left:L('works side closed','施工侧封'),both:L('both sides closed','两侧都封')}[EP.foot]||'—',ran=s&&!EP.busy&&!EP.runErr,k=EP.keep;
  const blk=s&&s.transit&&s.transit.blocked_routes||0,chk=(key,t)=>`<label class="chk"><input type="checkbox" data-keep="${key}"${k[key]?' checked':''}><span>${t}</span></label>`;
  return`<div class="stack"><div class="row between"><span class="eyebrow">${L('Budget · equipment & layout','设备与布置预算')}</span><span class="eyebrow">${L('works period','整个施工期')}</span></div>
    <label class="eng-field"><span class="eyebrow">${L('Upper limit · AUD','上限 · 澳元')}</span><input type="number" id="budgetIn" min="0" step="100" inputmode="numeric" value="${+EP.budget||0}"></label></div>
  <div class="stack"><div class="row between"><span class="eyebrow">${L('Must keep','必须满足的通行条件')}</span></div><div class="chk-list">
    ${chk('foot',L('Continuous footpath','保留连续行人通道'))}${chk('transit',L('Trams and buses keep running','保留公交通行条件'))}${chk('emerg',L('Emergency vehicle lane','保留应急车辆通道'))}</div></div>
  <div class="stack eng-checklist"><div class="row between"><span class="eyebrow">${L('Before simulating','仿真前检查')}</span></div><div class="list eng-evd">
    ${k.foot&&EP.foot!=='none'?row(false,L('Footpath must stay open','行人通道要保留'),foot):''}
    ${k.transit&&s?row(!blk,L('Trams and buses','公交通行'),blk?L(`${blk} route${blk===1?'':'s'} stopped`,`${blk} 条线停运`):L('keep running','照常运行')):''}
    ${k.emerg?row(!EP.all,L('Emergency lane','应急车道'),EP.all?L('all lanes closed','全封了'):L('a lane stays open','留有一条道')):''}
    ${row(!!EP.link,L('Work zone','施工区'),EP.link?`${esc(shortSt(EP.street))} ${dirL(EP.dir)}`:L('not placed','还没放'))}
    ${row(true,L('Works period','施工期'),`${worksDates()} · ${engHour(WORKS_TIME.hours[0])}–${engHour(WORKS_TIME.hours[1])}`)}
    ${row(EP.foot==='none'?true:null,L('Footpath','人行道'),foot)}
    ${row(!EP.badText,L('Sign text','屏上文字'),EP.badText?L('fix it in Signs','去「设备诱导」改'):L('passes the VMS rules','符合 VMS 规范'))}
    ${row(ran?true:EP.runErr?false:null,L('Engine','引擎'),EP.runErr?L('could not score','算不了'):ran?L(`scored at ${engHour(EP.hour)}`,`已按 ${engHour(EP.hour)} 算好`):L('calculating…','计算中…'))}</div></div>`;
}
function copyPlaybook(){
  const ex=engPlaybook(),micro=microOn(),eng=engOn();
  const frames=[parseFrame(EP.f1),parseFrame(EP.f2)].filter(f=>f.length).map(f=>f.join(' / ')).join('  ▸  ');
  const planEn=eng?`${EP.street} ${dirL(EP.dir)} — ${EP.all?'full closure':'one lane closed'}\nWorks ${WORKS_TIME.from} to ${WORKS_TIME.to}, ${engHour(WORKS_TIME.hours[0])}–${engHour(WORKS_TIME.hours[1])} · scored at ${engHour(EP.hour)}\nVMS-1 ${EP.vmsAt} m upstream: ${frames||'(blank)'}\nSign S-1 ${EP.signAt} m: ${EP.sign||'(none)'}`:'';
  const planZh=eng?`${EP.street} ${dirL(EP.dir)} —— ${EP.all?'全封':'封一条道'}\n施工 ${WORKS_TIME.from} 至 ${WORKS_TIME.to}，${engHour(WORKS_TIME.hours[0])}–${engHour(WORKS_TIME.hours[1])} · 按 ${engHour(EP.hour)} 计算\nVMS-1 上游 ${EP.vmsAt} m：${frames||'（空）'}\n标志牌 S-1 ${EP.signAt} m：${EP.sign||'（无）'}`:'';
  const dEn=micro?`\n\nJunction layout v2 (La Trobe × Swanston micro-model)\nΔ1 Shift barrier B-12 8 m west and narrow it by 0.9 m\nΔ2 Add a 17 m tapered cycle transition with a give-way line\nΔ3 Keep a 1.8 m step-free footpath corridor\nΔ4 Move VMS-1 80 m further upstream`:'';
  const dZh=micro?`\n\n路口方案 v2（La Trobe × Swanston 微观仿真）\nΔ1 护栏 B-12 西移 8 m，并收窄 0.9 m\nΔ2 增设 17 m 渐变自行车过渡段和让行线\nΔ3 保留 1.8 m 无障碍人行通道\nΔ4 VMS-1 再往上游移 80 m`:'';
  const txt=L(`RippleTwin works playbook\n${planEn||'(engine offline — no plan numbers)'}`+ex[0]+dEn+`\n\nResponse levels\nGreen: queue stable — monitor.\nAmber: queue growing — check the VMS text is readable and the detour signed.\nRed: queue reaches the next junction — traffic controller on site, consider closing later in the day.\nSensor fault: fall back to amber and request manual confirmation.\n\nEngine figures are model estimates on real CBD flows, not field-validated.\n\nData sources\n${creditLines().map(s=>'- '+s).join('\n')}`,
`RippleTwin 施工处置手册\n${planZh||'（引擎未连接 —— 没有方案数字）'}`+ex[1]+dZh+`\n\n响应等级\n绿色：排队稳定，持续监控。\n黄色：排队增长，检查屏上文字是否看得清、绕行是否有指示。\n红色：排队排到下一个路口，交通指挥员到场，考虑改到当天更晚的时段施工。\n传感器故障：降级为黄色并要求人工确认。\n\n引擎数字是在真实 CBD 车流上的模型估算，未经实地验证。\n\n数据来源\n${creditLines().map(s=>'- '+s).join('\n')}`);
  const fb=()=>{$('#copyFallback').innerHTML=`<p class="small muted">${L('Copying is blocked here. Select the text below instead.','此处无法自动复制，请手动选中下面的文字。')}</p><div class="pre">${txt.replace(/</g,'&lt;')}</div>`;};
  try{navigator.clipboard.writeText(txt).then(()=>toast(L('Playbook copied to the clipboard','处置手册已复制到剪贴板')),fb);}catch(e){fb();}
}
let toastT=0;function toast(m){const t=$('#toast');t.textContent=m;t.hidden=false;toastT=2.6;}
function updateLive(force){
  const P=$('#panel'),sim=S.sim,set=(k,v)=>{const e=P.querySelector(`[data-live="${k}"]`);if(e&&e.textContent!==String(v))e.textContent=v;};
  if(S.step===1&&sim&&microOn()){const c=sim.counts();set('popTotal',L(`${c.total} live`,`实时 ${c.total} 个`));const rows=[[L('Drivers','驾驶员'),c.veh,'var(--a-car)'],[L('Cyclists','骑行者'),c.bike,'var(--a-bike)'],[L('Pedestrians','行人'),c.ped,'var(--a-ped)'],[L('Trams','有轨电车'),c.tram,'var(--a-tram)'],[L('Buses','公交'),c.bus,'var(--a-bus)']];const mx=Math.max(1,...rows.map(r=>r[1]));const el=$('#popBars');if(el)el.innerHTML=rows.map(([n,v,col])=>`<div class="b"><i class="dot" style="background:${col}"></i><span>${n}</span><span class="track"><i style="width:${(v/mx*100).toFixed(0)}%;background:${col}"></i></span><span class="n">${v}</span></div>`).join('');}
  if(S.step===2&&sim){
    if(sim.isGrid){const w=sim.works();if(w&&isFinite(w.queue_m))set('gq',Math.round(w.queue_m));}
    set('agents',(sim.isGrid&&sim.all?sim.all:sim.agents).length);set('conf',sim.stats.conflicts==null?'—':sim.stats.conflicts);set('crit',sim.stats.critical==null?'—':sim.stats.critical);set('harsh',sim.stats.harsh); // null = not computed (SUMO, T46)
    const crit=!!sim.critical,wl=wxLabel(S.wx);
    if(SU.busy)set('suEl',Math.round((performance.now()-SU.t0)/1000));
    const lb=$('#stLabel');if(lb){const txt=sim.isSumo?(sim.waiting?L('SUMO · loading this part of the hour…','SUMO · 正在载入这一段…'):L('SUMO · real CBD network','SUMO · 真实 CBD 路网')):sumoWaiting()?L('SUMO · computing in the cloud','SUMO · 云端计算中'):crit?L(`Micro-simulation · paused · ${wl}`,`微观仿真 · 已暂停 · ${wl}`):L(`Micro-simulation · running · ${wl}`,`微观仿真 · 运行中 · ${wl}`);if(lb.textContent!==txt)lb.textContent=txt;}
  }
  if(S.step===4&&S.simAfter){set('liveB',S.sim.stats.conflicts);set('liveA',S.simAfter.stats.conflicts);}
}
function updateSteps(){document.querySelectorAll('#stepper button').forEach(b=>{const n=+b.dataset.ui;if(n===S.ui)b.setAttribute('aria-current','step');else b.removeAttribute('aria-current');b.classList.toggle('done',n<S.ui);});}

/* ---------- weather & legend ---------- */
function rampCss(k){
  if(k==='storm'){const st=DBZ.map((d,i)=>{const a=i/DBZ.length*100,b=(i+1)/DBZ.length*100;return`${d[2]} ${a.toFixed(1)}% ${b.toFixed(1)}%`;});return`linear-gradient(90deg,${st.join(',')})`;}
  const r=k==='flood'?RAMPS.depth:k==='heat'?RAMPS.inferno:k==='wind'?(TK.light?RAMPS.windLight:RAMPS.wind):RAMPS.fog;
  const stops=k==='fog'?[[0,'#F4F7F9'],[1,'#5E707C']]:r.stops;return`linear-gradient(90deg,${stops.map(([t,c])=>`${c} ${(t*100).toFixed(0)}%`).join(',')})`;
}
const LEG={
  clear:{t:['Clear · baseline','晴 · 基准'],src:['Orthophoto 0.25 m · shadows from sun AZ 292° EL 34°','正射影像 0.25 m · 太阳方位 292°、高度 34° 的阴影']},
  storm:{t:['Radar reflectivity','雷达反射率'],min:'5',u:['dBZ','dBZ'],max:'65',src:['Radar composite resampled to 5 m · Z = 200R^1.6 (simulated)','雷达组合反射率重采样到 5 m · Z = 200R^1.6（模拟）']},
  flood:{t:['Flood depth','淹没深度'],min:'0',u:['metres','米'],max:'0.4',src:['SAR flood extent (Sentinel-1 VV) on a 2 m DEM (simulated)','SAR 淹没范围（Sentinel-1 VV）+ 2 m DEM（模拟）']},
  fog:{t:['Visibility','能见度'],min:'25 m',u:['dense → clear','浓 → 清'],max:'175 m',src:['Fog density from a satellite fog product, advected (simulated)','卫星雾产品的雾浓度，随风平流（模拟）']},
  heat:{t:['Land surface temperature','地表温度'],min:'26',u:['°C','°C'],max:'70',src:['Thermal band B10 sharpened to 2 m with land cover (simulated)','热红外 B10 波段，结合地表覆盖锐化到 2 m（模拟）']},
  wind:{t:['Wind speed · 10 m','风速 · 10 m 高度'],min:'0',u:['km/h','km/h'],max:'100',src:['Urban wind downscale with building wakes (simulated)','含建筑风影的城市风场降尺度（模拟）']}};
const Lp=p=>L(p[0],p[1]);
let heatStats=null;
function legendMetrics(){
  const k=S.wx;
  if(k==='clear')return[[L('Air','气温'),'18 °C'],[L('Road μ','路面摩擦 μ'),'0.80'],[L('Visibility','能见度'),'10 km'],[L('Wind','风速'),'12 km/h']];
  if(k==='storm'){const d=Math.max(0,WX.maxIn('storm',AOI,10)),R=Math.pow(Math.pow(10,d/10)/200,1/1.6);return[[L('Max over AOI','AOI 最大值'),`${d.toFixed(0)} dBZ`],[L('Rain rate','雨强'),d<15?'—':`${R.toFixed(0)} mm/h`],[L('Road μ','路面摩擦 μ'),'0.45']];}
  if(k==='flood'){const d=Math.max(0,WX.maxIn('flood',AOI,4));return[[L('Max depth AOI','AOI 最大水深'),`${d.toFixed(2)} m`],[L('Wet road','积水路面'),`${(WX.wet.length*4).toLocaleString('en-AU')} m²`],[L('Pits blocked','堵塞排水井'),'4'],[L('No step-free','无障碍中断'),String(S.sim?S.sim.stats.noRoute:0)]];}
  if(k==='fog'){const v=WX.visibility(0,0),vm=Math.min(120,WX.visibility(60,-6));return[[L('At junction','路口处'),`${v.toFixed(0)} m`],[L('VMS-1 legible','VMS-1 可读'),`${vm.toFixed(0)} m`],[L('Headway','车头时距'),'+1.6 s'],[L('Camera conf.','摄像头置信度'),Math.min(.98,.4+v/350).toFixed(2)]];}
  if(k==='heat'){if(!heatStats&&WX.lst){let s=0,n=0,sh=0,fn=0;for(let y=AOI.y0;y<AOI.y1;y+=2)for(let x=AOI.x0;x<AOI.x1;x+=2){const q=G.idx(x,y),c=G.cls[q];if(c===CLS.ROAD){s+=WX.lst[q];n++;}if(c===CLS.FOOT){fn++;if(G.shade[q])sh++;}}heatStats={a:s/n,sh:sh/fn};}const h=heatStats||{a:64,sh:.2};return[[L('Asphalt mean','沥青平均'),`${h.a.toFixed(1)} °C`],[L('Footpath shade','人行道遮阴'),`${(h.sh*100).toFixed(0)} %`],[L('Air','气温'),'44 °C'],['UTCI','46 °C']];}
  const g=WX.sample('wind',0,0)||0;return[[L('At junction','路口处'),`${g.toFixed(0)} km/h`],[L('Mean','平均'),'52 km/h'],[L('Barrier tip','护栏倾覆'),g>75?L('HIGH','高'):L('MODERATE','中')],[L('From','来向'),L('315° NW','315° 西北')]];
}
function renderLegend(){
  const k=S.wx,Lg=LEG[k],col=wxCol(k),el=$('#legend');el.style.setProperty('--wxc',col);el.style.setProperty('--wxc-tint',rgba(col,.16));
  el.innerHTML=`<div class="legend-head">${icon(k)}<span class="ttl">${Lp(Lg.t)}</span><span class="live">${L('ILLUSTRATIVE','示意')}</span><button type="button" class="legend-toggle" id="legToggle" aria-label="${L('Collapse legend','折叠图例')}"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 7.5l3-3 3 3"/></svg></button></div>
  <div class="legend-body">${Lg.min?`<div class="legend-ramp" style="background:${rampCss(k)}"></div><div class="legend-scale"><span>${Lg.min}</span><span class="u">${Lp(Lg.u)}</span><span>${Lg.max}</span></div>`:''}
  <dl class="legend-metrics" id="legM"></dl><p class="legend-impact"><b>${L('EFFECT ON ROAD USERS','对道路使用者的影响')}</b>${Lp(IMPACT[k])}</p><p class="legend-src">${Lp(Lg.src)} ${L('Illustrative only — weather is not fed into the engine numbers.','仅作示意 —— 天气不参与引擎计算。')}</p></div>`;
  $('#legToggle').onclick=()=>el.classList.toggle('collapsed');
  updateLegendLive();
}
function updateLegendLive(){const m=$('#legM');if(!m)return;const html=legendMetrics().map(([a,b])=>`<div><dt>${a}</dt><dd>${b}</dd></div>`).join('');if(m.innerHTML!==html)m.innerHTML=html;}
function renderWxSwitcher(){
  const el=$('#wx');el.innerHTML=`<span class="lbl">${L('WX','天气')}</span>`+WX_KINDS.map(k=>`<button type="button" role="radio" data-k="${k}" aria-checked="${k===S.wx}" aria-label="${wxLabel(k)}" style="--wxc:${wxCol(k)};--wxc-tint:${rgba(wxCol(k),.16)}">${icon(k)}<span class="t">${wxLabel(k)}</span></button>`).join('');
  el.querySelectorAll('button').forEach(b=>{b.onclick=()=>setWeather(b.dataset.k);b.onkeydown=e=>{if(e.key==='ArrowRight'||e.key==='ArrowLeft'){const i=WX_KINDS.indexOf(S.wx)+(e.key==='ArrowRight'?1:-1);setWeather(WX_KINDS[(i+6)%6]);el.querySelector(`[data-k="${S.wx}"]`).focus();e.preventDefault();}};});
}
function setWeather(k){
  S.wx=k;document.documentElement.dataset.wx=k;WX.set(k);heatStats=null;for(const s of[S.sim,S.simAfter,S.stress])if(s)s.setWeather(k,WX);
  renderWxSwitcher();renderLegend();renderPanel();renderAlert();
}

/* ---------- language ---------- */
function setLang(lang){
  LANG.cur=lang==='zh'?'zh':'en';ls.set('rt-lang',LANG.cur);applyLangDom();
  document.querySelectorAll('#langToggle span').forEach(s=>s.classList.toggle('on',s.dataset.l===LANG.cur));
  if(S.step===3&&S.event)S.nodes=causal(S.event);
  renderWxSwitcher();renderLegend();renderPanel();renderAlert();updateBasemapUI();renderCredits();
  if(!S.mouse)$('#pVal').textContent=L('Move over the map','将鼠标移到地图上');
  $('#play').dataset.i='';probeKey='';baseKey='';
  if(LANG.cur==='zh'&&document.fonts&&document.fonts.load)document.fonts.load('500 10px "Noto Sans SC"','拉筹伯街').then(()=>{baseKey='';},()=>{});
}

/* ---------- theme & basemap ---------- */
function applyTheme(){
  readTokens();WX.setTheme(TK.light);makePatterns();S.basemap=TK.light?'streets':'imagery';baseKey='';
  updateBasemapUI();renderWxSwitcher();renderLegend();if(S.step===3&&S.event){S.nodes=causal(S.event);renderPanel();}
}
/* ---------- real buildings (T15) ---------- */
/* g / imgs: grids and imagery already built for nw (loadBuildings makes them in earlier tasks); missing ones are rebuilt here */
function rebuildWorld(nw,g,imgs){
  W=nw;G=g||buildGrids(nw);WX.rebind(W,G);
  for(const k of Object.keys(IMG))delete IMG[k];
  if(imgs)Object.assign(IMG,imgs);
  baseKey='';probeKey='';heatStats=null;updateBasemapUI();
}
/* same-origin data from T3 (apps/roads). Fails on file://, the web-only static server or offline → the synthetic city stays.
   The swap runs in separate tasks (footprints → grids → imagery → swap): when the data lands after the page started, the
   animation keeps drawing the old city in between and the map flips to the real one in a single frame, instead of one
   ~0.4 s freeze. Before the first frame it just finishes a few ms later. */
const nextTask=()=>new Promise(r=>setTimeout(r,0));
function loadBuildings(){
  return fetch('/roads/public/cbd/buildings.json').then(r=>r.ok?r.json():null).then(async d=>{
    cityData(d); // the whole-CBD layer draws every footprint (6c-city.js); the fine window clips its copy to WORLD
    const nw=d?buildWorldReal(d,geoToWorld):null;
    if(!nw||nw.buildings.length<REAL_MIN)return false;
    await nextTask();const g=buildGrids(nw);
    await nextTask();const bm=S.basemap,imgs=bm==='streets'?null:{[bm]:renderImagery(nw,bm==='nir'?PAL_NIR:PAL_RGB)};
    await nextTask();rebuildWorld(nw,g,imgs);console.info('buildings: real footprints',nw.count);return true;
  }).catch(e=>{console.info('buildings: synthetic city',e&&e.message);return false;});
}
/* The real OSM vector basemap for the whole-CBD layer (T35, /roads/public/cbd/vectormap.json): water, green space, land use
   and rail from OpenFreeMap's OpenMapTiles vector tiles. Only the CITY layer draws it, so it loads on its own rather than
   joining loadBuildings()' first-frame race — the city layer re-renders itself when it lands. Same failure story: same-origin
   only, and a miss just leaves the flat city layer as it was. */
function loadVectorMap(){
  return fetch('/roads/public/cbd/vectormap.json').then(r=>r.ok?r.json():null).then(d=>{
    cityVector(d);if(d)console.info('vectormap: real OSM vector basemap',d.polygons.length+' polygon layers /',d.lines.length+' line layers');return !!d;
  }).catch(e=>{console.info('vectormap: plain city layer',e&&e.message);return false;});
}
function updateBasemapUI(){document.documentElement.dataset.bm=S.basemap;document.querySelectorAll('#basemap button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.bm===S.basemap)));}

/* ---------- histogram ---------- */
const hc=$('#hist'),hctx=hc.getContext('2d');let hw=0,hh=0;
function sizeHist(){const r=hc.getBoundingClientRect();hw=r.width;hh=r.height;const d=Math.min(2,devicePixelRatio||1);hc.width=Math.max(1,Math.round(hw*d));hc.height=Math.max(1,Math.round(hh*d));hctx.setTransform(d,0,0,d,0,0);}
function drawHist(){
  if(!hw)return;const c=hctx;c.clearRect(0,0,hw,hh);const top=4,bot=hh-16,bw=hw/60,sim=S.sim,live=sim?sim.minute:null;
  const su=sim&&sim.isSumo&&sim.bins?sim.bins.n:0,aria=su?L(`Share of vehicles into the works junctions that braked harshly, per ${su} minutes (SUMO: conflicts not computed). Click to jump.`,`每 ${su} 分钟驶入施工处路口的车里，急刹的占比（SUMO 不算冲突）。点击可跳转。`):sim&&sim.mSeen?L('Share of vehicles into the works junctions that braked harshly or were in a conflict, per 10 minutes. Click to jump.','每 10 分钟驶入施工处路口的车里，急刹或卷入冲突的占比。点击可跳转。'):L('Conflicts per minute, 17:00 to 18:00. Click to jump.','17:00–18:00 每分钟冲突数，点击可跳转');
  if(hc.getAttribute('aria-label')!==aria)hc.setAttribute('aria-label',aria);
  if(sim&&sim.mSeen)histShare(c,sim,top,bot); // 4×4 grid sim, and the SUMO replay since T46
  else{ // La Trobe scene: conflicts per minute, scaled to the busiest minute so far (at least 3, the old full height), so
        // minutes can be told apart
    let top1=0;if(live)for(let m=0;m<60;m++)top1=Math.max(top1,live[m]);const mx=Math.max(3,top1);
    for(let m=0;m<60;m++){c.fillStyle=TK.line;c.fillRect(m*bw+1,bot-2,bw-2,2);
      const v=live?live[m]:0;if(v>0){const lh=(bot-top)*v/mx;c.fillStyle=v>=2?TK.risk:TK.works;c.fillRect(m*bw+1,bot-lh,bw-2,lh);}}}
  c.fillStyle=TK.line2;c.fillRect(0,bot,hw,1);c.font=`400 9px ${FONT_MONO}`;c.fillStyle=TK.fg3;c.textBaseline='top';
  const H=clockHour();for(let k=0;k<=6;k++){const x=k*hw/6;c.textAlign=k===0?'left':k===6?'right':'center';c.fillText(k===6?`${String((H+1)%24).padStart(2,'0')}:00`:`${String(H).padStart(2,'0')}:${String(k*10).padStart(2,'0')}`,x,bot+4);}
  const px=S.clock/3600*hw;c.fillStyle=TK.accent;c.fillRect(px-1,top-2,2,bot-top+4);
}
// T44 step 2 (4×4): one bar per 10 minutes, all the same height = the vehicles that entered the 2×2 in them; red = the share
// that braked harshly or were in a conflict there, grey = the rest (through without either). Each part carries its share.
// T46: the SUMO replay sets sim.bins {m0, n}: n-minute bars from minute m0 (T48: the full hour 10 minutes from 08:00, as here;
// a 12-minute replay 2 minutes from 08:03, 6 bars), each over its own minutes on the hour axis the clock hand runs along. A label too wide for its slot drops to whole percent, then goes
function histShare(c,sim,top,bot){
  const B=sim.bins||{m0:0,n:10},mw=hw/60,W=B.n*mw,bw=Math.min(W*(B.n<10?.7:.42),96),H=bot-top;
  c.fillStyle=TK.line;c.fillRect(0,Math.round(top+H/2),hw,1); // 50 %
  c.font=`500 9.5px ${FONT_MONO}`;c.textAlign='center';c.textBaseline='middle';
  const pct=v=>{for(const d of[1,0]){const s=`${(v*100).toFixed(d)}%`;if(c.measureText(s).width<=W-2)return s;}return'';};
  for(let m0=B.m0-Math.ceil(B.m0/B.n)*B.n;m0<60;m0+=B.n){
    let seen=0,hit=0;for(let m=Math.max(0,m0);m<Math.min(60,m0+B.n);m++){seen+=sim.mSeen[m];hit+=sim.mHit[m];}if(!(seen>0))continue;
    const p=Math.min(1,hit/seen),x=m0*mw+(W-bw)/2,cx=x+bw/2,hr=H*p,inRed=hr>=13;
    c.globalAlpha=.45;c.fillStyle=TK.fg3;c.fillRect(x,top,bw,H-hr);c.globalAlpha=.9;c.fillStyle=TK.risk;c.fillRect(x,bot-hr,bw,hr);c.globalAlpha=1;
    if(inRed){c.fillStyle=TK.fg;c.fillText(pct(p),cx,bot-hr/2);}else{c.fillStyle=TK.risk;c.fillText(pct(p),cx,bot-hr-7);} // a thin red part: its share just above it
    const g1=inRed?bot-hr:bot-hr-14;if(g1-top>=12){c.fillStyle=TK.fg;c.fillText(pct(1-p),cx,(top+g1)/2);}
  }
}
// The 1 h sim window's hour: the plan's hour on the step-2 grid sim (T38; it runs that hour's flows), else the La Trobe scene's 17:00
function clockHour(){return gridShown()?(S.sim.isSumo?S.sim.hour:clamp(Math.floor(+EP.hour||0),0,23)):17;} // T40: a SUMO replay runs its own hour (index.hour)
const fmtClock=s=>{s=Math.floor(s);return`${String(clockHour()).padStart(2,'0')}:${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;};

/* ---------- input ---------- */
function bindInput(){
  const ptrs=new Map();let drag=null,pinch=null;
  cv.addEventListener('pointerdown',e=>{cv.setPointerCapture(e.pointerId);ptrs.set(e.pointerId,[e.offsetX,e.offsetY]);S.fly=null;if(ptrs.size===1){drag={x:e.offsetX,y:e.offsetY,cx:V.cx,cy:V.cy};cv.classList.add('dragging');}else if(ptrs.size===2){const[a,b]=[...ptrs.values()];pinch={d:Math.hypot(a[0]-b[0],a[1]-b[1]),s:V.s};drag=null;}});
  cv.addEventListener('pointermove',e=>{S.mouse=[e.offsetX,e.offsetY];if(!ptrs.has(e.pointerId))return;ptrs.set(e.pointerId,[e.offsetX,e.offsetY]);
    if(pinch&&ptrs.size===2){const[a,b]=[...ptrs.values()],d=Math.hypot(a[0]-b[0],a[1]-b[1]),mx=(a[0]+b[0])/2,my=(a[1]+b[1])/2;zoomAt(mx,my,pinch.s*d/pinch.d);}
    else if(drag)setView(drag.cx-(e.offsetX-drag.x)/V.s,drag.cy+(e.offsetY-drag.y)/V.s,V.s);});
  const up=e=>{ptrs.delete(e.pointerId);if(ptrs.size<2)pinch=null;if(!ptrs.size){drag=null;cv.classList.remove('dragging');}};
  cv.addEventListener('pointerup',up);cv.addEventListener('pointercancel',up);cv.addEventListener('pointerleave',()=>{S.mouse=null;});
  cv.addEventListener('wheel',e=>{e.preventDefault();S.fly=null;zoomAt(e.offsetX,e.offsetY,V.s*Math.exp(-e.deltaY*(e.ctrlKey?.01:.0018)));},{passive:false});
  cv.addEventListener('dblclick',e=>zoomAt(e.offsetX,e.offsetY,V.s*1.8));
  $('#zoomIn').onclick=()=>flyTo(V.cx,V.cy,V.s*1.6,.35,true);$('#zoomOut').onclick=()=>flyTo(V.cx,V.cy,V.s/1.6,.35,true);$('#zoomHome').onclick=()=>{if(gridShown())gridFly(.7);else if(engOn()&&!microOn())engFly(.7);else flyTo(HOME.cx,HOME.cy,HOME.s,.7);}; // the engine's works zone, or the micro-model junction
  document.querySelectorAll('#stepper button').forEach(b=>b.onclick=()=>goUi(+b.dataset.ui));
  document.querySelectorAll('#rail button').forEach(b=>b.onclick=()=>{const k=b.dataset.layer;S.layers[k]=!S.layers[k];b.setAttribute('aria-pressed',String(S.layers[k]));baseKey='';});
  document.querySelectorAll('#basemap button').forEach(b=>b.onclick=()=>{S.basemap=b.dataset.bm;updateBasemapUI();baseKey='';if(b.dataset.bm!=='streets'&&!IMG[b.dataset.bm]){$('#loading').hidden=false;$('#loading').textContent=b.dataset.bm==='nir'?L('RENDERING NIR COMPOSITE…','正在渲染近红外合成…'):L('RENDERING ORTHOPHOTO…','正在渲染正射影像…');setTimeout(()=>{imagery(b.dataset.bm);$('#loading').hidden=true;},30);}});
  document.querySelectorAll('#speed button').forEach(b=>b.onclick=()=>{S.speed=+b.dataset.speed;S.playing=true;});
  $('#play').onclick=()=>{S.playing=!S.playing;if(S.playing&&S.clock>=3599)S.clock=0;if(S.playing&&S.sim&&S.sim.isSumo&&S.sim.atEnd)S.sim.seek(0);}; // T48: the SUMO hour played out → again from 08:00
  hc.addEventListener('click',e=>{S.clock=clamp(e.offsetX/hw*3600,0,3599);if(S.sim&&S.sim.isSumo)S.sim.seek(S.clock-S.sim.clock0);});
  $('#langToggle').onclick=()=>setLang(LANG.cur==='zh'?'en':'zh');
  $('#themeToggle').onclick=()=>{const next=TK.light?'dark':'light';document.documentElement.dataset.theme=next;ls.set('rt-theme',next);};
  new MutationObserver(()=>applyTheme()).observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
  matchMedia('(prefers-color-scheme: light)').addEventListener('change',()=>applyTheme());
  const knob=$('#swipeKnob');let sd=false;knob.addEventListener('pointerdown',e=>{sd=true;knob.setPointerCapture(e.pointerId);});knob.addEventListener('pointermove',e=>{if(!sd)return;const r=$('#map').getBoundingClientRect();S.swipe=clamp((e.clientX-r.left)/r.width,.04,.96);});knob.addEventListener('pointerup',()=>{sd=false;});
  knob.addEventListener('keydown',e=>{if(e.key==='ArrowLeft')S.swipe=clamp(S.swipe-.05,.04,.96);if(e.key==='ArrowRight')S.swipe=clamp(S.swipe+.05,.04,.96);});
  window.addEventListener('keydown',e=>{if(e.target.closest&&e.target.closest('input,textarea'))return;if(e.key===' '&&e.target===document.body){S.playing=!S.playing;e.preventDefault();}const n=+e.key;if(n>=1&&n<=6&&!e.metaKey&&!e.ctrlKey)setWeather(WX_KINDS[n-1]);});
  new ResizeObserver(()=>{resize();}).observe($('#map'));new ResizeObserver(()=>{sizeHist();}).observe(hc);
}
function zoomAt(px,py,s){const wx=V.wx(px),wy=V.wy(py);s=clamp(s,cityMinS(),14);setView(wx-(px-V.w/2)/s,wy+(py-V.h/2)/s,s);}

/* ---------- main loop ---------- */
let last=performance.now(),uiT=0,histT=0,legT=0,probeKey='';
const PLAY='<svg width="14" height="16" viewBox="0 0 14 16"><path d="M2 1.5l10.5 6.5L2 14.5z" fill="currentColor"/></svg>',PAUSE='<svg width="14" height="16" viewBox="0 0 14 16"><path d="M2 1.5h3.5v13H2zM8.5 1.5H12v13H8.5z" fill="currentColor"/></svg>';
function loop(now){
  const dt=Math.min(.05,(now-last)/1000);last=now;
  if(S.fly)stepFly(dt);
  let sp=S.playing?S.speed:0;
  if(S.slow>0){S.slow-=dt;sp=.2;if(S.slow<=0){S.playing=false;sp=0;onCritical();}}
  if(sp>0){const sd=dt*sp,n=Math.ceil(sd/.05),h=sd/n;for(let i=0;i<n;i++)for(const s of activeSims())s.step(h);S.clock=Math.min(3599,S.clock+sd);if(S.clock>=3599)S.playing=false;}
  if(S.sim&&S.sim.isSumo){S.clock=S.sim.clock();if(S.sim.atEnd)S.playing=false;} // T40: the clock reads the replay's own time; T48: the full hour stops at its end, as the grid sim at 09:00
  WX.clock=fmtClock(S.clock);WX.update(dt,S.clock/3600);
  if(S.step===2&&S.sim&&S.sim.critical&&!S.alertShown){S.alertShown=true;S.slow=1.2;}
  render(dt);placeAlert();
  if(S.step===4){const sw=$('#swipe');if(!sw.hidden)sw.style.left=(S.swipe*V.w)+'px';}
  uiT+=dt;histT+=dt;legT+=dt;
  if(toastT>0){toastT-=dt;if(toastT<=0)$('#toast').hidden=true;}
  if(histT>.2){histT=0;drawHist();}
  if(uiT>.25){uiT=0;updateLive();$('#clock').textContent=fmtClock(S.clock);const pb=$('#play'),icn=S.playing?PAUSE:PLAY;if(pb.dataset.i!==String(S.playing)){pb.innerHTML=icn;pb.dataset.i=String(S.playing);pb.setAttribute('aria-label',S.playing?L('Pause simulation','暂停仿真'):L('Play simulation','播放仿真'));}
    document.querySelectorAll('#speed button').forEach(b=>b.setAttribute('aria-pressed',String(+b.dataset.speed===S.speed)));}
  if(legT>.5){legT=0;updateLegendLive();}
  {const pb=$('#probe'),hide=V.s<1;if(pb&&pb.hidden!==hide)pb.hidden=hide;} // T27: lat/lon readout only in the fine zooms
  if(S.mouse){const x=V.wx(S.mouse[0]),y=V.wy(S.mouse[1]),key=`${x.toFixed(1)},${y.toFixed(1)},${S.wx},${(WX.t*2)|0}`;if(key!==probeKey){probeKey=key;const ll=toLL(x,y);$('#pLat').textContent=dms(ll[0],'N','S');$('#pLon').textContent=dms(ll[1],'E','W');const p=WX.probe(x,y);$('#pVal').textContent=p?`${p.v} · ${p.n}`:L('outside the scene','场景范围外');}}
  requestAnimationFrame(loop);
}

/* ---------- boot ---------- */
function boot(){
  document.documentElement.dataset.theme=ls.get('rt-theme')==='light'?'light':'dark'; // dark unless the viewer picked light with the toggle (not the OS setting)
  document.documentElement.dataset.wx=S.wx; // always clear on arrival: the demo machine must not open under a storm (D-0929-2012)
  const lg=ls.get('rt-lang');LANG.cur=lg==='zh'?'zh':'en'; // English unless the viewer picked 中文 with the toggle (not the browser language)
  applyLangDom();document.querySelectorAll('#langToggle span').forEach(s=>s.classList.toggle('on',s.dataset.l===LANG.cur));
  $('#pVal').textContent=L('Move over the map','将鼠标移到地图上');$('#loading').textContent=L('RENDERING ORTHOPHOTO…','正在渲染正射影像…');
  $('#legend').classList.add('collapsed'); // the legend opens folded to its title line; the ^ button unfolds it
  readTokens();makePatterns();S.basemap=TK.light?'streets':'imagery';
  initGlass();resize();sizeHist();bindInput();engBindMap();gridBindMap();
  renderWxSwitcher();renderLegend();updateBasemapUI();renderCredits();
  /* the saved weather's raster (heat ≈ 180 ms) is built once, in start(), on whichever city is in by then — building it here
     on the synthetic grids was thrown away as soon as the real buildings arrived (WX.rebind) */
  const start=()=>{if(WX.kind!==S.wx)WX.set(S.wx);if(S.basemap!=='streets')imagery(S.basemap);$('#loading').hidden=true;goStep(1);requestAnimationFrame(t=>{last=t;loop(t);});};
  /* wait up to 1.2 s for the real footprints so the first frame is already the real city; slower → start synthetic, swap on arrival */
  let go=false;const once=()=>{if(go)return;go=true;if(S.basemap==='streets')start();else setTimeout(start,40);};
  loadBuildings().then(once);setTimeout(once,1200);
  loadVectorMap();
}
(document.fonts&&document.fonts.ready?document.fonts.ready:Promise.resolve()).then(boot,boot);
