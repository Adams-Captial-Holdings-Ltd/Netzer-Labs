---
feature: release-pipeline-v1
document_role: handoff
status: current
observed_at: 2026-09-08
as_of_commit: 271339bc8b2feea85e6c31b115fdd34e757a72e2
---

# Release pipeline v1 — operational handoff

- **Branch:** `feature/release-pipeline-v1`, cut from `development` at
  `271339bc`. Not pushed, no PR opened.
- **Where the work happened:** a fresh sibling clone at `C:\dev\_netzer-release`.
  The primary checkout `C:\dev\Netzer-Labs` carries unrelated uncommitted work
  and was deliberately not touched.
- **Deployed:** nothing. No tag, no release, no deploy, no repository settings
  changed. Every consent gate in the parent plan is still closed:
  no key ceremony, no `RELEASE_SIGNING_KEY`, no rulesets, no tags.
- **`TRUST_ROOTS` is still empty**, so `npm run update` still refuses to run.
  That refusal is correct pre-release behaviour, not a regression.
- **`release.yml` has never executed.** It requires `RELEASE_SIGNING_KEY` and an
  image digest that only `deploy.yml` can produce; it fails closed without them.
- **Scope:** P1, P2 and P6 of the release plan. P3, P4 and P5 were skipped —
  they touch shared deploy infrastructure with other work open on it. Items
  discovered and not acted on are listed in section 7 of the
  [README](README.md).

Authorities: [README](README.md) for verified behaviour,
[ADR 0011](../../adr/0011-release-artifact-identity.md) for the decisions,
[the session handoffs](handoffs/2026-09-08-forgery-corpus-and-release-ci.md) for how it got here.
