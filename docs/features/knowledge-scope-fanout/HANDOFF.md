---
feature: knowledge-scope-fanout
document_role: handoff
status: current
observed_at: 2026-08-25
as_of_commit: 476e25bf6e8f8fcf255022e9fa726907035aa379
---

# Knowledge scope fan-out handoff

## Where this is

- **Branch:** `fix/knowledge-scope-fanout`, branched from `origin/development` at
  `06ebe1caf91c4053b0bce6a8fc3c2c82fb9d2710`. **Merge target:** `development`.
- **AWS environment this branch reaches:** none. Per the
  [branch mapping](../../../development.md#branch-to-environment-mapping),
  `fix/*` and `development` both deploy nothing.
- **Pushed:** no. **PR:** none. **Deployed:** no.
- **Commits on this branch:** one — `476e25b`
  `fix(knowledge): resolve an agent's own scope when it has no CLAUDE.md`.

**Half the work is done.** Read the next two sections before writing any code.

## What actually landed

`476e25b` fixes the scope-resolution bug only. `loadAgent` now reads
`agents/<id>/agent.yaml` on the builtin-fallback path, so an agent with no
`CLAUDE.md` object resolves its configured `knowledgeScope` instead of silently
becoming `default`. Six lines in `src/lib/config/agent-loader.ts` plus a guard
in `src/lib/config/agent-loader.scope.test.ts`.

Verified locally, all of it actually run:

| Check | Result |
|---|---|
| `npx vitest run src/lib/config/agent-loader.scope.test.ts` | pass, 4/4 |
| Mutation: revert the fix, re-run | 2 failed / 2 passed — the two tests that pin the defect fail, the two controls hold |
| `npm run typecheck` | clean |
| `npx vitest run src/lib/config/ src/lib/tools/ src/lib/vectors/ src/lib/media/` | 23 files, 209 tests, all pass |

## What is NOT done

1. **The three-corpus fan-out — the actual feature — is not written.**
   `src/lib/tools/vector-tools.ts` is untouched. An agent still searches
   `[ownScope, 'shared']` and never reaches `default`. The design is settled and
   written up in the feature [README](README.md) and in section 4.3 of the
   [session handoff](handoffs/2026-08-25-three-corpus-retrieval.md); it is a
   replacement of roughly lines 97–111 plus the `scope` property description,
   and a table-driven guard in the existing
   `src/lib/tools/vector-tools.scope.test.ts`.
2. **No end-to-end retrieval has ever been run.** The acceptance bar for this
   work is a real retrieval returning all three corpora in one search, cited by
   scope. That has not happened once. Nothing here claims deployed behaviour.
3. **The full validation list has not been run.** Only typecheck and scoped
   Vitest. See the blocker below about `npm test`.

## The next action, concretely

Write the fan-out in `src/lib/tools/vector-tools.ts`. One list must serve as
both the fan-out and the read allowlist so the two cannot drift:

```ts
let scopes = [...new Set([ownScope, DEFAULT_KNOWLEDGE_SCOPE, SHARED_KNOWLEDGE_SCOPE])];
if (typeof args.scope === 'string' && args.scope) {
  if (!scopes.includes(args.scope)) return { text: `Scope '${args.scope}' is not searchable from this agent. Allowed: ${scopes.map((s) => `'${s}'`).join(', ')}.`, isError: true };
  scopes = [args.scope];
}
```

Then run the harness described below and confirm all three corpora return.

## Things that will bite you

- **Do not touch `ingest_document`.** Writes stay pinned to the agent's own
  scope, resolved server-side. `args.scope` is model-supplied and therefore
  attacker-controlled under prompt injection; a write into `shared` would poison
  retrieval for every agent. `default` goes into the **read** allowlist only.
- **Do not scope-qualify the `chunkId` merge key.** It looks like a bug and is
  not: chat-ingest `docId` is a content hash, so one document can legitimately
  occupy two corpora, and the unqualified key collapses the duplicate keeping
  the higher score. Qualifying it would surface the same passage three times.
- **Leave the four `ingest_document` containment tests and the `ops-corpus`
  refusal in `vector-tools.scope.test.ts` byte-for-byte.** They are the security
  assertions. The test that legitimately changes is
  `searches own scope plus shared by default`.
- **`npm test` cannot go green on this machine**, and that is pre-existing. See
  the blocker below before you conclude you broke something.

## The end-to-end harness

`e2e-three-corpus.ts` at the repository root. **It is untracked and was
deliberately not committed** — decide what to do with it (see the open question
below).

```bash
AWS_PROFILE=netzer-process npx tsx e2e-three-corpus.ts
```

It writes an `agent.yaml` with a distinct scope and **no** `CLAUDE.md` to the
staging config bucket, ingests one uniquely-identifiable document into each of
the three corpora through the real ingest path, invokes the real
`s3_vectors_search` as that agent, prints the verbatim tool output, reports
HIT/MISS per corpus, and deletes the fixture. `--keep` skips cleanup.

It distinguishes all three states cleanly, which is why it is worth keeping:

| State | Expected result |
|---|---|
| Before `476e25b` | OWN misses — and the tool reports no error, which is the silent failure |
| After `476e25b`, before the fan-out | OWN hits, DEFAULT misses |
| After both | all three hit, each cited by its own scope |

It does not load `.env`, because `.env` pins `AWS_ENDPOINT_URL` at the local
Floci emulator, which stubs Bedrock and has no embeddings. Bucket names and the
credential profile are passed explicitly and only **staging** resources are
touched.

## Blockers and open questions

- [ ] **`npm test` exits 1 on an untouched `development` base**, so the step-7
      gate cannot be recorded as passing from this machine. Five files fail and
      none are in `src/`: four are the documented ledger entry **A7** (a
      Windows-only Vitest failure importing `.mjs` — `docs-links`,
      `feature-knowledge`, `runnable-blocks`, `sync-deprecations`) and the fifth
      is `scripts/lib/lifecycle/rollback-classes.test.ts`, one test failing on a
      Windows path separator. Both `.mjs` validators run clean under plain
      `node`, so the documentation gates were genuinely verified. Compare any
      future run against this list rather than against zero.
- [ ] **Open gap report against `development.md` § AWS safety**, filed
      2026-08-25, **not** applied. Layer 4 claims the machine has no `~/.aws`
      directory; `~/.aws/config` now exists, so isolation rests on three layers
      rather than four. The document is also silent on how to run a deliberate
      real-AWS verification when an acceptance bar requires one. An amendment is
      drafted and awaiting the maintainer. Running the harness against staging
      was treated as a one-time decision, recorded here, and is not blocked on
      it — but the document still needs correcting.
- [ ] **Should `e2e-three-corpus.ts` be committed?** Keeping it makes the proof
      reproducible. Committing it also puts a new real-AWS-touching script in
      the repository, which arguably belongs in
      [dangerous commands](../../../development.md#dangerous-commands-never-run-locally).
      That registration is a `development.md` edit and needs approval, which is
      why it was left untracked rather than quietly added.
- [ ] **`resolveChatIngestScope`** in `src/lib/media/chat-kb-ingest.ts` has a
      bare `catch` that silently redirects a chat-dropped document into
      `default`. Deliberately out of scope: it is a consumer of `loadAgent` and
      inherits `476e25b`. Recorded so it is not rediscovered as new.

## Route to production, as decided

Promotion chain, one PR per step: `fix/knowledge-scope-fanout` → `development` →
`qa` → `staging` → `production`. Merging to `staging` deploys staging
automatically, so the fix gets real-environment validation before production.
**Production deploys nothing on merge** — someone must dispatch `deploy.yml`
with `env: prod` and type `deploy` to confirm.

The bug is confirmed present in `origin/production`: the identical
`if (!text) return null` at `:180` followed by `fetchKnowledgeScope` at `:181`,
and the identical two-scope fan-out. The patch applies to production's code
unchanged, and production already carries the `indexPrefixFor` store fix, so
nothing interferes.

**Known divergence, reported and deliberately not reconciled here:**
`origin/production` carries 15 commits `origin/development` does not — the
`empty-turn-poisoning` hotfixes (#103–#106), a Bedrock Haiku model-id
correction, `hotfix: restore knowledge uploads and stop the index expiring`
(#91), and `hotfix: isolated delete chat promotion to production` (#90). Some
were backported and some were not; the Haiku model id, for instance, *is*
present in `development`. Reconciling that drift is its own change and must not
be folded into this one.

## Session log index

Newest first:

- [2026-08-25 — three-corpus retrieval](handoffs/2026-08-25-three-corpus-retrieval.md)

## Related

- [Feature README](README.md)
- [Knowledge durability](../knowledge-durability/README.md) — owns the storage prefix behaviour this work must not regress
- [Feature knowledge framework](../README.md)
- [`development.md`](../../../development.md)
