#!/usr/bin/env bash
# check.sh: the single check / test entry point. Run locally, by .githooks/pre-push, by GitHub Actions CI and by deploy.sh.
#
# Purpose: 9 numbered checks at two levels, ❌ (must fix) and ⚠️ (warning), always followed by a summary block.
#   [1] Secret scan     [2] Secret files tracked   [3] Branch & module boundary   [4] Module structure
#   [5] Module tests    [6] Repo hygiene           [7] RULES block                [8] Handoff notes   [9] hackathon.conf
# Usage:
#   bash scripts/check.sh                  full: scan every file and run every apps/*/test.sh
#   bash scripts/check.sh --quick          quick: the secret scan and tests cover only files / modules changed since base
#   bash scripts/check.sh --base <ref>     diff base (default origin/main, then main; if neither exists, diff-based checks are skipped with a ⚠️)
#   bash scripts/check.sh --e2e [URL]      live smoke test only (without a URL, reads DEMO_URL from hackathon.conf):
#                                          GET / returns 200 and contains data-smoke; /api/health contains "ok":true;
#                                          no localhost in the HTML; each request ≤3 s. Results go to logs/last-e2e.txt
#   bash scripts/check.sh --selftest       build 16 scenarios in throwaway repos (direct push to main / fake keys / cross-module
#                                          change / crashing test / missing count line / bad branch name / missing RULES markers /
#                                          size limits ...) and confirm the gate turns red when it should
#   bash scripts/check.sh --time           print only the current time, time to the deadline and the phase
#   bash scripts/check.sh --time-raw       same, as KEY=VALUE lines (PHASE= is the phase; parsed by deploy.sh and deploy.yml)
# Output: one line per check, "[N] Name ✅" / "[N] Name ❌ reason" / "[N] Name ⚠️ reason"; indented lines are details.
#   A summary block ends the output: first one line "======== Summary X ❌ Y ⚠️", then every ❌/⚠️ line repeated verbatim
#   (pre-push and CI read only this block to classify a run; do not count ❌ by grepping the whole output).
#   The whole output is also written to logs/last-check.txt (the directory is created if missing).
# Exit codes: 0 = no ❌ (⚠️ allowed); 1 = at least one ❌; 2 = usage error / not inside a git repo
# Environment variables:
#   ALLOW_CROSS=1  [3] downgrades cross-module files and non-conforming branch names to ⚠️ (CI sets it when the PR has the cross-module label)
#   ALLOW_MAIN=1   [3] downgrades "changes on main" to ⚠️ (for small direct pushes to main by the lead)
#   BRANCH=<name>  overrides the branch name (a CI PR checkout is a detached merge commit; the workflow sets github.head_ref)
#   GITHUB_ACTOR   used in CI to verify identity on lead/* branches (locally: git config hack.me)
#   CHECK_TEST_TIMEOUT=<seconds>  time limit per test.sh, default 120 (the gates pass smaller values)
# Compatible with macOS's bundled bash 3.2 (no mapfile / declare -A / ${var,,}) and Ubuntu; all times are computed with python3 zoneinfo.
set -uo pipefail

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SELF="$SELF_DIR/$(basename "${BASH_SOURCE[0]}")"
TEST_TIMEOUT="${CHECK_TEST_TIMEOUT:-120}"
TIMEOUT_NOTE=""
if ! printf '%s' "$TEST_TIMEOUT" | grep -Eq '^[1-9][0-9]*$'; then
  TIMEOUT_NOTE="CHECK_TEST_TIMEOUT=$TEST_TIMEOUT is not a positive integer; using 120 s"; TEST_TIMEOUT=120
fi
TMPBASE="${TMPDIR:-/tmp}"; TMPBASE="${TMPBASE%/}"
DETAIL_MAX=20

usage() { awk 'NR==1{next} /^#/{sub(/^# ?/,"");print;next} {exit}' "$SELF"; }

MODE="full"; BASE_ARG=""; E2E_URL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --quick) MODE="quick" ;;
    --base) [ -n "${2:-}" ] || { echo "❌ --base needs a ref" >&2; exit 2; }; BASE_ARG="$2"; shift ;;
    --base=*) BASE_ARG="${1#--base=}" ;;
    --e2e)  # the URL is optional (omitted or empty → read DEMO_URL from the conf)
      MODE="e2e"
      if [ $# -ge 2 ] && [ "${2#-}" = "$2" ]; then E2E_URL="$2"; shift; fi ;;
    --e2e=*) E2E_URL="${1#--e2e=}"; MODE="e2e" ;;
    --selftest) MODE="selftest" ;;
    --time) MODE="time" ;;
    --time-raw) MODE="timeraw" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "❌ Unknown argument: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

g() { git -c core.quotePath=false "$@"; }

# =====================================================================
# Python helper: [6][7][8][9] and time calculations. Output protocol: E:<❌ reason> / W:<⚠️ reason> / D:<detail> / OK:<all-green note>
# Times: conf times are read as local time in TZ, then converted to UTC for arithmetic —
#   subtracting two aware datetimes that share one ZoneInfo ignores the offset, which is an hour off across the 10-04 DST change.
# =====================================================================
pyhelp() {
python3 - "$@" <<'PY'
import os, re, subprocess, sys
from datetime import datetime, timedelta, timezone

UTC = timezone.utc
WEEK = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
KEYS = ['EVENT_NAME', 'EVENT_URL', 'TZ', 'START', 'DEADLINE', 'FEATURE_FREEZE_HOURS', 'CODE_FREEZE_HOURS',
        'LEAD', 'BACKUP_LEAD', 'DEPLOYER', 'DEMO_URL', 'VIDEO_URL', 'DEPLOY_MODULES']
sub, root = sys.argv[1], sys.argv[2]


def emit(kind, msg):
    print('%s:%s' % (kind, msg))


def read_text(rel):
    p = os.path.join(root, rel)
    if not os.path.isfile(p):
        return None
    with open(p, encoding='utf-8', errors='replace') as f:
        return f.read().replace('\r\n', '\n')


def read_conf():
    """Matches the bash reading (grep '^KEY=' | cut -d= -f2- | sed 's/#.*//' | xargs): strip comments, surrounding whitespace and quotes."""
    text = read_text('hackathon.conf')
    if text is None:
        return None, [], []
    conf, bad, dups = {}, [], []
    for no, line in enumerate(text.split('\n'), 1):
        s = line.strip()
        if not s or s.startswith('#'):
            continue
        m = re.match(r'^([A-Z_][A-Z0-9_]*)=(.*)$', line)
        if not m:
            bad.append(no)
            continue
        k, v = m.group(1), m.group(2).split('#', 1)[0].strip().strip('"').strip("'")
        if k in conf:
            dups.append(k)
            continue
        conf[k] = v
    return conf, bad, dups


def fmt(t, tz):
    d = t.astimezone(tz)
    return d.strftime('%m-%d ') + WEEK[d.weekday()] + d.strftime(' %H:%M')


def timeinfo(conf):
    r = {'err': [], 'warn': [], 'phase': 'not set', 'left': '--', 'tzlabel': '', 'now': '', 'marks': '',
         'start': None, 'dl': None, 'tz': None}
    tzname = conf.get('TZ', '')
    tz = None
    try:
        from zoneinfo import ZoneInfo
        if tzname:
            try:
                tz = ZoneInfo(tzname)
            except Exception:
                r['err'].append('TZ=%s is not a valid IANA time zone name (e.g. Australia/Melbourne)' % tzname)
        else:
            r['warn'].append('TZ is empty (using the local time zone for now)')
    except ImportError:
        r['err'].append('python3 < 3.9 has no zoneinfo; cannot compute time zones')
    if tz is None:
        tz, r['tzlabel'] = datetime.now().astimezone().tzinfo, 'local time zone'
    else:
        r['tzlabel'] = tzname
    r['tz'] = tz
    now = datetime.now(UTC)
    local = now.astimezone(tz)
    r['now'] = local.strftime('%Y-%m-%d ') + WEEK[local.weekday()] + local.strftime(' %H:%M')

    def parse(key):
        s = conf.get(key, '')
        if not s:
            return None
        try:
            naive = datetime.strptime(s, '%Y-%m-%d %H:%M')
        except ValueError:
            r['err'].append('%s=%s has the wrong format (expected YYYY-MM-DD HH:MM, local time in TZ)' % (key, s))
            return None
        aware = naive.replace(tzinfo=tz)
        if aware.astimezone(UTC).astimezone(tz).replace(tzinfo=None) != naive:
            r['warn'].append('%s=%s falls in the hour skipped by daylight saving; this local time does not exist' % (key, s))
        return aware.astimezone(UTC)

    def hours(key, default):
        v = conf.get(key, '')
        if v == '':
            return float(default)
        try:
            h = float(v)
            if h < 0:
                raise ValueError
            return h
        except ValueError:
            r['err'].append('%s=%s is not a non-negative number (using %s)' % (key, v, default))
            return float(default)

    start, dl = parse('START'), parse('DEADLINE')
    ffh, cfh = hours('FEATURE_FREEZE_HOURS', 6), hours('CODE_FREEZE_HOURS', 2)
    r['start'], r['dl'] = start, dl
    if dl is not None:
        ff, cf = dl - timedelta(hours=ffh), dl - timedelta(hours=cfh)
        if now >= dl:
            r['phase'] = 'deadline passed'
        elif now >= cf:
            r['phase'] = '🔒 code freeze'
        elif now >= ff:
            r['phase'] = '🧊 feature freeze'
        elif start is not None and now < start:
            r['phase'] = 'pre-event'
        else:
            r['phase'] = 'development'
        h = (dl - now).total_seconds() / 3600
        r['left'] = ('%.1fh left' % h) if h >= 0 else ('passed %.1fh ago' % -h)
        r['marks'] = 'deadline %s · 🧊 feature freeze %s · 🔒 code freeze %s' % (fmt(dl, tz), fmt(ff, tz), fmt(cf, tz))
        if start is not None and now < start:
            r['marks'] += ' · start %s (in %.1fh)' % (fmt(start, tz), (start - now).total_seconds() / 3600)
    return r


def git(*a):
    return subprocess.run(['git', '-c', 'core.quotePath=false'] + list(a), cwd=root,
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout


def zsplit(b):
    return [p.decode('utf-8', 'surrogateescape') for p in b.split(b'\0') if p]


# ---------------------------------------------------------------- time
if sub in ('time', 'timeraw'):
    conf, _, _ = read_conf()
    if conf is None:
        conf = {}
    t = timeinfo(conf)
    notes = t['err'] + t['warn']
    if not conf:
        notes.insert(0, 'cannot read hackathon.conf')
    if sub == 'timeraw':
        print('PHASE=%s' % t['phase'])
        print('NOW=%s' % t['now'])
        print('TZ=%s' % t['tzlabel'])
        print('LEFT=%s' % t['left'])
        print('MARKS=%s' % t['marks'])
        print('NOTE=%s' % '; '.join(notes))
    else:
        print('⏰ Now %s (%s) | deadline: %s | phase: %s' % (t['now'], t['tzlabel'], t['left'], t['phase']))
        if t['marks']:
            print('   ' + t['marks'])
        for n in notes:
            print('   ⚠️ ' + n)
        if t['phase'] == 'not set':
            print('   (DEADLINE in hackathon.conf is empty; the lead fills it in at kickoff)')

# ---------------------------------------------------------------- [9] conf
elif sub == 'conf':
    conf, bad, dups = read_conf()
    if conf is None:
        emit('E', 'hackathon.conf is missing (restore it from git; do not write a new one)')
        sys.exit(0)
    for no in bad:
        emit('E', 'hackathon.conf line %d is not KEY=VALUE (no leading spaces allowed)' % no)
    for k in sorted(set(dups)):
        emit('W', '%s is set more than once (scripts use only the first)' % k)
    missing = [k for k in KEYS if k not in conf]
    if missing:
        emit('W', 'hackathon.conf is missing keys: %s' % ' '.join(missing))
    t = timeinfo(conf)
    for e in t['err']:
        emit('E', e)
    for w in t['warn']:
        emit('W', w)
    if not conf.get('DEADLINE'):
        emit('W', 'DEADLINE is not set (the countdown shows --; the lead fills it in at kickoff)')
    if t['start'] and t['dl'] and t['start'] >= t['dl']:
        emit('E', 'START is not earlier than DEADLINE')
    for k in ('LEAD', 'DEPLOYER'):
        if k in conf and not conf[k]:
            emit('W', '%s is empty' % k)
    demo = conf.get('DEMO_URL', '')
    if demo:
        readme = read_text('README.md')
        if readme is None:
            emit('W', 'DEMO_URL is set, but there is no README.md')
        elif demo.rstrip('/') not in readme:
            emit('W', 'DEMO_URL (%s) not found in README.md: the demo link at the top of the README must match the conf' % demo)
    for m in conf.get('DEPLOY_MODULES', '').split():
        if not os.path.isdir(os.path.join(root, 'apps', m)):
            emit('W', 'DEPLOY_MODULES entry %s does not exist under apps/' % m)
    emit('OK', 'phase: %s · deadline: %s' % (t['phase'], t['left']))

# ---------------------------------------------------------------- [6] hygiene
elif sub == 'hygiene':
    MB = 1024 * 1024
    # .json data files under apps/<module>/public/: 2MB limit and no 500KB warning (PRD "each file < 2 MB", D-0929-1430); everything else 1MB
    DATA_RE = re.compile(r'apps/[^/]+/public/.+\.json$')
    # .pdf files under docs/hackathon/pitch/ (the pre-screening / final submission PDFs): 10MB limit and no 500KB warning (D-0930-0116)
    PDF_RE = re.compile(r'docs/hackathon/pitch/.+\.pdf$')

    def is_data(p):
        return DATA_RE.match(p) is not None
    tracked = {}
    for rec in git('ls-files', '-s', '-z').split(b'\0'):
        if b'\t' not in rec:
            continue
        meta, path = rec.split(b'\t', 1)
        tracked[path.decode('utf-8', 'surrogateescape')] = meta.split()[0].decode()
    untracked = zsplit(git('ls-files', '-z', '--others', '--exclude-standard'))

    def fpath(p):
        return os.path.join(root, p)

    for p in sorted(tracked):
        fp = fpath(p)
        if tracked[p] == '160000' or os.path.islink(fp) or not os.path.isfile(fp):
            continue
        sz = os.path.getsize(fp)
        if is_data(p):
            if sz > 2 * MB:
                emit('E', '%s %.1fMB > 2MB (data file limit; thin it out, drop fields or split the file)' % (p, sz / MB))
        elif PDF_RE.match(p):
            if sz > 10 * MB:
                emit('E', '%s %.1fMB > 10MB (pitch PDF limit; lower the image resolution when exporting)' % (p, sz / MB))
        elif sz > MB:
            emit('E', '%s %.1fMB > 1MB (compress it or host it elsewhere; git rm --cached %s)' % (p, sz / MB, p))
        elif sz > 500 * 1024:
            emit('W', '%s %dKB > 500KB (compress it if you can)' % (p, sz // 1024))
    for p in sorted(untracked):
        fp = fpath(p)
        lim = 2 * MB if is_data(p) else 10 * MB if PDF_RE.match(p) else MB
        if os.path.isfile(fp) and not os.path.islink(fp) and os.path.getsize(fp) > lim:
            emit('W', '%s (untracked) %.1fMB > %dMB: do not git add it; keep it in out/ or external storage' % (p, os.path.getsize(fp) / MB, lim // MB))
    shells = [p for p in list(tracked) + untracked if p.endswith('.sh') or p.startswith('.githooks/')]
    # $var directly followed by non-ASCII (e.g. $mod followed by a full-width comma): macOS bash takes the first byte of the
    # wide character as part of the variable name and fails with "unbound variable" under set -u, so write ${var}
    VAR_NONASCII = re.compile(r'\$([A-Za-z_][A-Za-z0-9_]*)(?=[^\x00-\x7f])')
    for p in sorted(set(shells)):
        fp = fpath(p)
        if os.path.islink(fp) or not os.path.isfile(fp):
            continue
        hits = [i for i, l in enumerate((read_text(p) or '').split('\n'), 1) if VAR_NONASCII.search(l)]
        if hits:
            emit('W', '%s:%d (%d line(s)): $var directly followed by a non-ASCII / full-width character (crashes on macOS); write ${var}' % (p, hits[0], len(hits)))
    for p in sorted(set(shells)):
        fp = fpath(p)
        if os.path.islink(fp) or not os.path.isfile(fp) or p.endswith('.md'):
            continue
        if p in tracked:
            if tracked[p] != '100755':
                emit('W', '%s has no executable bit in git (git update-index --chmod=+x %s)' % (p, p))
        elif not os.access(fp, os.X_OK):
            emit('W', '%s has no executable bit (chmod +x %s)' % (p, p))
        with open(fp, 'rb') as f:
            if b'\r\n' in f.read():
                emit('W', '%s has CRLF line endings (causes "bad interpreter"; convert to LF)' % p)
    emit('OK', '%d tracked files' % len(tracked))

# ---------------------------------------------------------------- [7] RULES
elif sub == 'rules':
    FILES = ['README.md']
    BEGIN, END = re.compile(r'<!--\s*RULES:BEGIN\s*-->'), re.compile(r'<!--\s*RULES:END\s*-->')
    blocks = {}
    for f in FILES:
        t = read_text(f)
        if t is None:
            emit('W', '%s does not exist' % f)
            continue
        nb, ne = len(BEGIN.findall(t)), len(END.findall(t))
        if nb == 0 or ne == 0:
            miss = ' and '.join(x for x, n in (('<!-- RULES:BEGIN -->', nb), ('<!-- RULES:END -->', ne)) if n == 0)
            emit('E', '%s is missing %s (the block with the three hard rules; README.md needs exactly one pair)' % (f, miss))
            continue
        if nb > 1 or ne > 1:
            emit('E', '%s has %d BEGIN and %d END markers (exactly one pair per file)' % (f, nb, ne))
            continue
        b = BEGIN.search(t)
        e = END.search(t, b.end())
        if not e:
            emit('E', '%s: RULES:END comes before RULES:BEGIN' % f)
            continue
        lines = t[b.end():e.start()].split('\n')
        while lines and not lines[0].strip():
            lines.pop(0)
        while lines and not lines[-1].strip():
            lines.pop()
        blocks[f] = lines
    names = [f for f in FILES if f in blocks]
    if names:
        ref = names[0]
        for f in names[1:]:
            a, b = blocks[ref], blocks[f]
            if a != b:
                n = next((i for i in range(min(len(a), len(b))) if a[i] != b[i]), min(len(a), len(b)))
                emit('E', '%s: RULES block differs from %s (from line %d of the block)' % (f, ref, n + 1))
    emit('OK', 'README.md has one RULES block')

# ---------------------------------------------------------------- [8] handoff notes
elif sub == 'handoff':
    d = os.path.join(root, 'handoff')
    if not os.path.isdir(d):
        emit('OK', 'no handoff/ directory')
        sys.exit(0)
    conf, _, _ = read_conf()
    t = timeinfo(conf or {})
    tz = t['tz']
    now = datetime.now(UTC)
    NAME = re.compile(r'^[A-Za-z0-9][A-Za-z0-9-]*-T[0-9]+-(\d{2})(\d{2})-(\d{2})(\d{2})\.md$')
    HEADS = [('## 1. Facts', r'^##\s*1\.\s*Facts'), ('## 2. Shared files to change', r'^##\s*2\.\s*Shared files to change'),
             ('## 3. For the lead', r'^##\s*3\.\s*For the lead'), ('## 4. Next steps', r'^##\s*4\.\s*Next steps')]
    n = 0
    for f in sorted(os.listdir(d)):
        fp = os.path.join(d, f)
        if not os.path.isfile(fp) or f in ('README.md', '.gitkeep', '.DS_Store'):
            continue
        n += 1
        m = NAME.match(f)
        if not m:
            emit('W', 'handoff/%s: file name does not match <handle>-T<n>-<MMDD-HHMM>.md' % f)
        txt = read_text(os.path.join('handoff', f)) or ''
        miss = [h for h, rx in HEADS if not re.search(rx, txt, re.M)]
        if miss:
            emit('W', 'handoff/%s is missing sections: %s' % (f, ' / '.join(miss)))
        if m:
            mo, dd, hh, mi = (int(x) for x in m.groups())
            year = now.astimezone(tz).year
            try:
                at = datetime(year, mo, dd, hh, mi, tzinfo=tz).astimezone(UTC)
                if at > now + timedelta(days=1):
                    at = datetime(year - 1, mo, dd, hh, mi, tzinfo=tz).astimezone(UTC)
                age = (now - at).total_seconds() / 3600
                if age > 12:
                    emit('W', 'handoff/%s has been pending for %.0f hours (once the lead has processed it, git mv it to handoff/done/)' % (f, age))
            except ValueError:
                emit('W', 'handoff/%s: invalid date in the file name' % f)
    emit('OK', '%d pending handoff note(s)' % n if n else 'no pending handoff notes at the top level')
else:
    print('E:unknown subcommand %s' % sub)
PY
}

# ---------------------------------------------------------------------------
# Repo root: the repo that contains the cwd (so the script runs in any repo, including the selftest's throwaway repos)
ROOT=$(git rev-parse --show-toplevel 2>/dev/null || true)
CONF_ROOT="${ROOT:-$(cd "$SELF_DIR/.." && pwd)}"
case "$MODE" in
  time|timeraw)
    command -v python3 >/dev/null 2>&1 || { echo "⏰ Now $(date '+%Y-%m-%d %H:%M') (local time) | ⚠️ no python3, cannot compute the countdown"; exit 0; }
    if [ "$MODE" = time ]; then pyhelp time "$CONF_ROOT"; else pyhelp timeraw "$CONF_ROOT"; fi
    exit 0 ;;
esac

# Conf reading convention: grep '^KEY=' | cut -d= -f2- | sed 's/#.*//' | xargs
conf_get() { [ -f "$CONF_ROOT/hackathon.conf" ] && grep -E "^$1=" "$CONF_ROOT/hackathon.conf" | cut -d= -f2- | sed 's/#.*//' | xargs 2>/dev/null; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# ---------------------------------------------------------------------------
# All temp files live in one directory, removed as a whole on exit
WORK=$(mktemp -d "$TMPBASE/check.XXXXXX") || { echo "❌ mktemp failed" >&2; exit 2; }
OUT_BUF="$WORK/out.txt"; : >"$OUT_BUF"
CUR_TEST_PID=""
cleanup() { rm -rf "$WORK"; }
on_signal() {  # when killed by a pre-push timeout, also kill the whole process group of the running test.sh (it is in its own group)
  if [ -n "$CUR_TEST_PID" ]; then
    kill -TERM -- "-$CUR_TEST_PID" 2>/dev/null || kill_tree "$CUR_TEST_PID" TERM
    sleep 0.2
    kill -KILL -- "-$CUR_TEST_PID" 2>/dev/null
  fi
  exit "$1"
}
trap cleanup EXIT
trap 'on_signal 143' TERM
trap 'on_signal 130' INT
trap 'on_signal 129' HUP

say() { printf '%s\n' "$*"; printf '%s\n' "$*" >>"$OUT_BUF"; }
progress() { [ -t 2 ] && printf '  … %s\n' "$*" >&2; return 0; }

N_ERR=0; N_WARN=0; SUMMARY=""
item() {  # item <number> <name> <ok|err|warn> [reason]
  local line
  case "$3" in
    ok) line="[$1] $2 ✅${4:+ $4}" ;;
    err) line="[$1] $2 ❌ ${4:-}"; N_ERR=$((N_ERR + 1)); SUMMARY="$SUMMARY$line"$'\n' ;;
    *) line="[$1] $2 ⚠️ ${4:-}"; N_WARN=$((N_WARN + 1)); SUMMARY="$SUMMARY$line"$'\n' ;;
  esac
  say "$line"
}

# Accumulate within one check: the first reason goes on the check line, every reason goes into the detail lines
reset_item() { IE=""; IW=""; IE_N=0; IW_N=0; ID=""; ID_N=0; ID_HIDDEN=0; ID_EXTRA=0; }
_add_detail() {
  if [ "$ID_N" -lt "$DETAIL_MAX" ]; then ID="$ID    $1"$'\n'; ID_N=$((ID_N + 1)); else ID_HIDDEN=$((ID_HIDDEN + 1)); fi
}
add_e() { IE_N=$((IE_N + 1)); [ -z "$IE" ] && IE="$1"; _add_detail "❌ $1"; }
add_w() { IW_N=$((IW_N + 1)); [ -z "$IW" ] && IW="$1"; _add_detail "⚠️ $1"; }
add_d() { ID_EXTRA=$((ID_EXTRA + 1)); _add_detail "$1"; }
finish_item() {  # finish_item <number> <name> [note when all green]
  local reason
  if [ "$IE_N" -gt 0 ]; then
    reason="$IE"; [ "$IE_N" -gt 1 ] && reason="${reason} ($IE_N ❌ in total)"
    [ "$IW_N" -gt 0 ] && reason="${reason}; plus $IW_N ⚠️"
    item "$1" "$2" err "$reason"
  elif [ "$IW_N" -gt 0 ]; then
    reason="$IW"; [ "$IW_N" -gt 1 ] && reason="${reason} ($IW_N ⚠️ in total)"
    item "$1" "$2" warn "$reason"
  else
    item "$1" "$2" ok "${3:-}"
  fi
  # With a single reason and no extra details, the check line already says it all; do not repeat it
  if [ "$ID_EXTRA" -gt 0 ] || [ $((IE_N + IW_N)) -gt 1 ]; then
    printf '%s' "$ID"; printf '%s' "$ID" >>"$OUT_BUF"
  fi
  [ "$ID_HIDDEN" -gt 0 ] && say "    … $ID_HIDDEN more not shown"
  return 0
}

finish_output() {  # finish_output <log file name>
  say "======== Summary $N_ERR ❌ $N_WARN ⚠️"
  if [ -n "$SUMMARY" ]; then printf '%s' "$SUMMARY"; printf '%s' "$SUMMARY" >>"$OUT_BUF"; fi
  if [ -n "${ROOT:-}" ] && mkdir -p "$ROOT/logs" 2>/dev/null; then cp "$OUT_BUF" "$ROOT/logs/$1" 2>/dev/null; fi
  [ "$N_ERR" -gt 0 ] && exit 1
  exit 0
}

# Fold the python helper's output into one check
py_item() {  # py_item <number> <name> <subcommand>
  local out rc line okmsg=""
  reset_item
  out=$(pyhelp "$3" "$ROOT" 2>&1); rc=$?
  while IFS= read -r line; do
    case "$line" in
      E:*) add_e "${line#E:}" ;;
      W:*) add_w "${line#W:}" ;;
      D:*) add_d "${line#D:}" ;;
      OK:*) okmsg="${line#OK:}" ;;
      *) [ "$rc" -ne 0 ] && [ -n "$line" ] && add_d "$line" ;;
    esac
  done <<<"$out"
  [ "$rc" -ne 0 ] && add_e "the check script itself failed (python exit code ${rc}); this is a bug in check.sh"
  finish_item "$1" "$2" "$okmsg"
}

kill_tree() {  # kill_tree <pid> <signal>: fallback when the process group cannot be signalled
  local c
  for c in $(pgrep -P "$1" 2>/dev/null); do kill_tree "$c" "$2"; done
  kill "-$2" "$1" 2>/dev/null
}

# =====================================================================
# --e2e: live smoke test
# =====================================================================
run_e2e() {
  local url tmp="$WORK/e2e" code rc body n got_index=0
  mkdir -p "$tmp"
  [ -n "$E2E_URL" ] || E2E_URL=$(conf_get DEMO_URL)
  url="${E2E_URL%/}"
  say "🌐 check.sh --e2e ${url:-(no URL)}  ·  $(date '+%Y-%m-%d %H:%M')"
  if [ -z "$url" ]; then
    item E0 "DEMO_URL" err "DEMO_URL is empty in the conf (once deployed, set it in hackathon.conf and at the top of the README; to test another address use --e2e <URL>)"
    finish_output last-e2e.txt
  fi
  if ! command -v curl >/dev/null 2>&1; then
    item E0 "curl" err "curl not found; cannot run the smoke test"; finish_output last-e2e.txt
  fi
  fetch() {  # fetch <path> <output file> → sets code rc
    code=$(curl -sS -m 3 -o "$2" -w '%{http_code}' "$url$1" 2>"$tmp/err"); rc=$?
  }
  why_curl() { [ "$rc" = 28 ] && echo "no response within 3 s" || echo "request failed (curl exit code ${rc}: $(head -n 1 "$tmp/err"))"; }

  fetch "/" "$tmp/index.html"
  if [ "$rc" -ne 0 ]; then item E1 "Home page GET /" err "$(why_curl)"
  elif [ "$code" != 200 ]; then item E1 "Home page GET /" err "HTTP ${code} (expected 200)"
  elif ! grep -q 'data-smoke' "$tmp/index.html"; then item E1 "Home page GET /" err "200, but the page has no data-smoke marker (wrong site deployed?)"; got_index=1
  else item E1 "Home page GET /" ok "200, contains data-smoke"; got_index=1
  fi

  fetch "/api/health" "$tmp/health"
  body=$(head -c 160 "$tmp/health" 2>/dev/null | tr -d '\r\n')
  if [ "$rc" -ne 0 ]; then item E2 "Health check GET /api/health" err "$(why_curl)"
  elif grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' "$tmp/health"; then item E2 "Health check GET /api/health" ok "$body"
  else item E2 "Health check GET /api/health" err "HTTP ${code}, no \"ok\":true in the response (starts with: ${body:-empty})"
  fi

  if [ "$got_index" -eq 1 ]; then
    n=$(grep -Eic 'localhost|127\.0\.0\.1' "$tmp/index.html")
    if [ "${n:-0}" -gt 0 ]; then
      item E3 "No localhost in HTML" err "the home page has $n line(s) referencing localhost / 127.0.0.1 (lines $(grep -Ein 'localhost|127\.0\.0\.1' "$tmp/index.html" | head -n 3 | cut -d: -f1 | tr '\n' ' ' | sed 's/ $//'))"
    else
      item E3 "No localhost in HTML" ok
    fi
  else
    item E3 "No localhost in HTML" err "the home page was not fetched, so it cannot be checked"
  fi
  finish_output last-e2e.txt
}

# =====================================================================
# --selftest: the gate itself must be verified too
# =====================================================================
run_selftest() {
  local T="$WORK/selftest" i=0 total=16 out rc q v
  mkdir -p "$T"
  say "🧪 check.sh --selftest (temp directory ${T}, removed afterwards)"
  gq() { git -c user.name=selftest -c user.email=selftest@example.invalid -c commit.gpgsign=false \
             -c core.hooksPath=/dev/null -c init.defaultBranch=main "$@"; }
  mkrepo() {  # mkrepo <dir>: a clean, all-green minimal repo on main
    local f
    mkdir -p "$1" && cd "$1" || return 1
    gq init -q . && gq symbolic-ref HEAD refs/heads/main
    mkdir -p scripts apps/demo
    cp "$SELF" scripts/check.sh && cp "$SELF_DIR/secret-scan.sh" scripts/secret-scan.sh
    printf 'logs/\n' >.gitignore
    printf 'TZ=Australia/Melbourne\nSTART=\nDEADLINE=\nFEATURE_FREEZE_HOURS=6\nCODE_FREEZE_HOURS=2\nLEAD=lead\nDEPLOYER=lead\nDEMO_URL=\nDEPLOY_MODULES=\n' >hackathon.conf
    printf '# demo\n\nOwner: @alice\n' >apps/demo/README.md
    printf '#!/usr/bin/env bash\necho "1 passed, 0 failed"\n' >apps/demo/test.sh
    chmod +x apps/demo/test.sh
    printf '# README.md\n\n<!-- RULES:BEGIN -->\n1. Rule one\n2. Rule two\n<!-- RULES:END -->\n' >README.md
    gq add -A && gq commit -qm init
  }
  run_case() {  # run_case <description> <expected: green, or a prefix that must appear in the summary block, e.g. "[3] Branch & module boundary ❌"> <repo dir>
    i=$((i + 1))
    out=$(cd "$3" && env -u ALLOW_CROSS -u ALLOW_MAIN -u BRANCH bash scripts/check.sh --quick 2>&1); rc=$?
    local ok=0 why=""
    if ! printf '%s\n' "$out" | grep -q '^======== Summary '; then why="no summary line in the output"
    elif [ "${2#warn:}" != "$2" ]; then   # warn:<text>: no ❌ allowed, and this ⚠️ text must appear in the summary block
      if [ "$rc" -eq 0 ] && printf '%s\n' "$out" | sed -n '/^======== Summary/,$p' | grep -qF "${2#warn:}"; then ok=1
      else why="expected no ❌ and '${2#warn:}' in the summary block; exit code was ${rc}"; fi
    elif [ "$2" = green ]; then
      [ "$rc" -eq 0 ] && ok=1 || why="expected no ❌, exit code was ${rc}: $(printf '%s\n' "$out" | grep -E '^\[[0-9]\] .*❌' | head -n 1)"
    else
      if [ "$rc" -eq 1 ] && printf '%s\n' "$out" | sed -n '/^======== Summary/,$p' | grep -qF "$2"; then ok=1
      else why="expected '$2' in the summary block; exit code was $rc"; fi
    fi
    if [ -n "${FAKE_KEY:-}" ] && { printf '%s\n' "$out" | grep -qF "$FAKE_KEY" || grep -qF "$FAKE_KEY" "$3/logs/last-check.txt" 2>/dev/null; }; then
      ok=0; why="the key value appears in the output or in logs/last-check.txt!"
    fi
    if [ "$ok" -eq 1 ]; then item "S$i" "$1" ok
    else item "S$i" "$1" err "$why"; printf '%s\n' "$out" | sed 's/^/      │ /' | tail -n 25
    fi
  }
  FAKE_KEY=""
  ( mkrepo "$T/green" && gq checkout -q -b alice/demo/T1-ok && echo "x" >>apps/demo/README.md ) >/dev/null 2>&1
  run_case "Baseline: module branch changes only its own module → all green" green "$T/green"

  ( mkrepo "$T/main" && echo "x" >>apps/demo/README.md ) >/dev/null 2>&1
  run_case "Direct push to main: changes on main → [3] ❌" "[3] Branch & module boundary ❌ changes on main" "$T/main"

  # The fake key is assembled at run time so the full string never appears in this file (a full scan would flag it)
  FAKE_KEY="AKIA""$(printf 'Z%.0s' 1 2 3 4 5 6 7 8)SELFTEST"
  ( mkrepo "$T/key" && gq checkout -q -b alice/demo/T2-key && printf 'const k = "%s";\n' "$FAKE_KEY" >apps/demo/config.js ) >/dev/null 2>&1
  run_case "Fake key: AKIA… in a module file → [1] ❌, value not echoed" "[1] Secret scan ❌ found" "$T/key"
  FAKE_KEY=""

  ( mkrepo "$T/cross" && gq checkout -q -b alice/demo/T3-cross && mkdir -p apps/other && echo x >apps/other/x.txt &&
    gq add -A && gq commit -qm cross ) >/dev/null 2>&1
  run_case "Cross-module: demo branch changes apps/other/ → [3] ❌" "[3] Branch & module boundary ❌ 1 file(s) outside module demo" "$T/cross"

  ( mkrepo "$T/crash" && gq checkout -q -b alice/demo/T4-crash &&
    printf '#!/usr/bin/env bash\necho "3 passed, 0 failed"\nexit 3\n' >apps/demo/test.sh ) >/dev/null 2>&1
  run_case "Crashing test: green count line but exit code 3 → [5] ❌" "[5] Module tests ❌ 1/1 test.sh failed: apps/demo" "$T/crash"

  ( mkrepo "$T/nocount" && gq checkout -q -b alice/demo/T5-nocount &&
    printf '#!/usr/bin/env bash\necho "looks fine"\n' >apps/demo/test.sh ) >/dev/null 2>&1
  run_case "No count line: exit code 0 but no 'N passed, M failed' → [5] ❌" "[5] Module tests ❌ 1/1 test.sh failed: apps/demo" "$T/nocount"

  ( mkrepo "$T/badname" && gq checkout -q -b fix-readme && echo "x" >>apps/demo/README.md ) >/dev/null 2>&1
  run_case "Non-conforming branch name: changes on fix-readme → [3] ❌" "[3] Branch & module boundary ❌ branch name fix-readme does not match" "$T/badname"

  ( mkrepo "$T/rules" && gq checkout -q -b lead/rules &&
    printf '# README.md\n\n1. Rule one\n2. Rule two\n' >README.md ) >/dev/null 2>&1
  run_case "Missing RULES markers: README.md without BEGIN/END → [7] ❌" "[7] RULES block ❌ README.md is missing" "$T/rules"

  # docs/decisions.md and docs/pitfalls.md are append-only on module branches: deleting a line is ❌
  ( mkrepo "$T/append" && mkdir -p docs && printf '# Decisions\n\n- one\n- two\n' >docs/decisions.md &&
    gq add -A && gq commit -qm log && gq checkout -q -b alice/demo/T6-log && printf '# Decisions\n\n- one\n' >docs/decisions.md ) >/dev/null 2>&1
  run_case "Append-only log: module branch deletes a line from docs/decisions.md → [3] ❌" "[3] Branch & module boundary ❌ docs/decisions.md: 1 line(s) deleted" "$T/append"

  # Five forms, one per line: a literal Bearer value, hf_, gsk_, xai-, r8_; values are assembled at run time and never appear in full in this file
  q=$(printf 'Q%.0s' $(seq 1 44)); FAKE_KEY="selftest$q"
  ( mkrepo "$T/keys" && gq checkout -q -b alice/demo/T7-keys &&
    printf 'curl -H "Authorization: Bearer %s" https://api.example.com\nhf: %s\ngroq: %s\nxai: %s\nreplicate: %s\n' \
      "$FAKE_KEY" "hf_$q" "gsk_$q" "xai-$q" "r8_$q" >apps/demo/notes.md ) >/dev/null 2>&1
  run_case "Keys in a module file (Bearer / hf_ / gsk_ / xai- / r8_) → [1] ❌ 5 hits, values not echoed" "[1] Secret scan ❌ found 5 potential" "$T/keys"
  FAKE_KEY=""

  # The reverse: a Bearer with only a variable name / placeholder is not a false positive; a capitalised handle is a valid branch name
  ( mkrepo "$T/placeholders" && gq checkout -q -b Alice/demo/T8-env &&
    printf 'curl -H "Authorization: Bearer CLOUDFLARE_API_TOKEN"\ncurl -H "Authorization: Bearer YOUR-OPENROUTER-API-KEY"\ncurl -H "Authorization: Bearer $DEEPSEEK_API_KEY"\napi_key: CLOUDFLARE_API_TOKEN\n' \
      >apps/demo/qwen2.5.md ) >/dev/null 2>&1
  run_case "Placeholders: branch Alice/, Bearer with only variable names → all green" green "$T/placeholders"

  # Keys without a fixed prefix after a label (full-width colon, …_SECRET_KEY=), plus pplx- and JWT: one per line
  # (\357\274\232 is the UTF-8 encoding of the full-width colon U+FF1A)
  v=$(printf 'Ab3%.0s' $(seq 1 11)); FAKE_KEY="$v"
  ( mkrepo "$T/keys2" && gq checkout -q -b alice/demo/T9-keys &&
    printf -- '- API Key\357\274\232%s\nQIANFAN_SECRET_KEY=%s\npplx: %s\njwt: %s\n' "$v" "$v" "pplx-$q" "eyJ$v.eyJ$v.$v" \
      >apps/demo/notes.md ) >/dev/null 2>&1
  run_case "Labelled keys: API Key + full-width colon / …_SECRET_KEY= / pplx- / JWT → [1] ❌ 4 hits, values not echoed" "[1] Secret scan ❌ found 4 potential" "$T/keys2"
  FAKE_KEY=""

  # Size limits: .json data files under apps/<module>/public/ 2MB, everything else 1MB (D-0929-1430)
  ( mkrepo "$T/data" && gq checkout -q -b alice/demo/T10-data && mkdir -p apps/demo/public &&
    head -c 1572864 /dev/zero | tr '\0' '1' >apps/demo/public/big.json && gq add apps/demo/public/big.json ) >/dev/null 2>&1
  run_case "Data file: apps/demo/public/big.json 1.5MB → all green (2MB limit)" green "$T/data"

  ( mkrepo "$T/big" && gq checkout -q -b alice/demo/T11-big &&
    head -c 1572864 /dev/zero | tr '\0' '1' >apps/demo/big.txt && gq add apps/demo/big.txt ) >/dev/null 2>&1
  run_case "Large file: apps/demo/big.txt 1.5MB → [6] ❌ (1MB limit for non-data files)" "[6] Repo hygiene ❌" "$T/big"

  # Pitch PDFs: .pdf files under docs/hackathon/pitch/ have a 10MB limit (D-0930-0116); a lead/ branch may write outside apps/
  ( mkrepo "$T/pdf" && gq checkout -q -b lead/pitch-pdf && mkdir -p docs/hackathon/pitch &&
    head -c 3145728 /dev/zero | tr '\0' '1' >docs/hackathon/pitch/deck.pdf && gq add docs/hackathon/pitch/deck.pdf ) >/dev/null 2>&1
  run_case "Pitch PDF: docs/hackathon/pitch/deck.pdf 3MB → all green (10MB limit)" green "$T/pdf"

  # $var directly followed by a full-width character crashes macOS bash ($mod followed by a full-width comma is read as the
  # variable mod\xEF), so check [6] must warn; the comma is written as the octal escape \357\274\214 so this file never contains the pattern
  ( mkrepo "$T/utf8var" && gq checkout -q -b alice/demo/T12-utf8 &&
    printf '#!/usr/bin/env bash\nx=1\necho "value $x\357\274\214ok"\necho "1 passed, 0 failed"\n' >apps/demo/test.sh ) >/dev/null 2>&1
  run_case "\$var directly followed by a full-width character in a shell file → [6] ⚠️ suggests \${var}" "warn:[6] Repo hygiene ⚠️ apps/demo/test.sh:3" "$T/utf8var"

  [ "$i" -eq "$total" ] || item S0 "Scenario count" err "ran $i scenarios, expected $total"
  ROOT=""   # the selftest must not overwrite the real repo's logs/last-check.txt
  finish_output last-check.txt
}

case "$MODE" in
  selftest) run_selftest ;;
  e2e) run_e2e ;;
esac

if [ -z "$ROOT" ]; then
  say "[0] Repo ❌ the current directory is not inside a git repo (cd into the repo and run again)"
  say "======== Summary 1 ❌ 0 ⚠️"
  say "[0] Repo ❌ the current directory is not inside a git repo"
  exit 2
fi
cd "$ROOT" || exit 2
if ! command -v python3 >/dev/null 2>&1; then
  say "[0] Environment ❌ python3 not found (≥3.9 required; bash scripts/setup.sh tells you how to install it)"
  say "======== Summary 1 ❌ 0 ⚠️"
  say "[0] Environment ❌ python3 not found"
  exit 1
fi

# =====================================================================
# Shared state: branch, base, set of changed files
# =====================================================================
HAS_HEAD=0; g rev-parse -q --verify HEAD >/dev/null 2>&1 && HAS_HEAD=1
BRANCH_NAME="${BRANCH:-}"
[ -n "$BRANCH_NAME" ] || BRANCH_NAME=$(g symbolic-ref --short -q HEAD 2>/dev/null || true)
# Branches pushed from Claude Code cloud sessions carry a claude/ prefix (claude/<handle>/<module>/T<n>-<slug>); strip it before matching
BRANCH_NAME="${BRANCH_NAME#claude/}"

BASE=""; BASE_NOTE=""
if [ -n "$BASE_ARG" ]; then
  if g rev-parse -q --verify "$BASE_ARG^{commit}" >/dev/null 2>&1; then BASE="$BASE_ARG"
  else BASE_NOTE="--base $BASE_ARG does not exist"; fi
else
  if g rev-parse -q --verify "refs/remotes/origin/main^{commit}" >/dev/null 2>&1; then BASE="origin/main"
  elif g rev-parse -q --verify "refs/heads/main^{commit}" >/dev/null 2>&1; then BASE="main"
  else BASE_NOTE="neither origin/main nor main exists"; fi
fi
MB=""
if [ -n "$BASE" ] && [ "$HAS_HEAD" -eq 1 ]; then
  MB=$(g merge-base "$BASE" HEAD 2>/dev/null || true)
  [ -n "$MB" ] || BASE_NOTE="$BASE and HEAD have no common ancestor"
elif [ "$HAS_HEAD" -eq 0 ]; then
  BASE_NOTE="no commits yet"
fi

CHANGED_FILE="$WORK/changed.txt"
{
  [ -n "$MB" ] && g diff --name-only --no-renames "$MB" HEAD
  if [ "$HAS_HEAD" -eq 1 ]; then g diff --name-only --no-renames HEAD; else g ls-files; fi
  g ls-files --others --exclude-standard
} 2>/dev/null | sed '/^$/d' | sort -u >"$CHANGED_FILE"
N_CHANGED=$(wc -l <"$CHANGED_FILE" | tr -d ' ')

if [ -n "$MB" ]; then BASE_SHOW="$BASE"; else BASE_SHOW="none (${BASE_NOTE})"; fi
say "🔍 check.sh ($([ "$MODE" = quick ] && echo quick --quick || echo full)) · $(basename "$ROOT") · branch ${BRANCH_NAME:-(detached)} · base $BASE_SHOW · $N_CHANGED changed file(s) · $(date '+%Y-%m-%d %H:%M')"

# =====================================================================
# [1] Secret scan
# =====================================================================
check_1() {
  local scan="$SELF_DIR/secret-scan.sh" out rc n f
  reset_item
  if [ ! -f "$scan" ]; then add_e "$scan not found"; finish_item 1 "Secret scan"; return; fi
  if [ "$MODE" = quick ]; then
    set --
    while IFS= read -r f; do [ -f "$f" ] && set -- "$@" "$f"; done <"$CHANGED_FILE"
    if [ $# -eq 0 ]; then finish_item 1 "Secret scan" "no changed files to scan (--quick)"; return; fi
    out=$(bash "$scan" --files "$@" 2>/dev/null); rc=$?
  else
    out=$(bash "$scan" --all 2>/dev/null); rc=$?
  fi
  if [ "$rc" -eq 0 ]; then
    finish_item 1 "Secret scan" "$([ "$MODE" = quick ] && echo "scanned $# changed file(s)" || echo "all files")"
  elif [ "$rc" -eq 1 ]; then
    n=$(printf '%s\n' "$out" | grep -c .)
    IE="found $n potential secret(s) (locations only, values not printed): move the values into .env / .dev.vars; if a key ever entered history, rotate it first (a human does this), then discuss cleanup"; IE_N=1
    while IFS= read -r f; do [ -n "$f" ] && add_d "$f"; done <<<"$out"
    finish_item 1 "Secret scan"
  else
    add_e "secret-scan.sh itself failed (exit code ${rc})"; finish_item 1 "Secret scan"
  fi
}

# =====================================================================
# [2] Secret files tracked
# =====================================================================
check_2() {
  local f base
  reset_item
  while IFS= read -r f; do
    base=${f##*/}
    case "$base" in
      *.example) ;;
      .env|.env.*|.dev.vars|.dev.vars.*|settings.local.json|keys.json|credentials*.json|*.pem|*.key)
        add_e "$f is tracked by git (git rm --cached '$f'; make sure .gitignore covers it; if the value ever entered history, rotate it first)" ;;
    esac
  done < <(g ls-files 2>/dev/null)
  finish_item 2 "Secret files tracked"
}

# =====================================================================
# [3] Branch & module boundary
# =====================================================================
check_3() {
  local name="Branch & module boundary" re='^([A-Za-z0-9][A-Za-z0-9-]*)/([a-z][a-z0-9-]*)/T([0-9]+)-.+$'
  local mod f ref ref_short del out_n=0 out_list="" me lead backup example
  reset_item
  if [ "$HAS_HEAD" -eq 0 ]; then
    add_w "no commits yet; boundary check skipped (the lead makes the first commit on main)"; finish_item 3 "$name"; return
  fi
  if [ -z "$BRANCH_NAME" ]; then
    add_w "detached HEAD (no branch name); boundary check skipped; in CI, set BRANCH in the workflow"; finish_item 3 "$name"; return
  fi
  me="${GITHUB_ACTOR:-$(git config hack.me 2>/dev/null || true)}"
  case "$BRANCH_NAME" in
    main|master)
      if [ "$N_CHANGED" -gt 0 ]; then
        if [ "${ALLOW_MAIN:-}" = 1 ]; then add_w "changes on $BRANCH_NAME ($N_CHANGED file(s)), allowed by ALLOW_MAIN=1 (give the reason in the commit message)"
        else add_e "changes on $BRANCH_NAME ($N_CHANGED file(s)): create a branch first, git switch -c <handle>/<module>/T<n>-<slug> (the lead uses lead/<slug>)"; fi
        while IFS= read -r f; do add_d "$f"; done <"$CHANGED_FILE"
      fi
      [ -z "$MB" ] && add_w "no base (${BASE_NOTE}); only working-tree changes were checked"
      finish_item 3 "$name" "on $BRANCH_NAME, no changes"; return ;;
    lead/*)
      # Warn only, never block: in CI GITHUB_ACTOR may be a bot, and blocking would misfire
      lead=$(conf_get LEAD); backup=$(conf_get BACKUP_LEAD)
      if [ -z "$lead" ]; then add_w "LEAD in hackathon.conf is empty; cannot verify identity on lead/* branches"
      elif [ -z "$me" ]; then add_w "lead/* is for the lead only: cannot tell who you are (git config hack.me is empty), LEAD=@$lead"
      elif [ "$(lower "$me")" != "$(lower "$lead")" ] && { [ -z "$backup" ] || [ "$(lower "$me")" != "$(lower "$backup")" ]; }; then
        add_w "lead/* is for the lead only: you are @${me}, LEAD=@$lead${backup:+, BACKUP_LEAD=@$backup} (team members use <handle>/<module>/T<n>-<slug>)"
      fi
      finish_item 3 "$name" "$BRANCH_NAME is a lead branch (@${me}); the whole repo is writable"; return ;;
  esac
  if [[ ! "$BRANCH_NAME" =~ $re ]]; then
    example="git branch -m ${me:-<handle>}/<module>/T<n>-<slug> (e.g. git branch -m ${me:-alice}/web/T3-login)"
    if [ "$N_CHANGED" -eq 0 ]; then
      add_w "branch name $BRANCH_NAME does not match <handle>/<module>/T<n>-<slug> (no changes yet); rename it: $example"
    elif [ "${ALLOW_CROSS:-}" = 1 ]; then
      add_w "branch name $BRANCH_NAME does not match <handle>/<module>/T<n>-<slug>; allowed by ALLOW_CROSS=1 ($N_CHANGED change(s) not checked against a module)"
    else
      add_e "branch name $BRANCH_NAME does not match <handle>/<module>/T<n>-<slug>, so no module can be inferred and $N_CHANGED change(s) cannot be checked: $example"
    fi
    finish_item 3 "$name"; return
  fi
  mod="${BASH_REMATCH[2]}"
  [ -z "$MB" ] && add_w "no base (${BASE_NOTE}); only working-tree changes were checked"
  ref="${MB:-HEAD}"; ref_short=$(g rev-parse --short "$ref" 2>/dev/null || echo "$ref")
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    case "$f" in
      apps/"$mod"/*) ;;
      docs/decisions.md|docs/pitfalls.md)
        del=$(g diff --numstat "$ref" -- "$f" 2>/dev/null | awk '{ if ($2 ~ /^[0-9]+$/) s += $2 } END { print s + 0 }')
        [ "$del" -gt 0 ] && add_e "$f: $del line(s) deleted (append-only; see which with git diff $ref_short -- $f and restore them)" ;;
      *) out_n=$((out_n + 1)); out_list="$out_list$f"$'\n' ;;
    esac
  done <"$CHANGED_FILE"
  if [ "$out_n" -gt 0 ]; then
    if [ "${ALLOW_CROSS:-}" = 1 ]; then
      add_w "ALLOW_CROSS=1 allows $out_n cross-module file(s) (outside module ${mod})"
    else
      add_e "$out_n file(s) outside module ${mod}'s writable scope (apps/$mod/, plus append-only docs/decisions.md and docs/pitfalls.md): move them back into your module; for an agreed cross-module change, run ALLOW_CROSS=1 git push and add the cross-module label to the PR"
    fi
    while IFS= read -r f; do [ -n "$f" ] && add_d "outside: $f"; done <<<"$out_list"
  fi
  finish_item 3 "$name" "$BRANCH_NAME → module ${mod}; all $N_CHANGED change(s) in scope"
}

# =====================================================================
# [4] Module structure
# =====================================================================
is_exec() {  # tracked files: use the mode in git; untracked files: use the filesystem
  local mode
  mode=$(g ls-files -s -- "$1" 2>/dev/null | awk '{print $1}' | head -n 1)
  if [ -n "$mode" ]; then [ "$mode" = 100755 ]; else [ -x "$1" ]; fi
}
check_4() {
  local d m n=0 owner
  reset_item
  for d in apps/*/; do
    [ -d "$d" ] || continue
    m=${d%/}; n=$((n + 1))
    if [ ! -f "$m/README.md" ]; then add_e "$m has no README.md (it needs an Owner: @handle line)"
    else
      owner=$(grep -m 1 'Owner:' "$m/README.md" 2>/dev/null || true)
      if [ -z "$owner" ]; then add_e "$m/README.md has no Owner: line"
      # The first alternative is the "fill me in" placeholder from the original (Chinese) module template
      elif printf '%s' "$owner" | grep -Eq '<填我>|<handle>|Owner:[*[:space:]]*$'; then add_w "$m/README.md: Owner is still a placeholder"; fi
    fi
    if [ ! -f "$m/test.sh" ]; then add_e "$m has no test.sh (its last line must print N passed, M failed)"
    elif ! is_exec "$m/test.sh"; then add_e "$m/test.sh is not executable (chmod +x $m/test.sh && git add $m/test.sh)"; fi
  done
  finish_item 4 "Module structure" "$([ "$n" -gt 0 ] && echo "all $n modules under apps/ are complete" || echo "no modules under apps/ yet")"
}

# =====================================================================
# [5] Module tests (time limit per test; a non-zero exit code or a last line without a count is ❌)
# =====================================================================
run_test() {  # run_test <path/test.sh> → sets T_OK T_LAST T_WHY T_P T_LOG T_LEFTOVER
  local t="$1" log pid ticks=0 limit rc timed_out=0 f
  log="logs/test-$(printf '%s' "${t%/test.sh}" | tr '/' '-').txt"
  mkdir -p logs 2>/dev/null
  progress "running ${t} (limit ${TEST_TIMEOUT}s)"
  set -m   # put test.sh in its own process group: on timeout / signal the whole group is killed, including node and background processes it started
  MOCK="${MOCK:-1}" bash "$t" >"$log" 2>&1 </dev/null &
  pid=$!
  set +m
  CUR_TEST_PID=$pid
  limit=$((TEST_TIMEOUT * 5))
  while kill -0 "$pid" 2>/dev/null; do
    if [ "$ticks" -ge "$limit" ]; then
      timed_out=1
      kill -TERM -- "-$pid" 2>/dev/null || kill_tree "$pid" TERM
      sleep 1
      kill -KILL -- "-$pid" 2>/dev/null || kill_tree "$pid" KILL
      break
    fi
    sleep 0.2; ticks=$((ticks + 1))
  done
  wait "$pid" 2>/dev/null; rc=$?
  # Always clean up the process group once: test.sh has exited, but background processes it left behind (an & without wait) are still in the group
  T_LEFTOVER=0
  if kill -TERM -- "-$pid" 2>/dev/null; then
    T_LEFTOVER=1; sleep 0.2; kill -KILL -- "-$pid" 2>/dev/null
  fi
  CUR_TEST_PID=""
  T_LAST=$(sed '/^[[:space:]]*$/d' "$log" | tail -n 1 | tr -d '\r' | cut -c 1-300)
  T_OK=0; T_P=0; T_WHY=""
  if [ "$timed_out" -eq 1 ]; then T_WHY="timed out (>${TEST_TIMEOUT}s; the whole process group was killed)"
  elif ! printf '%s\n' "$T_LAST" | grep -Eq '[0-9]+ passed, [0-9]+ failed'; then T_WHY="the last line has no 'N passed, M failed' (exit code ${rc}; it probably crashed)"
  else
    T_P=$(printf '%s\n' "$T_LAST" | grep -oE '[0-9]+ passed' | head -n 1 | grep -oE '[0-9]+')
    f=$(printf '%s\n' "$T_LAST" | grep -oE '[0-9]+ failed' | head -n 1 | grep -oE '[0-9]+')
    if [ "$rc" -ne 0 ]; then T_WHY="exit code $rc"
    elif [ "${f:-0}" -gt 0 ]; then T_WHY="$f failure(s) but exit code 0 (the test.sh breaks the contract)"
    else T_OK=1; fi
  fi
  T_LOG="$log"
}
check_5() {
  local t m all="" run="" n_all=0 n_run=0 n_fail=0 total_p=0 failed_mods=""
  reset_item
  [ -n "$TIMEOUT_NOTE" ] && add_w "$TIMEOUT_NOTE"
  for t in apps/*/test.sh; do
    [ -f "$t" ] || continue
    all="$all$t"$'\n'; n_all=$((n_all + 1))
  done
  if [ "$n_all" -eq 0 ]; then add_w "no apps/*/test.sh found"; finish_item 5 "Module tests"; return; fi
  if [ "$MODE" = quick ] && [ -n "$MB" ]; then
    while IFS= read -r t; do
      [ -n "$t" ] || continue
      m="${t%/test.sh}/"
      grep -q "^$m" "$CHANGED_FILE" && run="$run$t"$'\n'
    done <<<"$all"
  else
    run="$all"
  fi
  while IFS= read -r t; do
    [ -n "$t" ] || continue
    n_run=$((n_run + 1))
    run_test "$t"
    if [ "$T_OK" -eq 1 ]; then
      total_p=$((total_p + ${T_P:-0}))
      add_d "✅ $t → $T_LAST"
    else
      n_fail=$((n_fail + 1)); failed_mods="$failed_mods${failed_mods:+, }${t%/test.sh}"
      add_d "❌ $t → ${T_LAST:-(no output at all)}"
      add_d "   $T_WHY · full log $T_LOG"
    fi
    [ "$T_LEFTOVER" -eq 1 ] && add_w "${t%/test.sh}/test.sh left background processes behind; cleaned up (wait for or kill anything started with & in test.sh)"
  done <<<"$run"
  if [ "$n_run" -eq 0 ]; then
    finish_item 5 "Module tests" "no modules changed relative to $BASE; skipped (for a full run: bash scripts/check.sh)"; return
  fi
  if [ "$n_fail" -gt 0 ]; then
    IE="$n_fail/$n_run test.sh failed: $failed_mods"; IE_N=1
  fi
  finish_item 5 "Module tests" "all $n_run test.sh passed ($total_p passed in total, ${TEST_TIMEOUT}s limit each)$([ "$n_run" -lt "$n_all" ] && echo "; --quick skipped $((n_all - n_run)) unchanged")"
}

# =====================================================================
check_1
check_2
check_3
check_4
check_5
py_item 6 "Repo hygiene" hygiene
py_item 7 "RULES block" rules
py_item 8 "Handoff notes" handoff
py_item 9 "hackathon.conf" conf
finish_output last-check.txt
