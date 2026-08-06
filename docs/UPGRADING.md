# UPGRADING

> Plain English: this file is the human-readable record of what each
> release changes about the operator contract, the env vars, CLI flags,
> runtime-config keys, and file formats you actually touch. The
> machine-readable version of the same facts lives in
> [deprecations.json](deprecations.json), and the tooling trusts that
> file, not this prose. If this file and the JSON ever disagree, the JSON
> wins and the disagreement is a bug to fix.

## House rules

- Every release APPENDS a section here, newest first, even when the
  honest content is "no contract changes".
- The machine-readable metadata in [deprecations.json](deprecations.json)
  is AUTHORITATIVE; this prose is courtesy. `deprecations.json` is
  consumed by the release CI gates only — `scripts/release/contract-check.mjs`
  and `scripts/release/sync-deprecations.mjs` enforce the warn-then-remove
  contract from it — and nothing reads it at runtime. (The updater consumes
  the signed release metadata of item 44, not this file; the dashboard does
  not read it either.)
- Every removal or rename of a contract element MUST be named here, in
  the section of the release that removes it, with its replacement.
  `scripts/release/contract-check.mjs` fails the release otherwise.
- Warn-then-remove, never surprise-remove: anything removed ships at
  least one prior release as a working deprecation with a doctor/verify
  warning. The support-window policy lives in
  [release-pipeline.md](release-pipeline.md).
- New env vars ship with working defaults. The only exception is a
  security boundary that must fail closed, and that exception is flagged
  `security-boundary` in the element's `notes` in
  [deprecations.json](deprecations.json).

## 0.0.1 (baseline, pre-release)

The registry baseline. Everything in [deprecations.json](deprecations.json)
with `introduced: "0.0.1"` is the public surface as it existed before the
first public tag: the zod env schema keys in `src/config/env.ts`, the CLI
flags of `setup` / `deploy` / `rollback` / `teardown` / `status` /
`doctor` / `seed`, the seeded runtime-config keys, the flat `agent.yaml`
keys, and the updater-critical formats (deploy manifest, app schema,
journal, release metadata, artifact manifest, signature artifact,
promotion attestation, key-rotation metadata).

Nothing is deprecated and nothing is removed at this baseline. The
per-element introduction history before this point is not
reconstructible, and we do not invent it.
