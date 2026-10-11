#!/usr/bin/env bash
# Purpose: increment every ?v=N in public/index.html and public/js/*.js so browsers re-fetch CSS/JS/data (run after every front-end change)
# Usage: bash apps/sim/bump.sh (from any directory)
# Exit code: 0 incremented; 1 no ?v=N found
cd "$(dirname "$0")" || exit 1
python3 - public/index.html public/js/*.js <<'PY'
import re, sys
n = 0
for f in sys.argv[1:]:
    s = open(f, encoding='utf-8').read()
    t, k = re.subn(r'\?v=(\d+)', lambda m: '?v=%d' % (int(m.group(1)) + 1), s)
    if k:
        open(f, 'w', encoding='utf-8').write(t); n += k
        print('%s: %d incremented' % (f, k))
if not n:
    print('❌ no ?v=N found'); sys.exit(1)
PY
