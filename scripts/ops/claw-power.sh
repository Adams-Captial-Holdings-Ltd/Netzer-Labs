#!/usr/bin/env bash
#
# claw-power.sh — pause / wake Netzar OS Enterprise (CCE) prod to save money
# between demos. Phase A ("works today, no new infra") of the demo pause/wake
# system. See handoff/pause-system-build-plan-*.md.
#
# Subcommands:
#   status            read-only; show current power state (safe to run anytime)
#   pause             scale Fargate to 0 + freeze AI spend (Bedrock + nightly
#                     consolidation). Saves the Fargate + background-Bedrock cost.
#   wake              restore Fargate + unfreeze, then wait until healthy.
#
# Flags:
#   --dry-run         print the mutating AWS calls instead of running them
#   --yes             skip the confirmation prompt (for automation)
#   -h | --help       this help
#
# What pause does (all reversible by wake):
#   1. bedrock_global            kill switch ON   (hard stop, enforced by the
#                                                  Phase-0 guardedBedrockSend)
#   2. memory_consolidation_disabled  ON          (the worker checks this)
#   3. ConsolidationSchedule rule  DISABLED        (no nightly one-shot spawns)
#   4. autoscaling min/max        -> 0 / 0         (stop the floor bouncing back)
#   5. desired count              -> 0             (drain the tasks)
#
# Notes:
#   - Switch writes here are raw DynamoDB PutItems (propagate within the 30s
#     kill-switch cache TTL). The Phase-B phone-button Lambda uses the
#     setKillSwitch() SNS-invalidation variant for *immediate* stream teardown.
#   - The durable lock/marker, alarm muting, and the deep NAT cut are Phase B-D.
#   - The front door (ALB, CloudFront, DNS, DynamoDB, S3) is never touched.
#
set -euo pipefail

REGION="${CCE_REGION:-us-east-1}"
CLUSTER="${CCE_CLUSTER:-claudeclaw-cluster}"
SERVICE="${CCE_SERVICE:-claudeclaw-service}"
RES_ID="service/${CLUSTER}/${SERVICE}"
DIM="ecs:service:DesiredCount"
SWITCH_TABLE="${CCE_KILL_SWITCH_TABLE:-claudeclaw-kill-switches}"
WAKE_MIN="${CCE_WAKE_MIN:-3}"
WAKE_MAX="${CCE_WAKE_MAX:-20}"
WAKE_DESIRED="${CCE_WAKE_DESIRED:-3}"

DRY_RUN=0
ASSUME_YES=0

say()  { printf '%s\n' "$*"; }
warn() { printf 'WARN: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# run MUTATING aws calls through here so --dry-run can intercept them.
run() {
  if [[ "$DRY_RUN" -eq 1 ]]; then
    printf 'DRY-RUN: %s\n' "$*"
  else
    "$@"
  fi
}

aws_q() { aws "$@" --region "$REGION" --output text 2>/dev/null; }

# ── kill switch helpers ─────────────────────────────────────────────
switch_get() { # name -> True | False | None
  aws dynamodb get-item --table-name "$SWITCH_TABLE" --region "$REGION" \
    --key "{\"PK\":{\"S\":\"SWITCH#$1\"},\"SK\":{\"S\":\"STATUS\"}}" \
    --query 'Item.active.BOOL' --output text 2>/dev/null || echo "None"
}

switch_set() { # name active(true|false) reason
  local name="$1" active="$2" reason="$3"
  local now; now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  run aws dynamodb put-item --table-name "$SWITCH_TABLE" --region "$REGION" \
    --item "{\"PK\":{\"S\":\"SWITCH#${name}\"},\"SK\":{\"S\":\"STATUS\"},\"active\":{\"BOOL\":${active}},\"setBy\":{\"S\":\"claw-power.sh\"},\"setAt\":{\"S\":\"${now}\"},\"reason\":{\"S\":\"${reason}\"}}"
}

# ── consolidation schedule helpers (best-effort discovery) ──────────
consolidation_rule() {
  aws events list-rules --region "$REGION" \
    --query "Rules[?contains(Name, 'Consolidation') || contains(Name, 'consolidation')].Name | [0]" \
    --output text 2>/dev/null || echo "None"
}

# ── confirmation ────────────────────────────────────────────────────
confirm() {
  [[ "$ASSUME_YES" -eq 1 || "$DRY_RUN" -eq 1 ]] && return 0
  printf '%s [y/N] ' "$1"
  local ans; read -r ans
  [[ "$ans" == "y" || "$ans" == "Y" ]]
}

# ── status ──────────────────────────────────────────────────────────
cmd_status() {
  local desired running svc_status min max bg mcd rule rule_state
  read -r svc_status desired running < <(
    aws_q ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
      --query 'services[0].[status,desiredCount,runningCount]' || echo "? ? ?"
  )
  read -r min max < <(
    aws_q application-autoscaling describe-scalable-targets --service-namespace ecs \
      --resource-ids "$RES_ID" \
      --query 'ScalableTargets[0].[MinCapacity,MaxCapacity]' || echo "? ?"
  )
  bg="$(switch_get bedrock_global)"
  mcd="$(switch_get memory_consolidation_disabled)"
  rule="$(consolidation_rule)"
  if [[ "$rule" != "None" && -n "$rule" ]]; then
    rule_state="$(aws_q events describe-rule --name "$rule" --query 'State' || echo '?')"
  else
    rule_state="(rule not found)"
  fi

  local mode="AWAKE"
  if [[ "${desired:-0}" == "0" && "$bg" == "True" ]]; then mode="PAUSED"; fi
  if { [[ "${desired:-0}" == "0" ]] || [[ "$bg" == "True" ]]; } && [[ "$mode" == "AWAKE" ]]; then
    mode="PARTIAL"
  fi

  say "Netzar OS Enterprise power state"
  say "  region/cluster/service : ${REGION} / ${CLUSTER} / ${SERVICE}"
  say "  mode                   : ${mode}"
  say "  ecs service            : status=${svc_status:-?} desired=${desired:-?} running=${running:-?}"
  say "  autoscaling bounds     : min=${min:-?} max=${max:-?}"
  say "  bedrock_global         : ${bg}   (True = AI hard-stopped)"
  say "  memory_consolidation   : ${mcd}   (True = nightly consolidation off)"
  say "  consolidation rule     : ${rule:-?} -> ${rule_state}"
}

# ── pause ───────────────────────────────────────────────────────────
cmd_pause() {
  confirm "Pause CCE prod (scale Fargate to 0 + freeze AI spend)?" || die "aborted."
  say "Pausing CCE..."

  say " - bedrock_global ON"
  switch_set bedrock_global true "demo pause via claw-power.sh"
  say " - memory_consolidation_disabled ON"
  switch_set memory_consolidation_disabled true "demo pause via claw-power.sh"

  local rule; rule="$(consolidation_rule)"
  if [[ "$rule" != "None" && -n "$rule" ]]; then
    say " - disable consolidation rule: $rule"
    run aws events disable-rule --name "$rule" --region "$REGION"
  else
    warn "consolidation rule not found; relying on the switch + Phase-0 guard"
  fi

  say " - autoscaling min/max -> 0/0"
  run aws application-autoscaling register-scalable-target --service-namespace ecs \
    --resource-id "$RES_ID" --scalable-dimension "$DIM" \
    --min-capacity 0 --max-capacity 0 --region "$REGION"

  say " - desired count -> 0 (draining)"
  run aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" \
    --desired-count 0 --region "$REGION" >/dev/null

  say "Paused. Run '$0 status' to confirm; '$0 wake' to bring it back."
}

# ── wake ────────────────────────────────────────────────────────────
cmd_wake() {
  confirm "Wake CCE prod (restore Fargate to ${WAKE_DESIRED} + unfreeze)?" || die "aborted."
  say "Waking CCE..."

  say " - autoscaling min/max -> ${WAKE_MIN}/${WAKE_MAX}"
  run aws application-autoscaling register-scalable-target --service-namespace ecs \
    --resource-id "$RES_ID" --scalable-dimension "$DIM" \
    --min-capacity "$WAKE_MIN" --max-capacity "$WAKE_MAX" --region "$REGION"

  say " - desired count -> ${WAKE_DESIRED}"
  run aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" \
    --desired-count "$WAKE_DESIRED" --region "$REGION" >/dev/null

  local rule; rule="$(consolidation_rule)"
  if [[ "$rule" != "None" && -n "$rule" ]]; then
    say " - enable consolidation rule: $rule"
    run aws events enable-rule --name "$rule" --region "$REGION"
  fi

  say " - bedrock_global OFF"
  switch_set bedrock_global false "demo wake via claw-power.sh"
  say " - memory_consolidation_disabled OFF"
  switch_set memory_consolidation_disabled false "demo wake via claw-power.sh"

  if [[ "$DRY_RUN" -eq 0 ]]; then
    say " - waiting for tasks to reach steady state..."
    aws ecs wait services-stable --cluster "$CLUSTER" --service "$SERVICE" --region "$REGION" \
      && say "Awake and healthy." || warn "wait timed out; check '$0 status'"
  else
    say "DRY-RUN: would wait for services-stable"
  fi
}

usage() { sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'; }

main() {
  local cmd="${1:-}"; shift || true
  for arg in "$@"; do
    case "$arg" in
      --dry-run) DRY_RUN=1 ;;
      --yes)     ASSUME_YES=1 ;;
      -h|--help) usage; exit 0 ;;
      *) die "unknown flag: $arg" ;;
    esac
  done
  command -v aws >/dev/null || die "aws CLI not found on PATH"
  case "$cmd" in
    status) cmd_status ;;
    pause)  cmd_pause ;;
    wake)   cmd_wake ;;
    -h|--help|"") usage ;;
    *) die "unknown subcommand: $cmd (try: status | pause | wake)" ;;
  esac
}

main "$@"
