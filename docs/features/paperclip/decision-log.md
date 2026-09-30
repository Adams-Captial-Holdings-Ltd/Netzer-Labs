---
feature: paperclip
document_role: decision
status: accepted
observed_at: 2026-09-29
as_of_commit: 29309c8fab1d9b37121aee7d92f0efa0bb30fbc8
---

# Work Platform decision log

The durable copy of every decision behind the Work Platform architecture: the owner-approved plan of 2026-09-26 (decisions 1-15 and the Jev adjudication record), the owner's later decisions (16-19, 2026-09-27 and 2026-09-28) and the cross-plan rows from the release pipeline plan (X1-X11). Transcribed on 2026-09-29 (Work Platform step 1). Nothing here is a new decision.

The architecture is recorded in [ADRs 0012-0020](../../adr/README.md) and the [minimum sellable product](minimum-sellable-product.md). The [DO NOT BUILD list](do-not-build.md) is binding. Feature home: [README](README.md).

## How to read this log

- **By.** *Jev* is the decision model (`typesafe/jev-1.13` on OpenRouter) and the number is its confidence. *Owner* is the owner's own answer, given where Jev was unsure or where the owner decides. *Cross-plan (release)* comes from the release pipeline plan.
- **Precedence.** Where a later decision touches text in the minimum sellable product, the decision wins, and that text carries a marked "Later decision" note. Decisions 16-19 and X1-X11 were made after the roadmap text was last written, so the roadmap does not contain them.
- **Labels.** VERIFIED (checked against source), LIKELY (probable; a step-2 spike or contract test settles it), UNVERIFIED.
- **Process labels.** The Reversibility and Revisit-trigger line in each ADR was added when the ADR was written (2026-09-29), as the Gauntlet's Product Mode requires (process metadata, not a repository rule). Those lines classify the approved decisions and change none of them.
- **"Recorded in"** columns are the recorder's cross-reference to the ADR or document that carries each decision.

## ADR numbers

The plan numbered its nine ADRs 0011-0019. ADR 0011 was taken by the chat ADR when Netzar Chat P7 merged (PR #195), before this record landed. The release plan's rule (X8) is that whichever merges later takes the next free number, so the repo numbers are the plan's numbers plus one.

| Plan | Repo | Title |
|---|---|---|
| 0011 | [0012](../../adr/0012-paperclip-owns-work-state.md) | Paperclip owns work state; pipelines are canonical, key-per-version |
| 0012 | [0013](../../adr/0013-sync-attach-execution-contract.md) | SYNC_ATTACH execution contract and the deterministic-writes rule |
| 0013 | [0014](../../adr/0014-netzer-only-ai-runtime.md) | Netzer is the only AI runtime; Paperclip runners are disabled and fail closed |
| 0014 | [0015](../../adr/0015-agentcore-connector-credential-plane.md) | AgentCore is the connector and credential plane; Netzer enforces in v1, Cedar next |
| 0015 | [0016](../../adr/0016-human-decisions-via-shadow-users.md) | Human decisions are recorded in Paperclip through shadow users; high-impact classes are human by default |
| 0016 | [0017](../../adr/0017-netzer-identity-and-work-ui.md) | Netzer identity is authoritative; customers never use the Paperclip UI |
| 0017 | [0018](../../adr/0018-managed-solution-packs-v1.md) | Managed Solution Packs v1: format, registry and entitlement |
| 0018 | [0019](../../adr/0019-paperclip-compatibility-program.md) | Paperclip compatibility program |
| 0019 | [0020](../../adr/0020-worm-audit-and-ledger-cost-authority.md) | WORM compliance record and ledger cost authority |

The plan's ADR list also said "amend ADR 0010 and supersede 0009"; both are done in this record ([0010](../../adr/0010-paperclip-work-engine.md), [0009](../../adr/0009-mission-container-model.md)). The release identity ADR and bedrock-all-models' ADR take the next free numbers when they merge (X8).

## Decisions 1-19

| # | Decision | By | Recorded in |
|---|---|---|---|
| 1 | Execution contract SYNC_ATTACH (held open per attempt; attempt = issueId + wake cause/revision; repeats attach; 2xx only after outcome written; non-2xx on failure; waits → blocked + durable wait path; fenced renewable leases; no forging 202/503) | Jev 1.0 (revised from async monitor after owner requirement) | [ADR 0013](../../adr/0013-sync-attach-execution-contract.md) |
| 2 | Business writes only in deterministic steps; effect ledger key (caseKey, stage, step, stageEntryNo); Paperclip writes ledgered; unknown outcome → blocked | Jev 0.99 + blindspot | [ADR 0013](../../adr/0013-sync-attach-execution-contract.md) |
| 3 | Netzer `runAgentTurn` is the only AI runtime; Paperclip runner/local adapters/remote profiles off, fail-closed checks | Jev 1.0 | [ADR 0014](../../adr/0014-netzer-only-ai-runtime.md) |
| 4 | AgentCore Gateway/Identity is the connector and credential plane; policy enforced in Netzer for customer #1, Cedar interceptor next | Jev 1.0 / 0.89 | [ADR 0015](../../adr/0015-agentcore-connector-credential-plane.md) |
| 5 | Customers use a Netzer-owned Work UI (Inbox, Cases, Case Detail, Approvals); Paperclip UI operator-only; redesign around Paperclip's work model, Missions page not the foundation | Jev 1.0 + owner | [ADR 0017](../../adr/0017-netzer-identity-and-work-ui.md) |
| 6 | Paperclip shadow users per approver (Netzer is identity authority); approvals hash-bound to the exact action; operator accounts never count | owner + blindspot | [ADR 0016](../../adr/0016-human-decisions-via-shadow-users.md) |
| 7 | High-impact decision classes need human sign-off unless the customer approved an automated-decision policy for that class | owner | [ADR 0016](../../adr/0016-human-decisions-via-shadow-users.md) |
| 8 | Packs: Netzer wrapper over Paperclip bundles + native pipeline/routine bodies; pipeline key per pack version; per-key routines and agent configs; declarative only | Jev 1.0 / 0.91 | [ADR 0018](../../adr/0018-managed-solution-packs-v1.md), [ADR 0012](../../adr/0012-paperclip-owns-work-state.md) |
| 9 | Pipelines are the canonical workflow engine; contribute pipeline portability upstream | owner | [ADR 0012](../../adr/0012-paperclip-owns-work-state.md) |
| 10 | Re-pin to v2026.916.x first under a compatibility program; never fork | owner + Jev 1.0 | [ADR 0019](../../adr/0019-paperclip-compatibility-program.md) |
| 11 | Config in Netzer deployment registry + install record; entitlement = registry check; signing soon, not first | Jev 0.98 / 0.98 / 0.85 | [ADR 0018](../../adr/0018-managed-solution-packs-v1.md) |
| 12 | One agent format everywhere; skills live in Netzer agent config; pack creates namespaced agents with optional mapping | owner / Jev 0.88 / 0.81 | [ADR 0018](../../adr/0018-managed-solution-packs-v1.md) |
| 13 | SLAs: pack thresholds, Paperclip routines/monitors as timers; Netzer scheduler only for personal chat reminders | Jev 0.99 / 1.0 | [ADR 0012](../../adr/0012-paperclip-owns-work-state.md) |
| 14 | Audit: Netzer WORM rows (IDs/hashes only) for customer #1; full Paperclip-event mirror next; Netzer ledger is cost authority | Jev 0.93 / 1.0 | [ADR 0020](../../adr/0020-worm-audit-and-ledger-cost-authority.md) |
| 15 | One Paperclip company per deployment (single-tenant) | Jev 1.0 | [ADR 0012](../../adr/0012-paperclip-owns-work-state.md) |
| 16 | **Behavioral Health Referral = staging-only TEST pack, never production or a customer.** It stays healthcare-shaped to exercise the hardest rules. Step 9 = the test pack proves the platform on staging (full L checklist, never shipped). Step 10 = the owner's first real pack passes the same checklist on its own and goes to Customer #1. Still 18 steps. The owner designs the real pack on paper now (stages, approvals, agents, connections, settings, 5–10 test cases), writes it in the pack format after step 3, and installs it on staging after step 8. Authoring uses the same files and tools as staff (Paperclip operator screen → export → `pack validate`); no visual builder in v1 | owner 2026-09-27 (Jev: design-now 0.90, same-tools 0.94; test-pack 0.70, real pack to C#1 0.88, repurpose 9/10 0.79, healthcare-shaped 0.84 → owner confirmed) | [ADR 0018](../../adr/0018-managed-solution-packs-v1.md), [minimum sellable product](minimum-sellable-product.md#build-steps) |
| 17 | **Resale is forbidden; a customer who stops paying keeps what they have.** A lapsed customer may keep running the copy they already have (no remote kill switch, no call-home). Reselling, redistributing or sublicensing Netzer or a pack is forbidden, and the license says so (counsel, release step 11). It is backed by what the plans already do: no source code in customer accounts; signed updates and packs only from Netzer staff; and the per-customer `deploymentId` in logs and audit rows (§15). The account-bound signed license file stays in step 14 (signed entitlement seam), not before Customer #1 | owner 2026-09-28 (Jev unsure 0.26: lock-later 0.51, contract+trace 0.39, lock-now 0.10 → status quo kept) | [ADR 0018](../../adr/0018-managed-solution-packs-v1.md) |
| 18 | **Netzer staff never access customer data.**<br>**Can:** in a customer's AWS account, staff use a limited login that can install, upgrade and remove packs and the platform, and see system health (status, counts, IDs and error codes).<br>**Cannot:** read cases, records, documents, secrets or content-bearing logs; open the Paperclip screens there; or grant itself more access.<br>**Customer admin does:** anything that touches real data, with our runbook. That means entering secrets, connecting their systems (OAuth), looking at a stuck case, `effect resolve` decisions, UAT on their systems, and restores.<br>**Scope:** this defines B10's staff-access model and replaces "operators over SSM" (Part 2, §N) for customer accounts. `pack status` and alerts show IDs and counts only.<br>**Open:** how installs run without staff holding data keys (e.g. an installer job inside their account) is decided in step 8 with Jev. The BAA stays only if counsel still requires it | owner 2026-09-28 | [ADR 0017](../../adr/0017-netzer-identity-and-work-ui.md), [minimum sellable product](minimum-sellable-product.md#b-must-have) (B10) |
| 19 | **Customers maintain their own system after hand-over; Customer #1 is the pilot.**<br>**Go-live:** Customer #1 goes live on the managed path (step 10, staff limited login).<br>**Hand-over block:** right after that, and before customers 2–5, two existing steps run next, both extended:<br>– step 11 (pack upgrade/rollback);<br>– step 14 (pack signing, plus a signed license file tied to the customer's AWS account).<br>The extensions: the customer's own install flow for signed pack files (e.g. an admin screen that runs decision 18's in-account installer), the customer update path (release step 13), and a hand-over runbook.<br>**Handover:** Customer #1 is handed over as the pilot, and the staff login is then removed.<br>**Order:** step numbers stay; after step 10 the order is 11 → 14 → 12 → 13 → 15–18.<br>**Open for that block, with Jev:** how a customer updates the platform without receiving source code. The options are a customer-approved deploy by Netzer's pipeline through a data-blind role, or signed pre-built templates run by an in-account job | Jev 0.98 (pilot hand-off after go-live); owner 2026-09-28: Customer #1 is a willing pilot | [ADR 0018](../../adr/0018-managed-solution-packs-v1.md), [minimum sellable product](minimum-sellable-product.md#d-should-have-next) |

## Cross-plan decisions X1-X11 (release pipeline plan)

The release pipeline plan owns Netzer releases. These rows were agreed between that plan and this one.

| # | Decision | By | Recorded in |
|---|---|---|---|
| X1 | Customer installs verify the release, import its signed digests and **never build**. This replaces §C/§25 step 4's "`npm run setup`/`deploy` from a release tag" (release step 10) | cross-plan (release) 2026-09-26 · Jev 0.91 / 0.83 | [ADR 0018](../../adr/0018-managed-solution-packs-v1.md) |
| X2 | §G steps 2–3: pack preflight verifies the deployed release's signature. Running ECS digests must equal the signed digests, and the signed Paperclip digest must be in `compatibility.paperclip.tested`. The deploy-manifest `release` field is only a pointer. **WP step 8 depends on release step 4** | cross-plan (release) · blindspot | [ADR 0018](../../adr/0018-managed-solution-packs-v1.md), [ADR 0019](../../adr/0019-paperclip-compatibility-program.md) |
| X3 | Step 14 pack signing reuses the release signing module with a **separate pack trust-root set**. A pack key must never verify a Netzer release, and there is no second platform ceremony | cross-plan (release) · Jev 0.93 + blindspot | [ADR 0018](../../adr/0018-managed-solution-packs-v1.md), [minimum sellable product](minimum-sellable-product.md#build-steps) |
| X4 | Step 9 validates the test pack on `rc/v1.1.0` (the rc does not wait for counsel), and step 10 installs the owner's real pack on the final v1.1.0 (decision 16). Both depend on release steps 10–12 | cross-plan (release) | [minimum sellable product](minimum-sellable-product.md#build-steps) |
| X5 | Local deploys to staging (e.g. step 2's trip) must run code that includes release step 1, or the old ECR rule comes back; re-read the policy afterwards. No staging trips while a release rc is frozen on staging. Step 2 and release step 5 both touch the image path, so whichever lands second rebases and re-runs `paperclip-image-pipeline` tests | cross-plan (release) | [minimum sellable product](minimum-sellable-product.md#build-steps) |
| X6 | "Back-merge" leaves step 16 and moves to release step 8 (production hotfix reconciliation) | cross-plan (release) · Jev 0.93 | [minimum sellable product](minimum-sellable-product.md#build-steps) |
| X7 | The "prod provisioning guard" leaves step 16 and moves to release step 5. Production never creates Paperclip without an owner-set variable | cross-plan (release) · Jev 0.94 | [minimum sellable product](minimum-sellable-product.md#build-steps) |
| X8 | ADR numbers: step 1 keeps 0011–0019 if it lands first. The release identity ADR and bedrock-all-models' 0011 each take the next free number when they merge | cross-plan (release) | [ADR numbers](#adr-numbers) |
| X9 | The compatibility program's "staging canary" = release step 6 running the Paperclip contract suite on every rc | cross-plan (release) | [ADR 0019](../../adr/0019-paperclip-compatibility-program.md) |
| X10 | New repos `netzer-packs` / `netzer-deployments` get release step 3's ruleset shapes: `*/v*` tags immutable, and branches need a PR with zero approvals | cross-plan (release) | [ADR 0018](../../adr/0018-managed-solution-packs-v1.md), [minimum sellable product](minimum-sellable-product.md#k-minimum-licensing-model) |
| X11 | Where the customer-hosted docs conflict with managed installs, the managed model (decision 5, §25) wins. Release step 10 reconciles them | cross-plan (release) | [minimum sellable product](minimum-sellable-product.md#first-customer-deployment-model-25) |

## The Jev adjudication record (roadmap Part 3)

Jev returns choices and scores; "why" is the selected dossier rationale. Transcribed from the plan, with the ADR column added.

| Decision | Jev (conf) | Owner | Source verification | ADR |
|---|---|---|---|---|
| P1 execution contract | NATIVE_ASYNC_MONITOR (1.0) → **revised to SYNC_ATTACH (1.0)** after the owner made true run states a blocker | — | **VERIFIED**: http `timeoutMs` 0 = no timeout, non-2xx → failed (pc:adapters/http/execute.ts:11-41 @LATEST); silence watchdog 60 min / 4 h (pc:recovery/service.ts:80-81); active run skips stranded recovery; durable wait path for blocked waits (service.ts:857,3544; handoff skip "persisted issue monitor owns the next action" successful-run-handoff.ts:97); run-id header not status-checked (middleware/auth.ts:155-218) | 0013 |
| P2 packs | Envelope over Paperclip bundles (1.0), key-per-version (1.0) | — | **VERIFIED**: teams catalog uses portability import (services/teams-catalog.ts:12-19); archived pipeline blocks transitions → keep old key live | 0018, 0012 |
| P3 connectors | AWS-native plane (1.0); approvals verified directly (0.93); **v1: Netzer-enforced first, Cedar next (0.89)** | — | **VERIFIED**: no Paperclip policy-only endpoint; interceptor before Cedar, `passRequestHeaders` (AWS docs); approvals payload + GET by ID | 0015 |
| P4 runtime | Netzer `runAgentTurn` only (1.0) | — | **VERIFIED**: `enableNativeRunner` default true, settable (validators/instance.ts:44 @LATEST) | 0014 |
| Upstream pipeline portability | 0.89 lean | **YES** | — | 0012 |
| Re-pin first | 0.85 / 0.69 | **YES** | — | 0019 |
| Pipelines canonical | 0.87 | **YES** | — | 0012 |
| Human gates | 0.74 | **YES, with owner's rule** (high-impact classes human unless a customer policy approves automation) | — | 0016 |
| UI | hybrid (1.0) → revised to Netzer Work UI (1.0) | **YES, extended**: Netzer-owned Work UX, Paperclip SPA operator-only, Missions not the foundation | VERIFIED: no base path (pc:ui/src/api/client.ts:3) | 0017 |
| Approver identity | 0.57 vs 0.43 | **Shadow users** | **VERIFIED**: `board_api_keys.user_id` | 0016 |
| Agent templates → one format | 0.88 | **YES** | — | 0018 |
| Skills in Netzer agent config | 0.88 | — | — | 0018 |
| SLAs via pack thresholds + Paperclip timers | 0.99 | — | VERIFIED: monitors `timeoutAt`/`escalate_to_board`; routines | 0012 |
| Compat program 1.0 · private dispatch 0.93 · issue claim 0.91 · fail-closed checks 1.0 · declarative packs 0.91 · built-ins same policy 0.91 · retire dup connectors 0.93 · tokens to AWS 0.90 · ledger cost authority 0.91 · WORM compliance 1.0 · surface control 1.0 · deterministic actions 0.98 · scheduling boundary 1.0 · one company/deployment 1.0 · offline entitlements (target) 1.0 | as listed | — | — | see the mapping below |
| **MSP:** writes only in deterministic steps 0.99 · config in registry + install record 0.98 · signing should-have-soon 0.85 · entitlement via registry 0.98 · four screens 1.0 · namespaced agents + optional mapping 0.81 · runbook + scripts 1.0 · audit rows first, mirror next 0.93 | as listed | — | archived-pipeline and routine-portability mechanics VERIFIED | 0013, 0018, 0017, 0020 |

**Where the granular Jev items landed** (the recorder's mapping): compatibility program → 0019 · private dispatch, fail-closed checks → 0014 · issue claim, deterministic actions → 0013 · declarative packs, offline entitlements → 0018 · built-ins same policy, retire duplicate connectors, tokens to AWS → 0015 · ledger cost authority, WORM compliance → 0020 · surface control → 0017 · scheduling boundary, one company per deployment → 0012.

**Blindspot review.** A fresh `ecc:architect` returned SHIP-WITH-FIXES. It raised 11 findings, all folded in:

- approvals hash-bound to the action;
- effect-ledger key and Paperclip-write coverage;
- SYNC_ATTACH attempt identity, lease fencing, SIGTERM drain, the fetch-limit spike, and removing the forging 202/503 replies;
- ingest `always_enqueue`;
- the shadow-user and import spikes;
- PHI-safe audit, HIPAA eligibility, BAA and 42 CFR Part 2;
- full per-key pinning;
- the restore drill, cost-cap and model-access failure rows;
- roadmap reorder (P0-0b into step 2, schemas before use);
- overbuild moved to C/D (upgrade/rollback tooling, test automation, rotation and sync).

**Kept over the reviewer:** Jev's FOUR_SCREENS (1.0) and the owner's list; Inbox and Cases stay, as thin lists.

**Cross-problem review.**

- **Single authorities confirmed:** workflow (Paperclip 0.84), runtime (Netzer 1.0), connectors (AgentCore 1.0), credentials (AWS 0.99), packages (0.97), cost (Netzer 1.0).
- **Gaps fixed:** approvals, audit, Paperclip surface bypass, UI fencing. Plus two later corrections: SYNC_ATTACH (owner requirement) and the approver identity conflict (owner decision).
- **Final coherence 0.78.** The residual is risks, not conflicting authorities.

## Parts of decisions 18 and 19 still open

Recorded so the next steps do not treat them as settled:

- **Decision 18:** how installs run without staff holding data keys (for example an installer job inside the customer's account) is decided in step 8 with Jev. Whether the Netzer↔customer BAA is still required depends on counsel.
- **Decision 19:** how a customer updates the platform without receiving source code. The options are a customer-approved deploy by Netzer's pipeline through a data-blind role, or signed pre-built templates run by an in-account job. Decided with Jev in the hand-over block.

Recorded 2026-09-29 (Jev: log and fold, 0.87): decisions 17-19 are logged here and folded into ADR 0017, ADR 0018 and the DO NOT BUILD list, with no ADR of their own; each open part above gets its own ADR when it is settled.
