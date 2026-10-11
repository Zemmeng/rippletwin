"""Plan comparison: the pure functions in 8-compare.js, each of the advisor's changes run through backend.js, and the pack.js execution pack.

Usage: python3 apps/web/tests/test_compare.py (needs node ≥ 18, no network)
The assertions live in tests/compare_glue.mjs; this file only runs node and forwards its ✅ / ❌ lines. The last line is "N passed, M failed".
"""
import pathlib
import shutil
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
node = shutil.which("node")
if not node:
    print("❌ node not found (the wiring-layer assertions run under node)")
    print("0 passed, 1 failed")
    sys.exit(1)
try:
    r = subprocess.run([node, str(HERE / "compare_glue.mjs")], capture_output=True, text=True, encoding="utf-8", timeout=120)
    out, code = r.stdout + r.stderr, r.returncode
except subprocess.TimeoutExpired:
    out, code = "❌ compare_glue.mjs did not finish within 120 s\n", 1
passed = failed = 0
for line in out.splitlines():
    if line.startswith("✅"):
        passed += 1
        print(line)
    elif line.startswith("❌"):
        failed += 1
        print(line)
if code != 0 and failed == 0:
    failed += 1
    print(f"❌ compare_glue.mjs exit code {code}")
    print("\n".join(out.splitlines()[-15:]))
print(f"{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
