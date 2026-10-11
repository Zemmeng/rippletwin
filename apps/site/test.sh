#!/usr/bin/env bash
# Purpose: run every test in this module (tests/*.test.mjs: build.mjs output, worker.js routing, wrangler.jsonc config) one by one and sum up
# Usage: bash apps/site/test.sh (works from any directory); requires node >= 18, no npm install, no network
# Exit code: 0 all passed; 1 any failure (a failed assertion, a crash, a missing count line, a timeout or no tests found)
# The last line is always "N passed, M failed"; scripts/check.sh reads it
cd "$(dirname "$0")" || exit 1

LIMIT=60 # time limit per test file (seconds)
P=0; F=0; N=0

if ! command -v node >/dev/null 2>&1; then
  echo "❌ node not found (needs >= 18)"; echo "0 passed, 1 failed"; exit 1
fi

OUT=$(mktemp "${TMPDIR:-/tmp}/site-test.XXXXXX") || exit 1
PID=""
trap '[ -n "$PID" ] && kill "$PID" 2>/dev/null; rm -f "$OUT"' EXIT
trap 'exit 130' INT TERM

for f in tests/*.test.mjs; do
  [ -f "$f" ] || continue
  N=$((N + 1)); ticks=0; timed_out=0
  # macOS has no timeout command: run in the background and poll with kill -0
  node "$f" >"$OUT" 2>&1 &
  PID=$!
  while kill -0 "$PID" 2>/dev/null; do
    if [ "$ticks" -ge $((LIMIT * 10)) ]; then kill -9 "$PID" 2>/dev/null; timed_out=1; break; fi
    sleep 0.1; ticks=$((ticks + 1))
  done
  wait "$PID" 2>/dev/null; code=$?; PID=""
  last=$(tail -n 1 "$OUT" | tr -d '\r')
  if [ "$timed_out" = 1 ]; then
    echo "❌ $f timed out (>${LIMIT}s)"; F=$((F + 1))
  elif ! printf '%s\n' "$last" | grep -Eq '^[0-9]+ passed, [0-9]+ failed$'; then
    # A crash must never pass as green: a missing count line always counts as 1 failure
    echo "❌ $f has no \"N passed, M failed\" count line (exit code ${code})"; F=$((F + 1)); tail -n 20 "$OUT" | sed 's/^/   /'
  else
    p=${last%% passed*}; q=${last##*, }; q=${q%% failed}
    P=$((P + p)); F=$((F + q))
    if [ "$code" -ne 0 ] && [ "$q" -eq 0 ]; then echo "❌ $f ${last}, but the exit code is $code"; F=$((F + 1))
    elif [ "$q" -gt 0 ]; then echo "❌ $f $last"; grep '^❌' "$OUT" | sed 's/^/   /'
    else echo "✅ $f $last"; fi
  fi
done

[ "$N" -eq 0 ] && { echo "❌ no test files found in tests/"; F=$((F + 1)); }
echo "$P passed, $F failed"
[ "$F" -eq 0 ] || exit 1
