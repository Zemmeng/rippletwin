"""Step 2 wired to the real-network SUMO replay (SumoReplay in 4c-sumo.js + the wiring in 5-app.js).

tests/sumo_glue.mjs runs SumoReplay in node on a v2 replay built in memory (a few westbound vehicles on Lonsdale + a bus + two signal heads + two chunks);
if apps/sumo/public/real/ exists it is checked too. This file adds static source assertions: only through the same-origin sumo-client.js, failures stay on GridSim, a pre-computed run is never labelled live.
Usage: python3 apps/web/tests/test_sumo_wire.py (needs node ≥ 18, no network)
The last line is always "N passed, M failed"; any failure exits with code 1.
"""
import pathlib
import re
import shutil
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
JS = {p.name: p.read_text(encoding="utf-8") for p in sorted((ROOT / "src" / "js").glob("*.js"))}
APP, SU = JS["5-app.js"], JS.get("4c-sumo.js", "")
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
    m = re.search(r"^(?:async )?function " + re.escape(name) + r"\(.*?(?=^(?:async )?function |^const |^/\*|\Z)", src, re.M | re.S)
    return m.group(0) if m else ""


# 1. 4c-sumo.js: pure logic, names prefixed with sumo, sorted after 4b-grid.js (uses GRID_K) and before 5-app.js
check("4c-sumo.js has /* sumo:begin */ … /* sumo:end */", "/* sumo:begin */" in SU and "/* sumo:end */" in SU)
names = re.findall(r"^(?:const|let|class|function) ([A-Za-z_$][\w$]*)", SU, re.M)
check("every top-level name in 4c-sumo.js has a sumo / Sumo / SUMO prefix", names and all(n.lower().startswith("sumo") for n in names), str(names))
check("negative: 4c-sumo.js does not touch the DOM or fetch data itself", not re.search(r"\b(document|window|canvas|fetch|import)\b", SU))
order = list(JS)
check("bundle order 4b-grid.js → 4c-sumo.js → 5-app.js", order.index("4b-grid.js") < order.index("4c-sumo.js") < order.index("5-app.js"))
check("SumoReplay has the same shape as GridSim (isGrid, all / agents, signalHeads, works, stats, minute, resetStats, setWeather)",
      all(k in SU for k in ["this.isGrid=true", "this.isSumo=true", "this.agents=all", "signalHeads(){", "works(){", "resetStats(){", "setWeather(){", "this.minute=new Float32Array(60)", "this.critical=null"]))

# 2. Wiring: only through the same-origin sumo-client.js; swaps in only when gridOn() and on the Lonsdale demo link; failures stay on GridSim
check("the page connects to SUMO only via the literal import('/sumo/public/js/sumo-client.js')", APP.count("import('/sumo/public/js/sumo-client.js')") == 1)
want = fn(APP, "sumoWant")
check("sumoWant(): gridOn() && EP.link===SUMO_LINK, 1 lane closed", "gridOn()" in want and "EP.link===SUMO_LINK" in want and "EP.lanes===1" in want and "typeof SumoReplay==='function'" in want)
g2 = re.search(r"if\(n===2\)\{(.*?)\n", APP)
check("goStep(2): starts GridSim first (cars right away), then sumoStart()", bool(g2) and g2.group(1).index("gridOn()&&newGrid()") < g2.group(1).index("sumoStart()"))
start = fn(APP, "sumoStart")
check("sumoStart(): if the client fails to load, one console.info line only and SU.failed falls back to GridSim", "console.info('SUMO client unavailable, keeping the browser grid sim:'" in start and "SU.failed=true" in start)
check("sumoStart() does not play the pre-computed run first: if the same seed + plan was computed live within 10 minutes it plays that, otherwise sumoRerun() (spinner)", "if(!sumoStale())" in start and "return sumoRerun();" in start and "loadReal" not in start)
play = fn(APP, "sumoPlay")
check("sumoPlay(): swaps S.sim only once the chunk the replay needs (R.want()) has arrived, re-checking first that we are still on step 2 / still want SUMO / not superseded by a newer request",
      "const k=R.want();if(k<0)break;R.addChunk(k,await c.realChunk(ref,scen,ch[k]));if(tok!==SU.tok)return;}" in play and "for(let n=0;!R.ready&&n<=ch.length;n++)" in play
      and "if(!gridShown()||!sumoWant())return;" in play and play.index("R.addChunk(k,") < play.index("S.sim=R"))
check("switching plans (chips) stays at the same moment: R.seek(keepT) first, so want() asks for the chunk containing that moment, and the swap happens once it arrives",
      "const keepT=S.sim&&S.sim.isSumo?S.sim.t:0;if(keepT)R.seek(keepT);" in play and play.index("R.seek(keepT)") < play.index("R.want()"))
check("a manifest with no chunks (baseline has metrics only) is never played: it throws before the replay is built and the page keeps its current view",
      "if(!Array.isArray(ch)||!ch.length)throw new Error('manifest has no chunks');" in play and play.index("throw new Error('manifest has no chunks')") < play.index("new SumoReplay("))
feed = fn(APP, "sumoFeed")
check("after the swap, sumoFeed loads the rest of the hour in the background following R.want() (not awaited; sumoPlay returns after the swap); stops when the replay leaves the screen / is superseded",
      "sumoFeed(R,tok,ref,scen,ch).catch(" in play and "await sumoFeed" not in play and "while(tok===SU.tok&&S.sim===R)" in feed
      and "const k=R.want();" in feed and "R.addChunk(k,d)" in feed and "if(R.complete&&!R.nDropped)return;" in feed)
check("3 consecutive load failures on the first pass → R.truncate() plays up to what has arrived; a dropped chunk that is needed again keeps waiting (retry with back-off)",
      "if(miss>=3&&!R.cF[k]){R.truncate();" in feed and "await sumoNap(Math.min(5000,500*miss))" in feed)
check("sumoPlay(): works polygons and junctions come from the running GridSim (same link)", "polys:base.works().polys" in play and "spec:base.spec" in play)
check("gridRebuild(): no rebuild while a SUMO replay is playing and still wanted; tries SUMO again after a new grid", "if(S.sim&&S.sim.isSumo&&sumoWant())return;" in APP and re.search(r"renderPanel\(\);sumoStart\(\);\}", APP))

# 3. Source label: only a run the client reports as live is labelled live; a pre-computed run says "pre-computed" + the reason
pill = fn(APP, "sumoPill")
check("the source label reads the on-screen replay's own src; live needs source==='live' and an elapsed time", "S.sim.src" in pill and "s.source==='live'&&isFinite(s.elapsedMs)" in pill)
check("the pre-computed label says SUMO · pre-computed (EN and ZH), with the reason", "SUMO · pre-computed" in pill and "SUMO · 预先跑好" in pill and "sumoReason(s.reason)" in pill)
rr = fn(APP, "sumoRerun")
check("run: runReal({seed (set in the panel), p_original:.14, p_ai}); recorded as live only when source==='live' and there is a runId",
      "const tok=++SU.tok,seed=SU.seed" in rr and "runReal({seed,p_original:.14,p_ai:sumoPAi()}" in rr and "r.source==='live'&&r.runId" in rr)
check("falls back to the pre-computed run only if the cloud run failed (sumoBaked with a reason); with no pre-computed run either, SU.failed falls back to GridSim", "await sumoBaked(r&&r.reason)" in rr and "await sumoBaked('not_found')" in rr and "SU.failed=true" in rr)
check("p_ai: the detour share from the engine advisor comparison, 0.53 if there is none", "return isFinite(p)&&p>=0&&p<=1?" in APP and ":.53;}" in APP)
check("step 2 panel in SUMO mode: notes, two plan buttons, a re-run button, four metrics",
      "real CBD network (OSM) + SCATS" in APP and "Original plan · ROADWORK AHEAD" in APP and "AI plan · USE RUSSELL" in APP
      and "▶ Run SUMO (~1 min)" in APP and all(k in APP for k in ["Vehicles on map", "Works queue now", "Extra time per vehicle", "Detoured vehicles"]))
check("Chinese versions present too", all(k in APP for k in ["真实 CBD 路网（OSM）", "原方案 · ROADWORK AHEAD", "AI 方案 · USE RUSSELL", "运行 SUMO（约 1 分钟）", "地图上的车"]))
wait_h, draw_w = fn(APP, "sumoWaitHTML"), fn(APP, "drawSumoWait")
check("while waiting for the cloud (panel + map centre) it says \"SUMO simulating 08:00–09:00 in the cloud · X s (about 1 min)\"; the window comes from index.params.hour_window (else index.hour)",
      "SUMO simulating ${w0} in the cloud" in wait_h and "(about 1 min)" in wait_h and "SUMO 正在云端模拟 ${w0}" in wait_h and "（约 1 分钟）" in wait_h
      and "SUMO simulating ${w0} in the cloud · ${el} s (about 1 min)" in draw_w and "SUMO 正在云端模拟 ${w0} · ${el} s（约 1 分钟）" in draw_w
      and "I.params.hour_window" in fn(APP, "sumoWin") and "SUMO is computing this run" not in APP and "~15 s" not in APP and "约 15 s" not in APP)
check("the page waits 180 s on runReal (a full hour takes about 40–60 s in the cloud), no longer 90 s", "{timeoutMs:180000}" in fn(APP, "sumoRerun") and "timeoutMs:90000" not in APP)
check("outside SUMO mode, the original four GridSim metrics of step 2 are still there", "${su?sumoTiles():wait?'':`" in APP and "L('Road users','道路使用者')" in APP and "TTC &lt; 1.5 s" in APP)
# Decided by the team lead: the SUMO replay also marks harsh braking and the timeline draws 100% stacked bars; conflicts / critical cannot be computed, so they show —, never 0
tiles, lg, hs, dh = fn(APP, "sumoTiles"), fn(APP, "sumoEvLegend"), fn(APP, "histShare"), fn(APP, "drawHist")
check("SUMO-mode metrics get two extra tiles: harsh braking (data-live=\"harsh\", threshold from GRID_P.harsh) and conflicts · critical showing — with \"SUMO: not computed\" (EN and ZH)",
      'data-live="harsh"' in tiles and "-GRID_P.harsh/GRID_K" in tiles and "SUMO: not computed" in tiles and "SUMO 不算冲突" in tiles
      and "L('Conflicts · critical','冲突 · 严重')" in tiles)
check("negative: the SUMO metrics have no live conf / crit tiles (so they are never written as 0); the page writes null stats as —",
      'data-live="conf"' not in tiles and 'data-live="crit"' not in tiles
      and "set('conf',sim.stats.conflicts==null?'—':sim.stats.conflicts);set('crit',sim.stats.critical==null?'—':sim.stats.critical);" in APP
      and "conflicts:null,critical:null" in SU)
check("the SUMO-mode panel has a legend (harsh-braking diamond; conflicts / critical —, SUMO does not compute conflicts; timeline uses the replay's bar width)",
      "${su?sumoEvLegend():''}" in APP and 'class="eng-legend ev-legend"' in lg and "SUMO: not computed" in lg and "SUMO 不算冲突" in lg
      and "per ${n} min" in lg and "每 ${n} 分钟" in lg)
check("timeline histShare bins by sim.bins {m0, n} (the 4×4 without bins still uses 10 minutes), each bar placed at its minutes on the clock; the SUMO replay no longer takes the per-minute harsh-braking path",
      "const B=sim.bins||{m0:0,n:10}" in hs and "x=m0*mw+(W-bw)/2" in hs and "this.bins=this.dur>=1800?{m0:0,n:10}:{m0:Math.floor(this.clock0/60),n:2};" in SU
      and "this.mSeen=new Float32Array(60);this.mHit=new Float32Array(60);" in SU and "sumo?Math.max(2,top1*.67)" not in dh and "per_minute" not in SU)
add, stp, sk = re.search(r"addChunk\(k,data\)\{.*?\n  \}", SU, re.S), re.search(r"\n  step\(dt\)\{.*?\n  \}", SU, re.S), re.search(r"\n  seek\(t\)\{[^\n]*", SU)
check("harsh braking is scanned once per newly arrived sample in addChunk (_harsh); step() / seek() do not scan, they only move the pointer (_stats)",
      bool(add and stp and sk) and "this._harsh(this.nLoaded);this._stats();" in add.group(0) and "_harsh" not in stp.group(0) and "_harsh" not in sk.group(0)
      and "this._stats();" in stp.group(0) and "gridIn(V,px,py)" in SU and "a<P.harsh" in SU)
check("the clock follows the replay (clock0_s + t), clicking the timeline jumps there, the time window uses the replay's hour",
      "if(S.sim&&S.sim.isSumo){S.clock=S.sim.clock();" in APP and "S.sim.seek(S.clock-S.sim.clock0)" in APP and "S.sim.isSumo?S.sim.hour:" in APP)
check("after the full hour it stops at 09:00 (S.playing=false, same as the 4×4); pressing play again restarts from 08:00; jumping to a part not yet loaded shows \"loading this part\" in the status bar",
      "if(S.sim.atEnd)S.playing=false;}" in APP and "if(S.playing&&S.sim&&S.sim.isSumo&&S.sim.atEnd)S.sim.seek(0);" in APP
      and "sim.waiting?L('SUMO · loading this part of the hour…','SUMO · 正在载入这一段…')" in APP)

# 4. node: SumoReplay behaviour (in-memory replay + the pre-computed directory if present)
node = shutil.which("node")
if not node:
    check("node found (needed by sumo_glue.mjs)", False)
else:
    try:
        r = subprocess.run([node, str(HERE / "sumo_glue.mjs")], capture_output=True, text=True, encoding="utf-8", timeout=150)
        out, code = r.stdout + r.stderr, r.returncode
    except subprocess.TimeoutExpired:
        out, code = "❌ sumo_glue.mjs did not finish within 150 s\n", 1
    n0 = passed + failed
    for line in out.splitlines():
        if line.startswith("✅"):
            passed += 1
            print(line)
        elif line.startswith("❌"):
            failed += 1
            print(line)
        elif line.startswith("   "):
            print(line)
    if code != 0 and passed + failed == n0:
        check(f"sumo_glue.mjs exit code {code}", False, out[-400:])

check("no re-run if the same seed + same AI detour share was computed within 10 minutes; liveKey / liveAt are recorded only after a successful live run",
      "const sumoKey=()=>`${SU.seed}|${sumoPAi()}`;" in APP and "SU.liveKey===sumoKey()&&performance.now()-SU.liveAt<600000" in APP and "SU.liveKey=sumoKey();SU.liveAt=performance.now();" in fn(APP, "sumoRerun"))
check("while waiting, the browser GridSim's cars and signals are not drawn; spinner in the map centre, spinner + seed in the panel",
      "if(walkers&&!wait){drawAgents(S.sim);drawEvents(S.sim);}if(grid)drawJunctions(S.sim,wait);if(wait)drawSumoWait();" in APP
      and "if(!noHeads)for(const h of sim.signalHeads())" in APP and "function sumoWaiting(){return gridShown()&&!!S.sim&&!S.sim.isSumo&&sumoWant()&&!SU.failed;}" in APP
      and "${su?sumoNote()+sumoCtl():wait?sumoWaitHTML():" in APP and 'class="spin"' in APP)
check("seed input (0–2147483647), random button, run button; the label shows the seed", 'id="sumoSeed"' in APP and 'id="sumoDice"' in APP and 'max="2147483647"' in APP and "seed ${s.seed}" in APP)
check("the copy does not call it a \"replay\", and no longer plays the pre-computed run first", "SUMO 回放" not in APP and "SUMO replay ·" not in APP and "先显示预先跑好的" not in APP and "Cloud SUMO · computed live" in APP)
ENG = (ROOT / "src" / "js" / "6-engine.js").read_text(encoding="utf-8")
imp = fn(APP, "sumoImpactHTML")
check("step 3 puts this step 2 SUMO run's result (source + seed) above the engine numbers; the engine numbers are labelled \"Engine estimate · whole CBD · queue at 09:00\"",
      "${typeof sumoImpactHTML==='function'?sumoImpactHTML(s):''}" in ENG and "Engine estimate · whole CBD · queue at ${engEndH(s)}" in ENG and "引擎估算 · 整个 CBD · ${engEndH(s)} 时的排队" in ENG
      and "whole CBD, 1 hour" not in ENG
      and "SU.index" in imp and "src.source==='live'&&isFinite(src.elapsedMs)" in imp and "seed ${sd}" in imp)
check("the SUMO table has two rows, original plan / AI plan: max / mean queue, extra time per vehicle through the works, detouring vehicles; if SUMO has not run, it points to step 2", "row('original'" in imp and "row('ai'" in imp
      and "works_queue_max_m" in imp and "works_traffic_extra_s" in imp and "detour_vehicles" in imp and "Run SUMO in step 2" in imp)
check("explains why the two models differ so much, and does not call it proof", "not measured proof" in imp and "不是实测证据" in imp)
check("the full-hour SUMO table has 09:00 columns: queue by the engine method (works_queue_equiv_end_m), physical queue on Lonsdale (works_queue_end_m), max, extra time per vehicle, detours; the column times come from hour_window",
      "hour=!!(mo&&n(mo.works_queue_equiv_end_m))" in imp
      and all(k in imp for k in ["x.works_queue_equiv_end_m", "x.works_queue_end_m", "x.works_queue_max_m", "${end} queue (engine method)", "${end} 排队（引擎算法）",
                                 "Physical queue on Lonsdale at ${end}", "${end} Lonsdale 上实际排队", "L('Max (physical)','最长（实际）')", "end=w0.split('–')[1]"]))
qc = fn(APP, "sumoQChart")
check("below the comparison sentence, the queue curve for the hour: SUMO engine method / physical on Lonsdale (queue_series) + the engine's point-queue line rising to its number; colours from theme variables, nothing drawn without a series",
      "cmpP=`<div class=\"sumo-cmp\"><p class=\"small\">${cmp}</p>${sumoQChart(mo.queue_series,eg,w0)}</div>`" in imp and "if(!Array.isArray(qs)||qs.length<2)return'';" in qc
      and 'class="equiv"' in qc and 'class="phys"' in qc and 'class="eng"' in qc and 'y2="${Y(eg)}"' in qc and "#" not in re.sub(r"\$\{[^}]*\}", "", qc.split("return`<svg", 1)[1]))
check("the comparison sentence sits outside the collapsible SUMO block (visible in compact mode even with the table folded)", "if(cmp)cmpP=`<div class=\"sumo-cmp\">" in imp and "${note}</div>${cmpP}`;" in imp)
check("old replays (no new fields, 12 minutes) still show the earlier columns and notes", "`<td>${r(x.works_queue_max_m)} / ${r(x.works_queue_mean_m)} m</td>`" in imp and "Why the engine says more" in imp and "为什么引擎的数大" in imp)
check("one sentence compares SUMO's 09:00 engine-method queue with the engine's number, all from data (s.queue_m, ratio, detour share, capacity, actual throughput, 2935 green, network extent), no hard-coded numbers",
      "eg=s&&n(s.queue_m)?+s.queue_m:null" in imp and "Math.round(eq/eg*100)" in imp and "SUMO's original plan holds" in imp and "SUMO 原方案按引擎算法" in imp
      and "mo.works_capacity_assumption_vph" in imp and "mo.works_throughput_vph" in imp and "P.green_2935" in imp and "P.network_extent" in imp
      and not re.search(r"\b(918|810|1144|513|544)\b", imp))
qt = fn(ENG, "engQueueTxt")
check("the engine's queue label on the map (steps 1 / 3) says it is at 09:00: \"queue 918 m · at 09:00 · drawn to Spring St\"; the time = the engine's hour + 1",
      "(at?L(` · ${engEndH(s)}`,` · ${engEndH(s)} 时`):'')" in qt and "engQueueTxt(s,vis,true),TK.risk);}" in ENG
      and "const engEndH=s=>engHour((clamp(Math.floor(+(s&&s.when?s.when.hour:EP.hour)||0),0,23)+1)%24);" in ENG)
check("set the seed before running: step 1 has a seed box and random button above \"Save & simulate\", and step 2 runs with SU.seed",
      "${typeof sumoPreHTML==='function'?sumoPreHTML():''}${navHTML()}" in APP and "engBind1();vlMount();sumoPreBind();" in APP
      and 'id="sumoSeedPre"' in APP and 'id="sumoDicePre"' in APP and "const tok=++SU.tok,seed=SU.seed" in APP)
# A successful live run in step 2 → prefetch the multi-plan SUMO for 04 in the background; at most one cloud job at a time per page (sumoLane). Behaviour tests are in section 6 of tests/compare_glue.mjs
CMP = JS["8-compare.js"]
lane = re.search(r"let sumoTail=Promise\.resolve\(\);\nfunction sumoLane\(fn\)\{(.*?)\}\n", APP, re.S)
check("sumoLane(fn) serialises cloud jobs: the next starts only after the previous one ends (success or failure)",
      bool(lane) and "const run=sumoTail.then(()=>fn());sumoTail=run.then(()=>{},()=>{});return run;" in lane.group(1))
check("step 2's runReal goes through sumoLane; only the source==='live' with runId branch calls cmpPrefetch(seed) (no prefetch on the pre-computed fallback), not awaited",
      "r=await sumoLane(()=>SU.cli.runReal({seed,p_original:.14,p_ai:sumoPAi()},{timeoutMs:180000}))" in rr
      and rr.index("r.source==='live'&&r.runId") < rr.index("cmpPrefetch(seed)") < rr.index("else if(r&&r.index)")
      and "await cmpPrefetch" not in rr and "if(typeof cmpPrefetch==='function')cmpPrefetch(seed);" in rr)
check("04's runOptions also goes through sumoLane; 04 and the prefetch share cmpOptions (be.options computed once) and the CSU cache (key = seed + each plan's id:p)",
      "job.wait=true;const run=sumoLane(go);ping();return{r:await run};" in fn(CMP, "cmpSuJob") and "rows=cmpFromOptions(await cmpOptions(plan))" in fn(CMP, "cmpUpdate")
      and "cmpFromOptions(await cmpOptions(plan))" in fn(CMP, "cmpPrefetch") and "const job=st.job=cmpSuJob(ask,seed);" in fn(CMP, "cmpSuUpdate")
      and "if(job.out)return fin(job.out);" in fn(CMP, "cmpSuUpdate") and "BE.api.options(plan,{n:CMP_MAX})" in fn(CMP, "cmpOptions"))
print(f"{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
