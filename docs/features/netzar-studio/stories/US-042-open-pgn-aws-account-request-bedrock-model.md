# [US-042] Open PGN AWS account + request Bedrock model access (owner, drop-dead Nov 9)

> Backlog task NZR-42 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: OBJ-006.

## 1. User Story Statement
* **As a** Factory operator (the owner running the VPS gauntlet; Q54)
* **I want** a new, empty, standalone AWS account in `us-east-1` with Bedrock Claude access for the exact model ids the code calls, root MFA on, a billing alarm, and one admin identity that `npm run up` can use
* **So that** the drafter can be re-measured on the real model (Q58) and the pilot can be deployed (Q64), with the account ready by Nov 9 and an alert before spend passes the budget

---

## 2. Business Context & Description
* **Background:**
  * Q60: the owner opens the account and requests Bedrock this week (about 1 hour). Drop-dead Nov 9 (C1 gate). If Bedrock is not usable by Nov 23, C3 is re-planned. Q76 fixed the id: NZR-42.
  * Q64: this account hosts the managed pilot. Q91: the install is done with the repo's `npm run up`, not by hand. Q84/Q91: the old shared account is not a target. DEPLOY D4 (recommended): GitHub Actions does NOT deploy this account in 2026.
  * Q58/Q66: production (pilot-partner) reach stays blocked until the drafter eval is re-measured on Bedrock. That re-baseline cannot start until this story is done.
  * PRD: OBJ-006 (customer-owned infrastructure and enterprise controls). SECURITY.md §5 control 4: a dedicated AWS account for the pilot only, region pinned.
* **Current behaviour (d1d3a66): what the install expects from the account.**
  * A standalone account is a hard requirement: "the isolation scan refuses non-empty or Organizations-managed accounts, with no override flag" (`AGENTS.md:95-97`).
  * Account profile: the only signal that passes is Organizations answering "not in an organization" (`AWSOrganizationsNotInUseException`) and no Control Tower footprint (`scripts/lib/isolation/account-profile.ts:13-19`, `:81-86`, `:134`). Anything else, including an unreadable probe, fails closed.
  * Emptiness scan: deny-by-default over EC2 instances, non-default VPCs, EIPs, ECS clusters, DynamoDB tables, Lambda, ELBv2, CloudFormation stacks, Secrets Manager secrets, KMS customer keys, ECR repos, S3 buckets and IAM roles (`scripts/lib/isolation/scanner.ts:518-532`). Only the default VPC and service-linked / AWS default IAM roles are allowed (`scanner.ts:23-27`, `:152-170`). IAM users and AWS Budgets are NOT probed today (`scanner.ts:30-35` lists Budgets as a future probe).
  * Where the scan runs: `npm run validate:tier1` (read-only, Phase 3, `scripts/tier1-validate.ts:10`, `:97-100`) and `npm run bootstrap`, which hard-blocks before the first write (`scripts/bootstrap.ts:11-15`, `:661-670`). UNVERIFIED: whether `npm run up` runs the scan at all. `grep -n isolation scripts/up.ts scripts/deploy.ts` finds nothing; check `scripts/up.ts` step list at NZR-38.
  * Model ids the code calls (canonical, used when `.env` has no override): `infra/lib/constants.ts:254-261`:
    * `us.anthropic.claude-opus-4-7` (opus)
    * `us.anthropic.claude-sonnet-4-6` (sonnet; also the default model, `infra/lib/compute-stack.ts:357-360`)
    * `us.anthropic.claude-haiku-4-5-20251001-v1:0` (haiku; consolidator, `compute-stack.ts:849`)
    * `us.anthropic.claude-opus-4-7-1m` and `us.anthropic.claude-sonnet-4-6-1m` are synthetic ids: the base model plus the `context-1m-2025-08-07` beta, no separate grant (`src/lib/bedrock/models.ts:80-114`).
    * `amazon.titan-embed-text-v2:0` (knowledge embeddings; auto-enabled on first use, `docs/aws-getting-started.md:98`).
  * ADR 0003 says every Claude id uses the `us.` cross-region inference profile, which fans out to us-east-1, us-east-2 and us-west-2 ([ADR 0003](../../../adr/0003-bedrock-inference-profiles.md)); IAM grants those regions (`infra/lib/iam-stack.ts:180-185`). Note: ADR 0003 lists haiku as `us.anthropic.claude-haiku-4-5`, the code uses the dated id above. The code wins.
  * `npm run setup` lists the Claude inference profiles in the region and may pick the newest of each family into `.env` (`src/lib/bedrock/models.ts:1-10`, `scripts/setup.ts:341-375`). So the ids in the operator's `.env` can differ from the constants. The ids that matter are the ones in `.env` after setup.
  * Bedrock access today: Anthropic Claude needs a one-time use-case form in the model catalog; other models enable on first call (`docs/aws-getting-started.md:93-99`). Console URL: `https://console.aws.amazon.com/bedrock/home?region=us-east-1#/model-catalog` (`scripts/lib/onboarding/bedrock-access.ts:105-107`).
  * Probes: `npm run early-win` makes one real call on the first configured id (default model first, `scripts/early-win.ts:367-379`, `:431-459`). `probeBedrockAccess()` can probe every id (`scripts/lib/onboarding/bedrock-access.ts:308-322`) but no command calls it today (grep: only its test file). So an all-ids check is done by hand (Steps 7).
  * Default region `us-east-1`: `scripts/setup.ts:290`, `:320`; `examples/answers/infra-only-t0.json:2`; DEPLOY.md §1 (rebuild staging and pilot on Bedrock us-east-1).
  * Budget: the install itself creates a monthly AWS Budget with 80%/100% actual and 100% forecast email alerts (`infra/lib/cost-guardrails-stack.ts:94-121`, wired at `infra/bin/app.ts:326`), but only after the first deploy. Before that, nothing alerts. So the owner adds one by hand on day 1.
* **Target behaviour:**
  * A new AWS account exists, opened with a new email alias, not in any AWS Organization or Control Tower.
  * The root user has MFA on and no access keys. Root is not used after setup.
  * One admin identity exists for the install: an IAM user (recommended, see Agent gotchas) with MFA, AdministratorAccess, and one access key kept only on the operator machine.
  * An AWS Budget emails the owner at 80% and 100% of a monthly limit (recommended $300, from DEPLOY.md §4: typical $150–250/mo, worst case about $500).
  * Bedrock: the Anthropic use-case form is submitted in `us-east-1`, and one real call to each of the three Claude ids returns text.
  * The account id, region, grant date and exact model ids are written in the feature HANDOFF and a dated session handoff.
  * If Bedrock is still not usable on Nov 23, the C3 re-plan is recorded and the pilot date is reset with the owner.
* **Out of scope:**
  * Running `npm run up` / deploying anything (NZR-38). Creating a staging install (NZR-38, decision D1).
  * GitHub Actions / OIDC wiring for this account (DEPLOY D4: no in 2026). Changing `vars.AWS_ACCOUNT_ID` (DEPLOY risk 3: never).
  * The Bedrock eval re-baseline (NZR-14 / NZR-30, after this story).
  * Guarding the `staging` deploy branch (Q91, owner GitHub setting, tracked in NZR-38).
* **Target Value:** Account usable by Nov 9: `aws sts get-caller-identity` returns the new account, the Organizations probe says "not in an organization", and 3 of 3 Claude ids answer a test call in `us-east-1`. Measured by the evidence block in the session handoff.
* **User Persona Profile:** Factory operator (the owner running the VPS gauntlet; Q54). Has an AWS-capable laptop (the "operator machine"), a payment card and a phone for MFA. PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Account is standalone and reachable
* **Given** the owner opened a new account and configured the admin profile `nzr42-admin` on the operator machine
* **When** `aws sts get-caller-identity --profile nzr42-admin` and `aws organizations describe-organization --profile nzr42-admin` run
* **Then** the first prints JSON whose `Account` is the new 12-digit id and whose `Arn` ends in `:user/nzr42-admin`, and the second fails with `AWSOrganizationsNotInUseException`
* **Test:** evidence check › session handoff `handoffs/2026-11-DD-nzr-42-aws-account.md` "Evidence" block holds both outputs (Arn and account id, no keys)

### Scenario 2: Root locked down
* **Given** the account is open
* **When** the owner opens IAM → Security credentials as root
* **Then** "Multi-factor authentication (MFA)" lists at least 1 device, and "Access keys" lists 0 keys
* **Test:** evidence check › `aws iam get-account-summary --profile nzr42-admin` shows `"AccountMFAEnabled": 1` and `"AccountAccessKeysPresent": 0`, pasted into the session handoff

### Scenario 3: Billing alarm armed before any deploy
* **Given** the account is open
* **When** `aws budgets describe-budgets --account-id <id> --profile nzr42-admin` runs
* **Then** one budget named `nzr42-monthly` exists with a monthly `BudgetLimit` of 300 USD (or the owner's chosen number) and email notifications at 80% actual and 100% forecast
* **Test:** evidence check › budget name, limit and thresholds pasted into the session handoff

### Scenario 4: Bedrock access for every Claude id the code calls
* **Given** the Anthropic use-case form was submitted in `us-east-1`
* **When** the owner runs Step 7's call once for each of `us.anthropic.claude-sonnet-4-6`, `us.anthropic.claude-haiku-4-5-20251001-v1:0` and `us.anthropic.claude-opus-4-7`
* **Then** each call exits 0 and returns `output.message.content[0].text`; the grant date and the 3 ids are recorded in the HANDOFF
* **Test:** evidence check › session handoff lists each id with `exit 0` and the first 20 characters of the reply

### Scenario 5: Access still propagating or denied
* **Given** a call returns `AccessDeniedException` (for example "Your model access request is in progress", or not requested)
* **When** the owner re-checks after 30 minutes (the same wait `up` uses, `scripts/lib/onboarding/bedrock-access.ts:336-338`)
* **Then** if it still fails, the HANDOFF records the exact error code and message per id and the line "Bedrock not usable as of <date>"; the owner opens an AWS Support case (Basic plan, "Account and billing") the same day
* **Test:** evidence check › HANDOFF "Open owner items" holds the dated line and the support case number

### Scenario 6: Wrong id or region
* **Given** a call returns `ValidationException` ("The provided model identifier is invalid")
* **When** `aws bedrock list-inference-profiles --region us-east-1 --profile nzr42-admin` runs
* **Then** the HANDOFF records the id that does exist for that family, and the NOTES for NZR-38 say `.env` must use it (code constants are not edited in this story)
* **Test:** evidence check › the `inferenceProfileId` values for the Claude family are pasted into the session handoff

### Scenario 7: Account refused as managed or not empty
* **Given** the account was created inside an AWS Organization, or someone created a resource in it (an S3 bucket, a CloudTrail trail, an IAM role, an SSO permission set)
* **When** NZR-38 later runs `npm run validate:tier1`
* **Then** the scan reports `not-empty` or `unsupported-account-profile`; this story is re-opened, and the fix is a new standalone account (about 1 more owner-hour), never a deletion spree in the old one without the owner's yes
* **Test:** evidence check › story stays "done" only if Scenario 1 output shows `AWSOrganizationsNotInUseException` and the Step 9 "nothing else created" line is ticked

### Scenario 8: Bedrock not usable by Nov 23
* **Given** Scenario 4 is still failing on Nov 23
* **When** the Nov 23 gate runs
* **Then** the gate record says "C3 re-planned", names the new pilot date agreed with the owner, and NZR-38/NZR-48 dates are updated in the backlog
* **Test:** evidence check › `docs/features/netzar-studio/handoffs/2026-11-23-*.md` holds the decision line

---

## 4. Technical Notes & Constraints
* **Dependencies:** None to start. Blocks: NZR-38 (pilot deploy), the Bedrock re-baseline in NZR-14/NZR-30, NZR-48.
* **UI/UX Design:** N/A: owner task in the AWS console and a terminal. Guide to follow: [docs/aws-getting-started.md](../../../aws-getting-started.md) Steps 1–5, with the changes in Steps below.
* **Non-Functional Requirements:** Account is standalone and empty except for what Steps create. Region pinned to `us-east-1`. Cost before deploy: $0 except Bedrock test calls (a few cents). Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md) (C-07 production reach).
* **Data & Analytics:** N/A: no product event for this step; standard audit entries only.

* **Steps (who does what):**
  1. **Owner, 10 min. Create the account.** Sign up at `https://aws.amazon.com` with a NEW email alias (example: `aws-nzr42@<pgn-domain>`), PGN's payment card, phone verification. Do NOT use "add account" inside an existing AWS Organization: that makes it a member account and the install refuses it. Account name: `PGN Netzar pilot`. Wait for activation (minutes to a few hours).
  2. **Owner, 5 min. Lock root.** Sign in as root → IAM → Security credentials → assign MFA (passkey, authenticator app, or hardware key). Confirm no root access keys exist. Store the root email, password and MFA recovery in PGN's password manager, never in the repo or chat.
  3. **Owner, 5 min. Enable IAM access to billing.** Account menu → Account → "IAM user and role access to Billing information" → Activate. (Lets the admin user read budgets and Cost Explorer.)
  4. **Owner, 10 min. Create the admin identity.** IAM → Users → Create user `nzr42-admin`, attach `AdministratorAccess`, enable console access, assign MFA. Create one access key ("Command Line Interface"). On the operator machine only: `aws configure --profile nzr42-admin` (region `us-east-1`, output `json`). Never paste the key in chat, a file in the repo, or the VPS builder clone (that clone has no `.env` and no AWS keys, NZR-3). Where `npm run up` runs is NZR-38's call: DEPLOY.md §4 says the operator machine; US-038 Scenario 1 and the Q91 recommendation say the VPS. If the VPS, the key goes in a separate deploy checkout outside the builder clone (see NOTES).
     * Why not IAM Identity Center (SSO): AWS account access through Identity Center needs an AWS Organization, which the account-profile check refuses. UNVERIFIED against current AWS docs; if the owner prefers SSO, check first that it works without Organizations.
  5. **Owner, 5 min. Billing alarm.** Billing → Budgets → Create budget → "Monthly cost budget", name `nzr42-monthly`, amount $300 (owner may change), email the owner. Add a second alert at 100% forecasted. Also tick "Receive Free Tier usage alerts" in Billing preferences. Do not create SNS topics, CloudWatch alarms or a CloudTrail trail by hand (see gotchas).
  6. **Owner, 5 min. Request Claude access.** Open `https://console.aws.amazon.com/bedrock/home?region=us-east-1#/model-catalog`, pick an Anthropic Claude model, submit the one-time use-case form (company: PGN; use case: "business workflow drafting and document review for a pilot; test documents only").
  7. **Owner, 10 min. Prove each id answers.** On the operator machine (each call costs well under 1 cent):
     ```bash
     aws bedrock list-inference-profiles --region us-east-1 --profile nzr42-admin \
       --query "inferenceProfileSummaries[?contains(inferenceProfileId,'anthropic')].inferenceProfileId"
     for M in us.anthropic.claude-sonnet-4-6 us.anthropic.claude-haiku-4-5-20251001-v1:0 us.anthropic.claude-opus-4-7; do
       aws bedrock-runtime converse --region us-east-1 --profile nzr42-admin --model-id "$M" \
         --messages '[{"role":"user","content":[{"text":"Reply with the word OK"}]}]' \
         --query 'output.message.content[0].text' --output text && echo "PASS $M" || echo "FAIL $M"
     done
     ```
     If `converse` is missing, update the AWS CLI v2 (`aws --version`). If a profile id differs from the list in Step 7's first command, record the real one (Scenario 6).
  8. **Owner or Zion, 10 min. Record.** Write the session handoff (Artifacts) and update the feature HANDOFF "Open owner items" and "Current state".
  9. **Owner, 1 min. Confirm nothing else was created:** no S3 bucket, no trail, no IAM role, no VPC, no key pair, no Identity Center. Tick the line in the session handoff.
  10. **Zion, at the Nov 9 gate.** Read the HANDOFF; if any id still fails, start the Scenario 5 path; on Nov 23 apply Scenario 8.
* **Artifacts:**
  * `docs/features/netzar-studio/handoffs/2026-11-DD-nzr-42-aws-account.md` (session handoff, frontmatter per [feature framework](../../README.md) §6a): account id, account alias, region `us-east-1`, admin principal ARN, root MFA yes/no, budget name + limit, Anthropic form date, per-id result table `| model id | result | date |`, the Organizations probe line, the "nothing else created" tick, and open items.
  * `docs/features/netzar-studio/HANDOFF.md`: "Open owner items" line for NZR-42 changed to done (or the dated blocker) + a link to the session handoff.
  * Off-repo (PGN password manager): root credentials, MFA recovery codes, `nzr42-admin` console password. Never in the repo.
* **Evidence (what proves done):** the session handoff contains the outputs named in Scenarios 1–4, and `node scripts/ci/feature-knowledge.mjs` and `node scripts/ci/docs-links.mjs` pass on the docs commit.
* **Security notes:**
  * No secrets in the repo or chat: no access key, no password, no MFA code (C-14; `node scripts/ci/secret-scan.mjs` must stay at 0 findings). The account id and the IAM user ARN are not secrets and may be recorded.
  * Root is for account and billing tasks only. The access key belongs to `nzr42-admin`, lives only on the operator machine, and is rotated or deactivated after the first deploy (NZR-38 decides when; the bootstrap credential guard fails when a long-lived admin key is still in the environment, `scripts/bootstrap.ts:472-500`, and `docs/aws-getting-started.md:51` warns about the same). Option for NZR-38: use MFA-backed short-lived sessions from this user (`aws sts get-session-token`) instead of the raw key.
  * SECURITY.md §5 control 4: this account is for the pilot only. No dev, factory or VPS workloads in it. No cross-account trust.
  * Bedrock use-case form text says "test documents only", matching SECURITY.md §5 control 3.
  * Every AWS call is the owner's own action in this story (DEPLOY consent rule). Zion runs no AWS command against this account.
* **Test plan:** No code, no tests. Docs checks on the recording commit: `node scripts/ci/feature-knowledge.mjs`, `node scripts/ci/docs-links.mjs`, `node scripts/ci/secret-scan.mjs`.
* **Repo rules that apply:** Feature-doc rules ([docs/features/README.md](../../README.md)): session handoff per session, HANDOFF overwritten in place, frontmatter keys. Consent rule: no push/PR of the docs commit without the owner's yes (Q80).
* **Rollback:** Nothing in AWS to roll back. A wrong account (in an Organization, or not empty) is replaced by a new one; the old one is closed by the owner only (Account → Close account).
* **Build slices (proposal):** One owner session (~1 h): Steps 1–7. One recording session (~15 min): Steps 8–9.
* **Agent gotchas:**
  * The emptiness scan counts ANY non-service-linked IAM role (`scanner.ts:483-505`). Identity Center permission sets create `AWSReservedSSO_*` roles under `/aws-reserved/`, which are not on the allowlist (`scanner.ts:152-159`). A CloudTrail trail needs an S3 bucket, which is a finding. Budgets and IAM users are not scanned today.
  * `npm run early-win` only proves ONE id (the default). It does not prove opus or haiku. Use Step 7.
  * `.env` after `npm run setup` may hold newer ids than `infra/lib/constants.ts`. The eval result hash must record the id actually used (Q66).
  * ADR 0003's haiku id is stale. Do not "fix" the code to match it.
  * Do not set `vars.AWS_ACCOUNT_ID` in GitHub to this account (DEPLOY risk 3).
  * `aws-getting-started.md:51` says "Short-lived credentials (Option B) are preferred", but Option B is the long-lived IAM key. Do not copy that line; see NOTES.

---

## 5. Estimation & Tracking
* **Epic Name:** M0 Factory ready (cycle C0 Week 0: factory, security patch, foundation PLAN, 2026-10-20 to 2026-11-01)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 1 (raw estimate 1 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** N/A · **Deploy reach:** pilot · **Labels:** needs-owner, deploy, urgent

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified (owner = Factory operator; benefit = Bedrock re-baseline + pilot account).
- [ ] Acceptance criteria cover both happy paths and edge cases (standalone, root MFA, budget, 3 ids, pending/denied, wrong id, refused account, Nov 23 re-plan).
- [ ] UX/UI designs: N/A: owner task in the AWS console; guide = `docs/aws-getting-started.md` + Steps above.
- [ ] Dependencies have been identified and are unblocked (none). Owner has a payment card, a new email alias and an MFA device.
- [ ] The team has reviewed and estimated the story points (1 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70). N/A: no code; the two owner sessions above are the slices.

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] **Story exit gate (owner rule, all four required on the exact HEAD, evidence block recorded):** (1) code review: fresh critic, findings fixed or owner-waived; (2) unit tests: red SHA then green, full suite + typecheck; (3) UAT: every Given/When/Then scenario marked PASS and accepted; (4) E2E: run through the real entry point, happy + main failure path (or `N/A: reason` for docs/owner tasks). See [story-exit-gate](../story-exit-gate.md). Lessons in [LESSONS.md](../LESSONS.md) checked before PLANNING; any failure adds an entry with a guard. `PENDING` only for a gate needing an environment that does not exist yet (story is then Done locally).
- [ ] N/A: no code (owner/business task).
- [ ] Peer code review is completed and approved. N/A: owner/business task, no code. Evidence is the session handoff with the Scenario 1–4 outputs.
- [ ] N/A: no code; evidence is the artifact in the acceptance criteria. Docs checks green: `node scripts/ci/feature-knowledge.mjs`, `node scripts/ci/docs-links.mjs`, `node scripts/ci/secret-scan.mjs`.
- [ ] UAT: the owner confirms Scenarios 1–4 are met (or Scenario 5/8 is recorded).
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff (`handoffs/2026-11-DD-nzr-42-aws-account.md`); durable facts (account id, region, exact model ids) promoted to the NZR-38 runbook.
- [ ] Deployed to the PGN AWS pilot account with the owner's yes for that deploy; `npm run verify` green. N/A in this story: nothing is deployed here; the first deploy is NZR-38. Production reach stays blocked until the drafter is re-measured on Bedrock (Q58).
