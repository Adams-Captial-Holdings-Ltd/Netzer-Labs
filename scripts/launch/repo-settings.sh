#!/usr/bin/env bash
#
# Repo settings that gh api CAN set (IaC readiness item 36).
# The NOT-API-settable half (social preview image, rulesets, labels) lives in
# docs/launch-checklist.md as manual, browser-verified steps. Run BOTH at
# publish time.
#
# Requires: gh CLI authenticated with admin rights on the target repo.
# Idempotent — safe to re-run.
#
#   bash scripts/launch/repo-settings.sh
#
set -euo pipefail

# ── Edit these before running ────────────────────────────────────────
REPO="Adams-Captial-Holdings-Ltd/Netzer-Labs"
DESCRIPTION="Bedrock-native AI agent orchestrator — agents your team talks to in Slack/Telegram, running entirely in your AWS account. CDK-deployed, multi-agent, single-tenant."
HOMEPAGE="https://github.com/${REPO}#readme"
TOPICS=(aws bedrock cdk ai-agents slack-bot telegram-bot claude orchestrator infrastructure-as-code self-hosted)
# ─────────────────────────────────────────────────────────────────────

echo "==> ${REPO}: description, homepage, Discussions, merge hygiene"
gh api -X PATCH "repos/${REPO}" \
  -f description="${DESCRIPTION}" \
  -f homepage="${HOMEPAGE}" \
  -F has_discussions=true \
  -F has_wiki=false \
  -F allow_squash_merge=true \
  -F allow_merge_commit=false \
  -F allow_rebase_merge=true \
  -F delete_branch_on_merge=true \
  --silent

echo "==> ${REPO}: topics"
TOPIC_ARGS=()
for t in "${TOPICS[@]}"; do TOPIC_ARGS+=(-f "names[]=${t}"); done
gh api -X PUT "repos/${REPO}/topics" "${TOPIC_ARGS[@]}" --silent

echo "==> verify"
gh api "repos/${REPO}" --jq '{description, homepage, has_discussions, topics}'

cat <<'EOF'

Scripted half done. The MANUAL half still applies (docs/launch-checklist.md):
  - social-preview image upload (no API for this)
  - branch ruleset on main (code-owner review binding on docs/assets/**,
    required status checks, dismiss stale approvals)
  - tag rulesets for the v* / deploy/v* namespace split
  - issue labels: bug, deploy, enhancement, triage
  - private security advisories enabled
  - gh variable set AWS_ACCOUNT_ID (deferred until the adopter wires CI)
EOF
