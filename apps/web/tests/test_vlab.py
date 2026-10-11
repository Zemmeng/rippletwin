"""VMS test bench: static assertions (mounting, paired EN/ZH copy, no hard-coded numbers), plus node tests/vlab_glue.mjs run on the real network.

Usage: python3 apps/web/tests/test_vlab.py (needs node ≥ 18, no network)
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
SRC = HERE.parent / "src"
LAB = (SRC / "js" / "6d-vmslab.js").read_text(encoding="utf-8")
APP = (SRC / "js" / "5-app.js").read_text(encoding="utf-8")
ENG = (SRC / "js" / "6-engine.js").read_text(encoding="utf-8")
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
        print(f"❌ {name}" + (f" — {detail}" if detail else ""))


check("bundle includes 6d-vmslab.js", "function vlRun(" in PAGE and "function vlCands(" in PAGE)
check("sign-guidance panel mounted: 5-app.js concatenates vlabHTML() and calls vlMount() after binding", "engStateSec()+vlabHTML()" in APP and "engBind1();vlMount();" in APP)
check("markers refresh after the engine runs: 6-engine.js engRun() calls vlAfterRun()", "engRenderOut();vlAfterRun();" in ENG)
check("every number comes from BE.api.run(); the page does not compute queues", LAB.count("BE.api.run(") >= 3 and "queue_m" in LAB)
check("sign text goes through esc() before entering HTML", "esc(vlText(" in LAB and not re.search(r"\$\{vlText\(", LAB))
lits = [n for n in ("918", "548", "193", "82 m", "836", "725", "1,250") if n in LAB]
check("negative: no hard-coded demo numbers in the source", not lits, str(lits))
pos = [m.start() for m in re.finditer(r"\bL\(", LAB)] + [len(LAB)]
bad = [LAB[a:a + 60] for a, b in zip(pos, pos[1:]) if not re.search(r"[一-鿿]", LAB[a:b])]
check("EN/ZH copy is paired (Chinese text between every L( and the next L()", len(pos) > 8 and not bad, str(bad))
check("compact mode does not collapse it: the outer element is not .stack (7-glass.js only collapses top-level .stack)", '<div id="vlab" class="vlab">' in LAB and 'class="stack' not in LAB.split("function vlabHTML")[1][:200])
check("styles: bench row / recommended / current", ".vlab-row{" in CSS and ".vlab-row.best" in CSS and '.vlab-row[aria-current="true"]' in CSS)
check("narrow screens: rows use minmax(0,1fr), long copy wraps instead of overflowing the panel", "grid-template-columns:minmax(0,1fr) 64px 54px" in CSS and "overflow-wrap:anywhere" in CSS.split(".vlab-row .tx{")[1][:120])

node = shutil.which("node")
if not node:
    check("node found", False, "the real-network assertions run under node")
else:
    try:
        r = subprocess.run([node, str(HERE / "vlab_glue.mjs")], capture_output=True, text=True, encoding="utf-8", timeout=180)
        out, code = r.stdout + r.stderr, r.returncode
    except subprocess.TimeoutExpired:
        out, code = "❌ vlab_glue.mjs did not finish within 180 s\n", 1
    n_before = failed
    for line in out.splitlines():
        if line.startswith("✅"):
            passed += 1
            print(line)
        elif line.startswith("❌"):
            failed += 1
            print(line)
        elif line.startswith("   "):
            print(line)
    if code != 0 and failed == n_before:
        check(f"vlab_glue.mjs exit code {code}", False, "\n".join(out.splitlines()[-15:]))

print(f"{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
