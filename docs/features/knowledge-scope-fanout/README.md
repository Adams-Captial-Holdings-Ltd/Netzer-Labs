---
feature: knowledge-scope-fanout
document_role: index
status: current
observed_at: 2026-08-25
as_of_commit: 0072dde
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

Every agent reaches all three knowledge corpora on every query — its own scope,
the platform `default` corpus, and `shared` — merged and ranked together, so no
setting has to be toggled to reach different knowledge.

That is now true and proven by real retrieval, not only by unit test. Read the
volatile [HANDOFF](HANDOFF.md) for where the work sits; source code is the
ultimate truth for present behaviour. This index describes the verified snapshot
at `0072dde` on the unmerged branch
`fix/knowledge-scope-fanout`.

## 2. What It Does Today

`s3_vectors_search` builds one de-duped list of the corpora the calling agent may
read — its own scope, `default`, and `shared` — queries each in parallel, and
merges the hits by `chunkId`, keeping the higher score and re-sorting globally
before slicing to `topK`. Each returned passage is cited with the scope it came
from. When an agent's own scope *is* `default` or `shared` the list collapses, so
no corpus is ever scanned twice.

That same list is also the read allowlist. A model-supplied `scope` argument may
only name a corpus already on it, and doing so narrows the search to just that
corpus. Because the fan-out and the allowlist are one expression rather than two,
a corpus cannot be searched without being nameable, nor named without being
searched.

An agent's own scope resolves whether or not it has a `CLAUDE.md` object in S3.
Previously `knowledgeScope` was read from `agents/<id>/agent.yaml` only after a
successful `CLAUDE.md` fetch, so an agent without that object silently fell back
to `default`.

The result reports what each corpus **offered** and what **survived** the merge —
`research-corpus 0/4, default 5/5, shared 0/2`. Two numbers rather than one,
because `0/4` (had matches, lost the blended ranking) and `0/0` (empty or
misresolved corpus) are different facts. Contribution is counted by `chunkId`,
never by comparing scope strings, since the scope list holds raw `agent.yaml`
values while `metadata.scope` holds the `normalizeScope`-folded form.

Writes are **not** widened. `ingest_document` still lands only in the agent's own
scope, resolved server-side.

## 3. Current Status And Source Commit

Claims are verified at `0072dde` by two kinds of
evidence. Source evidence: the tests in section 8, including mutation checks run
by a reviewer other than the author. Behavioural evidence: a real end-to-end
retrieval against staging infrastructure — one fixture agent, one question, three
documents ingested one per corpus — returning all three in a single search, each
cited by its own scope.

No **deployment** evidence is claimed and none exists. The change sits on an
unmerged `fix/*` branch, which per the
[branch mapping](../../../development.md#branch-to-environment-mapping) deploys
nowhere. Staging resources were used for verification only; the fixture was
removed afterwards.

The scope-resolution defect is present in `origin/production` as **code**, but no
production agent is affected by it: all seven have a `CLAUDE.md`, and the defect
only bites an agent that has an `agent.yaml` without one. Production's
`index/default/` is also empty, so the fan-out returns nothing new there today.
Both measured 2026-08-26; see [HANDOFF](HANDOFF.md).

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
| Scope resolution | `src/lib/config/agent-loader.ts` | Reads `agent.yaml` on both the S3 and the builtin-fallback path; normalises to `default` only when nothing is configured. Cached 5 minutes |
| Search fan-out | `src/lib/tools/vector-tools.ts` | One de-duped list of own scope, `default`, and `shared`; queried in parallel and merged |
| Read allowlist | `src/lib/tools/vector-tools.ts` | The same list. A named scope must be on it, and narrows the search to it |
| Ingest containment | `src/lib/tools/vector-tools.ts` | Writes locked to the agent's own scope regardless of the argument |
| Storage partition | `src/lib/vectors/store.ts` | Scope folds to an S3 prefix via `indexPrefixFor`; read and write paths share it |

## 6. Business And State Rules

- A search reaches the agent's own scope, `default`, and `shared`, and nothing
  else. No corpus is scanned twice when those overlap.
- An agent's configured `knowledgeScope` is honoured whether or not it has a
  `CLAUDE.md` object; only an agent with nothing configured gets `default`.
- The `scope` argument is model-supplied and therefore attacker-controlled under
  prompt injection. It may only name a corpus the agent already reads, and
  naming one narrows the search to it.
- Writes via `ingest_document` always land in the agent's own scope. `default`
  and `shared` are readable but not writable through the tool, because a write
  into a fleet-wide corpus would poison retrieval for every agent.
- Each returned passage carries the scope it came from, and the result reports
  kept/found per corpus, so a corpus that returned nothing is distinguishable
  from one that returned something and lost the blended ranking.
- The read and write S3 prefixes for a scope derive from one helper, so a scope
  cannot be written to one prefix and read from another.

## 7. Known Risks And Approved Next Work

| Risk | Evidence | Status |
|---|---|---|
| Top-K is shared across three corpora, so an agent's own passages can be evicted by higher-scoring `default` ones | `vector-tools.ts` queries each scope with the same `topK` and slices the merged set back to `topK`. Default `topK` is 5 | **Observable, not eliminated.** The ranking is deliberately unchanged — one blended relevance order is the point, and reserving slots per corpus would return a less relevant passage over a more relevant one. `9bfbd97` makes eviction visible in the tool output and in a structured log line, so its real rate can be measured rather than guessed. Raise `topK`, or add a per-scope floor, only once that number says it is needed |
| Everything in `default` is now readable by every agent, including agents with a private scope | The fan-out list | **Accepted and intended.** Both write paths fall back to `default`, so documents ingested during the loader-bug window would land there and become fleet-readable on deploy. Measured 2026-08-26: production `index/default/` is empty, so nothing is exposed. **Re-check before any future promotion** — it is cheap and it is the only irreversible risk here |
| A transient config-load failure pins an agent to `default` for the cache TTL | `agent-loader.ts` caches negative results unconditionally | **Open, deferred** — distinct defect, self-healing |
| `resolveChatIngestScope` silently redirects a chat-dropped document to `default` | `src/lib/media/chat-kb-ingest.ts` bare `catch` | **Open, deferred** — consumer of `loadAgent`, inherits the fix, and less harmful now that `default` is universally readable |
| The `default` corpus was unreachable from any agent with its own scope | Former two-scope fan-out | **Closed** in `c3d27bb`, pinned by the table-driven guard |
| An agent's configured scope was silently discarded without a `CLAUDE.md` | Former single call site of `fetchKnowledgeScope` | **Closed** in `476e25b`, pinned by `agent-loader.scope.test.ts` |

## 8. Validation Commands

Focused:

```bash
npx vitest run src/lib/config/agent-loader.scope.test.ts src/lib/tools/vector-tools.scope.test.ts src/lib/vectors/store.scope.test.ts
```

Full pre-push suite: the nine commands in
[`development.md`](../../../development.md), step 7 of *How to develop a new
feature, end to end*. A scoped run does not satisfy that gate. Note that
`npm test` exits 1 on this repository from a Windows machine for five
pre-existing reasons unrelated to this feature; the enumerated list is in the
[session handoff](handoffs/2026-08-25-three-corpus-retrieval.md), section 7.

The behavioural check is an end-to-end retrieval, which no unit test replaces.
The harness that performs it is described in [HANDOFF](HANDOFF.md); it is
**untracked**, which is itself an open question recorded there.

## 9. Related Documents

- [HANDOFF](HANDOFF.md) — current volatile state, the next action, and the session index
- [Knowledge durability](../knowledge-durability/README.md) — owns the storage prefix behaviour this work must not regress
- [Feature knowledge framework](../README.md) — how these documents are governed
- [`development.md`](../../../development.md) — process, validation list, branch mapping
- [CONTRIBUTING.md](../../../CONTRIBUTING.md) — PR and commit conventions
