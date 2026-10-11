"""Static assertions for the liquid-glass UI: no browser, only the sources and the bundle are read (docs/hackathon/specs/T14-liquid-glass-PRD.md).

Usage: python3 apps/web/tests/test_glass.py
The last line is always "N passed, M failed"; any failure exits with code 1.
"""
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import build  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
CSS = (SRC / "styles.css").read_text(encoding="utf-8")
GLASS = (SRC / "js" / "7-glass.js").read_text(encoding="utf-8")
APP = (SRC / "js" / "5-app.js").read_text(encoding="utf-8")
BODY = (SRC / "body.html").read_text(encoding="utf-8")
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


def block(src, head):
    """Contents of the @media / @supports block starting with head (matched by brace pairing)"""
    i = src.find(head)
    if i < 0:
        return ""
    j = src.index("{", i) + 1
    depth = 1
    k = j
    while depth and k < len(src):
        depth += {"{": 1, "}": -1}.get(src[k], 0)
        k += 1
    return src[j:k - 1]


# 1. Fallbacks: reduced transparency → solid, no blur; no backdrop-filter support → solid; reduced motion → no transitions
rt = block(CSS, "@media (prefers-reduced-transparency: reduce)")
check("prefers-reduced-transparency: glass turns solid and backdrop-filter is switched off",
      "var(--shell-solid)" in rt and re.search(r"(?<!-)backdrop-filter:none", rt))
check("with prefers-reduced-transparency the JS does not attach the refraction filter", "prefers-reduced-transparency: reduce" in GLASS)
check("@supports not (backdrop-filter): glass turns solid", "var(--shell-solid)" in block(CSS, "@supports not ((backdrop-filter"))
check("prefers-reduced-motion: no transitions on panel collapse / fold arrows", "transition:none" in block(CSS, "@media (prefers-reduced-motion: reduce){\n  .panel"))

# 2. Legibility: the glass tint is very light (see-through, Apple style); --glass-tone darkens (dark theme) / brightens (light theme) the map behind it to keep 4.5:1.
#    Measured (29 Sep, 1440×900, 3 basemaps × 6 weather types × dark and light, worst case of the smallest text --fg-3 over highlights and cards):
#    at tint 0.40 dark ≥ 4.50, light ≥ 4.57; after making it more transparent that evening (0.30, darken .44 / brighten 1.24) dark ≥ 4.63, light ≥ 4.57
t14 = CSS[CSS.find("T14 liquid glass"):]
shells = [float(a) for a in re.findall(r"--shell:rgba\([^)]*,\s*(\.\d+)\)", t14)]
check(f"the regular glass tint is light (--shell opacity ≤ 0.35, {len(shells)} places)", len(shells) == 3 and max(shells) <= .35, f"{shells}")
tones = re.findall(r"--glass-tone:(brightness[^;]+);", t14)
check("both themes have --glass-tone: dark darkens (brightness < 1), light brightens (brightness > 1)",
      len(tones) == 3 and float(re.search(r"brightness\(([\d.]+)", tones[0]).group(1)) < 1
      and all(float(re.search(r"brightness\(([\d.]+)", t).group(1)) > 1 for t in tones[1:]))
check("every glass block's backdrop-filter includes var(--glass-tone)",
      re.search(r"\.top,\.rail,\.panel,\.timeline,\.panel-open\{[^}]*backdrop-filter:blur\(\d+px\) var\(--glass-tone\)", t14) is not None
      and re.search(r"\.glass\{[^}]*backdrop-filter:blur\(\d+px\) var\(--glass-tone\)", t14) is not None)
check("refraction also goes through CSS: .lg-on uses var(--lg-url) + var(--glass-tone); the JS only sets --lg-url",
      "backdrop-filter:var(--lg-url) blur(var(--lg-blur,12px)) var(--glass-tone)" in t14
      and "setProperty('--lg-url'" in GLASS and "el.style.backdropFilter=" not in GLASS)
check("adapts to the background: --tone-deep on dark basemaps / heat, --tone-fog in thick fog",
      ':root[data-bm="imagery"],:root[data-bm="nir"],:root[data-wx="heat"]{--glass-tone:var(--tone-deep)' in t14
      and ':root[data-wx="fog"]{--glass-tone:var(--tone-fog)}' in t14 and t14.count("--tone-deep:") == 3)
check("the JS writes the current basemap / weather to <html data-bm / data-wx>",
      "document.documentElement.dataset.bm=S.basemap" in APP and "document.documentElement.dataset.wx=k" in APP
      and "document.documentElement.dataset.wx=S.wx" in APP)

# 3. Refraction only on desktop Chromium, on 1–2 panels only (PRD: backdrop-filter for a few HUD elements, refraction for 1–2 panels)
check("refraction only at desktop widths (≥ 821px)", "(min-width: 821px)" in GLASS)
check("Safari / Firefox get no SVG refraction (CSS frosted glass instead)", re.search(r"Firefox.*Safari", GLASS) is not None)
n_fx = len(re.findall(r"GL\.fx\.push\(liquidGlass\(", GLASS))
check(f"{n_fx} refracting panel(s) (≤ 2)", 1 <= n_fx <= 2)
check("the filter interpolates in sRGB (otherwise neutral grey becomes a constant displacement)", "'color-interpolation-filters','sRGB'" in GLASS)

# 4. Licence: the referenced liquid-glass.js is MIT and the attribution stays in the source; the page still only connects to Google Fonts (test_web checks external URLs)
check("attribution: liquid-glass.js · Deepika Rao · MIT", "Deepika Rao" in GLASS and "sven1577/liquid-glass" in GLASS and "MIT" in GLASS)
check("no third-party libraries pulled in", not re.search(r"<script[^>]+src=", PAGE))

# 5. The map fills the window and the glass floats on top; --safe-* are the occlusion insets the JS reads
desk = block(CSS, "@media (min-width:821px){")
check("desktop: the map is fixed and fills the window", re.search(r"\.map\{position:fixed;inset:0", desk))
check("desktop: .app declares --safe-t / --safe-b / --safe-l / --safe-r",
      all(f"--safe-{k}:" in desk for k in "tblr"))
check("the JS reads --safe-* (readInsets); view / scale bar / alerts all avoid the glass",
      "--safe-l" in GLASS and "insets()" in APP and "GL.ins.l+22" in APP)
check("narrow screens go back to a vertical stack (no floating layers at ≤ 820px)", "@media (max-width:820px)" in CSS and "(min-width:821px)" in CSS)

# 6. Leaner right panel: the compact / details toggle, fold headings and the collapse button all have EN and ZH
check("the compact / details toggle has Chinese", "L('Compact','简洁')" in GLASS and "L('Details','详细')" in GLASS)
check("the collapse-panel button has Chinese", "收起面板" in GLASS)
check("the expand-panel button (body.html) has data-zh / data-zh-aria-label",
      'id="panelOpen"' in BODY and 'data-zh-aria-label="展开分析面板"' in BODY and 'data-zh="分析面板"' in BODY)
check("fold headings work from the keyboard (role=button + Enter / Space)",
      "setAttribute('role','button')" in GLASS and "e.key==='Enter'" in GLASS and "aria-expanded" in GLASS)
check("compact mode hides only explanatory text, never numbers (.metrics / inputs / plan cards expanded by default)",
      ".panel.compact p.muted{display:none}" in CSS and ".metrics" in GLASS and "textarea" in GLASS)
check("the copy-failed hint still shows in compact mode", "#copyFallback p.muted{display:block}" in CSS)

# 6b. One action colour (decided 29 Sep): primary buttons, the play key and selected states use --sun; in the light theme orange text uses the darker --sun-ink (contrast)
act = CSS[CSS.find("one action colour"):CSS.find("floating layout (desktop)")]
check("primary buttons / play key / selected chips, speed and language all use --sun",
      all(re.search(sel + r"[^{]*\{[^}]*background:var\(--sun\)", act) for sel in (r"\.btn", r"\.play", r"\.chips \[aria-pressed")))
check("the light theme has a darker orange text colour --sun-ink", CSS.count("--sun-ink:#874800") == 2)

# 7. Roads clearer than buildings (requested 29 Sep): basemap redraw darkens roofs and outlines kerbs
check("basemap redraw calls emphasizeRoads (once per view change, not every frame)",
      re.search(r"function renderBase\(\)\{[\s\S]*?emphasizeRoads\(", APP) is not None
      and not re.search(r"function render\(dt\)\{[^}]*emphasizeRoads", APP))

# 30 Sep, @unicornnnnnny: the panel's bottom buttons always float (no scrolling to the end); the left layer bar is smaller, same position
CLASH = (SRC / "js" / "8-clash.js").read_text(encoding="utf-8")
desk = CSS[CSS.index("@media (min-width:821px){"):]
check("desktop: the panel's .cta (find a better plan / stagger N days / copy playbook) is sticky at the panel bottom with no bar and no card; each button is a dark liquid-glass block (like the weather legend .glass: highlight, bright rim, shadow), not orange",
      ".panel .cta{position:sticky;bottom:-8px;z-index:2;margin:auto -8px -8px;padding:10px 8px 8px;background:none;border:0;box-shadow:none}" in desk
      and re.search(r"\.panel \.cta \.btn:not\(:disabled\)\{background:linear-gradient\(150deg,var\(--hl\)[^}]*color-mix\(in srgb,var\(--shell-solid\) 95%,transparent\);color:var\(--fg\);[^}]*var\(--rim\)", desk) is not None
      and "var(--sun)" not in desk[desk.index(".panel .cta{"):desk.index(".panel .cta .note{")])
check("without frosted glass / with reduced transparency, glass blocks get a solid background (the buttons are already nearly solid; no bottom bar any more)",
      all(".glass{background:var(--shell-solid)" in blk for blk in [CSS[CSS.index("@supports not"):], CSS[CSS.index("prefers-reduced-transparency"):]]))
check("\"Stagger N days\" moved into the #clashAct slot of the bottom button strip (clashBtnHTML); the clash-check section keeps only the explanation",
      "cta.prepend(a)" in CLASH and "a.id='clashAct'" in CLASH and "function clashBtnHTML()" in CLASH
      and CLASH.count('id="clashStagger"') == 1 and "面板底部的「错开 ${n} 天」" in CLASH)
check("left layer bar is smaller (50 px wide, 36 px buttons, 17 px icons) and still centred between the top bar and the timeline",
      "left:12px;width:50px;" in desk and "translateY(-50%)" in desk[desk.index("  .rail{"):desk.index("  .rail{") + 200]
      and ".rail button{width:36px;height:36px;" in CSS and ".rail button svg{width:17px;height:17px}" in CSS)

# 30 Sep, @unicornnnnnny: data sources without a border, centred below the map; the site defaults to English
cr = desk[desk.index("  .credits{"):desk.index("}", desk.index("  .credits{"))]
check("data-sources line: not .glass (no frame or background), centred below the visible map on desktop, text has a halo in the background colour for legibility",
      'class="credits" id="credits"' in BODY and "translateX(-50%)" in cr and "justify-content:center" in cr
      and "text-shadow:0 0 2px var(--shell-solid)" in cr and "border-radius" not in cr and "padding" not in cr)
check("first visit is in English: Chinese only if the user chose it (rt-lang), no switching by browser language",
      "LANG.cur=lg==='zh'?'zh':'en';" in APP and "navigator.language" not in APP and "const LANG={cur:'en'}" in (SRC / "js" / "0-i18n.js").read_text(encoding="utf-8"))
check("first visit is dark: <html data-theme=\"dark\"> (no light flash before scripts run); start-up only honours a light theme the user chose (rt-theme), not the system setting",
      '<html lang="en" data-theme="dark">' in PAGE and "document.documentElement.dataset.theme=ls.get('rt-theme')==='light'?'light':'dark';" in APP)

# 30 Sep, tutor feedback: too much text on the right ("limit the words"). Compact mode keeps only numbers, buttons and one assumptions line; source footnotes, each plan's AI explanation and the leaning rationale move to "Details"
ENGJS = (SRC / "js" / "6-engine.js").read_text(encoding="utf-8")
CMPJS = (SRC / "js" / "8-compare.js").read_text(encoding="utf-8")
check("compact mode hides the source footnotes (.legend-src), each plan's AI explanation (.cmp-explain), the leaning rationale (.cmp-lean-why), duplicate source badges (.eng-badges), the step 1 transit/pedestrian line (.eng-impacts) and the step 4 savings unit note (.eng-units; cards and headers already carry units); details mode still shows them all",
      ".panel.compact .legend-src,.panel.compact .cmp-explain,.panel.compact .cmp-lean-why,.panel.compact .eng-badges,.panel.compact .eng-impacts,.panel.compact .eng-units,.panel.compact .note-more,.panel.compact .eng-assume{display:none}" in CSS
      and "w.className='cmp-lean-why'" in CMPJS and 'class="cmp-explain"' in CMPJS)
check("the assumptions note is shortened to one line without losing meaning: share who understand · detour share · route-choice model · trust is an assumed value",
      "of drivers understand the sign · `" in ENGJS and "(route-choice model; trust in signs is an assumed value)" in ENGJS
      and "arrive, ${fmtN(l.cap)} veh/h get past" in ENGJS and "the route-choice model's per-driver-type parameters" not in ENGJS)
check("negative: \"Reword\" replaced by the plainer \"Edit sign\"; the step 1 button note no longer hard-codes La Trobe × Swanston (step 2 covers 4 junctions now)",
      "Reword" not in ENGJS + CMPJS and "L('Edit sign','改字')" in ENGJS and "Micro-simulation of the La Trobe × Swanston junction" not in APP)

CLASHJS = (SRC / "js" / "8-clash.js").read_text(encoding="utf-8")
check("compact mode collapses \"Where traffic goes\" by default (SEC_FOLD); clash check and plan comparison have their own tab / step, and their heading rows still show the key point: clash check shows the clash cost, comparison shows the leaning plan",
      "const SEC_FOLD='.eng-where';" in GLASS and "hd.textContent=row?L('Leaning: ','倾向：')+cmpLabel(row)" in CMPJS and 'class="row between cmp-head"' in CMPJS and "!sec.matches(SEC_FOLD)&&(" in GLASS and 'class="stack eng-where"' in ENGJS
      and "r.flags.reliable&&r.cost>0?`+${fmtN(r.cost)} ${U}`" in CLASHJS)
check("with the footpath open, pedestrians take a single line; the step 1 footpath options are short (Works side closed / Both sides closed)",
      "L('Footpath open · no detour','人行道照常 · 不用绕')" in ENGJS and "L('Works side closed','施工侧封')" in ENGJS and "Works-side footpath closed" not in ENGJS)

# 30 Sep, @unicornnnnnny: step 2 4×4, clicking a junction flies to it and zooms in; ⌖ returns to all 16 junctions
check("step 2 4×4: clicking a junction (not a drag; double-click still zooms) flies to it and zooms in, hover shows a ring and the junction name, ⌖ (gridFly) returns to all 16",
      "function gridPick(" in APP and "function gridFocus(j){" in APP and "gridBindMap();" in APP and "function gridFly(d){S.gridJ=null;" in APP
      and "L('click to zoom','点击放大')" in APP and "SCATS ${fo.id}" in APP and "cv.addEventListener('dblclick',()=>clearTimeout(pending));" in APP)

# 30 Sep, round 2 (@unicornnnnnny): three option rows, budget and access conditions, click again to zoom out, long fine print removed, side-by-side comparison table
CMP2 = (SRC / "js" / "8-compare.js").read_text(encoding="utf-8")
check("works info: lanes / time window / footpath are three labelled option rows (.opt-row), no longer crammed together",
      ENGJS.count('<div class="opt-row"><span class="opt-k">') == 3 and ".opt-row{display:grid;" in CSS)
check("constraint check: budget cap (AUD) + required access conditions (pedestrian route / public transport / emergency lane), each ticked or crossed against the plan and the engine result",
      'id="budgetIn"' in APP and all(f'data-keep="${{key}}"' in APP or k in APP for k in ["foot", "transit", "emerg"]) and "budget:3500,keep:{foot:true,transit:true,emerg:true}" in ENGJS
      and "k.emerg?row(!EP.all" in APP and "blocked_routes" in APP)
check("clicking the same junction again after zooming in returns to the 16 junctions",
      "if(S.gridJ===j.id&&V.s>=2.5)gridFly(.8);else gridFocus(j);" in APP and "L('click again to zoom out','再点一次缩小')" in APP)
check("long fine print (.eng-assume assumptions note, unit note, simulation note) is hidden in compact mode; the \"Assumptions\" tab still lists each assumed value (trust, riders per trip, weather)",
      ".panel.compact .eng-assume{display:none}" in CSS and "L('Trust in signs','对标志的信任度')" in ENGJS and "L('Riders per trip','每班乘客')" in ENGJS
      and 'class="list eng-evd"' in ENGJS)
check("Compare: side-by-side table (plans across, metrics down; clicking a column highlights it, with no selection the recommended column is lit; \"Cheapest\" is written under the plan name like \"Fewest\"; over-budget in red); the panel expands to the left on this step",
      'class="cmp-table"' in CMP2 and "L('Recommended','综合推荐')" in CMP2 and "L('over budget','超预算')" in CMP2 and "cmp-sel" in CMP2 and ".panel.compact .cmp-table thead .cmp-what{display:none}" in CSS and "el.querySelectorAll('[data-cmpcol]')" in CMP2 and "<i class=\"cmp-best\">${L('Cheapest','最省')}</i>" in CMP2
      and "setWide(S.ui===4);" in APP and "function setWide(on){" in APP and ".app.ui-wide .panel #cmp4{order:-1}" in CSS)

print(f"{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
