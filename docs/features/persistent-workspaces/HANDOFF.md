---
feature: persistent-workspaces
document_role: handoff
status: current
observed_at: 2026-08-13
as_of_commit: 8a66ba45ff1346642e144627eafb6985ad143fed
---

# Persistent agent workspaces handoff

- Branch: `feature/persistent-workspaces`; merge target: `development`.
- Worked in a linked worktree at `.worktrees/persistent-workspaces` so the
  in-flight `chore/netzar-os-enterprise-rename` tree and its uncommitted changes
  (`scripts/local/dev.mjs`, `.env.localdev.bak`) stay untouched.
- Pushed: no. PR: none. Deployment: none, and nothing here has been deployed.
- Phases/tasks: M0 (media-channel delivery for documents) in progress. M1
  (conversation persistence), M2 (durable artifacts), M3 (PPTX + editing) not
  started.
- Blockers: none blocking M0. **One product decision blocks M2**: whether
  artifacts are private to their creator or visible to everyone in the
  deployment, since `GET /api/sessions` currently scans and returns all
  sessions to any `sessions:read` holder.

## Baseline recorded before any change

`npm test` on `development` (`8a66ba4`) in this worktree, 2026-08-13:

```
Test Files  5 failed | 176 passed | 1 skipped (182)
     Tests  1 failed | 1942 passed | 6 skipped (1949)
```

All five failures are pre-existing and Windows-environment specific. **None are
in `src/`.**

| File | Failure |
|---|---|
| `scripts/ci/docs-links.test.ts` | collection — `SyntaxError` parsing the test file |
| `scripts/ci/feature-knowledge.test.ts` | collection — `SyntaxError: Invalid or unexpected token` at line 3 |
| `scripts/ci/runnable-blocks.test.ts` | collection — `SyntaxError` parsing the test file |
| `scripts/release/sync-deprecations.test.ts` | collection — `SyntaxError` parsing the test file |
| `scripts/lib/lifecycle/rollback-classes.test.ts` | 1 assertion — expects `/tmp/fake/cdk.out`, gets `\tmp\fake\cdk.out` (POSIX vs Windows separators) |

Verified these are not caused by this feature: the four collection failures are
parse errors in the test files themselves, and the fifth is a path-separator
assertion. The feature documents added here are not imported by any of them.

## Commands actually run

| Command | Result |
|---|---|
| `npm ci --ignore-scripts` | exit 0 |
| `npm test` | as recorded above (baseline) |
| `npx vitest run scripts/ci/feature-knowledge.test.ts` | 1 failed (collection), confirming the baseline failure is pre-existing |

**Not yet run:** `npm run typecheck`, `npm run build`,
`npm --prefix web run typecheck`, `npm --prefix web run build`,
`npm run local:test:integration`, `node scripts/ci/docs-links.mjs`,
`node scripts/ci/feature-knowledge.mjs`, `git diff --check`. All are required
before pushing.

## Environment note that contradicts an older belief

**Vitest runs correctly in a Windows linked worktree.** A previous session
recorded that it could not resolve `vitest.config.ts` there; that is not true
at this commit — the full 1949-test suite ran from
`.worktrees/persistent-workspaces`.

## Smallest next action

Apply M0: widen `ToolMedia.kind` to `'image' | 'artifact'`, have
`generate_document` return the artifact through the media channel instead of
only as a URL in the reply text, emit an `artifact` SSE event from the dashboard
stream, and skip non-image media on Telegram/Slack with an explicit comment at
the call site (no `sendDocument` helper exists on either surface).

Authorities: [README](README.md), [ADR 0002](../../adr/0002-single-tenant.md),
[ADR 0009](../../adr/0009-mission-container-model.md).
