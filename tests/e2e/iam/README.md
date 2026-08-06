# IAM copilot battle-test

Playwright UI smoke + guardrail test for the IAM policy copilot
(Security Posture → IAM). Drives the live dashboard with an admin token.

## Run

```bash
npm i --no-save playwright          # not a project dependency
npx playwright install chromium
export CCE_TOKEN="$(aws secretsmanager get-secret-value \
  --secret-id /claudeclaw/dashboard --region us-east-1 \
  --query SecretString --output text | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')"
node pwtest-iam/run.mjs            # set CCE_BASE to target a non-prod host
```

Screenshots (`*.png`, gitignored) are written next to `run.mjs`.

## Covers

- IAM tab + AI Policy Drafter render
- draft from plain English → valid policy (Version + Statement)
- apply: create managed policy (happy path)
- guardrail: modifying the orchestrator's own role is blocked

The test only applies when the kill switch is armed
(runtime-config `iam/apply_enabled = true`). The happy-path apply creates a
managed policy named `cce-copilot-pwtest-*`; delete any such leftovers with:

```bash
for a in $(aws iam list-policies --scope Local \
  --query "Policies[?starts_with(PolicyName,'cce-copilot-pwtest')].Arn" --output text); do
  aws iam delete-policy --policy-arn "$a"; done
```

A broader adversarial guardrail sweep (no-confirm, invalid action, own-role,
account-wide block/override, create-user, no-token 401) is run directly against
`/api/iam/*` — see the session notes.
