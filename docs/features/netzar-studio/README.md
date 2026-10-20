---
feature: netzar-studio
document_role: index
status: current
observed_at: 2026-10-20
as_of_commit: d1d3a66970cd548f9529a234ef2b51ecdc29378e
approved_work:
  - docs/features/netzar-studio/backlog.md
---

# Netzar Studio rebuild

Follows the [feature knowledge framework](../README.md).

## 1. What this is
The rebuild of Netzar into a simpler product: a conversational Workflow Studio where a person with no coding
knowledge describes a business process and gets a correct, understandable, testable workflow, inside a new
5-area Workspace, with today's dashboard kept as an admin-only Admin console. Target: done by 2026-12-31.

## 2. Scope
In: factory hardening, knowledge security fix, Workspace + Admin console, Workflow Studio (drafter, plain preview,
sample-data test, playbooks, company facts, agent versions, evals), then live workflows (engine, webhook/API
triggers, publish/activate/rollback, Paperclip retirement). Out until 2027: AI teams, visual canvas,
Developer Studio, outcome packs, customer-built integrations. Full detail: [blueprint](blueprint.md).

## 3. Current status and current source commit
Planning only. No product code changed. Observed against `development` at `d1d3a66` on 2026-10-20.
This is source evidence, not deployment evidence; nothing is deployed.

## 4. Source of truth
| Concern | Authority | Use it for |
|---|---|---|
| Plan and decisions | [blueprint](blueprint.md) | MVP, journeys, keep/modify/remove/build, acceptance criteria |
| Approved work | [backlog](backlog.md) | The only approved execution queue (NZR-n IDs, mirrored in Plane) |
| Volatile state | [HANDOFF](HANDOFF.md) | Branch, next action, open owner items |

## 5. Cycles
| Cycle | Dates | Tasks | Points |
|---|---|---|---|
| C0 Factory hardening | 2026-10-20 → 2026-10-26 | 5 | 18 |
| C1 Foundations | 2026-10-27 → 2026-11-09 | 10 | 38 |
| C2 MVP | 2026-11-10 → 2026-12-07 | 18 | 82 |
| C3 Live (loop 2) | 2026-12-08 → 2026-12-31 | 7 | 40 |
| **Total** | | 40 | 178 |

Each cycle has an exit gate (see [backlog](backlog.md)); a cycle does not start until the previous gate passes.

## 6. How work is executed
Work runs through the Gauntlet Loop engineering factory (`engdept`): frozen tests before code, an independent
critic, and evidence per step. The builder never certifies its own work. Model routing (owner decision 2026-10-20):
NVIDIA-hosted models (Gemma 4, Nemotron, Qwen/GLM coders) write small code; Codex reviews code; Opus orchestrates and
plans. Jev (`typesafe/jev-1.13` via OpenRouter) gives a first-pass recommendation on routes and a second pass/fail
check after the tests, critic and gates; a red or skipped gate is always a fail. If a model's usage runs out,
Jev picks the replacement; if Jev is not confident, the owner decides. Push, PR, deploy, new dependencies and
spend over the cap always need the owner's yes.
