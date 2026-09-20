---
feature: chat-history-integrity
document_role: handoff
status: current
observed_at: 2026-09-19
as_of_commit: 3f9c94ed4f6d1099a9d20613ef7701b641a17503
---

# Chat history integrity — current state

## Where this is

| | |
|---|---|
| Branch | `fix/test-credential-isolation` (WI-0.3): the AWS guard for the unit suite. Cut from `origin/development` at `0f41b53`. On top: the red state (`87c07b7`, test only), the guard (`54cb972`), its docs (`f533052`), the cleanup (`e09d673`, comments only), its docs (`3f9c94e`) and this session's verification docs commit. |
| Based on | `development` at `0f41b532668dc95e25db7473244db00e1b1cf5ed`, the merge of PR #179. It holds WI-0.1 (#176 → `264d024`), WI-0.2 (#177 → `b152b7a`), the `development.md` amendment (#178 → `33d9126`) and the WI-0.2 cleanup (#179). |
| Next merge target | `development` |
| Deployment state | **Nothing here deploys.** Nothing has been promoted past `development`: `qa`, `staging` and `production` still lack WI-0.1, WI-0.2 and the cleanup. `staging` deploys on push, so promotion needs its own authorization. Production (`de244e6`, deployed 2026-09-09) runs the hotfixes WI-0.1 back-merged. |
| Pushed | WI-0.3: **no**, local only. WI-0.1, WI-0.2, the amendment and the cleanup: yes, all merged into `development` on 2026-09-19. Every head branch is deleted on `origin`. |
| PR | WI-0.3: none. Earlier: [#176](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/176), [#177](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/177), [#178](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/178), [#179](https://github.com/Adams-Captial-Holdings-Ltd/Netzer-Labs/pull/179), all merged. |

Staging is reachable only by the promotion chain `development → qa → staging`. Each step is its own pull request, because `scripts/ci/deploy-source-guard.mjs` refuses any staging deploy whose ref is not `refs/heads/staging`. Nothing on a `fix/*` branch reaches an AWS environment.

## Current objective

WI-0.3 (plan section 10, P0 step 3): make `npm test` hermetic — a credential-stripping setup file and an AWS tripwire, plus a `budget-writer` mock, without changing what `npm test` collects.

**Status: WI-0.3 is VERIFIED (2026-09-19, at `3f9c94e`)** — implemented, cleaned up, and then judged **PASS** on all eight criteria by a fresh critic that neither built nor cleaned it ([verification log](handoffs/2026-09-19-wi03-verification.md)). Every criterion was re-derived from the repository, not carried from a log ([implementation log](handoffs/2026-09-19-wi03-implementation.md), sections 2 and 7; [cleanup log](handoffs/2026-09-19-wi03-cleanup.md)). The cleanup was comment-only: two comments in `vitest.setup.ts`, naming what `neutralised` records and the pool assumption under the once-per-worker install.
- `vitest.setup.ts` at the repository root, named in `vitest.config.ts`'s `setupFiles`, arms two layers in every worker: it neutralises every ambient credential source, and it records and refuses any `*.amazonaws.com` dial on `http`/`https` `request` and `get`.
- The refusal survives a swallow. An `afterEach` fails the test that made the call, which is what `budget-writer.ts` catching its own errors used to hide.
- `src/adapters/dashboard/cost-cap.test.ts` also mocks `budget-writer` directly, so that suite has no intent to call AWS.
- **The hand-stripping constraint is retired.** AC-0.3-2, AC-0.3-3 and AC-0.3-4 all passed, which is what the constraint named as its own release condition.

## Live state worth knowing

- **Green at `3f9c94e`**, re-derived by the verification ([log](handoffs/2026-09-19-wi03-verification.md), section 7):
  - `bash wi-0.3-proof.sh` in scored mode: 9 lines PASS, `FAILS=0`, exit 0, 0 changed paths left behind.
  - `npm test` with credentials **planted and not stripped**: 247 files, 3215 tests, exit 0, and **zero** `NETZAR-AWS-GUARD VIOLATION` lines.
  - The full step 7 list equals the baseline, run on this exact HEAD. Integration: 38 passed, 25 skipped, 1 failed — the Floci `checkSecrets` gap, confirmed by name.
  - Collection is unchanged: all 246 baseline files, plus `src/__test-utils__/aws-guard.test.ts`.
  - Scope: **8** changed paths against `origin/development`, all inside the seam. The count tracks the branch, not the session — it was 7 at `e09d673` and grew with the cleanup's docs commit, so score the criterion ("all inside the seam"), never the number. `package.json` and the lockfile are untouched.
  - Nothing can silently disarm the tripwire: no file outside `vitest.setup.ts` reassigns `http`/`https` `request` or `get`, and no HTTP-interception library is imported or declared.
- **The tripwire is proved on the real path, not just a synthetic one.** With fake credentials restored inside a test, the real `syncBudgetToDailyCap` dialled `sts.us-east-1.amazonaws.com`; the guard refused it, `budget-writer.ts` swallowed the error, and the test failed anyway.
- **AC-0.3-5's original mutation could not pass** and was amended with the owner's approval. Removing the mock does not reach a socket: layer 1 ends the call at `Could not load credentials from any providers`, so layer 2 has nothing to catch ([log](handoffs/2026-09-19-wi03-implementation.md), section 3.3 and M43).
- **`vitest.setup.ts` is not type-checked.** `tsconfig.json:25` names `vitest.config.ts` by name rather than globbing root files. `tsconfig.build.json` still keeps it out of `dist`. Classified, not patched (A39).
- **Chat `dashboard:1787596504860` (agent `elon-strategy`)** was poisoned in production on 2026-08-24. It has not been re-checked since production received the empty-turn repair (`8c14b3f`, #103).
- **BR-002 dry-run (at `6d43213`, not rerun since):** merging production into HEAD gives 9 conflicted files. Merging staging into HEAD is conflict-free.

## Blockers and open items

| Item | Status |
|---|---|
| The `development.md` AWS-safety paragraph still tells the reader to hand-strip, and its Automated tests table still says 246 files / 3209 tests | **Now wrong on the page.** The re-amendment is drafted ([spec log](handoffs/2026-09-19-wi03-specification.md), section 6.3) and needs a fresh owner yes/no **in the conversation that applies it**, exactly as PR #178's did. |
| `vitest.setup.ts` is outside `npm run typecheck`'s include list | Technical debt, one line in `tsconfig.json`. Outside AC-0.3-6's approved scope; offer it with the amendment above. |
| The tripwire matches the **first** host-bearing argument, while node gives `options` precedence over a `url` string | Technical debt, theoretical (A43). A two-argument dial whose `options.hostname` is the AWS host and whose URL is not would pass. No caller here passes both; the SDK passes one options object. Fixing it is a behaviour change, so it was classified, not patched. |
| Layer 1 does not neutralise `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI` / `_FULL_URI` or `AWS_WEB_IDENTITY_TOKEN_FILE` / `AWS_ROLE_ARN` | Technical debt, found by VERIFICATION (A45). Three places say layer 1 neutralises "every ambient credential source"; it covers the env, ini/process and IMDS members of the chain, not those four. **The safety property still holds** — layer 2 refuses the `*.amazonaws.com` call either path would end up making. None of the four is set on this machine. Four names in `CREDENTIAL_VARS` plus a wording fix; a behaviour change, so classified, not patched. |
| Promote `development → qa → staging` (owner decision 18) | **Due, not started.** Each step is its own PR, each confirmed with the owner before the push. The `staging` merge deploys (`cdk deploy --all`). |
| Production-only hotfixes #90, #91, #168 and the rest of #170 are not ancestors of `development` | Deferred by owner decision. **Do not promote `staging → production` until they are reconciled.** |
| Raising `agent/max_output_tokens` above 8192 in production | Unknown whether a non-streaming tool round (`ConverseCommand`, no client timeout set) finishes at that length. Exercise one long tool round first. The default stays 8192; the owner chose (c) on 2026-09-19, so large documents go through the incremental document tool and there is no separate ceiling item. |
| Documents of unbounded size | The incremental document tool is approved as a proposed P4 item (owner, 2026-09-19). It needs its own SPECIFICATION. |
| `budget-writer.ts` swallows every AWS error | Pre-existing and deliberate ("best-effort by design"). Unchanged — but the guard now makes it visible in tests, which was the point. |
| Documentation debts found in WI-0.2 CLEANUP | Classified and not patched ([log](handoffs/2026-09-19-wi02-cleanup.md), section 6.4): the README's `tested_by` and `implemented_by` omit the builder files and `builders.test.ts`; section 2.4 sits after 3a; and sections 3a and 4 disagree about production PDFs as of 2026-08-24. |
| The knowledge Q&A route (`handler.ts:2826-2828`) sends browser-posted history text to Bedrock with no empty-text guard | Technical debt, unrelated. Per request and never stored, so it cannot poison a chat. |
| `src/lib/state/runtime-config-repo.ts` holds literal NUL bytes (`:57`, `:238`), so `git grep -n` prints nothing for it | Technical debt, unrelated. Use `grep -a`. |
| `1124118` (Haiku id) takes effect only through a CDK deploy | A note for whoever deploys. A staging promotion runs one. |
| `npm run local` dies with `spawn npm ENOENT` on Windows (`scripts/local/dev.mjs:79-80`) | Deferred to its own `fix/*` branch. |
| PDF and DOCX had never run in production (as of 2026-08-24) | Not re-checked |
| Does the model reliably *pick* `generate_document`? (open on 2026-08-24) | Not re-checked |
| `memory ingest failed — "The provided model identifier is invalid."` (production, 2026-08-24) | Not re-checked |
| `webhook monitor: getWebhookInfo failed`, repeating (2026-08-24) | Not re-checked |

## Smallest next action

WI-0.3 is verified and complete. Nothing is pushed. The next action is the owner's, and needs authorization in the conversation that performs it: either push `fix/test-credential-isolation` and open its PR into `development` (re-running the full step 7 list on the exact HEAD pushed), or start owner decision 23 — the drafted `development.md` re-amendment plus A39's one-line `tsconfig.json` include — on its **own** branch, because putting them here would fail AC-0.3-6.

## Related

- [README](README.md), including the [content check](README.md#4a-checking-a-branch-for-these-fixes-by-content-never-by-ancestry)
- [2026-09-19 WI-0.3 verification log](handoffs/2026-09-19-wi03-verification.md): the PASS verdict for WI-0.3 at `3f9c94e`, every criterion re-derived from the code, and the provider-chain gap it found
- [2026-09-19 WI-0.3 cleanup log](handoffs/2026-09-19-wi03-cleanup.md): the two comments, what was deliberately left duplicated, and the proof and step 7 list re-run at `e09d673`
- [2026-09-19 WI-0.3 implementation log](handoffs/2026-09-19-wi03-implementation.md): what the guard does, why AC-0.3-5's mutation was amended, and every command with its result at `54cb972`
- [2026-09-19 WI-0.3 specification log](handoffs/2026-09-19-wi03-specification.md): the seam, the red state, the acceptance criteria, and the drafted `development.md` re-amendment
- [2026-09-19 WI-0.2 verification (final) log](handoffs/2026-09-19-wi02-verification-final.md): the PASS verdict for the whole item at `c195a6e`
- [2026-09-19 WI-0.2 specification amendment log](handoffs/2026-09-19-wi02-spec-amendment.md): the pinning test and the new counts
- [2026-09-19 WI-0.2 cleanup rerun log](handoffs/2026-09-19-wi02-cleanup-rerun.md): the replay paths and all 56 README claim checks
- [2026-09-18 WI-0.2 implementation log](handoffs/2026-09-18-wi02-implementation.md): the Codex build, its correction and the two defects
- [2026-09-18 verification log](handoffs/2026-09-18-wi01-verification.md): the PASS verdict for WI-0.1 at `fdda55c`
- [2026-09-17 docgen-crash-wip-transfer](handoffs/2026-09-17-docgen-crash-wip-transfer.md): the parked turn-ceiling work
- [knowledge-scope-fanout HANDOFF](../knowledge-scope-fanout/HANDOFF.md), which records the closed `staging → production` PR #61
- [Feature knowledge framework](../README.md)

## Session index

| Date | Session | Subject |
|---|---|---|
| 2026-09-19 | [wi03-verification](handoffs/2026-09-19-wi03-verification.md) | A fresh critic verified WI-0.3 at `3f9c94e`: **PASS** on all eight criteria, each re-derived from the repository. The proof is 9 PASS / `FAILS=0`; `npm test` is 247 files / 3215 tests with credentials planted and no stripping and zero violations; the full step 7 list equals the baseline on that exact HEAD. Both negative controls were read as output, not scored from a line — the real `budget-writer` dial was refused, logged its own swallow, and failed its test anyway. Corrected one count: the branch scope is 8 paths at `3f9c94e`, 7 at `e09d673`. One new finding classified, not patched: layer 1 leaves the container-credential and web-identity chain members set, which layer 2 still covers (A45). |
| 2026-09-19 | [wi03-cleanup](handoffs/2026-09-19-wi03-cleanup.md) | Cleaned up WI-0.3 with `/refactor`, scope-locked: two comments in `vitest.setup.ts` (`e09d673`), naming what `neutralised` actually records and the pool assumption under the once-per-worker install. No behaviour changed. The duplicated credential list and guard type in `aws-guard.test.ts` were left alone on purpose — unifying them would make the contract test assert against the implementation's own constant. The proof still exits 0 on all nine lines, and the full step 7 list was re-run (a file in `setupFiles` is a config file, P36) and equals the baseline. One new finding classified, not patched: the tripwire reads the first host-bearing argument, while node gives `options` precedence over a `url` string (A43). |
| 2026-09-19 | [wi03-implementation](handoffs/2026-09-19-wi03-implementation.md) | Armed the AWS guard (`54cb972`): a root `vitest.setup.ts` in `setupFiles` that neutralises every credential source and refuses any `*.amazonaws.com` dial, reporting from an `afterEach` so a swallowed error still fails its test, plus the one-line `budget-writer` mock in `cost-cap.test.ts`. The proof exits 0 on all nine lines; `npm test` is 247 files / 3215 tests with credentials planted and no stripping, with zero violations; the full step 7 list equals the baseline. AC-0.3-5's mutation could not pass against a correct guard and was replaced, with the owner's approval, by a control that restores credentials inside the test: the real `budget-writer` dial was refused and failed the test despite the swallow. |
| 2026-09-19 | [wi03-specification](handoffs/2026-09-19-wi03-specification.md) | Pinned the seam for WI-0.3 and committed the red state (`87c07b7`, test only): five tests that fail because no guard is armed. Established that this machine's `~/.aws` has no `[default]` profile, so an un-stripped run in a clean shell proves nothing, and made AC-0.3-2 plant fake credentials instead. Defined AC-0.3-1 … AC-0.3-7 with exact commands in two scripts kept outside the repository, and drafted the `development.md` re-amendment without applying it. |
| 2026-09-19 | [wi02-verification-final](handoffs/2026-09-19-wi02-verification-final.md) | A fresh critic verified the whole of WI-0.2 at `c195a6e`: **PASS** on all seven criteria. README 2.1's replay set was re-derived from the agent loop's 11 call sites; the proof passed every line with 72 tests; the full step 7 list equalled the baseline (246 files, 3210 tests; integration 38/25/1); and under the `raw?.trim()` mutation the pinning test was the only failure in the whole suite. |
| 2026-09-19 | [wi02-spec-amendment](handoffs/2026-09-19-wi02-spec-amendment.md) | Added the test the owner approved: a `max_output_tokens` value stored as a number resolves to that number and the turn still runs (`7b6bbf3`). New counts: 8 ceiling tests, and `npm test` 246 files and 3210 tests. |
| 2026-09-19 | [wi02-cleanup-rerun](handoffs/2026-09-19-wi02-cleanup-rerun.md) | Fixed VERIFICATION's one failure, docs only (`e1cdc11`). README 2.1 now names the eight call sites that replay a stored transcript through `getSession`. A full re-check (56 checks) found and corrected section 4's false "spec validation unchanged". |
| 2026-09-19 | [wi02-verification](handoffs/2026-09-19-wi02-verification.md) | A fresh critic verified WI-0.2 as merged plus the cleanup, at `974399b`: FAIL on one criterion — the README stamp certified section 2.1's false claim that Jarvis reads through `getSession`. Routed to a CLEANUP rerun. |
| 2026-09-19 | [wi02-cleanup](handoffs/2026-09-19-wi02-cleanup.md) | Cleaned up WI-0.2 on `chore/wi02-cleanup` off `development`: comments and docs only (`d1876b1`), including two diagram notes the drift gate forced a review of. |
| 2026-09-18 | [wi02-implementation](handoffs/2026-09-18-wi02-implementation.md) | Codex `gpt-5.6-terra` built WI-0.2 from the work order. Claude rejected the first build on two defects the tests could not see and sent the one allowed correction. Committed `3ae63b4`. |
| 2026-09-18 | [wi02-specification](handoffs/2026-09-18-wi02-specification.md) | G0 failed (WI-0.1 not on `development`). Opened PR #176. WI-0.2 red at `56e37b0`, with a user-turn boundary rule for the byte trim. |
| 2026-09-18 | [wi01-verification](handoffs/2026-09-18-wi01-verification.md) | A fresh critic verified WI-0.1: PASS. Every criterion, blob, route check and the full validation rerun at `fdda55c`. |
| 2026-09-18 | [wi01-cleanup](handoffs/2026-09-18-wi01-cleanup.md) | Reviewed the back-merge with `/refactor`: no change needed. Classified two findings and patched neither. |
| 2026-09-18 | [wi01-implementation](handoffs/2026-09-18-wi01-implementation.md) | Applied the nine picks with `-x`. Codex wrote the #170 slice and the diagram notes; Claude inspected and proved them. |
| 2026-09-18 | [wi01-specification](handoffs/2026-09-18-wi01-specification.md) | Rebased onto `9e8e42b`, recorded a green baseline, committed the red state and mapped every pick's conflicts. |
| 2026-09-17 | [backmerge-machine-transfer](handoffs/2026-09-17-backmerge-machine-transfer.md) | Landed the 09-10 log, recorded the interrupted claudex loop, and parked the back-merge for the machine transfer. |
| 2026-09-17 | [docgen-crash-wip-transfer](handoffs/2026-09-17-docgen-crash-wip-transfer.md) | Parked the 2026-08-25 turn-ceiling work in progress on `wip/docgen-crash-turn-ceiling`. |
| 2026-09-10 | [backmerge-production-hotfixes](handoffs/2026-09-10-backmerge-production-hotfixes.md) | Opened the back-merge of #103–#106 on a fresh clone at `271339b`. Nothing applied. |
| 2026-08-24 | [empty-turn-poisoning](handoffs/2026-08-24-empty-turn-poisoning.md) | Diagnosed the max_tokens → empty turn → dead chat chain from production logs, and shipped the three guards of #96. |
