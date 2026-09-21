---
feature: netzar-chat
document_role: handoff
status: current
observed_at: 2026-09-20
as_of_commit: eee0a83d7cfd98cc498bf0a509da345925c1183c
---

# Netzar Chat handoff

- Branch state: the work was merged into `development` by PR #129 (merge
  `b3b427497d63d8f4d1faa147b46c9681c19bc460`, 2026-08-27). It is present on
  `origin/qa` and `origin/staging`, and is not present on `origin/production`.
  Per the branch-to-environment mapping, staging is the only AWS environment
  reached; production remains untouched.
- Phases: CHATUI-000 through CHATUI-006 are built and blind-critic accepted.
  CHATUI-007 is superseded; CHATUI-008 owns the remaining authenticated staging
  verification and full-journey blind critic.
- This documentation refresh lives on `docs/wi-0.4-chat-docs`, cut from
  `development` at `eee0a83`; merge target `development`. Pushed: **no**.
  PR: none. Deployment: none — a `docs/*` branch reaches no AWS environment.
- Last checks actually run, all on this branch: the WI-0.4 claim proof went
  `FAILS=24` on the untouched baseline at `eee0a83` and `FAILS=0` after these
  documents and their session logs; `docs-links`, `feature-knowledge`,
  `docs-mermaid`, `docs-assets` and `git diff --check` all exit 0. The full
  `development.md` step 7 list was **not** run here and is not claimed: it is a
  pre-push gate, nothing is pushed yet, and no source, config, `package.json`,
  lockfile or `vitest.*` file is touched. It runs in full on the exact HEAD the
  landing phase pushes.
- Smallest next action: obtain owner decision 6 — mint a dedicated spend-capped
  staging token and authorize each staging-verification run — before starting
  CHATUI-008.

Session index (newest first):
- [2026-09-20-wi-0.4-implementation.md](handoffs/2026-09-20-wi-0.4-implementation.md)
- [2026-09-20-wi-0.4-specification.md](handoffs/2026-09-20-wi-0.4-specification.md)
- [2026-08-27-phases-1-6-and-harvest.md](handoffs/2026-08-27-phases-1-6-and-harvest.md)
- [2026-08-25-phase-0-extraction.md](handoffs/2026-08-25-phase-0-extraction.md)
- [2026-08-25-phase-0-scaffolding.md](handoffs/2026-08-25-phase-0-scaffolding.md)

Authorities: [README](README.md), [approved plan / phase backlog](plan.md).
