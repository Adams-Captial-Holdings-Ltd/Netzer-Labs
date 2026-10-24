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
  mkdir -p "$T/seed/web" "$T/seed/scripts/ci" "$T/bin"
  # stand-in for the repo scanner: SCAN_STUB_RC picks the exit code; rc 1 reports every arg like the real one
  cat >"$T/seed/scripts/ci/secret-scan.mjs" <<'EOF'
const rc = Number(process.env.SCAN_STUB_RC || 0);
if (rc === 1) for (const f of process.argv.slice(2)) console.error(`${f}:3: [stub-id] excerpt-fragment`);
process.exit(rc);
EOF
  ( cd "$T/seed" && git init -q -b development &&
    echo 'FOO=' >.env.example && echo '{"name":"x"}' >package.json &&
    echo '{"lock":1}' >package-lock.json && echo '{"lock":2}' >web/package-lock.json &&
    git add -A && git commit -qm seed ) || fail "seed"
  git clone -q --bare "$T/seed" "$T/origin.git" || fail "bare"
  cat >"$T/bin/npm" <<'EOF'
#!/usr/bin/env bash
echo "$(date +%s%N) start npm $*" >>"$STUB_LOG"; sleep 0.3
[ "${STUB_DRIFT:-}" = 1 ] && [ "$*" = "ci --ignore-scripts" ] && echo '{"lock":"drift"}' >package-lock.json
[ "${STUB_FAIL:-}" = 1 ] && [ "$*" = "ci --prefix web" ] && exit 1
# STUB_HANG: leave a grandchild running and drop available memory, like npm's workers
if [ -n "${STUB_HANG:-}" ]; then sleep 30 & echo $! >"$STUB_HANG"; : >"$STUB_DROP"; wait; fi
echo "$(date +%s%N) end npm $*" >>"$STUB_LOG"
EOF
  sed 's/npm/npx/g; /STUB_DRIFT/d' "$T/bin/npm" >"$T/bin/npx"
  cat >"$T/bin/free" <<'EOF'
#!/usr/bin/env bash
echo "              total        used        free      shared  buff/cache   available"
echo "Mem:           3900        1500        1000          10        1400        $([ -e "${STUB_DROP:-/nonexistent}" ] && echo 100 || echo "${STUB_AVAIL:-3000}")"
EOF
  chmod +x "$T/bin/"*
  export PATH="$T/bin:$PATH" STUB_LOG="$T/stub.log"
  export NETZAR_ORIGIN="$T/origin.git" NETZAR_CLONE="$T/clone" NETZAR_LOG_DIR="$T/logs" NETZAR_APPROVALS="$T/approvals.jsonl" NETZAR_HOOKS="$T/hooks"
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

t_check_tracked() {
  setup
  secret="$(fake_nvapi)"
  mkdir -p "$NETZAR_CLONE/src" "$NETZAR_CLONE/node_modules/x"
  echo "const k = '$secret';" >"$NETZAR_CLONE/src/leak.ts"
  git -C "$NETZAR_CLONE" add src/leak.ts && git -C "$NETZAR_CLONE" commit -qm leak || fail "commit"
  out="$(bash "$SCRIPT" check 2>&1)"; rc=$?
  eq "$rc" 1 "exit"
  has "$out" "CLONE NOT CLEAN: src/leak.ts" "tracked file hit"
  case "$out" in *"$secret"*) fail "value echoed" ;; esac
  case "$out" in *"CLONE CLEAN"*) fail "reported clean" ;; esac
  # the tracked env template stays exempt from the filename check
  case "$out" in *"CLONE NOT CLEAN: .env.example"*) fail "template flagged" ;; esac
}

# the repo scanner has no placeholder filter, so committed test fixtures must not reach it; the stub flags every arg it gets
t_check_scanner_tracked() {
  setup
  out="$(SCAN_STUB_RC=1 bash "$SCRIPT" check 2>&1)"; rc=$?
  eq "$rc" 0 "tracked-only exit"; has "$out" "CLONE CLEAN" "tracked files not scanned"
  echo changed >>"$NETZAR_CLONE/package.json"
  out="$(SCAN_STUB_RC=1 bash "$SCRIPT" check 2>&1)"; rc=$?
  eq "$rc" 1 "modified exit"; has "$out" "CLONE NOT CLEAN: package.json:3: [stub-id]" "modified file scanned"
}

t_check_scanner() {
  setup
  echo hi >"$NETZAR_CLONE/my notes.txt"
  out="$(SCAN_STUB_RC=1 bash "$SCRIPT" check 2>&1)"; rc=$?
  eq "$rc" 1 "hit exit"; has "$out" "CLONE NOT CLEAN: my notes.txt:3: [stub-id]" "hit on path with spaces"
  case "$out" in *excerpt-fragment*) fail "excerpt echoed" ;; esac
  out="$(SCAN_STUB_RC=2 bash "$SCRIPT" check 2>&1)"; rc=$?
  eq "$rc" 1 "crash exit"; has "$out" "CLONE NOT CLEAN" "scanner crash fails closed"
  case "$out" in *"CLONE CLEAN"*) fail "crash reported clean" ;; esac
  rm "$NETZAR_CLONE/scripts/ci/secret-scan.mjs"
  out="$(bash "$SCRIPT" check 2>&1)"; rc=$?
  eq "$rc" 1 "missing exit"; has "$out" "scanner missing" "missing scanner fails closed"
}

t_hook_stable() {
  setup
  eq "$(git -C "$NETZAR_CLONE" config core.hooksPath)" "$NETZAR_HOOKS" "hooksPath"
  [ -x "$NETZAR_HOOKS/pre-push" ] || fail "hook not installed"
  case "$NETZAR_HOOKS" in "$DIR"/*) fail "hook inside repo tree" ;; esac
  bash "$SCRIPT" check >/dev/null 2>&1 || fail "check with hook installed"
  rm "$NETZAR_HOOKS/pre-push"
  out="$(bash "$SCRIPT" check 2>&1)"; rc=$?
  eq "$rc" 1 "missing hook exit"; has "$out" "push guard" "missing hook"
  bash "$SCRIPT" init >/dev/null 2>&1 || fail "re-init"
  git -C "$NETZAR_CLONE" config --unset core.hooksPath
  out="$(bash "$SCRIPT" check 2>&1)"; rc=$?
  eq "$rc" 1 "unset hooksPath exit"; has "$out" "push guard" "unset hooksPath"
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

# the hook (not only `push`) consumes the approval, atomically: git runs it for a direct URL push too
t_hook_single_use() {
  setup
  cd "$NETZAR_CLONE" || fail cd
  git switch -q -c docs/x && echo y >y.txt && git add -A && git commit -qm y
  sha="$(git rev-parse HEAD)"
  printf '{"ts":"2026-01-01T00:00:00Z","sha":"%s","ref":"refs/heads/docs/x","owner_text":"yes","used":false}\n' "$sha" >"$NETZAR_APPROVALS"
  git push "$NETZAR_ORIGIN" HEAD:refs/heads/docs/x >/dev/null 2>&1 || fail "approved direct push refused"
  git --git-dir="$NETZAR_ORIGIN" update-ref -d refs/heads/docs/x
  git push "$NETZAR_ORIGIN" HEAD:refs/heads/docs/x >/dev/null 2>&1 && fail "approval reused after remote branch deleted"
  git --git-dir="$NETZAR_ORIGIN" rev-parse -q --verify refs/heads/docs/x >/dev/null && fail "ref recreated"
  eq "$(jq -s '[.[]|select(.event=="used")]|length' "$NETZAR_APPROVALS")" 1 "one used event"
  # concurrent pushes of one approval: exactly one wins
  echo z >z.txt && git add -A && git commit -qm z
  sha="$(git rev-parse HEAD)"
  printf '{"ts":"2026-01-01T00:00:00Z","sha":"%s","ref":"refs/heads/docs/y","owner_text":"yes","used":false}\n' "$sha" >"$NETZAR_APPROVALS"
  for i in 1 2 3 4 5; do
    ( echo "HEAD $sha refs/heads/docs/y 0000000000000000000000000000000000000000" | bash "$NETZAR_HOOKS/pre-push" origin url >/dev/null 2>&1 && echo ok >"$T/win.$i" ) &
  done
  wait
  eq "$(ls "$T"/win.* 2>/dev/null | wc -l | tr -d ' ')" 1 "concurrent winners"
}

# the clone holds no push credentials: a direct https URL with --no-verify has nothing to authenticate with
t_push_no_creds() {
  setup
  printf '#!/usr/bin/env bash\necho called >>"%s/cred.log"\necho username=u\necho password=p\n' "$T" >"$T/bin/credstub"
  chmod +x "$T/bin/credstub"
  printf '[credential]\n\thelper = %s/bin/credstub\n' "$T" >"$T/gitcfg"
  printf 'protocol=https\nhost=example.test\n\n' | GIT_TERMINAL_PROMPT=0 GIT_CONFIG_GLOBAL="$T/gitcfg" git -C "$NETZAR_CLONE" credential fill >/dev/null 2>&1 && fail "clone can fetch a credential"
  [ ! -s "$T/cred.log" ] || fail "global credential helper still runs in the clone"
  eq "$(git -C "$NETZAR_CLONE" config core.sshCommand)" /bin/false "ssh disabled"
  git -C "$NETZAR_CLONE" config --local --unset-all credential.helper
  out="$(bash "$SCRIPT" check 2>&1)"; rc=$?
  eq "$rc" 1 "check without cred block"; has "$out" "push guard" "check flags it"
}

# two installs never overlap, including during the playwright step
t_install_lock() {
  setup
  ( bash "$SCRIPT" install >"$T/first.out" 2>&1 & )
  for _ in $(seq 50); do grep -q 'start npx' "$STUB_LOG" && break; sleep 0.05; done
  grep -q 'start npx' "$STUB_LOG" || fail "first install never reached playwright"
  out="$(bash "$SCRIPT" install 2>&1)"; rc=$?
  eq "$rc" 1 "second install exit"; has "$out" "another install is running" "msg"
  for _ in $(seq 50); do grep -q 'INSTALL OK' "$T/first.out" && break; sleep 0.1; done
  grep -q 'INSTALL OK' "$T/first.out" || fail "first install did not finish"
  eq "$(grep -c 'start npm ci --ignore-scripts' "$STUB_LOG")" 1 "npm ci ran once"
}

# a failed attempt-log write must refuse the push (an unlogged push is not allowed)
t_hook_write_fail() {
  setup
  cd "$NETZAR_CLONE" || fail cd
  sha="$(git rev-parse HEAD)"
  printf '{"ts":"2026-01-01T00:00:00Z","sha":"%s","ref":"refs/heads/docs/w","owner_text":"yes","used":false}\n' "$sha" >"$NETZAR_APPROVALS"
  mkdir -p "$NETZAR_LOG_DIR/push-attempts.jsonl" # a directory: appends fail even for root
  echo "HEAD $sha refs/heads/docs/w 0000000000000000000000000000000000000000" | bash "$NETZAR_HOOKS/pre-push" origin url >/dev/null 2>&1 && fail "push allowed with unwritable attempt log"
  return 0
}

# the clone holds no credentials, so fetch must inject a per-command helper like push does (read path only)
t_fetch_cred() {
  setup
  printf '#!/usr/bin/env bash\necho "$*" >>"%s/git.log"\nexec %s "$@"\n' "$T" "$(command -v git)" >"$T/bin/git"
  chmod +x "$T/bin/git"
  NETZAR_FETCH_CRED="$T/bin/credstub" bash "$SCRIPT" fetch >/dev/null 2>&1 || fail "fetch"
  line="$(grep -E '(^| )fetch( |$)' "$T/git.log" | head -1)"
  has "$line" "credential.helper=$T/bin/credstub" "fetch carries the stub helper"
  case "$line" in *push*) fail "fetch helper on a push" ;; esac
  eq "$(git -C "$NETZAR_CLONE" config --local credential.helper)" "" "helper not persisted in the clone"
}

# npm's workers must die with the aborted install, not linger as orphans
t_install_lowmem_kill() {
  setup
  STUB_DROP="$T/drop" STUB_HANG="$T/hang.pid" bash "$SCRIPT" install >/dev/null 2>&1
  pid="$(cat "$T/hang.pid" 2>/dev/null)"; [ -n "$pid" ] || fail "stub never started"
  sleep 0.3
  if kill -0 "$pid" 2>/dev/null; then kill "$pid"; fail "grandchild survived the low-memory abort"; fi
}

# used:true or an empty owner_text is not an owner yes
t_hook_bad_approval() {
  setup
  cd "$NETZAR_CLONE" || fail cd
  sha="$(git rev-parse HEAD)"
  printf '{"ts":"2026-01-01T00:00:00Z","sha":"%s","ref":"refs/heads/docs/u","owner_text":"yes","used":true}\n' "$sha" >"$NETZAR_APPROVALS"
  printf '{"ts":"2026-01-01T00:00:00Z","sha":"%s","ref":"refs/heads/docs/e","owner_text":"","used":false}\n' "$sha" >>"$NETZAR_APPROVALS"
  for r in u e; do
    echo "HEAD $sha refs/heads/docs/$r 0000000000000000000000000000000000000000" | bash "$NETZAR_HOOKS/pre-push" origin url >/dev/null 2>&1 && fail "approval $r accepted"
  done
  return 0
}

# an edited installed hook is not the repo hook: check must notice
t_check_hook_hash() {
  setup
  bash "$SCRIPT" check >/dev/null 2>&1 || fail "check before tamper"
  chmod u+w "$NETZAR_HOOKS/pre-push"; printf 'exit 0\n' >>"$NETZAR_HOOKS/pre-push"; chmod 555 "$NETZAR_HOOKS/pre-push"
  out="$(bash "$SCRIPT" check 2>&1)"; rc=$?
  eq "$rc" 1 "tampered hook exit"; has "$out" "push guard" "tampered hook"
}

# a failed install must not leave a stamp that lets a later install skip over a half-written node_modules
t_install_stamp() {
  setup
  bash "$SCRIPT" install >/dev/null 2>&1 || fail "first install"
  ( cd "$NETZAR_CLONE" && echo '{"lock":"B"}' >package-lock.json && git commit -qam B ) || fail "commit B"
  STUB_FAIL=1 bash "$SCRIPT" install >/dev/null 2>&1 && fail "failing install passed"
  [ ! -e "$NETZAR_LOG_DIR/install-stamp" ] || fail "stamp survived a failed install"
  git -C "$NETZAR_CLONE" reset -q --hard HEAD~1
  : >"$STUB_LOG"
  bash "$SCRIPT" install >/dev/null 2>&1 || fail "third install"
  eq "$(grep -c 'start npm ci --ignore-scripts' "$STUB_LOG")" 1 "npm ci re-ran after the failed install"
}

CASES="t_check_clean t_check_dirty t_check_tracked t_check_scanner t_check_scanner_trackedt_hook_stable t_fetch t_install_serial t_install_drift t_install_lowmem t_push_refused t_push_approved t_hook_single_use t_push_no_creds t_install_lock t_hook_write_fail t_fetch_cred t_install_lowmem_kill t_hook_bad_approval t_check_hook_hash t_install_stamp"
if [ $# -gt 0 ]; then ( "$1" ); exit $?; fi
pass=0; total=0
for c in $CASES; do
  total=$((total + 1))
  if ( "$c" ); then pass=$((pass + 1)); echo "ok   $c"; else echo "FAIL $c"; fi
done
echo "SUMMARY: $pass/$total passed"
[ "$pass" = "$total" ]
