# NZR-6 UAT transcript (live requests)

App: http://127.0.0.1:3900 (local fake stack, Floci). Caller: owner token (admin), shown as `Bearer ***`. Run: 2026-10-25T18:46:35.555Z

SA = chatKnowledgeScope('ops','dashboard:chatA','dashboard:user:alice') = `chat_e0c2505e4cd782445bf390e3`

### S6 — owner lists own chat files by agentId+chatId (scope derived from caller identity)

```
GET /api/vectors?agentId=ops&chatId=dashboard:chatA
Authorization: Bearer ***

→ 200
{"scope":"chat_71555dd6f6764fd4becc17a9","count":0,"docs":[]}
```
Check: OK

### S6 — scope and agentId+chatId both given → invalid_scope

```
POST /api/vectors/search
Authorization: Bearer ***
{"scope":"ops_private","agentId":"ops","chatId":"dashboard:chatA","query":"x"}

→ 400
{"error":"invalid_scope"}
```
Check: OK

### S7 — admin GET raw chat scope (audited override)

```
GET /api/vectors?scope=chat_e0c2505e4cd782445bf390e3
Authorization: Bearer ***

→ 200
{"scope":"chat_e0c2505e4cd782445bf390e3","count":0,"docs":[]}
```
Check: OK

### S7 — audit log shows session_read_override row

```
GET /api/audit?limit=20
Authorization: Bearer ***

→ 200
{"days":1,"count":15,"rows":[{"PK":"DAY#2026-10-25","SK":"2026-10-25T18:46:35.670Z#1ade7a33-011c-4929-aa21-3828f96d08e5","GSI1PK":"AGENT#system","GSI1SK":"2026-10-25T18:46:35.670Z#1ade7a33-011c-4929-aa21-3828f96d08e5","id":"1ade7a33-011c-4929-aa21-3828f96d08e5","ts":"2026-10-25T18:46:35.670Z","action":"session_read_override","detail":{"scope":"knowledge","requestedBy":"dashboard:e437397bc937909f201c24ef70b5f84b81def35d99b0affd1c8919a2e829d626"},"result":"ok"},{"PK":"DAY#2026-10-25","SK":"2026-10-25T18:45:19.343Z#bf83f8ef-cf6d-4825-912d-abb20169c3d1","GSI1PK":"AGENT#system","GSI1SK":"2026-10-25T18:45:19.343Z#bf83f8ef-cf6d-4825-912d-abb20169c3d1","id":"bf83f8ef-cf6d-4825-912d-abb20169c3d1","ts":"2026-10-25T18:45:19.343Z","action":"token_revoked","surface":"dashboard","result":"ok","userId":"e437397bc937909f","operatorLabel":"Root token","detail":{"label":"nzr6-e2e-operator-1","role":"operator","hashPrefix":"50da1c0a61acee09"}},{"PK":"DAY#2026-10-25","SK":"2026-10-25T18:45:19.327Z#f4aec451-9da7-4ae5-874b-7917c95ae9cb","GSI1PK":"AGENT#system","GSI1SK":"2026-10-25T18:45:19.327Z#f4aec451-9da7-4ae5-874b-7917c95ae9cb","id":"f4aec451-9da7-4ae5-874b-7917c95ae9cb","ts":"2026-10-25T18:45:19.327Z","action":"token_revoked","surface":"dashboard","result":"ok","userId":"e437397bc937909f","operatorLabel":"Root token","detail":{"label":"nzr6-e2e-viewer-b","role":"viewer","hashPrefix":"befbb737b2c4c207"}},{"PK":"DAY#2026-10-25","SK":"2026-10-25T18:45:19.312Z#b54ab209-07d2-47c6-8a97-3ca18de253cd
```
Check: OK

### S8 — ingest/stream with alice's staged chat upload key

```
POST /api/ingest/stream
Authorization: Bearer ***
{"s3Key":"uploads/chat/9ed71e33b353c33d/abc123/a.pdf","scope":"ops_private"}

→ 200
data: {"stage":"error","detail":"invalid upload key"}


```
Check: OK

### S10 — admin lists quarantine

```
GET /api/knowledge/quarantine
Authorization: Bearer ***

→ 200
{"count":0,"docs":[]}
```
Check: OK

### S10 — admin reassign unknown doc → 404

```
POST /api/knowledge/quarantine/nope__deadbeef/reassign
Authorization: Bearer ***
{"agentId":"ops","chatId":"dashboard:chatA"}

→ 404
{"error":"not_found"}
```
Check: OK

### S10 — admin reassign with bad body → 400

```
POST /api/knowledge/quarantine/nope__deadbeef/reassign
Authorization: Bearer ***
{"agentId":"ops"}

→ 400
{"error":"invalid_body"}
```
Check: OK

## Unit-test evidence (roles/state the local app cannot provide)

The local app has one token (owner/admin). It has no viewer/operator/second-user sessions, no model calls (so no real chat turn runs `s3_vectors_search`), no Slack/Telegram, and no legacy chat-tagged docs (quarantine list is `count:0`). Running the quarantine script, even `--verify`, was not approved in this session, and `--apply` needs owner yes (Q50). These parts were checked through the story's named tests:

`npx vitest run src/lib/media/chat-kb-ingest.scope.test.ts src/lib/media/chat-kb-ingest.test.ts src/lib/tools/vector-tools.chat-scope.test.ts src/adapters/dashboard/vectors.scope.test.ts src/adapters/dashboard/knowledge-quarantine.test.ts scripts/nzr6-quarantine-chat-docs.test.ts` → Test Files 6 passed, Tests 54 passed.

| Scenario | Named tests (all ✓) |
|---|---|
| 1 | F6-1, F6-6, "says the file is available in this chat" |
| 2 | F6-2, F6-3 |
| 3 | F6-10 |
| 4 | F6-4 |
| 5 | F6-5, F6-7, F6-11 |
| 6 | F6-8, F6-12 (+ live owner GET above) |
| 7 | F6-13 (+ live admin override + audit row above) |
| 8 | F6-9 (+ live refusal above) |
| 9 | F6-14, "keeps a doc in place when its audit write fails" (script not run on local data: owner-gated) |
| 10 | "lists quarantined docs to admins only", "reassigns a doc into the chat owner's scope after an awaited audit", "refuses to reassign to a chat with no dashboard owner", "a failed audit leaves the doc in quarantine" (+ live admin list/404/400 above) |
