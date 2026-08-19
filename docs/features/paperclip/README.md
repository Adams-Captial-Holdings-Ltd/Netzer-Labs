---
feature: paperclip
document_role: index
status: current
observed_at: 2026-08-18
as_of_commit: a7ab7a325487c6ea06a3158f88d8cd45b73e0b53
implemented_by:
  - src/lib/paperclip/mission-projection.ts
  - tests/fixtures/paperclip-bootstrap.ts
  - vendor/paperclip/Dockerfile
  - vendor/paperclip/updated-since.patch
  - docker-compose.paperclip.yml
  - src/lib/state/kill-switches-repo.ts
tested_by:
  - src/lib/paperclip/mission-projection.test.ts
  - src/lib/paperclip/client.paperclip.integration.test.ts
  - src/adapters/dashboard/authz-matrix.test.ts
  - src/lib/state/kill-switches-repo.test.ts
decisions:
  - docs/adr/0010-paperclip-work-engine.md
  - docs/adr/0009-mission-container-model.md
---

# Paperclip integration

## 1. Start Here

This folder documents the integration that makes Paperclip — an open-source
agent work-tracking system, self-hosted as a pinned container — the system of
record behind Netzar's Missions feature. Read
[ADR 0010](../../adr/0010-paperclip-work-engine.md) for the ratified decisions
(DL-1 … DL-9 verbatim, the hard constraints, and the 2026-08-18 patch
amendment), then [HANDOFF.md](HANDOFF.md) for where the work stands right now.
Source code is the ultimate truth for present behavior. The detailed
phase-by-phase implementation plan is an external session artifact (not
tracked in this repository); its decision log is preserved verbatim in
ADR 0010 and its milestone results in the session handoffs here.

## 2. What paperclip does today

Today the integration is **first-milestone validation only**. What exists and
is verified:

- A pure projection (`src/lib/paperclip/mission-projection.ts`) translating
  Paperclip's issue shape to Netzar's legacy Mission shape, with typed
  rejection of unassigned issues.
- A disposable local integration harness (`docker-compose.paperclip.yml`):
  the pinned Paperclip release plus PostgreSQL 17, built as
  `netzer-paperclip:2026.722.0-netzar.1` from the immutable upstream digest
  plus the committed `updatedSince` patch (`vendor/paperclip/`).
- An authenticated, idempotent, secret-safe bootstrap fixture
  (`tests/fixtures/paperclip-bootstrap.ts`) provisioning one company, two
  mapped HTTP agents, and three API keys.
- Two live contract probes: I3 (the `updatedSince` strict millisecond
  watermark — green against the patched image) and FI-4 (fabricated run ids
  die at the `heartbeat_runs` foreign key with SQLSTATE 23503).
- The `paperclip_disabled` kill switch, registered in all three places in
  `src/lib/state/kill-switches-repo.ts`, plus a pinned four-route mission
  authorization matrix guarding the future route swap.

It is **not yet**: a Paperclip client, a reconciler, an ACL over
`/api/missions*`, agent tools, any AWS infrastructure, or anything deployed.
No production runtime behavior has changed.

## 3. Current status and current source commit

Source evidence only, verified at commit
`a7ab7a325487c6ea06a3158f88d8cd45b73e0b53` on branch
`codex/paperclip-integration` (2026-08-18). Nothing is deployed to any AWS
environment; deployment evidence does not exist yet.

## 4. Source of truth

| Concern | Authority | Use it for |
|---|---|---|
| Ratified architecture decisions | [ADR 0010](../../adr/0010-paperclip-work-engine.md) | DL-1 … DL-9, hard constraints, the patch amendment |
| Superseded storage model | [ADR 0009](../../adr/0009-mission-container-model.md) | What Missions v2 was; wire contract and roles that survive |
| Issue-to-Mission translation | [code](../../../src/lib/paperclip/mission-projection.ts) | Present runtime behavior |
| Pinned patched artifact | [Dockerfile](../../../vendor/paperclip/Dockerfile) + [patch](../../../vendor/paperclip/updated-since.patch) | Exactly what runs in the harness |
| Live contract evidence | [integration test](../../../src/lib/paperclip/client.paperclip.integration.test.ts) | I3 and FI-4, the two proven contracts |
| Volatile state | [HANDOFF](HANDOFF.md) | Branch, command, and next-action state |

## 5. Implementation map

| Area | Verified location | Present behavior |
|---|---|---|
| Projection | `src/lib/paperclip/mission-projection.ts` | Pure issue→Mission mapping; throws typed `UnassignedIssueError`; neutralizes hostile text |
| Harness | `docker-compose.paperclip.yml` | Builds and runs the patched pinned image + Postgres 17; `npm run test:paperclip:up/down/all` |
| Patched artifact | `vendor/paperclip/` | Immutable digest + 37-line `updatedSince` patch, recompiled in-image by `tsc` |
| Bootstrap | `tests/fixtures/paperclip-bootstrap.ts` | Better Auth first-admin flow, company/agents/keys provisioning, `/dev/shm` credential cache (mode 0600), fail-closed idempotency |
| Kill switch | `src/lib/state/kill-switches-repo.ts` | `paperclip_disabled` in the union, `ALL_KILL_SWITCHES` (41), and `KILL_SWITCH_META` (Integrations) |
| Authz pin | `src/adapters/dashboard/authz-matrix.test.ts` | Four-route mission matrix, coarse-envelope pin, decision-level stripped-capability tests |

## 6. Current business/state rules

- One Netzar deployment maps to one Paperclip company (DL-5).
- Unassigned Paperclip issues are rejected by the projection with a typed
  error; the future ACL filters them rather than inventing an owner.
- `updatedSince` is a strict greater-than watermark at millisecond resolution
  (`updated_at >= watermark + 1ms`), requires an explicit UTC offset, and is
  served by `issues_company_updated_idx`.
- Paperclip run ids are never synthesized (ADR 0010 hard constraint 2; source
  assertion in the integration test forbids `randomUUID` in
  `src/lib/paperclip/`).
- `paperclip_disabled` fails open on DDB errors like the other 40 switches and
  will gate every future Paperclip call path.

## 7. Known runtime risks and approved next work

| Risk | Evidence | Approved next work |
|---|---|---|
| Patch must be re-evaluated on every artifact re-pin | [ADR 0010 amendment](../../adr/0010-paperclip-work-engine.md) | Drop the patch the release upstream ships `updatedSince` |
| Node-vs-Postgres clock skew can stamp an update at or before an observed watermark | Reviewer note, 2026-08-18 session handoff §3.1 | Reconciler design must overlap polls rather than trust exact watermarks; owned by the client/reconciler phase |
| Later phases (client, reconciler, ACL, infra) are unstarted | [HANDOFF](HANDOFF.md) | Follow the implementation plan phases in order |

## 8. Exact focused and full validation commands

Focused (require Docker; set `PAPERCLIP_TEST_AUTH_SECRET` in the process
environment first — any value, never committed):

```powershell
npm run test:paperclip:up
npx vitest run src/lib/paperclip/client.paperclip.integration.test.ts --config vitest.integration.config.ts
npx vitest run src/lib/paperclip/mission-projection.test.ts src/adapters/dashboard/authz-matrix.test.ts src/lib/state/kill-switches-repo.test.ts
npm run test:paperclip:down
```

Full pre-push suite: see
[development.md — How to develop a new feature](../../../development.md#how-to-develop-a-new-feature-end-to-end),
step 7.

## 9. Related documents

- [Operational HANDOFF](HANDOFF.md)
- [Feature knowledge framework](../README.md)
- [Documentation index](../../README.md)
- [Repository development guidance](../../../development.md)
