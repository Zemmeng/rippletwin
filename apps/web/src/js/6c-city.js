'use strict';
/* ============================================================
   Whole-CBD layer (T27, docs/hackathon/specs/T26-T27-web-PRD.md §3). The fine window (WORLD: orthophoto, weather, the junction
   micro-model) stays as it is. Around it the whole Hoddle Grid (+~150 m, CITY in 1-world.js) is drawn from real data:
   the real OSM vector basemap underneath (T35 — water, green space, land use, rail from OpenFreeMap's OpenMapTiles vector
   tiles, /roads/public/cbd/vectormap.json), then every building footprint (flat — no extrusion, no edge), then the road
   network the engine runs on (flat carriageways; a two-way street's pair of links drawn once).
   Pre-rendered once per theme to an off-screen canvas: a full redraw is ~46 ms, pasting the cache ~2 ms, and the base map
   is redrawn on every frame of a drag. renderBase() pastes it under the fine window.
   ============================================================ */
const CITY_PX=1.6; // canvas pixels per page unit in the cache (≈ 6 Mpx)
const CITYL={bld:null,vec:null,cv:{}};
// buildings.json as loadBuildings() fetched it (the fine window clips its own copy to WORLD)
function cityData(d){if(d&&Array.isArray(d.buildings)){CITYL.bld=d.buildings;CITYL.cv={};baseKey='';}}
// vectormap.json as loadVectorMap() fetched it: the real OSM vector basemap for the whole grid
function cityVector(d){if(d&&Array.isArray(d.polygons)){CITYL.vec=d;CITYL.cv={};baseKey='';}}
// Carriageway width in page units by road class — the city layer is context, the fine window has the detailed streets
const CITY_W={trunk:20,primary:20,secondary:17,tertiary:14,unclassified:10,residential:9,living_street:6};
function cityKey(){return(engNet()?'n':'')+(CITYL.bld?'b':'')+(CITYL.vec?'v':'');}
/* The real OSM vector basemap: fill every polygon of a kind in one path (polygons meeting at a tile edge then share an
   edge instead of showing a seam), then stroke the lines. Order is the basemap order — land use, then green, then water. */
const VMAP_FILL=['urban','civic','aeroway','sport','park','wood','grass','sand','water'];
const VMAP_LINE=['waterway','rail','transit'];
function vecLayers(g,pal,X,Y){
  const v=CITYL.vec;if(!v)return;
  for(const kind of VMAP_FILL){
    const col=pal.vmap[kind];if(!col)continue;
    g.fillStyle=col;g.beginPath();
    for(const layer of v.polygons){if(layer.kind!==kind)continue;for(const poly of layer.polys)for(const ring of poly){
      ring.forEach((q,i)=>{const p=geoToWorld(+q[0],+q[1]);if(i)g.lineTo(X(p[0]),Y(p[1]));else g.moveTo(X(p[0]),Y(p[1]));});
      g.closePath();}}
    g.fill('nonzero');
  }
  g.lineCap='round';g.lineJoin='round';
  for(const kind of VMAP_LINE){
    const col=pal.vmap[kind];if(!col)continue;
    g.strokeStyle=col;
    if(kind==='waterway'){g.setLineDash([]);g.lineWidth=Math.max(1,CITY_PX*1.4);}
    else if(kind==='rail'){g.setLineDash([CITY_PX*2.5,CITY_PX*2.5]);g.lineWidth=Math.max(1,CITY_PX*1.1);}
    else{g.setLineDash([]);g.lineWidth=Math.max(1,CITY_PX*.7);}
    g.beginPath();
    for(const layer of v.lines){if(layer.kind!==kind)continue;for(const pts of layer.pts){
      pts.forEach((q,i)=>{const p=geoToWorld(+q[0],+q[1]);if(i)g.lineTo(X(p[0]),Y(p[1]));else g.moveTo(X(p[0]),Y(p[1]));});}}
    g.stroke();
  }
  g.setLineDash([]);
}
function cityCanvas(light){
  const net=engNet(),key=(light?'L':'D')+cityKey();if(!net&&!CITYL.bld&&!CITYL.vec)return null;
  if(CITYL.cv[key])return CITYL.cv[key];
  // streets palette; in the dark theme the carriageways are lifted above the roofs so the roads read first (09-29 ask)
  const v=VEC[light?'light':'dark'],pal=light?v:{...v,bldg:'#161E23',road:'#34414A',casing:'#252F37'},w=Math.round((CITY.x1-CITY.x0)*CITY_PX),h=Math.round((CITY.y1-CITY.y0)*CITY_PX);
  const c=document.createElement('canvas');c.width=w;c.height=h;const g=c.getContext('2d');
  const X=x=>(x-CITY.x0)*CITY_PX,Y=y=>(CITY.y1-y)*CITY_PX;
  g.fillStyle=pal.land;g.fillRect(0,0,w,h);
  vecLayers(g,pal,X,Y);
  if(CITYL.bld){
    g.fillStyle=pal.bldg;g.beginPath();
    for(const b of CITYL.bld){const fp=b&&b.footprint;if(!Array.isArray(fp)||fp.length<3)continue;
      fp.forEach((q,i)=>{const p=geoToWorld(+q[0],+q[1]);if(i)g.lineTo(X(p[0]),Y(p[1]));else g.moveTo(X(p[0]),Y(p[1]));});g.closePath();}
    g.fill('nonzero');
  }
  if(net){
    const seen=new Set(),runs=[];
    for(const l of net.links.values()){const k=l.from<l.to?l.from+'|'+l.to:l.to+'|'+l.from;if(seen.has(k))continue;seen.add(k);const P=linkPts(l);if(P)runs.push([P,CITY_W[l.highway]||10]);}
    g.lineCap='round';g.lineJoin='round';
    for(const pass of[0,1]){g.strokeStyle=pass?pal.road:pal.casing;
      for(const[P,wd]of runs){g.lineWidth=(wd+(pass?0:2.4))*CITY_PX;g.beginPath();P.forEach((p,i)=>{if(i)g.lineTo(X(p[0]),Y(p[1]));else g.moveTo(X(p[0]),Y(p[1]));});g.stroke();}}
  }
  CITYL.cv[key]=c;return c;
}
// Paste the city under the fine window; false while neither the network nor the buildings have arrived
function cityDraw(c,V){
  const cvs=cityCanvas(TK.light);if(!cvs)return false;
  c.save();c.imageSmoothingEnabled=true;c.drawImage(cvs,V.X(CITY.x0),V.Y(CITY.y1),(CITY.x1-CITY.x0)*V.s,(CITY.y1-CITY.y0)*V.s);c.restore();return true;
}
// The seam: a thin dashed line round the fine window, so the change of detail (orthophoto, weather, the junction model) reads
// as a boundary on purpose rather than a glitch
function citySeam(c,V,light){
  c.save();c.strokeStyle=light?'rgba(80,98,106,.5)':'rgba(176,196,206,.34)';c.lineWidth=1;c.setLineDash([6,5]);
  c.strokeRect(Math.round(V.X(WORLD.x0))+.5,Math.round(V.Y(WORLD.y1))+.5,Math.round((WORLD.x1-WORLD.x0)*V.s),Math.round((WORLD.y1-WORLD.y0)*V.s));c.restore();
}
