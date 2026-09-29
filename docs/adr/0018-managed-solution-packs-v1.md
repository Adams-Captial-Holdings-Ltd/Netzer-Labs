# ADR 0018 — Managed Solution Packs v1: format, registry and entitlement

**Status:** Accepted (owner-approved plan, 2026-09-26; recorded 2026-09-29; touched by decisions 16, 17 and 19 and cross-plan rows X1, X2, X3 and X10). Plan number 0017; repo number 0018 — [why](../features/paperclip/decision-log.md#adr-numbers).

## Context

Netzer sells a managed Solution Pack: staff install, configure, test and support it in the customer's own AWS account, and one pack plus customer configuration plus connector mapping serves many customers without a fork ([minimum sellable product](../features/paperclip/minimum-sellable-product.md)). The first sale needs a repeatable format, install path and licensing check, and nothing more. Installs must not be hand-edited, or they become forks.

## Decision

1. **A pack is a Netzer wrapper over Paperclip bundles**: a company-portability bundle (`agentcompanies/v1`, the same code path the teams catalog uses) plus native pipeline and routine bodies, so no workflow schema is invented. Packs are **declarative only**: no executable code. The layout and the `pack.json` v1 fields are in [section F](../features/paperclip/minimum-sellable-product.md#f-minimum-pack-format-v1) of the minimum sellable product.
2. **Releases** are directories in the private repo `netzer-packs`; a release is a protected tag `<pack>/vX.Y.Z` plus a tarball sha256, immutable. New repos `netzer-packs` and `netzer-deployments` get the release plan's ruleset shapes: `*/v*` tags are immutable, and branches need a PR with zero approvals (X10).
3. **One agent format everywhere** (`agents/*.yaml`): templates, manual, imported and pack agents share one schema. A pack creates **namespaced** agents (for example `bhr-intake`); config may map a role to an existing customer agent (`agentRef`), which must satisfy the role's tool allowlist. Skills live in Netzer agent config (`skills/*.md`).
4. **Pipeline key per pack version** with per-key routines and agent configs ([ADR 0012](0012-paperclip-owns-work-state.md)).
5. **Configuration and entitlement live in the deployment registry**: the private git repo `netzer-deployments` (PR-reviewed, no PHI, PII or secrets), one `customers/<id>.yaml` per customer. Config is projected into an installation record in the customer deployment, so every installation is recorded twice. `pack preflight|install|activate|upgrade` refuse unless the pack is listed. The seam is `checkEntitlement()`; it later reads a signed entitlement file or an AWS Marketplace entitlement instead.
6. **Installs are a runbook plus scripts.** Every dangerous step is a script that is journaled and never hand-run (`pack validate`, `preflight`, `install`, `test`, `activate`, `status`, `effect resolve`). `pack install` is idempotent and a re-run resumes. `pack upgrade` and `pack rollback` land before the first pack update ships ([step 11](../features/paperclip/minimum-sellable-product.md#build-steps)).
7. **Signing is soon, not first.** Pack signing and the key ceremony (`TRUST_ROOTS`) are step 14. Pack signing reuses the release signing module with a **separate pack trust-root set**: a pack key must never verify a Netzer release, and there is no second platform ceremony (X3).
8. **Customer installs verify the release, import its signed digests and never build** (X1). Preflight verifies the deployed release's signature (X2); this replaces the earlier plan to run `npm run setup` or `deploy` from a release tag.
9. **Later owner decisions that touch this ADR** (full text in the [decision log](../features/paperclip/decision-log.md)):
   - **decision 16:** Behavioral Health is a staging-only test pack; the owner's first real pack goes to Customer #1; authoring uses the same files and tools as staff, with no visual builder in v1.
   - **decision 17:** resale is forbidden and a lapsed customer keeps what they have (no remote kill switch, no call-home); the account-bound signed license file stays in step 14.
   - **decision 19:** customers maintain their own system after hand-over, with pack upgrade and signing extended for it.

**Decided by.** Jev: envelope over Paperclip bundles 1.0, key-per-version 1.0, declarative packs 0.91, config in the registry and installation record 0.98, entitlement via the registry 0.98, signing should-have-soon 0.85, namespaced agents with optional mapping 0.81, runbook plus scripts 1.0, agent templates to one format 0.88, skills in Netzer agent config 0.88, offline entitlements as the later target 1.0. Owner: YES on one agent format. VERIFIED: the teams catalog uses portability import.

## Consequences

Good: one pack serves many customers by configuration, and the release, install and entitlement steps are repeatable and auditable.

Bad:

- Staff-run installs can vary (Med). Every dangerous step is scripted and journaled.
- Until signing lands, artifact integrity rests on protected tags, checksums and the fact that customers receive packs only through Netzer staff.
- Until upstream portability ships, the pipeline and routine bodies in a pack are interim serialized bodies.

- **Reversibility:** one-way. The pack format and the registry layout are the contract that installs and customer records depend on.
- **Revisit trigger:** step 14 (signing and the signed license file), step 15 (upstream pipeline portability replaces the interim bodies), or the reuse test finding customer-specific debt.

## Alternatives considered

- **An invented pack or workflow schema.** Rejected: reuse Paperclip and Netzer formats.
- **Executable code in packs.** Rejected: [DO NOT BUILD](../features/paperclip/do-not-build.md).
- **An online license server as a runtime dependency.** Rejected: registry check now, signed entitlement later.
- **Cryptographic signing before Customer #1.** Rejected (Jev 0.85): signing is a should-have soon, not first.
- **A separate skills store, or a second agent format.** Rejected: [DO NOT BUILD](../features/paperclip/do-not-build.md).
- **A public marketplace, and one-click or self-service install and uninstall.** Deferred until there is revenue (section E of the minimum sellable product).
