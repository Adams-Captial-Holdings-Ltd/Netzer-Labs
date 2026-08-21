---
feature: paperclip
document_role: index
status: current
observed_at: 2026-08-20
as_of_commit: 5e6325b
implemented_by:
  - src/lib/paperclip/mission-projection.ts
  - src/lib/state/kill-switches-repo.ts
  - tests/fixtures/paperclip-bootstrap.ts
  - vendor/paperclip/Dockerfile
  - vendor/paperclip/updated-since.patch
  - docker-compose.paperclip.yml
  - infra/lib/database-stack.ts
  - infra/lib/filesystem-stack.ts
  - infra/lib/network-stack.ts
  - infra/lib/secrets-stack.ts
  - infra/lib/constants.ts
  - scripts/deploy.ts
  - scripts/teardown.ts
  - scripts/lib/cost-gate.ts
  - scripts/lib/lifecycle/deploy-phases.ts
tested_by:
  - src/lib/paperclip/mission-projection.test.ts
  - src/lib/paperclip/client.paperclip.integration.test.ts
  - src/adapters/dashboard/authz-matrix.test.ts
  - src/lib/state/kill-switches-repo.test.ts
  - infra/lib/database-stack.test.ts
  - infra/lib/filesystem-stack.test.ts
decisions:
  - docs/adr/0010-paperclip-work-engine.md
  - docs/adr/0009-mission-container-model.md
evidence:
  - docs/features/paperclip/implementation-plan.md
  - docs/features/paperclip/plan-audit.md
---

# Paperclip integration

## 1. Start Here

This folder documents the integration that makes Paperclip — an open-source
agent work-tracking system, self-hosted as a pinned container — the system of
record behind Netzar's Missions feature. **Everything needed to continue this
work is in this folder or is linked from it.** Nothing lives in a chat log or a
scratchpad any more.

Read in this order:

| # | Read | For |
|---|---|---|
| 1 | [HANDOFF.md](HANDOFF.md) | Where the work stands right now, and the single next action |
| 2 | [ADR 0010](../../adr/0010-paperclip-work-engine.md) | The ratified decisions — DL-1 … DL-9 verbatim, the hard constraints, the 2026-08-18 patch amendment |
| 3 | [plan-audit.md](plan-audit.md) | The 16 wrong citations and 4 structural defects in the plan — **read before the plan, not after** |
| 4 | [implementation-plan.md](implementation-plan.md) | The §1–§34 design study and the 10-phase build sheet for everything not yet built |
| 5 | [handoffs/](handoffs/2026-08-18-codex-review.md) | Session history: what was already tried, and why it failed |

**Source code is the ultimate truth for present behavior.** Where a document
and the implementation disagree, the code wins; inspect it and correct the
document.

### The one rule about the plan

[implementation-plan.md](implementation-plan.md) is the blueprint for Phases
2–10, and it is **historical** — true when written on 2026-08-18, not
maintained since. Two things have already overtaken it:

- **ADR 0010's amendment supersedes its "no Paperclip source changes" premise.**
  The pinned release does not implement `updatedSince` at all, which invalidated
  the plan's mandatory durable reconciler feed. The self-hosted copy now carries
  one approved patch.
- **[plan-audit.md](plan-audit.md) corrects 16 of its citations**, two of which
  are paths that do not exist. Check a citation there before you follow it.

## 2. What paperclip does today

Verified and in `development`:

- **A pure projection** (`src/lib/paperclip/mission-projection.ts`) translating
  Paperclip's issue shape to Netzar's legacy Mission shape, with typed rejection
  of unassigned issues and neutralization of hostile text.
- **A patched, pinned artifact** (`vendor/paperclip/`) —
  `netzer-paperclip:2026.722.0-netzar.1`, built from the immutable upstream
  digest plus a committed 37-line `updatedSince` patch, recompiled in-image by
  the `tsc` the image already ships.
- **A disposable local integration harness** (`docker-compose.paperclip.yml`):
  that patched image plus PostgreSQL 17, driven by
  `npm run test:paperclip:up` / `:down` / `:all`.
- **An authenticated, idempotent, secret-safe bootstrap fixture**
  (`tests/fixtures/paperclip-bootstrap.ts`) provisioning one company, two mapped
  HTTP agents, and three API keys.
- **Two live contract probes**: I3 (the `updatedSince` strict millisecond
  watermark) and FI-4 (fabricated run ids die at the `heartbeat_runs` foreign
  key with SQLSTATE 23503). Both green against the patched image.
- **The `paperclip_disabled` kill switch**, registered in all three
  hand-maintained places in `src/lib/state/kill-switches-repo.ts` (registry now
  41), plus a pinned four-route mission authorization matrix guarding the future
  route swap.
- **Phase 1 infrastructure, as code only, and gated off**: `CCE-Database`
  (Aurora Serverless v2 PG 17) and `CCE-Filesystem` (encrypted EFS + log group)
  are synthesized **only when `CCE_PAPERCLIP_ENABLED=1`**, which is unset
  everywhere. `cdk ls` returns 15 stacks with the flag off and 17 with it on.
  Ungated and therefore present in every environment: the `PaperclipSg` on port
  3100 and the `/claudeclaw/paperclip` secret with `REPLACE_ME` placeholders —
  both already deployed to staging, both `RETAIN` with fixed names, so removing
  them from the template now would orphan them (see the Phase 1 audit session
  log, **P16**). The `better_auth_secret` field is populated by deploy phase b
  when `PAPERCLIP_BETTER_AUTH_SECRET` is set; the other three stay `REPLACE_ME`
  until a later phase mints them against the running instance. The second ECR
  repository is created in deploy phase a **only when armed**, and deleted by
  teardown. The cost gate prices the substrate only when it is armed. `cdk synth` is clean and
  `CCE-Compute` has **zero** Paperclip references.

It is **not yet**: a Paperclip client, a reconciler, an ACL over
`/api/missions*`, agent tools, or any Missions UI change. **Nothing is
deployed.** No AWS resource has been created and no production runtime behavior
has changed.

## 3. Current status and current source commit

**Source evidence only.** Verified at commit
`6996f64efaace96bb4b19246e4a870be341290c1` on
`fix/paperclip-phase2-readiness` — the Phase 2 readiness fixes, cut from
`development` at `5418497` (the squash-merge of
[PR #81](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/81),
the Phase 1 over-engineering audit).

Deployment evidence **does not exist**. The Phase 1 stacks have never been
`cdk diff`ed or deployed against the real account; those steps are deliberately
gated on an explicit user go-ahead because they create billable resources.
Source evidence and deployment evidence are not the same thing and are not
conflated anywhere in this folder.

Phases complete: §33 first milestone (1A–1D), Phase 0, Phase 1 **code**
(audited and corrected 2026-08-19; Phase 2 code blockers cleared 2026-08-20).
Phase 1 steps **5–8** and Phases 2–10 are unstarted; step 5 is the `cdk diff`
the plan lists before the deploy. **Step 7, the ARM64 question, is already
answered** — the pinned digest is a multi-arch index carrying `linux/arm64`,
so no `docker buildx` run is owed. See [HANDOFF](HANDOFF.md).

## 4. Source of truth

Read this table top-down. **A row beats every row below it** where they
conflict.

| Rank | Concern | Authority | Use it for |
|---|---|---|---|
| 1 | Present runtime behavior | [the code](../../../src/lib/paperclip/mission-projection.ts) and its [tests](../../../src/lib/paperclip/mission-projection.test.ts) | What the system actually does today. Beats every document. |
| 2 | Ratified architecture | [ADR 0010](../../adr/0010-paperclip-work-engine.md) | DL-1 … DL-9, the hard constraints, the 2026-08-18 patch amendment |
| 3 | Volatile state | [HANDOFF.md](HANDOFF.md) | Branch, PR, deploy state, blockers, the next action |
| 4 | Plan corrections | [plan-audit.md](plan-audit.md) | The 16 wrong citations and 4 structural defects. Beats the plan. |
| 5 | Design and build sheet | [implementation-plan.md](implementation-plan.md) | §1–§34: why this architecture, and the phase-by-phase plan for Phases 2–10 |
| 6 | Session history | [handoffs/](handoffs/2026-08-18-updated-since-patch-and-phase-0.md) | What was already attempted and why it failed. Never a statement of present state. |
| — | Exactly what runs in the harness | [Dockerfile](../../../vendor/paperclip/Dockerfile) + [patch](../../../vendor/paperclip/updated-since.patch) | The byte-exact artifact; re-evaluate on every re-pin |
| — | Live contract evidence | [integration test](../../../src/lib/paperclip/client.paperclip.integration.test.ts) | I3 and FI-4, the two proven contracts |
| — | Superseded storage model | [ADR 0009](../../adr/0009-mission-container-model.md) | What Missions v2 was; the wire contract and roles that survive |

**Not an authority:** the `.superpowers/sdd/` task briefs and `progress.md`
ledger are local, gitignored, per-machine scratch. Do not cite them.

## 5. Implementation map

| Area | Verified location | Present behavior |
|---|---|---|
| Projection | `src/lib/paperclip/mission-projection.ts` | Pure issue→Mission mapping; throws typed `UnassignedIssueError`; neutralizes hostile text |
| Harness | `docker-compose.paperclip.yml` | Builds and runs the patched pinned image + Postgres 17; `npm run test:paperclip:up/down/all` |
| Patched artifact | `vendor/paperclip/` | Immutable digest + 37-line `updatedSince` patch, recompiled in-image by `tsc`; LF pinned in `.gitattributes` |
| Bootstrap | `tests/fixtures/paperclip-bootstrap.ts` | Better Auth first-admin flow, company/agents/keys provisioning, `/dev/shm` credential cache (mode 0600), fail-closed idempotency |
| Kill switch | `src/lib/state/kill-switches-repo.ts` | `paperclip_disabled` in the union (`:109`), `ALL_KILL_SWITCHES` (`:152`, 41 total), and `KILL_SWITCH_META` (`:299`, Integrations) |
| Authz pin | `src/adapters/dashboard/authz-matrix.test.ts` | Four-route mission matrix, coarse-envelope pin, decision-level stripped-capability tests |
| Database substrate | `infra/lib/database-stack.ts` | Aurora Serverless v2 PG 17, min 0.5 ACU, deletion-protected, RETAIN, 14-day backups, generated credentials at `/claudeclaw/paperclip-db`; 5432 admitted from `PaperclipSg` **only** |
| Filesystem substrate | `infra/lib/filesystem-stack.ts` | Encrypted EFS with automatic backups, access point pinned to posix 1000:1000 at `/paperclip`, the `/claudeclaw/paperclip` log group |
| Network | `infra/lib/network-stack.ts` | `PaperclipSg` on port 3100 from the ALB — its own port, not a `PORT=3000` reuse — without touching the Fargate SG |
| Secrets and names | `infra/lib/secrets-stack.ts`, `infra/lib/constants.ts`, `scripts/lib/lifecycle/deploy-phases.ts` | `/claudeclaw/paperclip` seeded `REPLACE_ME` by CDK; deploy phase b **merges** a real `better_auth_secret` in (generated once by `npm run setup`) without disturbing the three keys minted later; suffix-aware names via `buildResourceNames()` |
| Deploy and cost | `scripts/deploy.ts`, `scripts/lib/cost-gate.ts` | Both stacks join deploy phase a **only when `CCE_PAPERCLIP_ENABLED=1`**, which `cdkEnvBag` forwards and `SYNTH_INPUT_ALLOWLIST` replays; the Paperclip ECR repo is created in phase a when armed and deleted by `scripts/teardown.ts` (the out-of-band catalog only **reports**, it never deletes); the cost gate lists and prices the substrate only when armed, and the budget default is back to 600 |

## 5b. Using the client (`src/lib/paperclip/client.ts`)

Every fenced block in this section is **executed** by
`src/lib/paperclip/readme.test.ts`, which also asserts the block is byte-identical
to the code it runs. Editing one without the other fails the suite, so these
snippets cannot silently rot.

**Constructing one.** In a deployed task use `paperclipClientFromEnvironment()`,
which reads env plus the `paperclip/base_url` runtime-config key. Everywhere
else, hand the constructor the four values directly. Construction is
**synchronous and total**: a missing base URL, company or agent key throws
`PaperclipDisabledError` here, naming the remediation, rather than becoming a
request to `undefined/api/…`.

<!-- CODE_SECTION: construct -->
```ts
const paperclip = new PaperclipClient({
  baseUrl: 'https://paperclip.internal',
  companyId: '00000000-0000-4000-8000-000000000001',
  agentKeys: { main: 'agent-key-for-main' },
  defaultActor: 'main',
});
```

**Reading a board.** The issue list answers a **bare array** — no envelope, no
`total`, no `nextOffset` — so a sweep pages until an empty page. `paginateAll()`
walks serially on purpose: identical concurrent reads coalesce, but *distinct*
concurrent reads for one actor are what trip `429 Too many concurrent
issue-list requests`. Reaching its page bound with rows still on the board
raises `PaperclipPaginationTruncatedError` rather than returning a short array —
this surface has no totals endpoint to catch an undercount against.

<!-- CODE_SECTION: paginate -->
```ts
const page = await paperclip.listIssues({
  updatedSince: '2026-08-20T00:00:00.000Z',
  sortField: 'updated',
  limit: 2,
});
const everything = await page.paginateAll();
```

The filters above survive to page 2 without being repeated: the page holds a
refetch closure captured at construction, and `fetchNext()` merges the cursor
over it.

**Catching a failure.** Every failure is a `PaperclipError` with a `type`
discriminant, the HTTP `status`, the parsed `body`, the `request` context and the
untouched original on `raw`. Rate limits carry the whole budget, and
`advertisedWaitMs()` is the wait the server actually asked for — never `NaN`,
even when the header is not a number.

<!-- CODE_SECTION: errors -->
```ts
try {
  await paperclip.getIssue('a1b2c3d4-0000-4000-8000-000000000001');
} catch (err) {
  if (err instanceof PaperclipRatelimitedError) {
    await sleep(err.advertisedWaitMs() ?? 1_000);
  } else if (err instanceof PaperclipError) {
    logger.warn({ type: err.type, status: err.status, path: err.request?.path }, err.message);
  }
}
```

**When the integration is switched off.** The `paperclip_disabled` kill switch is
checked inside the transport at **every** invoke and *before* the circuit
breaker, so no caller can bypass it and a deliberately disabled integration never
looks like an outage.

<!-- CODE_SECTION: killswitch -->
```ts
const failure = await paperclip.getHealth().catch((err: unknown) => err);
// PaperclipDisabledError, not PaperclipUnavailableError:
// "paperclip_disabled kill switch active: …"
```

## 6. Current business/state rules

- One Netzar deployment maps to one Paperclip company (DL-5).
- Unassigned Paperclip issues are rejected by the projection with a typed error;
  the future ACL filters them rather than inventing an owner.
- `updatedSince` is a strict greater-than watermark at **millisecond**
  resolution (`updated_at >= watermark + 1ms`), requires an explicit UTC offset,
  and is served by `issues_company_updated_idx`. A naive `>` is wrong: storage
  is microsecond `timestamptz`, callers only ever observe truncated values.
- Paperclip run ids are **never** synthesized (ADR 0010 hard constraint 2; a
  source assertion in the integration test forbids `randomUUID` anywhere in
  `src/lib/paperclip/`).
- `paperclip_disabled` fails open on DDB errors like the other 40 switches and
  will gate every future Paperclip call path.
- Netzar never touches Paperclip's Postgres (DL-2). Every read and write crosses
  an authenticated HTTP boundary.

## 7. Known runtime risks and approved next work

| Risk | Evidence | Approved next work |
|---|---|---|
| Phase 1 stacks have never been `cdk diff`ed against the real account | [HANDOFF](HANDOFF.md) — synth-only evidence | Phase 1 steps 6–8, gated on an explicit user deploy go-ahead |
| ~~ARM64 buildability of the patched image is unanswered~~ **RESOLVED 2026-08-20** | The pinned digest `sha256:6b9daa3c…` is an OCI image index whose `linux/arm64` child manifest is `sha256:6ab3c816…`, read from GHCR. The Dockerfile pins the index; the two differing is correct | None. The base image is multi-arch, and the whole compute plane is ARM64 already (`compute-stack.ts` `CpuArchitecture.ARM64`) |
| **Nothing builds or pushes the patched Paperclip image** | `.github/workflows/deploy.yml` has no build step; `vendor/paperclip/Dockerfile` is built only by `docker-compose.paperclip.yml` for the local test harness | [Phase 1.5 — the Paperclip image pipeline](phase-1.5-image-pipeline.md): extend `scripts/lib/lifecycle/cloud-build.ts` (the Docker-free CodeBuild path) to build it in the operator's own account. Specified 2026-08-20, not yet built. |
| **Aurora is untiered: a Tier 0 install provisions the production cluster** | `infra/lib/database-stack.ts` has zero `TIERS`/`props.tier` references | Tier-gate `serverlessV2Min/MaxCapacity`; keep `deletionProtection` and `RETAIN` (**P17**, **M19**) — decided 2026-08-20, not yet built |
| The patch must be re-evaluated on every artifact re-pin | [ADR 0010 amendment](../../adr/0010-paperclip-work-engine.md) | Drop the patch the release upstream ships `updatedSince` |
| Node-vs-Postgres clock skew can stamp an update at or before an observed watermark | [Session handoff §3.1](handoffs/2026-08-18-updated-since-patch-and-phase-0.md) | Reconciler must overlap polls rather than trust exact watermarks; owned by the client/reconciler phase |
| **The plan contradicts itself on dual-write and on the `PAPERCLIP_ENABLED` fall-through** | [plan-audit.md](plan-audit.md) P1-C6, P1-C7 | An author decision is required **before** Phase 4. Rollout (§30) and cutover (§25/§27) were written to different premises. |
| **The plan's central `MissionEngine` interface is orphaned**, and §29's POC drops ~530 specified lines | [plan-audit.md](plan-audit.md) P1-G1, P1-G2 | Propagate the indirection or rewrite §13.2 against C1/C2; add the missing §27 rows |
| Later phases (client, reconciler, ACL, tools, UI, rollout) are unstarted | [HANDOFF](HANDOFF.md) | Follow [the plan's](implementation-plan.md) §26 phases in order |

## 8. Exact focused and full validation commands

The Paperclip live suite needs Docker **and** `PAPERCLIP_TEST_AUTH_SECRET` set
in the process environment — any value, never committed. The bootstrap fixture
shells out to `docker compose`, whose YAML interpolation refuses to parse
without it, so the *vitest* process needs it too. Without the variable the live
suite skips rather than fails.

```powershell
npm run test:paperclip:up
npx vitest run src/lib/paperclip/client.paperclip.integration.test.ts --config vitest.integration.config.ts
npx vitest run src/lib/paperclip/mission-projection.test.ts src/adapters/dashboard/authz-matrix.test.ts src/lib/state/kill-switches-repo.test.ts
npx vitest run infra/lib/database-stack.test.ts infra/lib/filesystem-stack.test.ts
npm run test:paperclip:down
```

`test:paperclip:all` chains with `&&`, so when a test fails the `down` step
never runs — clean the disposable stack up explicitly.

Docs gates, required before any push that touches this folder:

```powershell
node scripts/ci/feature-knowledge.mjs
node scripts/ci/docs-links.mjs
```

Full pre-push suite: see
[development.md — How to develop a new feature](../../../development.md#how-to-develop-a-new-feature-end-to-end),
step 7. Run the **full** `npm test`, never a scoped run.

## 9. Related documents

- [Operational HANDOFF](HANDOFF.md) — current state and next action
- [Phase 1.5 — the Paperclip image pipeline](phase-1.5-image-pipeline.md) — the
  approved work definition for the last blocker on a verifiable Phase 2
- [Implementation plan](implementation-plan.md) and its [audit](plan-audit.md)
- [ADR 0010 — Paperclip is the missions work engine](../../adr/0010-paperclip-work-engine.md)
- [Feature knowledge framework](../README.md)
- [Documentation index](../../README.md)
- [Repository development guidance](../../../development.md)
