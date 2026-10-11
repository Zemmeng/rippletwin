#!/usr/bin/env bash
# deploy.sh -- one-command deploy followed by an automatic live smoke test. Stack-agnostic: it calls each
# module's own `npm run deploy` or deploy.sh.
#
# 🔒 Only the DEPLOYER in hackathon.conf may run it (when the DEPLOYER is unavailable, BACKUP_LEAD can do a
#    backup deploy, which prints ⚠️ and is marked "backup deploy" in deploy.log).
#    Automated agents must ask a human before running it.
# What it does: deploys only after every preflight check passes:
#   [1/6] git config hack.me equals DEPLOYER (or BACKUP_LEAD → ⚠️ backup deploy)
#   [2/6] the worktree is clean (no uncommitted or untracked files)
#   [3/6] HEAD is on main or on a tag, and matches origin (only ⚠️ if there is no remote)
#   [4/6] during the code freeze and after the deadline (computed from hackathon.conf) only a demo-* tag can be
#         deployed, unless --hotfix is given. The deadline has passed, so a deploy from main needs --hotfix.
#   [5/6] a full bash scripts/check.sh run has no ❌ (--quick would check almost nothing on a clean main)
#   [6/6] deploys module by module, printing [i/N]: package.json with a deploy script → npm run deploy;
#         otherwise deploy.sh → run it; otherwise ❌
#   Dependencies: npm ci when package-lock.json exists; otherwise npm install --no-package-lock (so no untracked
#   lockfile is created)
#   Afterwards: runs check.sh --e2e when DEMO_URL is set; appends one line per module to logs/deploy.log
#   (time | module | commit | who); on failure prints a rollback command (switch to the previous demo-* tag and
#   deploy again).
# Usage: bash scripts/deploy.sh <module|all> [--hotfix]
#   all = DEPLOY_MODULES in hackathon.conf (space-separated directory names under apps/)
# Exit codes: 0 = deploy and smoke test passed; 1 = refused or failed; 2 = usage error / not inside a git repository
set -uo pipefail

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
usage() { awk 'NR==1{next} /^#/{sub(/^# ?/,"");print;next} {exit}' "$0"; }

TARGET=""; HOTFIX=0
while [ $# -gt 0 ]; do
  case "$1" in
    --hotfix) HOTFIX=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "❌ Unknown option: $1" >&2; usage; exit 2 ;;
    *) [ -z "$TARGET" ] || { echo "❌ Give one module at a time (or all)" >&2; exit 2; }; TARGET="$1" ;;
  esac
  shift
done
[ -n "$TARGET" ] || { usage; exit 2; }

ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "❌ Not inside a git repository" >&2; exit 2; }
cd "$ROOT" || exit 2
g() { git -c core.quotePath=false "$@"; }
conf_get() { grep -E "^$1=" hackathon.conf | cut -d= -f2- | sed 's/#.*//' | xargs 2>/dev/null; }
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

refuse() {  # refuse <reason> [fix]
  echo "🚫 Deploy refused: $1"
  [ -n "${2:-}" ] && echo "   Fix: $2"
  exit 1
}

[ -f hackathon.conf ] || refuse "hackathon.conf not found" "restore it from git (git restore hackathon.conf)"
DEPLOYER=$(conf_get DEPLOYER); BACKUP_LEAD=$(conf_get BACKUP_LEAD); DEMO_URL=$(conf_get DEMO_URL); MODULES_ALL=$(conf_get DEPLOY_MODULES)
CONF_TZ=$(conf_get TZ); CONF_TZ=${CONF_TZ:-Australia/Melbourne}
ME=$(git config hack.me 2>/dev/null || true)

echo "🚀 deploy.sh $TARGET$([ "$HOTFIX" = 1 ] && echo ' --hotfix')"

# Rollback hint: the most recent demo-* tag that is not on HEAD
print_rollback() {
  local here prev t
  here=$(g tag --points-at HEAD 2>/dev/null | tr '\n' ' ')
  prev=""
  for t in $(g tag -l 'demo-*' --sort=-creatordate 2>/dev/null); do
    case " $here " in *" $t "*) continue ;; esac
    prev="$t"; break
  done
  echo ""
  echo "↩️  Rollback (if production is broken, restore the last demo-ready version first, then fix):"
  if [ -n "$prev" ]; then
    echo "    git switch --detach $prev && bash scripts/deploy.sh $TARGET"
  else
    echo "    There is no other demo-* tag yet. Pick a working commit (git log --oneline -n 10), tag it and deploy:"
    echo "    git tag -a demo-rollback <commit> -m 'Rollback' && git push origin demo-rollback \\"
    echo "      && git switch --detach demo-rollback && bash scripts/deploy.sh $TARGET"
    echo "    (push the tag to origin first, otherwise [3/6] refuses)"
  fi
  echo "    Once fixed, return to main: git switch main"
}

# ---- [1/6] Identity ----
[ -n "$DEPLOYER" ] || refuse "DEPLOYER in hackathon.conf is empty" "set DEPLOYER=<GitHub handle> in hackathon.conf"
[ -n "$ME" ] || refuse "git config hack.me is not set, so your identity is unknown" "bash scripts/setup.sh (or git config hack.me <your GitHub handle>)"
BACKUP_DEPLOY=0
if [ "$(lower "$ME")" = "$(lower "$DEPLOYER")" ]; then
  echo "[1/6] Identity @$ME = DEPLOYER ✅"
elif [ -n "$BACKUP_LEAD" ] && [ "$(lower "$ME")" = "$(lower "$BACKUP_LEAD")" ]; then
  BACKUP_DEPLOY=1
  echo "[1/6] Identity @$ME = BACKUP_LEAD ⚠️ backup deploy (DEPLOYER is @${DEPLOYER}; continue only if they are unavailable; deploy.log marks it as a backup deploy)"
else
  refuse "only DEPLOYER (@${DEPLOYER})${BACKUP_LEAD:+ or BACKUP_LEAD (@${BACKUP_LEAD})} can deploy; you are @$ME" "ask @$DEPLOYER to deploy; to change the deployer, edit DEPLOYER in hackathon.conf"
fi

# ---- [2/6] Clean worktree ----
DIRTY=$(g status --porcelain 2>/dev/null)
if [ -n "$DIRTY" ]; then
  echo "$DIRTY" | head -n 10 | sed 's/^/    /'
  refuse "the worktree is not clean ($(printf '%s\n' "$DIRTY" | grep -c .) uncommitted files); a deploy must be an exact commit" \
         "git stash -u (or commit / discard these changes), then run again"
fi
echo "[2/6] Worktree clean ✅"

# ---- [3/6] HEAD is on main or a tag and matches origin ----
g rev-parse -q --verify HEAD >/dev/null 2>&1 || refuse "there are no commits yet"
COMMIT=$(g rev-parse --short HEAD)
BR=$(g symbolic-ref --short -q HEAD 2>/dev/null || true)
TAGS=$(g tag --points-at HEAD 2>/dev/null | tr '\n' ' ' | sed 's/ $//')
if [ "$BR" != main ] && [ -z "$TAGS" ]; then
  refuse "HEAD (${COMMIT}, ${BR:-detached}) is neither on main nor on a tag" "git switch main && git pull; or git switch --detach demo-v1"
fi
WHERE="${BR:+$BR }${TAGS:+tag $TAGS }@ $COMMIT"
if g remote get-url origin >/dev/null 2>&1; then
  if ! g fetch origin --tags --quiet 2>/dev/null; then
    echo "[3/6] $WHERE ⚠️ git fetch origin failed (offline?), cannot confirm it matches origin"
  elif [ "$BR" = main ]; then
    ORIGIN_MAIN=$(g rev-parse -q --verify refs/remotes/origin/main 2>/dev/null || true)
    [ "$ORIGIN_MAIN" = "$(g rev-parse HEAD)" ] \
      || refuse "local main (${COMMIT}) differs from origin/main (${ORIGIN_MAIN:0:7})" "git pull (unpushed local commits must reach main through a PR first)"
    echo "[3/6] $WHERE matches origin/main ✅"
  else
    ok_tag=""
    for t in $TAGS; do
      remote_sha=$(g ls-remote --tags origin "refs/tags/$t" "refs/tags/$t^{}" 2>/dev/null | awk '{print $1}' | tail -n 1)
      [ "$remote_sha" = "$(g rev-parse HEAD)" ] && { ok_tag="$t"; break; }
    done
    [ -n "$ok_tag" ] || refuse "tag $TAGS is not on origin yet (or the tag of that name on origin points to another commit)" "git push origin <tag>"
    echo "[3/6] $WHERE matches tag $ok_tag on origin ✅"
  fi
else
  echo "[3/6] $WHERE ⚠️ no origin remote, cannot confirm it matches origin"
fi

# ---- [4/6] Freeze rule ----
PHASE=$(bash "$SELF_DIR/check.sh" --time-raw 2>/dev/null | sed -n 's/^PHASE=//p')
DEMO_TAG=$(printf '%s\n' $TAGS | grep '^demo-' | head -n 1)
case "$PHASE" in
  *"code freeze"*|*"deadline passed"*)
    if [ -n "$DEMO_TAG" ]; then echo "[4/6] Phase: ${PHASE}, HEAD is on $DEMO_TAG ✅"
    elif [ "$HOTFIX" = 1 ]; then echo "[4/6] Phase: $PHASE ⚠️ --hotfix: deploying without a demo-* tag (tag it afterwards and record the reason in docs/decisions.md)"
    else refuse "phase: ${PHASE}; after the code freeze and after the deadline only a demo-* tag can be deployed" "git tag -a demo-v2 -m 'Demo build' && git push origin demo-v2 && git switch --detach demo-v2; or add --hotfix (needed for any deploy from main after the deadline)"
    fi ;;
  *) echo "[4/6] Phase: ${PHASE:-unknown} ✅" ;;
esac

# ---- Module list ----
if [ "$TARGET" = all ]; then
  MODULES="$MODULES_ALL"
  [ -n "$MODULES" ] || refuse "DEPLOY_MODULES in hackathon.conf is empty" "list the modules to deploy there (space-separated), or name a single module"
else
  MODULES="$TARGET"
fi
for m in $MODULES; do
  [ -d "apps/$m" ] || refuse "apps/$m does not exist" "check the module name / DEPLOY_MODULES"
done

# ---- [5/6] Full check (--quick only looks at changes against the base, which is nothing on a clean main) ----
echo "[5/6] bash scripts/check.sh (full run, all tests)…"
CHK=$(bash "$SELF_DIR/check.sh" 2>&1); CHK_RC=$?
printf '%s\n' "$CHK" | sed -n '/^======== Summary/,$p' | sed 's/^/    /'
if [ "$CHK_RC" -ne 0 ] || ! printf '%s\n' "$CHK" | grep -q '^======== Summary 0 ❌'; then
  refuse "check.sh reported ❌ (or did not finish)" "fix it before deploying; the full output is in logs/last-check.txt"
fi
echo "[5/6] Full check has no ❌ ✅"

# ---- [6/6] Deploy ----
now_str() {
  python3 -c 'import sys; from datetime import datetime; from zoneinfo import ZoneInfo; print(datetime.now(ZoneInfo(sys.argv[1])).strftime("%Y-%m-%d %H:%M %Z"))' "$CONF_TZ" 2>/dev/null \
    || date '+%Y-%m-%d %H:%M'
}
mkdir -p logs
log_line() {
  local who="@$ME"
  [ "$BACKUP_DEPLOY" = 1 ] && who="@${ME} (backup deploy)"
  printf '%s | %s | %s | %s\n' "$(now_str)" "$1" "$COMMIT${TAGS:+ ($TAGS)}" "$who" >>logs/deploy.log
}
has_deploy_script() {
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); sys.exit(0 if (d.get("scripts") or {}).get("deploy") else 1)' "$1" 2>/dev/null
}

N=$(printf '%s\n' $MODULES | grep -c .)
i=0
for m in $MODULES; do
  i=$((i + 1))
  echo ""
  echo "[$i/$N] Deploying $m …"
  rc=0
  if [ -f "apps/$m/package.json" ] && has_deploy_script "apps/$m/package.json"; then
    if [ ! -d "apps/$m/node_modules" ]; then
      # With a lockfile, install exactly from it; without one, do not create an untracked package-lock.json (it would dirty the worktree)
      if [ -f "apps/$m/package-lock.json" ]; then
        echo "      apps/$m has no dependencies installed, installing: npm ci"
        (cd "apps/$m" && npm ci --no-audit --no-fund) || rc=$?
      else
        echo "      apps/$m has no dependencies installed, installing: npm install --no-package-lock"
        (cd "apps/$m" && npm install --no-package-lock --no-audit --no-fund) || rc=$?
      fi
    fi
    [ "$rc" -eq 0 ] && { (cd "apps/$m" && npm run deploy); rc=$?; }
  elif [ -f "apps/$m/deploy.sh" ]; then
    (cd "apps/$m" && bash deploy.sh); rc=$?
  else
    echo "[$i/$N] $m ❌ no way to deploy: add a \"deploy\" script to package.json, or write apps/$m/deploy.sh"
    log_line "${m} (failed: no way to deploy)"
    print_rollback; exit 1
  fi
  if [ "$rc" -ne 0 ]; then
    echo "[$i/$N] $m ❌ deploy failed (exit code ${rc})"
    log_line "${m} (failed)"
    print_rollback; exit 1
  fi
  log_line "$m"
  echo "[$i/$N] $m ✅"
done

# ---- Live smoke test ----
echo ""
if [ -n "$DEMO_URL" ]; then
  echo "🌐 Live smoke test: bash scripts/check.sh --e2e $DEMO_URL"
  if ! bash "$SELF_DIR/check.sh" --e2e "$DEMO_URL"; then
    echo "❌ Deploy succeeded but the live smoke test failed (full output in logs/last-e2e.txt)"
    print_rollback; exit 1
  fi
else
  echo "⚠️ DEMO_URL in hackathon.conf is empty, skipping the live smoke test (set it after the first deploy and link it at the top of README.md)"
fi

echo ""
echo "✅ Deployed: $MODULES"
echo "   URL: ${DEMO_URL:-(DEMO_URL not set)}"
echo "   commit: $COMMIT${TAGS:+ (tag ${TAGS})} · time: $(now_str) · deployed by: @$ME$([ "$BACKUP_DEPLOY" = 1 ] && echo ' (backup deploy)')"
echo "   Appended to logs/deploy.log"
exit 0
