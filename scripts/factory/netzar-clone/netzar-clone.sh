#!/usr/bin/env bash
# Clean-clone manager for Netzer-Labs builds (NZR-3).
#   netzar-clone.sh init | fetch | check | install | push <sha> <branch>
# Env overrides (tests): NETZAR_CLONE NETZAR_ORIGIN NETZAR_LOG_DIR NETZAR_APPROVALS NETZAR_HOOKS
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLONE="${NETZAR_CLONE:-/root/work/netzer-baseline}"
ORIGIN="${NETZAR_ORIGIN:-https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs}"
LOGS="${NETZAR_LOG_DIR:-$HOME/.claude/plans/netzar-logs}"
APPROVALS="${NETZAR_APPROVALS:-$HOME/.claude/plans/netzar-push-approvals.jsonl}"
# Hook runs from a stable path outside any checkout: a branch switch or worktree removal must not drop it.
HOOKS="${NETZAR_HOOKS:-$HOME/.claude/bin/hooks/netzar}"
export NETZAR_LOG_DIR="$LOGS" NETZAR_APPROVALS="$APPROVALS"
MIN_AVAIL_MB=250

ts() { date -u +%Y%m%dT%H%M%SZ; }
jarr() { if [ $# -eq 0 ]; then echo '[]'; else printf '%s\n' "$@" | jq -R . | jq -sc .; fi; }
dirty() { [ -n "$(git status --porcelain --untracked-files=all | grep -vE ' (web/)?node_modules/' || true)" ]; }

cmd_init() {
  mkdir -p "$LOGS" "$(dirname "$APPROVALS")"
  [ -d "$CLONE/.git" ] || git clone -q "$ORIGIN" "$CLONE" || { echo "clone failed" >&2; exit 1; }
  git -C "$CLONE" config remote.origin.pushurl DISABLED-owner-yes-required
  mkdir -p "$HOOKS"
  install -m 555 "$HERE/hooks/pre-push" "$HOOKS/pre-push"
  git -C "$CLONE" config core.hooksPath "$HOOKS"
  [ -e "$APPROVALS" ] || { : >"$APPROVALS"; chmod 600 "$APPROVALS"; }
  echo "INIT $CLONE"
}

cmd_fetch() {
  cd "$CLONE"
  if dirty; then echo "REFUSED: dirty tree" >&2; exit 3; fi
  git fetch -q origin --prune
  echo "FETCHED origin/development $(git rev-parse origin/development)"
}

# Report paths and ids only, never matched values.
cmd_check() {
  cd "$CLONE"
  local files f b p id re h sha out
  local env=() key=() pat=() scan=()
  files="$(git ls-files -z -o | tr '\0' '\n' | grep -vE '(^|/)node_modules/' || true)"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    b="${f##*/}"
    case "$b" in
      .env | .env.*) env+=("$f") ;;
      *.pem | id_rsa*) key+=("$f") ;;
      .npmrc) if grep -q _authToken "$f"; then key+=("$f"); fi ;;
    esac
  done <<<"$files"

  local PATS=(
    'ghp=ghp_[A-Za-z0-9]{36}' 'github_pat=github_pat_[A-Za-z0-9_]{20,}'
    'sk-ant=sk-ant-[A-Za-z0-9_-]{20,}' 'sk-or=sk-or-v1-[a-f0-9]{20,}'
    'nvapi=nvapi-[A-Za-z0-9_-]{20,}' 'jwt=eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.'
  )
  for p in "${PATS[@]}"; do
    id="${p%%=*}"; re="${p#*=}"
    while IFS= read -r h; do
      [ -n "$h" ] && pat+=("$h:$id")
    done < <(printf '%s\n' "$files" | grep -v '^$' | xargs -d '\n' -r grep -IHnE -m1 -e "$re" -- 2>/dev/null | cut -d: -f1,2 || true)
  done

  # fail closed: a missing or crashing scanner is a finding, never a skip
  if [ ! -f scripts/ci/secret-scan.mjs ]; then
    scan+=("scanner missing")
  elif [ -n "$files" ]; then
    local list=() rc=0 errs
    mapfile -t list <<<"$files"
    errs="$(node scripts/ci/secret-scan.mjs "${list[@]}" 2>&1 >/dev/null)" || rc=$?
    if [ "$rc" -ne 0 ]; then
      # keep only file:line: [id]; the scanner's excerpt is a secret fragment
      while IFS= read -r h; do
        [ -n "$h" ] && scan+=("$h")
      done < <(printf '%s\n' "$errs" | sed -nE 's/^(.+:[0-9]+: \[[^]]*\]).*/\1/p')
      if [ "$rc" -ne 1 ] || [ ${#scan[@]} -eq 0 ]; then scan+=("scanner failed (exit $rc)"); fi
    fi
  fi

  # the push guard must be in place, or the clone is not safe to build in
  if [ "$(git config remote.origin.pushurl || true)" != DISABLED-owner-yes-required ] ||
    [ "$(git config core.hooksPath || true)" != "$HOOKS" ] || [ ! -x "$HOOKS/pre-push" ]; then
    echo "CLONE NOT CLEAN: push guard missing (run init)"; exit 1
  fi

  sha="$(git rev-parse HEAD)"
  mkdir -p "$LOGS"
  jq -n --arg sha "$sha" --argjson env "$(jarr "${env[@]+"${env[@]}"}")" --argjson key "$(jarr "${key[@]+"${key[@]}"}")" \
    --argjson scan "${#scan[@]}" --argjson pat "${#pat[@]}" --argjson pp "$(jarr "${pat[@]+"${pat[@]}"}")" \
    --argjson tpl "$(jarr $(git ls-files | grep -E '(^|/)\.env(\..*)?$' || true))" \
    '{sha:$sha,env_files:$env,key_files:$key,scanner_hits:$scan,extra_pattern_hits:$pat,extra_pattern_paths:$pp,tracked_templates:$tpl}' \
    >"$LOGS/clone-check-$(ts).json"

  out=0
  for f in "${env[@]+"${env[@]}"}"; do echo "CLONE NOT CLEAN: $f (env file)"; out=1; done
  for f in "${key[@]+"${key[@]}"}"; do echo "CLONE NOT CLEAN: $f (key file)"; out=1; done
  for f in "${pat[@]+"${pat[@]}"}"; do echo "CLONE NOT CLEAN: ${f%:*} (secret-shaped string, pattern ${f##*:})"; out=1; done
  for f in "${scan[@]+"${scan[@]}"}"; do echo "CLONE NOT CLEAN: $f (secret-scan)"; out=1; done
  [ "$out" = 0 ] || exit 1
  echo "CLONE CLEAN $sha"
}

avail() { free -m | awk '/^Mem:/{print $7}'; }
used() { free -m | awk '/^Mem:/{print $3}'; }

cmd_install() {
  cd "$CLONE"
  mkdir -p "$LOGS"
  if pgrep -f '^npm ci' >/dev/null; then echo "ABORTED: another npm ci is running" >&2; exit 1; fi
  local steps=() min="" peak=0 now u cur stamp="$LOGS/install-stamp" report="$LOGS/install-$(ts).json"

  finish() {
    jq -n --argjson rc "$1" --argjson s "$(if [ ${#steps[@]} -eq 0 ]; then echo '[]'; else printf '%s\n' "${steps[@]}" | jq -sc .; fi)" \
      --argjson min "${min:-null}" --argjson peak "$peak" \
      '{ok:($rc==0),steps:$s,min_avail_mb:$min,peak_used_mb:$peak}' >"$report"
  }
  sample() {
    now="$(avail)"; u="$(used)"
    if [ -z "$min" ] || [ "$now" -lt "$min" ]; then min="$now"; fi
    if [ "$u" -gt "$peak" ]; then peak="$u"; fi
  }
  low_abort() { echo "ABORTED: low memory ($now MB available)" >&2; finish 1; exit 1; }
  drift() {
    local f
    for f in package-lock.json web/package-lock.json; do
      if [ -n "$(git status --porcelain -- "$f")" ]; then echo "LOCKFILE CHANGED: $f" >&2; finish 1; exit 1; fi
    done
  }
  run_step() {
    local pid rc
    sample
    if [ "$now" -lt "$MIN_AVAIL_MB" ]; then low_abort; fi
    "$@" >&2 &
    pid=$!
    while kill -0 "$pid" 2>/dev/null; do
      sample
      if [ "$now" -lt "$MIN_AVAIL_MB" ]; then
        kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; low_abort
      fi
      sleep 0.2
    done
    wait "$pid" && rc=0 || rc=$?
    steps+=("$(jq -nc --arg c "$*" --argjson e "$rc" '{cmd:$c,exit:$e}')")
    return "$rc"
  }
  step() { run_step "$@" || { echo "STEP FAILED (exit $?): $*" >&2; finish 1; exit 1; }; }

  cur="$(sha256sum package-lock.json web/package-lock.json | sha256sum | cut -d' ' -f1)"
  # same lockfiles as the last good install and the trees exist: skip the npm steps
  if [ ! -f "$stamp" ] || [ "$(cat "$stamp")" != "$cur" ] || [ ! -d node_modules ] || [ ! -d web/node_modules ]; then
    step npm ci --ignore-scripts; drift
    step npm ci --prefix web; drift
  fi
  step npx playwright install chromium
  drift
  echo "$cur" >"$stamp"
  finish 0
  echo "INSTALL OK $report"
}

cmd_push() {
  [ $# -eq 2 ] || { echo "usage: netzar-clone.sh push <sha> <branch>" >&2; exit 2; }
  cd "$CLONE"
  local sha br ref url out
  sha="$(git rev-parse --verify "$1^{commit}")" || exit 2
  br="$2"; git check-ref-format "refs/heads/$br" || exit 2
  ref="refs/heads/$br"
  url="$(git remote get-url origin)"
  # Run the gate ourselves (git skips the hook for an up-to-date ref), then push
  # to the explicit URL, which bypasses the disabled pushurl.
  printf 'HEAD %s %s 0000000000000000000000000000000000000000\n' "$sha" "$ref" | bash "$HOOKS/pre-push" origin "$url" || exit 4
  out="$(git push --no-verify "$url" "$sha:$ref" 2>&1)" || { echo "$out" >&2; exit 1; }
  jq -nc --arg ts "$(date -u +%FT%TZ)" --arg sha "$sha" --arg ref "$ref" '{ts:$ts,sha:$sha,ref:$ref,event:"used"}' >>"$APPROVALS"
  echo "PUSHED $sha -> $ref"
}

sub="${1:-}"
[ $# -gt 0 ] && shift
case "$sub" in
  init) cmd_init ;;
  fetch) cmd_fetch ;;
  check) cmd_check ;;
  install) cmd_install ;;
  push) cmd_push "$@" ;;
  *) echo "usage: netzar-clone.sh init|fetch|check|install|push <sha> <branch>" >&2; exit 2 ;;
esac
