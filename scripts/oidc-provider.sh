#!/usr/bin/env bash
# Idempotent one-liner wrapper: create the GitHub Actions OIDC identity
# provider in the current AWS account (IaC readiness item 27).
#
# This is an ACCOUNT-LEVEL SHARED PREREQUISITE, deliberately not managed
# by CDK: other repos/workflows in the account may already depend on it,
# so creating/deleting it must never ride a stack deploy. Teardown
# classifies it report-only (see docs/out-of-band-catalog.md).
#
# Usage:
#   bash scripts/oidc-provider.sh           # create if missing, validate if present
#   AWS_PROFILE=... bash scripts/oidc-provider.sh
#
# After this succeeds, set CCE_CICD_ENABLED=1 plus CCE_GITHUB_OWNER /
# CCE_GITHUB_REPO / CCE_GITHUB_DEPLOY_REFS in .env (npm run setup asks
# these in Q11c) and deploy — the IAM stack then creates the deploy role
# with exact-subject trust.
set -euo pipefail

PROVIDER_URL="token.actions.githubusercontent.com"
AUDIENCE="sts.amazonaws.com"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${PROVIDER_URL}"

echo "account: ${ACCOUNT_ID}"

if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$ARN" >/dev/null 2>&1; then
  echo "OIDC provider already exists: $ARN"
  # Validate the audience list contains sts.amazonaws.com (a shared
  # account may have created it with a different client ID).
  AUDS=$(aws iam get-open-id-connect-provider \
    --open-id-connect-provider-arn "$ARN" \
    --query 'ClientIDList' --output text)
  if echo "$AUDS" | grep -q "$AUDIENCE"; then
    echo "audience OK: ${AUDIENCE} is in the ClientIDList"
  else
    echo "WARNING: ClientIDList (${AUDS}) does not include ${AUDIENCE}."
    echo "Add it with:"
    echo "  aws iam add-client-id-to-open-id-connect-provider \\"
    echo "    --open-id-connect-provider-arn $ARN \\"
    echo "    --client-id $AUDIENCE"
    exit 1
  fi
  exit 0
fi

# Thumbprint note: since 2023 AWS validates GitHub's OIDC cert against
# trusted CAs and ignores the thumbprint, but the API still requires one.
echo "creating OIDC provider ${PROVIDER_URL} (audience ${AUDIENCE})"
aws iam create-open-id-connect-provider \
  --url "https://${PROVIDER_URL}" \
  --client-id-list "$AUDIENCE" \
  --thumbprint-list "6938fd4d98bab03faadb97b34396831e3780aea1" \
  --tags Key=app,Value=claudeclaw Key=claudeclaw:component,Value=ci-prerequisite

echo "created: $ARN"
