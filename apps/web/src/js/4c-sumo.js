/* sumo:begin */
// Step 2 on the REAL network (T40): a replay of Eclipse SUMO runs on the CBD network built from OSM (network.json) with
// SCATS weekday 08:00 flows — baked (/sumo/public/real/) or a live cloud run, both in the v2 replay format
// (docs/reference/interfaces.md §HTTP API): per scenario a manifest (vehicle table, signal heads, chunks, metrics) and chunks of
// samples every sample_s (1 or 2 s) [i, lon×1e6, lat×1e6, angle°, speed cm/s] + every signal's state string + the works queue (m).
// SumoReplay wears the same surface the page already draws from GridSim (4b-grid.js): isGrid, t, step(), all / agents,
// signalHeads(), works(), stats, minute, risk … so drawAgents / drawJunctions / updateLive / gridPick need no SUMO branch.
// It needs a GridSim spec for the same works link (junction positions for click-to-zoom, the closed-lane polygon); the page
// passes the one it already runs. Positions are linear between samples; the heading is SUMO's angle turned through the
// local map of geoToWorld (page x / y are fitted to the Hoddle grid, not due east / north). Pure, no DOM: tests/sumo_glue.mjs
// runs this block in node.
// T48 (lead's option B): SUMO runs the whole hour 08:00–09:00, t 0 ↔ 08:00:00 + clock0_s. The page loads what want() names —
// the chunk at the playhead and the two after it, then the rest in time order — and plays as soon as the playhead's chunk is
// in; playing into a chunk that is not in yet holds on the last sample before it (never jumps). Decoded samples are kept up to
// SUMO_MEM bytes: beyond that the chunks farthest from the playhead are dropped (only after their harsh-braking scan) and named
// by want() again when the playhead nears them (seek, or playing on). A replay under 30 minutes (the old 12-minute runs)
// loops; the full hour stops at its end, as the grid sim does. A manifest with no chunks (baseline: metrics only) never plays.
// Safety marks (T46, lead's call): the v2 samples carry no lane, so there is no leader and no gap — conflicts / critical (TTC)
// are not computed (stats null, the page shows —), only harsh braking, by the grid sim's rule (4b-grid.js): one vehicle's
// speed drops faster than GRID_P.harsh (3.5 m/s²) between consecutive samples → one event per braking episode (it ends
// once the deceleration eases below 1 page unit / s², as there), at the first sample of the drop, counted only inside the
// 2×2 the grid sim counts (GRID_VIEW); sim.events, kind 'harsh', so the page's map marks (and their 60 s fade) need no SUMO
// branch. Found once per sample as chunks arrive (addChunk, in time order); step() / seek() only move pointers along the
// sorted lists.
// Timeline, like the grid sim (mSeen / mHit per minute of the hour): each vehicle once, in the minute it first enters
// GRID_VIEW; hit = it braked harshly there. A replay of 30 minutes or more (T48: the hour) gets the grid sim's 10-minute bars
// from 08:00; a shorter one 2-minute bars from its first minute (12 minutes → 6 bars, not two with one half empty).
const SUMO_LINK='l595594354_9756035316';
const SUMO_MEM=48e6; // T48: bytes of decoded samples one replay keeps (24 per vehicle and sample; an hour of 1 s samples on the extended network is > 100 MB)
// SUMO angle (0 = north, clockwise) at lat / lon → unit heading in page coordinates
function sumoHead(lat,lon,p,a){
  const r=a*Math.PI/180,d=1e-5,q=geoToWorld(lat+Math.cos(r)*d,lon+Math.sin(r)*d/Math.cos(lat*Math.PI/180));
  const hx=q[0]-p[0],hy=q[1]-p[1],n=Math.hypot(hx,hy);return n>0?[hx/n,hy/n]:[1,0];
}
// Signal head state from a SUMO state string at link indices idx: any G/g → green, else any y/Y → amber, else red
function sumoHeadState(s,idx){
  if(typeof s!=='string')return'R';let y=false;
  for(const i of idx||[]){const c=s[i];if(c==='G'||c==='g')return'G';if(c==='y'||c==='Y')y=true;}
  return y?'A':'R';
}
// The closed lane SUMO ran (manifest.works.lane_shape_e6, its centre line [lon×1e6, lat×1e6]…) → a page polygon 3.2 units wide.
// SUMO closes the lane the plan says (Lonsdale: the median lane, "RIGHT LANE CLOSED"); the grid sim's polygon is its kerb lane
function sumoLanePoly(shape){
  const P=(shape||[]).filter(q=>Array.isArray(q)&&isFinite(q[0])&&isFinite(q[1])).map(q=>geoToWorld(q[1]/1e6,q[0]/1e6)),n=P.length;if(n<2)return null;
  const L=[],R=[];
  for(let i=0;i<n;i++){const a=P[Math.max(0,i-1)],b=P[Math.min(n-1,i+1)],dx=b[0]-a[0],dy=b[1]-a[1],d=Math.hypot(dx,dy)||1,nx=-dy/d*1.6,ny=dx/d*1.6;
    L.push([P[i][0]+nx,P[i][1]+ny]);R.push([P[i][0]-nx,P[i][1]-ny]);}
  return L.concat(R.reverse());
}
class SumoReplay{
  // index: index.json · scenario id · manifest: <id>/manifest.json · opts {spec, polys (used when the manifest has no works.lane_shape_e6), src {source, elapsedMs, reason}, memBytes (default SUMO_MEM)}
  constructor(index,scenario,manifest,opts={}){
    const M=manifest||{};
    if(!M||!Array.isArray(M.agents)||!Array.isArray(M.chunks))throw new Error('bad SUMO manifest');
    this.isGrid=true;this.isSumo=true;this.index=index||{};this.scenario=scenario;this.man=M;this.spec=opts.spec||null;
    this.src=opts.src||{source:'baked'};const lp=M.works&&sumoLanePoly(M.works.lane_shape_e6);this.polys=lp?[lp]:opts.polys||[];this.hour=clamp(Math.floor(+(this.index.hour!=null?this.index.hour:8)),0,23);
    this.dt=+M.sample_s>0?+M.sample_s:1;this.clock0=+M.clock0_s||0;this.dur=+M.duration_s||0;
    this.meta=M.agents.map(a=>({id:String(a.id),type:a.type==='bus'?'bus':'car',len:Math.max(2,(+a.length_m||5)*GRID_K),wid:Math.max(1,(+a.width_m||1.8)*GRID_K)}));
    this.heads=(M.signal_heads||[]).map(h=>{const p=geoToWorld(h.lat_e6/1e6,h.lon_e6/1e6);return{x:p[0],y:p[1],tls:h.tls,idx:h.idx||[],id:h.id};});
    // T48 chunks: cF0 = first frame of chunk k (manifest start, in seconds; the frames it really holds once in), cF = [first, last]
    // frame once in, cHave = its frames are in memory now, cSeen = it has arrived at least once (scanned); frames[i] = sample i
    // (t = i·dt), ever[i] = it has been in; nLoaded = samples 0 … nLoaded − 1 have all been in; nF = samples in the replay
    this.nChunks=M.chunks.length;this.cF0=M.chunks.map(c=>Math.max(0,Math.round((+(c&&c.start)||0)/this.dt)));this.cF=M.chunks.map(()=>null);
    this.cHave=new Uint8Array(this.nChunks);this.cSeen=new Uint8Array(this.nChunks);this.chunksIn=0;this.nDropped=0;this.mem=0;this.memMax=+opts.memBytes>0?+opts.memBytes:SUMO_MEM;
    this.frames=[];this.ever=[];this.nLoaded=0;this.nF=Math.max(0,Math.round(this.dur/this.dt));this.loops=this.dur>0&&this.dur<1800;this.waiting=false;
    this.t=0;this.cars=new Map();this.all=[];this.agents=this.all;this.events=[];this.critical=null;
    this.risk=new Float32Array(RNX*RNY);this.riskVer=0;this.minute=new Float32Array(60);this.tlsNow={};this.q=0;
    // T46 harsh braking: evAll (events), vIn (first entry into GRID_VIEW per vehicle), vHit (first harsh braking there), all by t;
    // per vehicle: last sample scanned (frame, v, x, y), braking episode on, index into vIn
    const nA=this.meta.length;this.evAll=[];this.vIn=[];this.vHit=[];this.nScan=0;
    this._lf=new Int32Array(nA).fill(-1);this._lv=new Float32Array(nA);this._lx=new Float32Array(nA);this._ly=new Float32Array(nA);this._hb=new Uint8Array(nA);this._in=new Int32Array(nA).fill(-1);
    this.mSeen=new Float32Array(60);this.mHit=new Float32Array(60);this.bins=this.dur>=1800?{m0:0,n:10}:{m0:Math.floor(this.clock0/60),n:2};
    this.resetStats();
  }
  get metrics(){const s=(this.index.scenarios||[]).find(x=>x.id===this.scenario);return Object.assign({},s&&s.metrics,this.man.metrics);}
  get tEnd(){return Math.max(0,(this.nF-1)*this.dt);} // time of the last sample
  _fi(t){return clamp(Math.floor(t/this.dt+1e-9),0,Math.max(0,this.nF-1));} // sample at or before t
  get ready(){return this.nChunks>0&&!!this.frames[this._fi(this.t)];} // the playhead's sample is in: something to draw
  get complete(){return this.chunksIn>=this.nChunks&&this.nLoaded>=this.nF;}
  get atEnd(){return !this.loops&&this.complete&&this.t>=this.tEnd-1e-6;} // the full hour played out (the page pauses there, as at 09:00 in the grid sim)
  _cAt(i){let k=this.nChunks-1;while(k>0&&this.cF0[k]>i)k--;return Math.max(0,k);} // chunk holding sample i
  // Chunk k (frames-NNN.json) → page coordinates once, up front; frames are placed by t, so chunks may arrive in any order.
  // Arriving again (asked for after a drop) it only puts its samples back
  addChunk(k,data){
    const F=(data&&data.frames)||[],n=this.meta.length;let f0=Infinity,f1=-1;
    for(const f of F){
      const fi=Math.round((+f.t||0)/this.dt);if(fi<0||fi>1e5)continue;
      const a=Array.isArray(f.a)?f.a:[],m=a.length,ids=new Int32Array(m),x=new Float32Array(m),y=new Float32Array(m),hx=new Float32Array(m),hy=new Float32Array(m),v=new Float32Array(m);
      let j=0;
      for(const r of a){const i=r[0]|0;if(i<0||i>=n)continue;const lat=r[2]/1e6,lon=r[1]/1e6,p=geoToWorld(lat,lon),h=sumoHead(lat,lon,p,+r[3]||0);
        ids[j]=i;x[j]=p[0];y[j]=p[1];hx[j]=h[0];hy[j]=h[1];v[j]=Math.max(0,+r[4]||0)/100*GRID_K;j++;}
      const old=this.frames[fi];if(old)this.mem-=old.ids.length*24;
      this.frames[fi]={ids:ids.subarray(0,j),x:x.subarray(0,j),y:y.subarray(0,j),hx:hx.subarray(0,j),hy:hy.subarray(0,j),v:v.subarray(0,j),tls:f.tls||null,q:+f.q||0};
      this.mem+=j*24;this.ever[fi]=1;if(fi<f0)f0=fi;if(fi>f1)f1=fi;if(fi>=this.nF)this.nF=fi+1;
    }
    if(k>=0&&k<this.nChunks){if(f1>=0){this.cF[k]=[f0,f1];this.cF0[k]=f0;}this.cHave[k]=1;if(!this.cSeen[k]){this.cSeen[k]=1;this.chunksIn++;}}
    while(this.ever[this.nLoaded])this.nLoaded++;
    if(this.chunksIn>=this.nChunks&&this.nLoaded<this.nF&&this.nLoaded>0)this.nF=this.nLoaded; // all in: the replay ends at its last sample
    this._harsh(this.nLoaded);this._stats();this._trim();this._pose();
  }
  // T48: the next chunk to load, or −1: the playhead's chunk and the two after it when not in memory (never loaded, or
  // dropped), else the first that never arrived, in time order
  want(){
    if(!this.nChunks)return-1;
    const c=this._cAt(this._fi(this.t));
    for(let k=c;k<=Math.min(this.nChunks-1,c+2);k++)if(!this.cHave[k]&&(this.cF[k]||!this.cSeen[k]))return k;
    for(let k=0;k<this.nChunks;k++)if(!this.cSeen[k])return k;
    return-1;
  }
  // T48: over SUMO_MEM, drop the chunks farthest from the playhead — never the one before it, its own or the two after it,
  // nor one whose samples are not scanned for harsh braking yet
  _trim(){
    const c=this._cAt(this._fi(this.t));
    while(this.mem>this.memMax){
      let best=-1,bd=0;
      for(let k=0;k<this.nChunks;k++){const r=this.cF[k];if(!this.cHave[k]||!r||r[1]>=this.nScan||(k>=c-1&&k<=c+2))continue;const d=Math.abs(k-c);if(d>bd){bd=d;best=k;}}
      if(best<0)break;
      const r=this.cF[best];for(let i=r[0];i<=r[1];i++){const f=this.frames[i];if(f){this.mem-=f.ids.length*24;this.frames[i]=undefined;}}
      this.cHave[best]=0;this.nDropped++;
    }
  }
  // The page gave up on the chunks still missing (3 misses in a row): the replay ends at the last sample that arrived in order
  truncate(){for(let k=0;k<this.nChunks;k++)if(!this.cSeen[k]){this.cSeen[k]=1;this.chunksIn++;}this.nF=Math.max(1,this.nLoaded);if(this.t>this.tEnd)this.seek(this.tEnd);}
  // T46: harsh braking in GRID_VIEW over frames nScan … n − 1 (loaded, contiguous from 0), each sample once, in time order
  _harsh(n){
    const P=GRID_P,V=GRID_VIEW,dt=this.dt,mOf=u=>clamp(Math.floor((this.clock0+u)/60),0,59);
    for(let i=this.nScan;i<n;i++){
      const F=this.frames[i],t=i*dt;if(!F)continue;
      for(let j=0;j<F.ids.length;j++){
        const id=F.ids[j],x=F.x[j],y=F.y[j],v=F.v[j];
        if(this._lf[id]===i-1){const a=(v-this._lv[id])/dt; // page units / s², as GRID_P.harsh
          if(a<P.harsh){if(!this._hb[id]){this._hb[id]=1;const px=this._lx[id],py=this._ly[id],t0=t-dt;
            if(gridIn(V,px,py)){this.evAll.push({t:t0,x:px,y:py,kind:'harsh',sev:0,type:this.meta[id].type});
              const e=this.vIn[this._in[id]];if(e&&e.h<0){e.h=t0;this.vHit.push({t:t0,m:e.m});}}}}
          else if(a>-1)this._hb[id]=0;}
        else this._hb[id]=0; // first sample, or back after a gap: no deceleration to read
        if(this._in[id]<0&&gridIn(V,x,y)){this._in[id]=this.vIn.length;this.vIn.push({t,m:mOf(t),h:-1});}
        this._lf[id]=i;this._lv[id]=v;this._lx[id]=x;this._ly[id]=y;
      }
    }
    this.nScan=Math.max(this.nScan,n);
  }
  // Wall-clock second of the hour the replay is at (08:00:00 + clock0_s + t)
  clock(){return clamp(this.clock0+this.t,0,3599);}
  resetStats(){
    this.stats={conflicts:null,critical:null,harsh:0,delay:0,done:0,noRoute:0,merges:0};this.risk.fill(0);this.riskVer++; // null: not computed (no lanes)
    this._pt=Infinity;this._stats();
  }
  // Counts up to the replay's moment t (T46): harsh = events so far (in GRID_VIEW), minute[] = those per minute of the hour,
  // mSeen / mHit = vehicles into GRID_VIEW / of them braked harshly, per entry minute; events = the last evKeep s. Pointers
  // only move forward; a loop or a seek back starts them again from 0. Samples scanned later (T48: a seek ahead of the
  // loading) are counted on the next call — the lists only grow at their end
  _stats(){
    const t=this.t,E=this.evAll,S=this.vIn,H=this.vHit,mOf=u=>clamp(Math.floor((this.clock0+u)/60),0,59);
    if(t<this._pt){this._pe=this._ps=this._ph=this._lo=0;this.events=[];this.minute.fill(0);this.mSeen.fill(0);this.mHit.fill(0);}
    this._pt=t;
    while(this._pe<E.length&&E[this._pe].t<=t)this.minute[mOf(E[this._pe++].t)]++;
    while(this._ps<S.length&&S[this._ps].t<=t)this.mSeen[S[this._ps++].m]++;
    while(this._ph<H.length&&H[this._ph].t<=t)this.mHit[H[this._ph++].m]++;
    let lo=this._lo;while(lo<this._pe&&t-E[lo].t>GRID_P.evKeep)lo++;
    if(lo!==this._lo||this.events.length!==this._pe-lo){this._lo=lo;this.events=E.slice(lo,this._pe);}
    this.stats.harsh=this._pe;
  }
  setWeather(){} // SUMO ran in clear weather; the page's weather layer is drawn over it unchanged
  // Jump to t (timeline click), anywhere in the replay: a chunk not in yet is named first by want(); until it is in, the
  // vehicles on screen stay as they were (waiting)
  seek(t){if(!this.nChunks)return;this.t=clamp(+t||0,0,this.tEnd);for(const c of this.cars.values())c.trail.length=0;this._stats();this._pose();}
  // T48: the latest time in [t0, t1] reachable from t0 through samples in memory — a missing sample holds on the one before it
  _reach(t0,t1){
    const F=this.frames;let i=this._fi(t0);if(!F[i])return t0;
    const i1=this._fi(t1);while(i<i1&&F[i+1])i++;
    if(i<i1)return i*this.dt;
    return i1+1<this.nF&&!F[i1+1]?Math.max(t0,i1*this.dt):t1;
  }
  step(dt){
    if(!(dt>0)||!this.nChunks)return;
    const end=this.tEnd;if(this.t>end)this.t=end;let t=this.t+dt;if(!this.loops&&t>end-1e-6&&t<end)t=end; // float steps: land on the last sample (09:00 reads 08:59:58, not :57)
    if(t>end){
      if(this.loops&&this.complete&&end>0&&this.frames[0]){this.t=this._reach(0,t%end);for(const c of this.cars.values())c.trail.length=0;this.resetStats();this._pose();return;} // loop (short replays)
      t=end; // the hour ends here (or waits for the chunk that ends it)
    }
    this.t=this._reach(this.t,t);this._stats();this._pose();
  }
  _pose(){
    const i=this._fi(this.t),A=this.frames[i];this.waiting=this.nChunks>0&&!A;if(!A)return; // T48: hold what is on screen until that chunk is in
    const B=i+1<this.nF&&this.frames[i+1]||null,u=B?clamp(this.t/this.dt-i,0,1):0;
    const nx=new Int32Array(this.meta.length).fill(-1);if(B)for(let j=0;j<B.ids.length;j++)nx[B.ids[j]]=j;
    if(A.tls)this.tlsNow=Object.assign({},this.tlsNow,A.tls);this.q=B?A.q+(B.q-A.q)*u:A.q;
    const seen=new Set(),all=[];
    for(let j=0;j<A.ids.length;j++){
      const i2=A.ids[j],b=nx[i2],M=this.meta[i2];let x=A.x[j],y=A.y[j],hx=A.hx[j],hy=A.hy[j],v=A.v[j],acc=0;
      if(b>=0){x+=(B.x[b]-x)*u;y+=(B.y[b]-y)*u;const hx2=hx+(B.hx[b]-hx)*u,hy2=hy+(B.hy[b]-hy)*u,hn=Math.hypot(hx2,hy2);if(hn>1e-6){hx=hx2/hn;hy=hy2/hn;}
        acc=(B.v[b]-v)/this.dt;v+=(B.v[b]-v)*u;}
      let c=this.cars.get(i2);
      if(!c){c={id:M.id,kind:'veh',type:M.type,x,y,hx,hy,v,acc,len:M.len,wid:M.wid,trail:[],tag:null,blocked:false,tt:-1};this.cars.set(i2,c);}
      c.x=x;c.y=y;c.hx=hx;c.hy=hy;c.v=v;c.acc=acc;
      if(this.t-c.tt>=.4||this.t<c.tt){c.tt=this.t;c.trail.push(x,y);if(c.trail.length>24)c.trail.splice(0,2);}
      seen.add(i2);all.push(c);
    }
    for(const k of this.cars.keys())if(!seen.has(k))this.cars.delete(k);
    this.all=all;this.agents=all;
  }
  signalHeads(){return this.heads.map(h=>({x:h.x,y:h.y,state:sumoHeadState(this.tlsNow[h.tls],h.idx),id:h.id,shown:true}));}
  works(){return{polys:this.scenario==='baseline'?[]:this.polys,queue_m:this.q};}
}
/* sumo:end */
