"""SUMO primary (every on-screen traffic number comes from SUMO; the engine stays behind the scenes): on the Lonsdale one-lane-closure plan, 03 / 04 advisor / 05 export / 01 check / the map
show no engine traffic numbers (queue metres, seconds per vehicle, vehicle-minutes, rider-minutes, network delay, per-persona minutes, tram/bus / pedestrian minutes, clash costs);
only SUMO's numbers and the AI sign reading (notice / understand / trust, detour share = SUMO's input). Static wiring + tests/sumo3_glue.mjs (rendered in node).

Usage: python3 apps/web/tests/test_sumo_primary.py (needs node ≥ 18, no network)
The last line is always "N passed, M failed"; any failure exits with code 1.
"""
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import build  # noqa: E402

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
SRC = ROOT / "src"
JS = {p.name: p.read_text(encoding="utf-8") for p in sorted((SRC / "js").glob("*.js"))}
ENG, S3, AI = JS["6-engine.js"], JS.get("6e-sumo3.js", ""), JS["9-ai.js"]
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


def first_stmt(src, name):
    return fn(src, name).strip().split("\n")[0]


# 1 New file: sorts after 6-engine.js and before 7-glass.js (build.py concatenates by file name); same test as sumoWant / suPlan
order = sorted(JS)
check("6e-sumo3.js exists and is concatenated after 6-engine.js, before 7-glass.js", "6e-sumo3.js" in JS and order.index("6-engine.js") < order.index("6e-sumo3.js") < order.index("7-glass.js"))
check("sumoPlanOn = the Lonsdale link with 1 lane closed (same test as sumoWant / sumoImpactHTML)",
      "function sumoPlanOn(){return typeof SUMO_LINK==='string'&&!!EP.link&&EP.link===SUMO_LINK&&!EP.all&&EP.lanes===1;}" in S3)

# 2 Hooks in 6-engine.js: one line each; SUMO plans go to 6e-sumo3.js first
check("03: the first statement of engPanel3 branches to SUMO (all three tabs: traffic / evidence / nearby works); the engTabs3 tab row stays",
      first_stmt(ENG, "engPanel3").startswith("if(typeof sumoPanel3==='function'&&sumoPlanOn())return sumo3Top()+(EP.view3==='evidence'?sumo3Evidence():EP.view3==='clash'?sumo3Clash():sumoPanel3())+navHTML();")
      and "${engTabs3()}" in fn(S3, "sumo3Top"))
check("04 advisor: eng4HTML branches to sumo3Eng4 after the invalid-text check", "if(typeof sumo3Eng4==='function'&&sumoPlanOn())return sumo3Eng4();" in fn(ENG, "eng4HTML")
      and fn(ENG, "eng4HTML").index("if(EP.badText)") < fn(ENG, "eng4HTML").index("sumo3Eng4()"))
check("05 export: the first statement of engPlaybook branches to sumo3Playbook", first_stmt(ENG, "engPlaybook").startswith("if(typeof sumo3Playbook==='function'&&sumoPlanOn())return sumo3Playbook();"))
check("01 check: the first statement of engMoreHTML branches to sumo3More", first_stmt(ENG, "engMoreHTML").startswith("if(typeof sumo3More==='function'&&sumoPlanOn())return sumo3More();"))
check("map: engSumFor returns null on SUMO plans → engDraw / engLabels / engFit draw none of the engine's queue, ripple, detours, trams/pedestrians or their labels (on every step)",
      "if(EP.badText||EP.runErr||(typeof sumoPlanOn==='function'&&sumoPlanOn()))return null;return which==='before'" in fn(ENG, "engSumFor")
      and "const s=engSumFor(which)" in fn(ENG, "engDraw") and "const s=engSumFor('now')" in fn(ENG, "engLabels") and "const s=engSumFor('now')" in fn(ENG, "engFit"))
check("negative: engDraw's engine queue / ripple / detours and trams/pedestrians all hang off s (nothing drawn when s is null); the works segment and equipment squares do not",
      "if(s&&S.step!==2){\n    const faint" in fn(ENG, "engDraw") and "if(s&&S.step!==2){engTransitDraw(s,S.step===1);engPedDraw(s,S.step===1);}" in fn(ENG, "engDraw")
      and "ctx.strokeStyle=TK.works;ctx.lineWidth=9*k;engLine(EP.pts,off);" in fn(ENG, "engDraw") and "if(S.step<=2){\n    const vm=[]" in fn(ENG, "engDraw"))
check("negative: engLabels' \"QUEUE 918 m · drawn to Spring St\" and \"+N veh·min\" labels both hang off s", "if(s&&s.queue_m>0){const q=engUp" in fn(ENG, "engLabels") and "if(S.step===3&&s){" in fn(ENG, "engLabels"))
check("map: SUMO's on-the-hour queue is drawn under the works segment, labelled \"SUMO queue at 09:00 · X m\" and included in framing (only on 03 network · traffic)",
      "if(!s&&typeof sumo3QueueDraw==='function')sumo3QueueDraw(which,k,off);" in fn(ENG, "engDraw")
      and fn(ENG, "engDraw").index("sumo3QueueDraw(") < fn(ENG, "engDraw").index("ctx.strokeStyle=TK.works;ctx.lineWidth=9*k")
      and "if(!s&&typeof sumo3QueueTag==='function')sumo3QueueTag(vis);" in fn(ENG, "engLabels") and fn(ENG, "engLabels").rstrip().endswith("tagFlush();")
      and "if(typeof sumo3Fit==='function')sumo3Fit().forEach(add);" in fn(ENG, "engFit")
      and "S.step!==3||EP.tab3!=='net'||EP.view3!=='traffic'" in fn(S3, "sumo3QueueM") and "c.m.works_queue_end_m" in fn(S3, "sumo3QueueM")
      and "SUMO queue at ${c.end} · " in fn(S3, "sumo3QueueTag") and "engSub(Math.min(m,engReach()))" in fn(S3, "sumo3QueueDraw"))
check("AI road-users panel: on SUMO plans says \"the share who detour is SUMO's input · SUMO computes the traffic numbers\"; other plans still say \"the engine computes every number\"",
      "typeof sumoPlanOn==='function'&&sumoPlanOn()?'the share who detour is SUMO’s input · SUMO computes the traffic numbers':'the engine computes every number'" in AI
      and "绕行比例是 SUMO 的输入 · 交通数字由 SUMO 算':'数字都由引擎算'" in AI)

# 3 6e-sumo3.js does not touch the engine's result fields itself (it reads only SU, detour_share / sign reading in EP.sum, and detour_share in EP.cmp)
code = re.sub(r"//[^\n]*|/\*[\s\S]*?\*/", "", S3)
bad = re.findall(r"\.queue_m\b|\bmean_delay_s\b|\bdelay_min\b|\bextra_min\b|\bpax_min\b|\bper_capita_min\b|\.hot\b|\bdelta_min\b|\bcost\b|\.why\b|\bped_h\b|\bdetour_m\b|\.transit\b|\.peds\b|engMetrics|engWhy|engImpacts|engHeadline|engQueueTxt", code)
check("negative: 6e-sumo3.js reads none of the engine's queue / delay / vehicle-minute / rider-minute / clash / advisor-rationale fields", not bad, str(sorted(set(bad))))
check("negative: 6e-sumo3.js does not write innerHTML (it only returns strings, which 6-engine.js writes into the page where it always did)", "innerHTML" not in code)
check("03 traffic: SUMO not run yet → card + goStep(2) button (delegated click, no per-render binding)",
      "Run SUMO in step 2 first" in fn(S3, "sumoPanel3") and 'data-sumo3-go="2"' in fn(S3, "sumoPanel3") and "closest('[data-sumo3-go]')" in S3 and "goStep(2)" in S3)
check("03 traffic: vehicles held up — works_held_end if present, else the sum of works_queue_equiv_end_vehicles, else round(equiv_end_m × 2 / 7), documented in a comment",
      "works_held_end" in fn(S3, "sumo3Held") and "works_queue_equiv_end_vehicles" in fn(S3, "sumo3Held") and "*2/7" in fn(S3, "sumo3Held") and "N = round(m × 2 / 7)" in S3)
check("03 traffic: four tiles = works throughput veh/h, extra time per vehicle through the works, detouring vehicles, longest queue; trams / buses / pedestrians get one \"not covered by SUMO\" line",
      all(x in fn(S3, "sumoPanel3") for x in ["works_throughput_vph", "s3ex(m)", "m.detour_vehicles", "m.works_queue_max_m", "sumo3NotCovered()"]) and "not covered by SUMO" in S3 and "SUMO 暂不覆盖" in S3)
check("source: live = seconds + seed; pre-computed = seed + reason (sumoReason)", "Cloud SUMO · computed live" in fn(S3, "sumo3Pill") and "SUMO · pre-computed" in fn(S3, "sumo3Pill") and "sumoReason(src.reason)" in fn(S3, "sumo3Pill"))
check("injection: SUMO scenario names, reasons and assumption text all go through esc()", "esc(sumo3Name(idx,id))" in S3 and "esc(why)" in fn(S3, "sumo3Pill") and "esc(t)" in fn(S3, "sumo3Evidence"))
check("negative: the SUMO version of the 04 advisor has no data-optwhy (the advisor rationale contains engine minutes / vehicle-minutes); data-opt / #applyBtn still bound by engRender4",
      "data-optwhy" not in code and 'data-opt="${i}"' in fn(S3, "sumo3Eng4") and 'id="applyBtn"' in fn(S3, "sumo3Eng4") and "computed by SUMO" in fn(S3, "sumo3Eng4"))

# 4 The bundled page script parses (a // comment inside a one-line function comments out the rest, which no other test catches)
check("public/index.html is the latest bundle (python3 apps/web/build.py)", (ROOT / "public" / "index.html").read_text(encoding="utf-8") == PAGE)
node = shutil.which("node")
if not node:
    check("node found", False, "node is not on PATH")
else:
    m = re.search(r"<script>\n([\s\S]*?)</script>\n</body>", PAGE)
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as f:
        f.write(m.group(1) if m else "")
        tmp = f.name
    r = subprocess.run([node, "--check", tmp], capture_output=True, text=True, timeout=60)
    pathlib.Path(tmp).unlink(missing_ok=True)
    check("the whole-page <script> passes node --check (syntax)", bool(m) and r.returncode == 0, (r.stderr or "")[-300:])
    r = subprocess.run([node, str(HERE / "sumo3_glue.mjs")], capture_output=True, text=True, timeout=120)
    out = r.stdout + r.stderr
    for line in out.splitlines():
        if line.startswith("✅") or line.startswith("❌"):
            check("node · " + line[2:], line.startswith("✅"))
    if r.returncode != 0 and "❌" not in out:
        check(f"sumo3_glue.mjs exit code {r.returncode}", False, out[-400:])

print(f"{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
