---
feature: netzar-chat
document_role: handoff
status: historical
observed_at: 2026-08-27
as_of_commit: 3cf4c34c359f74afc04dc258a3da90876fa05a37
---

# Netzar Chat — phases 1-6, the compat spike, and the donor harvest

## 1. Scope

Built the whole chat surface (theming, layout shell, message list with the tool
timeline, composer, agent/model pickers, conversation sidebar), settled the
react->preact/compat question by spike, and harvested donor source into the
shipping branch. Each phase was gated by a builder and a separate blind critic
comparing against two frozen bars.

## 2. Current state summary

19 commits ahead of `origin/development` on `feature/librechat-chat-ui`. Every
phase has been accepted by a blind critic. Nothing is pushed; nothing is
deployed. The next action is the promotion ladder (section 6).

## 3. Decisions

- **The preact/compat ban was never in force.** `@preact/preset-vite` already
  aliases react to preact/compat by default and merges those aliases ahead of
  user config. Donor React source compiles here unmodified — the spike proved it
  on the first attempt with zero edits. Recorded in [plan.md](../plan.md)
  decision 1, which supersedes the original ban.
- **Ariakit is excluded on evidence, not taste.** Its menus mount and filter
  under Preact but their keyboard access is silently dead:
  `aria-activedescendant` never populates, ArrowDown does nothing, `hideOnClick`
  never fires. Preact's `useId` restarts per portal root and emits duplicate ids
  that Ariakit's composite store addresses by, and Ariakit writes to
  `event.currentTarget`, which Preact exposes as a getter with no synthetic
  event layer to intercept. Our hand-written CommandMenu stays, and the
  roll-call proves it does the keyboard selection Ariakit could not.
- **The donor markdown parser is excluded on cost**: 111 kB gzip without KaTeX,
  279 kB with, against 12.87 kB for the `marked` renderer already shipping.
- **The delete flow was deliberately NOT moved** into the sidebar. The brief
  said move it verbatim; transcribing `deletingRef`, the confirm step and the
  snapshot-inside-updater rollback was the single action most likely to break
  paid-for fixes, so the sidebar reports which row was clicked and the flow
  stays byte-identical in `Chat.tsx`. Proven live rather than assumed.
- **Mobile pickers keep a row each.** This costs ~20 CSS px of chrome against
  the donor and buys whole labels; stacked they truncated ("Netzar Prime" showed
  45px of 80). On a surface selling which agent answered you, a clipped agent
  name is the worse defect.

## 4. What was copied

826 donor lines render, 780 byte-identical (94.4%), verified by a critic's own
diff against the pinned donor rather than by claim. The enabler was a shim for
`@librechat/client`: the donor's UI primitives are an npm package with 485
import sites across its tree, not source, which is why every earlier copy
attempt died on an unresolvable import.

Four byte-perfect copies were deleted rather than kept — InProgressCall,
ProgressCircle, MenuItem, UnifiedSidebar/constants compiled but nothing imported
them, and 217 lines of unreachable code inflate a count without delivering.

## 5. Ledger (carried forward)

- M6: Vitest cannot start inside a Windows linked worktree — use a full clone.
- The dev harness must answer `/agents` and `/sessions`; they are DynamoDB-backed
  and fail locally, so without it the chat route cannot be driven at all.
- `scripts/local/dev.mjs` fails on this machine (`spawn npm ENOENT` under Git
  Bash); start the orchestrator and dashboard separately.
- Piping a dev server's output through `head` kills it via SIGPIPE.
- The production CSS build is a real gate: lightningcss rejects Tailwind forms
  that `tsc` accepts, so `npm --prefix web run build` catches what typecheck
  cannot.

## 6. Next action

The promotion ladder: PR into `development`, merge on green CI, then
`development -> qa -> staging`. A push to `staging` auto-deploys Tier 0 to
staging.pgnos.ai. **The Deploy run itself is the gate, not the merge** — a red
or cancelled run is an unfinished phase. Then verify on real staging the things
a local Bedrock stub cannot prove: streaming cadence, live tool statuses, the
agent and model roll-call, both themes, mobile. Production is manual-dispatch
with a typed confirmation and needs a separate human go-ahead.

## 7. Verification actually performed

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| `npm --prefix web run typecheck` | exit 0 |
| `npm --prefix web run build` | exit 0; chat chunk 80.31 kB gzip |
| `npx vitest run` (chat golden tests) | 70/70 |
| `node scripts/ci/docs-links.mjs` | OK |
| `node scripts/ci/feature-knowledge.mjs` | OK |
| `git diff --check` | clean |
| `rollcall-pickers.js` | ROLLCALL_PASS 84/84 — 18/18 agents, 5/5 models, "Agent default" sends no override |
| `probe-tour-anchors.js` | ALL_SIX_ANCHORS_PRESENT |

## 8. Environment

Bars frozen at `C:\dev\_netzer-librechat-qa\bar\`: `librechat/` 52 donor shots,
`house/` 12, `ours/` regenerated per round. Donor source at `donor/src`. Spike
preserved on `spike/preact-compat` (`0b065a0`) — not merged, safe to inspect or
discard. Tool-call states are genuinely unobtainable from the donor: its mock
streams text deltas and never emits `tool_calls`. That gap is recorded, not
faked.
