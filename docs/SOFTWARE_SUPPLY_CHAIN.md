# Software supply-chain controls

> The repository has useful foundations: lockfiles, Dependabot, SHA-pinned
> Actions, read-only default workflow tokens, image scan-on-push, hermetic CDK
> synth, and signed-release libraries. It lacks enforcement and final-artifact
> evidence: no branch/ruleset protections, SAST, full-tree/history secret scan,
> container release gate, complete SBOM/notices, provenance attestation, or
> immutable release. This page separates current facts from the minimum
> commercial gate.

## Current material findings

| Area | Current state | Priority |
|---|---|---:|
| Repository rules | No rulesets/branch protection; promotion guard detects after push | P0 |
| Environment approvals | All four GitHub Environments have no protection rules and allow admin bypass | P0 |
| Release identity | No tags/releases/trust root; branch workflow builds SHA and `latest` with build provenance disabled | P0 |
| Secret scanning | GitHub secret/push protection disabled; CI scanner covers synth output/fixtures, not full source/history | P0 before external distribution |
| Dependency licensing | Unknown `buffers`; PDFKit data provenance; FFmpeg GPL/LGPL; incomplete image notices | P0 |
| Runtime vulnerabilities | After narrow updates: root 0 critical, 0 high, 2 moderate; web 0. The remaining `exceljs → uuid` path is documented/accepted because code does not pass `buf` and npm proposes a breaking downgrade | P1/accepted risk |
| Dev vulnerabilities | Current full audit still reports critical/high build/test advisories; they are not in runtime but must be triaged, patched normally, and isolated from production credentials | P1 |
| Container/base images | Node Alpine tag floats; Paperclip is digest-pinned; main build uses `npm install`; no final image SBOM/scan gate | P0/P1 |
| Actions | Inspected actions use full commit SHAs; repository allows all actions and does not enforce SHA pinning | P1 |
| Dependabot | npm root/web and Actions enabled weekly; many open alerts | P1 remediation cadence |
| Drift | Daily CDK drift workflow exists but its latest observed run failed | P1 operational |

## Changes completed on 2026-08-28

- Updated root lockfile to `@hono/node-server@1.19.17`, `hono@4.13.5`,
  `docx@9.7.1`, `nanoid@5.1.16`, `brace-expansion@1.1.18/2.1.4`, and
  `tmp@0.2.7`.
- Updated dashboard DOMPurify to `3.4.14`.
- `npm audit --omit=dev --json` now reports root 2 moderate/0 high/0 critical
  and dashboard 0 findings.
- Generated source-level CycloneDX npm SBOMs under `sbom/`.
- Disabled Paperclip's default telemetry in ECS and local harness definitions.

No `npm audit fix --force`, major framework upgrade, base-image mutation,
production deploy, or security-setting change was performed.

## Commercial release gates

1. **Source/review:** protected PR, independent owner review, all required CI,
   clean worktree, and full commit SHA.
2. **Secrets:** scan current tree and complete Git history with an approved
   detector; triage every hit; rotate exposed credentials; store a signed
   result. Do not print secrets into CI logs.
3. **Dependencies:** locked production and build dependency audit; license
   policy fails unknown/custom/copyleft expressions until approved; no known
   critical/high runtime vulnerability without written owner/time-bound risk
   acceptance.
4. **Static/IaC:** CodeQL or equivalent SAST, CDK/IaC policy scan, and reviewed
   synthesized diff. A scanner finding is evidence, not automatic compliance.
5. **Build:** hermetic, isolated, least-privilege runner; base images pinned by
   digest; `npm ci` or a documented reproducible alternative; no customer AWS
   credentials during untrusted PR builds.
6. **Artifact:** scan every per-platform final image by digest; produce
   CycloneDX/SPDX SBOM, final notices, malware/signature checks, and build
   provenance. Include Paperclip, X-Ray, Cloudflare if used, OS and native
   packages, and browser assets.
7. **Release:** sign manifest/metadata, attest builder/source, publish immutable
   candidate/final without rebuild, and verify retention.
8. **Deploy:** verify signature/digest/SBOM hash before OIDC assumption; customer
   approval; import exact digest to customer ECR; record outputs and probes.

## Severity policy target

| Finding | Default release decision |
|---|---|
| Known secret/private key/customer data exposure | Stop, contain, rotate, investigate history, document closure |
| Critical runtime/container exploit | Stop until patched/removed or exceptional written security/customer acceptance |
| High runtime/container exploit | Stop by default; narrowly documented exception must name reachability, controls, owner, deadline |
| Moderate/low | Triage reachability, track owner/deadline, disclose where contractually required |
| Unknown/custom/copyleft license | Stop distribution until provenance and obligations are approved |
| Dev-only vulnerability | Isolate build credentials; patch on cadence; stop if reachable in release runner or artifact |

## Base image and Docker remediation

Pin `node:20-alpine` by a reviewed multi-architecture digest and record the
resolved Alpine/Node versions. Determine whether FFmpeg functionality can use a
license-compatible build/package; otherwise satisfy its LGPL/GPL obligations
as counsel directs. Reconcile `npm install` versus lockfile reproducibility
rather than accepting the current comment indefinitely. Copy the final notices
into the runtime image and make the SBOM retrievable without running the
application.

## Continuous evidence

Release records and security evidence must contain only software/deployment
metadata, not customer content. Retain scanner versions, policy versions,
timestamps, inputs, outputs/hashes, approvals, and exceptions so a customer can
reproduce why a release passed. Re-run gates when an image digest or release
asset changes; a tag alone is not evidence.
