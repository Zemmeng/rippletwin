"""Junction micro-simulation wired into step 2 (GridSim in 4b-grid.js). Static source assertions only; no browser.

Usage: python3 apps/web/tests/test_grid_wire.py (needs git, no network)
The last line is always "N passed, M failed"; any failure exits with code 1.
"""
import pathlib
import re
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
REPO = ROOT.parent.parent
SRC = ROOT / "src"
JS = {p.name: p.read_text(encoding="utf-8") for p in sorted((SRC / "js").glob("*.js"))}
APP, ENG = JS["5-app.js"], JS["6-engine.js"]
ALL = "\n".join(JS.values())

passed = failed = 0


def check(name, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print(f"✅ {name}")
    else:
        failed += 1
        print(f"❌ {name}" + (f" — {detail}" if detail else ""))


def fn_body(src, name):
    m = re.search(r"^function " + re.escape(name) + r"\(.*$", src, re.M)
    return m.group(0) if m else ""


# 1. helpers exist, each defined exactly once across all js files (one classic script: names must be unique)
for name in ["gridOn", "newGrid", "gridShown", "gridFly", "gridRebuild", "gridNote", "drawJunctions"]:
    n = len(re.findall(r"^function " + name + r"\(", ALL, re.M))
    check(f"{name}() is defined exactly once across all files", n == 1, f"found {n}")

# 2. gridOn guards a missing 4b-grid.js and only fires on step 2 inside GRID_BOX
on = fn_body(APP, "gridOn")
check("gridOn() checks typeof GridSim==='function' first", "typeof GridSim==='function'" in on)
check("gridOn() only on step 2, with the whole works segment inside GRID_BOX", "S.step===2" in on and "GRID_BOX.x0" in on and "EP.pts.every" in on)

# 3. newGrid falls back to null on any throw
ng = fn_body(APP, "newGrid")
check("newGrid() has try/catch and returns null on error", "try{" in ng and "catch(" in ng and "return null" in ng)

# 4. every newGrid() call sits behind gridOn()
calls = [m.start() for m in re.finditer(r"(?<!function )newGrid\(\)", APP + ENG)]
bad = [i for i in calls if not (APP + ENG)[max(0, i - 10):i].endswith("gridOn()&&")]
check("every newGrid() call is preceded by gridOn()&&", len(calls) >= 2 and not bad, f"{len(bad)} unguarded")
g2 = re.search(r"if\(n===2\)\{(.*?)\n\s*else\{(.*?)\}\}", APP, re.S)
check("goStep(2): the grid is used only if gridOn()&&newGrid() succeeds; otherwise the original newStress('before') stays as it was",
      bool(g2) and "gridOn()&&newGrid()" in g2.group(1) and "S.stress=newStress('before');S.sim=S.stress" in g2.group(2) and "flyTo(-8,-4,4.2)" in g2.group(2))
check("goStep(2) grid branch clears S.stress (step 3 rebuilds the La Trobe scene itself and does not touch GridSim.script)",
      bool(g2) and "S.stress=null" in g2.group(1))

# 5. La Trobe-only drawing skips the grid sim
check("drawRisk / fogRings return immediately on isGrid",
      "if(!sim||sim.isGrid)return;" in APP and "if(!sim||sim.isGrid||S.wx!=='fog'" in APP)
check("render on the step 2 grid skips the La Trobe works and draws the grid's works and signals (also when zoomed out)",
      "if(micro&&!grid)drawWorks('before')" in APP and "if(grid)drawJunctions(S.sim,wait)" in APP)
check("step 2 grid draws cars at zoom < 1 too (walkers includes gridShown()); the La Trobe scene still draws only when fine",
      "walkers=micro&&(fine||gridShown())" in APP)
check("grid sim draws the whole 4×4 (sim.all); stats still use sim.agents (the 2×2 at the works)",
      "const list=sim.isGrid&&sim.all?sim.all:sim.agents" in APP and "for(const a of list)" in APP)
check("works segment stands out (glow + tag); the tag names the street and how many lanes are closed",
      "drawTag(ctx,px,py,0,-34" in fn_body(APP, "drawJunctions") or "drawTag(ctx,px,py,0,-34" in APP)
check("clock / timeline follow the plan's time window (step 2 grid uses EP.hour, everything else 17:00); \"17:\" is no longer hard-coded",
      "function clockHour(){return gridShown()?" in APP and "`17:${" not in APP)

# 6. plan change in step 2 rebuilds the grid
run = ENG[ENG.find("async function engRun("):]
run = run[:run.find("\n}\n")]
check("engRun calls gridRebuild() on step 2 when it finishes", "if(S.step===2)gridRebuild();" in run)

# 7. panel line + things other tests rely on
check("step 2 panel states that signal timing and turn shares are assumed", "signal timing and turn shares are assumed" in APP and "信号配时和转弯比例是假设值" in APP)
check("clashMount();aiMount(); still present", "clashMount();aiMount();" in APP)

# 8. 4-sim.js untouched vs origin/main
r = subprocess.run(["git", "-C", str(REPO), "diff", "--quiet", "origin/main", "--", "apps/web/src/js/4-sim.js"])
check("4-sim.js matches origin/main", r.returncode == 0, f"git diff exit code {r.returncode}")

print(f"{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
