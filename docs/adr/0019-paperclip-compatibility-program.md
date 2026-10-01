# ADR 0019 — Paperclip compatibility program

**Status:** Accepted (owner-approved plan, 2026-09-26; recorded 2026-09-29; touched by cross-plan rows X2 and X9; outcome of the step-2 re-pin recorded 2026-10-01 at the end). Plan number 0018; repo number 0019 — [why](../features/paperclip/decision-log.md#adr-numbers).

## Context

Netzer consumes Paperclip as a pinned container image and must never fork it ([ADR 0010](0010-paperclip-work-engine.md) DL-9). Upstream releases about once a week (the evidence is in ADR 0010 DL-9), pipelines are marked experimental, and some behavior Netzer relies on is unverified until the step-2 contract tests (company import semantics, concurrency defaults). Netzer runs `v2026.722.0` (`e55d702`); the latest release is `v2026.916.1` (`d554c47`) ([minimum sellable product](../features/paperclip/minimum-sellable-product.md)).

## Decision

1. **Re-pin first**, to v2026.916.x, under a compatibility program ([step 2](../features/paperclip/minimum-sellable-product.md#build-steps)). **Never fork.**
2. **The program:** a digest pin, a compatibility matrix and a contract suite (run on the old pin first, then on the new digest). Cadence: monthly review, quarterly adopt, and immediate security re-pins. The staging canary is release-plan step 6 running the Paperclip contract suite on every release candidate (X9). Patches are a last resort, each with an upstream issue.
3. **What the re-pin changes.** It deletes `vendor/paperclip/updated-since.patch` (upstream is native and strict `>`, so the reconciler keeps its overlap window), makes the P0-3b workaround moot (agents write visible issues, @817), and brings credential redaction (@916) and the SSRF allowlist. The P0-0b image-build fix lands in the same step.
4. **The pin is enforced at install** (X2). Preflight requires that the running ECS digests equal the signed digests and that the signed Paperclip digest is in `compatibility.paperclip.tested`. The deploy-manifest `release` field is only a pointer.
5. **IP boundary.** Paperclip is MIT © 2025 Paperclip AI. Ship its LICENSE and Inter OFL 1.1 in `THIRD_PARTY_NOTICES` and the SBOM. There is no "Paperclip" branding in the customer UI, and it is never presented as Netzer IP. Netzer IP is packs, agents, policies, pack tooling, Work UX, governance and deployment.

**Decided by.** Jev: compatibility program 1.0; re-pin first 0.85 and 0.69. Owner: YES to re-pin first. Netzer never forks: owner and Jev 1.0.

## Consequences

Good: upstream changes arrive on a schedule Netzer controls, and each one is proven by tests before it reaches a customer.

Bad:

- "Pipelines experimental" is a High risk. Mitigation: contract tests on every route used, key-per-version, and upstream PRs.
- The re-pin is real work before any pack work: the contract suite, instance settings, the fail-closed check and the image-build fix.

- **Reversibility:** two-way for pins. Forking is the one-way direction and stays out of bounds (ADR 0010 DL-9).
- **Revisit trigger:** the contract suite is red at the candidate digest (step 2), or an immediate security re-pin is needed.

## Alternatives considered

- **Forking Paperclip, or plugins.** Rejected: [DO NOT BUILD](../features/paperclip/do-not-build.md), and ADR 0010 DL-9.
- **Patches as a way of life.** Rejected: patches are a last resort, each with an upstream issue.
- **Building packs on v2026.722.0 first and re-pinning later.** Rejected: the owner said re-pin first.
- **Tracking the latest tag.** Rejected in ADR 0010 DL-9.

## Outcome of the step-2 re-pin (2026-10-01)

Work Platform step 2 carried out decision 1 and 3 above on branch `feature/wp-step2-repin-runtime-lock` (merge pending). The facts below were measured against real containers, not read from docs.

- **The pin.** `ghcr.io/paperclipai/paperclip:2026.916.1@sha256:a02ac35ac41df911af477422ea0e781cf41d2b2c600c66f0a5ac9d8c63f52c2c`, the multi-architecture index digest of upstream v2026.916.1 (commit d554c47). It replaces v2026.722.0 (commit e55d702, index `sha256:6b9daa3c...`).
- **No patch and no instruction.** `vendor/paperclip/updated-since.patch` is deleted and `vendor/paperclip/Dockerfile` is a single `FROM` line. Live check: the unmodified image answers `GET /` with `SERVE_UI=true` as 200 `text/html`, byte-identical to the image built with the old UI symlink, because `server/src/app.ts` now tries `../ui-dist` and then `../../ui/dist`. "Patches are a last resort" held: none is carried.
- **Order of proof.** The contract suite ran on the old pin first and passed (30 passed, 15 skipped, both snapshots byte-identical). On the new image its first complete run had 14 failures (12 of them in the old suite, one in the client test, one in the new updatedSince file), each explained below; after the corrections and a read of both regenerated snapshots, 45 of 45 pass and the snapshots are stable. The reconciler boot probe was changed to signals that are true on both pins (a future stamp returns `[]`; `not-a-date` is a 400).
- **What the new pin changed (each is pinned by a test now).**
  - `updatedSince` is strict `>` over a microsecond column while the API shows millisecond stamps. A watermark equal to a row's own stamp re-returns that row (5 of 5 measured), one millisecond after excludes it, one before includes it. Offset-less values are accepted; a malformed value is a 400. The old patch's 1 ms row loss is gone; duplicates remain, so the reconciler keeps its overlap and dedupe.
  - Agent comments and agent field updates need a valid heartbeat run. Without one, and with a made-up run id, they answer 403 `Cross-issue writes need a run to attribute them to ...`; a board session can still comment. Source: `assertCrossIssueInfluenceWithinRunCap` (a per-run cap of 20 cross-issue writes, enforced since 2026-08-11). Netzer's dispatch path carries the run id, but **agent tools called outside a dispatch (chat, Slack) hold none and will be refused**. That needs an owner decision in a later step; nothing here changes it.
  - A delegation-cycle guard: 409 when a child issue is assigned to the agent that created one of its ancestors.
  - `sortField` also accepts `id`; the anonymous health body adds `commit` (the build's git sha, so a pin can now be identified by commit), `hiddenSettings` and `localAiLoginSupported`; validation messages use zod 4 wording; wakeup is documented as 202; the OpenAPI document has 838 operations (it had 590) and an empty create-issue body schema.
  - The server refuses to start if its decision-signing secrets directory is not owned by its own user (setting `PAPERCLIP_DECISION_SIGNING_SECRET` skips the file). The production task writes `/paperclip` through an EFS access point that matches the `node` user, so it should pass; the directory's owner is to be checked on the staging trip.
- **Still open.** The staging trip and the slow image-orchestrator test were not run in this step.
