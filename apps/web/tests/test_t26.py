"""Static assertions for T26: finishing T20 (docs/hackathon/specs/T26-T27-web-PRD.md section 2).

Usage: python3 apps/web/tests/test_t26.py
The last line is always "N passed, M failed"; any failure exits with code 1.
"""
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import build  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / "src"
APP = (SRC / "js" / "5-app.js").read_text(encoding="utf-8")
ENG = (SRC / "js" / "6-engine.js").read_text(encoding="utf-8")
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


def fn(src, name):
    """Function body (matched by brace pairing)"""
    i = src.index(f"function {name}(")
    j = src.index("{", i) + 1
    d, k = 1, j
    while d:
        d += {"{": 1, "}": -1}.get(src[k], 0)
        k += 1
    return src[j:k - 1]


# 2.1 The scene name in the top bar follows the scene on screen
scene = re.search(r'<span class="scene-name"[^>]*>([^<]*)</span>', BODY)
check("2.1 negative: .scene-name in body.html does not hard-code La Trobe", scene is not None and "La Trobe" not in scene.group(0), scene.group(0) if scene else ".scene-name not found")
check("2.1 the map canvas aria-label does not hard-code La Trobe", re.search(r'<canvas id="mapCanvas"[^>]*La Trobe', BODY) is None)
us = fn(APP, "updateScene")
check("2.1 updateScene(): the micro scene shows the La Trobe junction, otherwise the works street + direction + hour (EN and ZH)",
      "microOn()" in us and "shortSt(EP.street)" in us and "dirL(EP.dir)" in us and "engHour(EP.hour)" in us and "墨尔本 CBD" in us)
check("2.1 every panel redraw updates the scene name (step, plan and language switches all go through renderPanel)", "syncMicro();updateScene();" in APP)

# 2.2 "Back to the works"
home = re.search(r"\$\('#zoomHome'\)\.onclick=\(\)=>\{([^}]*)\}", APP)
check("2.2 negative: #zoomHome no longer only flies to HOME; with an engine plan it calls engFly()", home is not None and "engFly(" in home.group(1) and "microOn()" in home.group(1), home.group(0) if home else "")

# 2.3 Step 1: four headline numbers, then the VMS input, then the rest of the notes
p1 = fn(ENG, "engPanel1")
check("2.3 step 1 order: works → engine's 4 numbers → VMS input → notes / transit and pedestrians / badges (engPanel1 is built from three parts)",
      "engSiteHTML()+engOutSec()+engSignsHTML()+'<div id=\"engMore\"" in p1 and "data-foot" in fn(ENG, "engSiteHTML")
      and 'id="engOut"' in fn(ENG, "engOutSec") and 'id="vmsF1"' in fn(ENG, "engSignsHTML"))
out = fn(ENG, "engOutHTML")
check("2.3 #engOut holds only the 4 headline numbers (notes, transit and pedestrians, badges moved to #engMore)",
      "engMetrics(s)" in out and "engWhy(s)" not in out and "engImpacts(s)" not in out and "engBadges(" not in out)
more = fn(ENG, "engMoreHTML")
check("2.3 #engMore holds the assumptions note, transit and pedestrians, sign-reading / parameter badges (badges still go through engBadges → aiPlanSrc / aiSrcLabel)",
      all(x in more for x in ["engWhy(s)", "engImpacts(s)", "engBadges(s.flags,s)"]) and "aiPlanSrc(s,f)" in ENG and "aiSrcLabel(rs.src)" in ENG)
check("2.3 engRenderOut refreshes both blocks together", "['engOut',engOutHTML],['engMore',engMoreHTML]" in ENG)

# 2.4 Framing avoids the legend
fit = fn(ENG, "engFit") + fn(ENG, "fitView")  # the framing algorithm was pulled out into fitView()
check("2.4 desktop framing counts the height of the (collapsed) bottom-left legend in the bottom margin", "getElementById('legend')" in fit and "offsetHeight" in fit)
check("2.4 the legend starts collapsed every time the page opens", "$('#legend').classList.add('collapsed')" in APP)

# 2.5 Two assumption lines
why = fn(ENG, "engWhy")
check("2.5 negative: the page copy has no \"follow the signs\" / \"act on the signs\" wording", not re.search(r"照标志|屏走|act on the signs", PAGE))
check("2.5 the 53 % is about \"understanding the sign text\"; whether drivers divert comes from the route-choice model, and this run's detour share is shown", "读懂屏上的字" in why and "路线选择模型" in why and "pctS(s.detour_share)" in why)
why_txt = re.sub(r"//[^\n]*", "", why)  # comments may cite data sources; the page text does not
check("2.5 trust is labelled \"assumed value\", not \"per T12 parameters\"", "假设值" in why_txt and "assumed value" in why_txt and "T12" not in why_txt)
check("2.5 a full closure (cap = 0) also gets a line explaining where the queue comes from", "EP.all||(l&&l.cap===0)" in why and "施工段全封" in why)
check("2.5 negative: the \"Drivers detouring\" row does not pass better=true (neutral colour)",
      re.search(r"row\(L\('Drivers detouring','绕行的车'\),[^)]*\),pctS\(da\),true\)", ENG) is None
      and "row(L('Drivers detouring','绕行的车'),pctS(B.detour_share),pctS(da),null)" in ENG and "better==null?'var(--fg)'" in ENG)
i = ENG.index("的前提：")
check("2.5 the step 4 detour-premise line does not say \"T12 parameters\" either", "T12" not in ENG[i - 200:i + 200])
check("2.5 the vehicle count beside \"extra wait per vehicle\" says it is the main approach", "${L('main approach','主进口道')} ${fmtN(s.vehicles)}" in ENG)

# 2.6 Wording that overstated things
check("2.6 step bar (switched to the 6-step workbench on 30 Sep): Overview / Configure / Simulate / Impact / Compare / Export",
      all(x in BODY for x in ['data-zh="路况总览">Overview', 'data-zh="配置施工">Configure', 'data-zh="仿真评估">Simulate', 'data-zh="影响分析">Impact', 'data-zh="比较方案">Compare', 'data-zh="确认导出">Export'])
      and not re.search(r"Stress test|Ripple trace|>Repair<|压力测试|涟漪追踪|\"修复\"", BODY))
check("2.6 (review) the step 3 panel subtitle matches the step bar (\"Impact\"); negative: no \"Ripple trace\" left on the page",
      "L('Impact · network','影响 · 路网')" in ENG and not re.search(r"Ripple trace|涟漪追踪", PAGE))
check("2.5 (review) the parameter badge reads \"T12 (trust is assumed)\"; negative: no \"T12 sources\" / \"with sources\"",
      "L('Parameters · T12 (trust is assumed)','参数 · T12（信任度是假设值）')" in ENG and not re.search(r"T12 sources|T12 with sources|有出处", PAGE))
check("2.6 negative: no \"generate a safer layout\" wording (v2 is a preset layout, not generated)", "Generate a safer layout" not in APP)
check("2.6 negative: the page no longer says \"agents\" (it suggests AI is involved)", "智能体" not in APP and "Agents involved" not in APP and "AGENT IMPACT" not in APP)

# AI panel hooks (PRD 4.3: T26 neither removes nor moves them)
check("step 3 AI panel hooks still present (clashMount();aiMount();)", "clashMount();aiMount();" in APP)

print(f"{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
