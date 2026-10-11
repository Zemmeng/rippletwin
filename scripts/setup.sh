#!/usr/bin/env bash
# setup.sh -- run once after cloning (safe to re-run; idempotent) to prepare a local checkout.
#
# What it does: [1/6] checks tools (git, gh, node >= 20 and python3 >= 3.9 are required; wrangler and uv
#                     are optional) and prints an install command for anything missing, without stopping
#               [2/6] gh login status
#               [3/6] enables the repository's git hooks (core.hooksPath=.githooks) and sets the executable bits
#               [4/6] copies .env.example to .env if there is no .env (never overwrites); creates logs/ out/ scratch/
#               [5/6] identity: hack.me = your GitHub handle; if user.email is empty or a *.local host address,
#                     it only prints a suggested command and does not change it for you
#               [6/6] bash scripts/check.sh --quick, then prints the summary
#   🔒 Never touches any key values; never commits or pushes.
# Usage: bash scripts/setup.sh
# Exit codes: 0 = finished (also with ⚠️; follow the hints and run it again); 2 = not inside a git repository
set -uo pipefail

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
case "${1:-}" in -h|--help) awk 'NR==1{next} /^#/{sub(/^# ?/,"");print;next} {exit}' "$0"; exit 0 ;; esac
ROOT=$(git -C "$SELF_DIR" rev-parse --show-toplevel 2>/dev/null || git rev-parse --show-toplevel 2>/dev/null) \
  || { echo "❌ Not inside a git repository: git clone first, then run bash scripts/setup.sh inside the clone" >&2; exit 2; }
cd "$ROOT" || exit 2

OS=$(uname -s)
WARN=0
ok() { echo "      ✅ $*"; }
warn() { echo "      ⚠️ $*"; WARN=$((WARN + 1)); }
fix() { echo "         → $*"; }
install_hint() {  # install_hint <macOS command> <Linux command>
  if [ "$OS" = Darwin ]; then fix "$1"; else fix "$2"; fi
}
ver_ge() {  # ver_ge <actual version> <minimum version>: compares dotted numeric versions
  python3 -c 'import sys
a = [int(x) for x in sys.argv[1].split(".")[:3] if x.isdigit()]
b = [int(x) for x in sys.argv[2].split(".")[:3]]
sys.exit(0 if a >= b else 1)' "$1" "$2" 2>/dev/null
}

echo "🛠  setup.sh · $(basename "$ROOT") (safe to re-run)"

# ---------------------------------------------------------------- [1/6] tools
echo "[1/6] Checking tools"
if command -v git >/dev/null 2>&1; then ok "git $(git --version | awk '{print $3}')"; else warn "git not found"; install_hint "xcode-select --install" "sudo apt install -y git"; fi
HAS_PY=0
if command -v python3 >/dev/null 2>&1; then
  PYV=$(python3 -c 'import sys; print("%d.%d.%d" % sys.version_info[:3])')
  if python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'; then ok "python3 $PYV"; HAS_PY=1
  else warn "python3 $PYV < 3.9 (the scripts use zoneinfo for time calculations)"; install_hint "brew install python@3.12" "sudo apt install -y python3"; fi
else
  warn "python3 (>= 3.9) not found"; install_hint "brew install python@3.12" "sudo apt install -y python3"
fi
if command -v node >/dev/null 2>&1; then
  NV=$(node -v 2>/dev/null | sed 's/^v//')
  if [ "$HAS_PY" = 1 ] && ver_ge "$NV" 20; then ok "node $NV"
  elif [ "$HAS_PY" = 1 ]; then warn "node $NV < 20"; install_hint "brew install node@20 (or nvm install 20)" "curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs (or nvm install 20)"
  else ok "node ${NV} (cannot compare versions without python3; >= 20 is required)"; fi
else
  warn "node (>= 20) not found"; install_hint "brew install node@20 (or nvm install 20)" "nvm install 20 (or NodeSource setup_20.x)"
fi
HAS_GH=0
if command -v gh >/dev/null 2>&1; then ok "gh $(gh --version 2>/dev/null | head -n 1 | awk '{print $3}')"; HAS_GH=1
else warn "gh not found (GitHub CLI: used to open PRs, check CI and detect your handle)"; install_hint "brew install gh" "sudo apt install -y gh (or see https://cli.github.com)"; fi
if command -v wrangler >/dev/null 2>&1; then ok "wrangler (optional) installed"
else echo "      · wrangler is optional: each Worker module pins it as a devDependency, so run npm ci in apps/<module> and use npx wrangler"; fi
if command -v uv >/dev/null 2>&1; then ok "uv (optional) installed"
else echo "      · uv is optional: only for the offline Python data pipelines, where python3 -m venv also works ($([ "$OS" = Darwin ] && echo 'brew install uv' || echo 'curl -LsSf https://astral.sh/uv/install.sh | sh'))"; fi

# ---------------------------------------------------------------- [2/6] gh login
echo "[2/6] gh login"
GH_OK=0
if [ "$HAS_GH" = 1 ]; then
  if gh auth status >/dev/null 2>&1; then ok "gh is logged in"; GH_OK=1
  else warn "gh is not logged in"; fix "gh auth login   (choose GitHub.com → HTTPS → browser login; the token stays in gh's own keychain)"; fi
else
  warn "gh not found, skipped"
fi

# ---------------------------------------------------------------- [3/6] hooks
echo "[3/6] Enabling git hooks"
if [ -d .githooks ]; then
  git config core.hooksPath .githooks && ok "git config core.hooksPath .githooks"
  chmod +x .githooks/* 2>/dev/null
  chmod +x scripts/*.sh 2>/dev/null
  ok "chmod +x .githooks/* scripts/*.sh (secret scan before each commit, check --quick before each push)"
else
  warn "no .githooks/ directory (incomplete checkout?)"
fi

# ---------------------------------------------------------------- [4/6] .env and local directories
echo "[4/6] .env and local directories"
if [ -f .env ]; then ok ".env already exists, not overwritten"
elif [ -f .env.example ]; then cp .env.example .env && ok "copied .env.example to .env -- fill in the values yourself; 🔒 never paste them into chats, issues or PRs"
else warn "no .env.example, skipped"; fi
mkdir -p logs out scratch && ok "logs/ out/ scratch/ ready (all in .gitignore)"

# ---------------------------------------------------------------- [5/6] identity
echo "[5/6] Identity"
ME=$(git config hack.me 2>/dev/null || true)
if [ "$GH_OK" = 1 ]; then
  LOGIN=$(gh api user --jq .login 2>/dev/null || true)
  if [ -n "$LOGIN" ]; then
    git config hack.me "$LOGIN" && ME="$LOGIN" && ok "git config hack.me ${LOGIN} (read from gh api user)"
  else
    warn "gh api user did not return a handle (network?)"
  fi
fi
if [ -z "$ME" ]; then
  warn "your GitHub handle is unknown"
  fix "git config hack.me <your GitHub handle>   (without @; the hooks and checks use it to identify you)"
elif [ "$GH_OK" != 1 ]; then
  ok "hack.me = ${ME} (kept the existing setting; re-run after gh login to correct it automatically)"
fi
EMAIL=$(git config user.email 2>/dev/null || true)
case "$EMAIL" in
  "") warn "git user.email is empty" ;;
  *.local) warn "git user.email is a local host address (*.local), which GitHub cannot match to you" ;;
  *) ok "user.email is set (value not shown)"; EMAIL="set" ;;
esac
if [ "$EMAIL" != set ]; then
  fix "Suggestion (your call; the script does not change it): git config user.email ${ME:-<handle>}@users.noreply.github.com"
  fix "Use the noreply address shown under GitHub → Settings → Emails (newer accounts use <numeric ID>+<handle>@users.noreply.github.com)"
fi
[ -n "$(git config user.name 2>/dev/null)" ] || { warn "git user.name is empty"; fix "git config user.name \"<your name or handle>\""; }

# ---------------------------------------------------------------- [6/6] check --quick
echo "[6/6] bash scripts/check.sh --quick"
if [ -f scripts/check.sh ]; then
  CHK=$(bash scripts/check.sh --quick 2>&1); CHK_RC=$?
  SUM=$(printf '%s\n' "$CHK" | sed -n '/^======== Summary/,$p')
  if [ -n "$SUM" ]; then printf '%s\n' "$SUM" | sed 's/^/      /'
  else warn "check.sh printed no summary line (exit code ${CHK_RC}); see logs/last-check.txt"; fi
  [ "$CHK_RC" -eq 0 ] || fix "there are ❌: the full output is in logs/last-check.txt"
else
  warn "no scripts/check.sh"
fi

echo ""
if [ "$WARN" -gt 0 ]; then echo "setup finished: $WARN ⚠️ -- apply the → hints above, then re-run (it is idempotent)"
else echo "setup finished: environment ready ✅"; fi
echo "Next: see CONTRIBUTING.md (run the demo locally, quality gate, branch naming)"
exit 0
