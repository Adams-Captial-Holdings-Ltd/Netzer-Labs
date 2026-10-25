# G1 code review — NZR-6, pass 3

- HEAD: a0e224e5a35f9ad69cf4437d7ce026d4d57049fb
- Diff: `git diff origin/integration/netzar-studio...HEAD -- . ':(exclude)docs/features/netzar-studio'` (26 files, +1579/-97)
- Story: US-006, tier T3
- Verdict: **PASS** (no open high or medium findings)

## Re-check of earlier findings

| # | Prior finding | Status |
|---|---|---|
| 1 | [medium] Jarvis `vectors` query gated only on `canReadScope`, so `chat_*` scopes were readable | **FIXED.** `jarvis.ts:1105` now refuses when `isChatScope(scope)`, before `canReadScope`, and audits `knowledge_scope_denied`. New test `jarvis.test.ts` "NZR-6 refuses raw chat_* scopes even to a knowledge:private:read holder" covers `chat_quarantine`, a `chat_<hex>` scope and `chat:x` (normalized). |
| 2 | [low] reassign splits qDocId with `indexOf('__')` | **OPEN.** `handler.ts` reassign still uses `indexOf('__')`, and the list route's `fromScope` fallback still uses `split('__')[0]`. `normalizeScope` maps `:` to `_`, so `agent::ops` becomes `agent__ops`. The doc then gets qDocId `agent__ops__<hash>`, which restores docId `ops__<hash>`. Docids are content-hash hex, so `lastIndexOf` is correct. Mitigation: the `from:` tag is read first in the list route. |
| 3 | [low] `dashboardIdentity` falls back to `'dashboard:unknown'`, which counts as an uploader | **OPEN.** `handler.ts:327` is unchanged. Unreachable behind auth today. |
| 4 | [info] reassign does not check the doc's `agent:` tag against `body.agentId` | Open, allowed by the contract. |
| 5 | [info] a reassign put/delete failure after the awaited audit gives an unhandled 500 | Partly addressed. The put is now an ETag CAS with 3 merge retries and returns 409 `reassign_conflict`. A throwing put or delete still gives a 500 after the audit row. Copy-first means no data loss. |
| 6 | [info] typecheck and full `npm test` not run by the reviewer | Still not run here. G2 must run `npm run typecheck`, the full `npm test`, diagrams-drift and secret-scan. |

## New findings this pass

- **[low] The `knowledge_delete` audit row leaks the source scope name for quarantined docs.** `DELETE /vectors/chat_quarantine/:qDocId` writes `detail: { scope, docId }` with the raw qDocId (`<fromScope>__<docId>`). The audit log is readable by viewers. The quarantine script deliberately hashes the scope because "qDocId embeds it". The delete row was raw before this change, but quarantine deletes are new traffic through it. Suggested fix: hash the scope and strip the prefix (or hash the docId) when `isChatScope(scope)`.
- **[info] Scope addition beyond the story text: `tokenUserId`.** The story says `s3_vectors_search` adds "exactly one extra scope". `tokenTurnIdentity` adds a second scope for a linked token: its own pre-link `dashboard:<tokenHash>` scope, same chat only. It is bound to the caller's own token hash and is tested (`vector-tools.chat-scope.test.ts:103`, `sessions-ownership.test.ts:381-392`), so it is not a leak. The dashboard `/vectors?agentId&chatId` route does not derive this second scope, so a linked token cannot list its pre-link files there; search still finds them. Mention this in the PR.

## Acceptance criteria coverage

| Scenario | Tests found | Code |
|---|---|---|
| 1 | F6-1, F6-6, "says the file is available in this chat" | `chat-kb-ingest.ts` scope, `owner:` tag and text; `vector-tools.ts` chat scope; `process.ts:612` ack text |
| 2 | F6-2, F6-3 | `resolveChatIngestScope` deleted |
| 3 | F6-10 | blocked/`no_uploader` audit, returns null |
| 4 | F6-4 | dedup checked inside the per-chat scope |
| 5 | F6-5, F6-7, F6-11 | only the caller's derived scope is added; raw `args.scope` is checked against the allowed set |
| 6 | F6-8, F6-12 | `scopeAccess` chat mode (`chat:read`, identity-derived); both `scope` and chat ids given → 400 |
| 7 | F6-13 | raw `chat_*` needs `knowledge:private:read` + `security:write` + an awaited override; audit failure → 500 |
| 8 | F6-9 | `uploads/chat/` refused on `/ingest/stream`; `/ingest*` refuse `chat_*` via `write:true` |
| 9 | F6-14, "keeps a doc in place when its audit write fails" | script copies, then audits (awaited), then deletes; exits non-zero on any failure |
| 10 | four `knowledge-quarantine.test.ts` cases | list, reassign (claim + CAS merge), 409 `no_dashboard_owner`, audit-failure path |

## Other checks

- **Security.** No new auth bypass found. The chat scope is always derived from `dashboardIdentity(c)`. Raw chat scopes are refused on writes and on Jarvis, and on reads need an admin with an awaited override. Ingest audit rows no longer carry `fileName`. The new audit actions are in `ALWAYS_AUDITED_ACTIONS`.
- **Callers.** All `scopeAccess` call sites were reviewed. `putDocument` now returns `Promise<boolean>`; existing callers that ignore the result still compile in a TS sense, but typecheck was not run.
- **Repo rules.** The `architecture-security.md` drift line is present. No new dependency or capability.
- **Not done by this reviewer:** typecheck, full `npm test`, diagrams-drift, secret-scan, and the local `--apply` / `--verify` evidence (DoD).
