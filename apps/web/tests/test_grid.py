"""Junction micro-simulation (src/js/4b-grid.js; 4×4 computed, 2×2 shown): tests/grid_glue.mjs runs it in node on the real network and real flows.

Usage: python3 apps/web/tests/test_grid.py (needs node ≥ 18, no network)
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
passed = failed = 0


def check(name, ok, detail=""):
    global passed, failed
    if ok:
        passed += 1
        print(f"✅ {name}")
    else:
        failed += 1
        print(f"❌ {name}{(': ' + detail) if detail else ''}")


G = JS.get("4b-grid.js", "")
check("4b-grid.js has /* grid:begin */ … /* grid:end */", "/* grid:begin */" in G and "/* grid:end */" in G)
names = re.findall(r"^(?:const|let|class|function) ([A-Za-z_$][\w$]*)", G, re.M)
check("every top-level name in 4b-grid.js has a grid / Grid / GRID prefix", names and all(n.lower().startswith("grid") for n in names), str(names))
check("negative: 4b-grid.js does not touch the DOM", not re.search(r"\b(document|window|canvas)\b", G))

# Real network / real flows (node)
node = shutil.which("node")
if not node:
    check("node found (needed by grid_glue.mjs)", False)
else:
    try:
        r = subprocess.run([node, str(HERE / "grid_glue.mjs")], capture_output=True, text=True, encoding="utf-8", timeout=150)
        out, code = r.stdout + r.stderr, r.returncode
    except subprocess.TimeoutExpired:
        out, code = "❌ grid_glue.mjs did not finish within 150 s\n", 1
    n0 = passed + failed
    for line in out.splitlines():
        if line.startswith("✅"):
            passed += 1
            print(line)
        elif line.startswith("❌"):
            failed += 1
            print(line)
    if code != 0 and passed + failed == n0:
        check(f"grid_glue.mjs exit code {code}", False, out[-400:])

print(f"{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
