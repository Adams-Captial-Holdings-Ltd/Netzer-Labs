# NZR-5 UAT transcript (G3)

- Date: 2026-10-24. Walker: fresh UAT agent (not the builder). Branch `feature/nzr-5-fix-vectors-scope-leak-knowledge-routes` @ `1dd1c8a`.
- App: `http://127.0.0.1:3900`, fake local stack (Floci), no real AWS, no model calls.
- Token: owner (env root) via `E2E_TOKEN`, masked as `***`. Script: `/root/.hermes/netzar-runner/runs/NZR-5/uat-live.mjs`, raw output `uat-live.json` in the same dir.
- **Limit:** the local app only has the owner principal. Viewer and operator scenarios (1–5, 8, 9 refusal, 10 viewer/operator, 11) cannot be driven live; they were run through the story's named unit tests (below). Owner-side and role-independent checks were run live.

## Live requests (owner token)

| # | Scn | Request | Status | Body |
|---|---|---|---|---|
| 1 | 5/6 | `GET /api/vectors` (no scope) | 200 | `{"scope":"default","count":0,"docs":[]}` |
| 2 | 5/6 | `GET /api/vectors?scope=default` | 200 | `{"scope":"default","count":0,"docs":[]}` |
| 3 | 5/6 | `GET /api/vectors?scope=shared` | 200 | `{"scope":"shared","count":0,"docs":[]}` |
| 4 | 6 | `GET /api/vectors?scope=finance_private` | 200 | `{"scope":"finance_private","count":0,"docs":[]}` |
| 5 | 6 | `POST /api/vectors/search {"query":"q","scope":"finance_private"}` | 400 | `{"error":"search_failed","detail":"Titan returned no embedding"}` |
| 6 | 6 | `POST /api/vectors/answer {"query":"q","scope":"finance_private","modelId":"anthropic.claude-sonnet"}` | 400 | `{"error":"unknown_model"}` |
| 7 | 6 | `DELETE /api/vectors/finance_private/doc1` | 200 | `{"ok":true,"scope":"finance_private","docId":"doc1"}` |
| 8 | 4 | `POST /api/ingest {"content":"x","scope":"shared"}` | 400 | `{"error":"ingest_failed","detail":"embedding failed for all 1 chunks; nothing indexed (Bedrock embed unavailable?)"}` |
| 9 | 9 | `POST /api/vectors/search {"query":"q","scope":""}` | 400 | `{"error":"invalid_scope"}` |
| 10 | 9 | `POST /api/vectors/search {"query":"q","scope":123}` | 400 | `{"error":"invalid_scope"}` |
| 11 | 9 | `POST /api/vectors/search {"query":"q","scope":"aaaa…(200 chars)"}` | 400 | `{"error":"invalid_scope"}` |
| 12 | 10 | `POST /api/vectors/upload-url {"filename":"a.txt","contentType":"text/plain"}` | 200 | `{"url":"http://127.0.0.1:4566/claudeclaw-vectors-staging/uploads/<uuid>/a.txt?X-Amz-…(presigned, masked)"}` |
| 13 | auth | `GET /api/vectors?scope=finance_private` (no Authorization header) | 401 | `{"error":"unauthorized"}` |

What the live rows show:
- Rows 4–7: the owner is **not** refused `finance_private` on any route (no `forbidden_scope`). Rows 5, 6 and 8 fail *after* the scope gate because the fake stack has no embedding model and no catalog model (expected, since there are no model calls). F5-8 and F5-10 below prove the admin 200 bodies for search, answer and ingest.
- Rows 9–11: malformed scopes return `400 invalid_scope` before any store call (the role-independent part of Scenario 9).
- Row 12: a holder of `agents:write` still gets a staging URL (owner side of Scenario 10).

## Unit-test runs (roles the local app cannot provide)

Command (one run):
`npx vitest run src/adapters/dashboard/vectors.scope.test.ts src/lib/tools/vector-tools.scope.test.ts src/adapters/dashboard/jarvis.test.ts src/lib/audit/audit-writer.test.ts src/lib/vectors/scope-access.test.ts --reporter=verbose`
Result: `Test Files 5 passed (5)`, `Tests 62 passed (62)`.

```
✓ vectors.scope.test.ts > F5-1 GET /vectors refuses a viewer another agent's private scope
✓ vectors.scope.test.ts > F5-2 POST /vectors/search refuses a viewer another agent's private scope
✓ vectors.scope.test.ts > F5-3 POST /vectors/answer refuses a viewer another agent's private scope before any spend
✓ vectors.scope.test.ts > F5-4 refuses a scope that reaches a private corpus only after normalization
✓ vectors.scope.test.ts > F5-5 answers an unknown scope exactly like a private one
✓ vectors.scope.test.ts > F5-6 DELETE /vectors/:scope/:docId refuses an operator a scope they cannot read
✓ vectors.scope.test.ts > F5-7 still lets a viewer read the default and shared corpora
✓ vectors.scope.test.ts > F5-8 lets a principal with knowledge:private:read read a private scope
✓ vectors.scope.test.ts > F5-9 audits each refusal as knowledge_scope_denied with a scope hash only
✓ vectors.scope.test.ts > F5-9b rejects an empty, non-string or over-long scope with 400
✓ vectors.scope.test.ts > F5-10 /ingest and /ingest/stream refuse an operator a scope they cannot read
✓ vectors.scope.test.ts > F5-13 POST /vectors/upload-url needs agents:write
✓ vectors.scope.test.ts > F5-14 a failing capability lookup or audit write fails closed
✓ audit-writer.test.ts > knowledge_scope_denied survives audit_log_disabled
✓ vector-tools.scope.test.ts > F5-11 refuses an agent knowledgeScope in the reserved chat_ namespace
✓ jarvis.test.ts > F5-12 the vectors resource refuses a scope the principal cannot read
```

## Scenario results

| Scn | Title | Result | Evidence |
|---|---|---|---|
| 1 | Viewer refused private scope on every read route | PASS | F5-1, F5-2, F5-3 (unit; no viewer locally) |
| 2 | Normalization cannot bypass the check | PASS | F5-4 (unit) |
| 3 | Unknown scope looks like a private one | PASS | F5-5 (unit) |
| 4 | Operator cannot delete/ingest into unreadable scope | PASS | F5-6, F5-10 (unit); live row 8 shows `shared` ingest passes the gate (fails later at embedding, fake stack) |
| 5 | Viewer still reads public corpora | PASS | F5-7 (unit); live rows 1–3 (owner) show unchanged bodies and no-scope → `default` |
| 6 | Admin/owner reads a private scope | PASS | F5-8 (unit); live rows 4–7 (owner, env root token) |
| 7 | Agent runtime reads own scope only; `chat_` refused | PASS | `vector-tools.scope.test.ts` incl. F5-11 (unit) |
| 8 | Jarvis query path held to same rule | PASS | F5-12 (unit) |
| 9 | Refusal audited by hash; malformed input 400 | PASS | F5-9, F5-9b, "knowledge_scope_denied survives audit_log_disabled" (unit); live rows 9–11 |
| 10 | Upload URL needs write; SPA hides agent scopes | PENDING-OWNER | Server half PASS: F5-13 (unit) + live row 12. **SPA half not run**: the local app on :3900 serves the legacy dashboard (`#login` page, `web/dist` not built), and building the Vite SPA needed an approval this run did not have. The selector filter (`web/src/pages/Vectors.tsx:214`) still needs the manual viewer/operator/admin browser check. Not marked PASS because it was not run. |
| 11 | Degraded mode fails closed | PASS | F5-14 (unit) |
