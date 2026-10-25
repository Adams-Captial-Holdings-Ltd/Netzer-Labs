# G1 code review — NZR-5 (pass 2, fresh critic)

- HEAD: 1dd1c8a49b46a506a564caa9a01bcedc17b79f30
- Diff: `origin/integration/netzar-studio...HEAD` excluding `docs/features/netzar-studio` (19 files, +759/-55)
- Tier: T3
- Verdict: **PASS** (no high/medium open)

## Evidence I ran
- `npx vitest run` on vectors.scope, scope-access, vector-tools.scope, jarvis, authz-matrix, route-manifest, legacy-role, audit-writer, vectors-answer-metering: **9 files, 217 tests, all green**.
- `npm run typecheck` and full `npm test`: **not run** (tool permission refused in this session). The gate still needs them on the exact HEAD.
- SPA Scenario 10 manual check: **not done** (no browser session). Code read only.

## Acceptance criteria coverage
| Scenario | Test | Status |
|---|---|---|
| 1 viewer refused on 3 reads, no I/O, no cost-cap read | F5-1/2/3 (`expectNoKnowledgeIo` incl. getDailyCostUsd, getEffectiveCostCap) | covered, green |
| 2 normalization + case (`DEFAULT`, `shared `) | F5-4 | covered |
| 3 unknown == private, byte-identical | F5-5 | covered |
| 4 operator DELETE / ingest / ingest-stream (JSON 403 before SSE); shared ingest 200 | F5-6, F5-10 | covered |
| 5 viewer default/shared/no-scope 200 | F5-7 | covered |
| 6 admin + env owner read/delete private, no denied row | F5-8 | covered |
| 7 agent runtime + reserved `chat_` | existing suite + F5-11 (search and ingest, `chat:abc` folded too) | covered |
| 8 Jarvis vectors | F5-12 | covered |
| 9 audit row shape, hash only, survives kill switch; 400 invalid_scope no audit | F5-9, F5-9b, audit-writer test | covered |
| 10 upload-url needs agents:write; SPA filter | F5-13; `Vectors.tsx` uses `hasCapability('knowledge:private:read')` | server covered; SPA manual check pending |
| 11 fail closed (caps lookup throws, audit rejects) | F5-14 | covered |

All 7 scope sites gated (6 HTTP + Jarvis). `/vectors/answer` checks scope before validation, kill switch and cost cap. `/ingest/stream` checks before `ReadableStream`. Capability check precedes `scopeAccess` on every route. Ingest still passes raw `body.scope` to `ingestDocument`, but it is the same value `scopeAccess` validated, and the store normalizes identically.

## Security
- No auth bypass found. `canReadScope` compares after `normalizeScope`, case-sensitive, deny by default, empty string denied.
- No scope name or query text in audit rows (hash only; test asserts `not.toContain('finance')`). No new log lines carrying scope names.
- `capabilitiesForPrincipal` failure → refuse (try/catch in handler, `.then(…, () => new Set())` in Jarvis).
- `normalizeScope` moved to `scope-access.ts` and re-exported from `store.ts`: same regex, callers unaffected.

## Findings

1. **low — viewer gains Bedrock spend via the legacy-gate relaxation.** `requiredRole()` now returns `viewer` for `POST /vectors/search|answer|upload-url` (`handler.ts:~469`). Before this diff a viewer was stopped at the legacy POST=operator rank, so viewers could **not** call `/vectors/answer` at all. Now they can spend Bedrock money on `default`/`shared`. Scenario 5 requires this, and the kill switch and daily cost cap still bound it. It is recorded in the architecture-security drift line. But the story's "current behaviour" premise (only `vectors:read` gates it) was wrong, so this is a privilege widening the owner should explicitly ack at the security-boundary review.
2. **low — legacy-role bridge refactor is outside the listed files.** `LEGACY_ROLE_TEMPLATES`/`holdsAll` moved from `handler.ts` into `permissions.ts` as `legacyRoleForCapabilities`, and `POST_BRIDGE_ADMIN_CAPS` excludes `knowledge:private:read` from the admin rung. It is justified: without it, saved custom full-admin profiles would be demoted and lose `/tokens*`. It has its own red→green tests (`legacy-role.test.ts`). It is still scope beyond §4 "Files to change"; mention it in the PR.
3. **low — `isReservedScope` is declared between import statements** in `src/lib/tools/vector-tools.ts:14-18`. It works (imports hoist) but it breaks file idiom; move it below the imports.
4. **info — Jarvis coerces `params.scope` with `String()`** for the check, while `runQuery` passes the raw value to `listDocuments`. A non-string (for example `['shared']`) passes the check and then throws inside `normalizeScope`, so there is no leak, but there is no test for the non-string Jarvis path and no 1–128 length bound like the HTTP helper has.
5. **info — gate evidence incomplete from this critic:** typecheck, full `npm test`, `web/` build, diagrams-drift, secret-scan and the SPA manual check (viewer/operator/admin) were not run here. They must be green on the exact HEAD before the story exit gate.
