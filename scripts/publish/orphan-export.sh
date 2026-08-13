#!/usr/bin/env bash
# Orphan-commit export (IaC readiness plan, item 30b).
#
# Creates a fresh single-commit export of the CURRENT tracked tree into a
# target directory: `git archive HEAD` (tracked files only; gitignored files
# like scripts/publish/personal-values.txt never leave) unpacked into the
# target, then `git init` + one commit. No history travels with it, which is
# the point: this is the publish path when publish-gate.sh finds hits in the
# ORIGINAL repo's history.
#
# The scan is re-run on the export before this script declares success.
# This script performs NO pushes; it prints the next steps and stops.
#
#   scripts/publish/orphan-export.sh <target-dir>

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET="${1:-}"

if [ -z "$TARGET" ]; then
  echo "usage: scripts/publish/orphan-export.sh <target-dir>" >&2
  exit 2
fi

if [ -e "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null)" ]; then
  echo "refusing: target directory $TARGET exists and is not empty" >&2
  exit 2
fi
mkdir -p "$TARGET"
TARGET="$(cd "$TARGET" && pwd)"

echo "== Exporting tracked tree at HEAD -> $TARGET"
git -C "$ROOT" archive HEAD | tar -x -C "$TARGET"

echo "== Initializing fresh history (one orphan commit)"
git -C "$TARGET" init -q -b main
git -C "$TARGET" add -A
git -C "$TARGET" commit -q --no-gpg-sign -m "Netzar OS Enterprise public export"

echo "== Re-running the scan on the export"
SCAN_ARGS=(--denylist "$ROOT/scripts/ci/denylist.txt")
PV_FILE="$ROOT/scripts/publish/personal-values.txt"
if [ -f "$PV_FILE" ]; then
  # The gitignored personal-value list doubles as a denylist here, so the
  # export is checked against the REAL values, not just generic patterns.
  SCAN_ARGS+=(--denylist "$PV_FILE")
else
  echo "WARNING: $PV_FILE missing; export scanned against generic patterns" >&2
  echo "         and the placeholder denylist only. Copy the example file" >&2
  echo "         and fill in real values for a meaningful personal-value scan." >&2
fi

if ! node "$ROOT/scripts/ci/secret-scan.mjs" "${SCAN_ARGS[@]}" "$TARGET"; then
  echo "EXPORT SCAN FAILED: the exported tree itself contains hits." >&2
  echo "Fix the tracked files in the source repo and re-export." >&2
  exit 1
fi

cat <<EOF

Export ready at: $TARGET
  - tracked tree at HEAD, single orphan commit, no history
  - scan re-run on the export: clean

Next steps (manual, nothing is pushed by this script):
  1. Finish docs/publish-checklist.md (rotation, smoke matrix, repo settings).
  2. Add the public remote:
       git -C "$TARGET" remote add origin <public-repo-url>
  3. Review one last time, then push:
       git -C "$TARGET" push -u origin main
EOF
