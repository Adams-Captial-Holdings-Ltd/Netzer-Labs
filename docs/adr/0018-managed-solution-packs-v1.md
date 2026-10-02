# ADR 0018 — Managed Solution Packs v1: format, registry and entitlement

**Status:** Accepted (owner-approved plan, 2026-09-26; recorded 2026-09-29; touched by decisions 16, 17, 18 and 19 and cross-plan rows X1, X2, X3 and X10; amended 2026-09-30 for roadmap v2, decisions 20, 22, 24, 25, 26 and 29 and rows X12 and X13). Plan number 0017; repo number 0018 — [why](../features/paperclip/decision-log.md#adr-numbers).

## Context

Netzer sells a managed Solution Pack: staff install, configure, test and support it in the customer's own AWS account (decision 18, below, limits what staff can do there), and one pack plus customer configuration plus connector mapping serves many customers without a fork ([minimum sellable product](../features/paperclip/minimum-sellable-product.md)). The first sale needs a repeatable format, install path and licensing check, and nothing more. Installs must not be hand-edited, or they become forks.

## Decision

1. **A pack is a Netzer wrapper over Paperclip bundles**: a company-portability bundle (`agentcompanies/v1`, the same code path the teams catalog uses) plus native pipeline and routine bodies, so no workflow schema is invented. Packs are **declarative only**: no executable code. The layout and the `pack.json` v1 fields are in [section F](../features/paperclip/minimum-sellable-product.md#f-minimum-pack-format-v1) of the minimum sellable product.
2. **Releases** are directories in the private repo `netzer-packs`; a release is a protected tag `<pack>/vX.Y.Z` plus a tarball sha256, immutable. New repos `netzer-packs` and `netzer-deployments` get the release plan's ruleset shapes: `*/v*` tags are immutable, and branches need a PR with zero approvals (X10).
3. **One agent format everywhere** (`agents/*.yaml`): templates, manual, imported and pack agents share one schema. A pack creates **namespaced** agents (for example `bhr-intake`); config may map a role to an existing customer agent (`agentRef`), which must satisfy the role's tool allowlist. Skills live in Netzer agent config (`skills/*.md`).
4. **Pipeline key per pack version** with per-key routines and agent configs ([ADR 0012](0012-paperclip-owns-work-state.md)).
5. **Configuration and entitlement live in the deployment registry**: the private git repo `netzer-deployments` (PR-reviewed, no PHI, PII or secrets), one `customers/<id>.yaml` per customer. Config is projected into an installation record in the customer deployment, so every installation is recorded twice. `pack preflight|install|activate|upgrade` refuse unless the pack is listed. The seam is `checkEntitlement()`. *(Roadmap v2, decisions 24-25: from step 8 the in-account installer checks a signed license file offline through this seam; the registry stays git; a database or AWS Marketplace entitlement replaces the source behind the same seam only at self-purchase.)*
6. **Installs are a runbook plus scripts.** Every dangerous step is a script that is journaled and never hand-run (`pack validate`, `preflight`, `install`, `test`, `activate`, `status`, `effect resolve`). `pack install` is idempotent and a re-run resumes. `pack upgrade` and `pack rollback` land before the first pack update ships ([step 15](../features/paperclip/minimum-sellable-product.md#build-steps)).
7. **Signing lands before Customer #1, and it is the release signature.** *(Amended 2026-09-30, roadmap v2.)* Decision 24 (Jev 0.79; owner, 2026-09-29) merged pack signing and the signed license file into step 8 (trusted install); the plan had them in step 14, after Customer #1. Decision 29 (owner, 2026-09-30): packs ride inside the signed Netzer release the customer already installs, so the release signature covers them, with no separate pack key set, no download channel and no catalog feed. X3's separate pack trust-root set (a pack key must never verify a Netzer release; no second platform ceremony) is therefore not needed for Customer #1 (X13). Revisit trigger (decision 29): a second sellable pack, or a pack fix needed between releases, which switches to uploading a signed file.
8. **Customer installs verify the release, import its signed digests and never build** (X1). Preflight verifies the deployed release's signature (X2); this replaces the earlier plan to run `npm run setup` or `deploy` from a release tag.
9. **Later owner decisions that touch this ADR** (full text in the [decision log](../features/paperclip/decision-log.md)):
   - **decision 16:** Behavioral Health is a staging-only test pack; the owner's first real pack goes to Customer #1; authoring uses the same files and tools as staff, with no visual builder in v1 (superseded by decisions 20-21: the Workflow Studio, step 9).
   - **decision 17:** resale is forbidden and a lapsed customer keeps what they have (no remote kill switch, no call-home); the account-bound signed license file moved into step 8, before Customer #1 (decision 24); it gates new installs and upgrades only.
   - **decision 18:** Netzer staff never access customer data. In a customer's AWS account, staff use a limited login that installs, upgrades and removes packs and the platform and sees system health only; entering secrets, connecting the customer's systems (OAuth), UAT and restores are the customer admin's. How installs run without staff holding data keys is decided in step 8 with Jev.
   - **decision 19:** customers maintain their own system after hand-over; the hand-over block is step 15 (decision 24).
   - **decisions 20 and 22:** all customer UI ships before Customer #1, including the pack store, an in-app catalog where licensed packs self-install through the in-account installer and unlicensed packs show a request button (step 12); there is no in-app payment.
   - **decision 24 and decision 25:** pack signing and the signed license file are in step 8, before Customer #1. Customer records and licenses stay in the `netzer-deployments` git repo: staff mint signed license files from it, and the installer checks them offline through `checkEntitlement()`. A database replaces this only at self-purchase.
   - **decision 29:** see item 7. The store lists the packs in the installed release, and the admin uploads the license file to unlock them.
   - **decision 26 and X12:** roadmap v2 renumbers the steps; this ADR uses the v2 numbers.

**Decided by.** Jev: envelope over Paperclip bundles 1.0, key-per-version 1.0, declarative packs 0.91, config in the registry and installation record 0.98, entitlement via the registry 0.98, signing should-have-soon 0.85, namespaced agents with optional mapping 0.81, runbook plus scripts 1.0, agent templates to one format 0.88, skills in Netzer agent config 0.88, offline entitlements as the later target 1.0. Owner: YES on one agent format. VERIFIED: the teams catalog uses portability import. Decisions 20-29: [decision log](../features/paperclip/decision-log.md).

## Consequences

Good: one pack serves many customers by configuration, and the release, install and entitlement steps are repeatable and auditable.

Bad:

- Staff-run installs can vary (Med). Every dangerous step is scripted and journaled.
- Until signing lands (step 8), artifact integrity rests on protected tags, checksums and the fact that customers receive packs only through Netzer staff.
- Until upstream portability ships, the pipeline and routine bodies in a pack are interim serialized bodies.

- **Reversibility:** one-way. The pack format and the registry layout are the contract that installs and customer records depend on.
- **Revisit trigger:** step 8 (signing and the signed license file), step 17 (upstream pipeline portability replaces the interim bodies), a second sellable pack or a pack fix needed between releases (decision 29), or the reuse test finding customer-specific debt.

## Alternatives considered

- **An invented pack or workflow schema.** Rejected: reuse Paperclip and Netzer formats.
- **Executable code in packs.** Rejected: [DO NOT BUILD](../features/paperclip/do-not-build.md).
- **An online license server as a runtime dependency.** Rejected: a registry check, and a signed license file checked offline (step 8).
- **Cryptographic signing before Customer #1.** Rejected at first (Jev 0.85); reversed in roadmap v2 (decision 24): signing lands in step 8.
- **A separate skills store, or a second agent format.** Rejected: [DO NOT BUILD](../features/paperclip/do-not-build.md).
- **A public marketplace, in-app checkout and self-service uninstall.** Deferred until there is revenue (section E of the minimum sellable product). The in-app pack store with licensed self-install is step 12 (decision 22).
