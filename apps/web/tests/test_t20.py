"""Static assertions for T20: remove the hard-coded fake numbers from the page, label the weather as illustrative, and the five follow-ups from the simulated (AI role-play) judge panel (docs/hackathon/specs/T20-addendum.md).

Usage: python3 apps/web/tests/test_t20.py
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
WXJ = (SRC / "js" / "3-weather.js").read_text(encoding="utf-8")
GLASS = (SRC / "js" / "7-glass.js").read_text(encoding="utf-8")
BODY = (SRC / "body.html").read_text(encoding="utf-8")
CSS = (SRC / "styles.css").read_text(encoding="utf-8")
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


# ---- B1–B3: hard-coded fake numbers ----
check("B1 no safety score in the top bar (#safetyChip / updateSafety both removed)", "safetyChip" not in BODY and "safetyVal" not in PAGE and "updateSafety" not in APP)
check("B1 step 4 has no safety-score ring and no lookup-table before/after comparison", "Safety score" not in APP and "Severe conflicts" not in APP and "R.score" not in APP)
check("B1 the response playbook no longer copies lookup-table effects (severe conflicts / safety score)", "Severe conflicts" not in fn(APP, "copyPlaybook") and "Safety score" not in fn(APP, "copyPlaybook"))
check("B2 step 2 has no fake progress, no \"variant 22/30\" and no variant list", not re.search(r"data-live=\"(var|pct|dps)\"|varList|22 / 30|22 of 30", APP))
check("B2 no \"agent decisions / s\" (= agent count × 10 × speed)", "agent decisions" not in APP and "智能体决策" not in APP)
check("B2 step 2 states it is a junction micro-simulation and the counts come from this run, not the plan's engine numbers", "Junction micro-simulation" in APP and "不是方案的引擎数字" in APP)
check("B3 no \"AI red team\", \"250 agents × 30 behaviour variations\" or \"random seed 4218\" wording", not re.search(r"red team|红队|250 agents|250 个智能体|seed 4218|随机种子|行为变体|behaviour variations", PAGE, re.I))
check("B3 button renamed: the step after configuring the works is \"Save & simulate\" (6-step workbench), no longer AI red team", "Save & simulate" in APP and "保存并进入仿真" in APP and "red team" not in APP.lower())
check("step 3 replay no longer says \"reproduced in n / 50 seeds\", nor does the alert card", "Reproduced in" not in APP and "SEEDS" not in APP)
check("the timeline draws only the conflicts counted in this run, with no invented \"expected\" curve", "PROFILE" not in APP and "hash2(m,7" not in APP)

# ---- B4–B5: weather is illustrative ----
check("B4 legend badge reads \"Illustrative\", not \"Live\"", "L('ILLUSTRATIVE','示意')" in APP and "L('LIVE','实时')" not in APP)
check("B4 legend states that weather does not feed the engine", "天气不参与引擎计算" in APP)
check("B4 lightning tag has no random kA strength; the strike count is not shown", "kA" not in WXJ and "strikeCount" not in APP)
check("B5 the page opens on clear weather by default and neither reads nor writes rt-wx in localStorage", "rt-wx" not in PAGE and re.search(r"S=\{step:1,wx:'clear'", APP) is not None)

# ---- Follow-up 1: centre the map on Lonsdale ----
fit = fn(ENG, "engFit") + fn(ENG, "fitView")  # the framing algorithm was pulled out into fitView(); engFit calls it
check("1 engFit no longer forces junction (0,0) into the frame", "xs=[0]" not in fit and "const xs=[],ys=[]" in fit)
check("1 engFit sets the zoom from the area not covered by glass (insets())", "insets()" in fit and "V.w-I.l-I.r" in fit and "V.h-I.t-I.b" in fit)
check("1 engFit frames the queue line (along the real road, clipped to the network / CITY edge) and the drawn detours (share ≥ 1 %, previously ≥ 5 %)", "engSub(Math.min(s.queue_m,engReach()))" in fit and ">=.01" in fit)
check("1 re-frames when the first engine result arrives (step 1 / step 3 network)", "if(first&&(S.step===1||(S.step===3&&EP.tab3==='net')))engFly(.7);" in ENG)
check("1 entering steps 1, 3 and 4 calls engFly()", all(re.search(rf"if\(n==={n}\)\{{.*?engFly\(", APP, re.S) for n in (1, 4)) and "if(engOn()&&EP.tab3==='net')engFly();" in APP)

# ---- Follow-up 2: engine numbers expanded by default ----
check("2 SEC_KEEP includes #engOut / #eng4 (numbers arrive asynchronously and are not judged collapsible)", "#engOut" in GLASS and "#eng4" in GLASS and "sec.matches(SEC_KEEP)" in GLASS)
p1 = fn(ENG, "engPanel1")
check("2 the step 1 engine section sits below the works form and above the sign text (engPanel1 = works + engine + signs)",
      "engSiteHTML()+engOutSec()+engSignsHTML()" in p1 and "data-foot" in fn(ENG, "engSiteHTML") and 'id="engOut"' in fn(ENG, "engOutSec") and 'id="vmsF1"' in fn(ENG, "engSignsHTML"))

# ---- Follow-up 3: units ----
check("3 the advisor's savings are labelled \"whole works\" and spell out days × sampled hours", "whole works" in ENG and "全施工期" in ENG and "engWindowTxt" in ENG and "天 × 每天采样" in ENG)
check("3 the comparison table says \"this hour\"; network delay is labelled \"vehicle-minutes (this hour)\"", "这一小时 · ${engHour(EP.hour)}" in ENG and "车·分钟（这一小时）" in ENG)

# ---- Follow-up 4: one works, one time ----
check("4 microOn() decides whether the La Trobe micro scene is drawn (barriers, pedestrians, notes, Δ; pedestrians / notes also need zoom ≥ 1, except the step 2 grid sim)", all(x in APP for x in ["if(micro)drawWorks('before')", "&&walkers)planNotes()", "&&micro)drawDeltas()", "walkers=micro&&(fine||gridShown())", "if(micro)drawWorks('before');if(walkers){drawAgents(S.sim);"]))
check("4 with the engine connected and the plan not on La Trobe, the micro scene is not drawn, and it does not flash while connecting", re.search(r"if\(!BE\.api\)return false;.*?return /la trobe/i\.test\(EP\.street", fn(APP, "microOn"), re.S) is not None)
check("4 the timeline follows the micro scene (.app.no-time hides it; on desktop --safe-b shrinks)", "classList.toggle('no-time',!on)" in APP and ".app.no-time .timeline{display:none}" in CSS and ".app.no-time{--safe-b:24px}" in CSS)
check("4 the step 1 La Trobe equipment list / road users show only in the micro scene (Configure · works-info tab)", "${microOn()&&t==='site'?`<div class=\"stack\"><div class=\"row between\"><span class=\"eyebrow\">${L('Junction micro-model" in APP)
check("4 the before/after slider label no longer says \"After AI fix · v2\"", "AI 修复后" not in BODY and 'data-zh="修改后">AFTER' in BODY)

# ---- Follow-up 5: show the assumptions ----
why = fn(ENG, "engWhy")
check("5 under the engine numbers: \"works-link flow X veh/h vs capacity after closure Y veh/h\" (v and cap of the works link in raw.links)", "l.v" in why and "l.cap" in why and "EP.link" in why and "const over=l.v>l.cap" in why)
check("5 states the assumptions detours rely on (route-choice model + parameters + share who understand the sign)", "路线选择模型" in why and "engInformed(s)" in why)
check("5 step 4 has an assumptions note beside the before/after detour comparison", "绕行 ${pctS(B.detour_share)} → ${pctS(da)} 的前提" in ENG)
check("5 the assumptions note does not use .muted (visible in the compact view too)", '<div class="eng-assume">' in why and ".eng-assume{" in CSS)

print(f"{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
