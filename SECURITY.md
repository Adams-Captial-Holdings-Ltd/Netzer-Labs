# Security Policy

Netzar OS Enterprise runs entirely in your own AWS account, but it terminates
webhooks from the public internet (Slack, Telegram), holds AWS credentials in
CI, and brokers model calls — so security reports get priority handling.

> **Doing diligence on this repository?** The governance controls this project
> cannot enforce at its current GitHub plan tier are documented openly, with the
> compensating control and residual risk for each, in
> [docs/security-posture.md](./docs/security-posture.md). That page also carries
> the standing accepted risks, including why `npm audit fix --force` must never
> be run here.

## Reporting a vulnerability

**Do not open a public issue for a vulnerability.** Use one of the private
channels:

1. **GitHub private security advisory** (preferred): on this repository, go to
   *Security → Advisories → Report a vulnerability*. This opens a private
   thread with the maintainers and supports coordinated disclosure.
2. **Email**: <security contact — set at publish>. Include a description,
   reproduction steps, and the affected version (the `deployedVersion` block
   from `npx tsx scripts/support-bundle.ts` identifies your install precisely).

You can expect an acknowledgement within 72 hours. Please give us a reasonable
window to ship a fix before public disclosure; we will credit reporters in the
release notes unless you ask otherwise.

## Supported versions

The support window is **N-1** (see the deprecation and support-window policy,
plan item 49): the latest release plus the release immediately before it.

| Version            | Supported | What you get                                            |
| ------------------ | --------- | ------------------------------------------------------- |
| Latest (`N`)       | Yes       | Security fixes, bug fixes, canary-proven direct upgrade |
| Previous (`N-1`)   | Yes       | Security fixes; direct upgrade to `N` is canary-tested  |
| Older than `N-1`   | No        | No fixes. Upgrade as a chain of sequential N-1 hops (`npm run update -- <tag>` performs one hop per invocation; repeat it per stepping-stone tag — the runner names the next tag when a jump is too far) |

Security fixes land in a new release; they are not backported beyond `N-1`.
If you run an out-of-window version, the remediation for any advisory is
"upgrade along the chain".

## Sharing diagnostics privately (raw support bundles)

Public issue reports must use the **redacted** support bundle
(`npx tsx scripts/support-bundle.ts`), which hashes resource IDs, ARNs, account IDs, and
hostnames so a paste does not publish your AWS posture.

Sometimes redacted output is not enough to diagnose a problem. For those
cases there is a private escalation path:

1. Open the issue publicly with the **redacted** bundle so the problem is
   tracked.
2. A maintainer will ask for the raw bundle **only if needed** and will open a
   private channel for it — a GitHub security advisory thread, or the security
   email above.
3. Generate the raw bundle with `npx tsx scripts/support-bundle.ts --raw` and send it
   **only** through that private channel. The raw bundle contains real
   resource names, ARNs, your account ID, and your domain. Never attach it to
   a public issue, gist, or discussion.

Maintainers will never ask for secret values (tokens, keys, `.env` contents).
The support bundle never contains them by construction — if anyone asks you
to paste secrets, treat it as a phishing attempt and report it here.
