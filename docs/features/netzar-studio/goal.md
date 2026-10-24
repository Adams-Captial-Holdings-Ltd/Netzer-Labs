---
feature: netzar-studio
document_role: process
status: accepted
observed_at: 2026-10-24
---

# Goal v1: Netzar workflow rebuild through the gauntlet loop

Owner instruction, 2026-10-24. The full text is below, verbatim. This first section says how it maps onto what already exists, so nothing is duplicated.

## How this maps onto the existing process

| Goal requirement | Where it lives | Status |
|---|---|---|
| `/goal` | Hermes `/goal`: a loop that keeps working until a judge agrees the goal text is met (`hermes_cli` goal manager). It drives the run; it does not replace the gauntlet. | exists |
| `/gauntlet-loop` | Claude Code skill `~/.claude/skills/gauntlet-loop` (VPS copy, 2026-10-22) plus the `engdept` coordinator. The Hermes copy is older and is synced from the Claude copy. | exists, Hermes copy stale |
| Per-step cycle (inspect … gate) | [Story exit gate](story-exit-gate.md) G1 code review, G2 unit, G3 UAT, G4 E2E. Goal adds **G2b integration** and **G5 Opik eval** (where the story has AI behaviour). | gates extended by this goal |
| Traceability: epic → story → criteria → task → step → tests → eval → status | Stories in [stories/](stories/README.md) plus Plane NZR. New: a generated `TRACE.md` matrix, CI-checked (NZR-51). | new |
| Layered review | gauntlet-loop `references/review-gauntlet.md`: L0 local checks, Kodus, CodeRabbit, NVIDIA roles, repair loop, one final Greptile pass. | exists, wiring is NZR-41 |
| Opik | `references/agent-evals.md` + `gauntlet-evals.mjs` for gauntlet events; Netzar's own agent evals via NZR-14/30. Opik login verified on the VPS. Scores never replace tests or owner UAT. | partly exists, NZR-52 |
| Retrospective agent | New role (NZR-53): runs at the end of each gauntlet cycle, writes [LESSONS.md](LESSONS.md) entries with guards and a handoff backlog. | new |
| Prerequisite readiness report | NZR-50. | new |

Order of work: factory blockers (NZR-1, NZR-2) first, because no builder touches Netzer-Labs before they pass; then NZR-50 readiness; then stories in the backlog's cycle order, each through the extended exit gate.

Unchanged owner rules still apply: no push, PR, deploy, new dependency, spend or secrets without the owner's yes; the builder never certifies its own work; owner UAT stays PENDING until the owner gives it.

---

# /goal — Complete Netzar Workflow Rebuild, Gauntlet Loop Validation, Automated Testing, and Continuous Improvement

## Role and Mission

Act as a **Principal Software Architect, Senior Full-Stack Engineer, QA Automation Lead, DevOps Engineer, and AI Agent Orchestration Specialist**.

Your mission is to fully audit, rebuild, implement, test, evaluate, and production-harden the entire **Netzar workflow**, including every stage of `/gauntlet-loop`.

This is an **end-to-end implementation and verification task**, not simply a planning exercise.

Work systematically, using the existing codebase, architecture, user stories, workflows, and project conventions as the source of truth.

**Primary objective:** Deliver a complete, maintainable, scalable, well-tested Netzar implementation with traceable user stories, automated quality gates, Opik evaluations, and a dedicated retrospective handoff agent that continuously identifies and prevents recurring engineering mistakes.

---

## PHASE 1 — Repository Audit and Prerequisite Verification

Before modifying code:

1. Inspect the entire relevant Netzar repository, architecture, dependencies, workflows, configurations, and existing documentation.
2. Discover and inspect the actual implementations and definitions of `/goal` and `/gauntlet-loop`. Do not invent their behavior.
3. Identify all existing user stories, tasks, agents, orchestration components, and acceptance criteria.
4. Audit the current state of Unit, Integration, UAT, E2E, regression, performance, and security testing.
5. Verify that all tools required for code review, test execution, debugging, CI/CD validation, observability, and Opik evaluation are available and correctly configured.
6. Detect missing dependencies, misconfigurations, permissions, integration failures, and technical debt.

Install or configure missing prerequisites when supported and authorized. If access, credentials, or permissions are unavailable, clearly document the blocker rather than pretending the prerequisite is satisfied.

**Deliverable:** A prerequisite readiness report identifying existing capabilities, missing requirements, implementation risks, and remediation actions.

## PHASE 2 — Rebuild and Synchronize User Stories

Build a comprehensive traceability system connecting:

**Epic → User Story → Acceptance Criteria → Task → Gauntlet Step → Implementation → Unit Tests → Integration Tests → UAT → E2E Tests → Opik Evaluation → Completion Status**

For every user story:

- Break requirements into small, independently verifiable tasks.
- Define measurable acceptance criteria and expected outcomes.
- Establish dependencies and execution order.
- Associate every task with the appropriate `/gauntlet-loop` stage.
- Create test cases covering successful paths, edge cases, negative paths, and failure recovery.
- Identify the required performance, reliability, and security constraints.
- Track implementation status and evidence of successful completion.

Update the relevant user stories immediately after each completed Gauntlet step, including test results, discovered defects, fixes, remaining risks, and evaluation outcomes.

Maintain bidirectional traceability so that changes to implementation or tests are reflected in the associated user stories.

## PHASE 3 — Rebuild and Execute the Entire /gauntlet-loop

Inspect every existing `/gauntlet-loop` stage and fully rebuild, correct, or enhance it where necessary.

For **every Gauntlet step**, execute this mandatory engineering cycle:

1. **Inspect:** Analyze the current implementation, dependencies, and expected behavior.
2. **Validate:** Confirm alignment with user stories and acceptance criteria.
3. **Implement:** Complete the required functionality using existing architecture and conventions.
4. **Review:** Perform code review, static analysis, linting, type checks, and relevant security checks.
5. **Unit Test:** Verify individual functions, components, and business rules.
6. **Integration Test:** Verify interactions between services, APIs, databases, agents, and external dependencies.
7. **UAT:** Execute user-acceptance scenarios against the documented acceptance criteria.
8. **E2E Test:** Validate complete user journeys and workflow execution from entry point to final outcome.
9. **Evaluate:** Record results, defects, quality metrics, and relevant evaluation evidence in Opik.
10. **Remediate:** Diagnose failures, correct their root causes, and add regression coverage.
11. **Retest:** Rerun impacted tests and quality gates after each correction.
12. **Synchronize:** Update user stories, task statuses, acceptance evidence, and workflow documentation.
13. **Gate:** Advance to the next stage only when mandatory automated checks pass and required acceptance evidence is present.

If a Gauntlet step fails, enter a controlled **diagnose → reproduce → correct → retest → reevaluate** loop.

Do not bypass failed checks, delete failing tests to obtain a passing result, or mark incomplete work as completed.

Human UAT approval must remain pending until explicitly provided when required.

## PHASE 4 — Production-Grade Engineering Standards

Apply rigorous code-quality requirements across the entire Netzar workflow.

Prioritize:

- **Simplicity:** Avoid unnecessary abstraction, premature optimization, excessive dependencies, and overengineered architecture.
- **Maintainability:** Use readable, modular, cohesive code with clear ownership and responsibilities.
- **Reliability:** Implement correct error handling, validation, retries with limits, timeouts, idempotency where needed, and safe failure recovery.
- **Scalability:** Identify bottlenecks, concurrency risks, resource leaks, and expensive operations. Validate meaningful performance expectations.
- **Security:** Review authentication, authorization, secrets handling, input validation, dependency risks, and data protection.
- **Observability:** Provide actionable structured logging, metrics, tracing, and meaningful error reporting.
- **Testability:** Keep business logic independently testable and eliminate fragile hidden dependencies.

Do not introduce placeholder production logic, unsupported assumptions, cosmetic fixes that conceal defects, or unnecessary architectural complexity.

Prefer the smallest robust solution that satisfies requirements and is consistent with the existing system.

Do not perform destructive data operations or production deployments without explicit authorization.

## PHASE 5 — Opik Evaluation and Continuous Quality Feedback

Integrate **Opik** into the applicable Gauntlet evaluation and agent execution workflows.

For each applicable stage:

1. Capture execution traces, inputs, outputs, exceptions, and relevant metadata.
2. Establish reusable evaluation datasets and baseline results.
3. Evaluate functional correctness, task completion, reliability, error handling, and quality of AI-agent behavior where applicable.
4. Track regressions against previous successful evaluations.
5. Classify recurring errors by root cause, severity, and affected user stories.
6. Connect evaluation failures to corrective implementation tasks.
7. Rerun evaluations after fixes and preserve before/after evidence.
8. Track evaluation trends to identify systemic workflow and engineering problems.

Do not treat Opik scores alone as proof that deterministic software tests or human acceptance requirements have passed.

## PHASE 6 — Create a Retrospective Handoff Agent

Create and configure a dedicated **Netzar Retrospective & Engineering Quality Agent**.

This agent must operate at the completion of each Gauntlet cycle and support a final project-level retrospective.

### Responsibilities

Review:

- What worked successfully and why.
- What failed, where it failed, and the underlying root cause.
- Which implementation decisions introduced unnecessary complexity.
- Which shortcuts or weak coding patterns created reliability or scalability risks.
- Which tests failed, were flaky, or exposed insufficient coverage.
- Which user stories remain incomplete or insufficiently validated.
- Which Opik evaluations identified recurring weaknesses.
- Which problems could reappear in production.

### Required outputs

Generate a structured retrospective containing:

- Successful engineering patterns worth preserving.
- Failure analysis and root-cause evidence.
- Technical debt and maintainability findings.
- Corrective actions prioritized by impact and severity.
- Regression tests required to prevent recurrence.
- Recommended changes to Gauntlet instructions, test coverage, and quality gates.
- Updated Opik evaluation records and future evaluation cases.
- A clearly assigned handoff backlog with acceptance criteria.

Where supported, create a feedback loop:

**Gauntlet Execution → Testing → Opik Evaluation → Retrospective Agent → Root-Cause Remediation → Regression Testing → Updated User Stories → Next Gauntlet Execution**

The retrospective agent must produce actionable, evidence-backed findings rather than generic summaries.

## PHASE 7 — Final Validation and Completion Criteria

The workflow is not considered fully complete until:

- Every in-scope `/gauntlet-loop` stage has been inspected, rebuilt where necessary, and evaluated.
- All in-scope user stories have implementation and acceptance-criteria traceability.
- Required Unit, Integration, UAT, E2E, regression, and relevant security/performance checks have been executed.
- Critical and high-severity defects have been resolved or explicitly documented as release blockers.
- Opik evaluation integration has been verified with actual recorded results.
- The retrospective handoff agent has been implemented and tested.
- Relevant documentation and operational runbooks have been updated.
- No unresolved release-blocking issues are hidden behind passing status labels.
- Production readiness has been assessed with supporting evidence.

If any condition cannot be met, report the exact blocker and mark the relevant component as incomplete.

## PHASE 8 — Final Engineering Handoff

Produce a final report containing:

1. **Implementation Summary:** What was built, rebuilt, fixed, and validated.
2. **Prerequisite Readiness:** Verified tools, dependencies, and outstanding access blockers.
3. **Gauntlet Execution Matrix:** Every stage, associated stories, test outcomes, evaluation results, and completion status.
4. **Test Evidence:** Executed test suites, pass/fail counts, commands, and relevant evidence references.
5. **Opik Evaluation Summary:** Baselines, scores, identified errors, and changes after remediation.
6. **Code Quality Findings:** Complexity, maintainability, security, performance, and scalability concerns.
7. **Retrospective Agent Handoff:** Findings, recommendations, and corrective-action backlog.
8. **Production Readiness Assessment:** Verified release gates, unresolved risks, and next actions.

## Execution Rules

**Do not stop after generating a plan. Execute the work.**

First inspect the actual repository and available environment. Establish the baseline, then implement and verify the workflow incrementally.

Work autonomously on tasks supported by the available tools and permissions. Ask for intervention only when an essential external dependency, credential, permission, or decision prevents safe progress.

After every completed Gauntlet stage, update the relevant user stories and evaluation evidence before advancing.

Do not claim tests passed without executing them. Do not claim integrations are configured without verification. Do not claim production readiness without evidence.

**Final success condition:** Netzar has a fully traceable, rigorously evaluated, maintainable, production-ready workflow in which every Gauntlet stage is verified, every user story is tested, recurring mistakes feed back into engineering improvements, and the retrospective agent continuously strengthens overall software quality.