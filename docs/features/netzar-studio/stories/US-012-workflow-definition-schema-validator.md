# [US-012] Workflow definition schema + validator

> Backlog task NZR-12 ([backlog](../backlog.md)). Plan story: [US-000](US-000-netzar-studio-rebuild.md). Requirement IDs: FR-001, FR-004, FR-008, AC-002, AC-020, AC-021.

## 1. User Story Statement
* **As a** Persona B, business process owner (PRD 1.3)
* **I want** every workflow saved as versioned data that one validator checks, with errors that name the step in plain words
* **So that** a draft that cannot run is caught and explained before I test it, and nothing I described is silently dropped

---

## 2. Business Context & Description
* **Background:** Workflows are versioned data (blueprint section 2, Q16); one-way door D4 (ARCHITECTURE section 7) recorded in ADR 0025 (NZR-8). Step kinds: trigger, agent, decision, approval, output (DATA-MODEL row "WorkflowDraft revision"). Agent steps pin an immutable agent version (DATA-MODEL row "WorkflowVersion" `agentPins`, NZR-22). ARCHITECTURE R9 warns against two workflow formats. **PENDING OWNER Q95:** "should the validator refuse any workflow where an external write (email, update, webhook out) has no approval step before it?" Recommended answer ✅ "Yes, approval required before every external write in MVP". AC-002 (valid draft without code), AC-020 (no step silently disappears), AC-021 (unsupported constructs shown, not discarded).
* **Current behaviour (d1d3a66):**
  - `src/lib/workflows/` does not exist (`ls` fails).
  - The only workflow-like format is the pack schema `src/lib/packs/schema.ts` (zod, `.strict()` everywhere): `agentDefinitionSchema` (`:8-13`, `id` = slug `/^[a-z0-9-]+$/`, `:3`); `policiesSchema.approvalGates[{pipeline, stage, decisionClass}]` (`:49-52`); `packManifestSchema.resources.pipelines` = paths to **Paperclip pipeline JSON** (`:59-79`); `decisionClasses[{id /^[a-z][a-z0-9_]*$/, impact, default}]` (`:76`). It is read by `scripts/lib/pack/validate.ts:3-9`, which returns `PackFinding {code, file, pointer, message}`.
  - Approval payload binding: `src/lib/work/approvals.ts:39` `approvalPayload(key, payload, decisionClass)` hashes the exact payload; class id regex `CLASS_ID` (`:45`).
  - Agent ids: `AGENT_ID_RE = /^[a-z][a-z0-9_-]{0,29}$/` (`src/lib/agents/agent-manager.ts:42`). Differs from the pack slug.
  - Agent loading: `loadAgent(agentId)` (`src/lib/config/agent-loader.ts:248`) falls back to `main` for unknown ids (`:253`), so it cannot be used to check that an agent exists. `listKnownAgentsAsync()` (`:290`) can.
  - Roles: `TEMPLATED_PROFILE_IDS` = seat-user, viewer, analyst, operator, admin, org-admin, owner (`src/lib/auth/permissions.ts:146-154`).
* **Target behaviour:**
  - **Schema** in `src/lib/workflows/schema.ts` (zod, like the pack schema; types via `z.infer`). Proposed v1:
    ```ts
    export const WORKFLOW_SCHEMA_VERSION = 1 as const;
    const stepId   = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);          // unique inside one workflow
    const agentId  = z.string().regex(/^[a-z][a-z0-9_-]{0,29}$/);          // = AGENT_ID_RE
    const label    = z.string().trim().min(1).max(80);                      // plain name shown to users
    const ref      = stepId;                                               // "next" / input pointers
    const decisionClass = z.string().regex(/^[a-z][a-z0-9_]*$/);           // = approvals.ts CLASS_ID

    const trigger = z.object({ id: stepId, type: z.literal('trigger'), label,
      kind: z.enum(['manual', 'form', 'webhook', 'api', 'embed', 'integration', 'schedule']),
      inputs: z.array(z.object({ key: stepId, label, type: z.enum(['text', 'number', 'date', 'file', 'choice']),
        required: z.boolean().default(true), choices: z.array(label).optional() })).max(20),
      next: ref });
    const agent = z.object({ id: stepId, type: z.literal('agent'), label, agentId,
      agentVersionId: z.string().min(1).max(64).optional(),               // required at publish; format owned by NZR-22
      instruction: z.string().trim().min(1).max(2000), uses: z.array(ref).max(10).default([]),
      next: ref.optional() });
    const decision = z.object({ id: stepId, type: z.literal('decision'), label, question: z.string().min(1).max(200),
      branches: z.array(z.object({ label, when: z.object({ from: ref, field: z.string().min(1).max(60),
        op: z.enum(['is', 'is_not', 'contains', 'more_than', 'less_than', 'is_empty', 'is_not_empty']),
        value: z.union([z.string().max(200), z.number(), z.boolean()]).optional() }), next: ref })).min(1).max(5),
      otherwise: ref });
    const approval = z.object({ id: stepId, type: z.literal('approval'), label,
      approver: z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('role'), role: z.enum(['operator', 'admin', 'org-admin', 'owner']) }),
        z.object({ kind: z.literal('user'), userId: z.string().min(1).max(64) }) ]),
      shows: z.array(ref).min(1).max(10), decisionClass: decisionClass.optional(),
      onReject: z.union([z.literal('stop'), ref]).default('stop'), next: ref.optional() });
    const output = z.object({ id: stepId, type: z.literal('output'), label,
      kind: z.enum(['record', 'notify', 'email', 'update', 'webhook_out']),
      from: z.array(ref).min(1).max(10),
      target: z.object({ connection: z.string().regex(/^[a-z][a-z0-9_-]{0,59}$/).optional(),   // an install connection id, never a URL
        recipientFrom: z.object({ from: ref, field: z.string().min(1).max(60) }).optional() })  // address comes from data, never a literal
        .strict().default({}), next: ref.optional() });
    const unsupported = z.object({ id: stepId, type: z.literal('unsupported'), label,
      original: z.string().max(2000), reason: z.string().max(200), next: ref.optional() });  // AC-021 placeholder

    export const workflowDefinitionSchema = z.object({
      schemaVersion: z.literal(WORKFLOW_SCHEMA_VERSION), id: z.string().regex(/^wf_[0-9a-z]{10,32}$/),
      name: label, description: z.string().max(500).optional(), revision: z.number().int().min(1),
      trigger, steps: z.array(z.discriminatedUnion('type', [agent, decision, approval, output, unsupported])).min(1).max(30),
    });
    export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;
    export const EXTERNAL_WRITE_KINDS = ['email', 'update', 'webhook_out'] as const;   // Q95 list
    ```
    Rules the zod shape cannot express live in the validator: one trigger; graph runs forward only (no cycles in v1); every step reachable from the trigger; `uses`/`shows`/`from`/`when.from` point only to steps that run earlier on every path; an approver is never an agent.
  - **Validator API** in `src/lib/workflows/validate.ts`:
    ```ts
    export type ValidationMode = 'draft' | 'test' | 'publish';
    export interface ValidationContext {                    // injected; tests use fakes
      agents: { exists(agentId: string): Promise<boolean>;  // real: listKnownAgentsAsync (agent-loader.ts:290)
                versionExists(agentId: string, versionId: string): Promise<boolean> };  // real: NZR-22
      connections: { exists(connectionId: string): Promise<boolean> };  // real: the install's connector list
    }
    export interface ValidationIssue {
      code: WorkflowIssueCode; severity: 'error' | 'warning';
      stepId?: string; stepLabel?: string; path: string;   // JSON pointer, e.g. /steps/2/approver
      message: string;                                     // plain language, ≤ 200 chars, names the step label
      fix?: string;                                        // one plain sentence
    }
    export interface ValidationResult { ok: boolean; issues: ValidationIssue[]; sha256: string; }
    export function checkShape(input: unknown): ValidationResult;                       // sync, pure; draft checks
    export async function validateWorkflow(input: unknown, mode: ValidationMode,
      ctx: ValidationContext): Promise<ValidationResult>;
    export function canonicalSha256(input: unknown): string;                           // sorted-key JSON, hex
    ```
    `ok` is false when any issue has `severity: 'error'`. The validator **never changes its input**: unknown fields and unknown step types are reported and kept; storage (NZR-49) saves the original JSON and its `sha256`. Modes add checks: `draft` = shape + graph + external-write rule; `test` = + agents and connections exist + no `unsupported` step; `publish` = + every agent step has `agentVersionId` that exists. Unknown fields are **rejected** (error in every mode, SECURITY section 4 mitigation 2) but kept in the stored JSON so the user sees what was not understood (AC-021).
  - **Error catalogue** in `src/lib/workflows/messages.ts` (one place, English, plain words; `{label}` is the step's label, never its id). **PENDING OWNER Q96-Q110 (plain words):** recommended Workspace wording is "routine" for workflow, "helper" for agent and "When this happens" for trigger. The copy below uses that wording; if the owner keeps "workflow/agent", only `messages.ts` changes. Codes stay the same either way:

    | Code | Sev. (mode) | Message |
    |---|---|---|
    | `NOT_A_WORKFLOW` | error | This doesn't look like a routine Netzar can read. |
    | `SCHEMA_VERSION_NEWER` | error | This routine was made with a newer Netzar (format {n}). Update Netzar to open it. |
    | `TRIGGER_MISSING` | error | This routine has no "When this happens" step. Add how it starts, for example "when a policy document arrives". |
    | `TRIGGER_DUPLICATE` | error | "{label}" is a second "When this happens" step. A routine can start in one way only. |
    | `TRIGGER_NOT_LIVE_YET` | warning | "{label}" starts on a {kind}. You can test it with sample data; going live with it comes later. |
    | `STEP_TYPE_UNKNOWN` | error | "{label}" is a kind of step Netzar doesn't know ("{type}"). We kept it so nothing is lost. Replace it with a helper, choice, approval or result step. |
    | `UNSUPPORTED_CONSTRUCT` | warning (draft), error (test, publish) | "{label}" asks for something Netzar can't do yet: {reason}. We kept your words; change this step before testing. |
    | `FIELD_UNKNOWN` | error | "{label}" has a setting Netzar doesn't know ("{field}"). We kept it so you can see it; remove it or describe what you meant. |
    | `STEP_ID_DUPLICATE` | error | Two steps share the name "{id}". Each step needs its own name. |
    | `LABEL_MISSING` | error | Step {n} has no name. Give it a short name people will understand. |
    | `NEXT_UNKNOWN` | error | "{label}" goes on to a step that doesn't exist. |
    | `CYCLE` | error | "{a}" leads back to "{b}", so the routine would go round in a circle. Routines must move forward. |
    | `UNREACHABLE` | error | "{label}" can never run because no step leads to it. |
    | `REF_NOT_EARLIER` | error | "{label}" uses the result of "{ref}", which doesn't always run before it. |
    | `AGENT_UNKNOWN` | error (test, publish) | "{label}" uses a helper that doesn't exist ("{agentId}"). Pick one of your helpers. |
    | `AGENT_VERSION_NOT_PINNED` | error (publish) | "{label}" must use a published version of helper "{agentName}" before you publish. |
    | `AGENT_VERSION_UNKNOWN` | error (publish) | "{label}" uses a version of helper "{agentName}" that doesn't exist. |
    | `DECISION_INCOMPLETE` | error | Decision "{label}" needs at least one path and an "otherwise" path. |
    | `APPROVER_MISSING` | error | Approval "{label}" doesn't say who approves. Choose a role or a person. |
    | `APPROVER_INVALID` | error | Approval "{label}" names an approver Netzar can't use. Choose operator, admin, org admin, owner or a named person. |
    | `OUTPUT_TARGET_MISSING` | error (test, publish) | "{label}" sends something but doesn't say where. |
    | `CONNECTION_UNKNOWN` | error (test, publish) | "{label}" sends through a connection this workspace doesn't have ("{connection}"). Ask an admin to connect it first. |
    | `EXTERNAL_WRITE_WITHOUT_APPROVAL` | error (PENDING OWNER Q95; warning if the owner picks "Only warn") | "{label}" sends something outside Netzar, but there isn't an approval on every path before it. Add an approval step before "{label}". |
    | `TOO_BIG` | error | This routine has {n} steps. The limit is 30. |
  - **Fixtures** in `src/lib/workflows/__fixtures__/`: `golden-insurance-policy-review.json` (trigger `form` "Policy document arrives" → agent "Review the policy" → decision "Gaps found?" → yes: output `record` "Gap report" → approval "Account manager approves" (role `operator`, `decisionClass: client_report`) → output `email` "Send report to client"; otherwise: output `record` "Clean review note") and these **10 malformed cases**, one expected code each:
    1. `missing-trigger.json` → `TRIGGER_MISSING`
    2. `unknown-step-type.json` (`type: "loop"`) → `STEP_TYPE_UNKNOWN`, step still present in the result path
    3. `approval-without-approver.json` → `APPROVER_MISSING`
    4. `cycle.json` (review → decision → review) → `CYCLE`
    5. `dangling-next.json` → `NEXT_UNKNOWN`
    6. `duplicate-step-id.json` → `STEP_ID_DUPLICATE`
    7. `unreachable-step.json` → `UNREACHABLE`
    8. `unknown-agent.json` (mode `test`) → `AGENT_UNKNOWN`
    9. `publish-without-agent-pin.json` (mode `publish`) → `AGENT_VERSION_NOT_PINNED`
    10. `external-write-without-approval.json` (email output straight after the agent) → `EXTERNAL_WRITE_WITHOUT_APPROVAL`

    Plus three edge fixtures not counted in the 10: `future-schema-version.json` → `SCHEMA_VERSION_NEWER`; `unknown-field.json` → `FIELD_UNKNOWN` (error, field kept); `unsupported-construct.json` → `UNSUPPORTED_CONSTRUCT` (warning in draft, error in test).
  - **Relation to the pack schema (R9):** the Studio schema is the only workflow format new code writes. It does not import pack pipeline shapes, and the pack schema is not changed in this story. Shared on purpose: `decisionClass` uses the same regex as `approvals.ts:45` / `packs/schema.ts:76`, so a Studio approval can reuse `approvalPayload` hash binding later (NZR-36). Different on purpose: agent ids follow `AGENT_ID_RE` (runtime ids), not the pack `slug`. Packs keep Paperclip pipeline bodies until NZR-37; pack format v2 (2027) embeds `workflowDefinitionSchema` (ADR 0025). A test asserts `src/lib/workflows/` has no import from `src/lib/packs/` or any Paperclip client.
* **Out of scope:** storing drafts (NZR-49); drafter output (NZR-23); preview text (NZR-24); agent version creation and the version id format (NZR-22); running steps or trigger runtime (NZR-26/35); a canvas or developer editor (2027); loops, parallel branches, timers and SLA (DO NOT BUILD row 1 keeps the scheduler/SLA ban, ADR 0024); schema v2 migration code (only the forward-only rule is written now).
* **Target Value:** golden fixture valid in all three modes; 10 of 10 malformed fixtures fail with exactly their expected code and a message containing the step label (where the step has one); 0 fixture inputs changed by validation (byte-equal after the call).
* **User Persona Profile:** Persona B, business process owner (PRD 1.3). Describes work in plain words, never writes JSON; sees validator messages through the drafter and preview. PRD: [foundation/PRD.md](../foundation/PRD.md).

---

## 3. Acceptance Criteria (Confirmation)
*Use the BDD (Behavior-Driven Development) "Given-When-Then" format for clarity.*

### Scenario 1: Golden workflow valid
* **Given** `__fixtures__/golden-insurance-policy-review.json` and a fake `ValidationContext` that knows agent `insurance-reviewer`, its version, and connection `email`
* **When** `validateWorkflow(golden, mode, agents)` runs for `draft`, `test` and `publish`
* **Then** `ok` is true with 0 errors in each mode; `sha256` equals `canonicalSha256(golden)` and is the same for the same JSON with keys in another order
* **Test:** `src/lib/workflows/validate.test.ts` › "accepts the golden workflow in draft, test and publish"; › "sha256 ignores key order"

### Scenario 2: Ten malformed cases rejected in plain words
* **Given** the 10 malformed fixtures listed in section 2
* **When** each is validated in its stated mode
* **Then** each result has `ok: false`, exactly one issue with the expected code at `severity: 'error'`, a `path` pointing at the step, and a `message` that contains the step's label and no step id, JSON pointer or code name
* **Test:** `src/lib/workflows/validate.test.ts` › "rejects <fixture> with <CODE>" (10 table-driven cases)

### Scenario 3: Unknown things are kept, not dropped
* **Given** `unknown-step-type.json`, `unknown-field.json` and `unsupported-construct.json`
* **When** they are validated
* **Then** the input object is deep-equal to a copy taken before the call; every unknown step and field appears in an issue (`STEP_TYPE_UNKNOWN`, `FIELD_UNKNOWN`, `UNSUPPORTED_CONSTRUCT`); `unknown-field.json` fails in every mode; `unsupported-construct.json` is a warning in `draft` and an error in `test`
* **Test:** `src/lib/workflows/validate.test.ts` › "never mutates input"; › "keeps unknown step types and fields as issues"; › "unsupported construct blocks test but not draft"

### Scenario 4: External write needs an approval on every path (PENDING OWNER Q95)
* **Given** a workflow where the email output is reached on one path through an approval and on another path without one
* **When** it is validated in `draft`
* **Then** it fails with `EXTERNAL_WRITE_WITHOUT_APPROVAL` on the email step; the same workflow with an approval on both paths passes; `record` and `notify` outputs never trigger the rule
* **Test:** `src/lib/workflows/validate.test.ts` › "requires approval on every path before email, update and webhook_out"; › "record and notify need no approval"
* If the owner answers Q95 "Only warn", the same tests assert `severity: 'warning'` and `ok: true`; "No rule" deletes the code and these two tests.

### Scenario 5: Future format refused, current format forward-only
* **Given** `future-schema-version.json` (`schemaVersion: 2`)
* **When** it is validated
* **Then** it fails with `SCHEMA_VERSION_NEWER` and no other issue; the file `src/lib/workflows/schema.ts` has a header comment: "v1 fields are never removed or renamed; a change that breaks v1 needs schemaVersion 2 and a migration"
* **Test:** `src/lib/workflows/validate.test.ts` › "refuses a newer schemaVersion with one plain message"

### Scenario 6: Limits and bad input do not crash
* **Given** inputs `null`, a string, an array, a 31-step workflow, and a 5,000-deep `next` chain built by a test helper
* **When** each is validated
* **Then** each returns a result (no throw) with `NOT_A_WORKFLOW` or `TOO_BIG`; the cycle and reachability walk is iterative and finishes in < 50 ms for 30 steps
* **Test:** `src/lib/workflows/validate.test.ts` › "returns NOT_A_WORKFLOW for non-objects"; › "returns TOO_BIG over 30 steps"; › "graph walk does not recurse"

### Scenario 7: One workflow format
* **Given** the files under `src/lib/workflows/`
* **When** the test scans their import lines
* **Then** none imports `../packs/` or a Paperclip module; `decisionClass` regex source equals the one in `src/lib/work/approvals.ts`
* **Test:** `src/lib/workflows/schema.test.ts` › "does not import pack or Paperclip modules"; › "decisionClass regex matches approvals CLASS_ID"

### Scenario 8: No free-form destinations
* **Given** an output step whose `target` holds `"to": "attacker@example.com"` or `"url": "https://x.example"`, and another whose `connection` is not in the install
* **When** each is validated in `test` mode
* **Then** the first fails with `FIELD_UNKNOWN` (literal addresses and URLs are not part of the schema), the second with `CONNECTION_UNKNOWN`; an output whose recipient comes from `recipientFrom` (a field of an earlier step) passes
* **Test:** `src/lib/workflows/validate.test.ts` › "refuses literal addresses and URLs in output targets"; › "refuses a connection the install does not have"

---

## 4. Technical Notes & Constraints
* **Dependencies:** [NZR-9 / US-009](US-009-foundation-plan-docs-user-stories-this-docs.md) Foundation PLAN docs + user stories (this docs PR)
* **Gates before merge (not backlog dependencies; see NOTES):** ADR 0025 (workflows are versioned data, [NZR-8 / US-008](US-008-adrs-workflows-as-data-eval-flywheel-knowledge.md)) accepted or listed WAITING (PLAN gate, D4); owner answer to Q95 before the frozen tests are committed (else build with the recommended answer).
* **UI/UX Design:** N/A: data contract. Messages are UI copy shown by NZR-23/24; they follow the plain-language rules in [design.md](../foundation/design.md) (copy may be revised by round-5 Q96-Q110 without code changes, since all text sits in `messages.ts`).
* **Non-Functional Requirements:** `schemaVersion` field; forward-only changes. Validation of a 30-step workflow < 50 ms on the VPS (`checkShape` is sync; only `ValidationContext` calls are async). Limits in [CONSTRAINTS.md](../foundation/CONSTRAINTS.md).
* **Data & Analytics:** N/A: no product event for this step; standard audit entries only.
* **Steps:**
  1. Builder (Opus, T3): commit fixtures + `validate.test.ts` + `schema.test.ts` with the tests named in section 3 against empty stubs; run `npx vitest run src/lib/workflows`; record red + SHA.
  2. Builder: `schema.ts` (zod v1 above), `messages.ts` (catalogue), `graph.ts` (iterative reachability, cycle and "runs earlier" checks), `validate.ts` (modes, `ValidationContext`, `canonicalSha256` with `node:crypto`).
  3. Builder: `npx vitest run src/lib/workflows` green; `npm run typecheck`; `npm test`.
  4. Fresh critic + security reviewer + one Greptile pass (T3, Q68); owner yes.
* **Files to change:**
  | path | change |
  |---|---|
  | `docs/features/netzar-studio/foundation/DATA-MODEL.md` (row "WorkflowDraft revision", line 115) | add a link to `src/lib/workflows/schema.ts` |
  | `src/lib/packs/schema.ts`, `scripts/lib/pack/*`, routes, `web/`, `infra/` | **no change** |
* **New files:**
  - `src/lib/workflows/schema.ts`: zod v1 schema, types, `EXTERNAL_WRITE_KINDS`, forward-only header comment.
  - `src/lib/workflows/graph.ts`: iterative reachability, cycle and "runs earlier on every path" checks.
  - `src/lib/workflows/messages.ts`: the error catalogue (all user-facing text).
  - `src/lib/workflows/validate.ts`: `checkShape`, `validateWorkflow`, `canonicalSha256`, `EXTERNAL_WRITE_RULE`.
  - `src/lib/workflows/index.ts`: re-exports.
  - `src/lib/workflows/schema.test.ts`, `src/lib/workflows/validate.test.ts`: frozen tests.
  - `src/lib/workflows/__fixtures__/*.json`: 1 golden + 10 malformed + 3 edge, synthetic data only.
* **Data changes:** none in this story (no table, key or S3 prefix). The stored shape is defined here and written by NZR-49 into `WF#<wfId>/DRAFT#<rev>` (DATA-MODEL line 115). Migration rule: forward-only; a v1 field is never removed or renamed; a breaking change bumps `schemaVersion` and ships a migration with its own story. Rollback: delete the folder.
* **Evidence:** red test output with SHA; green `npx vitest run src/lib/workflows` and full `npm test` on a clean checkout of HEAD; `npm run typecheck` output.
* **API contract:** library API only (types in section 2). No HTTP route; NZR-49 adds the routes that call it.
* **Security notes:**
  - Validation runs on drafter (model) output, which is untrusted (SECURITY 2b T1): no `eval`, no regex built from input, size limits checked before graph work, iterative walks only (no stack overflow from deep chains).
  - Output destinations follow SECURITY section 4 mitigation 2: only connections the install already has, no free-form URL, address or webhook target; the recipient comes from workflow data (`recipientFrom`).
  - Q95 rule is a prompt-injection guard: a draft cannot add an email/update/webhook-out step that runs without a human. The runtime (NZR-26/36) must still check approvals; the validator is not the only gate.
  - `approver` can only be a role ≥ operator or a named user; there is no `agent` kind, so an AI step can never be its own approver (PRD 4.6). At runtime the approver is taken from the session, never from the definition (NZR-36).
  - `instruction` and `original` text are customer data: do not log them; log codes and step ids only.
* **Test plan:** `src/lib/workflows/validate.test.ts` (Scenarios 1-6, 10 table-driven malformed cases), `src/lib/workflows/schema.test.ts` (Scenario 7). Fake `ValidationContext` in the test file; no AWS, no network (the `vitest.setup.ts` tripwire stays on). Commands: `npx vitest run src/lib/workflows`, then `npm test`, `npm run typecheck`.
* **Repo rules that apply:** frozen failing test first (C-41); never repurpose an exported name; zod style as in `src/lib/packs/schema.ts`; no new dependency (zod and `node:crypto` already used); ESM `.js` import suffixes as elsewhere in `src/`.
* **Rollback:** delete `src/lib/workflows/` (no caller exists until NZR-49/23).
* **Build slices (proposal):**
  1. Fixtures + frozen tests (red) → all Scenarios red.
  2. `schema.ts` + `messages.ts` + `checkShape` → Scenarios 2 (shape cases 1, 2, 3, 6), 3, 5, 6, 7.
  3. `graph.ts` → Scenario 2 (cases 4, 5, 7), Scenario 4.
  4. `validateWorkflow` modes + `ValidationContext` + `canonicalSha256` → Scenario 1, Scenario 2 (cases 8, 9), Scenario 8.
* **Agent gotchas:**
  - `loadAgent` returns `main` for an unknown id (`agent-loader.ts:253`); never use it to test existence.
  - zod `.strict()` rejects unknown keys; this story must report them as `FIELD_UNKNOWN` and keep them, so parse a copy and map zod `unrecognized_keys` issues; never return the parsed object as the stored value.
  - The pack `slug` allows a leading digit and no underscore; Studio agent ids use `AGENT_ID_RE`. Don't share the regex.
  - `schedule` stays in the trigger enum for design (NZR-13) but must produce `TRIGGER_NOT_LIVE_YET`; DO NOT BUILD keeps the business scheduler banned.
  - Messages must use the step **label**; tests check that ids like `step_3` never appear in `message`.
  - Q95 is pending: write the rule behind one constant (`EXTERNAL_WRITE_RULE: 'error' | 'warning' | 'off'`) so the owner's answer is a one-line change plus test expectations.

---

## 5. Estimation & Tracking
* **Epic Name:** M1 Foundations ready (cycle C1 Foundations, 2026-10-27 to 2026-11-09)
* **Priority:** Must Have
* **Story Points / Effort Estimate:** 5 (raw estimate 6 h; 1 pt is about 1 h of factory work, rounded to 1/2/3/5/8/13, Q47)
* **Rigor tier:** T3 · **Deploy reach:** local only · **Labels:** workflow

---

## 6. Definition of Ready (DoR) Checklist
*Before pulling this story into a sprint:*
- [ ] User persona and "So That" benefit are clear and verified.
- [ ] Acceptance criteria cover both happy paths and edge cases (golden, 10 malformed, kept unknowns, Q95 rule, future version, limits, one format, no free-form destinations).
- [ ] UX/UI designs: N/A: data contract (message copy in the catalogue).
- [ ] Dependencies have been identified and are unblocked (NZR-9; ADR 0025 accepted; owner answer to Q95).
- [ ] The team has reviewed and estimated the story points (5 pts; re-checked at the Nov 9 re-plan, Q71).
- [ ] Task stories (build slices) are written at this step's PLANNING, before code (Q70).

---

## 7. Definition of Done (DoD) Checklist
*Before this story can be marked as complete:*
- [ ] Code is written and follows CLAUDE.md / CONTRIBUTING.md, minimum correct diff (/ponytail).
- [ ] Peer code review is completed and approved. Full review layers incl. one Greptile pass (Q68): fresh Claude critic + security reviewer (+ NVIDIA roles after bake-off).
- [ ] The frozen failing tests in `validate.test.ts` and `schema.test.ts` came first (red SHA recorded); `npx vitest run src/lib/workflows`, `npm test` and `npm run typecheck` green on a clean checkout of the exact HEAD.
- [ ] QA: the fresh critic re-runs the gate against these criteria. UAT: N/A, no user-facing change; the owner reads the message catalogue and accepts it.
- [ ] Documentation is updated: feature HANDOFF + a dated session handoff; DATA-MODEL "WorkflowDraft revision" row links `src/lib/workflows/schema.ts`.
- [ ] Done = merged to `development` (owner yes for every merge/push, Q50) and verified locally. Staging: N/A: library only, no deploy.
