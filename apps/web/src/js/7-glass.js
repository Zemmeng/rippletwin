'use strict';
/* ============================================================
   T14 liquid glass (docs/hackathon/specs/T14-liquid-glass-PRD.md) — appearance only, no numbers change.
   · Floating layout (desktop): the map fills the window; top bar, layer rail, analysis panel and timeline float over it.
     .app carries --safe-l/r/t/b = how much of the map the glass covers; the view, scale bar, graticule labels and the alert
     keep inside what is left (insets()).
   · Real refraction on the analysis panel and the top bar, adapted from liquid-glass.js by Deepika Rao
     (github.com/sven1577/liquid-glass, MIT): a canvas displacement map fed to three staggered feDisplacementMap
     passes through backdrop-filter:url(). Chromium only; Safari / Firefox / reduced transparency / phones keep the CSS
     frosted blur, so nothing depends on it.
   · Compact analysis panel: secondary sections fold behind their heading, explanatory text hides; "Details" shows it all.
   · Roads over buildings (09-29 ask): roofs are washed back and carriageways lifted and edged, once per view change.
   ============================================================ */
const GL={ins:{l:0,r:0,t:0,b:0},mode:'compact',open:new Map(),def:new Map(),fx:[],obs:null};
function readInsets(){const el=document.getElementById('app');if(!el)return GL.ins;const cs=getComputedStyle(el),px=k=>parseFloat(cs.getPropertyValue(k))||0;GL.ins={l:px('--safe-l'),r:px('--safe-r'),t:px('--safe-t'),b:px('--safe-b'),cr:px('--cr-h')};return GL.ins;}
function insets(){return GL.ins;}
/* fraction of the canvas width at the middle of the uncovered map (swipe divider start) */
function visibleMid(){const I=insets();return clamp((I.l+(V.w-I.r))/2/Math.max(1,V.w),.1,.9);}

/* ---------- refraction ---------- */
const LG_OK=(()=>{const ua=navigator.userAgent;if(/Firefox/.test(ua)||(/Safari/.test(ua)&&!/Chrome|Chromium|Edg/.test(ua)))return false;try{return CSS.supports('backdrop-filter','url(#lg)');}catch(e){return false;}})();
const SVG_NS='http://www.w3.org/2000/svg';let lgDefs=null,lgUid=0;
function lgEnsureDefs(){if(lgDefs)return lgDefs;const svg=document.createElementNS(SVG_NS,'svg');svg.setAttribute('width','0');svg.setAttribute('height','0');svg.setAttribute('aria-hidden','true');svg.style.position='absolute';lgDefs=document.createElementNS(SVG_NS,'defs');svg.appendChild(lgDefs);document.body.appendChild(svg);return lgDefs;}
/* red left→right ramp = x push, blue top→bottom ramp = y push; a blurred mid-grey inset neutralises the interior so only the rim bends */
function lgMap(w,h,radius,border,mapBlur){
  const cv=document.createElement('canvas');cv.width=w;cv.height=h;const g=cv.getContext('2d');
  const gx=g.createLinearGradient(0,0,w,0);gx.addColorStop(0,'rgb(0,0,0)');gx.addColorStop(1,'rgb(255,0,0)');g.fillStyle=gx;g.fillRect(0,0,w,h);
  const gy=g.createLinearGradient(0,0,0,h);gy.addColorStop(0,'rgb(0,0,0)');gy.addColorStop(1,'rgb(0,0,255)');g.globalCompositeOperation='difference';g.fillStyle=gy;g.fillRect(0,0,w,h);
  g.globalCompositeOperation='source-over';const ins=border*Math.min(w,h);g.filter=`blur(${mapBlur}px)`;g.fillStyle='rgba(128,128,128,.93)';
  rr(g,ins,ins,w-ins*2,h-ins*2,Math.max(radius-ins,2));g.fill();g.filter='none';return cv.toDataURL();
}
function lgFilter(id,scales){
  const f=document.createElementNS(SVG_NS,'filter');for(const[k,v]of[['id',id],['x','0'],['y','0'],['width','100%'],['height','100%'],['color-interpolation-filters','sRGB']])f.setAttribute(k,v);
  const img=document.createElementNS(SVG_NS,'feImage');for(const[k,v]of[['x','0'],['y','0'],['result','map'],['preserveAspectRatio','none']])img.setAttribute(k,v);f.appendChild(img);
  const keep=['1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0','0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0','0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0'];
  for(let i=0;i<3;i++){
    const d=document.createElementNS(SVG_NS,'feDisplacementMap');for(const[k,v]of[['in','SourceGraphic'],['in2','map'],['scale',scales[i]],['xChannelSelector','R'],['yChannelSelector','B'],['result','d'+i]])d.setAttribute(k,v);f.appendChild(d);
    const m=document.createElementNS(SVG_NS,'feColorMatrix');for(const[k,v]of[['in','d'+i],['type','matrix'],['values',keep[i]],['result','c'+i]])m.setAttribute(k,v);f.appendChild(m);
  }
  const b1=document.createElementNS(SVG_NS,'feBlend');for(const[k,v]of[['in','c0'],['in2','c1'],['mode','screen'],['result','c01']])b1.setAttribute(k,v);f.appendChild(b1);
  const b2=document.createElementNS(SVG_NS,'feBlend');for(const[k,v]of[['in','c01'],['in2','c2'],['mode','screen']])b2.setAttribute(k,v);f.appendChild(b2);
  lgEnsureDefs().appendChild(f);return{f,img};
}
function liquidGlass(el,opts){
  const o=Object.assign({scale:-90,chroma:5,border:.06,mapBlur:12,blur:12},opts);
  const id='lg-'+(++lgUid),parts=lgFilter(id,[o.scale,o.scale+o.chroma,o.scale+2*o.chroma]);let timer=0;
  const refresh=()=>{const w=el.offsetWidth,h=el.offsetHeight;if(!w||!h)return;const r=parseFloat(getComputedStyle(el).borderTopLeftRadius)||0;parts.img.setAttribute('href',lgMap(w,h,r,o.border,o.mapBlur));parts.img.setAttribute('width',w);parts.img.setAttribute('height',h);};
  /* the tone (dim / lift) lives in CSS (.lg-on + --glass-tone) so a theme switch needs no re-apply */
  refresh();el.style.setProperty('--lg-url',`url(#${id})`);el.style.setProperty('--lg-blur',o.blur+'px');el.classList.add('lg-on');
  const ro=new ResizeObserver(()=>{clearTimeout(timer);timer=setTimeout(refresh,120);});ro.observe(el);
  return{destroy(){ro.disconnect();clearTimeout(timer);parts.f.remove();el.style.removeProperty('--lg-url');el.style.removeProperty('--lg-blur');el.classList.remove('lg-on');}};
}
function applyGlass(){
  for(const g of GL.fx)g.destroy();GL.fx=[];
  const desktop=matchMedia('(min-width: 821px)').matches,lowT=matchMedia('(prefers-reduced-transparency: reduce)').matches;
  if(!LG_OK||!desktop||lowT)return;
  const P=document.getElementById('panel'),T=document.querySelector('.top');
  if(P)GL.fx.push(liquidGlass(P,{scale:-110,chroma:6,border:.05,mapBlur:14,blur:12}));
  if(T)GL.fx.push(liquidGlass(T,{scale:-78,chroma:5,border:.14,mapBlur:9,blur:10}));
}

/* ---------- compact analysis panel ---------- */
const SEC_KEEP='textarea,input,select,.metrics,.eng-opts,#engOut,#eng4,#aiBox,.eng-checklist,#cmp4';
const SEC_FOLD='.eng-where'; // 6-step UI: nearby works and compare have their own tab / step now // brief mode opens these folded (09-30, tutor: fewer words) — the header says the gist, a tap opens them // #aiBox: the AI road-users panel also starts open in brief mode (the demo needs it visible at a glance)
function compactPanel(){
  const P=document.getElementById('panel');if(!P)return;
  if(GL.obs)GL.obs.disconnect();
  P.classList.toggle('compact',GL.mode==='compact');
  let tools=P.firstElementChild&&P.firstElementChild.classList.contains('panel-tools')?P.firstElementChild:null;
  if(!tools){tools=document.createElement('div');tools.className='panel-tools';P.insertBefore(tools,P.firstChild);}
  tools.innerHTML=`<div class="seg-mode" role="group" aria-label="${L('Panel detail','面板详略')}"><button type="button" data-mode="compact" aria-pressed="${GL.mode==='compact'}">${L('Compact','简洁')}</button><button type="button" data-mode="full" aria-pressed="${GL.mode==='full'}">${L('Details','详细')}</button></div><button type="button" class="panel-hide" aria-label="${L('Hide panel — show the whole map','收起面板，看完整地图')}" title="${L('Hide panel','收起面板')}"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3l5 5-5 5"/><path d="M11 3v10" opacity=".45"/></svg></button>`;
  tools.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{GL.mode=b.dataset.mode;GL.open.clear();ls.set('rt-panel',GL.mode);compactPanel();});
  tools.querySelector('.panel-hide').onclick=()=>setPanelMin(true);
  const tab=(S.step===3&&typeof EP!=='undefined')?EP.tab3+EP.view3:S.step===1||S.step===4?S.ui+(typeof EP!=='undefined'?EP.tab1:''):'';let n=0;
  for(const sec of[...P.children]){
    if(sec===tools||!sec.classList.contains('stack'))continue;
    const head=sec.firstElementChild;if(!head||!head.classList.contains('row')||!head.querySelector('.eyebrow')||sec.children.length<2)continue;
    const key=`${S.step}${tab}:${n++}`;
    if(!GL.def.has(key+sec.childElementCount))GL.def.set(key+sec.childElementCount,!sec.matches(SEC_FOLD)&&(sec.matches(SEC_KEEP)||!!sec.querySelector(SEC_KEEP)||(n<=2&&sec.offsetHeight<=280)));
    const open=GL.open.has(key)?GL.open.get(key):(GL.mode==='full'||GL.def.get(key+sec.childElementCount));
    sec.classList.add('sec');sec.classList.toggle('sec-closed',!open);
    head.classList.add('sec-head');head.setAttribute('role','button');head.tabIndex=0;head.setAttribute('aria-expanded',String(open));
    const toggle=()=>{GL.open.set(key,sec.classList.contains('sec-closed'));compactPanel();};
    head.onclick=e=>{if(e.target.closest('button,a,input,textarea,select'))return;toggle();};
    head.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();toggle();}};
  }
  if(GL.obs)GL.obs.observe(P,{childList:true});
}
function setPanelMin(on){
  const app=document.getElementById('app');app.classList.toggle('panel-min',on);ls.set('rt-pmin',on?'1':'0');
  const b=document.getElementById('panelOpen');if(b)b.hidden=!on;
  readInsets();if(on){const btn=document.getElementById('panelOpen');if(btn)btn.focus();}
}
function initGlass(){
  GL.mode=ls.get('rt-panel')==='full'?'full':'compact';
  const P=document.getElementById('panel');
  GL.obs=new MutationObserver(()=>compactPanel());if(P)GL.obs.observe(P,{childList:true});
  const b=document.getElementById('panelOpen');if(b)b.onclick=()=>setPanelMin(false);
  if(ls.get('rt-pmin')==='1'&&matchMedia('(min-width: 821px)').matches)setPanelMin(true);
  readInsets();applyGlass();
  let t=0;window.addEventListener('resize',()=>{clearTimeout(t);t=setTimeout(()=>{readInsets();applyGlass();},200);});
  for(const q of['(prefers-reduced-transparency: reduce)','(min-width: 821px)']){try{matchMedia(q).addEventListener('change',()=>{readInsets();applyGlass();});}catch(e){}}
}

/* ---------- roads over buildings ---------- */
function roadPieces(Wd){
  const out=[],span=Wd.real&&typeof STREET_SPAN!=='undefined'?STREET_SPAN:{};
  for(const st of Wd.streets){
    const r=carriage(st),H=st.axis==='h',sp=span[st.id],lim=sp?[sp[0],sp[1]]:[-Infinity,Infinity];
    const runs=H?[[r.x0,r.x1]]:freeSpans(st,0);
    for(const[a0,b0]of runs){const a=Math.max(a0,lim[0]),b=Math.min(b0,lim[1]);if(b<=a)continue;out.push(H?{H,x0:a,x1:b,y0:r.y0,y1:r.y1,st}:{H,x0:r.x0,x1:r.x1,y0:a,y1:b,st});}
  }
  return out;
}
function emphasizeRoads(c,V,Wd,basemap,light){
  const X=x=>V.X(x),Y=y=>V.Y(y),s=V.s,vec=basemap==='streets';
  c.save();
  /* 1. wash roofs back toward the ground tone */
  c.fillStyle=vec?(light?'rgba(240,243,242,.62)':'rgba(13,18,21,.52)'):(light?'rgba(20,24,28,.34)':'rgba(6,8,10,.5)');
  c.beginPath();
  for(const b of Wd.buildings){
    if(X(b.x1)<-20||X(b.x0)>V.w+20||Y(b.y0)<-20||Y(b.y1)>V.h+20)continue;
    const P=b.pts?(polyArea(b.pts)>0?b.pts:b.pts.slice().reverse()):[[b.x0,b.y0],[b.x1,b.y0],[b.x1,b.y1],[b.x0,b.y1]];
    c.moveTo(X(P[0][0]),Y(P[0][1]));for(let i=1;i<P.length;i++)c.lineTo(X(P[i][0]),Y(P[i][1]));c.closePath();
  }
  c.fill('nonzero');
  /* a landmark already inside a washed footprint (real data) would go twice as dark */
  for(const l of Wd.landmarks||[]){if(Wd.buildings.some(b=>l.x>=b.x0&&l.x<=b.x1&&l.y>=b.y0&&l.y<=b.y1))continue;c.beginPath();c.arc(X(l.x),Y(l.y),l.r*s,0,Math.PI*2);c.fill();}
  /* 2. lift the carriageways out of building shadow, then edge them */
  const pcs=roadPieces(Wd);
  if(!vec){c.globalCompositeOperation='screen';c.fillStyle=light?'rgba(72,80,88,.5)':'rgba(60,68,76,.55)';for(const p of pcs)c.fillRect(X(p.x0),Y(p.y1),(p.x1-p.x0)*s,(p.y1-p.y0)*s);c.globalCompositeOperation='source-over';}
  c.strokeStyle=vec?(light?'rgba(88,104,110,.9)':'rgba(150,172,184,.6)'):'rgba(238,242,246,.66)';c.lineWidth=clamp(s*.32,1,2.2);c.beginPath();
  for(const p of pcs){if(p.H){for(const y of[p.y0,p.y1]){c.moveTo(X(p.x0),Y(y));c.lineTo(X(p.x1),Y(y));}}else{for(const x of[p.x0,p.x1]){c.moveTo(X(x),Y(p.y0));c.lineTo(X(x),Y(p.y1));}}}
  c.stroke();
  c.restore();
}
