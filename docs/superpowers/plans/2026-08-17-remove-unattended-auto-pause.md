# Remove Unattended Auto-Pause Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the PowerSwitch unattended auto-pause capability while preserving authenticated manual pause, wake, status, hold, and costs.

**Architecture:** Remove the PowerSwitch Scheduler resource, its invocation role/grant, all arming configuration, and the Lambda direct-event route. Keep the Function URL control plane and every unrelated application schedule unchanged.

**Tech Stack:** TypeScript, AWS CDK, Node.js Lambda, Vitest

## Global Constraints

- Production and staging must have zero PowerSwitch auto-pause schedules; unrelated Scheduler resources remain untouched.
- Remove `CCE_POWER_AUTO_PAUSE_ENABLED`, `autoPauseEnabled`, and `cce.power.scheduler`.
- Reject every non-HTTP PowerSwitch invocation; the caller audit found no legitimate non-HTTP caller except auto-pause.
- Preserve authenticated manual `pause`, `wake`, `status`, `hold`, and `costs` behavior.
- Do not change Cloudflare, ECS capacity, monitoring, CI/CD, secrets, or unrelated infrastructure.
- Deploy staging first; do not mutate production without explicit approval after staging evidence and the final production diff.

---

### Task 1: Remove the unattended PowerSwitch capability

**Files:**
- Modify: `infra/lib/power-switch-stack.test.ts`
- Create: `infra/lib/power-switch-handler/index.test.ts`
- Modify: `infra/lib/power-switch-stack.ts`
- Modify: `infra/lib/power-switch-handler/index.js`
- Modify: `infra/bin/app.ts`
- Modify: `.env.reference`

**Interfaces:**
- Consumes: existing `PowerSwitchStack` and exported Lambda `handler(event)`.
- Produces: a Function-URL-only PowerSwitch stack with no auto-pause Scheduler/IAM path.

- [ ] **Step 1: Write the failing synth test**

  Change the PowerSwitch assertions to require `AWS::Scheduler::Schedule` count `0`, no `scheduler.amazonaws.com` principal, and no auto-pause Lambda environment variables. Remove tests whose desired behavior is an armable schedule.

- [ ] **Step 2: Write the failing handler test**

  Invoke the real handler with `{ source: 'cce.power.scheduler', action: 'auto-pause' }` and assert the literal result:

  ```ts
  expect(result).toEqual({ ok: false, code: 400, error: 'unsupported event' });
  ```

- [ ] **Step 3: Verify RED**

  Run: `npx vitest run infra/lib/power-switch-stack.test.ts infra/lib/power-switch-handler/index.test.ts`

  Expected: the stack test finds one PowerSwitch schedule and the former Scheduler event is accepted/refused rather than rejected as unsupported.

- [ ] **Step 4: Implement the minimal deletion**

  Delete the Scheduler resource/role/grant, `autoPauseCron`, `autoPauseTimezone`, `autoPauseEnabled`, `AUTO_PAUSE_FORBIDDEN`, `doAutoPause`, and the direct-event route. Remove app/reference wiring for `CCE_POWER_AUTO_PAUSE_ENABLED`. Return this literal for non-HTTP events:

  ```js
  return { ok: false, code: 400, error: 'unsupported event' };
  ```

  Keep the status response informative with a non-configurable `autoPause: 'disabled'` value.

- [ ] **Step 5: Verify GREEN and scope**

  Run:

  ```text
  npx vitest run infra/lib/power-switch-stack.test.ts infra/lib/power-switch-handler/index.test.ts
  npm run typecheck
  rg -n "CCE_POWER_AUTO_PAUSE_ENABLED|autoPauseEnabled|cce\.power\.scheduler|AUTO_PAUSE_FORBIDDEN|AutoPauseSchedule" . --glob "!node_modules/**" --glob "!docs/superpowers/**"
  ```

  Expected: tests and typecheck pass; the search returns no implementation references.

- [ ] **Step 6: Commit**

  ```text
  git add .env.reference infra/bin/app.ts infra/lib/power-switch-stack.ts infra/lib/power-switch-stack.test.ts infra/lib/power-switch-handler/index.js infra/lib/power-switch-handler/index.test.ts
  git commit -m "fix(power): remove unattended auto-pause"
  ```

---

### Task 2: Prove environment safety without widening scope

**Files:**
- No production-code changes expected.

**Interfaces:**
- Consumes: synthesized CDK templates for production and staging.
- Produces: verification evidence for the staging-first deployment gate.

- [ ] **Step 1: Synthesize production and staging**

  Synthesize both environment shapes and inspect only the PowerSwitch auto-pause resources plus Compute capacity/task-definition outputs.

- [ ] **Step 2: Verify invariants**

  Prove both PowerSwitch stacks contain zero auto-pause schedules and no Scheduler invocation role; intended ECS minimum/desired capacity is non-zero; `cloudflared` remains in the task definition; unrelated application Scheduler resources still synthesize normally.

- [ ] **Step 3: Prepare the staging-only backport**

  Apply only the implementation commit to a short-lived branch based on `staging`; do not merge PR #68. Review the target-specific diff before any staging deployment.

