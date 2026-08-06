#!/usr/bin/env bash
# Publish gate (IaC readiness plan, item 30).
#
# Run this BEFORE pushing this repository anywhere public. It is the
# automated half of docs/publish-checklist.md:
#
#   (a) full-history secret + personal-value scan over ALL refs. Current-file
#       scrubbing says nothing about history; a value deleted three commits
#       ago is still one `git log -p` away.
#   (b) on ANY history hit, refuses and points at the orphan-export path
#       (scripts/publish/orphan-export.sh). History rewrite is NOT attempted.
#   (c) prints the secret-rotation checklist (manual steps).
#   (d) reminds that the fresh-clone smoke matrix must pass in a scratch
#       account before publish.
#
# This script makes NO network calls, NO pushes, and touches NO live account.
# It only reads the local git repository.
#
# Tooling: prefers gitleaks, falls back to trufflehog, falls back to a
# documented `git grep` loop over `git rev-list --all`. The personal-value
# list (scripts/publish/personal-values.txt, GITIGNORED, real values live
# only in the private checkout) is scanned with git grep in every case,
# because the generic tools cannot know your account id / domains / handles.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

PV_FILE="scripts/publish/personal-values.txt"
PV_EXAMPLE="scripts/publish/personal-values.example.txt"

# Same regex families as scripts/ci/secret-scan.mjs, in POSIX ERE form for
# git grep: AWS access keys, Slack tokens, Telegram bot tokens, PEM headers.
PATTERN_ERE='(AKIA|ASIA)[0-9A-Z]{16}|xox[abopr]-[A-Za-z0-9-]{10,}|[0-9]{8,10}:[A-Za-z0-9_-]{35}|-----BEGIN [A-Z ]*PRIVATE KEY-----'

HITS=0

note()  { printf '\n== %s\n' "$*"; }
fail()  { printf 'FAIL: %s\n' "$*" >&2; }

note "Publish gate: full-history scan over ALL refs"

# ── (a) secret-pattern scan over all history ──────────────────────────

if command -v gitleaks >/dev/null 2>&1; then
  echo "using gitleaks ($(gitleaks version 2>/dev/null || echo unknown))"
  if ! gitleaks detect --source . --log-opts=--all; then
    fail "gitleaks found secrets in history"
    HITS=1
  fi
elif command -v trufflehog >/dev/null 2>&1; then
  echo "using trufflehog ($(trufflehog --version 2>&1 | head -1 || echo unknown))"
  # --fail: nonzero exit (183) when results are found.
  if ! trufflehog git "file://$ROOT" --no-update --fail; then
    fail "trufflehog found secrets in history"
    HITS=1
  fi
else
  echo "gitleaks/trufflehog not installed; using the documented git-grep fallback"
  echo "(slower and pattern-only; install gitleaks for entropy-based detection)"
  # Every rev reachable from any ref, greped for the secret-pattern set.
  # xargs exits nonzero only on git-grep errors; git grep itself exits 0
  # when it MATCHES, which for us means a hit.
  if git rev-list --all | xargs -r git grep -I -n -E "$PATTERN_ERE" -- 2>/dev/null; then
    fail "secret-pattern hits in history (rev:file:line above)"
    HITS=1
  fi
fi

# ── personal-value scan (always, regardless of which tool ran) ────────

note "Personal-value scan (account ids, domains, handles, chat ids)"

if [ ! -f "$PV_FILE" ]; then
  fail "$PV_FILE is missing."
  echo "  The gate cannot certify a publish without the real personal-value" >&2
  echo "  list. Copy $PV_EXAMPLE to $PV_FILE (it is gitignored) and fill it" >&2
  echo "  with the real values from the PRIVATE checkout, then re-run." >&2
  exit 1
fi

PV_TMP="$(mktemp)"
trap 'rm -f "$PV_TMP"' EXIT
# Strip comments and blank lines; what remains are literal needles.
grep -v -e '^[[:space:]]*#' -e '^[[:space:]]*$' "$PV_FILE" > "$PV_TMP" || true

if [ ! -s "$PV_TMP" ]; then
  fail "$PV_FILE contains no entries (placeholders only?). Fill in the real values."
  exit 1
fi

echo "scanning all refs for $(wc -l < "$PV_TMP" | tr -d ' ') personal-value literal(s)..."
if git rev-list --all | xargs -r git grep -I -n -F -f "$PV_TMP" -- 2>/dev/null; then
  fail "personal-value hits in history (rev:file:line above)"
  HITS=1
else
  echo "no personal-value hits in any ref"
fi

# ── (b) refuse on history hits; point at the orphan export ────────────

if [ "$HITS" -ne 0 ]; then
  cat >&2 <<'EOF'

PUBLISH REFUSED: this repository's HISTORY contains secrets or personal
values. Do NOT push it to a public remote, and do NOT attempt a history
rewrite (filter-repo/BFG leave reflog/fork traps and are easy to get wrong).

Publish from a fresh orphan-commit export of the current tree instead,
the same way the public OS repo is cut:

    scripts/publish/orphan-export.sh /path/to/export-dir

That script re-runs the scan on the export before you push anything.
EOF
  exit 1
fi

echo
echo "History scan PASSED: no secret patterns, no personal values, in any ref."

# ── (c) rotation checklist (manual) ───────────────────────────────────

cat <<'EOF'

== Secret rotation checklist (MANUAL, do before or at publish)
Values that ever lived in a local .env or a teammate's shell are burned the
moment the repo goes public, even if the history scan is clean, because the
code documents exactly where they are used. Rotate:

  [ ] Telegram bot token        (BotFather /revoke + /token, then update
                                 Secrets Manager + re-register the webhook)
  [ ] Dashboard token           (re-issue; update Secrets Manager, redeploy)
  [ ] Encryption key            (rotate per docs/lifecycle.md; data re-wrap)
  [ ] Webhook secret            (rotate; re-run Telegram setWebhook)
  [ ] Kill phrase               (set a new one in runtime-config)

A rotation only takes effect for running tasks after a forced ECS
redeploy (secrets inject at task START).

== Fresh-clone smoke matrix (MANUAL, blocks publish)
Item 38's release matrix must pass in a SCRATCH account from a fresh clone
before publish, in BOTH modes:

  [ ] infra-only mode: preflight -> deploy -> verify -> image rollback ->
      secret-version rollback -> teardown (incl. break-glass drill) ->
      residuals match the documented intentional list exactly
  [ ] chat mode (Telegram fixture): same lifecycle with the chat surface
      verified end-to-end

The gate above is automated; these two blocks are not. docs/publish-checklist.md
is the full ordered list.
EOF

echo "Publish gate: automated checks PASSED. Complete the manual checklist above."
