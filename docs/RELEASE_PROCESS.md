# Commercial release process

> Netzer has substantial signed-release and updater code, but no legitimate
> release exists today: there are no `v*` tags, GitHub Releases, populated trust
> roots, or published signed artifacts. The current deploy workflow builds
> moving branches and deploys SHA/`latest` image tags. Commercial customer
> deployment must begin only after the existing tooling is wired to the
> immutable process below and exercised end to end.

## Required lifecycle

```text
feature branch
  -> pull request
  -> CI + docs + security + license policy
  -> independent approval
  -> merge to protected development/promotion path
  -> release candidate tag
  -> reproducible multi-arch build
  -> image scan + SBOM + notices + provenance
  -> canary and upgrade test
  -> immutable vX.Y.Z tag and GitHub Release (no rebuild)
  -> customer/environment approval
  -> OIDC deployment of verified digest
  -> deployment record and post-deploy verification
```

Semantic versioning uses `vMAJOR.MINOR.PATCH`: incompatible contractual/runtime
changes increment MAJOR, backward-compatible features MINOR, and compatible
fixes PATCH. Counsel/business must decide whether license/support changes can
ship independently of software SemVer.

## Existing reusable machinery

- `scripts/release/build-release.mjs` assembles typed metadata, artifact
  manifest, signature, and promotion attestation.
- `scripts/lib/release/*` contains schemas, signing, promotion, retention,
  migration, rollback, and image-import contracts.
- `scripts/update/*` verifies before running target-version code and imports
  digests into private ECR.
- `docs/release-pipeline.md` describes release-candidate promotion and N-1
  retention.

These are unit-tested implementation assets, not evidence of an operating
release system. `TRUST_ROOTS` is empty and the first-release external key,
gallery, protected tags, release environment, and GitHub artifacts do not
exist.

## Release identity and artifact set

Every final release must bind and retain:

| Item | Required identity |
|---|---|
| Git tag/GitHub Release | immutable `vX.Y.Z` |
| Source | full commit SHA and clean tree |
| Main/Paperclip/sidecar images | per-platform OCI digests, never `latest` |
| SBOM | CycloneDX/SPDX for every final image and browser bundle; hash recorded |
| Notices | complete license texts/notices for the exact distributed artifact |
| Security results | dependency, SAST, secret-history, container and IaC scans |
| Provenance | SLSA-style build attestation identifying workflow/source/build inputs |
| Signature | offline/HSM or tightly protected release key; verified before deploy |
| Promotion evidence | release candidate commit/digests equal final; no rebuild |
| Deployment record | customer/account/region/approver/tag/commit/digest/result |

## Repository protections required first

- Protect `development`, `qa`, `staging`, and `production`; require PRs,
  independent CODEOWNER review, required checks, conversation resolution, and
  signed/verified commit policy as approved.
- Prohibit force-push and deletion. Delete transient branches after merge.
- Protect `rc/v*`, `v*`, and any deployment-authorization namespace from
  mutation/deletion; only the release automation may create final tags.
- Restrict GitHub Actions to approved actions and keep them SHA-pinned.
- Protect release and customer-production Environments with non-bypassable
  reviewers and customer-specific secrets/variables.

## First-release sequence

1. Counsel approves licensor, customer grant, notices, and distribution scope.
2. Close dependency/image provenance blockers and produce a clean built-image
   SBOM/notices bundle.
3. Enable repository/environment/tag protections and the security reporting
   path.
4. Perform the release-signing key ceremony; commit the public trust root and
   secure/backup the private key under dual control.
5. Implement a release workflow that builds once, records digests, scans,
   attests, signs, and publishes a release candidate.
6. Deploy the candidate to an isolated customer-shaped canary using customer
   DNS (not PGN Cloudflare), test fresh install/upgrade/rollback, and retain
   evidence.
7. Promote the exact candidate artifacts to `v1.0.0`; do not rebuild.
8. Test signature, retention, import into private ECR, and customer approval
   before using the customer deployment workflow.

## Prohibited release behavior

- Building or deploying from an arbitrary moving customer branch.
- Using `latest`, mutable tags, or digest-unverified registry copies.
- Rebuilding between approved candidate and final release.
- Using an empty trust root, unsigned metadata, unreviewed SBOM/license output,
  unresolved critical/high release findings, or a customer role with data read.
- Treating a successful CloudFormation update as application/data-boundary
  verification.
