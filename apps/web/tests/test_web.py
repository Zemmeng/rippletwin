"""Static assertions for apps/web: no browser, only the sources and the bundle are read.

Usage: python3 apps/web/tests/test_web.py
The last line is always "N passed, M failed"; any failure exits with code 1.
"""
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import build  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
JS = "\n".join(p.read_text(encoding="utf-8") for p in sorted((SRC / "js").glob("*.js")))
BODY = (SRC / "body.html").read_text(encoding="utf-8")
PAGE, _ = build.bundle()
WX_KINDS = ["clear", "storm", "flood", "fog", "heat", "wind"]

passed = failed = 0


def check(name, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print(f"✅ {name}")
    else:
        failed += 1
        print(f"❌ {name}{(': ' + detail) if detail else ''}")


# 1. The committed public/index.html is in sync with src/ (goes red if the source changed but was not rebuilt)
committed = (ROOT / "public" / "index.html").read_text(encoding="utf-8")
check("public/index.html matches the bundle built from src/", committed == PAGE, "run python3 apps/web/build.py first")

# 2. Single-file size under 2 MB (the file size limit under public/)
size = len(PAGE.encode("utf-8"))
check(f"bundle is {size} bytes < 2MB", size < 2 * 1024 * 1024)

# 3. Negative assertions (privacy): the page only loads from the same origin (/engine/ /roads/ /params/ /api/, docs/hackathon/specs/T13-web-wiring-PRD.md section 6; plus /sumo/:
#    it only imports the same-origin sumo-client.js, which fetches /sumo/public/real/ and /api/sumo/v1/) and sends no data to any other server
SAME_ORIGIN = ("/engine/", "/roads/", "/params/", "/api/", "/sumo/")
loads = re.findall(r"\b(import|fetch)\s*\(\s*([^)]*?)\s*[,)]", JS)
bad = [f"{k}({a})" for k, a in loads if not re.fullmatch(r"'(/[^']*)'", a) or not a.strip("'").startswith(SAME_ORIGIN)]
check(f"import() / fetch() use only fixed same-origin paths ({len(loads)} calls)", loads and not bad, f"non-compliant {bad}")
check("no XMLHttpRequest / WebSocket / sendBeacon in the JS", not re.search(r"XMLHttpRequest|WebSocket|sendBeacon", JS))
hosts = set(re.findall(r"https?://([a-zA-Z0-9.-]+)", PAGE))
allowed = {"fonts.googleapis.com", "fonts.gstatic.com", "www.w3.org"}
# The licence-required data attributions (OSM, OpenMapTiles / OpenFreeMap, DataVic, City of Melbourne) are links for people to click, not things the page loads:
# they may only appear in CREDITS hrefs (vector tiles are fetched at build time by tools/fetch_vectormap.py; the page never connects to them)
CREDIT_HOSTS = {"www.openstreetmap.org", "openfreemap.org", "discover.data.vic.gov.au", "data.melbourne.vic.gov.au"}
check("the only external hosts are Google Fonts (plus attribution links, see the next check)", hosts <= allowed | CREDIT_HOSTS, f"extra {sorted(hosts - allowed - CREDIT_HOSTS)}")
stray = [h for h in CREDIT_HOSTS if PAGE.count("https://" + h) != len(re.findall(r"href:'https://" + re.escape(h), PAGE))]
check("attribution links appear only in CREDITS hrefs and are never loaded via fetch / import / src", not stray, str(stray))
check("attribution links open in a new window without a referrer (rel=noopener noreferrer)", 'target="_blank" rel="noopener noreferrer"' in PAGE and re.search(r"CREDITS\.map\(c=>`<a href=\"\$\{c\.href\}\" target=\"_blank\" rel=\"noopener noreferrer\">", PAGE) is not None)

# 3b. Backend wiring: only backend.js connect(); on failure BE.err is set and the page shows the offline card
ENG = (SRC / "js" / "6-engine.js").read_text(encoding="utf-8")
check("6-engine.js loads /engine/public/js/backend.js and calls connect()",
      "import('/engine/public/js/backend.js')" in ENG and re.search(r"\.then\(m=>m\.connect\(\)\)", ENG))
check("backend load-failure branch: catch records BE.err and does not rethrow",
      re.search(r"\.catch\(e=>\{BE\.err=e;", ENG) and "engOfflineCard" in ENG)
check("negative: when the engine is unreachable, no preset numbers stand in (no RESULTS lookup table; the offline card says there are no numbers to show)",
      "RESULTS" not in JS and "Engine offline — no numbers to show" in ENG and "showing preset numbers" not in ENG)

# 3c. Negative assertions (injection): text from the engine / sign checker / advisor (why, road names, errors) is never concatenated into HTML as is
#     why only via textContent; road names and errors always go through esc() in templates; text drawn on canvas (drawTag) and clipboard text (engPlaybook) are not HTML
html_part = re.sub(r"function engPlaybook\(\)\{.*?\n\}\n", "", ENG, flags=re.S)
html_part = re.sub(r"/\* pure:begin.*?/\* pure:end \*/", "", html_part, flags=re.S)  # pure plan-building data, never goes into HTML
interp = [m.group(0) for m in re.finditer(r"\$\{((?:[^{}]|\{[^{}]*\})*)\}", html_part)]
raw_why = [x for x in interp if re.search(r"\.why\b", x)]
check("why is not concatenated into HTML (textContent only)", not raw_why, str(raw_why[:3]))
check("why is written with textContent (step 3 readings, step 4 advisor)", ENG.count(".textContent=w||''") + ENG.count(".textContent=o&&o.why||''") >= 2)
def interpolations(text):
    """Every ${…} on its own (including inner ones nested in L(`…${x}…`)), matched by brace pairing"""
    out, i = [], text.find("${")
    while i != -1:
        depth, j = 0, i + 1
        while j < len(text):
            if text[j] == "{":
                depth += 1
            elif text[j] == "}":
                depth -= 1
                if depth == 0:
                    break
            j += 1
        out.append(text[i + 2:j])
        i = text.find("${", i + 2)
    return out


def unsafe_in(text):
    """Fields from the engine / sign reader / advisor interpolated directly without esc() (an outer L(…) as a whole does not count; each ${} inside is checked separately)"""
    bad = []
    for x in interpolations(text):
        if "${" in x:  # outer: the interpolations inside are checked separately
            continue
        code = re.sub(r"'[^']*'|\"[^\"]*\"|`[^`]*`", "''", x)  # copy inside string literals does not count
        # fields from the engine / sign reader / advisor / check, text the user typed (f1 f2 sign), and advisor changes (what kind frames)
        if re.fullmatch(r"\s*(fmtN|pctS|engHour)\([^()]*(\([^()]*\))?[^()]*\)\s*", code):  # number formatting, outputs digits only
            continue
        if re.search(r"(?<![.\w])(street|name|msg|message|reading_src|src|equipment|f1|f2|sign|what|kind|frames|text|headsign|short|m)\b|\.(street|name|msg|message|reading_src|src|equipment|f1|f2|sign|kind|frames|text|headsign|short)\b", code) and "esc(" not in code:
            bad.append(x[:60])
    return bad


lines = "\n".join(ln for ln in html_part.splitlines() if "drawTag(" not in ln and "toast(" not in ln)
unsafe = unsafe_in(lines)
check("road names / errors / sources in HTML templates all go through esc() (including those nested in L())", not unsafe, str(unsafe[:4]))
# Self-check: removing one esc() must be caught (guards against an assertion that can never fail)
probe = "`${L(`One lane on ${shortSt(s.street)} backs up`,`x`)}` `${esc(a.src)}`"
check("self-check: an unescaped road name nested in L() is caught", unsafe_in(probe) == ["shortSt(s.street)"], str(unsafe_in(probe)))
app_js = (SRC / "js" / "5-app.js").read_text(encoding="utf-8")
check("the road name in the step 1 heading goes through esc()", "esc(shortSt(EP.street)" in app_js and not unsafe_in(app_js[app_js.find("S.step===1"):app_js.find("S.step===2")]))

# 3d. Real buildings: draw the procedurally generated city synchronously first (fallback), fetch buildings.json asynchronously, keep the fallback if it is missing / too small, so the page is never blank
WORLD_JS = (SRC / "js" / "1-world.js").read_text(encoding="utf-8")
no_comments = lambda t: re.sub(r"/\*.*?\*/|//[^\n]*", "", t, flags=re.S)  # noqa: E731
check("the fallback city is built synchronously first: let W=buildWorld(),G=buildGrids(W)", "let W=buildWorld(),G=buildGrids(W);" in app_js and "function buildWorld(){" in WORLD_JS)
lb = re.search(r"function loadBuildings\(\)\{.*?\n\}\n", app_js, re.S)
lb_src = lb.group(0) if lb else ""
check("loadBuildings fetches the same-origin /roads/public/cbd/buildings.json", "fetch('/roads/public/cbd/buildings.json')" in lb_src)
check("missing / bad data / fewer than REAL_MIN buildings → the world is not replaced (catch + REAL_MIN)",
      ".catch(" in lb_src and "nw.buildings.length<REAL_MIN)return false" in lb_src and "r.ok?r.json():null" in lb_src)
check("geoToWorld is used only in the loadBuildings async callback (1-world.js top level does not touch it)",
      "geoToWorld" not in no_comments(WORLD_JS) and no_comments(app_js).count("geoToWorld") == no_comments(lb_src).count("geoToWorld") == 1)
check("rebuildWorld clears the imagery cache, basemap signature and heat stats", re.search(r"function rebuildWorld\(nw,g,imgs\)\{\s*W=nw;G=g\|\|buildGrids\(nw\);WX\.rebind\(W,G\);\s*for\(const k of Object\.keys\(IMG\)\)delete IMG\[k\];\s*if\(imgs\)Object\.assign\(IMG,imgs\);\s*baseKey='';probeKey='';heatStats=null;", app_js) is not None)
check("start-up waits at most 1.2 s for real buildings, then draws the fallback city", "loadBuildings().then(once);setTimeout(once,1200);" in app_js)
# Late-arriving real buildings are swapped in over several tasks (footprints → rasters → imagery → swapped within one frame) so the animation never stalls; rasters and imagery are built before rebuildWorld gets them
lb_code = no_comments(lb_src)
check("loadBuildings swaps the world over several tasks: 3 × await nextTask(), rasters and imagery built before rebuildWorld(nw,g,imgs)",
      lb_code.count("await nextTask();") == 3 and "const g=buildGrids(nw);" in lb_code and "renderImagery(nw," in lb_code
      and lb_code.find("buildGrids(nw)") < lb_code.find("renderImagery(nw,") < lb_code.find("rebuildWorld(nw,g,imgs)"))
check("negative: loadBuildings has no rebuildWorld(nw) without pre-built rasters", "rebuildWorld(nw)" not in lb_code)
# Weather rasters are built once, in start(): building them earlier in boot (on the fallback city) would be thrown away and rebuilt by WX.rebind when real buildings arrive
bt = re.search(r"function boot\(\)\{.*?\n\}\n", app_js, re.S)
bt_code = no_comments(bt.group(0) if bt else "")
pre_start = bt_code[:bt_code.find("const start=")] if "const start=" in bt_code else bt_code
check("weather rasters are built in start(): if(WX.kind!==S.wx)WX.set(S.wx)", "const start=()=>{if(WX.kind!==S.wx)WX.set(S.wx);" in bt_code)
check("negative: boot does not call WX.set before start() (no wasted heat raster on the fallback city)", bool(bt) and "WX.set(" not in pre_start)
# Negative assertion (injection): building names from the data are only drawn on canvas, never put into HTML
BASE_JS = (SRC / "js" / "2-basemap.js").read_text(encoding="utf-8")
check("negative: building names are drawn only with fillText; no innerHTML in 1-world / 2-basemap", "innerHTML" not in WORLD_JS + BASE_JS and "c.fillText(t,px,py)" in BASE_JS)
# In the real city, Little La Trobe / A'Beckett are labelled only on the stretch the real network has (STREET_SPAN), so no "A'BECKETT ST" over the real buildings east of Swanston
check("street labels only on the stretch the real network has: drawLabels skips by W.real && STREET_SPAN",
      "real=W.real&&STREET_SPAN[st.id]" in BASE_JS and "if(real&&!(u>real[0]&&u<real[1]))continue;" in BASE_JS
      and "const STREET_SPAN={llatrobe:[-185,-15],abeckett:[-Infinity,-15]};" in WORLD_JS)

# 4. Negative assertion (secrets): no key / token-shaped strings in the source
check("no key / token in the source", not re.search(r"(sk-[A-Za-z0-9]{16,}|api[_-]?key\s*[:=]|Bearer\s+[A-Za-z0-9])", JS + BODY, re.I))

# 5. All workflow steps present
steps = re.findall(r'data-ui="(\d)"', BODY)
check("the stepper has six steps 00–05 (Overview → Configure → Simulate → Impact → Compare → Export)", steps == ["0", "1", "2", "3", "4", "5"], str(steps))

# 6. Six weather types: each has a colour, icon, legend and impact note (the comparison results and reproduction seeds were hard-coded fake numbers and have been removed)
for k in WX_KINDS:
    ok = all(re.search(pat, JS, re.S) for pat in [
        rf"WX_META=\{{.*?\b{k}:\{{label:", rf"WX_ICON=\{{.*?\b{k}:'", rf"const LEG=\{{.*?\b{k}:\{{t:",
        rf"const IMPACT=\{{.*?\b{k}:\["])
    check(f"weather {k} is fully configured", ok)

# 7. Negative: the per-weather lookup-table fake numbers (safety score, before/after table, reproduction seeds, expected conflict curve) are all gone
check("no RESULTS / SEEDS / PROFILE lookup tables", not re.search(r"\bconst (RESULTS|SEEDS|PROFILE)=", JS))

# 8. Layout v2 geometry matches its copy: barriers 8 m west, 0.9 m narrower, accessible path 1.8 m, VMS moved 80 m upstream
lay = {m.group(1): dict((k, float(v)) for k, v in re.findall(r"(\w+):(-?[\d.]+)", m.group(2)))
       for m in re.finditer(r"\b(before|after):\{([^}]*)\}", JS.split("const LAYOUTS=")[1].split(";")[0])}
b, a = lay.get("before", {}), lay.get("after", {})
check("Δ1 barriers moved 8 m west", b and a and a["bx0"] - b["bx0"] == -8 and a["bx1"] - b["bx1"] == -8)
check("Δ1 barriers 0.9 m narrower", b and a and abs((a["by"] - b["by"]) + 0.9) < 1e-9)
check("Δ3 pedestrian path 1.1 m → 1.8 m", b and a and abs(abs(b["hoard"] + 10.5) - 1.1) < 1e-9 and abs(abs(a["hoard"] + 10.5) - 1.8) < 1e-9)
check("Δ4 VMS-1 moved 80 m upstream", b and a and a["vms"] - b["vms"] == 80)

# 9. EN/ZH toggle: static copy carries data-zh, and every L(en, zh) in the JS has text on both sides
check("body.html has at least 30 data-zh translations", len(re.findall(r"data-zh[-=]", BODY)) >= 30)
bad = [m.group(0)[:60] for m in re.finditer(r"\bL\('([^']*)','([^']*)'\)", JS) if not m.group(1) or not m.group(2)]
check("L('en','zh') has no empty strings", not bad, str(bad[:3]))
cjk = len(re.findall(r"[一-鿿]", JS))
check(f"the JS has Chinese copy ({cjk} CJK characters)", cjk > 800)

# 10. No hard-coded localhost in the page (the live smoke test check --e2e checks this too)
check("no hard-coded localhost", "localhost" not in PAGE)

# 11. Deployment config: purely static (serves public/ only, no Worker code / bindings); deploy.sh can call npm run deploy
import json  # noqa: E402
wr_txt = (ROOT / "wrangler.jsonc").read_text(encoding="utf-8")
wr = json.loads(re.sub(r"(?m)^\s*//.*$|\s//[^\"\n]*$", "", wr_txt))
check("wrangler.jsonc serves public/ via assets", wr.get("assets", {}).get("directory") == "public")
check("wrangler.jsonc is purely static: no main / durable_objects / vars", not any(k in wr for k in ("main", "durable_objects", "vars", "kv_namespaces")))
pkg = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
check("the package.json deploy script is wrangler deploy", pkg.get("scripts", {}).get("deploy") == "wrangler deploy")
check("negative: no token / account_id in the deployment config", not re.search(r"api[_-]?token|account_id|CLOUDFLARE_", wr_txt, re.I))

# Overlapping-works check (8-clash.js, docs/decisions.md D-0929-2011 ②): the register comes from the same-origin /api/, every number from be.clash / be.stagger; no negative numbers shown when unreliable
CLASH = (SRC / "js" / "8-clash.js").read_text(encoding="utf-8")
check("clash check: the register comes via /api/public/js/worksites.js, numbers from BE.api.clash / stagger",
      "import('/api/public/js/worksites.js')" in CLASH and "BE.api.clash(" in CLASH and "BE.api.stagger(" in CLASH)
check("clash check: flags.reliable = false shows \"≈ 0 · result not reliable\" (EN and ZH)",
      "!r.flags.reliable" in CLASH and "result not reliable" in CLASH and "结果不可信" in CLASH)
check("clash check: the two kinds of ≈ 0 are worded separately: negative_delay says the baseline is over capacity, substitutes says same corridor; staggering checks best.reliable",
      "r.flags.negative_delay?" in CLASH and "r.flags.substitutes?" in CLASH and "same corridor" in CLASH and "同一走廊" in CLASH and "b&&!b.reliable" in CLASH)
check("clash check: mounted on step 3 (clashMount), the map draws the other works (clashDraw)", "clashMount();" in app_js and "clashDraw();" in app_js)
raw_title = [x for x in interpolations(CLASH) if "${" not in x and re.search(r"\.(title|name)\b", x) and "esc(" not in x]
check("clash check, negative: register titles / road names go through esc() before entering HTML", not raw_title and "esc(o.title)" in CLASH, str(raw_title[:3]))

# 9. Plan comparison · selection · export (src/js/8-compare.js)
CMP = (SRC / "js" / "8-compare.js").read_text(encoding="utf-8")
cmp_html = re.sub(r"/\* pure:begin.*?/\* pure:end \*/", "", CMP, flags=re.S)
cmp_html = "\n".join(ln for ln in cmp_html.splitlines() if "toast(" not in ln)
cmp_unsafe = unsafe_in(cmp_html)
check("compare: plan names, changes and road names in HTML templates all go through esc()", not cmp_unsafe, str(cmp_unsafe[:4]))
cmp_loads = re.findall(r"(?:import|fetch)\('([^']+)'\)", CMP)
check("compare: loads only the same-origin /api/public/js/pack.js and explain.js", sorted(cmp_loads) == ["/api/public/js/explain.js", "/api/public/js/pack.js"], str(cmp_loads))
check("compare: change descriptions and the plain-text execution pack are written with textContent", ".textContent=r?cmpWhat(r):''" in CMP and "pre.textContent=txt" in CMP)
check("compare: the formatted execution pack goes only through cmpDocHTML (every string in it goes through esc(); negative assertions in compare_glue.mjs)", CMP.count("innerHTML=doc") == 1 and "doc=cmpDocHTML(" in CMP)
check("compare, negative: the reason the user types is not concatenated into HTML (.value only)", "ta.value=CP.reason" in CMP and not re.search(r"\$\{[^}]*reason", cmp_html))
check("compare: the page states that hire rates are assumptions (EN and ZH)", "day rates and stock are assumptions" in CMP and "日租价和库存件数是假设值" in CMP)
check("compare: says a person decides (the tool does not choose for them)", "a person decides" in CMP and "由人拍板" in CMP)
check("compare: mounted under the step 4 advisor (engPanel4 has #cmp4, engRender4 calls cmpRender)", 'id="cmp4"' in ENG and "cmpRender();" in ENG)
check("compare: plan names (possibly the advisor's kind) go through esc()", "esc(cmpLabel(r))" in CMP)
probe_cmp = "`<b>${cmpLabel(r)}</b><i>${r.kind}</i>`"
check("self-check: removing esc() in the comparison is caught", len(unsafe_in(probe_cmp)) >= 1)

# 10. Finals highlights (assigned by the team lead): ① the comparison table flags the plan with "the same result but costs more"; ② a "nearby works" clash row (③ "how much shorter than ROADWORK AHEAD alone" is covered by the VMS test bench, so not done here, per @jinmingq's handoff note)
#     Only shows numbers the engine already has: the page computes nothing itself and the source hard-codes none of the numbers seen during acceptance
CLASHJS = (SRC / "js" / "8-clash.js").read_text(encoding="utf-8")
T43_SRC = JS + "\n" + BODY + "\n" + (SRC / "styles.css").read_text(encoding="utf-8")
t40_lits = [x for x in ["1,250", "1250", "33,015", "33015", "25,719", "25719"] if x in T43_SRC or x in PAGE] \
    + re.findall(r"(?<![\w.])725(?!\d)", T43_SRC + PAGE)
check("finals, negative: no acceptance-run numbers (1,250 / 33,015 / 25,719 / 725) in the source or bundle; they all come from the engine", not t40_lits, str(t40_lits[:4]))
check("finals ①: \"Same result as A · +A$…\" is computed column by column by cmpSameAs(CP.rows), with neither letter nor amount hard-coded (EN/ZH paired)",
      "dup=cmpSameAs(CP.rows)" in CMP and "function cmpSameAs(rows){" in CMP and "String.fromCharCode(65+d.of),amt=fmtN(d.extra)" in CMP
      and "L(`Same result as ${a} · +A$${amt}`,`结果和 ${a} 一样 · 多花 A$${amt}`)" in CMP and 'class=\\"cmp-dup\\"' in CMP.replace('"', '\\"'))
t40_same = CMP[CMP.index("function cmpSameAs(rows){"):CMP.index("function cmpSpan(")]
check("finals ①, negative: not a special case for column B (no rows[1] / 'B' / i===1 in cmpSameAs)",
      not re.search(r"rows\[1\]|'B'|===1\b", t40_same))
check("finals ②: the clash row uses the same pick as 8-clash.js (clashPick) + BE.api.clash per plan; the table renders first and this row fills in later; no overlap shows none, a failure shows — and console.warn",
      "async function clashPick(cur,alive){" in CLASHJS and "await clashPick(clashCur(),()=>seq===CL.seq)" in CLASHJS
      and "await clashPick(cur,alive)" in CMP and "BE.api.clash(r.plan.worksites[0],x.ws)" in CMP and "${cmpClashRow(rc)}" in CMP
      and "cmpUpdate();cmpExplainUpdate();cmpClashUpdate();" in CMP and "L('none','无')" in CMP
      and "console.warn('compare: clash check failed for plan'" in CMP and "console.warn('compare: nearby works check failed'" in CMP
      and "L('Nearby works','和附近施工叠加')" in CMP)
check("finals ②: if 03 has been visited, reuse the works it picked (CL.other); otherwise pick now with the same rule",
      "in3=CL.m&&CL.key===JSON.stringify(cur)&&!CL.busy&&!CL.err;" in CMP and "x3=in3?cmpClashOther(CL.other,CL.st):null" in CMP
      and "if(in3)x=x3;" in CMP)
# Decided by the team lead on 30 Sep (follows #123): after "Stagger N days" in 03, 04's clash row follows 03, using 03's stagger().worksite; the row name shows the shifted date + "staggered N days"
check("04's clash row uses the same worksite as 03 after staggering (cmpClashOther reads the reliable best from CL.st); the cache key includes N, so 04 recomputes when 03 staggers / undoes it",
      "function cmpClashOther(x,st){" in CMP and "b&&b.reliable&&st.worksite?{...x,ws:st.worksite,days:b.days" in CMP
      and "key=CP.key+(x3&&x3.days!=null?`|+${x3.days}`:'')" in CMP and "if(CP.cl&&CP.cl.key===key)return;" in CMP
      and "CP.cl.key===CP.key" not in CMP)
check("the row name shows the shifted date + \"staggered N days\" (EN/ZH paired, cmpClashWhen in the pure block); if the user is already on 04 when staggering finishes, it updates too (cmpRender() at the end of clashStagger)",
      "function cmpClashWhen(x,zh,hour){" in CMP and "`已错开 ${n} 天`:`staggered ${n} day${Math.abs(n)===1?'':'s'}`" in CMP
      and "${cmpClashWhen(x,LANG.cur==='zh',engHour)}" in CMP
      and CMP.index("function cmpClashWhen(") < CMP.index("/* pure:end */")
      and "CL.stBusy=false;clashRender();\n  cmpRender();" in CLASHJS)

# 11. @unicornnnnnny, 30 Sep: 01 works info / sign guidance no longer show the engine's four numbers; 02 marks conflicts / critical / harsh braking from the simulation on the map
GRIDJS = (SRC / "js" / "4b-grid.js").read_text(encoding="utf-8")
check("01 works info / sign guidance tabs no longer show the four \"engine · real CBD traffic\" numbers; only a one-line hint when no street is chosen / the engine cannot compute",
      "engOutSec()" not in app_js and app_js.count("engStateSec()") == 2 and "function engStateHTML(){" in ENG and "['engState',engStateHTML]" in ENG)
check("the 4×4 simulation records harsh braking and conflicts with positions in sim.events (conflict TTC < 1.5 s, critical < 1.0 s, 2×2 only); the map draws them with drawEvents",
      "kind:'harsh'" in GRIDJS and "kind:'conflict'" in GRIDJS and "ttc:1.5,ttcCrit:1" in GRIDJS and "if(e.kind==='harsh'){" in app_js
      and "const keep=sim.isGrid?EV_KEEP_GRID:25" in app_js)
check("negative: the harsh-braking threshold in the 02 panel comes from the 4×4 simulation's own GRID_P.harsh (3.5), no longer the old scene's 4.2",
      "-GRID_P.harsh/GRID_K" in app_js and "grid?fmtN(-GRID_P.harsh/GRID_K*10)/10:'4.2'" in app_js)
check("the 02 panel has a legend explaining the map and timeline markers (EN/ZH paired); conflicts / critical are also diamonds, not confused with signal dots",
      "L(`map: last ${EV_KEEP_GRID} s · timeline: share of vehicles, per 10 min`,`地图标最近 ${EV_KEEP_GRID} 秒 · 时间轴：每 10 分钟车辆占比`)" in app_js and 'class="eng-legend ev-legend"' in app_js
      and "evDiamond(px,py,sim.isGrid?(e.sev===2?7.5:6.5)" in app_js and "ev-dot" not in app_js)
check("the 02 timeline is now a 100% stacked bar per 10 minutes (red = share of vehicles with harsh braking or in a conflict, grey = the rest), both segments labelled with percentages; other steps scale to the busiest minute (no longer capped at 3 per minute)",
      "function histShare(c,sim,top,bot){" in app_js and "hit/seen" in app_js and "pct(1-p)" in app_js
      and "Math.min(1,v/3)" not in app_js[app_js.index("function drawHist(){"):app_js.index("function histShare(")] and "const mx=Math.max(3,top1)" in app_js
      and "this.mSeen=new Float32Array(60);this.mHit=new Float32Array(60);" in GRIDJS and "mBy" not in GRIDJS + app_js)
check("the 02 4×4 simulation records minutes by clock time (clock0 = clock − simulated seconds), so timeline bars line up with the clock hand",
      "s.clock0=CLOCK_EVENT-s.t;return s;" in app_js and "g.clock0=S.clock-g.t;" in app_js)

# 12. SUMO primary, engine behind the scenes (docs/decisions.md D-1001-0045): plans SUMO covers (this stretch of Lonsdale, 1 lane closed) show no engine traffic results in 04 / 05, 03 nearby works or the VMS test bench;
#     the rendered page is checked by negative assertions in compare_glue.mjs / vlab_glue.mjs; this file only checks the wiring
LAB = (SRC / "js" / "6d-vmslab.js").read_text(encoding="utf-8")
CSS = (SRC / "styles.css").read_text(encoding="utf-8")
check("the SUMO-plan test matches sumoImpactHTML in 5-app.js (SUMO_LINK, not a full closure, 1 lane closed)",
      "function suPlan(){return typeof SUMO_LINK==='string'&&EP.link===SUMO_LINK&&!EP.all&&EP.lanes===1;}" in CMP
      and "if(EP.link!==SUMO_LINK||EP.all||EP.lanes!==1)return'';" in app_js)
check("04 uses runOptions from sumo-client.js (loaded via sumoClient() in 5-app.js, feature-detected), p from the engine's sign reading, with SU.seed; no separate import",
      "await sumoClient()" in CMP and "typeof cli.runOptions==='function'" in CMP and "return fn(ask,{seed});" in CMP  # via cmpSuJob (cache + sumoLane)
      and "const ask=cmpSuAsk(CP.rows);" in CMP and "function cmpSuAsk(rows){return(rows||[]).map(r=>({id:r&&r.id,p:r?cmpP(r.s):null}))" in CMP
      and "cmpUpdate();cmpExplainUpdate();cmpClashUpdate();cmpSuUpdate();" in CMP)
check("no runOptions / failure → shows the reason (EN/ZH paired), with no engine numbers standing in; error text goes through esc() before HTML",
      "this SUMO client has no runOptions yet" in CMP and "SUMO 客户端还没有 runOptions" in CMP and "${esc(su.err)}" in CMP and "${esc(s.why)}" in CMP)
check("on SUMO plans the traffic rows of the 04 table are replaced by cmpSuRows (drivers who detour / 09:00 queue / per vehicle / total delay / detouring vehicles / trams, buses and pedestrians not covered by SUMO)",
      "${su?cmpSuRows(rc):mRows.map(" in CMP and "L('Drivers who detour (AI sign reading)','AI 读牌 → 会绕行的司机')" in CMP
      and "L('not covered by SUMO','SUMO 暂不覆盖')" in CMP and "L('SUMO computing the options in the cloud','SUMO 正在云端计算这几套方案')" in CMP)
check("two plans with the same p show \"same traffic effect as A · models don't value the arrow board's safety role · +A$…\" (neutral style, not the red \"wasted money\")",
      "交通效果和 ${a} 相同 · 模型不评价箭头板的安全作用 · 多 A$${amt}" in CMP and "models don't value the arrow board's safety role" in CMP
      and "<i class=\"cmp-dup\" data-eq>" in CMP and ".cmp-table .cmp-dup[data-eq]{" in CSS)
check("no AI explanation on SUMO plans (explain.js reads engine numbers); hidden, with the reason stated",
      "if(CP.busy||!CP.rows.length||suPlan()){" in CMP and "No AI explanation for this plan" in CMP and "这套方案不显示 AI 解读" in CMP)
check("03 nearby works on SUMO plans goes through clashSuHTML (combined impact not covered by SUMO, suggested stagger days), with no engine stagger button; other plans are labelled \"engine estimate\"",
      "if(suPlan())return clashSuHTML();" in CLASH and "function clashSuHTML(){" in CLASH and "叠加影响 SUMO 暂不覆盖" in CLASH
      and "!(x.r.cost>0)||suPlan())return'';" in CLASH and "引擎估算。叠加冲突" in CLASH and "L('engine estimate','引擎估算')" in CMP)
check("the VMS test bench on SUMO plans goes through vlSuHTML (detour share, strongest detour signal, effect computed by SUMO in step 2, no DELAYS N MIN); other plans are labelled \"engine estimate\"",
      "if(suPlan())return vlSuHTML();" in LAB and "function vlBestShare(rows){" in LAB and "(suPlan()?vlBestShare:vlBest)(VL.rows)" in LAB
      and "for(const c of vlCands(b,suPlan())){" in LAB and "if(dm>=2&&!su)" in LAB
      and "由第 2 步的 SUMO 计算" in LAB and "Each row: engine estimate on this plan" in LAB)
t49_lits = [x for x in ["918", "509", "10,493", "10493", "18,693", "18693", "33,015", "33015"] if x in CMP + CLASH + LAB]
check("negative: no engine numbers seen live (918 / 509 / 10,493 / 18,693 / 33,015) in the 04 / 03 / test-bench source", not t49_lits, str(t49_lits))

# 13. @unicornnnnnny, 1 Oct: the top-left uses the team's final logo; "Ripple" takes the theme text colour (light text on dark, dark text on light), the rest follows the original artwork; PNGs embedded in the page
CSS_ALL = (SRC / "styles.css").read_text(encoding="utf-8")
check("the top-bar brand area is the new logo (role=img, aria-label=RippleTwin); the old circle icon and text are gone",
      '<span class="brand-logo" role="img" aria-label="RippleTwin"></span>' in BODY and "brand-name" not in BODY + CSS_ALL and ".brand>svg" not in CSS_ALL)
check("both logo layers are embedded PNGs (the page is still a single file): road + Twin follow the original artwork; Ripple is a mask filled with --fg, so it follows the dark/light theme",
      '.brand-logo{position:relative;display:block;width:148px;height:30px;background:url("data:image/png;base64,' in CSS_ALL
      and '--logo-ripple:url("data:image/png;base64,' in CSS_ALL and "background:var(--fg);-webkit-mask:var(--logo-ripple)" in CSS_ALL
      and "mask:var(--logo-ripple) left center/contain no-repeat}" in CSS_ALL)

# 14. @unicornnnnnny, 1 Oct: the step 2 camera frames the whole 4×4 (16 junctions), not just the 2×2 at the works; "click again to zoom out" and ⌖ also return to the 4×4
check("gridFly uses gridFit() to frame the 16 junctions (S.sim.spec.junctions) + a zebra-crossing margin, via fitView to avoid the panel; falls back to the 2×2 only without a spec",
      "function gridFit(){" in app_js and "S.sim.spec.junctions" in app_js and "return fitView(Math.min(...xs)-m,Math.max(...xs)+m,Math.min(...ys)-m,Math.max(...ys)+m,3);" in app_js
      and "const f=gridFit();if(f)flyTo(f[0],f[1],f[2],d);else flyTo((GRID_BOX.x0" in app_js and "function fitView(x0,x1,y0,y1,maxS){" in ENG)

# 14. @unicornnnnnny, 1 Oct: the fine window (high-resolution imagery / building shadows) covers the whole step 2 4×4, no longer half on the vector basemap
wm = re.search(r"const WORLD=\{x0:(-?\d+),x1:(-?\d+),y0:(-?\d+),y1:(-?\d+)\};", WORLD_JS)
wx0, wx1, wy0, wy1 = (int(v) for v in wm.groups()) if wm else (0, 0, 0, 0)
check("WORLD covers the 16 junctions (x −195…401, y −300…9) plus one street width, with sides divisible by 40 (CELL 2 / RISK_CELL 4 / weather cells 5, 8)",
      bool(wm) and wx0 <= -195 - 30 and wx1 >= 401 + 30 and wy0 <= -300 - 30 and wy1 >= 9 + 30 and (wx1 - wx0) % 40 == 0 and (wy1 - wy0) % 40 == 0,
      str((wx0, wx1, wy0, wy1)))
check("the fine window's streets add Exhibition St (x ≈ 401) and Little Bourke St (y ≈ −300)",
      "{id:'exhibition',name:'Exhibition St',zh:'展览街',axis:'v',c:402," in WORLD_JS and "{id:'lbourke',name:'Little Bourke St',zh:'小博克街',axis:'h',c:-300," in WORLD_JS)

# 15. @unicornnnnnny, 1 Oct: the 04 table / 05 cards on SUMO plans are no longer full of "not covered by SUMO": the tram/bus and pedestrian rows are gone (the table footer says "cars only"),
#     each cell of the clash row says "suggest staggering N days"; the execution pack (print document) still states that SUMO does not cover trams, buses or pedestrians
check("the 04 table on SUMO plans omits the tram/bus and pedestrian rows, the footer says cars only (EN and ZH); the clash row uses cmpSuStagger()",
      "[L('Trams & buses','电车公交'),L('Pedestrians','行人')].map(" not in CMP and "around the works · cars only${" in CMP and "路网上算 · 只含机动车${" in CMP
      and "function cmpSuStagger(x){" in CMP and "x?cmpSuStagger(x):'…'" in CMP and "L('combined impact not covered by SUMO'" not in CMP)
check("05 cards on SUMO plans omit the tram/bus and pedestrian cells; the execution pack still states SUMO does not cover them (the print document must be explicit)",
      "${su?'':cell('transit'," in CMP and "trams, buses and pedestrians are not covered by SUMO. Hire: whole works period." in CMP)

print(f"{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
