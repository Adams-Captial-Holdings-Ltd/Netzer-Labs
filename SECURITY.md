# Security Policy

> Netzer OS handles customer-controlled infrastructure, credentials, messages,
> and model traffic, so suspected vulnerabilities require private handling.
> The repository does not currently have an externally usable private-reporting
> channel or a published commercial support window. Both are release blockers,
> not promises this draft tries to invent.

## Reporting a vulnerability

Do not open a public issue or attach secrets, raw support bundles, customer
data, account identifiers, or exploit details to a public channel.

**SECURITY CONTACT REQUIRED BEFORE EXTERNAL USE.** The business must create and
monitor a security mailbox, replace this marker with that address, and test the
complete receive/acknowledge/escalate path before a customer receives software.

GitHub private vulnerability reporting is currently disabled for this private
repository, so the repository's *Security → Advisories → Report a
vulnerability* link must not be represented as available. It may become the
preferred alternative only after the setting is enabled and tested.

When a private channel exists, a useful report contains:

- the affected Netzer release tag, commit, and image digest;
- a concise impact statement and reproducible steps;
- whether customer data, credentials, or account boundaries may be affected;
- logs or a redacted support bundle, never secret values.

No response-time SLA is committed by this draft. Counsel and the support owner
must approve any acknowledgement, remediation, disclosure, and customer-notice
commitments.

## Supported versions

There is no externally supported commercial release today. Repository version
`0.0.1`, moving branches, and untagged builds are development artifacts and are
not customer-supported versions.

Before `v1.0.0`, the business must publish the contractually approved support
window and test its upgrade path. The repository contains tooling designed for
an `N`/`N-1` window, but no tags, releases, signing trust root, or retained
release artifacts currently exist; therefore that tooling is not evidence of
an active support promise.

## Diagnostic handling

The default support bundle is redacted. A raw bundle can contain real AWS
resource names, ARNs, account identifiers, and hostnames. Generate or transmit
a raw bundle only through a customer-approved private channel, after the
recipient, retention period, and deletion procedure are agreed. Maintainers
must never request secret values, tokens, private keys, `.env` contents,
database exports, or unrestricted production access.

## Current control register

Repository-governance gaps and compensating controls are recorded in
[docs/security-posture.md](docs/security-posture.md). Customer deployment and
data-access constraints are recorded in
[docs/CUSTOMER_DATA_BOUNDARY.md](docs/CUSTOMER_DATA_BOUNDARY.md).
