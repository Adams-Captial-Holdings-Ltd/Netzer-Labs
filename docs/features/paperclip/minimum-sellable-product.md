---
feature: paperclip
document_role: decision
status: accepted
observed_at: 2026-09-29
as_of_commit: 29309c8fab1d9b37121aee7d92f0efa0bb30fbc8
---

# Minimum Sellable Product: managed Solution Packs

What Netzer must build before it can sell a managed Solution Pack to a real customer, and deploy the same pack to the next customer without a fork. Transcribed on 2026-09-29 from the owner-approved Work Platform plan (2026-09-26). Nothing here is a new decision: the decisions are in the [decision log](decision-log.md) and [ADRs 0012-0020](../../adr/README.md), and the [DO NOT BUILD list](do-not-build.md) is binding. **Amended 2026-09-30** (Work Platform step 2, first commit, decision 27) to roadmap v2: the Customer #1 track is steps 1-14 and the after-go-live track is steps 15-18 (decisions 20-29, cross-plan rows X12 and X13).

Read the [feature README](README.md) for what runs today. This page describes what is being built and what "sellable" means. Where the code and this page disagree about present behavior, the code wins.

**Notation.** `nz:` means this repository. Line numbers were taken at `origin/development` `6c49661` when the plan was written; the citations of `src/lib/audit/audit-writer.ts`, `src/lib/state/runner-lease.ts`, `src/adapters/dashboard/paperclip-dispatch.ts`, `src/index.ts` and `infra/lib/paperclip-stack.ts` were re-checked at `29309c8` on 2026-09-29, and the others are as of plan time. `pc:` means paperclipai/paperclip. `@PIN` is v2026.722.0 (what Netzer runs) and `@LATEST` is v2026.916.1; `@NNN` marks the upstream release where a behavior appeared, as written in the plan. Labels: VERIFIED (checked against source), LIKELY (probable; a step-2 spike or contract test settles it), UNVERIFIED. Callouts headed "Later decision" apply decisions 16-29 and X1-X13, which were made after the roadmap's first text (2026-09-26). Text marked *v2* is the roadmap's own v2 wording.

## Context

The owner asked for a plan to finish the Paperclip integration. It widened into a first-principles architecture, with Paperclip as the work engine under a commercial Netzer product, and then narrowed to the question that matters for revenue: **what is the minimum that lets Netzer sell a managed Solution Pack to a real customer tomorrow, and deploy the same pack to the next customer without a fork?** Sections A-O answer that. "Target architecture" records the architecture that they are a safe subset of. "Build steps" gives the step numbering used across this record. The earlier 11-step "finish the integration" roadmap is superseded.

**Commercial model.** The customer buys a pack. Netzer staff install, configure, test and support it in the customer's own AWS account. One pack + customer configuration + connector mapping = many customers.

> **Later decision (decision 18).** Decision 18 (owner, 2026-09-28) limits what staff do in a customer's AWS account: they install, upgrade and remove packs and the platform with a limited login and see system health only. They never read customer data (see B10).

## A. Executive answer

**Yes.** Netzer can responsibly sell a managed Solution Pack once the ten MUST-HAVE items in B are built, the two step-2 feasibility spikes pass (held-request limit, shadow-user lifecycle), and the first pack passes the L release checklist.

*v2:* the owner widened the first sale (decision 20). All customer UI and designs ship too: the full Work UI, the Workflow Studio, dashboards, notifications, SSO, operator screens, the pack store and self-install, plus pack signing and a signed license. That is Customer #1 track steps 1-14 in [Build steps](#build-steps).

The rest of the long-term architecture is either manual for now, right after go-live, or deferred:

- the public marketplace and in-app checkout;
- upgrade and rollback (step 15, before the first pack update);
- the Cedar interceptor and the full audit mirror (step 16);
- automated billing.

Two items are **real blockers** and cannot be manual:

1. **Correct execution semantics.** Today Paperclip marks a run "succeeded" the moment Netzer answers, which causes duplicate AI work. This is VERIFIED in source.
2. **Retry-safe business actions.** An AI retry must never create a second EHR record or a second calendar booking.

> **Later decisions (decisions 16, 19, 24 and 26; roadmap v2).** Decision 16 (owner, 2026-09-27): the Behavioral Health Referral pack used as the example in this document is a staging-only **test** pack, never shipped and never a customer. In roadmap v2 (decision 26) step 13 proves the platform with it, and step 14 is the owner's first real pack, which passes the same L checklist on its own and goes to Customer #1. Decision 19 (Jev 0.98 for the pilot hand-off after go-live; owner, 2026-09-28: Customer #1 is a willing pilot): after go-live a hand-over block runs before customers 2-5, and the customer then maintains their own system. Under decision 24 that block is step 15 only, because step 14's old work (pack signing and the signed license file) moved into step 8.

## B. MUST HAVE

Blockers before the first paid customer. Each one fails the owner's risk filter.

| # | Capability | Why it is a blocker (risk if absent) |
|---|---|---|
| B1 | **Execution contract SYNC_ATTACH** (see B1 details below) | duplicate work, false "succeeded", corrupted workflow state |
| B2 | **Deterministic-writes-only + effect ledger** (see B2 details below) | duplicated business actions, skipped stages |
| B3 | **Paperclip re-pin to v2026.916.x + contract tests + fail-closed runtime check** (native runner off, no non-http agents, no remote profiles, tool-access off, timer heartbeats off on pack agents), private dispatch URL + SSRF allowlist, public route denied, telemetry off, **P0-0b image-build fix** (every staging trip and customer deploy builds the image) | a second ungoverned AI runtime (data leak); an exposed spend endpoint; untested upstream behavior; failed deploys |
| B4 | **Tool policy enforced in Netzer**: per-agent-role tool allowlist from the pack; write-deny for AI steps, **including `paperclip_add_comment`/`paperclip_create_subtask`**; approval-verified gated steps (see B5); `allowedAgents` enforced | dangerous actions without policy |
| B5 | **Shadow identities + approval write path + action-bound approvals** (see B5 details below) | misidentified approvals; approving X and executing Y |
| B6 | **PHI-safe audit + correlation**: Netzer WORM rows for every AI turn, tool call and human decision carrying the §15 IDs, **IDs and hashes only, no tool arguments or PHI**; human decisions and L1 writes use `writeAuditOrThrow` (`nz:src/lib/audit/audit-writer.ts:414`); Paperclip case events retained | no compliance trail, or PHI locked into 7-year WORM |
| B7 | **Minimum Work UI (4 screens)**: Work Inbox, Cases, Case Detail, Approvals (§H). Approvals show the exact action payload being approved. Inbox and Cases are thin lists. | the customer would need Paperclip's UI, which violates the identity and approval model |
| B8 | **Pack v1 format + install scripts**: `validate`, `preflight`, `install` (journaled, idempotent, config projection, mints pack-agent API keys, never logs the dispatch bearer), `activate`/`deactivate`, `status`, `effect resolve`; deployment registry + installation record; checksums + protected tags | non-repeatable installs, forks per customer, unrecoverable deploys, hand-edited ledgers |
| B9 | **Secrets and connectors**: pack declares requirements only; values live in AgentCore Identity (OAuth) or Secrets Manager (API keys); activation blocked unless every mandatory connector is READY and every model the pack uses is invocable in-region | credential exposure; dead-on-arrival workflows |
| B10 | **Recoverability + PHI eligibility**: joint restore drill (Aurora + EFS, which holds Paperclip's secrets master key, + the DynamoDB effect ledger) followed by a reconcile runbook; every PHI-carrying service confirmed HIPAA-eligible (Bedrock, AgentCore Gateway/Identity, Aurora, EFS, DynamoDB, S3, ECS, CloudWatch); Netzer↔customer BAA and a staff-access model signed at kickoff | unrecoverable deployment; compliance breach |

> **Later decisions (decision 18, X1).** X1 (release plan, 2026-09-26): customer installs verify the release, import its signed digests and **never build**. B3's remark that every customer deploy builds the image predates X1, which names only §C and §25 step 4; the two are not reconciled here. Decision 18 (owner, 2026-09-28) defines B10's staff-access model: **Netzer staff never access customer data.** In a customer's AWS account, staff use a limited login that can install, upgrade and remove packs and the platform, and see system health (status, counts, IDs and error codes). They cannot read cases, records, documents, secrets or content-bearing logs, open the Paperclip screens there, or grant themselves more access. The customer admin does anything that touches real data, with the Netzer runbook: entering secrets, connecting their systems (OAuth), looking at a stuck case, `effect resolve` decisions, UAT on their systems, and restores. `pack status` and alerts show IDs and counts only. **Open:** how installs run without staff holding data keys (for example an installer job inside their account) is decided in step 8 with Jev. The BAA stays only if counsel still requires it.

**B1 details: SYNC_ATTACH** ([ADR 0013](../../adr/0013-sync-attach-execution-contract.md)).

- **Hold and outcome.** Dispatch is held open for one execution attempt. 2xx comes back only after the outcome is written; failure returns non-2xx with an error code.
- **What counts as one attempt.** An attempt is identified by `(issueId, wake cause/revision)`, not by run ID. A genuine re-wake (a comment, an unblock) starts a new attempt. A retry of the same attempt attaches to it or gets its recorded result.
- **Leases.** Renewable, with a fencing token checked on every ledger write. There is attach/wait across ECS tasks. On SIGTERM no new L1 write starts, and scale-in protection covers tasks with attempts in progress.
- **Held-request limit.** Node fetch likely gives up after about 300 s (LIKELY; step-2 spike). If confirmed, attempts are capped at about 240 s and continue through a new wake.
- **Waits and pauses.** Waits end the attempt as `blocked`/`in_review` with a durable wait path. Pause is done by disabling routines and agents, never by 202 `agent_not_enabled` or 503 kill-switch replies, which would forge outcomes.

**B2 details: deterministic-writes-only + effect ledger** ([ADR 0013](../../adr/0013-sync-attach-execution-contract.md)).

- **Who writes.** Business writes happen only in deterministic L1 steps. AI (L2) steps read, analyze, recommend and draft.
- **The key.** The effect-ledger key is `(ingest caseKey, stage, step, stageEntryNo)`, which survives Request Changes rounds and database restores.
- **Retries.** A retry returns the recorded result.
- **Paperclip writes.** Paperclip writes (transition, review, comment) are ledgered with read-before-retry.
- **Unknown outcomes.** Unknown-outcome writes go to `blocked: verify`, never a blind retry.

**B5 details: approvals** ([ADR 0016](../../adr/0016-human-decisions-via-shadow-users.md)).

- **Shadow users.** Each approver gets a headless Paperclip shadow user (creation, membership and board key proven by the step-2 spike).
- **Decisions.** Approve, Reject and Request Changes each carry a comment, case, stage, timestamp and a Netzer audit row.
- **Frozen payload.** AI output is persisted once per `(case, stage, round)` and never regenerated after approval is requested.
- **Hash-bound approval.** The approval carries the sha256 of the exact L1 payload. The executor checks that hash and that `decidedByUserId` is a shadow user entitled to the decision class, so operator accounts never count.
- **Human-only by default.** High-impact decision classes are human-only.

## B+. Owner requirement before the first sale (decision 20)

Not a risk blocker; the owner's product bar. Every customer screen and its design ships before Customer #1. That covers:

- the full Work UI;
- the Workflow Studio;
- dashboards and notifications;
- SSO and operator screens;
- the pack store with self-install.

Each UI step passes the Design Gauntlet. Pack signing and the signed license move before go-live because self-install needs them. Delivered in [Build steps](#build-steps) steps 7-12.

## C. CAN BE MANUAL

Netzer implementation team, documented in the runbook:

- Connecting integrations: AgentCore Gateway targets and the Identity OAuth wizard.
- Creating secrets in Secrets Manager. *(D18 + v2: the customer admin does both, using the step-12 install screens with Netzer's runbook. Staff only create the Gateway targets through the limited login.)*
- Collecting customer configuration.
- Adding the entitlement entry to the registry.
- Running the install scripts in order.
- UAT sign-off, recorded in the registry.
- Scheduling and performing upgrades and rollbacks with the scripts.
- SLA escalation routines: staff configure a Paperclip routine per pack.
- Customer "automated decision policy" exceptions: recorded sign-off plus a config flag set by staff.
- Deploying the Netzer release into the customer account and the Paperclip tenant bootstrap. *(X1: customer installs verify the signed release and never build; D18: through the staff limited login.)*
- Monitoring: CloudWatch dashboards plus `pack status`.
- Pack authoring *(v2)*: staff and the owner use the Workflow Studio (step 9), which exports the pack format. Before step 9, use the operator Paperclip SPA or JSON.
- Shadow-user key rotation and RBAC sync, for ten or fewer approvers. Staff follow a runbook, but creating a shadow user and attributing decisions to it are automated in B5.
- Running the §J test scenarios by hand until the step-13 CI harness lands. The checklist is always required.

> **Later decisions (X1, X11, decision 18).** X1 (release plan, 2026-09-26): customer installs verify the release, import its signed digests and **never build**, as the deployment bullet above now states. X11: where the customer-hosted docs conflict with managed installs, the managed model wins, and release step 10 reconciles them. Under decision 18, work that touches real customer data (entering secrets, connecting their systems by OAuth, looking at a stuck case, `effect resolve` decisions, UAT on their systems, restores) is done by the customer admin with the Netzer runbook.

## D. SHOULD HAVE NEXT (after Customer #1, steps 15-17)

For customers 2-5:

- **Upgrade and rollback scripts** (`pack upgrade`, including the permission diff, and `pack rollback`). These are required before the first pack UPDATE ships, not before the first sale.
- AgentCore request interceptor + Cedar policies (defense in depth; approvals verified at the Gateway).
- Full WORM mirror of Paperclip case/approval events.
- Ledger budget partitions per pack/pipeline.
- Upstream pipeline-portability PR.
- Migrating existing Netzer vendor tokens (Slack/Salesforce) to AWS; retiring `salesforce_record`.
- Prod-provisioning guard for Netzer's own production (P0-0b moved into B3).
- *(v2: signing, chat notifications, Work UI v2, the CI pack harness and the operator UI moved into the Customer #1 track: steps 8, 10, 13 and 11.)*

> **Later decisions (decisions 19 and 24; roadmap v2).** After Customer #1 goes live on the managed path (step 14, staff limited login), the hand-over block (step 15) runs before customers 2-5 (decision 19): `pack upgrade` (with the permission diff the customer admin must acknowledge) and `pack rollback`, the customer platform-update path (release step 13) and a hand-over runbook. Pack updates arrive with new Netzer releases. Customer #1 is handed over as the pilot, and the staff login is then removed. Decision 24 moved step 14's old work (pack signing and the signed license file) into step 8, so after go-live the order is 15 → 16 → 17 → 18. **Open, with Jev:** how a customer updates the platform without receiving source code; the options are a customer-approved deploy by Netzer's pipeline through a data-blind role, or signed pre-built templates run by an in-account job.

## E. DEFER

Do not build before revenue:

- Public marketplace, third-party publishers, in-app checkout, self-service uninstall. *(v2: the in-app pack store with licensed self-install is step 12.)*
- AWS Marketplace, automated or usage-based billing.
- Automatic upgrades and migrations.
- Customer-built workflows and routines. Customers edit only a pack's exposed settings (decision 21); the Studio, for staff and the owner, is step 9.
- Pack recommendations, ratings and reviews, multi-region catalog.
- Complex dependency resolver: v1 packs have no pack-to-pack dependencies.
- SAML and SCIM (OIDC SSO is step 11).
- Netzer runtime on AgentCore Runtime.
- Amazon Quick integration.
- Phase 8.5 org/goals chat verbs.

**Verified:** none of these is needed to satisfy the B-list risks.

## F. Minimum pack format (v1)

Reuses Paperclip and Netzer formats; no invented workflow schema. Decision: [ADR 0018](../../adr/0018-managed-solution-packs-v1.md).

```text
behavioral-health-referrals/            # dir in private repo `netzer-packs`; release = protected tag
│                                       #   behavioral-health-referrals/v1.0.0 + tarball sha256 (immutable)
├── pack.json                           # identity + requirements (fields below)
├── paperclip/
│   ├── bundle/                         # Paperclip company-portability bundle (agentcompanies/v1, same code path
│   │                                   #   the teams catalog uses): projects, seed tasks, agent ROLE records
│   │                                   #   (imported with adapter override → http → Netzer)
│   ├── routines/*.json                 # native Paperclip create-routine bodies (triggers, variables, concurrency)
│   └── pipelines/*.json                # native create-pipeline body + transitions (INTERIM: deleted when upstream
│                                       #   portability ships). Placeholders ${config.x} ${agent:role} ${routine:key}
├── agents/*.yaml                       # the ONE canonical Netzer agent format (persona, model, tool allowlist,
│                                       #   skills, knowledge scope); also used by templates, manual and imported agents
├── skills/*.md                         # instruction assets referenced by agents/*.yaml
├── config/schema.json                  # types: string | number | boolean | enum | secretRef | connectorRef
├── connectors.json                     # capability → AgentCore target + scopes; tool aliases per capability
├── policies.json                       # tool risk overrides, approval-gated steps, decision classes (human default)
├── tests/checklist.md, tests/scenarios/*.json
├── migrations/<from>-<to>.md           # manual steps + rollback steps
└── docs/customer.md, implementation.md, support.md, CHANGELOG.md
```

**`pack.json` v1 fields.** The owner's list, plus four additions (marked ✚):

- `id`, `name`, `version` (semver), `description`, `industry`;
- `compatibility.netzer` (min), `compatibility.paperclip` (min + tested);
- `resources` (paths), `agents` (roles, default definition, `mappable`);
- `requires.connectors`, `requires.permissions` (Netzer capabilities + per-role tool list), `requires.config` (schema ref), `requires.secrets` (names + store);
- ✚ `decisionClasses` (high-impact classes default `human_required`);
- ✚ `dataClasses` (e.g. `PHI`), for the customer's compliance review;
- ✚ `supportOwner`;
- ✚ `checksums` ref.

The exact file shapes and the rules `pack validate` enforces are in [pack format v1](pack-format.md) (frozen 2026-10-02, ADR 0021).

Nothing else is needed for v1.

## G. Minimum installation process

A runbook. ★ = must be a script, never hand-run.

| Step | What happens | Tooling |
|---|---|---|
| 1 | Validate environment: Netzer release, AWS region, AgentCore availability, Aurora backups on | ★ `pack preflight` |
| 2 | Validate Netzer version ≥ `compatibility.netzer` | ★ |
| 3 | Validate Paperclip digest ∈ tested set and instance settings (native runner off, apps off) | ★ |
| 4 | Validate entitlement (customer → pack in registry) | ★ |
| 5 | Validate connectors: READY / MISSING per capability via AgentCore target probe | ★ |
| 6 | Validate config against `config/schema.json`; secret refs exist (names only) | ★ |
| 7 | **Dry run** (default): Paperclip import preview + pipeline/routine plan diff | ★ `pack install` |
| 8 | Import the bundle (`existing_company`, collision `skip`, adapter override; semantics contract-tested in step 2) → mint pack-agent API keys into Secrets Manager → create routines per pipeline key (disabled; ingest routines must be `always_enqueue`) → create pipelines under key `<pipeline>.v<major-minor>` → remap IDs → write agent configs versioned by pipeline key → set per-agent concurrency → write installation record. The dispatch bearer never appears in dry-run output or the journal. | ★ `pack install --apply` (journaled; re-run resumes) |
| 9 | Run test scenarios (§J) | ★ `pack test` + manual |
| 10 | Customer acceptance test on customer-connected systems; record sign-off | manual + registry PR |
| 11 | Activate: enable routines/ingest; refused unless 5, 6, 9 and 10 passed | ★ `pack activate` |
| 12 | Monitor / support | `pack status`, dashboards |

**Upgrade.** `pack upgrade --to v1.0.1` runs a permission/connector **diff that must be acknowledged**, then steps 1-11 against new pipeline keys. **Rollback:** `pack rollback --to v1.0.0`. Both scripts are step 15 (hand-over), which must land **before the first pack update ships**. The first sale is a v1.0 install and needs neither.

> **Later decisions (X1, X2).** Steps 2-3 above are refined by X2: preflight verifies the deployed release's signature; the running ECS digests must equal the signed digests, and the signed Paperclip digest must be in `compatibility.paperclip.tested`. The deploy-manifest `release` field is only a pointer. Work Platform step 8 depends on release step 4. X1 applies to the environment step of the customer deployment model (§25): the install verifies the release and never builds.

## H. Minimum Work UI

Netzer-native, on Paperclip's API through a Netzer BFF; RBAC `work:read`, `work:approve`. Decision: [ADR 0017](../../adr/0017-netzer-identity-and-work-ui.md).

1. **Work Inbox:** items needing this person. Approvals waiting on them, blocked cases (connector/config/failed), cases they own.
2. **Cases:** active workflow instances for the installed packs. Filter by pack, stage and status.
3. **Case Detail:**
   - current stage and status;
   - owner (agent or human);
   - key fields;
   - timeline (case events + issue comments);
   - agent activity (turns and tool calls from the Netzer audit);
   - blockers;
   - approvals.
4. **Approvals:** a queue plus Approve / Reject / Request Changes with a required comment.

`/missions` redirects to Work Inbox. These four screens are step 7.

*v2, also before Customer #1:*

- step 9 Workflow Studio: a designer and editors for staff; customers get a read-only flow map plus config values;
- step 10: Active Workflows, Automations, SLA status, dashboards and notifications;
- step 11: SSO and operator screens;
- step 12: pack store and self-install.

Every UI step is checked against the web app's `design.md`, which step 7 creates.

## I. Minimum security controls

- **Secrets:** no embedded secrets. `pack validate` runs a secret scan and rejects literals in `config`, routines and pipelines.
- **Connectors:** least privilege per pack. Gateway targets are scoped to the pack's capabilities, the tool allowlist is per agent role, and AI steps cannot call write tools.
- **Tenant isolation:** single-tenant AWS account per customer, one Paperclip company.
- **No silent permission growth:** upgrades show a permission/connector/tool diff that requires explicit acknowledgement, recorded in the registry.
- **Approvals:** identity preserved (shadow users). High-impact decision classes are human-only unless a customer automated-decision policy is recorded.
- **Audit:** a WORM row for every turn, tool call and decision.
- **Config** validated at install, activate and runtime.
- **Workflow input is untrusted:** framed prompts, the Bedrock guardrail, outbound DLP, and no write tools in AI steps.
- **Tool calls** only via Netzer's runtime. Netzer holds the only IAM role that can invoke the Gateway.
- **✚ Paperclip is unreachable by customers:** Paperclip sign-up disabled; telemetry off. *(D18: in customer accounts staff never open the Paperclip SPA; the SSM operator access applies to Netzer's own environments only.)*
- **✚ Dispatch endpoint** on the private address only; bearer rotated at install.
- **✚ Recoverability:** Aurora automated backups plus one restore drill before go-live.
- **✚ PHI hygiene:**
  - Audit rows hold IDs and hashes, never tool arguments. Existing redaction is switch-gated, covers only top-level strings and lands in 7-year Object Lock (`nz:src/lib/audit/audit-writer.ts:306-323`), so it is not relied on.
  - Every PHI-carrying service is confirmed HIPAA-eligible.
  - The customer AWS BAA and the Netzer↔customer BAA are in place, with a staff-access model.
  - `dataClasses` may include `PHI` and `42CFR2`.
- **✚ Approvals bound to actions:** sha256 of the L1 payload. Operator accounts can never satisfy an approval.

> **Later decision (decision 18).** Decision 18 supplies the staff-access model: in customer accounts staff never open the Paperclip screens. Whether the Netzer↔customer BAA is still required is open with counsel.

## J. Minimum testing gate

Per pack release; partly manual allowed. Happy path. Approve. Reject. Request changes. Forced agent failure. Forced connector failure. Retry with **no duplicate side effect** (effect-ledger check). Paperclip restart mid-execution. Netzer restart mid-execution. Duplicate dispatch. Duplicate webhook. Invalid configuration fails safely. Permission test (an agent lacks tools it does not need; an AI step cannot write). Customer acceptance test on customer-connected systems.

**Failure-handling matrix (must behave exactly like this; no silent failures):**

| Failure | What happens | Retries? | Recoverable? | Customer sees | Operator sees |
|---|---|---|---|---|---|
| Agent failure | attempt returns non-2xx `agent_failed` → run FAILED | per Paperclip classification; guardrail/policy denials non-retryable | yes; case stays at stage; after max attempts the issue goes `blocked` | Inbox: "needs attention" | failed run, audit row, `pack status` alert |
| Bedrock timeout/throttle | transient code | yes (in-attempt backoff, then Paperclip ≤3×) | yes | nothing unless exhausted | retry trail |
| MCP/target unavailable | deterministic step transient failure; **unknown-outcome writes are not retried** → `blocked: verify` | only when the outcome is known not-sent | yes | Inbox item | effect-ledger entry `unknown` to reconcile |
| OAuth expired | non-retryable `connector_auth` → issue `blocked` | no | yes after re-auth; operator re-queues | "Connector needs re-authorization" | alert |
| Missing connector | activation refused; at runtime same as OAuth expired | no | yes | same | preflight MISSING |
| Human does not approve | review stage waits (durable wait); staff-configured SLA routine escalates | n/a | yes | Approvals queue, escalation | SLA view (CLI) |
| Duplicate webhook | routine HMAC + idempotency key + `caseKey` ingest → one case | n/a | n/a | one case | dedupe log |
| Duplicate dispatch | attaches to the running attempt / returns the recorded result | n/a | n/a | nothing | attach log |
| Paperclip restart | Netzer finishes the attempt and records it; Paperclip retries → attaches → SUCCEEDED | automatic | yes | nothing | reaped run + attach |
| Netzer restart | connection drops → run FAILED → retry → new attempt after lease; L1 steps already done are skipped by the effect ledger; AI steps re-run (read-only) | automatic | yes | nothing (latency) | new attempt number |
| Invalid config | install/activate refused; runtime → `blocked: config` | no | yes | Inbox item (admins) | validation error |
| Daily cost cap exhausted | non-retryable `cost_cap` → issue `blocked: cost cap` (not burned through retries) | no | yes, after staff raise the cap or the day resets and re-queue | Inbox (admins) | alert |
| Bedrock model not enabled in region | caught by `pack preflight` model probe; at runtime non-retryable `model_access` → blocked | no | yes | Inbox (admins) | alert |
| Two distinct referrals during one run | ingest routine `always_enqueue` → two cases (validated by `pack validate`) | n/a | n/a | two cases | — |
| Netzer deploy/scale-in mid-attempt | SIGTERM: no new L1 writes; fencing token rejects stale writes; the attempt resumes on the next dispatch | automatic | yes | nothing | attempt log |

## K. Minimum licensing model

A private, Netzer-internal **deployment registry** (git repo `netzer-deployments`, PR-reviewed, **no PHI, PII or secrets**) holds one `customers/<id>.yaml` per customer:

- customer, AWS account alias, region;
- Netzer and Paperclip versions;
- `licensedPacks`;
- per installation: pack, version, non-secret config values, secret *names*, connector mapping, test/UAT/activation records.

`pack preflight|install|activate|upgrade` refuse unless the pack is listed. The installation record written into the customer deployment carries `entitlementRef` (the registry commit). Enforcement works because customers receive pack artifacts only through Netzer staff.

*v2 (step 8, decisions 24-25):* customers self-install from the store, so enforcement no longer relies on staff delivery.

- Staff mint a **signed license file** from the registry, bound to the customer's AWS account.
- The in-account installer checks it **offline** through the same `checkEntitlement()` seam. The packs come inside the signed Netzer release (decision 29). There is no call-home and no remote kill switch (D17).

The registry stays git. A database or AWS Marketplace entitlement replaces the source behind the same seam only at self-purchase (decision 25).

> **Later decisions (decisions 17, 19 and 24).** Decision 17 (owner, 2026-09-28): resale is forbidden and a customer who stops paying keeps what they have. A lapsed customer may keep running the copy they already have (no remote kill switch, no call-home). Reselling, redistributing or sublicensing Netzer or a pack is forbidden, and the license says so (counsel, release step 11). It is backed by what the plans already do: no source code in customer accounts; signed updates and packs only from Netzer staff; and the per-customer `deploymentId` in logs and audit rows (§15). The account-bound signed license file was to stay in step 14, not before Customer #1; the owner moved it into step 8, before Customer #1, because self-install needs it (decision 24, 2026-09-29). It gates new installs and upgrades only; the rest of decision 17 stands. Decision 19 (Jev 0.98 for the pilot hand-off; owner, 2026-09-28): the hand-over block is step 15 only.

> **Later decision (X10).** The new repos `netzer-packs` and `netzer-deployments` get the release plan's ruleset shapes (release step 3): `*/v*` tags are immutable, and branches need a PR with zero approvals.

## L. Release checklist

Authoritative v1. A pack is SELLABLE only when every box is checked.

- **Identity and release**
  - [ ] Pack ID assigned; semver version assigned; CHANGELOG entry
  - [ ] Released as a protected tag + tarball sha256; releaser in the release group
- **Contents and security**
  - [ ] `pack validate` green: schema, placeholders resolve, **no secrets**, no customer identifiers
  - [ ] Pipelines validated against Paperclip's schema (contract-tested digest); routines validated
  - [ ] Agents in canonical format; each role's tool allowlist minimal; AI roles have no write tools
  - [ ] Skills present and referenced
  - [ ] `decisionClasses` declared; high-impact classes human-only; approval-gated steps declared
  - [ ] Required connectors, scopes and tool aliases documented; permissions documented; `dataClasses` declared
  - [ ] Config schema complete; defaults safe; invalid config fails safely (tested)
- **Tests**
  - [ ] Happy path passed
  - [ ] Approve / reject / request changes passed with real-person attribution
  - [ ] Agent and connector failure passed
  - [ ] Retry passed with no duplicate side effects
  - [ ] Paperclip and Netzer restart tests passed
  - [ ] Duplicate dispatch and duplicate webhook passed
  - [ ] Permission test passed
- **Operability**
  - [ ] Work UI shows the pack's cases, stages, fields, and approvals with the exact action payload
  - [ ] Joint restore drill (Aurora + EFS + effect ledger) done on staging; reconcile runbook written
  - [ ] Ingest routines are `always_enqueue`; per-agent concurrency set; timer heartbeats off
  - [ ] From v1.1 on: upgrade from the previous version tested; migration + rollback instructions written; rollback rehearsed
- **Documentation and ownership**
  - [ ] Customer doc, implementation guide, support guide, release notes
  - [ ] Support owner assigned
- **Reuse**
  - [ ] Reuse test (§26): installed with a second customer's config (Customer-B values, a different connector alias mapping) on a clean staging company (the same account reset between runs is fine) **with zero source change**

## M. Missing Netzer capabilities

The exact code still needed, as of plan time. Files marked (planned) do not exist yet.

| Capability | Where |
|---|---|
| SYNC_ATTACH dispatch, part 1: attempt identity `(issueId, wake cause/revision)`, renewable lease + fencing token (today `tryClaimOnce` has neither, `nz:src/lib/state/runner-lease.ts:113-124`), cross-task attach/wait with result record | `nz:src/adapters/dashboard/paperclip-dispatch.ts`, `src/lib/paperclip/dispatch-worker.ts:92-105`, `runner-lease.ts` |
| SYNC_ATTACH dispatch, part 2: outcome-then-2xx, error codes (`agent_failed`, `connector_auth`, `cost_cap`, `model_access`), blocked waits, completion writer with `X-Paperclip-Run-Id`, `pending_dispatch` sweep; remove the forging 202/503 replies (`paperclip-dispatch.ts:152-155,191-193`) | same files |
| SYNC_ATTACH dispatch, part 3: SIGTERM drain (no new L1 writes; today force-exit after 28 s, `nz:src/index.ts:124-127`) and scale-in protection | same files, infra |
| Deterministic step executor + effect ledger keyed `(caseKey, stage, step, stageEntryNo)`, covering Paperclip writes; approval hash check; `pack effect resolve` | new `src/lib/work/executor.ts` (planned), DynamoDB table |
| Frozen AI output per `(case, stage, round)` for approval | new `src/lib/work/drafts.ts` (planned) |
| Tool policy: role allowlists, AI write-deny, approval-verified gated steps, `allowedAgents` enforced | `nz:src/lib/tools/registry.ts`, `src/lib/mcp/*` |
| Correlation IDs (turn ID) + audit row per tool call + human decision audit | `nz:src/agent/agent-loop.ts`, `src/lib/audit/*` |
| Shadow-user provisioning + per-user board keys + rotation + approval write path | new `src/lib/paperclip/shadow-users.ts` (planned), bootstrap |
| Work BFF + 4 screens + capabilities `work:read` / `work:approve` | `nz:src/adapters/dashboard/*`, `web/src/pages/work/*` (planned), `src/lib/auth/permissions.ts` |
| Pack CLI (`validate`, `release`, `preflight`, `install`, `test`, `activate`, `status`, `upgrade`, `rollback`) + installation record + config projection + connector readiness probe | new `scripts/pack/*` (planned), `src/lib/packs/*` (planned) |
| Canonical agent format adopted by templates, manual and imported agents (one schema) | `nz:src/lib/agents/templates.ts`, `src/lib/config/agent-loader.ts` |
| Re-pin: contract suite, instance settings, fail-closed check, private dispatch, telemetry off, patch deleted | `vendor/paperclip`, `infra/lib/paperclip-stack.ts`, `tests/contract/paperclip` (planned) |

## N. Missing Paperclip capabilities

| Gap | v1 workaround | Later |
|---|---|---|
| Pipelines not portable | serialized native create bodies applied by `pack install` | upstream PR; delete the interim files |
| No pipeline definition versioning | key per pack version. **Verified:** old key must stay un-archived until drained (archive blocks transitions); only new ingest moves | upstream versioning |
| No automation dispatch worker | Netzer sweep via `…/automation/retry` | upstream fix |
| Finished issue doesn't advance the case | completion writer transitions/reviews | — |
| No external run outcome API | SYNC_ATTACH (HTTP status = outcome) | — |
| Routines portable only as recurring tasks | serialized native routine bodies | upstream |
| No outbound events | reconciler polling (`updatedSince` native @824) | — |
| Approvals board-only | shadow users with per-user board keys (VERIFIED `board_api_keys.user_id`) | — |
| UI: no base path, email/password only | customers never use it; operators use it over SSM in Netzer's own environments (D18: staff never open it in customer accounts) | — |
| Pipelines "experimental" | contract tests on every route used | — |
| Routine concurrency can merge or skip triggers while a run is active (LIKELY) | ingest routines forced to `always_enqueue`; two-webhook test | — |
| Per-agent concurrent-run limit (LIKELY default 1) | set per pack agent at install; timer heartbeats off | — |
| Sign-up endpoint open at PIN even in `authenticated` mode (`nz:infra/lib/paperclip-stack.ts:454-462`) | step-2 spike at LATEST: sign-up closed, create user, add membership, mint board key, approve, revoke | — |
| Company import `existing_company` + adapter override + `skip` semantics unverified | step-2 contract test at both digests | — |

## O. First implementation order

Dependency-ordered (roadmap v2); see [Build steps](#build-steps) for steps 1-18.

1. Architecture/MSP record.
2. Re-pin + runtime lock + P0-0b + **feasibility spikes** (held-request limit, shadow-user lifecycle, import semantics, routine/agent concurrency).
3. **Pack format + schemas + `pack validate`** (the canonical agent schema, `policies.json`/`decisionClasses`, config, connectors, key-field metadata). Steps 5-8 depend on these.
4. Execution contract.
5. Safe actions + policy + PHI-safe audit.
6. Shadow identities + approvals.
7. Work UI core + `PRODUCT.md`/`design.md`.
8. Trusted install: tooling + registry + pack signing + signed license.
9. Workflow Studio.
10. Work UI more: workflows, automations, SLA, dashboards, notifications.
11. SSO + operator screens.
12. Pack store + self-install.
13. Behavioral Health test pack (authored in the Studio, installed from the store) + CI pack harness + restore drill. It is never shipped (decision 16).
14. The owner's first real pack passes the same SELLABLE gate, then Customer #1 managed deployment.

### Minimum customer configuration (§6)

`config/schema.json` is a JSON Schema subset with types `string`, `number`, `boolean`, `enum`, `secretRef` (name only), `connectorRef` (capability), plus `required` and `default`.

Values are stored in the registry, validated by `pack preflight`, and projected at install into:

- Paperclip routine variables and stage config (e.g. `escalation_hours`, `clinical_review_required`);
- the installation record that agents and the executor read at run time (e.g. `assessment_duration`, `default_location`).

Staff edit YAML in the registry. *(v2: customer admins edit the fields flagged `customerEditable` in a step-10 settings screen, journaled and applied to new cases only.)*

### Secrets (§7): authoritative locations (no duplicates)

| Secret kind | Home |
|---|---|
| OAuth tokens (Jira, M365, EHR OAuth) | AgentCore Identity token vault |
| API keys (e.g. `SMARTCARE_API_KEY`) | Secrets Manager, referenced by the Gateway target |
| MCP credentials | AgentCore Gateway target auth |
| AWS credentials | IAM roles only; no keys |
| Paperclip's own DB/auth secrets and per-user board keys | Secrets Manager |

Packs and the registry hold **names only**.

### Connector requirements (§8)

`connectors.json` declares each capability with scopes and **tool aliases**, e.g. `ehr.client.search → <target>__searchClient`. The alias mapping is customer config, so a different EHR vendor is configuration, not a fork. `pack preflight` probes each Gateway target with `tools/list` for the aliased tools and prints READY or MISSING. Activation is refused while any mandatory capability is MISSING.

### Canonical agent format (§9)

The v1 mechanism: a pack declares **roles**. The installer creates pack-namespaced agents from `agents/*.yaml` by default (e.g. `bhr-intake`). Config may map a role to an existing customer agent (`agentRef`), which must satisfy the role's tool allowlist. Templates, manual, imported and pack agents all use the same schema.

### Human approvals (§10)

The UI performs the approval. The Netzer BFF writes to Paperclip **as the approver's shadow user** (`approvals/:id/approve|reject` or the pipeline `review` with `approve|reject|request_changes`). Each decision records:

- approver (real person via shadow user);
- timestamp;
- comment (required for reject and request changes);
- case and stage.

A Netzer WORM audit row carries the Netzer user ID, shadow ID, decision class and correlation IDs. There is no delegation engine in v1.

### Versioning and rollback (§13-14)

**Every installation is recorded twice:** in the registry (customer → pack@version, config, test and UAT records) and in the customer deployment (installation record).

**Upgrades** are scheduled and performed by Netzer until hand-over. After step 15 (D19), the customer admin runs them from the store. Each needs:

- the current version;
- the target version;
- the CHANGELOG entry;
- `migrations/<from>-<to>.md`;
- rollback steps.

**Running cases stay pinned** to the pipeline key they started on. This is VERIFIED mechanics: separate pipelines per key; an archived pipeline blocks transitions, so the old key stays live until drained. Explicit migration is a manual, documented operation.

**Full pinning.** Each pipeline key has its **own routines**. The Netzer runtime picks the **agent config version from the case's pipeline key**, which arrives in the dispatch context. So a v1.0 case keeps v1.0 prompts and tools, and rollback never runs v1.1 cases on v1.0 agents.

**Rollback preserves:**

- the previous tarball (immutable tag);
- the previous pipeline key (still live);
- the previous agent configs (S3, versioned by pack version);
- the previous config (registry git history);
- migration notes.

`pack rollback` moves ingest back and restores configs. **No case is ever deleted.**

### Basic auditability (§15)

Minimum correlation IDs: `deploymentId` (customer) · `packId@version` · `pipelineKey` · `caseId` · `stageKey` · `issueId` · `paperclipRunId` · `attemptNo` · `netzerTurnId` · `agentId` · `userId` + `shadowUserId` · `toolCallId` + `effectKey` · `bedrockRequestId` · timestamp · outcome.

These are carried in dispatch, audit rows, structured logs and the effect ledger. Enough for support, compliance, failure diagnosis, billing disputes and incident response.

### Implementation-team experience (§23)

`pack status --customer <id>` prints: pack, version, customer, Paperclip digest/version, required connectors and their status, required config and its status, deployment/test/UAT/activation status, open blocked cases, last failures. It reads the registry and the installation record. *(v2: staff operator screens over it land in step 11, with IDs, counts and error codes only.)*

> **Later decision (decision 18).** In a customer account, `pack status` and alerts show IDs and counts only.

### First customer deployment model (§25)

| Step | What happens |
|---|---|
| 1. Purchase | registry PR adds the customer + `licensedPacks` |
| 2. Kickoff | runbook checklist: AWS account access, BAA, region, AgentCore availability, users/approvers list |
| 3. Requirements/config | staff fill `customers/<id>.yaml` config; validated with `pack validate --config` |
| 4. Environment | Netzer release deployed into the customer account; Paperclip bootstrap; runtime lock check green |
| 5. Connectors | staff create Gateway targets + Identity OAuth with the customer's admins; `pack preflight` all READY |
| 6. Install | `pack install` dry run → `--apply` |
| 7. Config applied | projection verified in `pack status` |
| 8. Netzer QA | §J scenarios on the customer environment with test data |
| 9. UAT | customer runs scenarios on their systems; sign-off recorded |
| 10. Activate | `pack activate` |
| 11. Monitor | first two weeks daily `pack status` + alerts |
| 12. Support | support guide runbooks; escalations logged |

> **Later decisions (X1, X11, decision 18).** Step 4 is refined by X1: the install verifies the release and imports its signed digests; it never builds. X11: where the customer-hosted docs conflict with the managed model, the managed model wins. Under decision 18, work that touches real customer data (entering secrets, connecting their systems by OAuth, looking at a stuck case, `effect resolve` decisions, UAT on their systems, restores) is done by the customer admin with the Netzer runbook, and staff use the limited login only to install, upgrade and remove packs and the platform and to see system health.

### Commercial reuse test (§26)

"Could we deploy this exact package to Customer B without changing source?" is enforced by the release checklist's reuse test: a second, differently configured staging tenant, zero source change. Anything customer-specific found there is architectural debt, tracked as a ledger item. Typical fixes: move it to config, or add a tool alias or capability.

### Things we explicitly do not need yet (§24)

Each verified not to hit the blocker filter:

- Public marketplace, third-party publishers, in-app checkout.
- Automated billing, AWS Marketplace, usage-based billing.
- Automatic upgrades and migrations.
- Customer-built workflows (the staff Studio is step 9).
- Pack recommendations, multi-region marketplace, ratings and reviews.
- Third-party signing infrastructure, complex dependency resolver.
- Self-service uninstall. Uninstall is staff-run: definition archived, data retained.

## Target architecture

Sections A-O are a safe subset of this architecture. The decisions behind it are the [ADRs](../../adr/README.md); this section keeps the parts that are not decisions.

**Principle.** Paperclip defines and tracks the work. Netzer performs the intelligent work and owns the customer experience, identity, governance, cost and audit. AgentCore connects to enterprise systems. The customer's AWS account hosts everything. Packs package the business logic.

### Responsibility matrix

| Capability | Netzer | Paperclip | AgentCore/AWS |
|---|---|---|---|
| Workflow definitions, cases, stages, transitions, business schedules/triggers, SLA timers | — | **Owner** (pipelines, routines, monitors) | — |
| Personal chat reminders | **Owner** | — | EventBridge |
| Human decisions | UX, identity, decision-class policy | **Record/authority** (via shadow users) | Cedar later |
| AI + deterministic execution | **Owner** (`runAgentTurn` + executor) | dispatch only | Bedrock |
| Agent definition + skills | **Owner** (one format) | shadow agent record | — |
| Connectors, credentials, tool policy | sole MCP client; enforcement v1 | tool-access OFF | **Owner** (Gateway, Identity, SM; Cedar next) |
| Identity/auth, RBAC | **Owner** | shadow users, least-privilege roles | IAM |
| AI cost | **Owner** (ledger) | budgets unused | Budgets mirror |
| Compliance audit | **Owner** (WORM) | operational history | CloudTrail |
| Customer UX | **Owner** (Work UI) | operator-only SPA | — |
| Packs, install, entitlement | **Owner** | content format + import API | S3/KMS |

### Architecture diagram (the committed system)

```text
Customer user ─ Netzer Work UI (Inbox · Cases · Case Detail · Approvals) / chat ─ Netzer identity + RBAC
        │ Netzer BFF ── writes decisions as the user's Paperclip SHADOW USER ───────────────┐
        ▼                                                                                  │
┌──────────── NETZER (customer AWS) ─────────────────────────────────────────────────────┐│
│ pack CLI + registry check + installation record · ledger · WORM audit · kill switches   ││
│ private /dispatch ─▶ attempt claim (attach) ─▶ runAgentTurn (L2: read/analyze/draft)     ││
│                                        └─▶ deterministic executor (L1 writes, effect ledger)│
│ tool policy (role allowlist, AI write-deny, approval-verified gated steps) ─▶ MCP client ││
└──────▲──────────────────────────────────────┬──────────────────────────────────────────┘│
  http │ held open per attempt (2xx = outcome  │ outcome writes: status, comments, work    │
       │  written; non-2xx = failed)           │ products, case transition/review          │
┌──────┴─────── PAPERCLIP (customer AWS; digest-pinned; contract-tested; customers never see it) ─┐
│ pipelines (key per pack version) · routines (triggers, SLA escalation) · issues · approvals ◀─┘ │
│ native runner OFF · local adapters OFF · tool-access OFF · SPA = operator-only                    │
└──────────────────────────────────────────────────────────────────────────────────────────────────┘
   Netzer MCP ─▶ AgentCore Gateway (targets scoped per pack) ─▶ [next: interceptor + Cedar]
               ─▶ AgentCore Identity / Secrets Manager ─▶ Jira · M365 · EHR …   (CloudTrail, KMS)
```

> **Later decision (decision 18).** In customer accounts staff never open the Paperclip screens; the SSM operator access applies to Netzer's own environments only.

### How a case runs

A routine or API ingest creates a case (the L1 ingest step resolves the pack's current pipeline key). Stage entry runs a routine → issue → dispatch → Netzer. The attempt's outcome is written back, and the completion writer transitions the case. The L1, L2 and L3 execution model is in [ADR 0013](../../adr/0013-sync-attach-execution-contract.md). The upgrade strategy and IP boundary are in [ADR 0019](../../adr/0019-paperclip-compatibility-program.md).

### Deprecation

After two clean production weeks (metrics defined at go-live):

- **Retire:** the legacy DynamoDB mission store and handlers; the Missions page; the per-run claim; `salesforce_record`; runtime-config vendor tokens; the dormant extension system; the separate template schema; the `PAPERCLIP_ENABLED` router flag.
- **Keep:** the `paperclip_disabled` kill switch.

### Risk register (top)

| Sev | Risk | Mitigation |
|---|---|---|
| High | Held-open dispatch across restarts | attach semantics; lease takeover; live restart proofs |
| High | Unknown-outcome writes | effect ledger `unknown` → blocked for operator; never blind retry |
| High | Native runner re-enabled by re-pin | fail-closed deploy + startup checks |
| High | Pipelines experimental | contract tests; key-per-version; upstream PRs |
| Med | Netzer-only policy enforcement until Cedar | tests + single IAM path to Gateway; Cedar next |
| Med | Shadow-user sync drift | reconcile job; fail closed on mismatch |
| Med | Staff-run installs vary | every dangerous step scripted and journaled |
| Med | Approval-gated tools depend on Paperclip availability | gated steps fail closed; others continue |

## Build steps

The numbering used across this record is roadmap v2 (decisions 20-29): 18 steps, the same count as the plan of 2026-09-26, now covering all customer UI. Customer #1 track 1-14: 1 docs · 2 re-pin + spikes · 3 pack format · 4 execution contract · 5 safe actions · 6 approvals · 7 Work UI core · 8 trusted install (old 8 + 14) · 9 Workflow Studio · 10 Work UI more · 11 SSO + operator screens · 12 pack store + self-install · 13 test pack + CI harness · 14 owner's pack → Customer #1. After go-live: 15 hand-over (old 11) · 16 security + audit (old 12 + 13) · 17 upstream PR + cleanup (old 15 + 16) · 18 retirement (decision 26). Owner gates apply to every step: push, PR, merge, every staging trip (shared with the Netzar Chat Gauntlet), any AWS call, customer accounts, production, money, external PRs and Fable/astra.

**Customer #1 track (steps 1-14)**

| # | Step | Delivers | Exit gate |
|---|---|---|---|
| 1 | Architecture + MSP record (landed as PR #198, `c9897c5`; its roadmap-v2 docs amendment is step 2's first commit, decision 27) | ADRs 0012-0020 (numbered one higher than the plan, X8; see the [decision log](decision-log.md#adr-numbers)), amend 0010, supersede 0009; DO NOT BUILD list; MSP doc; old plan pieces marked superseded. The amendment updates the MSP doc to roadmap v2: parked screens move into the Customer #1 track; D16's "no visual builder in v1" is superseded by decisions 20-21. | docs gates; narrow re-check critic covers the amendment; owner review |
| 2 | Re-pin + runtime lock + feasibility spikes (B3) | **First, a small docs commit** updating step 1's MSP doc and decision log to roadmap v2 (decision 27: deferred list, D16's builder line, the lines the v2 review flagged, step numbers). P0-0b landed; contract suite (run on the old pin first) → digest v2026.916.x; patch deleted; instance settings; fail-closed check; private dispatch + allowlist; public route denied; telemetry off. **Spikes:** (a) held response ≥ 6 min through the http adapter; (b) shadow-user lifecycle at LATEST (sign-up closed, create, membership, board key, approve, revoke); (c) import `existing_company` + adapter override + `skip`; (d) routine and per-agent concurrency defaults | suite green; spike results recorded. **A failed spike (a) or (b) sends B1 or B5 back to Jev for rework before step 4.** Staging trip (Aurora snapshot first) |
| 3 | Pack format + schemas (B8 part) | `pack.json`, canonical agent schema (templates migrated), `policies.json`/`decisionClasses`, config schema, `connectors.json` with aliases, UI key-field metadata; `pack validate` (schema, placeholders, secret scan, `always_enqueue`, no customer identifiers). **v2:** a `customerEditable` flag per config field (default false; approval-gate and decision-class fields can never be customer-editable) and a reserved, install-ignored Studio layout block | validator tests incl. known-bad packs; a pack marking a gate field `customerEditable` is rejected |
| 4 | Execution contract (B1) | SYNC_ATTACH with attempt identity, renewable fenced lease, cross-task attach, error codes, blocked waits, completion writer, `pending_dispatch` sweep, SIGTERM drain, forging replies removed | live proofs: Paperclip restart, Netzer restart and deploy mid-attempt, duplicate dispatch → one execution with true run states; genuine re-wake runs a new attempt |
| 5 | Safe actions + policy + audit (B2, B4, B6) | deterministic executor + effect ledger (restore-safe key, Paperclip writes ledgered, `unknown` → blocked, `effect resolve`); frozen drafts; role allowlists; AI write-deny incl. Paperclip tools; turn ID + correlation; PHI-safe audit with `writeAuditOrThrow` | retry and Request-Changes rounds produce no duplicate or skipped write |
| 6 | Shadow identities + approvals (B5) | headless users per spike; per-user board keys (SM); approve/reject/request-changes as the shadow user; hash-bound approvals; operator accounts rejected; decision-class enforcement | Paperclip record names the real person; payload-change invalidates approval; operator approval rejected |
| 7 | Work UI core (B7) + first Design Gauntlet | BFF + Inbox, Cases, Case Detail, Approvals (exact payload shown); `work:*` capabilities; `/missions` redirect; `PRODUCT.md` + `design.md` (owner-approved). Candidate bars: Linear Inbox + issue view; GitHub pull-request review for Approvals | Playwright; RBAC route tests; Design Gauntlet stop rule |
| 8 | Trusted install (B8, B9 + old step 14) | `pack preflight` (entitlement, versions, settings, connector READY/MISSING, model invocation probe, config, secret refs); `pack install` (dry run, journaled, projection, key minting, per-key routines and agent configs, concurrency); `activate`/`deactivate`/`status`; registry layout; installation record. **In-account installer** without staff holding data keys: decided here with Jev, **jointly with the release plan's limited-login template (R18)**, recorded as X13. **Pack delivery (decision 29): packs ride inside the signed Netzer release** the customer already installs. Nothing is downloaded separately, and there is no catalog feed or call-home. The release signature covers the packs, so there is **no separate pack key set** for Customer #1. The license root is created in release step 7's ceremony (owner present, an owner gate) and ships inside v1.1.0. A bad pack version is withdrawn by the next release, which carries a minimum-version list. **Signed license file**: its own license root; minted only in CI from a merged `netzer-deployments` commit; bound to the customer's AWS account; checked offline through `checkEntitlement()`. It gates new installs and upgrades only. Activate after deactivate, restore, and running packs are never blocked, and there is no call-home (D17). *Owner confirmed 2026-09-29 (decision 24): the account-bound license lands here, before Customer #1, changing D17's timing (not its promise).* **Needs release steps 4 (X2) and 7.** | full install on staging incl. partial-install resume; a tampered pack, a revoked version, a wrong-account license and an expired license (for a new install) are each refused; an expired license does not block activate or restore |
| 9 | Workflow Studio (new; decision 21) | drag-and-drop pipeline designer + pipeline editor + routine editor for staff and the owner. It runs in a **Netzer-only deployment** and is never in customer builds. It exports the pack format (step 3, including its reserved layout block) and runs `pack validate` on save. Export = a PR to `netzer-packs` → protected tag → the next Netzer release build includes it (decision 29). Staging uses rc builds. Accessibility: every drag has a keyboard/menu alternative (WCAG 2.2 SC 2.5.7), plus a read-only small-screen mode. The customer-side flow map moved to step 10. Candidate bars: n8n workflow editor; Zapier editor (demo state) | an exported pack passes `pack validate` and installs on staging via the signed path; round-trip (import → edit → export) is lossless; keyboard-only edit of one pipeline; Design Gauntlet stop rule |
| 10 | Work UI more (new; UI half of old 17 + day-to-day admin, decision 28) | Active Workflows, Automations, SLA status, and customer dashboards (cases by stage, SLA breaches, throughput; counts from Paperclip + the Netzer audit; `dataviz` skill, analytics preset). **Customer read-only flow map** of each installed pack. **Customer-editable settings**: only fields flagged `customerEditable` in step 3. Each edit is journaled with a WORM row and applies to new cases only; approval gates and decision classes are never editable. **Day-to-day admin screens**: resolve unknown-outcome writes (`effect resolve`) and handle stuck cases (D18: customer admins, never staff). **Chat notifications** (Slack/Teams/email): IDs and a deep link only, no PHI in the message; tokens on the B9 path (Secrets Manager/AgentCore); SES added to B10's HIPAA-eligible list. Candidate bars: Linear Insights; GitHub Actions run list (demo state; no paid accounts: money gate) | Playwright; notification payload has no PHI (test); a settings edit leaves running cases untouched and writes a WORM row; `effect resolve` e2e; Design Gauntlet stop rule |
| 11 | SSO + operator screens (new; decision 23) | **OpenID Connect** login (Entra ID, Okta, Google). Users are linked on the IdP's `iss`+`sub`, never email alone. Just-in-time Netzer users are mapped to roles and Paperclip shadow users (step 6). Magic link stays as fallback, but is off for SSO-enforced domains. A de-provision sweep revokes removed users' shadow users and board keys. IdP-group role grants get WORM audit rows. **Staff operator screens** over `pack status`; their host and staff identity are decided at PLANNING with Jev (D18: the staff limited login is an AWS role, not an app account). They pass a **field allowlist**: IDs, counts and error codes only, no free-text failure messages. `PRODUCT.md` gains a staff persona. Candidate bars: Linear SSO login; Vercel deployments list | OIDC login e2e against a test IdP; account-linking takeover test (same email, different `sub`) refused; de-provisioned user cannot approve; operator screens pass the field allowlist; Design Gauntlet stop rule |
| 12 | Pack store + self-install (new; decisions 22, 28) | in-app catalog = the packs inside the installed release (decision 29). The admin **uploads the license file** (again after each purchase) to unlock installs. Unlicensed packs show a **request** as copyable text / `mailto:`, with no server egress from the customer account. **Install-time admin journey** for licensed packs, behind a `packs:install` capability: first-install **consent screen** (permissions, connectors, data classes; recorded acknowledgement + WORM row) → **connect systems** (AgentCore Identity OAuth) → **enter secrets** (Secrets Manager) → preflight READY → activate (§G step 11 gates kept). No update offers until step 15. Candidate bars: Slack App Directory; GitHub Marketplace listing + GitHub App install/permission screen | self-install of a signed licensed pack on staging end to end; unlicensed or revoked pack cannot install; consent recorded; activation refused while a connector is MISSING; Design Gauntlet stop rule |
| 13 | Behavioral Health **test pack** + CI pack harness (staging only, never production or a customer; decision 16) | pipeline, routines, agents, skills, config, connectors (Jira/M365/EHR aliases), policies, tests, 4 docs. Authored in the Studio and installed through the store. Joint restore drill; reuse test with Customer-B config. **Automated pack CI harness** runs the §J scenarios. Healthcare-shaped on purpose, to exercise PHI, human-only decisions and action-bound approvals | **L checklist all green on staging → platform proven** (the test pack itself is never SELLABLE); harness green in CI |
| 14 | Owner's first real pack → Customer #1 | the owner authors the pack in the Studio (designed on paper since step 1). It passes the full L checklist **on its own** (SELLABLE). Then the §25 model runs end to end in the customer account, on the managed path (D19): staff limited login plus the customer admin, using the same store and self-install screens. Every action is owner-gated; BAA and staff-access model at kickoff | real pack SELLABLE; UAT sign-off; activation; two-week monitoring |

**After Customer #1 (steps 15-18)**

| # | Step |
|---|---|
| 15 | **Hand-over (D19)**, right after go-live: `pack upgrade` (permission diff the customer admin must acknowledge) + `pack rollback`; pack updates arrive with new Netzer releases. Customer platform-update path without source code (release step 13; the option is picked here with Jev). Hand-over runbook; staff login removed. Design Gauntlet on the update/permission-diff screens (candidate bar: the GitHub App permission-update approval screen) |
| 16 | Security + audit depth (old 12 + 13): AgentCore interceptor + Cedar (CDK), approvals verified at the Gateway; WORM mirror of Paperclip events; ledger budget partitions; CloudWatch operator dashboards |
| 17 | Upstream + cleanup (old 15 + 16): pipeline-portability PR **opened** upstream with its tests passing (the merge is tracked, not waited on; it can start any time after step 2); vendor token migration; retire `salesforce_record`; production hygiene (P13, RCA 34184592522). Back-merge and the prod guard moved to the release plan (X6, X7) |
| 18 | Legacy retirement after two clean production weeks |

> **Later decisions (decisions 16, 19, 24, 26, 29 and X2-X7, X12, X13; roadmap v2).**
> - The step numbers on this page are roadmap v2 (X12): X3's "step 14" is step 8; X4's steps 9-10 are steps 13-14; X6 and X7's "step 16" is step 17. Step 13 is the test pack and step 14 the owner's real pack (decision 16). After go-live the order is 15 → 16 → 17 → 18 (decisions 19 and 24).
> - Step 8 depends on release step 4 (X2) and on release step 7, whose ceremony (owner present, irreversible) also creates the license trust root, which ships inside v1.1.0 (X13).
> - Step 13 validates the test pack on `rc/v1.1.0` and step 14 installs the owner's real pack on the final v1.1.0 (X4). v1.1.0, the release Customer #1 gets, must contain steps 7-12, so release steps 10-12 follow step 12; release step 12's rc must follow step 12, not step 8, and the final release follows step 13 plus counsel (X12, X13).
> - Decision 29 (owner, 2026-09-30): packs ride inside the signed Netzer release, so the release signature covers them. X3's separate pack trust-root set (a pack key must never verify a Netzer release; no second platform ceremony) is therefore not needed for Customer #1 (X13).
> - Local deploys to staging (for example step 2's trip) must run code that includes release step 1, or the old ECR rule comes back; re-read the policy afterwards. No staging trips while a release rc is frozen on staging. Step 2 and release step 5 both touch the image path, so whichever lands second rebases and re-runs the `paperclip-image-pipeline` tests (X5).
> - "Back-merge" leaves the after-go-live steps for release step 8 (X6). The "prod provisioning guard" leaves them for release step 5, and production never creates Paperclip without an owner-set variable (X7).

## Where each decision is recorded

| ADR | Title |
|---|---|
| [0012](../../adr/0012-paperclip-owns-work-state.md) | Paperclip owns work state; pipelines are canonical, key-per-version |
| [0013](../../adr/0013-sync-attach-execution-contract.md) | SYNC_ATTACH execution contract and the deterministic-writes rule |
| [0014](../../adr/0014-netzer-only-ai-runtime.md) | Netzer is the only AI runtime; Paperclip runners are disabled and fail closed |
| [0015](../../adr/0015-agentcore-connector-credential-plane.md) | AgentCore is the connector and credential plane; Netzer enforces in v1, Cedar next |
| [0016](../../adr/0016-human-decisions-via-shadow-users.md) | Human decisions are recorded in Paperclip through shadow users; high-impact classes are human by default |
| [0017](../../adr/0017-netzer-identity-and-work-ui.md) | Netzer identity is authoritative; customers never use the Paperclip UI |
| [0018](../../adr/0018-managed-solution-packs-v1.md) | Managed Solution Packs v1: format, registry and entitlement |
| [0019](../../adr/0019-paperclip-compatibility-program.md) | Paperclip compatibility program |
| [0020](../../adr/0020-worm-audit-and-ledger-cost-authority.md) | WORM compliance record and ledger cost authority |

Amended or superseded by this record: [ADR 0010](../../adr/0010-paperclip-work-engine.md) (amended), [ADR 0009](../../adr/0009-mission-container-model.md) (superseded). Every decision, with who decided it: the [decision log](decision-log.md). Decisions 20-29 (roadmap v2) are logged there and folded into ADRs 0012, 0015, 0017, 0018 and 0020 (step numbers and superseded statements).
