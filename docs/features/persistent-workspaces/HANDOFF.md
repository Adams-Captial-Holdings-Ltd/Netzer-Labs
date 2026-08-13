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

## Commands actually run, after M0

| Command | Result |
|---|---|
| `npm ci --ignore-scripts` | exit 0 |
| `npm ci --prefix web --ignore-scripts` | exit 0 |
| `npm run typecheck` | **clean** |
| `npm test` | **5 failed / 177 passed / 1 skipped files; 1 failed / 1954 passed / 6 skipped tests** — the same five pre-existing failures as the baseline, plus 12 new passing tests |
| `npm run build` | **clean** |
| `npm --prefix web run typecheck` | **clean** |
| `npm --prefix web run build` | **built in 8.41s** |
| `node scripts/ci/docs-links.mjs` | **OK** — 470 internal links |
| `node scripts/ci/feature-knowledge.mjs` | **OK** |
| `node scripts/ci/runnable-blocks.mjs` | **OK** (extra, not in the required list) |
| `npm run local:verify` | **all 5 isolation checks passed** |
| `npm run local:provision` | 32 tables, 4 buckets created |
| `npm run local:test:integration` | **31/32 passed** — see below |
| `git diff --check` | clean |

### Integration suite — run, and matching the documented expectation

Docker was started, Floci `1.6.0` came up healthy on `127.0.0.1:4566`, and
`npm run local:verify` passed all five isolation checks
(`sts:GetCallerIdentity` returned `000000000000`, the emulator account).
`npm run local:provision` created 32 tables and 4 buckets.

```
Test Files  1 failed | 7 passed (8)
     Tests  1 failed | 31 passed (32)
```

The one failure is
`scripts/destroy.integration.test.ts > checkSecrets … schedule-deleted`,
`expected 'pass' to be 'warn'`. This is **the documented known emulator gap**,
not a regression: `development.md` records the expected result for this command
as *"31/32 passing, 1 known emulator gap"* and explains it under
[Known local limitations](../../../development.md#known-local-limitations) —
Floci's `ListSecrets` omits secrets scheduled for deletion, where real AWS and
LocalStack list them with a `DeletedDate`. The test is correct and was not
modified; only the deploy-time destroy sweep depends on that behaviour.

**All nine documented pre-push commands have now actually been run.** None were
skipped or substituted.

The emulator was left running. `npm run local:down` stops it.

## Environment note that contradicts an older belief

**Vitest runs correctly in a Windows linked worktree.** A previous session
recorded that it could not resolve `vitest.config.ts` there; that is not true
at this commit — the full 1949-test suite ran from
`.worktrees/persistent-workspaces`.

## M0 as landed

- `ToolMedia.kind` widened to `'image' | 'artifact'`.
- `generate_document` now returns the document on the media channel via the new
  pure `buildDocumentResult`, so the usable link no longer depends on the model
  reproducing a signed URL. The URL stays in `text` as a fallback — removing it
  would leave Telegram with no link at all.
- `documentFileName` derives a display name from the spec's own `title`. It is
  sanitized and length-capped because it reaches a download filename, and is
  deliberately **not** used to build the S3 key, which stays server-derived.
- Slack delivers documents natively — its `uploadFile` is format-agnostic, so
  only the filename needed to change. `deliverSlackImages` renamed
  `deliverSlackMedia`.
- Telegram **skips** non-image media, with the reason stated at the call site
  per the parity rule in [CLAUDE.md](../../../CLAUDE.md): `sendPhoto` hardcodes
  `image.png` and no `sendDocument` helper exists. Documents reach Telegram via
  the text URL only.
- Dashboard emits a distinct `artifact` SSE event; the Chat tab renders a
  download card.

## Smallest next action

M0 is complete and every documented gate has been run. Push
`feature/persistent-workspaces` and open a PR into `development`.

Then M1: omit `ttl` for `surface === 'dashboard'` in `sessions-repo.ts` and add
the conversation sidebar to the Chat tab.

Authorities: [README](README.md), [ADR 0002](../../adr/0002-single-tenant.md),
[ADR 0009](../../adr/0009-mission-container-model.md).
