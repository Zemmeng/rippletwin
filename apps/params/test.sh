#!/usr/bin/env bash
# Purpose: validate apps/params/public/params.json
#   - every parameter has a source + confidence (confidence ∈ high/medium/low/none)
#   - share/ratio values ∈ [0,1]; both ends of range are in [0,1] and the value lies inside it (when the value is not null)
#   - the four mix shares sum to 1 (±1e-6)
#   - all keys are ASCII (docs/decisions.md D-05)
#   - the last line is always "N passed, M failed"
# Usage: bash test.sh
# Exit code: 0 all passed; 1 at least one failure
set -u
cd "$(dirname "$0")" || exit 1

JSON="public/params.json"
P=0
F=0

pass() { P=$((P + 1)); echo "  ✅ $1"; }
fail() { F=$((F + 1)); echo "  ❌ $1"; }

if [ ! -f "$JSON" ]; then
  echo "missing $JSON"
  echo "0 passed, 1 failed"
  exit 1
fi

python3 - "$JSON" <<'PY'
import json, sys, re

path = sys.argv[1]
ok = 0
bad = 0

def check(cond, msg):
    global ok, bad
    if cond:
        ok += 1
        print("  ✅", msg)
    else:
        bad += 1
        print("  ❌", msg)

try:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
except Exception as e:
    print("  ❌ JSON parse failed:", e)
    print("0 passed, 1 failed")
    sys.exit(1)

check(isinstance(data.get("version"), int) and data.get("version") >= 1, "version is a positive integer")

ASCII_RE = re.compile(r"^[\x20-\x7e]+$")

def walk(obj, prefix=""):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if not ASCII_RE.match(k):
                yield ("key", prefix + k, None)
            yield from walk(v, prefix + k + ".")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            yield from walk(v, prefix + f"[{i}].")
    else:
        yield ("leaf", prefix.rstrip("."), obj)

# 1) ASCII keys
bad_keys = [p for t, p, _ in walk(data) if t == "key"]
check(not bad_keys, "all keys are ASCII" + (f" violations: {bad_keys}" if bad_keys else ""))

# 2) parameters: every object shaped like {value, source, confidence, ...}
def is_param(d):
    return isinstance(d, dict) and "value" in d and ("confidence" in d or "source" in d)

params = []

def collect(obj, path=""):
    if isinstance(obj, dict):
        if is_param(obj):
            params.append((path, obj))
        for k, v in obj.items():
            collect(v, path + "/" + k if path else k)

collect(data)
check(len(params) >= 8, f"at least 8 parameter objects (found {len(params)})")

UNIT_SHARE = {"share", "ratio"}
CONF_OK = {"high", "medium", "low", "none"}

for path, p in params:
    conf = p.get("confidence")
    src = p.get("source")
    val = p.get("value")
    rng = p.get("range")
    unit = p.get("unit")

    check(conf in CONF_OK, f"{path}.confidence ∈ high/medium/low/none (got {conf!r})")

    if conf == "none":
        check(val is None, f"{path}.value is null (confidence=none must not invent a number)")
    else:
        check(src not in (None, ""), f"{path}.source is not empty")

    if unit in UNIT_SHARE and val is not None:
        check(isinstance(val, (int, float)) and 0.0 <= float(val) <= 1.0,
              f"{path}.value is within 0–1 (got {val})")
        if rng is not None:
            check(isinstance(rng, list) and len(rng) == 2, f"{path}.range is [lo,hi]")
            if isinstance(rng, list) and len(rng) == 2:
                lo, hi = rng
                check(0.0 <= float(lo) <= float(hi) <= 1.0, f"{path}.range is within 0–1 with lo≤hi (got {rng})")
                check(float(lo) <= float(val) <= float(hi), f"{path}.value lies within range")

# 3) the four mix shares sum to 1
mix = data.get("mix") or {}
need = ["commuter", "local", "tourist", "delivery"]
check(all(k in mix for k in need), f"mix contains {need}")
if all(k in mix for k in need):
    s = 0.0
    for k in need:
        v = mix[k].get("value")
        check(isinstance(v, (int, float)), f"mix.{k}.value is a number")
        if isinstance(v, (int, float)):
            s += float(v)
    check(abs(s - 1.0) <= 1e-6, f"the four mix shares sum to 1 (actual {s:.6f})")

# 4) both high-confidence anchors need a traceable source (a link or an author-year citation)
for k in ("named_route_divert", "stated_to_actual"):
    a = (data.get("anchors") or {}).get(k) or {}
    src = a.get("source") or ""
    check(a.get("confidence") == "high", f"anchors.{k}.confidence = high")
    check("http" in src or re.search(r"\d{4}", src), f"anchors.{k}.source contains a link or a year")

print(f"{ok} passed, {bad} failed")
sys.exit(1 if bad else 0)
PY
