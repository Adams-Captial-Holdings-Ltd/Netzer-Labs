---
feature: delete-chat
document_role: index
status: current
observed_at: 2026-08-17
as_of_commit: b201bd8f389ae6eb9d3533f199d956aad68f85c4
implemented_by:
  - src/adapters/dashboard/handler.ts
  - web/src/pages/Chat.tsx
  - src/lib/state/sessions-repo.ts
tested_by:
  - src/adapters/dashboard/sessions-delete.test.ts
---

# Delete Chat

## 1. Start Here

This describes the per-conversation delete on the dashboard **Chat** tab, as of
the commit in the frontmatter. Read [section 2](#2-what-delete-chat-does-today)
for behaviour, [section 6](#6-current-businessstate-rules) for the rules the code
actually enforces, and the [HANDOFF](HANDOFF.md) for where the work currently
sits. Source code is the ultimate authority: where this page and the
implementation disagree, the code wins and this page is wrong.

## 2. What Delete Chat does today

Each row in the Chat tab's conversation sidebar carries a delete control,
revealed on hover or keyboard focus. Activating it opens the repository's
standard destructive dialog, which requires typing `DELETE` before the red
confirm button unlocks. Confirming issues `DELETE /api/sessions`, which removes
the conversation's DynamoDB row — and with it every stored message — after
verifying that the authenticated principal owns that conversation.

The sidebar updates immediately (optimistically) and the row is restored if the
server refuses. Deleting the conversation currently on screen falls back to the
same empty state the "New chat" button produces.

What it is **not** yet:

- It is not a GDPR erasure. Memories distilled out of a conversation survive it;
  see [section 7](#7-known-runtime-risks-and-approved-next-work).
- It does not restrict what the sidebar *lists*. `GET /sessions` still returns
  every session on the agent, so a user can see conversations they cannot delete.
- There is no undo and no soft-delete tombstone. The row is gone.

## 3. Current status and current source commit

Source evidence, not deployment evidence. Verified against
`b201bd8f389ae6eb9d3533f199d956aad68f85c4` plus the working-tree change that
introduces the feature. Nothing has been deployed: `development` reaches no AWS
environment, per the
[branch-to-environment mapping](../../../development.md#branch-to-environment-mapping).

## 4. Source of truth

| Concern | Authority | Use it for |
|---|---|---|
| Route + authorization | [handler.ts](../../../src/adapters/dashboard/handler.ts) | The delete endpoint and its two gates |
| Persistence | [sessions-repo.ts](../../../src/lib/state/sessions-repo.ts) | Row shape, key schema, `deleteSession` |
| Capability tiers | [permissions.ts](../../../src/lib/auth/permissions.ts) | Which profile holds `agents:write` / `security:write` |
| UI | [Chat.tsx](../../../web/src/pages/Chat.tsx) | Sidebar control, dialog, optimistic state |
| Coverage | [sessions-delete.test.ts](../../../src/adapters/dashboard/sessions-delete.test.ts) | What authorization behaviour is actually pinned |
| Volatile state | [HANDOFF](HANDOFF.md) | Branch, command, and next-action state |

## 5. Implementation map

| Area | Verified location | Present behaviour |
|---|---|---|
| Delete endpoint | `src/adapters/dashboard/handler.ts` — `router.delete('/sessions')` | Capability gate, ownership check, delete, audit |
| Row removal | `src/lib/state/sessions-repo.ts` — `deleteSession` | One `DeleteCommand` on `PK=AGENT#<id>` / `SK=CHAT#<id>` |
| Caller identity | `src/adapters/dashboard/handler.ts` — `dashboardIdentity` | `dashboard:<sha256(bearer)>`, derived from the token |
| Owner stamp | `src/lib/state/sessions-repo.ts` — `appendTurns` enrichment | Writes `userId` on every dashboard turn |
| Sidebar control | `web/src/pages/Chat.tsx` — conversation `<li>` | Hover/focus-revealed `Trash2` button, sibling of the row button |
| Confirmation | `web/src/components/ConfirmDialog.tsx` | Type-`DELETE`-to-confirm, `danger` styling |
| Optimistic state | `web/src/pages/Chat.tsx` — `confirmDelete` | Remove, roll back on failure, refetch to reconcile |
| Active-chat reset | `web/src/pages/Chat.tsx` — `startNewChat` | Reused verbatim; also rewrites the `sessionStorage` pointer |

## 6. Current business/state rules

1. **A conversation and its messages are one row.** `turns` is an attribute array
   on the session item, not a child table, so a single `DeleteItem` removes both
   atomically. There is no cascade and there are no orphans to sweep.
2. **Ownership is decided server-side, from stored data.** The route compares the
   persisted `userId` against `dashboardIdentity(c)`, which is derived from the
   bearer token. Nothing the client sends participates in that decision.
3. **`agents:write` is required.** This matches every other per-tab delete in the
   product (scheduled tasks, vectors). Viewers do not hold it.
4. **`security:write` is an override.** Admin/owner-tier principals may delete any
   conversation on the agent, and the audit row records `viaAdminOverride: true`.
5. **A row with no `userId` has no owner**, so only the override reaches it. This
   covers rows written before the dashboard stamped identity, and rows created by
   Telegram or Slack.
6. **Not-yours and does-not-exist are the same 404**, byte for byte, so the route
   cannot be used to discover other users' chat ids.
7. **Only `dashboard:` conversations are listed** in the sidebar, so only they are
   reachable through the UI. The endpoint itself is not prefix-restricted.
8. **One confirmed delete sends exactly one request.** The guard is a `useRef`
   set synchronously, not `useState`: state does not apply until the next
   render, so a state-only guard lets a fast double-click fire several DELETEs.
   Verified by firing five clicks in a single tick.

## 7. Known runtime risks and approved next work

| Risk | Evidence | Approved next work |
|---|---|---|
| Distilled memories outlive the conversation they came from | `ingestEvictedTurns` writes to `claudeclaw-memories`, which this route does not touch | None approved. `DELETE /export` remains the full-purge path |
| The sidebar lists conversations the viewer cannot delete | `GET /sessions` filters by agent, not by owner | None approved; narrowing the list is a separate change |
| Legacy rows without `userId` need an admin to remove | Rule 5 above | None approved; expected to age out |
| Optimistic removal briefly disagrees with the database | `confirmDelete` restores and refetches on failure | Covered by the rollback path; no further work approved |

## 8. Exact focused and full validation commands

Focused:

```bash
npx vitest run src/adapters/dashboard/sessions-delete.test.ts
```

Full pre-push suite, per
[development.md](../../../development.md#automated-tests):

```bash
npm run typecheck
npm test
npm run build
npm --prefix web run typecheck
npm --prefix web run build
npm run local:test:integration
node scripts/ci/docs-links.mjs
node scripts/ci/feature-knowledge.mjs
git diff --check
```

## 9. Related documents

- [Operational HANDOFF](HANDOFF.md)
- [Feature knowledge framework](../README.md)
- [Documentation index](../../README.md)
- [Repository development guidance](../../../development.md)
