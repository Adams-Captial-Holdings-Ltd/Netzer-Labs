---
feature: paperclip
document_role: evidence
status: historical
observed_at: 2026-08-18
as_of_commit: bfe870724dc38ee8cd470b4a44ce95e121e22f21
---

# Paperclip implementation plan — adversarial audit

**Historical evidence.** Two independent adversarial audit passes run over
[the implementation plan](implementation-plan.md) on 2026-08-18, before any of
it was built from. Findings were true when observed against the repositories on
disk that day; nothing here has been re-run since. Present behavior lives in
[the feature README](README.md) and, ultimately, in the source code.

**Why this document exists.** The plan is unusually well-sourced — roughly 250
line-anchored citations were re-verified and the overwhelming majority are
exact — but **16 of them are wrong**, two point at paths that do not exist, and
one cluster of five carries a systematic line offset that anchors a load-bearing
architecture argument. None of the corrections overturns a conclusion; the
architecture survives every one. But a fabricated path in a build-ready plan is
exactly the defect that burns a day, which is why the plan is not safe to follow
without this list beside it.

**None of these corrections has been applied to the plan text.** The plan is
vendored verbatim as a historical artifact. Read the two together.

## How to use this

1. Before following any citation in the plan, search this page for the file
   name. If it appears, use the correction here.
2. Before executing §26 Phase 4 or later, read
   [§ Structural defects](#structural-defects-that-need-an-author-decision) —
   four of them cannot be fixed by find-and-replace and need a decision.
3. Where this audit and the plan disagree, **this audit wins**. Where this audit
   and the code disagree, the **code** wins.

## Scope limit, stated by the auditors

Pass 1 could not see the Paperclip repository, so `PAPERCLIP:`-prefixed
citations were excluded from its fabrication list. Pass 2 did verify them. The
plan's own §28.5 contract-test lane and §32 Q2/Q4/Q9 remain the right
instruments to settle anything still marked `UNCONFIRMED`.

---

## Reading the `sN.md` references

The audits ran against the plan's seven assembly-stage section files, which are
**not vendored** — only the assembled
[implementation-plan.md](implementation-plan.md) is. Navigate by the § number in
each finding, not by the `sN.md` line number. The mapping:

| Section file | Plan sections it held |
|---|---|
| `s1.md` | §1 Executive Summary, §2 Repository Findings |
| `s2.md` | §3 Capability Comparison … §7 System-of-Record Decisions |
| `s3.md` | §8 Agent Bridge … §11 Routing Strategy |
| `s4.md` | §12 Identity Mapping, §13 API / Event Contracts, §14 Database Changes |
| `s5.md` | §15 AuthN/AuthZ … §21 Security Considerations |
| `s6.md` | §22 Deployment Architecture … §27 File-by-File Change Plan |
| `s7.md` | §28 Testing Strategy … §34 Decision Log |

## Structural defects that need an author decision

Four findings cannot be fixed by correcting a citation — two sections of the
plan were written to different premises and executing either breaks the other.
**Resolve these before starting §26 Phase 4.** Read them in full below:

- **P1-C6** — dual-write: §25.4 forbids it, §30 Stage 4 gates on it.
- **P1-C7** — the `PAPERCLIP_ENABLED` fall-through §29/§30 need is deleted by §27.1.
- **P1-G1** — the §13.2 `MissionEngine` interface is orphaned.
- **P1-G2** — §29's POC specifies ~530 lines with no §27 row.

Two lower-severity gaps are also unowned: **P1-G3** (`dueAt` removal, no phase)
and **P1-G5** (§32 Q9 blocks the integration lane but Phase 3 treats it as
settled). Q9 has since been **resolved** — see
[`tests/fixtures/paperclip-bootstrap.ts`](../../../tests/fixtures/paperclip-bootstrap.ts)
and [the Codex session handoff](handoffs/2026-08-18-codex-review.md).

## Pass 1 — coherence and completeness audit

**Verdict.** STRUCTURALLY COMPLETE, INTERNALLY INCONSISTENT — needs a reconciliation pass before it can be built from, but the foundations are sound.

WHAT PASSES. All 34 required sections are present, including §2.1-2.4 as separate subsections. All four REQUIRED DIAGRAMS exist and are syntactically valid Mermaid: System Architecture (`flowchart TB`, s2.md:493), Data Ownership (`flowchart LR`, s2.md:737), Mission Creation (`sequenceDiagram`, s3.md:865), Agent Execution (`sequenceDiagram`, s3.md:1182). I checked every block for correct type keyword, balanced brackets (including the `[[...]]` subroutine and `[(...)]` cylinder shapes), balanced `subgraph`/`end`, valid `classDef`/`class` statements, and stray backticks — all clean. No fifth Mermaid block exists anywhere, so there are no unchecked diagrams. All 11 §26 phases carry all 12 required fields. No section is too thin: the shortest (§32) is a 12-row table where each row names the settling command and the decision it gates.

CITATION QUALITY IS GENUINELY HIGH. I verified the Netzar-side citations directly against C:/dev/Netzer-Labs. Every file path I sampled exists (31/31), and the line numbers are accurate to the line: `handler.ts` mission routes at :3096/:3110/:3113-3115/:3171/:3183-3191/:3203, `MISSION_STATUSES` at :29-36, `autoAssign` at :54, `RUNNER_HOLDER_ID` at :35 and `tryAcquireRunnerLease` at :54 with the documented fail-open polarity, `CACHE_TTL_MS = 30_000` at :31 and `getConfig` at :69, telegram ack-first at :113-124, `TELEGRAM_TOKENS_JSON` at :473, logs grant scoped to `/claudeclaw/*` at :197, SG ingress `Port.tcp(3000)` at :99-101, mission table at dynamo-stack :199-212, `COLUMNS` at Missions.tsx:37 with dueAt at :263/:343/:370, `development.md:341` \"Migrations: none\", deploy phase-a list at :432-438. Two independently checkable counts are exactly right: 32 `new Table(` in dynamo-stack.ts and 23 tableArns passed to BackupStack. This is not hand-waved archaeology.

WHAT MUST BE FIXED. Three miscitations (one wrong file for reconciler startup, two wrong section cross-references — one repeated three times against a MEDIUM risk's only mitigation) and twelve contradictions. The contradictions cluster into four themes, and the first three are mechanical: (a) module paths for the same component differ between §17.1, §27.1 and §29.3 — watermark, agent-map and the wire-types split; (b) the Secrets Manager secret has two names and its fields have two spellings, which will produce a task that cannot start; (c) the reconciler's cadence and mode live in two different config planes. The fourth is substantive and cannot be resolved by find-and-replace: §25.4 forbids dual-write in four numbered reasons and §12.8 calls it split-brain, while §30 Stage 4 makes a dual-write probe a go/no-go gate metric, and §29/§30's `PAPERCLIP_ENABLED` runtime fall-through to legacy handlers is impossible once §27.1 deletes those handlers. Rollout strategy and cutover strategy were written to different premises and must be reconciled by an author decision, not an editor.

The other load-bearing gap is the orphaned §13.2 `MissionEngine` abstraction: the plan's central interface contract declares three NEW files that appear in no phase, no file-by-file row, and no call graph. Decide whether the indirection is real and propagate it, or delete §13.2's file declarations and rewrite it against C1/C2.

CAVEAT ON SCOPE. The Paperclip repository is not present on this machine, so PAPERCLIP-prefixed citations (`services/issues.ts:5587-5591`, `routes/issues.ts:3924`, `middleware/auth.ts:366-370`, the 222 migrations, the seven-status constant, the no-`due_at`/no-`metadata` column claims, etc.) could NOT be verified and are excluded from the fabrications list. Given how accurate the Netzar half is I would not assume they are wrong — but the plan's own §28.5 contract-test lane and §32 Q2/Q4/Q9 are the right instruments to settle them, and none should be treated as confirmed until that lane runs.

### Fabrications and miscitations — pass 1 (3)

#### P1-F1 — `s6.md (§27.1, File-by-File table)`

- **Claim.** `src/server.ts` | Modify | ... start the reconciler loop alongside the existing canary / webhook-monitor loops
- **Problem.** MISCITED. Verified against C:/dev/Netzer-Labs: `src/server.ts` is 166 lines and contains zero background loops — grep for startCanary/startWebhookMonitor/startQueueDrain/setInterval returns nothing. Those loops live in `src/index.ts` (startCanary() at :88, startWebhookMonitor() at :89, startQueueDrain() at :73), exactly as §8.5.1 and §17.6 correctly state. §27.1 is the authoritative build sheet, so an implementer following it edits the wrong file.
- **Correction.** Split the §27.1 row: `src/server.ts` | Modify | mount the dispatch router + ACL router, side-effect import for paperclip-tools. Add a separate row: `src/index.ts` | Modify | call startPaperclipReconciler() next to startCanary()/startWebhookMonitor() at :88-89.

#### P1-F2 — `s6.md:1408, s7.md:882 (R4), s7.md:914 (Q2)`

- **Claim.** "the §4.4 audit-cursor sweep" / "the §4.4 audit-cursor feed (GET /companies/{cid}/audit/agent-actions...)"
- **Problem.** MISCITED CROSS-REFERENCE, repeated three times. §4.4 is "The `dueAt` gap — ranked options" (s2.md:365) and contains no audit feed. The audit-cursor recovery feed is actually route #17 of the §13.1 route table (s4.md, `routes/activity.ts:238`) and is described in §13.3.1 (s4.md:620-624). R4 is a MEDIUM risk whose entire mitigation points at a section that does not describe it.
- **Correction.** Replace all three occurrences of "§4.4" with "§13.1 route #17 / §13.3.1". Also carry forward the §13.1 caveat that this feed's response passes `stripAuditAttribution`, nulling `agentId`, `runId` and `details` — which materially limits its usefulness as a comment-change detector and should be stated where the mitigation is proposed.

#### P1-F3 — `s7.md:911 (§32, Q1)`

- **Claim.** "Whether the optional idempotent import in §10.3(2) runs at all."
- **Problem.** MISCITED CROSS-REFERENCE. §10.3 is "The stages in detail" in the Task Lifecycle section (s3.md:1246) and describes creation origins, not a data import. The optional import is `scripts/import-missions-to-paperclip.ts`, specified in §25.3 and §27.3.
- **Correction.** Change "§10.3(2)" to "§25.3 / §27.3 (`scripts/import-missions-to-paperclip.ts`)".

### Internal contradictions — pass 1 (12)

**P1-C1.** CONFIG PLANE FOR THE RECONCILER — §8.5.1 (s3.md:392) specifies cadence via env var `RECONCILE_INTERVAL_MS` (default 60000, floor 15000) and §8.5.7 (s3.md:491) specifies mode via env var `PAPERCLIP_RECONCILER_MODE ∈ {shadow,active}`. §23.3 (s6.md) instead puts both in runtime-config plane 3 as `paperclip/poll_interval_ms` and `paperclip/reconciler_mode`, seeded in `scripts/lib/seed-defaults.ts`, and its table explicitly enumerates EVERY new env var added to `src/config/env.ts` — neither `RECONCILE_INTERVAL_MS` nor `PAPERCLIP_RECONCILER_MODE` appears. §27.1's `src/config/env.ts` row likewise omits both. These are different config planes with different operational properties (redeploy vs. live tunable); §26 Phase 5's acceptance criterion "promotion is a config write, not a deploy" only holds for the runtime-config version.

**P1-C2.** RECONCILER STARTUP FILE — §8.5.1 (s3.md:392-393), §17.2 call graph (s5.md:636 "src/index.ts boot ──► lib/paperclip/reconciler.ts") and §17.6 (s5.md:845 "called from src/index.ts, next to startQueueDrain") all say `src/index.ts`. §27.1 (s6.md) assigns it to `src/server.ts`. Verified: only `src/index.ts` starts loops.

**P1-C3.** SECRETS MANAGER SECRET NAME — Two different names for the same new secret. `/claudeclaw/paperclip-keys` in the §5.2 architecture diagram (s2.md:523 `SM[["Secrets Manager<br/>/claudeclaw/paperclip-keys"]]`), the §5.2 prose (s2.md:589) and the §15.2 delegation chain (s5.md:51). `/claudeclaw/paperclip` in §12.2 (s4.md:51), §12.6 (s4.md:365), §13.3 (s4.md:598), §15.5 (s5.md:327-329), §22.4 (s6.md:100), §23.2-23.4 (s6.md:396,463,472) and §27.2 secrets-stack row. The IAM grant, the CDK construct and the bootstrap script all key off this string.

**P1-C4.** SECRET FIELD NAMES — §15.5 credential inventory (s5.md:327-329) names the fields `reconciler_key`, `agent_keys_json`, `dispatch_token`. §23.3 (s6.md) and §27.2's secrets-stack row name them `reconciler_key`, `agent_keys`, `dispatch_secret`, and §23.4's concrete code block reads `EcsSecret.fromSecretsManager(paperclipSecret, 'agent_keys')` / `'dispatch_secret'`. A `fromSecretsManager` field-name mismatch produces a task that cannot start.

**P1-C5.** ENV VAR NAMES FOR THE SAME VALUES — §29.4 POC config table (s7.md:616-623) uses `PAPERCLIP_AGENT_KEYS`, `PAPERCLIP_DISPATCH_TOKEN`, `PAPERCLIP_AGENT_ID_MAP`, `PAPERCLIP_TIMEOUT_MS`, `PAPERCLIP_ENABLED`. §23.3 / §27.1 use `PAPERCLIP_AGENT_KEYS_JSON` and `PAPERCLIP_DISPATCH_SECRET`, and list no `PAPERCLIP_ENABLED`, `PAPERCLIP_AGENT_ID_MAP` or `PAPERCLIP_TIMEOUT_MS` at all.

**P1-C6.** DUAL-WRITE — DIRECT REVERSAL. §25.4 (s6.md:812-836) is titled "Dual-read / dual-write: not needed" and states "**Do not do it here**" with four numbered reasons, concluding "What replaces dual-write: a **shadow read**". §12.8/§13 (s4.md:418) reinforces: "**Do not fall back to `claudeclaw-mission-tasks`** — a dual-write fallback creates split-brain state that the cutover was designed to avoid." But §30 Stage 4 (s7.md:770-772) prescribes exactly that: "A **dual-write probe**: every legacy mission write also creates a Paperclip issue (idempotency-keyed `netzar-mission:<id>`), and a periodic comparator logs any divergence" — and makes "Projection divergence (dual-write comparator) | zero unexplained" a go/no-go gate metric. Stage 4 cannot be executed without violating §25.4.

**P1-C7.** PAPERCLIP_ENABLED RUNTIME FALL-THROUGH vs. HANDLER DELETION — §29.4 (s7.md:616) and §30 Stages 4-6 (s7.md:764, 799, 818) depend on a runtime flag where "When false the ACL routes fall through to the legacy repo handlers" and "the legacy handlers are still live" (s7.md:722), with §30 step 5 (s7.md:850) later removing "the `PAPERCLIP_ENABLED` fall-through branch". But §17.1 (s5.md) and §27.1 (s6.md) both say the cutover *deletes* the four inline handler bodies from `handler.ts:3096/3110/3171/3203` and mounts the ACL router instead, and §26 Phase 7's rollback is "Revert the commit" — not a flag flip. If the inline handlers are deleted there is nothing to fall through to, and Stages 4-6 have no mechanism.

**P1-C8.** WATERMARK MODULE PATH — `src/lib/paperclip/watermark-repo.ts` in the §17.1 module-layout tree (s5.md:578) vs `src/lib/paperclip/watermark.ts` in §26 Phase 5 (s6.md:1335) and §27.1 (s6.md:1823).

**P1-C9.** AGENT-MAP MODULE PATH — `src/lib/paperclip/agent-map.ts` in §17.1 (s5.md:577) and the §17.2 call graph (s5.md:616) vs `src/lib/paperclip/agent-id-map.ts` in §29.3 (s7.md:598). Neither name appears anywhere in the §27.1 file-by-file table, so the component has no build row under either name.

**P1-C10.** WIRE-TYPES MODULE SHAPE — §17.1 and §27.1 specify a single `src/lib/paperclip/types.ts` holding "types for the ~12 contract routes". §13.4 (s4.md:774) instead declares `src/lib/paperclip/dispatch-types.ts` and §13.5 (s4.md:863) declares `src/lib/paperclip/reconciler-types.ts` as separate NEW files. Three files vs one, and the two split files have no §26 or §27 row.

**P1-C11.** PAPERCLIP PORT DECISION — §5.2 (s2.md:589) leaves it open: "Either add the rule or set `PORT=3000` on Paperclip (`server/src/config.ts:294` honours it)". §22.5 (s6.md:145) closes it in the opposite direction with an explicit prohibition: "**Do not take the "cheap" option of setting `PORT=3000`**". §5.2 should defer to §22.5 rather than present a rejected option as live.

**P1-C12.** §30 STAGE 4 GATE ARITHMETIC — "**Gate (go/no-go):** all seven metrics met" (s7.md:786) but the metric table immediately above it has eight rows (shadow-vs-actual overlap, push-to-dispatch latency, sweep duration, watermark regressions, duplicate dispatch decisions, Paperclip 5xx rate, projection divergence, Aurora/EFS/Fargate budget).

### Gaps — pass 1 (6)

**P1-G1.** ORPHANED §13.2 MissionEngine ABSTRACTION — §13.2 (s4.md:468-580) defines the `MissionEngine` interface and declares three NEW files: `src/lib/paperclip/mission-engine.ts` (the interface), `src/lib/paperclip/paperclip-mission-engine.ts` ("the real one, over C1 + C2") and `src/lib/paperclip/disabled-mission-engine.ts` ("every method throws"). Grep across all seven files: these three paths appear ONLY in §13.2. They are in no §26 phase, no §27 file-by-file row, not in the §17.1 module-layout tree, and not in the §17.2 call graph — which wires C3 directly to C1/C2 with no engine indirection. Either the abstraction is real and §17/§26/§27 are missing it entirely, or it is vestigial and §13.2 should be rewritten against C1/C2 directly. As written the plan's central interface contract is unimplementable.

**P1-G2.** §29 POC FILES HAVE NO §27 ROWS — Five files specified in §29.3 have no row in the §27 file-by-file plan: `src/lib/paperclip/config.ts` (~60 lines, resolves base URL/company id/keys), `src/lib/paperclip/dispatch-worker.ts` (~200 lines — the entire fetch→neutralize→runAgentTurn→write-back worker), `src/lib/paperclip/agent-id-map.ts` (~60 lines), `docker-compose.paperclip.yml`, and `tests/fixtures/paperclip-bootstrap.ts` (~150 lines). `dispatch-worker.ts` is the largest single behavioural component in the POC; §17.7 folds the same logic into `paperclip-dispatch.ts` as `executePaperclipWork`. §27 is the authoritative build sheet and silently drops ~530 lines of specified work.

**P1-G3.** dueAt REMOVAL HAS NO OWNING PHASE OR FILE ROW — §16.5 (s5.md:475-482) is an explicit directive: "remove the three render sites and the field from the local `Mission` interface" (verified present at `web/src/pages/Missions.tsx:263, 343, 370` plus the interface field at `:31`), plus §4.4's requirement to drop `due_at` from `create_mission`'s tool schema (`mission-tools.ts:178`). §26 Phase 10's "Files affected" lists only the `COLUMNS` extension and the priority enum; §27.3's `Missions.tsx` row likewise mentions only COLUMNS and priority. The dueAt deletion — a user-visible field removal — is specified but assigned to no phase and no file row.

**P1-G4.** §30 STAGE 4 DUAL-WRITE PROBE IS UNIMPLEMENTABLE AS SPECIFIED — Beyond contradicting §25.4, the probe is a gate-blocking deliverable ("Projection divergence (dual-write comparator) | zero unexplained") with no implementation anywhere: no file in §27, no phase in §26, no interface in §13, no test in §28. It requires a write-path hook into `mission-tasks-repo.ts` plus a periodic comparator process, neither of which exists in the plan. Stage 4 is described as "the important one" and cannot be executed.

**P1-G5.** §32 Q9 IS FLAGGED AS BLOCKING BUT PHASE 3 HAS NO CONTINGENCY — Q9 ("What is the scripted path to create the first company and board user in an `authenticated`-mode Paperclip container?") is self-described as "**Blocks the entire integration test lane** (R19) and the Stage 3 bootstrap. This is the highest-priority unknown in the plan." Yet §26 Phase 3 specifies its bootstrap implementation steps as settled fact with no branch for the case where none of the three candidate paths (`paperclipai onboard --yes --run`, the setup-token route, the invite handshake) works, and Phase 3's Dependencies field says only "Phase 2 healthy" — it does not list Q9 as a gate. Phase 3, Phase 6 and the whole §28.4 integration lane sit downstream of an unresolved unknown that the phase plan treats as resolved.

**P1-G6.** §26 PHASE FIELD LABELS DRIFT FROM THE SPEC — All 11 phases (0-10) carry all 12 required fields, but three are consistently renamed: "Files/modules affected" for "Files affected", "New files/modules" for "New files", "Database changes" for "DB changes". Content is complete in every phase; flagging only because a mechanical field-name check against the spec will report 33 false misses.

## Pass 2 — citation and fabrication audit

**Verdict.** The plan is unusually well-sourced: I verified roughly 250 line-anchored citations plus every cited file path, route registration, and table/column name, and the overwhelming majority are exact. Load-bearing claims I independently confirmed include the four `/api/missions*` handler offsets (handler.ts:3096/3110/3171/3203), all Paperclip routes the ACL calls (issues.ts:5702 list + :5748 updatedSince + :5853-5854 sortField/sortDir plumbing, :8055 create, :8943 patch, :8392 children, :7540 work-products, :7996 approvals, :10536 checkout, :10662 release, :11616 comments, agents.ts:4306 wakeup), `requireAgentRunId` at issues.ts:3924-3930, the `checkout_run_id → heartbeat_runs` FK, all 20 cited Paperclip table names, the zero-RLS finding (0 hits across all migrations), the absence of a committed OpenAPI file, and every Netzar infra citation in §22. Thirteen citations are wrong and must be fixed before this is handed to an engineer. Two are hard fabrications — a PAPERCLIP path that does not exist (`server/src/types/work-product.ts`) and a NETZAR path that does not exist (`src/lib/scheduler/runner-lease.ts`) — and both have a correct sibling cited elsewhere in the same plan. The worst cluster is in s4: five `schema/issues.ts` line numbers carry a systematic ~+92-100 offset, four of them past the end of a 179-line file, and they anchor the reconciler's index-coverage argument (§13/§14) — an engineer opening them finds nothing. Also material: `agents.ts:43` points at an index instead of the `adapter_type` column it describes, `agent-auth-jwt.ts:131` points at a call site instead of the env check, `live-events-ws.ts:91/240` are off (7 and 3 occurrences respectively), and `mission-tools.ts:160-167` is cited three times — including as the security control in §21 — for a `listKnownAgents()` re-validation that lives at :58/:84-105 instead. The \"222 migrations\" headline stat is 221, and the \"32-item backlog, all approved\" claim is contradicted by the cited backlog's own status table (28 items; 2 retired, 2 blocked). None of these overturn a conclusion — the architecture argument survives every correction — but a fabricated path in a build-ready plan is exactly the defect that burns a day, so all 13 need the one-line fixes listed above.

### Fabrications and miscitations — pass 2 (13)

#### P2-F1 — `s3.md (line 1090)`

- **Claim.** "issue_work_products — 7 types × 5 providers × 9 statuses (`PAPERCLIP: server/src/types/work-product.ts:1-31`)"
- **Problem.** PAPERCLIP path does not exist. `server/src/types/` contains exactly one file, `express.d.ts`. The real file is `packages/shared/src/types/work-product.ts` — which the same plan cites correctly at s2.md:34 and s4.md:568.
- **Correction.** Change to `PAPERCLIP: packages/shared/src/types/work-product.ts:1-31` (verified: 7 types at :1-8, 5 providers at :10-15, 9 statuses at :17-25).

#### P2-F2 — `s4.md (lines 614 and 1477)`

- **Claim.** "index-backed by `issues_company_updated_idx (company_id, updated_at)` (`schema/issues.ts:191`)"
- **Problem.** `packages/db/src/schema/issues.ts` is only 179 lines — line 191 does not exist. `companyUpdatedIdx: index("issues_company_updated_idx").on(table.companyId, table.updatedAt)` is at line 99.
- **Correction.** Change both occurrences to `schema/issues.ts:99`.

#### P2-F3 — `s4.md (line 272)`

- **Claim.** "backed by the partial expression index `issues_open_normalized_title_created_idx`, `schema/issues.ts:194-198`"
- **Problem.** Out of range (file has 179 lines). The index is declared at lines 101-108.
- **Correction.** Change to `schema/issues.ts:101-108`.

#### P2-F4 — `s4.md (lines 45 and 1477)`

- **Claim.** "`issues.identifier` is *globally* unique (`issues_identifier_idx`, `schema/issues.ts:206`)"
- **Problem.** Out of range (file has 179 lines). `identifierIdx: uniqueIndex("issues_identifier_idx").on(table.identifier)` is at line 110.
- **Correction.** Change to `schema/issues.ts:110`.

#### P2-F5 — `s4.md (line 1477 table row)`

- **Claim.** "`issues_company_assignee_status_idx` | `(company_id, assignee_agent_id, status)` (`:182`)"
- **Problem.** Line 182 does not exist (file has 179 lines). `assigneeStatusIdx: index("issues_company_assignee_status_idx")` is at line 82. Note the whole s4 schema/issues.ts citation family carries a ~+92/+100 offset.
- **Correction.** Change to `schema/issues.ts:82`.

#### P2-F6 — `s1.md (line 205)`

- **Claim.** "`agents.adapter_type` … is a plain `text` column with **no DB enum and no FK** (`PAPERCLIP: packages/db/src/schema/agents.ts:43`)"
- **Problem.** Line 43 is `companyReportsToIdx: index("agents_company_reports_to_idx")…` — an index declaration, not the column. The claim itself is true but points at unrelated code.
- **Correction.** Change to `PAPERCLIP: packages/db/src/schema/agents.ts:26` (`adapterType: text("adapter_type").notNull().default("process")`).

#### P2-F7 — `s4.md (line 23)`

- **Claim.** "`agents.name` is `text().notNull()` with **no unique index** (`schema/agents.ts:44-48` declares only `agents_company_status_idx`, `agents_company_reports_to_idx`, `agents_company_default_environment_idx`)"
- **Problem.** `schema/agents.ts` is 46 lines, so 47-48 do not exist. The three named indexes are at lines 42, 43, 44; the index block is 41-45.
- **Correction.** Change to `schema/agents.ts:41-45`.

#### P2-F8 — `s2.md (line 709)`

- **Claim.** "Netzar already ships a lease primitive in `claudeclaw-queue-lease` (`src/lib/scheduler/runner-lease.ts:32`)"
- **Problem.** Path does not exist. `src/lib/scheduler/` contains only backfill/delivery/eb-scheduler/local-time/queue-drain. The file is `src/lib/state/runner-lease.ts` — which the plan cites correctly in s1.md:728, s3.md:385, s4.md:417/1090, s5.md:850, s6.md:445/1347/1843.
- **Correction.** Change to `NETZAR: src/lib/state/runner-lease.ts:32` (line 32 is `const TABLE = process.env.TABLE_QUEUE_LEASE ?? 'claudeclaw-queue-lease';`).

#### P2-F9 — `s5.md (lines 1011 and 1724), s7.md (line 1218)`

- **Claim.** "`autoAssign` … re-validates against `listKnownAgents()` (`mission-tools.ts:160-167`)" — presented in s5 §21 as the security control that "stops 'assign this to the agent with production credentials' from working"
- **Problem.** Lines 160-167 of `src/lib/tools/mission-tools.ts` are the `create_mission` tool's try/catch fallback around `autoAssign` (`logger.warn(...)`, `owner = ctx.agentId`). There is no allow-list re-validation there. The actual re-validation is `parseAssignResponse` (`if (!owner || !validAgents.includes(owner))`), and `listKnownAgents()` is read inside `autoAssign` itself.
- **Correction.** Change to `NETZAR: src/lib/tools/mission-tools.ts:58` (`const ids = listKnownAgents();`) plus `:84-105` (`parseAssignResponse`, allow-list check at :98-103).

#### P2-F10 — `s5.md (line 409), s7.md (line 919)`

- **Claim.** "If `PAPERCLIP_AGENT_JWT_SECRET`-equivalent config is unset, `jwtConfig()` returns null (`PAPERCLIP: server/src/agent-auth-jwt.ts:131`)"
- **Problem.** Line 131 is `if (!config) return null;` inside a *consumer* function (which received `config` from a `jwtConfig()` call on line 130). The env read and the actual null return live in `jwtConfig()` at lines 39-41.
- **Correction.** Change to `PAPERCLIP: server/src/agent-auth-jwt.ts:39-41` (`const secret = process.env.PAPERCLIP_AGENT_JWT_SECRET?.trim() || process.env.BETTER_AUTH_SECRET?.trim(); if (!secret) return null;`).

#### P2-F11 — `s1.md (line 244), s2.md (lines 55, 1008), s3.md (line 127), s4.md (line 460), s5.md (lines 586, 1075)`

- **Claim.** "`wss://…/api/companies/{cid}/events/ws` (`PAPERCLIP: server/src/realtime/live-events-ws.ts:91` path regex …)" — repeated 7 times
- **Problem.** Line 91 is blank. `function parseCompanyId(pathname)` is at 92 and the regex `/^\/api\/companies\/([^/]+)\/events\/ws$/` is at 93.
- **Correction.** Change all occurrences to `PAPERCLIP: server/src/realtime/live-events-ws.ts:93`.

#### P2-F12 — `s1.md (line 244), s4.md (line 460), s5.md (line 586)`

- **Claim.** "`:240` 30 s ping/pong"
- **Problem.** Line 240 is `) {` (the close of the options parameter list). The keepalive is `const pingInterval = setInterval(…)` at line 245 with `socket.ping()` at 252 and `}, 30000)` at 254.
- **Correction.** Change to `PAPERCLIP: server/src/realtime/live-events-ws.ts:245-254`.

#### P2-F13 — `s1.md (lines 15, 79, 99, 197), s2.md (line 46)`

- **Claim.** "**222 sequential SQL migrations**" / "**222 numbered `.sql` files**, `0000_…` → `0222_…`" / "zero row-level security across all 222 migrations"
- **Problem.** `packages/db/src/migrations/` contains 221 `.sql` files. Numbering does run 0000→0222, but 0126 and 0130 are absent — 222 is the highest index, not the count. (The substantive RLS finding is correct: 0 migration files contain `ROW LEVEL SECURITY`.) Same section also states "Drizzle schema (120 files, ~7,092 LOC)"; the LOC figure is exact but there are 116 `.ts` files in `packages/db/src/schema/`.
- **Correction.** Say "221 migration files, numbered 0000→0222 (0126 and 0130 absent)", and "116 schema files, 7,092 LOC".

### Internal contradictions — pass 2 (4)

**P2-C1.** s1.md:519 vs. its own cited source. The plan says "**MISSION-011 through MISSION-034 are all `approved` and unstarted**", but the status table in `NETZAR: docs/missions-v2-backlog.md:42-72` records MISSION-013 as `Retired / outcome: rejected`, MISSION-033 as `Retired / outcome: superseded`, and MISSION-021 and MISSION-032 as `work_state: blocked` — not `approved`. Fix: "MISSION-011 through MISSION-034 are unstarted; 20 are `approved`, 2 are `blocked` (021, 032), and 2 are retired (013, 033)."

**P2-C2.** "32-item backlog" (s1.md:13, s1.md:519, s2.md:962, s7.md:1024) vs. `docs/missions-v2-backlog.md`. The status table lists 28 IDs (MISSION-001/002/003, 010, and 011-034 — there is no 004-009). The "831 lines" figure in s1.md:519 is exact; the item count is not. Fix: "28-item backlog (26 after the two retired IDs)."

**P2-C3.** The `POST /api/missions` capability-gate line number disagrees across sections: s3.md:880 says `handler.ts:3113-3115`, s3.md:917 says `at :3113`, s5.md:248 says `handler.ts:3116`. The actual `if (!(await hasCapability(c, 'agents:write')))` is at `src/adapters/dashboard/handler.ts:3115` (the 403 return is :3116). Pick :3115 everywhere.

**P2-C4.** Minor line drift on otherwise-correct claims, worth a sweep before build: `NETZAR: infra/lib/constants.ts:17` for `CCE_NAME_SUFFIX` (actual :16, cited 4×); `handler.ts:3166` for the `201 { mission }` envelope (actual :3168, s7.md:213); `agent-loop.ts:326` for `GUARDRAIL_BLOCK_NOTICE` (actual :328); `PAPERCLIP: server/src/index.ts:1290` described as "`setInterval` … calling `heartbeat.tickTimers()`" (actual: `startHeartbeatSchedulerInterval(...)` at :1291, `.tickTimers(new Date())` at :1313); s4.md:614's `sortDir` cite `:5742-5745` (actual read at routes/issues.ts:5741) and "both plumbed `:5852-5853`" (actual :5853-5854).

### Gaps — pass 2 (1)

**P2-G1.** No gap assessment against the 33-section spec is possible from what I was given — the spec text was not supplied to this audit, only the seven section files. Structurally, all 33 required top-level sections are present across s1-s7 (1. Executive Summary … 33. Final Recommendation), plus an extra "34. Decision Log". Nothing is missing at section granularity.

