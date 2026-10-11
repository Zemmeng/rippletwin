#!/usr/bin/env bash
# Purpose: run every test in this module; discovers tests/*.test.mjs, runs each one and totals the results
# Usage: bash test.sh (works from any directory); requires node >= 18, no npm install needed
# Exit code: 0 all passed; 1 any failure (failed assertion / crash / missing count line / timeout / no tests found)
# The last line is always "N passed, M failed"; scripts/check.sh uses it for the totals
cd "$(dirname "$0")" || exit 1

LIMIT=60 # time limit per test file (seconds)
P=0
F=0
N=0

if ! command -v node >/dev/null 2>&1; then
  echo "❌ node not found (needs >= 18)"
  echo "0 passed, 1 failed"
  exit 1
fi

TMP=$(mktemp -d "${TMPDIR:-/tmp}/api-test.XXXXXX") || exit 1
PID=""
cleanup() {
  [ -n "$PID" ] && kill "$PID" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

run_one() {
  local f="$1" out="$TMP/out.txt" ticks=0 code timed_out=0 last p q
  N=$((N + 1))
  # macOS has no timeout command: run in the background and poll with kill -0
  node "$f" >"$out" 2>&1 &
  PID=$!
  while kill -0 "$PID" 2>/dev/null; do
    if [ "$ticks" -ge $((LIMIT * 10)) ]; then
      kill "$PID" 2>/dev/null
      sleep 0.2
      kill -9 "$PID" 2>/dev/null
      timed_out=1
      break
    fi
    sleep 0.1
    ticks=$((ticks + 1))
  done
  wait "$PID" 2>/dev/null
  code=$?
  PID=""

  last=$(tail -n 1 "$out" | tr -d '\r')
  if [ "$timed_out" = 1 ]; then
    printf '❌ %-24s timed out (>%ss)\n' "$f" "$LIMIT"
    F=$((F + 1))
  elif ! printf '%s\n' "$last" | grep -Eq '^[0-9]+ passed, [0-9]+ failed$'; then
    # A crash must never pass as green: a missing count line always counts as 1 failure
    printf '❌ %-24s missing the "N passed, M failed" count line (exit code %s)\n' "$f" "$code"
    F=$((F + 1))
  else
    p=$(printf '%s\n' "$last" | sed -E 's/^([0-9]+) passed.*/\1/')
    q=$(printf '%s\n' "$last" | sed -E 's/.* ([0-9]+) failed$/\1/')
    P=$((P + p))
    F=$((F + q))
    if [ "$code" -ne 0 ] && [ "$q" -eq 0 ]; then
      printf '❌ %-24s %s, but the exit code is %s\n' "$f" "$last" "$code"
      F=$((F + 1))
    elif [ "$q" -gt 0 ]; then
      printf '❌ %-24s %s\n' "$f" "$last"
    else
      printf '✅ %-24s %s\n' "$f" "$last"
      return
    fi
  fi
  echo "   ── end of output ──"
  tail -n 25 "$out" | sed 's/^/   /'
}

for f in tests/*.test.mjs; do
  [ -f "$f" ] || continue
  run_one "$f"
done

if [ "$N" -eq 0 ]; then
  echo "❌ no test files found under tests/"
  F=$((F + 1))
fi

echo "$P passed, $F failed"
[ "$F" -eq 0 ] || exit 1
