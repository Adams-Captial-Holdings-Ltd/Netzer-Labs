# ADR 0019 — Paperclip compatibility program

**Status:** Accepted (owner-approved plan, 2026-09-26; recorded 2026-09-29; touched by cross-plan rows X2 and X9). Plan number 0018; repo number 0019 — [why](../features/paperclip/decision-log.md#adr-numbers).

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
