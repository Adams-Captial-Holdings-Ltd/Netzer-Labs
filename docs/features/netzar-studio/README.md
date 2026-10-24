---
feature: netzar-studio
document_role: index
status: current
observed_at: 2026-10-23
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
In: week-0 security fix (knowledge scope leaks), foundation PLAN docs, a core vertical slice (drafter, plain preview,
edit-by-chat, sample-data test in a plain Workflows tab), then the 5-area Workspace + Admin console, playbooks, company
facts, agent versions, evals, then live workflows (engine, webhook/API triggers, publish/activate/rollback) and a managed
pilot in PGN's AWS account. Paperclip retirement moves to January 2027. Out until 2027: AI teams, visual canvas,
Developer Studio, outcome packs, customer-built integrations. Full detail: [blueprint v2](blueprint.md).

## 3. Current status and current source commit
Planning only. No product code changed. Observed against `origin/development` at `d1d3a66` on 2026-10-23.
This is source evidence, not deployment evidence; nothing is deployed.

## 4. Source of truth
| Concern | Authority | Use it for |
|---|---|---|
| Plan and decisions | [blueprint v2](blueprint.md) | Owner decisions (grills Q1 to Q80), journeys, cycles, acceptance criteria |
| Approved work | [backlog](backlog.md) | The only approved execution queue (NZR-n IDs; Plane mirrors it after the owner's yes) |
| What each step must do | [stories](stories/README.md) | One user story per backlog item in the owner's template, plus plan story US-000 |
| Foundation docs | [PRD](foundation/PRD.md), [CONSTRAINTS](foundation/CONSTRAINTS.md), [ARCHITECTURE](foundation/ARCHITECTURE.md), [DATA-MODEL](foundation/DATA-MODEL.md), [SECURITY](foundation/SECURITY.md), [DEPLOY](foundation/DEPLOY.md), [design](foundation/design.md) | The bar, the system, the threats, the deploy path, the screens and mocks |
| Volatile state | [HANDOFF](HANDOFF.md) | Branch, next action, open owner items |

## 5. Cycles
| Cycle | Dates | Exit gate |
|---|---|---|
| C0 Week 0 | 2026-10-20 → 2026-11-01 | Docs PR ready; security red tests frozen; factory routing logged |
| C1 Foundations | 2026-10-27 → 2026-11-09 | Nov 9 gate + fixed re-plan; AWS account usable |
| C2a Core slice | 2026-11-10 → 2026-11-23 | Golden workflow end to end; drafter ≥ 70% (kill rule) |
| C2b Workspace + testers | 2026-11-24 → 2026-12-07 | ≥ 4 of 5 testers unaided in ≤ 20 min |
| C3 Live + pilot | 2026-12-08 → 2026-12-31 | Design partner live run + paid pilot or LOI |
| January 2027 | 2027-01-04 → 2027-01-29 | Paperclip retired |

Points per cycle and the cut order are in the [backlog](backlog.md).

## 6. How work is executed
Work runs through the VPS Gauntlet Loop (owner decision Q59; `engdept` is parked): frozen failing tests before code,
Codex builds, a fresh Claude critic checks, review depth per risk tier (Q68), evidence per step. The builder never
certifies its own work. NVIDIA roles join only after the owner says yes to NVIDIA's terms and they pass a bake-off.
Jev gives a first-pass route recommendation and can fail a pass, never pass a red gate. Every merge, push, PR, deploy,
new dependency and spend over the cap needs the owner's yes.
