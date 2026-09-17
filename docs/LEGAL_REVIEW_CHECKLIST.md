# Attorney review package

> **ATTORNEY REVIEW REQUIRED.** This package supplies technical facts and
> unanswered questions for technology counsel; it does not choose legal terms
> or represent that the software may be sold. Unknown legal entity, ownership,
> assignment, third-party, healthcare, and termination terms remain explicit
> so counsel can resolve them without relying on engineering assumptions.

## Product and distribution facts

- Product: customer-hosted enterprise AI/agent software and AWS Infrastructure
  as Code, including application source, deployment/update tooling, agents,
  release artifacts, and a patched Paperclip component.
- Intended distribution: PGN retains a private canonical repository and
  licenses approved releases for deployment into a customer's AWS account.
- Customer controls: AWS account, DNS/TLS, data stores, secrets, KMS keys,
  logs, backups, integration/model credentials, business data, production
  approval, and revocation of deployment trust.
- Intended PGN boundary: no PGN-hosted runtime proxy, database, analytics,
  license server, central logs, customer backups, or standing support access.
  Optional external processors are customer-selected.
- Current exception: the existing GitHub deployment role can retrieve/update
  Paperclip secrets and assume broad CDK deployment roles. Engineering has
  classified this as a P0 to remove before customer production.
- Entitlement v1: the signed commercial agreement, not an online license
  service. A future offline signed entitlement may be considered, but no
  call-home is planned or implemented.

## Ownership/provenance evidence

- Existing `PROVENANCE.md` records an imported source archive hash and Emmanuel
  Adams's authorship statement, including AI-assisted/shared-account work. It
  expressly is not an independent legal determination.
- The repository history contains multiple author names/email identities and
  automation. Counsel should not infer ownership from Git metadata.
- The existing rights notice was an interim individual/DBA statement. The new
  `LICENSE.md` remains a draft and deliberately does not decide which company,
  assignee, or individual is the licensor.
- Confirm original archive/history preservation, employee/contractor/advisor
  contributions, AI tool terms applicable at the time, third-party snippets,
  trademarks/branding, and all IP assignments.

## Third-party facts needing review

- npm trees are predominantly MIT/BSD/Apache/ISC/Unlicense. Proposed express
  choices: JSZip/Case under MIT and DOMPurify under Apache-2.0.
- `buffers@0.1.1` has no detected license metadata/text.
- PDFKit includes AFM/ICC assets with copyright/all-rights-reserved notices and
  no adjacent local redistribution grant found in the installed package.
- PDF.js includes OFL-1.1 fonts plus BSD/CC0 and other nested assets.
- The Alpine FFmpeg package is identified by Alpine as GPL-2.0-or-later and
  LGPL-2.1-or-later; exact release build/obligations are not inventoried.
- Patched/digest-pinned Paperclip source is MIT upstream; the shipped image,
  local modification notice, complete license texts, and image SBOM are absent.
- Node/Alpine/native packages, AWS X-Ray and optional Cloudflare sidecars need
  built-image review. See `THIRD_PARTY_NOTICES.md` and `sbom/README.md`.

## Customer data and healthcare facts

The software can process messages, files, business records, model prompts, and
potentially health information inside customer AWS. Customer-selected Bedrock,
Slack, Telegram, Salesforce, search, MCP, and email flows may transmit selected
content to those processors. The desired architecture avoids PGN creating,
receiving, maintaining, transmitting, storing, or accessing production data,
but deployment/support access, customer-directed diagnostics, security notices,
and metadata retention must be drafted consistently with that intent.

Counsel should determine whether PGN's deployment, support, update, and incident
roles make it a business associate, service provider, processor, or other
regulated party in any customer scenario despite the intended no-data-access
default. Engineering should not promise HIPAA compliance from architecture
alone.

## Questions for counsel

1. What commercial license/agreement structure should govern customer-hosted
   binaries, source access if any, IaC, agents, updates, support, and evaluation?
2. Is the provisional proprietary repository notice sufficient until a
   definitive signed agreement, and who is the correct legal licensor?
3. What evidence/terms are needed for AI-assisted authorship and repository
   chain of title?
4. Which employee, contractor, founder, advisor, or prior contributor IP
   assignments/confirmations are required?
5. Do the identified third-party licenses/assets permit the intended binary,
   source, installer, and patched-container distribution, and what notices or
   source offers are required?
6. What customer modification, derivative-work, backup, disaster-recovery,
   affiliate, contractor, and source-access rights should be granted?
7. On expiry/termination, may the deployment continue, in what degraded mode,
   and what happens to updates, backups, configuration, data, and retained
   infrastructure?
8. What warranties, disclaimers, indemnities, security commitments, incident
   notice, service levels, and limitation-of-liability terms are appropriate?
9. Should support, maintenance, security updates, professional services, and
   the software license be separate instruments/fees?
10. What healthcare/HIPAA, privacy, DPA, subprocessors, cross-region model,
    export-control, and customer-instruction terms follow from this architecture?

Do not answer these questions by editing this checklist; record counsel's
approved decisions in executed agreements and repository decisions.

## Deliverables requested from counsel

- Confirmed legal entity/licensor, copyright/trademark wording, and chain of
  title remediation list.
- Approved repository notice and customer license/order-form structure.
- Approved third-party disposition for every blocker and notice/source-offer
  template for release packages.
- Customer/PGN data responsibility, security/support access, DPA/HIPAA, and
  subprocessors language.
- Modification, support, update, audit, termination, survival, and
  post-termination deployment/data terms.
- Approval or edits to the technical statements in
  `CUSTOMER_HOSTED_ARCHITECTURE.md` and `CUSTOMER_DATA_BOUNDARY.md`.

## Engineering evidence counsel should receive

- This file, `LICENSE.md`, `PROVENANCE.md`, `THIRD_PARTY_NOTICES.md`.
- Commercialization readiness, architecture, data-boundary, AWS deployment,
  release, and supply-chain documents.
- Full Git author/contributor export plus original archive/hash evidence.
- Final built-image SBOMs/notices/scans and the exact release artifact manifest
  once P0 remediation is complete.
- Current IAM policies and a diff of the proposed data-blind deployment role.
