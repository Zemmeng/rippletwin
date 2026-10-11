"""Real buildings: buildings.json footprints converted to the page grid, the parts that overlap streets clipped off, the ground / shadow / wind-shadow rasters built, and a fallback to the procedurally generated city on bad data.

Usage: python3 apps/web/tests/test_world.py (needs node ≥ 18, no network)
The assertions live in tests/world_real.mjs; this file only runs node and forwards its ✅ / ❌ lines. The last line is "N passed, M failed".
"""
import pathlib
import shutil
import subprocess
import sys

HERE = pathlib.Path(__file__).resolve().parent
node = shutil.which("node")
if not node:
    print("❌ node not found (the real-buildings assertions run under node)")
    print("0 passed, 1 failed")
    sys.exit(1)
try:
    r = subprocess.run([node, str(HERE / "world_real.mjs")], capture_output=True, text=True, encoding="utf-8", timeout=120)
    out, code = r.stdout + r.stderr, r.returncode
except subprocess.TimeoutExpired:
    out, code = "❌ world_real.mjs did not finish within 120 s\n", 1
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
    print(f"❌ world_real.mjs exit code {code}")
    print("\n".join(out.splitlines()[-15:]))
print(f"{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
