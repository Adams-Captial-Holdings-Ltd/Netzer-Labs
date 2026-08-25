---
feature: knowledge-scope-fanout
document_role: index
status: current
observed_at: 2026-08-25
as_of_commit: 476e25bf6e8f8fcf255022e9fa726907035aa379
implemented_by:
  - src/lib/config/agent-loader.ts
  - src/lib/tools/vector-tools.ts
  - src/lib/vectors/store.ts
tested_by:
  - src/lib/config/agent-loader.scope.test.ts
  - src/lib/tools/vector-tools.scope.test.ts
  - src/lib/vectors/store.scope.test.ts
---

# Knowledge scope fan-out

## 1. Start Here

The goal of this feature is that every agent reaches all three knowledge corpora
on every query — its own scope, the platform `default` corpus, and `shared` —
merged and ranked together, so no setting has to be toggled to reach different
knowledge.

**That goal is half met.** The reason an agent's own scope never resolved is
fixed. The fan-out to all three corpora is not written yet. Read
[HANDOFF](HANDOFF.md) for the current state and the next action; source code is
the ultimate truth for present behaviour, and this index describes the verified
snapshot at `476e25bf6e8f8fcf255022e9fa726907035aa379` on the unmerged branch
`fix/knowledge-scope-fanout`.

## 2. What It Does Today

An agent searches **two** corpora: its own scope and `shared`.
`s3_vectors_search` resolves the calling agent's scope server-side, queries each
scope in parallel, and merges the hits by `chunkId`, keeping the higher score and
re-sorting globally. The `default` corpus is a real, first-class S3 prefix
alongside the others, but **no agent with its own scope reads it**. That is the
outstanding half of this feature.

As of `476e25b`, an agent's own scope now resolves correctly. Previously
`knowledgeScope` lived in `agents/<id>/agent.yaml` but was read only *after* a
successful fetch of `agents/<id>/CLAUDE.md`; an agent without that object fell
through to a built-in fallback declaring no scope and was normalised to
`default`, silently. `loadAgent` now performs that read on the fallback path as
well, so a configured scope is honoured whether or not a `CLAUDE.md` exists.

It is **not** true that this has been observed working against a real corpus. No
end-to-end retrieval has been run. Every claim in this document is source
evidence.

## 3. Current Status And Source Commit

Claims are **source evidence** at `476e25bf6e8f8fcf255022e9fa726907035aa379`,
read from the implementation and confirmed by the tests listed in section 8. No
deployment evidence is claimed and none exists: the change sits on an unmerged
`fix/*` branch, which per the
[branch mapping](../../../development.md#branch-to-environment-mapping) deploys
nowhere.

The same defect is present in `origin/production`, verified by reading that
branch's copy of `src/lib/config/agent-loader.ts`.

## 4. Source Of Truth Table

| Concern | Authority | Use it for |
|---|---|---|
| Agent scope resolution | [`src/lib/config/agent-loader.ts`](../../../src/lib/config/agent-loader.ts) | Which corpus an agent is deemed to own |
| Search fan-out and read allowlist | [`src/lib/tools/vector-tools.ts`](../../../src/lib/tools/vector-tools.ts) | Which corpora a query reaches |
| Scope-to-storage mapping | [`src/lib/vectors/store.ts`](../../../src/lib/vectors/store.ts) | How a scope name becomes an S3 prefix; owned by [knowledge-durability](../knowledge-durability/README.md) |
| Branch and environment reality | [`development.md`](../../../development.md#branch-to-environment-mapping) | Where work is and is not running |

## 5. Implementation Map

| Area | Verified file | Present behavior |
|---|---|---|
| Scope resolution | `src/lib/config/agent-loader.ts` | Reads `agent.yaml` on both the S3 and the builtin-fallback path; normalises to `default` only when nothing is configured. Result cached 5 minutes |
| Search fan-out | `src/lib/tools/vector-tools.ts` | Queries `[ownScope, 'shared']`. **Does not reach `default`** — outstanding |
| Read allowlist | `src/lib/tools/vector-tools.ts` | A model-supplied `scope` may name only the agent's own scope or `shared` |
| Ingest containment | `src/lib/tools/vector-tools.ts` | Writes are locked to the agent's own scope regardless of the argument |
| Storage partition | `src/lib/vectors/store.ts` | Scope folds to an S3 prefix via `indexPrefixFor`; read and write paths share it |

## 6. Business And State Rules

Rules the code enforces today:

- A search reaches the agent's own scope and `shared`, and nothing else.
- An agent's configured `knowledgeScope` is honoured whether or not it has a
  `CLAUDE.md` object; only an agent with nothing configured gets `default`.
- The `scope` argument is model-supplied and therefore attacker-controlled under
  prompt injection. It may only name a corpus the agent already reads.
- Writes via `ingest_document` always land in the agent's own scope, because a
  write into `shared` would poison retrieval fleet-wide.
- The read and write S3 prefixes for a scope derive from one helper, so a scope
  cannot be written to one prefix and read from another.

## 7. Known Risks And Approved Next Work

| Risk | Evidence | Status |
|---|---|---|
| The `default` corpus is unreachable from any agent that has its own scope | `src/lib/tools/vector-tools.ts` fan-out array | **Open** — the outstanding half of this feature |
| A zero-hit result is indistinguishable from a corpus that was never searched | `src/lib/tools/vector-tools.ts` empty-result message asserts a cause it cannot know | **Open** — mitigated by the fan-out guard once written |
| An agent's configured scope is silently discarded when `CLAUDE.md` is absent | `src/lib/config/agent-loader.ts`, single call site of `fetchKnowledgeScope` | **Addressed** in `476e25b`, pinned by `agent-loader.scope.test.ts` |
| A transient config-load failure pins an agent to `default` for the cache TTL | `agent-loader.ts` caches negative results unconditionally | **Open, deferred** — distinct defect, self-healing; see [HANDOFF](HANDOFF.md) |
| `resolveChatIngestScope` silently redirects a chat-dropped document to `default` | `src/lib/media/chat-kb-ingest.ts` bare `catch` | **Open, deferred** — consumer of `loadAgent`, inherits the fix |

## 8. Validation Commands

Focused:

```bash
npx vitest run src/lib/config/agent-loader.scope.test.ts src/lib/tools/vector-tools.scope.test.ts src/lib/vectors/store.scope.test.ts
```

Full pre-push suite: the nine commands in
[`development.md`](../../../development.md), step 7 of *How to develop a new
feature, end to end*. A scoped run does not satisfy that gate. Note that
`npm test` currently exits 1 on this repository from a Windows machine for five
pre-existing reasons unrelated to this feature; the enumerated list is in the
[session handoff](handoffs/2026-08-25-three-corpus-retrieval.md), section 7.

## 9. Related Documents

- [HANDOFF](HANDOFF.md) — current volatile state, the next action, and the session index
- [Knowledge durability](../knowledge-durability/README.md) — owns the storage prefix behaviour this work must not regress
- [Feature knowledge framework](../README.md) — how these documents are governed
- [`development.md`](../../../development.md) — process, validation list, branch mapping
- [CONTRIBUTING.md](../../../CONTRIBUTING.md) — PR and commit conventions
