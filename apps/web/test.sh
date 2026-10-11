#!/usr/bin/env bash
# Purpose: run every apps/web test (tests/test_*.py) one by one and add up the results
# Usage: bash apps/web/test.sh (works from any directory). Requires Python ≥ 3.9 and Node ≥ 18; no packages to install
# Exit code: 0 if everything passed; 1 on any failure (a failed assertion, a crash, a missing count line or no tests found)
# The last line is always "N passed, M failed"; scripts/check.sh relies on it for its summary
cd "$(dirname "$0")" || exit 1

PY=$(command -v python3 || command -v python)
if [ -z "$PY" ]; then echo "❌ python3 not found"; echo "0 passed, 1 failed"; exit 1; fi

P=0; F=0; N=0
for f in tests/test_*.py; do
  [ -f "$f" ] || continue
  N=$((N + 1))
  out=$(PYTHONIOENCODING=utf-8 "$PY" "$f" 2>&1); code=$?
  last=$(printf '%s\n' "$out" | tail -n 1 | tr -d '\r')
  if ! printf '%s\n' "$last" | grep -Eq '^[0-9]+ passed, [0-9]+ failed$'; then
    echo "❌ $f has no \"N passed, M failed\" count line (exit code ${code})"; F=$((F + 1)); printf '%s\n' "$out" | tail -n 20 | sed 's/^/   /'
    continue
  fi
  p=${last%% passed*}; q=${last##*, }; q=${q%% failed}
  P=$((P + p)); F=$((F + q))
  if [ "$code" -ne 0 ] && [ "$q" -eq 0 ]; then echo "❌ $f ${last}, but the exit code is $code"; F=$((F + 1))
  elif [ "$q" -gt 0 ]; then echo "❌ $f $last"; printf '%s\n' "$out" | grep '^❌' | sed 's/^/   /'
  else echo "✅ $f $last"; fi
done

[ "$N" -eq 0 ] && { echo "❌ no test files found under tests/"; F=$((F + 1)); }
echo "$P passed, $F failed"
[ "$F" -eq 0 ] || exit 1
