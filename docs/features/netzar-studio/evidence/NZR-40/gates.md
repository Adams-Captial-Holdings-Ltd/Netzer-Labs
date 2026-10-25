# NZR-40 gate summary (runner)

```
Story: NZR-40   HEAD: c31844ac2a9c18685c708be8737f38ec81cd8809
G1 code review : PASS  reviewer=claude-opus fresh critic session=f6694a9f-a591-4b12-b269-51e7bc6a0bb5 findings=1/12 open_low=11 greptile=GR:PASS
GR greptile    : PASS confidence=5 comments=0 plus=False
G2 unit tests  : PASS        red=c70fef8 green=c31844a counts=4779/4779 story_files=11/11 typecheck=ok
G2b integration: PENDING run=- (not in runner scope yet, Goal v1)
G3 UAT         : PASS scenarios=8/8 pending_owner=0 accepted_by=owner (Telegram) date=2026-10-25
G4 E2E         : PASS run=docs/features/netzar-studio/evidence/NZR-40/e2e-run.txt counts=7/7
G5 Opik eval   : N/A     experiment=- (not in runner scope yet, Goal v1)
Lessons checked: L-001,L-002,L-003,L-004,L-005,L-006,L-007,L-008,L-009,L-010,L-011,L-012,L-013,L-014,L-015,L-016,L-017,L-018,L-019   New lessons: L-018, L-019
```

## G1 open non-blocking findings

- [low] nvidia critic without consent gets no_nvidia_consent + 'LAYER: L3 NOT RUN' instead of critic_not_claude (route-guard.mjs:88-93 runs before :99).
- [low] decide({log, consent, ...flags}) lets --log/--consent overwrite parsed inputs (route-guard.mjs:146); fails closed today but fragile. Pass named fields.
- [low] --slug unsanitized in default log path (route-guard.mjs:20); ../ can write outside ~/.claude/plans.
- [low] Doc edits (SKILL.md section + amendments, review-gauntlet.md L3, hermes-adaptation.md) not applied and helper not installed to /root/.claude/bin; required before DoD.
- [info] Helper/test are repo vitest .ts, not /root/.claude/bin node:test .mjs as the story says; update story test refs at exit gate.
- [info] Scenario 8 JEV_SH stub unused since route-guard does not call jev.sh; advisor/MISSING behaviour covered.
- [info] Jev records written to routes.jsonl as kind:'jev', outside the route-line schema; counting tools must filter on result.
- [info] No validation of numeric --confidence, consent file mode 600, or owner_text length; tsc, e2e script and full npm test not run.
- [info] New refusal reason builder_was_critic is not in the story's route-log reason enum; add at exit gate.
- [info] Stale recovery guard (>30s) is removed unguarded (route-guard.mjs:45); concurrent cleanup after a crash mid-recovery can reopen the double-delete race. Documented shortcut.
- [info] Previous medium (order-dependent builder/critic separation) is FIXED at route-guard.mjs:105-107 with a test.

## G2 story test files

- `scripts/factory/route-guard/route-guard.test.ts`

Raw outputs: `/root/.hermes/netzar-runner/runs/NZR-40/` on the runner host (not in git).
