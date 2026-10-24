#!/usr/bin/env bash
# Tests for netzar-clone.sh (NZR-3). Local bare repo as origin, stub npm/npx/free; no network.
#   bash test-netzar-clone.sh            run every case
#   bash test-netzar-clone.sh <case>     run one case (used by the vitest wrapper)
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="$DIR/netzar-clone.sh"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.test GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.test
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null

fail() { echo "FAIL: $*" >&2; exit 1; }
eq() { [ "$1" = "$2" ] || fail "$3: expected '$2' got '$1'"; }
has() { grep -qF -- "$2" <<<"$1" || fail "$3: missing '$2' in: $1"; }

setup() {
  T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
  mkdir -p "$T/seed/web" "$T/bin"
  ( cd "$T/seed" && git init -q -b development &&
    echo 'FOO=' >.env.example && echo '{"name":"x"}' >package.json &&
    echo '{"lock":1}' >package-lock.json && echo '{"lock":2}' >web/package-lock.json &&
    git add -A && git commit -qm seed ) || fail "seed"
  git clone -q --bare "$T/seed" "$T/origin.git" || fail "bare"
  cat >"$T/bin/npm" <<'EOF'
#!/usr/bin/env bash
echo "$(date +%s%N) start npm $*" >>"$STUB_LOG"; sleep 0.3
[ "${STUB_DRIFT:-}" = 1 ] && [ "$*" = "ci --ignore-scripts" ] && echo '{"lock":"drift"}' >package-lock.json
echo "$(date +%s%N) end npm $*" >>"$STUB_LOG"
EOF
  sed 's/npm/npx/g; /STUB_DRIFT/d' "$T/bin/npm" >"$T/bin/npx"
  cat >"$T/bin/free" <<'EOF'
#!/usr/bin/env bash
echo "              total        used        free      shared  buff/cache   available"
echo "Mem:           3900        1500        1000          10        1400        ${STUB_AVAIL:-3000}"
EOF
  chmod +x "$T/bin/"*
  export PATH="$T/bin:$PATH" STUB_LOG="$T/stub.log"
  export NETZAR_ORIGIN="$T/origin.git" NETZAR_CLONE="$T/clone" NETZAR_LOG_DIR="$T/logs" NETZAR_APPROVALS="$T/approvals.jsonl"
  : >"$STUB_LOG"
  bash "$SCRIPT" init >/dev/null 2>&1 || fail "init"
}

latest() { ls -t "$NETZAR_LOG_DIR"/$1-*.json | head -1; }

# a secret-shaped string built at run time so this file never matches a scanner
fake_nvapi() { printf 'nvapi-%s' "$(printf 'A%.0s' {1..24})"; }

t_check_clean() {
  setup
  out="$(bash "$SCRIPT" check 2>&1)"; rc=$?
  eq "$rc" 0 "exit"
  sha="$(git -C "$NETZAR_CLONE" rev-parse HEAD)"
  has "$out" "CLONE CLEAN $sha" "stdout"
  r="$(latest clone-check)"
  eq "$(jq -c '[.sha,.env_files,.key_files,.scanner_hits,.extra_pattern_hits]' "$r")" "[\"$sha\",[],[],0,0]" "report"
  eq "$(jq -r '.tracked_templates|index(".env.example")!=null' "$r")" true "templates listed"
}

t_check_dirty() {
  setup
  secret="$(fake_nvapi)"
  echo 'A=1' >"$NETZAR_CLONE/.env"; : >"$NETZAR_CLONE/id_rsa"; echo "k=$secret" >"$NETZAR_CLONE/leak.txt"
  out="$(bash "$SCRIPT" check 2>&1)"; rc=$?
  eq "$rc" 1 "exit"
  has "$out" "CLONE NOT CLEAN: .env" "env"
  has "$out" "CLONE NOT CLEAN: id_rsa" "key"
  has "$out" "CLONE NOT CLEAN: leak.txt" "pattern"
  case "$out" in *"$secret"*) fail "value echoed" ;; esac
  r="$(latest clone-check)"
  case "$(cat "$r")" in *"$secret"*) fail "value in report" ;; esac
  eq "$(jq -c '[.env_files,.key_files,.extra_pattern_hits]' "$r")" '[[".env"],["id_rsa"],1]' "report"
}

t_fetch() {
  setup
  ( cd "$T/seed" && echo x >new.txt && git add -A && git commit -qm new && git push -q "$T/origin.git" development ) || fail "advance origin"
  new="$(git -C "$T/seed" rev-parse HEAD)"
  echo dirty >"$NETZAR_CLONE/stray.txt"
  out="$(bash "$SCRIPT" fetch 2>&1)"; rc=$?
  eq "$rc" 3 "dirty exit"; has "$out" "REFUSED: dirty tree" "dirty msg"
  eq "$(git -C "$NETZAR_CLONE" rev-parse origin/development)" "$(git -C "$T/seed" rev-parse HEAD~1)" "nothing fetched"
  rm "$NETZAR_CLONE/stray.txt"
  out="$(bash "$SCRIPT" fetch 2>&1)"; rc=$?
  eq "$rc" 0 "exit"; has "$out" "FETCHED origin/development $new" "stdout"
}

t_install_serial() {
  setup
  out="$(bash "$SCRIPT" install 2>&1)"; rc=$?
  eq "$rc" 0 "exit ($out)"
  eq "$(sed 's/^[0-9]* //' "$STUB_LOG" | tr '\n' '|')" \
    "start npm ci --ignore-scripts|end npm ci --ignore-scripts|start npm ci --prefix web|end npm ci --prefix web|start npx playwright install chromium|end npx playwright install chromium|" "serial order"
  r="$(latest install)"
  eq "$(jq -c '[.steps[]|[.cmd,.exit]]' "$r")" '[["npm ci --ignore-scripts",0],["npm ci --prefix web",0],["npx playwright install chromium",0]]' "report steps"
  eq "$(jq '.min_avail_mb' "$r")" 3000 "min avail"
  eq "$(jq '.peak_used_mb' "$r")" 1500 "peak used"
  eq "$(git -C "$NETZAR_CLONE" status --porcelain -- package-lock.json web/package-lock.json)" "" "lockfiles"
}

t_install_drift() {
  setup
  out="$(STUB_DRIFT=1 bash "$SCRIPT" install 2>&1)"; rc=$?
  eq "$rc" 1 "exit"; has "$out" "LOCKFILE CHANGED: package-lock.json" "msg"
  case "$(cat "$STUB_LOG")" in *"--prefix web"*) fail "later command ran" ;; esac
}

t_install_lowmem() {
  setup
  out="$(STUB_AVAIL=100 bash "$SCRIPT" install 2>&1)"; rc=$?
  eq "$rc" 1 "exit"; has "$out" "ABORTED: low memory (100 MB available)" "msg"
  eq "$(wc -l <"$STUB_LOG" | tr -d ' ')" 0 "no command completed"
}

t_push_refused() {
  setup
  cd "$NETZAR_CLONE" || fail cd
  git switch -q -c gauntlet/x && echo y >y.txt && git add -A && git commit -qm y
  sha="$(git rev-parse HEAD)"
  git push >/dev/null 2>&1 && fail "plain push succeeded"
  git push --no-verify origin HEAD >/dev/null 2>&1 && fail "--no-verify push succeeded"
  git push "$NETZAR_ORIGIN" HEAD:refs/heads/gauntlet/x >/dev/null 2>&1 && fail "explicit-url push succeeded"
  git --git-dir="$NETZAR_ORIGIN" rev-parse -q --verify refs/heads/gauntlet/x >/dev/null && fail "ref reached origin"
  eq "$(jq -c '[.sha,.ref,.result,.reason]' "$NETZAR_LOG_DIR/push-attempts.jsonl")" \
    "[\"$sha\",\"refs/heads/gauntlet/x\",\"refused\",\"no owner yes for ${sha:0:12} -> refs/heads/gauntlet/x\"]" "log line"
}

t_push_approved() {
  setup
  cd "$NETZAR_CLONE" || fail cd
  git switch -q -c docs/x && echo y >y.txt && git add -A && git commit -qm y
  sha="$(git rev-parse HEAD)"
  echo "{\"ts\":\"2026-01-01T00:00:00Z\",\"sha\":\"$sha\",\"ref\":\"refs/heads/docs/x\",\"owner_text\":\"yes push docs/x\",\"used\":false}" >"$NETZAR_APPROVALS"
  out="$(bash "$SCRIPT" push "$sha" docs/x 2>&1)"; rc=$?
  eq "$rc" 0 "first push ($out)"
  eq "$(git --git-dir="$NETZAR_ORIGIN" rev-parse refs/heads/docs/x)" "$sha" "reached origin"
  out="$(bash "$SCRIPT" push "$sha" docs/x 2>&1)"; rc=$?
  eq "$rc" 4 "reuse exit"; has "$out" "no owner yes for ${sha:0:12} -> refs/heads/docs/x" "reuse msg"
  echo z >z.txt && git add -A && git commit -qm z
  other="$(git rev-parse HEAD)"
  out="$(bash "$SCRIPT" push "$other" docs/x 2>&1)"; rc=$?
  eq "$rc" 4 "other sha exit"; has "$out" "no owner yes for ${other:0:12} -> refs/heads/docs/x" "other sha msg"
  eq "$(jq -s -c '[.[]|.result]' "$NETZAR_LOG_DIR/push-attempts.jsonl")" '["allowed","refused","refused"]' "log results"
}

CASES="t_check_clean t_check_dirty t_fetch t_install_serial t_install_drift t_install_lowmem t_push_refused t_push_approved"
if [ $# -gt 0 ]; then ( "$1" ); exit $?; fi
pass=0; total=0
for c in $CASES; do
  total=$((total + 1))
  if ( "$c" ); then pass=$((pass + 1)); echo "ok   $c"; else echo "FAIL $c"; fi
done
echo "SUMMARY: $pass/$total passed"
[ "$pass" = "$total" ]
