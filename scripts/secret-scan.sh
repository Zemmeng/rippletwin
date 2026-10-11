#!/usr/bin/env bash
# secret-scan.sh: secret scanner (shared by .githooks/pre-commit and scripts/check.sh [1])
#
# Purpose: find likely keys / tokens / private keys in the repo. Reports locations only; never prints the matched value.
# Usage:
#   bash scripts/secret-scan.sh                  same as --all
#   bash scripts/secret-scan.sh --all            all tracked files plus untracked, non-ignored files (reads the working tree)
#   bash scripts/secret-scan.sh --staged         only the staged content about to be committed (used by pre-commit)
#   bash scripts/secret-scan.sh --history        every line ever added in git history (run this before making a repo public)
#   bash scripts/secret-scan.sh --files <path>…  only the given working-tree files (used by check.sh --quick)
# Output: one line per hit, "file:line:pattern"; --history prints "commit:file:pattern". Explanations go to stderr.
# Exit codes: 0 = no hits; 1 = hits; 2 = usage error / not inside a git repo / no python3
#
# Patterns covered (to change them, edit PATTERNS below): AWS AKIA…, OpenAI-style sk-…, Anthropic sk-ant-…,
#   GitHub gh[pous]_… / github_pat_…, Google AIza…, Slack xox[bpa]-…, PEM private key headers, Volcano Engine Ark ark-…,
#   Hugging Face hf_…, Groq gsk_…, xAI xai-…, Replicate r8_…, Perplexity pplx-…, NVIDIA nvapi-…, Fireworks fw_…,
#   Together tgp_v1_…, Zhipu <32 hex chars>.<16 chars>, JWT eyJ….eyJ….…, a literal value after Bearer in a request header
#   (<≥20 chars>; common in curl examples), api key|secret key|access key|token|secret|password|passwd or an all-caps
#   …_KEY / …_SK assigned a ≥20-char string with =, : or a full-width colon, and password|passwd|secret assigned a quoted
#   ≥12-char string (references such as ${…}, process.env and env. do not count).
# The whitelist is judged per matched span, not per line (a line that also contains <br/> or __CONFIG__ is still caught):
#   a value that contains xxx / your_ / your-, is wrapped entirely in <…> (e.g. <sk-your-key>), is a __NAME__ placeholder,
#   or is an all-caps environment variable name (e.g. Bearer CLOUDFLARE_API_TOKEN) is allowed;
#   *.example files are skipped entirely, and so is this file.
set -uo pipefail

usage() { awk 'NR==1{next} /^#/{sub(/^# ?/,"");print;next} {exit}' "$0"; }

MODE="all"
case "${1:-}" in
  ""|--all) MODE="all" ;;
  --staged) MODE="staged" ;;
  --history) MODE="history" ;;
  --files) MODE="files"; shift ;;
  -h|--help) usage; exit 0 ;;
  *) echo "❌ Unknown argument: $1 (see --help)" >&2; exit 2 ;;
esac
[ "$MODE" = "files" ] || { [ $# -gt 0 ] && shift; }
[ "$MODE" = "files" ] || [ $# -eq 0 ] || { echo "❌ Unexpected extra arguments: $*" >&2; exit 2; }

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "❌ Not inside a git repo" >&2; exit 2; }
command -v python3 >/dev/null 2>&1 || { echo "❌ python3 (≥3.9) is required" >&2; exit 2; }

# files mode: turn paths relative to the cwd into paths relative to the repo root
PREFIX=$(git rev-parse --show-prefix 2>/dev/null)
cd "$ROOT" || exit 2

scan() {
python3 - "$MODE" "$PREFIX" "$@" <<'PY'
import os, re, subprocess, sys

mode, prefix, args = sys.argv[1], sys.argv[2], sys.argv[3:]
SELF = 'scripts/secret-scan.sh'
MAX_BYTES = 5 * 1024 * 1024  # files over 5MB are not scanned (check [6] handles large files)

# (pattern name, regex, number of the group that holds the value). Every pattern that matches a line is listed; sk-ant- is not also counted as sk-
PATTERNS = [
    ('aws_access_key', re.compile(r'(?<![0-9A-Z])AKIA[0-9A-Z]{16}(?![0-9A-Z])'), 0),
    ('anthropic_key', re.compile(r'(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{10,}'), 0),
    ('openai_style_key', re.compile(r'(?<![A-Za-z0-9_-])sk-(?!ant-)[A-Za-z0-9_-]{20,}'), 0),
    ('github_token', re.compile(r'(?<![A-Za-z0-9_])gh[pous]_[A-Za-z0-9]{30,}'), 0),
    ('github_pat', re.compile(r'(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{40,}'), 0),
    ('google_api_key', re.compile(r'(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{30,}'), 0),
    ('slack_token', re.compile(r'(?<![A-Za-z0-9])xox[bpa]-[A-Za-z0-9-]{10,}'), 0),
    ('private_key', re.compile(r'-----BEGIN ([A-Z]+ )?PRIVATE KEY-----'), 0),
    ('ark_key', re.compile(r'(?<![A-Za-z0-9_-])ark-[0-9a-f-]{30,}'), 0),
    ('huggingface_token', re.compile(r'(?<![A-Za-z0-9_])hf_[A-Za-z0-9]{30,}'), 0),
    ('groq_key', re.compile(r'(?<![A-Za-z0-9_])gsk_[A-Za-z0-9]{40,}'), 0),
    ('xai_key', re.compile(r'(?<![A-Za-z0-9_-])xai-[A-Za-z0-9]{40,}'), 0),
    ('replicate_token', re.compile(r'(?<![A-Za-z0-9_])r8_[A-Za-z0-9]{30,}'), 0),
    ('perplexity_key', re.compile(r'(?<![A-Za-z0-9_-])pplx-[A-Za-z0-9]{40,}'), 0),
    ('nvidia_key', re.compile(r'(?<![A-Za-z0-9_-])nvapi-[A-Za-z0-9_-]{40,}'), 0),
    ('fireworks_key', re.compile(r'(?<![A-Za-z0-9_])fw_[A-Za-z0-9]{20,}'), 0),
    ('together_key', re.compile(r'(?<![A-Za-z0-9_])tgp_v1_[A-Za-z0-9_-]{30,}'), 0),
    ('zhipu_key', re.compile(r'(?<![A-Za-z0-9])[0-9a-f]{32}\.[A-Za-z0-9]{16}(?![A-Za-z0-9])'), 0),
    ('jwt', re.compile(r'(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'), 0),
    # A literal value in a request header: Bearer $VAR / Bearer ${…} / Bearer <your-key> do not count (the character class has no $ { <)
    ('bearer_token', re.compile(r'(?i)(?<![A-Za-z0-9_])Bearer\s+([A-Za-z0-9._~+/=-]{20,})'), 1),
    # Generic assignment: KEY=…, "token": "…", password: '…', API Key + full-width colon …, QIANFAN_SK=…; a value directly followed by ( is a function call and does not count
    # …_KEY / …_SK match upper case only (lower-case field names such as message_key: do not count)
    ('generic_secret_assignment', re.compile(
        r'(?i)(?:api[_\s-]?key|secret(?:[_-]?(?:access[_-]?)?key)?|access[_-]?key|(?-i:[_-](?:KEY|SK))|token|password|passwd)'
        r'[\'"]?\s*[:=：]\s*[\'"]?'
        r'([A-Za-z0-9_\-]{20,})(?![A-Za-z0-9_\-]*\()'), 1),
    # Looser rule for passwords: any ≥12 non-whitespace, non-quote characters inside quotes
    ('password_assignment', re.compile(
        r'(?i)(?:password|passwd|secret)[\'"]?\s*[:=]\s*([\'"])([^\s\'"]{12,})\1'), 2),
]

PLACEHOLDER_IN_VALUE = re.compile(r'(?i)xxx|your[_-]')
ENV_NAME = re.compile(r'^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$')  # only a variable name (CLOUDFLARE_API_TOKEN), not a value
DUNDER = re.compile(r'^__[A-Z_]+__$')
REFERENCE = re.compile(r'^\$\{|^\$[A-Z_]|process\.env|^env\.|os\.environ|import\.meta\.env')


def enclosed_in_angle(line, start, end):
    """The matched span is wrapped entirely in one pair of <…> that contains no whitespace / = / quotes (<sk-your-key> counts; <img src="…key…"> does not)."""
    lt = line.rfind('<', 0, start)
    if lt < 0 or line.rfind('>', 0, start) > lt:
        return False
    gt = line.find('>', end)
    if gt < 0 or 0 <= line.find('<', end) < gt:
        return False
    inner = line[lt + 1:gt]
    return not re.search(r'[\s="\']', inner)


def whitelisted_match(line, m, grp):
    value = m.group(grp)
    if PLACEHOLDER_IN_VALUE.search(value) or DUNDER.match(value) or REFERENCE.search(value) or ENV_NAME.match(value):
        return True
    return enclosed_in_angle(line, m.start(grp), m.end(grp))


def whitelisted_path(path):
    return path.endswith('.example') or path == SELF


def hits_in_line(line):
    names = []
    for name, rx, grp in PATTERNS:
        if any(not whitelisted_match(line, m, grp) for m in rx.finditer(line)):
            names.append(name)
    if 'generic_secret_assignment' in names and 'password_assignment' in names:
        names.remove('password_assignment')  # do not report the same value twice
    if 'bearer_token' in names and len(names) > 1:
        names.remove('bearer_token')  # Bearer sk-… is already reported by the specific pattern
    return names


def git(*a):
    return subprocess.run(['git', '-c', 'core.quotePath=false'] + list(a),
                          stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout


def zsplit(b):
    return [p.decode('utf-8', 'surrogateescape') for p in b.split(b'\0') if p]


found = 0


def report(loc, name):
    global found
    found += 1
    print('%s:%s' % (loc, name))


def scan_bytes(path, data):
    if whitelisted_path(path) or len(data) > MAX_BYTES or b'\0' in data[:8000]:
        return
    text = data.decode('utf-8', 'replace')
    for no, line in enumerate(text.splitlines(), 1):
        for name in hits_in_line(line):
            report('%s:%d' % (path, no), name)


def scan_worktree(paths):
    seen = set()
    for p in paths:
        p = os.path.normpath(p)
        if p in seen or p.startswith('..'):
            continue
        seen.add(p)
        if os.path.islink(p) or not os.path.isfile(p):
            continue
        try:
            with open(p, 'rb') as f:
                data = f.read(MAX_BYTES + 1)
        except OSError:
            continue
        scan_bytes(p, data)


if mode == 'all':
    paths = zsplit(git('ls-files', '-z')) + zsplit(git('ls-files', '-z', '--others', '--exclude-standard'))
    scan_worktree(sorted(set(paths)))
elif mode == 'files':
    scan_worktree([os.path.join(prefix, a) if prefix and not os.path.isabs(a) else a for a in args])
elif mode == 'staged':
    for p in zsplit(git('diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR')):
        scan_bytes(p, git('show', ':' + p))
elif mode == 'history':
    proc = subprocess.Popen(['git', '-c', 'core.quotePath=false', 'log', '--all', '-p', '--no-color',
                             '--no-ext-diff', '--no-textconv', '-U0', '--format=commit %H'],
                            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    commit, path, in_hunk, seen = '?', None, False, set()
    for raw in proc.stdout:
        line = raw.decode('utf-8', 'replace').rstrip('\n')
        if line.startswith('commit ') and len(line) == 47:
            commit, path, in_hunk = line[7:19], None, False
        elif line.startswith('diff --git '):
            path, in_hunk = None, False
        elif not in_hunk and line.startswith('+++ '):
            path = line[6:] if line.startswith('+++ b/') else None
        elif line.startswith('@@'):
            in_hunk = True
        elif in_hunk and line.startswith('+') and path and not whitelisted_path(path):
            for name in hits_in_line(line[1:]):
                key = (commit, path, name)
                if key not in seen:
                    seen.add(key)
                    report('%s:%s' % (commit, path), name)
    proc.wait()

sys.exit(1 if found else 0)
PY
}

scan "$@"; rc=$?
if [ "$rc" -eq 0 ]; then
  [ "$MODE" = "history" ] && echo "✅ secret-scan --history: zero hits across the whole history" >&2
  exit 0
fi
[ "$rc" -ne 1 ] && { echo "❌ secret-scan itself failed (python exit code ${rc})" >&2; exit 2; }
{
  echo "🔑 secret-scan (--${MODE}): each line above is \"location:pattern\"; locations only, values are never printed."
  echo "   Fix: delete the value from the file and read it from an environment variable instead (locally in .env / .dev.vars; in production via wrangler secret put)."
  [ "$MODE" = "staged" ] && echo "   Staged content: git add again after fixing; untrack a secret file itself with git rm --cached <file>."
  echo "   False positive: switch to a placeholder form (<KEY>, your_…) or adjust this script's whitelist."
  echo "   🔒 If a key ever entered history (even committed but never pushed), rotate it first (a human does this), then discuss cleaning the history."
} >&2
exit 1
