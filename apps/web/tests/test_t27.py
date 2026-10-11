"""T27: the map holds the whole CBD (docs/hackathon/specs/T26-T27-web-PRD.md section 3). Static assertions + tests/t27_glue.mjs (real network, real engine, run in node).

Usage: python3 apps/web/tests/test_t27.py (needs node ≥ 18, no network)
The last line is always "N passed, M failed"; any failure exits with code 1.
"""
import pathlib
import re
import shutil
import subprocess
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import build  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
SRC = ROOT / "src"
JS = {p.name: p.read_text(encoding="utf-8") for p in sorted((SRC / "js").glob("*.js"))}
APP, ENG, CITYJS, WORLDJS = JS["5-app.js"], JS["6-engine.js"], JS.get("6c-city.js", ""), JS["1-world.js"]
PAGE, _ = build.bundle()

passed = failed = 0


def check(name, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print(f"✅ {name}")
    else:
        failed += 1
        print(f"❌ {name}{(': ' + detail) if detail else ''}")


def fn(src, name):
    i = src.index(f"function {name}(")
    j = src.index("{", i) + 1
    d, k = 1, j
    while d:
        d += {"{": 1, "}": -1}.get(src[k], 0)
        k += 1
    return src[j:k - 1]


# 0 Global names must be unique (6c-city.js and 8-clash.js once both declared CL, and the whole page script failed to run)
names = re.findall(r"^(?:const|let|class|function) ([A-Za-z_$][\w$]*)", "\n".join(JS.values()), re.M)
dups = sorted({n for n in names if names.count(n) > 1})
check("no duplicate top-level const / let / function names across the js files", not dups, str(dups))

# 1 Extent: CITY only governs how far you can pan, how far you can zoom out, and how far engine lines are drawn
check("1-world.js has CITY = Hoddle Grid + about 150 m, north to Franklin St (x −1150..750, y −950..450); WORLD (the fine window) extended east and south to cover the step 2 4×4",
      "const CITY={x0:-1150,x1:750,y0:-950,y1:450};" in WORLDJS and "const WORLD={x0:-320,x1:480,y0:-380,y1:300};" in WORLDJS)
check("negative: the weather, micro-simulation and orthoimagery grids are still built on WORLD, not CITY",
      "CITY" not in JS["3-weather.js"] and "CITY" not in JS["4-sim.js"] and "CITY" not in JS["2-basemap.js"] and "CITY" not in fn(WORLDJS, "buildWorldReal"))

# 2 Whole-city layer: pre-rendered once, tiled under the fine window
check("6c-city.js sorts right after 6-engine.js (build.py orders by file name)", sorted(JS).index("6c-city.js") == sorted(JS).index("6-engine.js") + 1)
cc = fn(CITYJS, "cityCanvas")
check("the whole-city layer is pre-rendered to an off-screen canvas, cached per light/dark theme", "document.createElement('canvas')" in cc and "CITYL.cv[key]=c" in cc and "(light?'L':'D')" in cc)
check("network: the two links of a two-way street are stroked once (deduplicated by end nodes)", "l.from<l.to?l.from+'|'+l.to:l.to+'|'+l.from" in cc and "seen.has(k)" in cc)
bl = cc[cc.index("if(CITYL.bld){"):cc.index("if(net){")]
check("buildings: flat footprints, no extrusion, no outline", "g.fill('nonzero')" in bl and "stroke" not in bl)
rb = fn(APP, "renderBase")
check("renderBase: paints the whole-city layer first, then clips the fine window to WORLD, then draws the seam",
      rb.index("cityDraw(bctx,V)") < rb.index("bctx.clip()") < rb.index("drawVector(") and "citySeam(bctx,V,TK.light)" in rb and "cityKey()" in rb)
check("the whole-city layer gets the full building table (loadBuildings → cityData)", "cityData(d);" in fn(APP, "loadBuildings"))

# 3 Opening up the view
check("minimum zoom = just fits CITY (cityMinS); panning is clamped to CITY", "V.s=clamp(s,cityMinS(),14)" in APP and "CITY.x0+hw-I.l/V.s" in APP
      and "s=clamp(s,cityMinS(),14);cx+=" in APP and "function zoomAt(px,py,s){const wx=V.wx(px),wy=V.wy(py);s=clamp(s,cityMinS(),14);" in APP)
check("negative: no hard-coded minimum zoom of 1.1 left in the view", not re.search(r"clamp\(s,1\.1,14\)", APP))
rd = fn(APP, "render")
check("zoom < 1: weather, the La Trobe micro scene's pedestrians and events, and the graticule are not drawn (the step 2 grid sim's cars still are)",
      "fine=V.s>=1" in rd and "wx=S.layers.weather&&fine" in rd and "walkers=micro&&(fine||gridShown())" in rd and "S.layers.grid&&fine" in rd
      and not re.search(r"if\(S\.layers\.weather\)WX\.", rd))
check("zoom < 1: the lat/long probe is hidden", "hide=V.s<1" in APP)
check("negative: clicking the map at zoom < 1 does not move the works", "if(S.step!==1||!BE.api||V.s<1)return;" in ENG)

# 4 Engine lines drawn in full
check("engine overlay uses CITY: clickable links, framing, label culling, visible range", all(x in ENG for x in [
    "p[0]<CITY.x0||p[0]>CITY.x1", "clamp(p[0],CITY.x0,CITY.x1)", "if(c[0]<CITY.x0||c[0]>CITY.x1", "Math.max(CITY.x0,V.wx(24))"]))
check("negative: 6-engine.js no longer uses WORLD", "WORLD" not in ENG)
fit = fn(ENG, "engFit") + fn(ENG, "fitView")  # the framing algorithm was pulled out into fitView(x0, x1, y0, y1, maxS)
check("framing's minimum zoom opens up too (cityMinS); every drawn detour (≥ 1 %) is framed", "cityMinS(),maxS" in fit and "+60,3.6);" in fit and ">=.01" in fit)

# 5 Queue line follows the real road
check("the queue line walks upstream along same-named links of the works street, accumulating len_m (upstreamPath), and is drawn until the street ends",
      "function upstreamPath(" in ENG and "u.name===link.name" in ENG and "+U.len_m" in ENG and "engSub(Math.min(s.queue_m,engReach())).reverse()" in ENG)
check("the label shows the engine's number as is, then says how far it is drawn (drawn to Spring St)", "engQueueTxt(s,vis)" in ENG and "画到 ${end} 为止" in ENG and "drawn to ${end" in ENG)
check("negative: no straight-line extrapolation along the works link any more (the old engUp treated metres as page units)", "return[a[0]-(b[0]-a[0])/l*m,a[1]-(b[1]-a[1])/l*m];" not in ENG)

# 6 Scale bar
ds = fn(APP, "drawScale")
check("scale bar uses 1 m ≈ 0.862 page units (K_UPM)", "K_UPM" in ds and "const K_UPM=0.862;" in ENG)

# 7 Slowed links by extra_min
check("slowed links are filtered by extra_min (rippleLinks), no longer by v·delay_s", "rippleLinks(s.raw.links,EP.link)" in ENG and "(l.v||0)*(l.delay_s||0)/60" not in ENG)
rl = fn(ENG, "rippleLinks")
check("negative: both the filter and the red threshold look only at extra_min, not queue_m (Flinders / King St queue anyway; PRD 3.2 item 7, #82)",
      "queue_m" not in rl and "sev:ex>=60?2:ex>=10?1:0" in rl)
check("negative: the map label on the most congested link also turns red by extra_min (same colour as the line below it), not by queue_m",
      "h.extra_min>=60?TK.risk:TK.works" in ENG and "h.queue_m>0?TK.risk" not in ENG)
dt = fn(APP, "drawTag")
check("label placement (at 375 px the works label once sat under the zoom buttons and off-screen): during engLabels drawTag goes through tagSpot, avoiding glass controls, the works segment and labels already drawn; all leader lines first, then the boxes",
      "TAGS.on?tagSpot(px,py,dx,dy,w,h)" in dt and "TAGS.boxes=[[wx0,wy0," in fn(ENG, "engLabels") and fn(ENG, "engLabels").rstrip().endswith("tagFlush();") and "if(TAGS.on)TAGS.q.push(t)" in dt
      and all(x in fn(APP, "tagObst") for x in ["#wx", "#basemap", ".zoom", "#legend", "#rail"]))

# 8 AI panel hooks (PRD 4.3)
check("step 3 AI panel hooks still present", "clashMount();aiMount();" in APP and "aiPlanSrc(s,f)" in ENG)

# 9 Real network / real engine (node)
node = shutil.which("node")
if not node:
    check("node found (needed by t27_glue.mjs)", False)
else:
    try:
        r = subprocess.run([node, str(HERE / "t27_glue.mjs")], capture_output=True, text=True, encoding="utf-8", timeout=150)
        out, code = r.stdout + r.stderr, r.returncode
    except subprocess.TimeoutExpired:
        out, code = "❌ t27_glue.mjs did not finish within 150 s\n", 1
    n0 = passed + failed
    for line in out.splitlines():
        if line.startswith("✅"):
            passed += 1
            print(line)
        elif line.startswith("❌"):
            failed += 1
            print(line)
    if code != 0 and passed + failed == n0:
        check(f"t27_glue.mjs exit code {code}", False, out[-400:])

print(f"{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
