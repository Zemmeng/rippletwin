/* grid:begin */
// Step 2 micro-simulation. COMPUTED: a 4×4 grid of real signalised junctions (GRID_SIM) — La Trobe / Little Lonsdale /
// Lonsdale / Little Bourke × Elizabeth / Swanston / Russell / Exhibition, 16 SCATS sites. SHOWN: only the 2×2 around the
// works (GRID_BOX: 2913 Little Lonsdale × Swanston, 2912 Little Lonsdale × Russell, 2904 Lonsdale × Swanston, 2903 Lonsdale ×
// Russell) — `agents`, harsh-braking counts and the risk field cover that 2×2 only; the outer ring exists so cars reach it
// in signal platoons and a queue can spill back past it. The page draws every car (`all`) and signalHeads() of all 16
// junctions (T38: an outer junction drawn empty read as a broken sim). Pure, no DOM:
// tests/grid_glue.mjs runs this block in node. Page units throughout (1 m ≈ GRID_K units); speeds in page units / s.
// ASSUMPTIONS (not measured): streets are straight axis-aligned lines at the median page coordinate of their links in
// GRID_SIM; lane count per direction = the entry link's `lanes`; 90 s two-phase cycle at every junction (EW green 0–40,
// amber 40–43, NS green 45–80, amber 80–83, else red), offsets for a westbound green wave at 11 m/s; 15 % of cars
// turn left at each junction with a left exit, no right turns; trams on Swanston every 90 s each way, through only;
// IDM v0 11 m/s, T 1.2 s, s0 2 m, a 1.2, b 2 (× weather). Drive on the left; lane k = 0 is the kerb lane (outermost).
// Safety events (T44), 2×2 only, each with x, y for the map (sim.events): harsh braking < −3.5 m/s²; conflict = a follower
// moving ≥ 1.5 m/s closing on its leader in the same lane at ≥ 1 m/s with time-to-collision < 1.5 s (critical < 1.0 s), once
// per pair within 6 s — the La Trobe scene's definition (4-sim.js). Rear-end only: signals keep crossing streams apart and
// there are no pedestrians here; IDM keeps safe gaps, so conflicts are rare and most marks are harsh braking.
// Stop lines sit just behind the zebra 2-basemap.js draws (GRID_W); nobody enters a junction unless all of the vehicle fits
// past the far zebra; left turns go straight past the stop line, then a quarter circle of radius ≤ rTurn into the kerb lane.
const GRID_BOX={x0:-100,x1:300,y0:-300,y1:0};
const GRID_SIM={x0:-300,x1:500,y0:-400,y1:100};
// Cars drawn: GRID_BOX minus the La Trobe / Little Bourke carriageways on its edges (those junctions are outer ring)
const GRID_VIEW={x0:GRID_BOX.x0,x1:GRID_BOX.x1,y0:GRID_BOX.y0+14,y1:GRID_BOX.y1-14};
const GRID_K=0.862;
const GRID_EW=['La Trobe Street','Little Lonsdale Street','Lonsdale Street','Little Bourke Street'],
  GRID_NS=['Elizabeth Street','Swanston Street','Russell Street','Exhibition Street'];
const GRID_FALLBACK={'La Trobe Street':0,'Little Lonsdale Street':-100,'Lonsdale Street':-200,'Little Bourke Street':-300,
  'Elizabeth Street':-200,'Swanston Street':0,'Russell Street':200,'Exhibition Street':400};
const GRID_JN=[['2922','La Trobe Street','Elizabeth Street'],['2921','La Trobe Street','Swanston Street'],
  ['2920','La Trobe Street','Russell Street'],['2919','La Trobe Street','Exhibition Street'],
  ['2914','Little Lonsdale Street','Elizabeth Street'],['2913','Little Lonsdale Street','Swanston Street'],
  ['2912','Little Lonsdale Street','Russell Street'],['2911','Little Lonsdale Street','Exhibition Street'],
  ['2906','Lonsdale Street','Elizabeth Street'],['2904','Lonsdale Street','Swanston Street'],
  ['2903','Lonsdale Street','Russell Street'],['2902','Lonsdale Street','Exhibition Street'],
  ['4606','Little Bourke Street','Elizabeth Street'],['4605','Little Bourke Street','Swanston Street'],
  ['4604','Little Bourke Street','Russell Street'],['4603','Little Bourke Street','Exhibition Street']];
function gridIn(B,x,y){return x>=B.x0&&x<=B.x1&&y>=B.y0&&y<=B.y1;}
const GRID_H={E:[1,0],W:[-1,0],N:[0,1],S:[0,-1]},GRID_LEFT={E:'N',N:'W',W:'S',S:'E'};
const GRID_P={v0:11*GRID_K,vT:10*GRID_K,T:1.2,s0:2*GRID_K,a:1.2*GRID_K,b:2*GRID_K,bStop:4*GRID_K,harsh:-3.5*GRID_K,
  cycle:90,stopGap:5,rTurn:9,turn:.15,cap:1800,fallback:400,tramHw:90,car:[4,1.8],tram:[28,2.6],slow:2,dt:.25,
  ttc:1.5,ttcCrit:1,ttcV:1.5*GRID_K,ttcDv:1*GRID_K,evKeep:120}; // safety events (T44); evKeep: seconds of events kept
// Street widths (page units) as 1-world.js draws them. 2-basemap.js puts the zebra w/2 + 0.4 … w/2 + 4.0 from the crossing
// street's centre line and the stop line at w/2 + 4.6 … w/2 + 5.0, so a junction's stop line is w/2 + stopGap before it and
// its far-side zebra ends w/2 + 4 after it
const GRID_W={'La Trobe Street':30,'Little Lonsdale Street':10,'Lonsdale Street':30,'Little Bourke Street':10,
  'Elizabeth Street':30,'Swanston Street':30,'Russell Street':30,'Exhibition Street':30}; // a street not listed counts as 30 wide
// Lateral offset (left of travel) of lane k; k = 0 is the kerb lane
function gridOff(D,k){return 1.8+3.2*(D.lanes-1-k);}
function gridPt(D,off,s){const hx=D.h[0],hy=D.h[1];return[D.ox+hx*s-hy*off,D.oy+hy*s+hx*off];}
// Signal state of junction j for an axis ('EW' | 'NS') at sim time t
function gridSigState(spec,j,axis,t){
  const c=GRID_P.cycle,tl=(((t-spec.junctions[j].off)%c)+c)%c;
  if(axis==='EW')return tl<40?'G':tl<43?'A':'R';
  return tl>=45&&tl<80?'G':tl>=80&&tl<83?'A':'R';
}
// network.json links + flows.json + hour + closes {link, lanes} → the grid the sim runs on
function gridSpec(links,flows,hour,closes){
  const B=GRID_SIM,F=(flows&&flows.days&&flows.days.wd)||flows||{},hr=clamp(Math.floor(+hour||0),0,23);
  const inB=(p,m)=>p[0]>=B.x0-m&&p[0]<=B.x1+m&&p[1]>=B.y0-m&&p[1]<=B.y1+m;
  const L=[];
  for(const l of links||[]){
    const ew=GRID_EW.includes(l.name);if(!ew&&!GRID_NS.includes(l.name))continue;
    const g=l.geometry;if(!Array.isArray(g)||g.length<2)continue;
    const P=g.map(p=>geoToWorld(p[0],p[1]));if(!P.some(p=>inB(p,60)))continue;
    const dx=P[P.length-1][0]-P[0][0],dy=P[P.length-1][1]-P[0][1];
    const dir=Math.abs(dx)>=Math.abs(dy)?(dx>=0?'E':'W'):(dy>=0?'N':'S');
    if(ew!==(dir==='E'||dir==='W'))continue;
    L.push({l,P,dir});
  }
  const C={};
  for(const n of GRID_EW.concat(GRID_NS)){
    const ew=GRID_EW.includes(n),v=[];
    for(const q of L)if(q.l.name===n)for(const p of q.P)if(inB(p,0))v.push(ew?p[1]:p[0]);
    v.sort((a,b)=>a-b);C[n]=v.length?v[v.length>>1]:GRID_FALLBACK[n];
  }
  const junctions=GRID_JN.map(([id,ew,ns])=>({id,ew,ns,x:C[ns],y:C[ew],shown:gridIn(GRID_VIEW,C[ns],C[ew]),off:((B.x1-C[ns])/GRID_K/11)%GRID_P.cycle}));
  // Car link where direction d of street n passes (ox, oy): the one over it (longest ahead), else the first one after it
  const pick=(n,d,ox,oy)=>{
    const h=GRID_H[d],sOf=p=>(p[0]-ox)*h[0]+(p[1]-oy)*h[1];
    const cs=L.filter(q=>q.l.name===n&&q.dir===d).map(q=>{const ss=q.P.map(sOf);return{q,a:Math.min(...ss),b:Math.max(...ss)};});
    const e=cs.filter(c=>c.a<=1&&c.b>=-1).sort((u,w)=>w.b-u.b)[0]||cs.filter(c=>c.a>=0).sort((u,w)=>u.a-w.a)[0];
    return e&&e.a<=40?e.q.l:null;
  };
  const vphOf=l=>{const f=F[l.id],v=Array.isArray(f)?+f[hr]:NaN;return isFinite(v)&&v>=0?v:null;};
  const dirs=[],V=GRID_VIEW;
  for(const n of GRID_EW.concat(GRID_NS)){
    const ew=GRID_EW.includes(n),inner=ew?C[n]>=V.y0&&C[n]<=V.y1:C[n]>=V.x0&&C[n]<=V.x1; // runs through the shown 2×2
    for(const d of ew?['E','W']:['N','S']){
      const h=GRID_H[d],ox=d==='E'?B.x0:d==='W'?B.x1:C[n],oy=d==='N'?B.y0:d==='S'?B.y1:C[n];
      // eB: the link at the GRID_BOX edge — what the 2×2 started from; its flows.json count is what must reach the 2×2
      const bx=d==='E'?GRID_BOX.x0:d==='W'?GRID_BOX.x1:C[n],by=d==='N'?GRID_BOX.y0:d==='S'?GRID_BOX.y1:C[n];
      const e0=pick(n,d,ox,oy),eB=inner?pick(n,d,bx,by):null,e=eB||e0,tram=n==='Swanston Street';
      if(!e&&!tram)continue; // no car link on this side and no tram: nothing drives this way
      const v0=e0?vphOf(e0):null,vB=eB?vphOf(eB):null,edge=e0?(v0==null?GRID_P.fallback:v0):0,target=eB?(vB==null?GRID_P.fallback:vB):null;
      const vx=d==='E'?V.x0:d==='W'?V.x1:C[n],vy=d==='N'?V.y0:d==='S'?V.y1:C[n];
      dirs.push({street:n,dir:d,axis:ew?'EW':'NS',h,ox,oy,len:ew?B.x1-B.x0:B.y1-B.y0,lanes:e?clamp(Math.round(+e.lanes||1),1,3):1,
        entry:e?e.id:null,edge,target,vph:target==null?edge:target,src:!e?'none':(eB?vB:v0)==null?'fallback':'flows',
        sV:(vx-ox)*h[0]+(vy-oy)*h[1],feeds:[],tram,jn:[]});
    }
  }
  const sAt=(D,x,y)=>(x-D.ox)*D.h[0]+(y-D.oy)*D.h[1];
  for(const D of dirs){
    junctions.forEach((J,j)=>{if((D.axis==='EW'?J.ew:J.ns)!==D.street)return;const s=sAt(D,J.x,J.y),d=(GRID_W[D.axis==='EW'?J.ns:J.ew]||30)/2+GRID_P.stopGap;
      D.jn.push({j,s,d,stop:s-d,left:-1,sE:0,dE:0,r:0,a0:0});});
    D.jn.sort((a,b)=>a.s-b.s);
  }
  for(const D of dirs)for(const q of D.jn){
    const J=junctions[q.j],cross=D.axis==='EW'?J.ns:J.ew,E=dirs.findIndex(x=>x.dir===GRID_LEFT[D.dir]&&x.street===cross&&x.entry);
    // left turn into the exit's kerb lane: straight on past the stop line, then a quarter circle of radius r (≤ rTurn) from a0
    if(E>=0){const eo=gridOff(dirs[E],0);q.left=E;q.sE=sAt(dirs[E],J.x,J.y);q.dE=dirs[E].jn.find(x=>x.j===q.j).d;
      q.r=clamp(q.d-eo,2,GRID_P.rTurn);q.a0=q.s-eo-q.r;}
  }
  gridFeeds(dirs);
  let close=null;
  if(closes&&closes.link){
    const q=L.find(z=>z.l.id===closes.link),di=q?dirs.findIndex(x=>x.street===q.l.name&&x.dir===q.dir&&x.entry):-1;
    if(di>=0){
      const D=dirs[di],ss=q.P.map(p=>sAt(D,p[0],p[1])),s0=clamp(Math.min(...ss),0,D.len),s1=clamp(Math.max(...ss),0,D.len);
      if(s1-s0>1){
        const n=clamp(Math.round(+closes.lanes||1),1,D.lanes);
        close={di,link:closes.link,s0,s1,n,all:n>=D.lanes,force:-1};
        if(close.all){
          D.jn.forEach((j,i)=>{if(j.stop<s0-5&&j.left>=0)close.force=i;}); // everyone turns left at the last junction before the works
          for(const X of dirs)for(const j of X.jn)if(j.left===di&&j.sE<s0)j.left=-1; // no turning into the closed street upstream
        }
      }
    }
  }
  return{box:GRID_BOX,sim:B,hour:hr,junctions,dirs,close};
}
// Feeds of each direction: the GRID_SIM edge (s 0) and, for streets through the 2×2, a top-up just past the last outer
// junction. Calibrated so the expected flow where a street enters the 2×2 (sV) equals `target` (its flows.json count at the
// old 2×2 edge): expected = edge × k × Π(1 − turn) over left exits passed + cars turned in on the way + top-up; too much →
// scale the edge down (k < 1), too little → top-up. Turned-in cars go straight on. Fixed point over all directions.
function gridFeeds(dirs){
  const p=GRID_P.turn,len=GRID_P.car[0];
  for(const D of dirs){const o=D.jn.filter(q=>q.s<D.sV);D.sTop=o.length?Math.min(o[o.length-1].s+o[o.length-1].d+4,D.sV-len-2):0;D.k=1;D.top=0;}
  // expected cars / h of D still free to turn when they reach stop line `at`
  const elig=(D,at)=>{
    let a=D.entry?D.edge*D.k:0,b=D.top;
    for(const q of D.jn){if(q.stop>=at)break;if(q.left<0)continue;a*=1-p;if(q.stop>D.sTop+len)b*=1-p;}
    return a+(D.sTop<at?b:0);
  };
  for(let it=0;it<12;it++)for(let di=0;di<dirs.length;di++){
    const D=dirs[di];if(D.target==null||!D.entry)continue;
    let pi=1,G=0;
    for(const q of D.jn){
      if(q.s>=D.sV)break;
      if(q.left>=0)pi*=1-p;
      for(const X of dirs)for(const r of X.jn)if(r.j===q.j&&r.left===di)G+=elig(X,r.stop)*p;
    }
    const base=D.edge*pi+G;
    if(base<=D.target){D.k=1;D.top=D.target-base;}else{D.top=0;D.k=D.edge*pi>0?Math.max(0,(D.target-G)/(D.edge*pi)):1;}
  }
  for(const D of dirs){
    D.feeds=[];if(!D.entry)continue;
    if(D.edge*D.k>.5)D.feeds.push({s:0,vph:D.edge*D.k});
    if(D.top>.5)D.feeds.push({s:D.sTop,vph:D.top});
  }
}
// Is any part of vehicle o (on direction D) past a stop line and short of that junction's far zebra?
function gridInJn(D,o){return D.jn.some(j=>o.s>j.stop&&o.s-o.len<j.s+j.d);}
// Where a vehicle's rear will come to rest: here if (almost) stopped or creeping (slow, not pulling away), v² / 2|a| ahead
// if braking, never if pulling away
function gridStopsAt(o){return o.s-o.len+(o.v<1||o.v<GRID_P.slow&&o.acc<=.1?0:o.acc<0?o.v*o.v/(-2*o.acc):1e9);}
class GridSim{
  constructor(spec,opts={}){
    this.isGrid=true;this.spec=spec;this.R=rng((opts.seed|0)||1);this.t=0;this.clock0=opts.clock0||0;this.nid=1;
    this.agents=[];this.all=[];this.events=[];this.recent=new Map();this.risk=new Float32Array(RNX*RNY);this.riskVer=0;this.critical=null;this.minute=new Float32Array(60);this.mSeen=new Float32Array(60);this.mHit=new Float32Array(60); // T44: per minute, vehicles into the 2×2 / of them with a safety event
    this.wxk='clear';this.wx=WXP.clear;this.env=null;this.onCross=null;this.redRun=0;
    const cl=spec.close;this.lanes=[];
    this.dl=spec.dirs.map((D,di)=>{const a=[];for(let k=0;k<D.lanes;k++){
      const feeds=D.feeds.map(f=>{
        let rate=Math.min(f.vph/D.lanes,GRID_P.cap);
        if(cl&&cl.di===di&&k<cl.n&&f.s>cl.s0-45&&f.s<cl.s1)rate=0; // works right past the feed: nobody enters the closed lane
        return{s:f.s,rate,pend:0,next:rate>0?this._exp(rate):Infinity};
      });
      const ln={di,D,k,off:gridOff(D,k),cars:[],feeds,tpend:0,tnext:Infinity};
      if(D.tram&&k===D.lanes-1)ln.tnext=this.R()*GRID_P.tramHw;
      a.push(ln);this.lanes.push(ln);
    }return a;});
    this.resetStats();
  }
  _exp(rate){return this.t-Math.log(1-this.R())*3600/(rate*((this.wx&&this.wx.rate)||1));}
  resetStats(){
    this.events=[];this.recent=new Map();this.critical=null;this.stats={conflicts:0,critical:0,harsh:0,delay:0,done:0,noRoute:0,merges:0};
    this.minute.fill(0);this.mSeen.fill(0);this.mHit.fill(0);this.risk.fill(0);
    for(const ln of this.lanes||[])for(const c of ln.cars){c.inV=false;c.hit=false;} // cars already in the 2×2 count again from here
    this.riskVer++;this.redRun=0;
    this.entry=this.spec.dirs.map(D=>({id:D.entry,street:D.street,dir:D.dir,vph:D.vph,arr:0,ins:0,div:0}));
  }
  setWeather(k,env){this.wxk=k;this.wx=WXP[k]||WXP.clear;this.env=env;}
  step(dt){if(!(dt>0))return;const n=Math.max(1,Math.ceil(dt/GRID_P.dt-1e-9)),h=dt/n;for(let i=0;i<n;i++)this._step(h);}
  _idm(c,gap,dv){
    const P=GRID_P,w=this.wx,v=c.v,ss=P.s0+Math.max(0,v*P.T*w.T+v*dv/(2*Math.sqrt(P.a*P.b*w.b)));
    return P.a*(1-Math.pow(v/c.v0,4)-Math.pow(ss/Math.max(gap,.05),2));
  }
  // New vehicle with its rear at sp (0 = the GRID_SIM edge), if there is room ahead and behind
  _insert(ln,type,sp){
    const P=GRID_P,[len,wid]=type==='tram'?P.tram:P.car,a=ln.cars,s=sp+len;
    let i=0;while(i<a.length&&a[i].s>s)i++;
    const ld=i>0?a[i-1]:null,fo=a[i]||null;
    if(ld&&ld.s-ld.len<s+P.s0+1)return false;
    if(fo&&(fo.s>sp-P.s0-fo.v*1.2||gridInJn(ln.D,fo)))return false; // nor in front of someone crossing a junction
    const v0=(type==='tram'?P.vT:P.v0)*this.wx.v,D=ln.D;
    const c={id:this.nid++,kind:'veh',type,x:0,y:0,hx:D.h[0],hy:D.h[1],v:ld?Math.min(v0*.8,ld.v+1):v0*.8,acc:0,len,wid,trail:[],
      tag:null,blocked:false,ln,s,dist:0,t0:this.t,v0,turn:null,arc:null,dl:0,wall:Infinity,tt:-1};
    if(type==='car'){
      for(let i=0;i<D.jn.length;i++)if(D.jn[i].stop>s&&D.jn[i].left>=0&&this.R()<P.turn){c.turn=i;break;}
      const cl=this.spec.close;if(cl&&cl.all&&cl.di===ln.di&&(c.turn===null||c.turn>cl.force))c.turn=cl.force;
    }
    a.splice(i,0,c);this._pos(c);return true;
  }
  _exitBlocked(c,ln,q,qi){
    const P=GRID_P,E=this.spec.dirs[q.left],el=this.dl[q.left][0],r=q.r,si=q.sE+ln.off+r-Math.PI/2*r,need=q.sE+q.dE+c.len+2*P.s0;
    let L=null,F=null;for(const o of el.cars){if(o.s>si)L=o;else{F=o;break;}}
    if(L){const g=L.s-L.len-si;if(g<P.s0||(L.v<1&&g<c.len+P.s0))return true;
      if(gridStopsAt(L)<need)return true;} // room for all of it past the exit zebra
    // … also with everyone ahead in the exit lane packed up against its next stop line (it may turn red meanwhile)
    const nq=E.jn[E.jn.findIndex(x=>x.j===q.j)+1];
    if(nq){let p=nq.stop+P.s0;for(const o of el.cars)if(o.s>si&&o.s-o.len<nq.stop)p-=o.len+P.s0;
      for(const L2 of this.dl[ln.di])for(const o of L2.cars)if(o.turn===qi&&o.s>c.s)p-=o.len+P.s0; // turning in ahead of it
      if(p<need)return true;}
    if(F&&si-c.len-F.s<P.s0*.5+F.v*.8)return true;
    return false;
  }
  _turn(c,ln,q){
    const D=ln.D,E=this.spec.dirs[q.left],el=this.dl[q.left][0],r=q.r,alen=Math.PI/2*r;
    const sEnd=q.sE+ln.off+r,P0=gridPt(D,ln.off,q.a0);
    c.arc={x:P0[0],y:P0[1],h1:D.h,h2:E.h,r,alen,sEnd};
    c.s=sEnd-alen+(c.s-q.a0);c.turn=null;c.ln=el;c.dl=0;
    this._put(el,c);
  }
  _put(ln,c){const a=ln.cars;let i=0;while(i<a.length&&a[i].s>c.s)i++;a.splice(i,0,c);ln.fix=true;}
  _splat(x,y,w){
    const i0=Math.floor((x-WORLD.x0)/RISK_CELL),j0=Math.floor((WORLD.y1-y)/RISK_CELL);
    for(let j=j0-3;j<=j0+3;j++)for(let i=i0-3;i<=i0+3;i++){if(i<0||j<0||i>=RNX||j>=RNY)continue;this.risk[j*RNX+i]+=w*Math.exp(-((i-i0)**2+(j-j0)**2)/4);}
    this.riskVer++;
  }
  _step(dt){
    const P=GRID_P,S=this.spec,t=this.t,cl=S.close;
    const sig=S.junctions.map((J,j)=>({EW:gridSigState(S,j,'EW',t),NS:gridSigState(S,j,'NS',t)}));
    // 1 arrivals (Poisson per lane and feed) and trams; enter when the lane is free at the feed
    for(const ln of this.lanes){
      const E=this.entry[ln.di],D=ln.D;
      for(const f of ln.feeds){
        while(f.next<=t){f.pend++;E.arr++;f.next=this._exp(f.rate)+(f.next-t);}
        if(f.pend&&cl&&cl.all&&cl.di===ln.di&&(cl.force<0||D.jn[cl.force].stop<=f.s+P.car[0])){E.div+=f.pend;this.stats.noRoute+=f.pend;f.pend=0;}
      }
      while(ln.tnext<=t){ln.tpend++;ln.tnext+=P.tramHw;}
      const tr=ln.tpend&&this._insert(ln,'tram',0);if(tr)ln.tpend--;
      for(const f of ln.feeds)if(f.pend&&!(tr&&f.s===0)&&this._insert(ln,'car',f.s)){f.pend--;E.ins++;}
    }
    // 2 zipper: the car in the target lane just behind the one waiting at the works lets it in
    const yieldTo=new Map();
    if(cl&&!cl.all){
      const L=this.dl[cl.di],tl=L[cl.n];let W=null;
      for(let k=0;k<cl.n;k++){const c=L[k].cars.find(o=>o.s<cl.s0);if(c&&c.s>cl.s0-8&&c.v<1.5&&(!W||c.s>W.s))W=c;}
      if(W&&tl)for(const o of tl.cars)if(o.s<W.s-W.len+.5){if(o.s>W.s-W.len-30)yieldTo.set(o,W.s-W.len);break;}
    }
    // 3 accelerations (IDM against leader, signal stop line, block-the-box, works)
    for(const ln of this.lanes){
      const D=ln.D,cars=ln.cars;
      for(let i=0;i<cars.length;i++){
        const c=cars[i],ld=i>0?cars[i-1]:null;let acc=this._idm(c,1e4,0),wall=Infinity,q=null,qi=-1;c.held=false;
        for(let m=0;m<D.jn.length;m++)if(D.jn[m].stop>c.s){q=D.jn[m];qi=m;break;}
        const turning=q&&c.turn===qi,tq=c.turn!==null?D.jn[c.turn]:null,inTurn=!!tq&&c.s>=tq.stop; // inTurn: past the stop line, not yet at a0
        if(ld&&!(turning&&ld.s-ld.len>q.stop)&&!(inTurn&&ld.s-ld.len>tq.a0))acc=Math.min(acc,this._idm(c,ld.s-ld.len-c.s,c.v-ld.v));
        if(q&&!inTurn&&q.stop-c.s<120){
          const st=sig[q.j][D.axis];let stop=st==='R'||(st==='A'&&q.stop-c.s>=c.v*c.v/(2*P.bStop));
          // keep the box clear: go only if there is room for all of this vehicle past the far zebra — behind the leader where it
          // will stop (if it is braking), and behind everyone ahead packed up against the next barrier (the works in a closed
          // lane, or the next stop line, which may turn red meanwhile). Cars ahead that turn off at this junction leave the lane.
          if(!stop&&!turning){
            let room=Infinity;for(let k=i-1;k>=0;k--)if(cars[k].turn!==qi){if(cars[k].s>q.stop)room=gridStopsAt(cars[k]);break;}
            const nq=D.jn[qi+1],bar=Math.min(nq?nq.stop:Infinity,cl&&!cl.all&&cl.di===ln.di&&ln.k<cl.n&&cl.s0>q.s?cl.s0-5:Infinity);
            if(bar<Infinity){let p=bar+P.s0;for(let m=0;m<i;m++){const x=cars[m];if(x.turn!==qi&&x.s-x.len<bar)p-=x.len+P.s0;}
              // the lane the works squeeze into also takes everyone still queued in the closed lanes ahead
              if(cl&&!cl.all&&cl.di===ln.di&&ln.k===cl.n&&cl.s0>q.s)for(let k=0;k<cl.n;k++)for(const x of this.dl[cl.di][k].cars)if(x.s>c.s&&x.s<cl.s0)p-=x.len+P.s0;
              room=Math.min(room,p);}
            stop=room<q.s+q.d+c.len+2*P.s0; // one spare gap for cars that turn or merge in ahead afterwards
          }
          if(!stop&&turning)stop=this._exitBlocked(c,ln,q,qi);
          if(stop){wall=q.stop;acc=Math.min(acc,this._idm(c,q.stop-c.s+.9*P.s0,c.v));c.held=true;}
        }
        if(cl&&cl.di===ln.di&&ln.k<cl.n&&c.s<cl.s0-5&&cl.s0-5-c.s<150){
          const w=cl.s0-5;wall=Math.min(wall,w);acc=Math.min(acc,this._idm(c,w-c.s+.9*P.s0,c.v));if(w-c.s<3)c.held=true;
        }
        const yw=yieldTo.get(c);if(yw!==undefined&&yw>c.s)acc=Math.min(acc,this._idm(c,yw-c.s,c.v));
        c.acc=acc;c.wall=wall;
      }
    }
    // 3b conflicts, on the state before this step's move (as 4-sim.js does: IDM here has no braking limit, a car can stop
    //   within one step, so after the move the closing speed is gone): same-lane follower closing on its leader, TTC < 1.5 s
    //   (critical < 1.0 s), once per pair within 6 s
    for(const ln of this.lanes){const a=ln.cars;for(let i=1;i<a.length;i++){
      const c=a[i],ld=a[i-1],dv=c.v-ld.v;if(c.v<P.ttcV||dv<P.ttcDv||!gridIn(GRID_VIEW,c.x,c.y))continue;
      const ttc=Math.max(.1*GRID_K,ld.s-ld.len-c.s)/dv;if(ttc>=P.ttc)continue;
      const key=c.id+'-'+ld.id,prev=this.recent.get(key);
      if(prev&&t-prev.t<6){if(ttc<prev.ttc){prev.ttc=ttc;if(ttc<P.ttcCrit&&prev.sev<2){prev.sev=2;this.stats.critical++}}continue;}
      const ev={t,x:(c.x+ld.x)/2,y:(c.y+ld.y)/2,ttc,sev:ttc<P.ttcCrit?2:1,kind:'conflict',types:[c.type,ld.type]};
      this.recent.set(key,ev);this.events.push(ev);this.stats.conflicts++;if(ev.sev===2)this.stats.critical++;
      const mi=clamp(Math.floor((this.clock0+t)/60),0,59);this.minute[mi]+=1;if(!c.hit){c.hit=true;this.mHit[mi]+=1;}this._splat(ev.x,ev.y,ev.sev===2?1.6:1);
    }}
    // 4 move; hard walls and no-overlap are enforced, stop-line crossings reported
    for(const ln of this.lanes){
      const D=ln.D,cars=ln.cars;
      for(let i=0;i<cars.length;i++){
        const c=cars[i],s0=c.s,v1=c.v;let v=c.v+c.acc*dt;if(v<0)v=0;let s=c.s+Math.max(0,(c.v+v)/2*dt);
        if(s>c.wall-.01){s=Math.max(c.s,c.wall-.01);v=0;}
        if(i>0){const ld=cars[i-1],mx=ld.s-ld.len-.05;if(s>mx){s=mx;v=Math.min(v,ld.v);}}
        c.s=s;c.v=v;c.dist+=Math.max(0,s-s0);
        const ra=(v-v1)/dt;c.acc=ra;
        if(ra<P.harsh){if(!c.hb){c.hb=true;if(gridIn(GRID_VIEW,c.x,c.y)){this.stats.harsh++;const mi=clamp(Math.floor((this.clock0+t)/60),0,59);this.minute[mi]+=1;if(!c.hit){c.hit=true;this.mHit[mi]+=1;}this._splat(c.x,c.y,.6);this.events.push({t,x:c.x,y:c.y,kind:'harsh',sev:0,type:c.type});}}}
        else if(ra>-1)c.hb=false;
        for(const q of D.jn)if(s0<q.stop&&s>=q.stop){if(sig[q.j][D.axis]==='R')this.redRun++;if(this.onCross)this.onCross(c,ln,q,t);}
      }
    }
    // 5 exits and left turns
    for(const ln of this.lanes){
      const D=ln.D,cars=ln.cars;
      for(let i=0;i<cars.length;i++){
        const c=cars[i];
        if(c.s>=D.len){cars.splice(i,1);i--;this.stats.done++;this.stats.delay+=Math.max(0,(t+dt-c.t0)-c.dist/c.v0);continue;}
        if(c.turn!==null&&c.s>=D.jn[c.turn].a0){cars.splice(i,1);i--;this._turn(c,ln,D.jn[c.turn]);}
      }
    }
    // 6 merge out of closed lanes before the works (gap ≥ s0 + 0.8 v both ways)
    if(cl&&!cl.all){
      const L=this.dl[cl.di],tl=L[cl.n];
      for(let k=0;k<cl.n&&tl;k++){const ln=L[k];
        for(let i=0;i<ln.cars.length;i++){
          const c=ln.cars[i];if(c.s>=cl.s0||c.s<cl.s0-80)continue;
          let ld=null,fo=null;for(const o of tl.cars){if(o.s>c.s)ld=o;else{fo=o;break;}}
          const slow=c.v<1,gA=ld?ld.s-ld.len-c.s:1e9,gB=fo?c.s-c.len-fo.s:1e9;
          const okA=gA>=(slow?.8*P.s0:P.s0+c.v*.8),okB=gB>=(slow?.05+(fo?fo.v:0)*.8:P.s0+(fo?fo.v:0)*.8); // .05: a car stopped to let this one in may sit right at its tail
          if(gridInJn(ln.D,c)||fo&&gridInJn(ln.D,fo))continue; // no lane change inside a junction, nor in front of a car crossing one
          if(okA&&okB){ln.cars.splice(i,1);i--;c.dl=ln.off-tl.off;c.ln=tl;this._put(tl,c);this.stats.merges++;}
        }
      }
    }
    // 7 re-assert no overlap where cars were inserted
    for(const ln of this.lanes){if(!ln.fix)continue;ln.fix=false;const a=ln.cars;for(let i=1;i<a.length;i++){const mx=a[i-1].s-a[i-1].len-.05;if(a[i].s>mx){a[i].s=mx;a[i].v=Math.min(a[i].v,a[i-1].v);}}}
    // 8 positions, trails, agent lists: `all` = the whole 4×4 (what the page draws), `agents` = the 2×2 in GRID_VIEW (stats)
    this.t=t+dt;const ag=[],all=[];const k=Math.exp(-3*dt);
    for(const ln of this.lanes)for(const c of ln.cars){
      c.dl*=k;if(Math.abs(c.dl)<.01)c.dl=0;this._pos(c);
      if(this.t-c.tt>=.4){c.tt=this.t;c.trail.push(c.x,c.y);if(c.trail.length>24)c.trail.splice(0,2);}
      all.push(c);if(gridIn(GRID_VIEW,c.x,c.y)){ag.push(c);if(!c.inV){c.inV=true;this.mSeen[clamp(Math.floor((this.clock0+this.t)/60),0,59)]+=1;}}
    }
    this.agents=ag;this.all=all;
    // forget events older than evKeep (the counts keep them)
    if(this.events.length&&this.t-this.events[0].t>P.evKeep)this.events=this.events.filter(e=>this.t-e.t<=P.evKeep);
    if(this.recent.size>64)for(const[k,e]of this.recent)if(this.t-e.t>=6)this.recent.delete(k);
  }
  _pos(c){
    const ln=c.ln,D=ln.D,m=c.s-c.len/2,a=c.arc;
    if(a&&m<a.sEnd){
      const u=m-(a.sEnd-a.alen);
      if(u<=0){c.x=a.x+a.h1[0]*u;c.y=a.y+a.h1[1]*u;c.hx=a.h1[0];c.hy=a.h1[1];}
      else{const th=u/a.r,co=Math.cos(th),si=Math.sin(th);
        c.x=a.x+a.r*(a.h2[0]*(1-co)+a.h1[0]*si);c.y=a.y+a.r*(a.h2[1]*(1-co)+a.h1[1]*si);
        c.hx=a.h1[0]*co+a.h2[0]*si;c.hy=a.h1[1]*co+a.h2[1]*si;}
      return;
    }
    if(a&&c.s-c.len>=a.sEnd)c.arc=null;
    const p=gridPt(D,ln.off+c.dl,m);c.x=p[0];c.y=p[1];c.hx=D.h[0];c.hy=D.h[1];
  }
  signalHeads(){ // all 16 junctions; `shown` = one of the 2×2 at the works
    const S=this.spec,out=[];
    for(const D of S.dirs)for(const q of D.jn){const J=S.junctions[q.j],p=gridPt(D,gridOff(D,0)+2.6,q.stop);
      out.push({x:p[0],y:p[1],axis:D.axis,state:gridSigState(S,q.j,D.axis,this.t),id:J.id,dir:D.dir,shown:J.shown});}
    return out;
  }
  // Contiguous slow (v < 2) queue upstream of s0 on direction di, metres (max over its lanes); runs on into the outer ring
  queueAt(di,s0){
    let best=0;
    for(const ln of this.dl[di]){let cur=s0;for(const c of ln.cars){if(c.s>=s0)continue;if(c.v<GRID_P.slow&&cur-c.s<12)cur=c.s-c.len;else break;}best=Math.max(best,s0-cur);}
    return best/GRID_K;
  }
  works(){
    const cl=this.spec.close;if(!cl)return{polys:[],queue_m:0};
    const D=this.spec.dirs[cl.di],polys=[];
    for(let k=0;k<cl.n;k++){const o=gridOff(D,k);polys.push([gridPt(D,o-1.6,cl.s0),gridPt(D,o-1.6,cl.s1),gridPt(D,o+1.6,cl.s1),gridPt(D,o+1.6,cl.s0)]);}
    return{polys,queue_m:this.queueAt(cl.di,cl.s0)};
  }
}
/* grid:end */
