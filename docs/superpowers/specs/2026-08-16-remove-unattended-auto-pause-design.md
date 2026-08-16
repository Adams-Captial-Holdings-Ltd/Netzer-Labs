# Remove Unattended Auto-Pause Design

**Status:** Approved; pending implementation  
**Date:** 2026-08-16

## Goal

Production and staging must stay running unless an authenticated operator
manually pauses them. A normal deployment must not create or enable any
unattended path that sets ECS desired count or autoscaling bounds to zero.

## Current cause

`PowerSwitchStack` creates an EventBridge Scheduler schedule that directly
invokes the PowerSwitch Lambda with `action: auto-pause`. The handler routes
that event to the same pause routine used by the manual control, which sets the
autoscaling target to `0/0` and ECS desired count to `0`.

Production's live schedule is manually disabled, but its deployed
CloudFormation template has no `State`, so a normal deployment can re-enable
it. Staging's template is disabled today, but current source can arm it through
`CCE_POWER_AUTO_PAUSE_ENABLED=1`.

The caller audit found no other legitimate non-HTTP PowerSwitch callers:

- Repository wiring contains one direct-event contract,
  `cce.power.scheduler` / `auto-pause`.
- Both live Lambdas have zero event-source mappings and zero EventBridge rule
  targets.
- Their resource policies permit invocation only through the Function URL.
- The only Scheduler targets for the two Lambdas are their disabled
  auto-pause schedules.

## Design

Remove unattended auto-pause as a capability:

- Delete the PowerSwitch `AWS::Scheduler::Schedule`, its Scheduler invocation
  role, and the Lambda invocation grant.
- Delete `CCE_POWER_AUTO_PAUSE_ENABLED`, `autoPauseEnabled`, and the scheduled
  `auto-pause` event contract.
- Make non-HTTP PowerSwitch invocations return an unsupported-event error.
- Preserve the token-gated Function URL and manual `pause`, `wake`, `status`,
  `hold`, and `costs` routes unchanged.

This change does not alter other Scheduler resources, ECS/Cloudflare
architecture, capacities, monitoring, alarms, CI/CD, or the manual
power-switch operations.

## Repository path

Implement the removal on `development`, promote the same focused change to
`qa`, and use isolated target-specific backports for `staging` and
`production`. Do not merge PR #61 or #68 to obtain the fix. Deploy staging
first. Production remains approval-gated after the final diff and staging
evidence are shown.

## Verification

- Targeted PowerSwitch tests and synth prove the PowerSwitch stack contains no
  auto-pause `AWS::Scheduler::Schedule`, Scheduler principal, or scheduled
  event payload. Unrelated application schedules remain untouched.
- Repository search finds no `CCE_POWER_AUTO_PAUSE_ENABLED`,
  `autoPauseEnabled`, or `cce.power.scheduler` implementation path.
- Production and staging compute synths retain non-zero minimum capacity and
  the `cloudflared` task-definition container.
- After staging deployment, its auto-pause schedule is absent; ECS remains at
  its intended non-zero desired/running count and minimum capacity, and its
  active task definition still contains `cloudflared`.
- Before any production mutation, present the final files/lines, behavior,
  targeted synth results, staging evidence, and exact deployment sequence for
  explicit approval. The production deployment must remove only the
  PowerSwitch auto-pause resources and leave ECS capacity/task definition
  unchanged.

## Non-goals

No monitoring, alarm, Cloudflare, ALB, HA, CI/CD, build, cost-control,
observability, secrets, or documentation-system redesign is part of this
change.
