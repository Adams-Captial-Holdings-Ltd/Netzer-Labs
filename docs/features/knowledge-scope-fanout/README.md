---
feature: knowledge-scope-fanout
document_role: index
status: current
observed_at: 2026-08-25
as_of_commit: 06ebe1caf91c4053b0bce6a8fc3c2c82fb9d2710
implemented_by:
  - src/lib/config/agent-loader.ts
  - src/lib/tools/vector-tools.ts
  - src/lib/vectors/store.ts
tested_by:
  - src/lib/tools/vector-tools.scope.test.ts
  - src/lib/vectors/store.scope.test.ts
---

# Knowledge scope fan-out

## 1. Start Here

This index describes the verified snapshot at
`06ebe1caf91c4053b0bce6a8fc3c2c82fb9d2710`, which is the state **before** this
feature's work. Source code is the ultimate truth for present behavior. Read the
volatile [HANDOFF](HANDOFF.md) for where the work currently sits, and the
[feature knowledge framework](../README.md) for how these documents are governed.

The goal of this feature is that every agent reaches all three knowledge corpora
on every query — its own scope, the platform `default` corpus, and `shared` —
merged and ranked together, so no setting has to be toggled to reach different
knowledge.

## 2. What It Does Today

Today an agent searches **two** corpora, and frequently the wrong two.

`s3_vectors_search` resolves the calling agent's scope server-side and fans out
to `[ownScope, 'shared']`, querying each in parallel and merging the hits by
`chunkId`, keeping the higher score and re-sorting globally
(`src/lib/tools/vector-tools.ts`). The `default` corpus is a real, first-class
S3 prefix alongside the others, but no agent with its own scope ever reads it.

It is **not** true that an agent reliably searches its own corpus. An agent's
`knowledgeScope` lives in `agents/<id>/agent.yaml` in the config bucket, but
`agent-loader.ts` reads that file only *after* it has successfully fetched
`agents/<id>/CLAUDE.md`. When `CLAUDE.md` is missing the loader returns early,
falls back to a built-in agent that declares no scope, and normalizes the result
to `default`. Nothing errors and nothing logs. The dashboard compounds the
illusion: `PATCH /agents/:id` writes the scope to both DynamoDB and `agent.yaml`,
and the detail endpoint echoes it back from the DynamoDB row, so the UI reports
success while retrieval keeps reading the wrong corpora.

## 3. Current Status And Source Commit

Claims above are **source evidence** at
`06ebe1caf91c4053b0bce6a8fc3c2c82fb9d2710`, read from the implementation, not
from a running environment. No deployment evidence is claimed. The
branch-to-environment mapping in
[`development.md`](../../../development.md#branch-to-environment-mapping)
confirms `development` deploys nothing.

## 4. Source Of Truth Table

| Concern | Authority | Use it for |
|---|---|---|
| Agent scope resolution | [`src/lib/config/agent-loader.ts`](../../../src/lib/config/agent-loader.ts) | Which corpus an agent is deemed to own |
| Search fan-out and read allowlist | [`src/lib/tools/vector-tools.ts`](../../../src/lib/tools/vector-tools.ts) | Which corpora a query reaches |
| Scope-to-storage mapping | [`src/lib/vectors/store.ts`](../../../src/lib/vectors/store.ts) | How a scope name becomes an S3 prefix |
| Branch and environment reality | [`development.md`](../../../development.md#branch-to-environment-mapping) | Where work is and is not running |

## 5. Implementation Map

| Area | Verified file | Present behavior |
|---|---|---|
| Scope resolution | `src/lib/config/agent-loader.ts` | Reads `agent.yaml` only after `CLAUDE.md` succeeds; otherwise falls back to `default`, cached 5 minutes |
| Search fan-out | `src/lib/tools/vector-tools.ts` | Queries `[ownScope, 'shared']`; rejects any other scope argument |
| Ingest containment | `src/lib/tools/vector-tools.ts` | Writes are locked to the agent's own scope |
| Storage partition | `src/lib/vectors/store.ts` | Scope folds to an S3 prefix via `indexPrefixFor`; read and write paths share it |

## 6. Business And State Rules

Rules the code enforces today:

- A search reaches the agent's own scope and `shared`, and nothing else.
- The `scope` argument is model-supplied and therefore attacker-controlled under
  prompt injection. It may only name a corpus the agent already reads; anything
  else is refused.
- Writes via `ingest_document` always land in the agent's own scope regardless of
  the argument, because a write into `shared` would poison retrieval fleet-wide.
- An agent with no `CLAUDE.md` object silently owns `default`, whatever its
  `agent.yaml` says.
- The read and write S3 prefixes for a scope are derived from one helper, so a
  scope containing unsafe characters cannot be written to one prefix and read
  from another.

## 7. Known Risks And Approved Next Work

| Risk | Evidence | Owner |
|---|---|---|
| An agent's configured scope is silently discarded when `CLAUDE.md` is absent | `src/lib/config/agent-loader.ts`, single call site of `fetchKnowledgeScope` | This feature |
| The `default` corpus is unreachable from any agent that has its own scope | `src/lib/tools/vector-tools.ts` fan-out array | This feature |
| A zero-hit result is indistinguishable from a corpus that was never searched | `src/lib/tools/vector-tools.ts` empty-result message asserts a cause | This feature |
| A transient config-load failure pins an agent to `default` for the cache TTL | `agent-loader.ts` caches negative results unconditionally | Not addressed here; see HANDOFF |

## 8. Validation Commands

Focused:

```bash
npx vitest run src/lib/tools/vector-tools.scope.test.ts src/lib/vectors/store.scope.test.ts
```

Full pre-push suite: the nine commands in
[`development.md`](../../../development.md), step 7 of *How to develop a new
feature, end to end*. A scoped run does not satisfy that gate.

## 9. Related Documents

- [HANDOFF](HANDOFF.md) — current volatile state and the session index
- [Feature knowledge framework](../README.md) — how these documents are governed
- [`development.md`](../../../development.md) — process, validation list, branch mapping
- [CONTRIBUTING.md](../../../CONTRIBUTING.md) — PR and commit conventions
