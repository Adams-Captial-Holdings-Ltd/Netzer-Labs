---
feature: netzar-studio
document_role: decision
status: draft
observed_at: 2026-10-23
as_of_commit: d1d3a66970cd548f9529a234ef2b51ecdc29378e
---

# Netzar Studio rebuild: constraints (the quality bar)

> The bar every step is judged against, written as numbers or named ratchets. The fresh critic checks these on every step.
> Sources: PRD section 5.2 (NFR-001 to NFR-010), [blueprint v2](../blueprint.md), owner grill Q46 to Q80. Observed 2026-10-23 against `origin/development` `d1d3a66`.

## 1. Product performance (PRD NFRs, measured locally until the AWS account exists)

| ID | Constraint | Number | Measured by | From |
|---|---|---|---|---|
| C-01 | Home interactive | <= 3 s p95, reference workload: 1 user, 20 agents, 50 workflows, local install | Playwright timing, 20 runs | NFR-001 |
| C-02 | Conversation acknowledgement | visible ack or progress <= 3 s p95 | Playwright timing on describe + chat | NFR-002 |
| C-03 | Basic workflow generation | valid draft or actionable explanation <= 45 s p95 on the 30-case eval set | live eval timings | NFR-003 |
| C-04 | Drafter quality, target | >= 80% of 30 cases schema-valid in <= 3 clarifying questions | live eval (NZR-30) | blueprint 7.1 |
| C-05 | Drafter quality, kill line | < 70% at the Nov 23 gate stops UI work | live eval | Q72 |
| C-06 | Drafter ratchet | a drafter change may not lower the stored pass rate; result file hashes (drafter files, dataset, model) must match | CI check (NZR-30) | Q66 |
| C-07 | Production reach | blocked until the drafter score is re-measured on Bedrock | DEPLOY gate | Q58 |

## 2. Safety and security

| ID | Constraint | Number | Measured by | From |
|---|---|---|---|---|
| C-10 | Unauthorized actions | 0 successful in the security test set | permission tests | NFR-007 |
| C-11 | Cross-scope / cross-user retrieval | 0 in permission tests on every `/vectors*` route and chat file path | NZR-5, NZR-6 tests | NFR-010, FR-012 |
| C-12 | External writes during a sample test | 0, asserted in tests | NZR-26 tests | FR-005, AC-005 |
| C-13 | Duplicate external effects | 0 in fault-injection tests; idempotency key required on every trigger | NZR-34, NZR-35 tests | NFR-008, AC-026 |
| C-14 | Secrets | 0 findings from `node scripts/ci/secret-scan.mjs`; no `.env` in the builder clone | CI + NZR-3 | security floor |
| C-15 | Dependencies | no new runtime dependency without the owner's yes; installs from the lockfile only (`npm ci`) | review + `git diff package-lock.json` | Q78 |
| C-16 | Model data | NVIDIA dev backend gets seeded test data only; no repo code to NVIDIA until the owner's yes on its terms | runbook + routing log | Q65 |
| C-17 | Product events | no personal data in any product event | OBSERVABILITY review | Q55 |
| C-18 | Mocks and tests | seeded sample data only, never customer data | review | Q77, Q67 |

## 3. Accessibility and readability (Workspace; Admin console keeps today's density)

| ID | Constraint | Number | Measured by | From |
|---|---|---|---|---|
| C-20 | Standard | WCAG 2.2 AA on primary journeys | axe + manual keyboard pass | NFR-005 |
| C-21 | Automated a11y | axe: 0 serious, 0 critical on Workspace pages | Playwright + axe in CI (NZR-20) | blueprint 7.5 |
| C-22 | Body text | >= 18px in the Workspace | axe/computed-style check | Q6/Q35 |
| C-23 | Touch targets | >= 44 x 44 px | computed-style check | blueprint 7.5 |
| C-24 | Motion | `prefers-reduced-motion` disables animation; no function depends on motion | Playwright with reduced motion | NZR-17 |
| C-25 | Colour scheme | light mode required; dark mode not required for MVP (revisit trigger: an owner or tester request) | design.md | Q77 |
| C-26 | Viewports | desktop 1440 x 900 only (Q108) | mock + e2e screenshots | Q49 |

## 4. Usability (people, not machines)

| ID | Constraint | Number | From |
|---|---|---|---|
| C-30 | Testers | >= 4 of 5 non-technical testers build + test the golden workflow unaided in <= 20 min | blueprint 7.4 |
| C-31 | First run | new user completes the welcome in < 5 min | NZR-21 |
| C-32 | Explainability | testers can explain what the previewed workflow does (4 of 5) | blueprint 7.2 |
| C-33 | Clarifying questions | <= 3 per draft | blueprint 7.1 |

## 5. Engineering bar

| ID | Constraint | Number | From |
|---|---|---|---|
| C-40 | Existing tests | full `npm test` green; 4,634+ unit tests at baseline, never fewer without a recorded reason | blueprint 7.6 |
| C-41 | Red first | every code step commits a failing test before production code and records the red SHA | gauntlet SPECIFICATION |
| C-42 | Docs CI | `feature-knowledge.mjs`, `docs-links.mjs`, `runnable-blocks.mjs`, mermaid render, `docs-assets.mjs` green | repo Docs CI |
| C-43 | Assets | no docs file > 2 MB; `docs/assets/` total <= 15 MB; every screenshot has a provenance sidecar | `docs/assets/README.md` |
| C-44 | Nav sync | Sidebar `NAV_ITEMS`, `App.tsx` routes and Jarvis `ROUTE_TABLE` change together; nav manifest tests pass | CLAUDE.md |
| C-45 | Route diagrams | `handler.ts` route changes update the `docs/diagrams.map` diagram | CI gate |
| C-46 | Data changes | expand/contract, forward-only, rollback path per change | DATA-MODEL |
| C-47 | Review | per tier (Q68); builder never certifies its own work; Codex reviews only code someone else built | Q51, Q68 |
| C-48 | Consent | every merge, push, PR, deploy, third-party code send and spend over cap needs the owner's yes | Q50, Q80 |

## 6. Scale, cost and capacity

| ID | Constraint | Number | From |
|---|---|---|---|
| C-50 | Install size | <= 50 users, about 1,000 runs/day per install; serverless pieces, no dead ends | Q15 |
| C-51 | Factory spend | cap $250, alert at $125 | Q33 |
| C-52 | Greptile | 50-credit ledger: warn 35, stop 45; one pass per T3 step only | NZR-41, Q68 |
| C-53 | Pilot running cost | T0 tier about $65 to $95/month (`docs/cost-guide.md`) | AGENTS.md |
| C-54 | Model spend | configured model and execution spending limits enforced | NFR-009 |
| C-55 | VPS | one build lane; Playwright serial; installs one at a time (3.9 GB RAM); resize to 8 GB before two lanes | Q69, Q78 |

## 7. Never

- Never weaken or delete a check to make a gate pass.
- Never send customer production data to the pilot, the NVIDIA backend, a mock or a test.
- Never deploy, push, merge or open a PR without the owner's yes for that specific action.
- Never run `npm run destroy` unless the owner asks.
