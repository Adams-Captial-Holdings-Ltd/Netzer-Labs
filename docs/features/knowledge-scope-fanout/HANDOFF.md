---
feature: knowledge-scope-fanout
document_role: handoff
status: current
observed_at: 2026-08-25
as_of_commit: 0072dde
---

# Knowledge scope fan-out handoff

## Where this is

- **Branch:** `fix/knowledge-scope-fanout`, branched from `origin/development` at
  `06ebe1caf91c4053b0bce6a8fc3c2c82fb9d2710`. **Merge target:** `development`.
- **AWS environment this branch reaches:** none. Per the
  [branch mapping](../../../development.md#branch-to-environment-mapping),
  `fix/*` and `development` both deploy nothing. Staging resources were used for
  verification only and the fixture was removed.
- **Pushed:** yes. **Merged:** `development` (#115), `qa` (#121), `staging`
  (#122). **Deployed:** staging, automatically on the `staging` merge.
  Production not yet promoted.
- **Commits:** `476e25b` (scope resolution), `ded9dd3` (interim docs),
  `c3d27bb` (the three-corpus fan-out), `9bfbd97` (per-corpus reporting),
  `3c8ef67` (docs), `0072dde` (harness tracked, development.md corrected),
  `660e7bb` (production measurements).

**The feature is complete and proven end to end**, including the per-corpus
reporting, which was re-verified live on `0072dde` after re-authenticating.

**Before opening the `staging` → `production` PR**, re-check that production's
`index/default/` is still empty. It was empty when measured on 2026-08-26, which
is the only reason the read-widening carries no disclosure risk. That check is
one CLI call and it guards the sole irreversible consequence of this change.

## What the proof actually was

Not a passing unit test. A real retrieval against staging: a fixture agent with
an `agent.yaml` and deliberately no `CLAUDE.md`, one uniquely identifiable
document ingested into each of the three corpora, one question asked as that
agent.

```
HIT   OWN     <e2emt8yy6na-own>
HIT   DEFAULT <default>
HIT   SHARED  <shared>
RESULT: PASS — all three corpora returned in one search, each cited by scope.
```

Run on `c3d27bb` by a critic that did not write the code, with its own run nonce
distinct from the builder's, so it is an independent run rather than a replayed
transcript. The same harness on the previous commit returned two of
three and reported no error at all — the silent failure this work exists to kill.

## Verified

| Check | Result |
|---|---|
| End-to-end retrieval harness, on `c3d27bb` | **PASS** — three HITs, fixture self-cleaned, exit 0 |
| End-to-end retrieval harness, on `0072dde` | **PASS** — three HITs, new kept/found output confirmed live, fixture self-cleaned |
| `npx vitest run src/lib/tools/vector-tools.scope.test.ts` | pass, 13/13 |
| `npx vitest run src/lib/config/agent-loader.scope.test.ts` | pass, 4/4 |
| Mutation: drop `default` from the scopes list | 3 tests fail, as they must |
| Mutation: swap the `Set` for a plain array | the `default` and `shared` rows fail on the duplicate-scan check |
| Mutation: revert the loader fix | the two tests pinning that defect fail; controls hold |
| Mutation: count contribution by scope string instead of `chunkId` | the colon-scope guard fails, and only that one |
| `npm run typecheck` | clean |
| `npm run build` | clean |
| `npm --prefix web run typecheck` | clean |
| `npm --prefix web run build` | built in 2m22s |
| `node scripts/ci/docs-links.mjs` | OK — 120 files, 1333 internal links |
| `node scripts/ci/feature-knowledge.mjs` | OK |
| `git diff --check` | clean |

`npm run local:test:integration` was **not run locally** — Docker is unavailable
on this machine. It ran in CI instead: the **Integration Tests (LocalStack)**
job passed on every promotion PR (#115, #121, #122), which closes that gate.

CI also settles the local `npm test` noise below. **Typecheck + Unit Tests**
passed on all three promotion PRs, so the suite is green on Linux and the
Windows failures are environmental.

## Production reality, measured 2026-08-26

Two claims made earlier in this work were wrong and are corrected here.

**The bug is latent in production, not active.** All seven production agents —
`audre-compliance`, `elon-strategy`, `imani-benefits-advisory`,
`jada-marketing`, `main`, `malik-business-risk-advisory`,
`tasha-client-services` — have a `CLAUDE.md` object. The loader defect only
bites an agent that has an `agent.yaml` and **no** `CLAUDE.md`, so no production
agent is affected today. What was confirmed earlier was that the buggy *code*
ships in production, which is not the same as a user being harmed by it. The fix
is protection against the next agent created without a prompt file, not a repair
of live damage.

**There is no stranded corpus.** `index/default/` in
`claudeclaw-vectors-239887088812-us-east-1` holds **zero objects**. The populated
scopes are all per-agent plus `shared`. A review had raised that documents
ingested during the bug window would have landed in `default` and would become
fleet-readable when this ships — a real mechanism, since both write paths
(`ingest_document` at `vector-tools.ts:46` and `resolveChatIngestScope` at
`chat-kb-ingest.ts:66`) fall back to `DEFAULT_KNOWLEDGE_SCOPE`. It does not
materialise here because nothing was ever written there. Re-check this before
any future promotion; it is cheap and it is the only irreversible risk in the
change.

A consequence worth stating: because `default` is empty, the fan-out returns
nothing new in production today. Its value is prospective.

## `npm test` cannot give a signal on this machine

Not merely non-hermetic — **nondeterministic in both directions**, measured:

| Code under test | Credentials | Failing tests, consecutive runs |
|---|---|---|
| base `06ebe1c` | none | 5 files / 1 test |
| this branch | none | 7 files / 4 tests |
| base `06ebe1c` | live | 3, then 5, then 1 |
| this branch | live | 6, then 5 |

The base range covers this branch's range. Two distinct credential-dependent
classes are at work: `durability.repro.test.ts` writes to the real staging
bucket and fails **without** credentials, while four dashboard tests
(`cost-cap`, `jarvis.flow`, `test-turn-attachments`, `authz-matrix`) make real
AWS calls against a 5-second test timeout and fail **with** them, depending on
latency and machine load. Every one of those four has **zero** references to
`loadAgent`, `agent-loader`, or `vector-tools`, so this change cannot reach
them, and they fail on the untouched base commit too.

`development.md` previously listed `npm test` as safe to run locally. `0072dde`
corrects that.

## The next action

Three of the four promotion steps are done: `development` (#115), `qa` (#121),
`staging` (#122), each with all CI gates green. The `staging` merge triggered the
staging deploy automatically.

What remains:

1. Re-check production's `index/default/` is still empty — see the warning at the
   top of this document. This is the only irreversible risk in the change.
2. Open and merge `staging` → `production`.
3. **A human must then dispatch the deploy.** Merging to `production` deploys
   nothing by itself: `deploy.yml` for prod is `workflow_dispatch` only, requires
   typing `deploy` to confirm, and `deploy-source-guard.mjs` rejects any prod
   deploy whose ref is not `refs/heads/production`.

Note that because production's `default` corpus is empty, this deploy changes
nothing observable in production. Anyone hoping to *test* the fan-out there will
see no difference until something is filed in `default`.

## Open questions

- [ ] **Top-K dilution — the largest remaining gap.** Each scope is queried with
      the same `topK` and the merged set is sliced back to `topK`, so an agent's
      own passages can now be evicted by higher-scoring `default` ones. Default
      `topK` is 5, so against a large `default` corpus an agent could ask about a
      document it uploaded itself and get five `default` passages instead. A
      matter of degree rather than a new failure class — own passages could
      already lose to `shared` — but the pressure is higher. Neither the harness
      nor any unit test catches it; the harness ran with `top_k=10` against
      exactly three documents. Suggested fix: a per-scope floor, or a test
      pinning per-scope representation in the merged result. Deliberately not
      fixed here, to keep the change small.
- [x] **The harness is tracked.** Now at `scripts/e2e-three-corpus.ts` and
      registered on `development.md`'s dangerous-commands list, in `0072dde`.
      Run it with `AWS_PROFILE=netzer-process npx tsx scripts/e2e-three-corpus.ts`;
      it provisions and deletes its own fixture and touches staging only.
- [ ] **Nobody runs it but a human.** It is still not in CI, so the only proof
      this feature works is a command someone has to remember to type.
- [ ] **Gap report against `development.md` § AWS safety**, filed and **not**
      applied. Layer 4 claims the machine has no `~/.aws` directory; it now does,
      so isolation rests on three layers rather than four. Running the harness
      against staging was treated as a one-time decision, recorded in both
      session logs.
- [ ] **Deferred, recorded so they are not rediscovered as new:** negative-result
      caching in `loadAgent` pins an agent to `default` for the 5-minute TTL after
      a transient S3 error; `resolveChatIngestScope`'s bare `catch` still
      redirects a chat-dropped document to `default`, though that is now less
      harmful since `default` is universally readable.

## Production is blocked, and not by this feature

Two pre-existing problems, both found on 2026-08-26 and neither caused by this
work. Full evidence in the [session log](handoffs/2026-08-26-promotion-and-deploy-blockers.md),
section 6.3.

**Every staging deploy fails.** Five consecutive failures since 2026-08-25 12:52
at the "Populate Paperclip secret" step — the deploy role lacks
`secretsmanager:GetSecretValue` and `PutSecretValue`. So **staging is not running
this build**, and the promotion chain's real-environment validation did not
happen. The feature's proof comes from driving the harness against staging
infrastructure directly, which is still evidence, but it is not a deployed build.

**A production deploy will likely fail the same way.** It defaults to tier 3,
where `paperclipEnabled` is true, so it runs the identical step against
`/claudeclaw/paperclip`. The last successful production deploy contains no
Paperclip step at all, so there is no evidence that role carries the grants.

**PR #61 (`staging` → `production`) has been conflicted since 2026-08-15.** A
local test merge produced eleven conflicting files, all from the
empty-turn-poisoning hotfixes. **None touch this feature** — `vector-tools.ts`,
`agent-loader.ts` and the harness merge cleanly. A `hotfix/*` branch from
`production` would therefore sidestep the conflicts entirely, though it still
leaves the IAM grant in front of the deploy.

## Known divergence, reported not reconciled

`origin/production` carries 15 commits `origin/development` does not — the
`empty-turn-poisoning` hotfixes (#103–#106), a Bedrock Haiku model-id correction,
`hotfix: restore knowledge uploads and stop the index expiring` (#91), and
`hotfix: isolated delete chat promotion to production` (#90). Some were
backported and some were not. Reconciling that drift is its own change.

## Session log index

Newest first:

- [2026-08-26 — promotion and deploy blockers](handoffs/2026-08-26-promotion-and-deploy-blockers.md)
  — merged to staging; production blocked by two pre-existing problems
- [2026-08-25 — three-corpus fan-out](handoffs/2026-08-25-three-corpus-fanout.md)
- [2026-08-25 — three-corpus retrieval](handoffs/2026-08-25-three-corpus-retrieval.md)

## Related

- [Feature README](README.md)
- [Knowledge durability](../knowledge-durability/README.md) — owns the storage prefix behaviour this work must not regress
- [Feature knowledge framework](../README.md)
- [`development.md`](../../../development.md)
