/**
 * Audit log writer — dual write to DDB + S3 audit-lock bucket.
 *
 * DDB is the hot lookup path (recent events queryable by day/agent).
 * S3 Object Lock is the cold immutable record (compliance, retention).
 *
 * Both writes are fire-and-forget from the hot path — we don't want
 * audit-log failure to block a user reply. Failures log a warning.
 */

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { ddb } from '../state/ddb.js';
import { logger } from '../../observability/logger.js';
import { isKillSwitchActive } from '../state/kill-switches-repo.js';
import { captureAwsClient } from '../observability/xray.js';
import { redactSync, refreshPiiCache } from '../pii/redact.js';

const TABLE = process.env.TABLE_AUDIT_LOG ?? 'claudeclaw-audit-log';
const region = process.env.AWS_REGION ?? 'us-east-1';

/**
 * The WORM bucket is tier-gated (T0/T1 deploys have no audit-lock bucket;
 * IaC plan item 26), so an unset/empty AUDIT_LOCK_BUCKET is a NORMAL
 * configuration, not an error: the S3 mirror no-ops cleanly with a single
 * debug-level line per process — never a warning per event, never a throw —
 * while the DDB hot path keeps writing. Read lazily (not at module load) so
 * tests and late env injection see the live value.
 */
let _noBucketLogged = false;
function auditLockBucket(): string {
  const bucket = process.env.AUDIT_LOCK_BUCKET ?? '';
  if (!bucket && !_noBucketLogged) {
    _noBucketLogged = true;
    // Defensive lookup: several unit tests double the logger with only
    // warn/info/error. A missing debug must never turn the no-op path
    // into a crash — that would defeat the whole point.
    (logger as { debug?: (msg: string) => void }).debug?.(
      'AUDIT_LOCK_BUCKET is unset (tier < 2 has no WORM bucket); S3 audit mirror disabled, DDB audit writes continue',
    );
  }
  return bucket;
}

/** Test hook: reset the once-per-process debug-log latch. */
export function _resetAuditLockBucketLogForTests(): void {
  _noBucketLogged = false;
}

let _s3: S3Client | null = null;
function s3(): S3Client {
  if (!_s3) _s3 = captureAwsClient(new S3Client({ region }));
  return _s3;
}

export interface AuditEvent {
  action:
    | 'agent_turn'
    | 'playground_run'
    | 'knowledge_answer'
    | 'knowledge_ingest'
    | 'knowledge_delete'
    | 'hive_note_logged'
    | 'tool_invoke'
    | 'memory_add'
    | 'memory_forget'
    | 'kill_switch_set'
    | 'kill_switch_blocked'
    | 'emergency_kill_phrase'
    | 'rate_limited'
    | 'rate_limit_policy_set'
    | 'rate_limit_reset'
    | 'media_upload'
    | 'data_purged'
    | 'canary_fired'
    | 'agent_file_edited'
    // v5.6: memory consolidation
    | 'memory_consolidate'
    | 'consolidation_partial_mark'
    | 'consolidation_collision'
    | 'consolidation_spawn_dedupe'
    | 'consolidation_task_failed_to_start'
    | 'consolidation_task_failed_after_running'
    | 'consolidation_daily_cap_hit'
    // v5.6: exfil guard
    | 'exfil_blocked'
    | 'exfil_payload_too_large'
    | 'exfil_budget_exceeded'
    | 'exfil_pattern_auto_disabled'
    | 'exfil_pattern_reload_rejected'
    | 'exfil_pattern_added'
    | 'exfil_pattern_removed'
    // v5.6: panic state machine
    | 'panic_triggered'
    | 'panic_restored'
    | 'panic_repaired'
    | 'panic_force_released'
    // v5.6: war room
    | 'warroom_turn'
    | 'warroom_deleted'
    | 'warroom_unauthorized_inbound_rejected'
    | 'warroom_unauthorized_abort_rejected'
    | 'warroom_unknown_inbound_type'
    | 'warroom_participant_revoked'
    | 'warroom_connection_revoked_lazy'
    | 'warroom_fanout_revalidated_newer_acl'
    | 'warroom_memory_import_authorized'
    // v5.6: extensions
    | 'extension_deployed'
    | 'extension_rejected'
    | 'extension_sha_mismatch'
    | 'extension_missing_runtime_layer'
    | 'extension_concurrency_cap_exceeded'
    // v5.6: hooks
    | 'hook_invoke_enqueued'
    | 'hook_dispatch_deduped'
    | 'hook_invoke_failed_retryable'
    | 'hook_terminal_failure'
    | 'tool_blocked_in_warroom'
    // v5.6: chaos + safety
    | 'chaos_injected'
    | 'kill_switch_blocked_v5'
    | 'cost_cap_blocked'
    // v5.6: track progress
    | 'v5_track_item_started'
    | 'v5_track_item_completed'
    // v5.7: auth + token lifecycle + guardrail
    | 'token_created'
    | 'token_revoked'
    // Owner decision 1: a token with no user linked to one person, and an admin
    // reading a conversation that is not theirs (the audited override).
    | 'token_linked'
    | 'session_read_override'
    | 'auth_failure'
    | 'guardrail_intervention'
    // Increment 2: runtime-config bridge writes.
    | 'config_updated'
    // NZR-43: a refused /api/config* request (secret, unknown or out-of-tier
    // category). Names only, never a value. Always audited.
    | 'config_access_denied'
    // NZR-5: a refused knowledge scope (dashboard routes + Jarvis vectors).
    // detail.scopeHash only, never the scope name. Always audited.
    | 'knowledge_scope_denied'
    // NZR-6: a legacy chat file moved into chat_quarantine, and an admin moving
    // one from there into a chat owner's private scope. Awaited; hashes, no names.
    | 'knowledge_quarantined'
    | 'knowledge_reassigned'
    | 'cost_cap_updated'
    // Increment 4: alert recipient management (SNS email subscriptions).
    | 'alert_recipient_added'
    | 'alert_recipient_removed'
    // v5.7: audit self-silence marker — emitted when a non-allowlisted
    // event is dropped while audit_log_disabled is active.
    | 'audit_suppressed'
    // Jarvis voice co-pilot (JARVIS-PLAN.md §5). All carry surface:'dashboard'
    // + detail.origin:'jarvis'. session_start + session_killed are always-audited
    // (an attacker tripping audit_log_disabled must not hide that a Jarvis session
    // opened or was force-killed).
    | 'jarvis_session_start'
    | 'jarvis_session_end'
    | 'jarvis_voice_turn'
    | 'jarvis_query'
    | 'jarvis_navigate'
    | 'jarvis_session_killed'
    | 'jarvis_canary_add'
    | 'jarvis_canary_remove'
    | 'jarvis_routine_save'
    | 'jarvis_routine_delete'
    | 'iam_apply'
    // Cost remediation: a real AWS mutation applied from the Cost tab (delete
    // NAT/LB/volume/endpoint, release EIP). 'blocked' = pre-flight refused or
    // the arm gate was off, so nothing was touched.
    | 'cost_remediation_applied'
    | 'cost_remediation_blocked'
    // Wave 4a: magic-link passwordless auth + RBAC member lifecycle. Every
    // privilege-changing action audits; the always-audited subset below makes
    // sure an attacker tripping audit_log_disabled cannot hide invites, role
    // changes, disables, or the login-request / login-outcome trail.
    | 'user_invited'
    | 'user_activated'
    | 'login_request'
    | 'login_success'
    | 'login_failure'
    | 'user_role_changed'
    | 'user_disabled'
    // MCP server registry changes (AgentCore gateways / remote MCP servers an
    // agent can call tools on). Config-tier write, always worth a trail.
    | 'mcp_servers_updated'
    // Dashboard scheduled-task CRUD (proactive routines).
    | 'scheduled_task_created'
    | 'scheduled_task_updated'
    // ask_agent synchronous delegation (cost lands on the target agent under
    // a delegation: chatId; this entry records the ASKING side).
    | 'agent_delegation'
    // in-app OAuth connect (detail carries provider/mode/key NAMES, never values)
    | 'oauth_connected'
    | 'oauth_credentials_set'
    // Seat administration (absorbed from PR #42): seat + seat-policy CRUD.
    // Privilege-adjacent config writes, so every mutation leaves a trail.
    | 'seat_created'
    | 'seat_updated'
    | 'seat_policy_created'
    | 'seat_policy_updated'
    // Power switch: a dashboard-initiated pause of the whole stack (flips kill
    // switches + drains compute via the external power Lambda).
    | 'power_pause'
    | 'effect_applied'
    | 'effect_unknown'
    | 'effect_resolved'
    | 'approval_requested'
    | 'approval_decided'
    | 'approval_refused'
    | 'shadow_assigned'
    | 'shadow_rotated'
    | 'shadow_retired';
  agentId?: string;
  chatId?: string;
  /** Speaker id when known (Slack user, Telegram chat numeric, dashboard operator). */
  userId?: string;
  surface?: 'telegram' | 'slack' | 'dashboard' | 'system';
  modelId?: string;
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  latencyMs?: number;
  toolName?: string;
  detail?: Record<string, unknown>;
  result?: 'ok' | 'error' | 'blocked';
  errMessage?: string;
  /** Untrusted annotation from X-Dashboard-User header. Never use as canonical identity. */
  operatorHint?: string;
  /** Human-readable operator label from per-operator token (display only). */
  operatorLabel?: string;
}

/**
 * Actions that MUST be written durably even when the 'audit_log_disabled'
 * kill switch is active. An attacker who trips that switch must not be able
 * to hide that panic was engaged/restored/force-released, that auth attempts
 * failed, or that other writes were being suppressed. Keep this list tight —
 * it is the set of break-glass-proof security events.
 */
const ALWAYS_AUDITED_ACTIONS: ReadonlySet<AuditEvent['action']> = new Set([
  'effect_applied',
  'effect_unknown',
  'effect_resolved',
  'approval_requested',
  'approval_decided',
  'approval_refused',
  'shadow_assigned',
  'shadow_rotated',
  'shadow_retired',
  'panic_triggered',
  'panic_restored',
  'panic_repaired',
  'panic_force_released',
  'auth_failure',
  // NZR-43: probing the config routes for secrets must not be hideable.
  'config_access_denied',
  // NZR-5: probing other agents' knowledge scopes must not be hideable.
  'knowledge_scope_denied',
  // NZR-6: moving chat files between scopes changes who can read them.
  'knowledge_quarantined',
  'knowledge_reassigned',
  'audit_suppressed',
  'jarvis_session_start',
  'jarvis_session_killed',
  // Wave 4a: passwordless auth + RBAC member lifecycle. These are the
  // break-glass-proof identity events. An attacker who trips audit_log_disabled
  // must not be able to hide that they invited a user, activated an account,
  // changed a role, disabled a member, or that login attempts were happening
  // (request / success / failure).
  'user_invited',
  'user_activated',
  'login_request',
  'login_success',
  'login_failure',
  'user_role_changed',
  'user_disabled',
  // C5c: control-plane changes an attacker most wants hidden. Tripping or
  // clearing a kill switch, minting/revoking a bearer token, and applying an
  // IAM change are never suppressible by audit_log_disabled.
  'kill_switch_set',
  'token_created',
  'token_revoked',
  // Decision 1: who owns a token's conversations, and every admin read of a
  // conversation that is not theirs, are exactly what a hostile admin would hide.
  'token_linked',
  'session_read_override',
  'iam_apply',
  // Pausing prod flips kill switches and drains compute — same tier as
  // kill_switch_set, so the trail survives audit_log_disabled.
  'power_pause',
]);

// Dedupe window for the 'audit_suppressed' marker so a flood of dropped
// events while the switch is on produces at most one marker per window
// instead of spamming the immutable trail.
const SUPPRESSION_MARKER_WINDOW_MS = 60_000;
let _lastSuppressionMarkerAt = 0;

export async function writeAudit(event: AuditEvent): Promise<void> {
  // Break-glass: dropping audit writes is itself an auditable action.
  const alwaysAudit = ALWAYS_AUDITED_ACTIONS.has(event.action);
  const killed = alwaysAudit
    ? { active: false }
    : await isKillSwitchActive('audit_log_disabled').catch(() => ({
        active: false,
      }));
  if (killed.active) {
    logger.warn(
      { action: event.action, agentId: event.agentId },
      'audit_log_disabled kill switch active; dropping audit write',
    );
    // Emit a durable, deduped suppression marker so the immutable trail
    // still records that suppression happened. The marker itself is on the
    // always-audited allowlist, so this recursion terminates after one hop.
    const now = Date.now();
    if (now - _lastSuppressionMarkerAt >= SUPPRESSION_MARKER_WINDOW_MS) {
      _lastSuppressionMarkerAt = now;
      void writeAudit({
        action: 'audit_suppressed',
        agentId: event.agentId,
        result: 'blocked',
        detail: { suppressedAction: event.action },
      });
    }
    return;
  }

  // Refresh the PII cache opportunistically so detail blobs get
  // redacted when the switch is on. The redactSync below uses whichever
  // value the cache landed at.
  void refreshPiiCache();

  const id = randomUUID();
  const ts = new Date().toISOString();
  const day = ts.slice(0, 10);

  // Run any string fields under `detail` through the redactor when the
  // switch is on. This is best-effort; the guardrail still handles the
  // model-facing path.
  const redactedDetail = event.detail
    ? Object.fromEntries(
        Object.entries(event.detail).map(([k, v]) => [
          k,
          typeof v === 'string' ? redactSync(v) : v,
        ]),
      )
    : undefined;
  const eventForWrite = {
    ...event,
    ...(redactedDetail ? { detail: redactedDetail } : {}),
  };

  // Don't await — caller doesn't block on audit.
  void persistAuditEvent(event, eventForWrite, id, ts, day);
}

/** Persist one redacted event to both stores. Never throws; reports which
 * stores accepted the write so critical callers can fail loudly. */
async function persistAuditEvent(
  event: AuditEvent,
  eventForWrite: Record<string, unknown>,
  id: string,
  ts: string,
  day: string,
): Promise<{ ddbOk: boolean; s3Ok: boolean }> {
  const ddbPromise = ddb()
    .send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          PK: `DAY#${day}`,
          SK: `${ts}#${id}`,
          GSI1PK: `AGENT#${event.agentId ?? 'system'}`,
          GSI1SK: `${ts}#${id}`,
          id,
          ts,
          ...eventForWrite,
        },
      }),
    )
    .then(() => true)
    .catch((err) => {
      logger.warn(
        {
          errMessage: err instanceof Error ? err.message : String(err),
          action: event.action,
        },
        'audit ddb write failed',
      );
      return false;
    });

  const bucket = auditLockBucket();
  const s3Promise = bucket
    ? s3()
        .send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: `audit/${day}/${ts.replace(/:/g, '-')}-${id}.json`,
            Body: JSON.stringify({ id, ts, ...eventForWrite }),
            ContentType: 'application/json',
          }),
        )
        .then(() => true)
        .catch((err) => {
          logger.warn(
            {
              errMessage: err instanceof Error ? err.message : String(err),
              action: event.action,
            },
            'audit s3 write failed',
          );
          return false;
        })
    : Promise.resolve(false);

  const [ddbOk, s3Ok] = await Promise.all([ddbPromise, s3Promise]);
  return { ddbOk, s3Ok };
}

/** Thrown when a security-critical audit event could not be durably recorded
 * in ANY store. Callers surface this as a 500 so the failure is never silent. */
export class AuditWriteFailedError extends Error {
  constructor(action: string) {
    super(`audit write failed for security-critical action ${action}`);
    this.name = 'AuditWriteFailedError';
  }
}

/**
 * C5c: the awaited, non-suppressible audit write for privilege-changing
 * mutations (token mint/revoke, IAM apply). Unlike writeAudit it:
 *   - never consults the audit_log_disabled kill switch (the actions using it
 *     are on the always-audited list anyway; this is defense in depth),
 *   - AWAITS both stores, and
 *   - THROWS AuditWriteFailedError when NEITHER store accepted the event.
 *
 * Ordering contract: callers invoke it AFTER the mutation persists and
 * surface a thrown error as a 500. The mutation is not rolled back — the
 * point is that a privilege change with no durable trail is loud (the caller
 * errors, both store failures are logged) instead of silently absorbed.
 * Emergency-protective paths (panic, kill-switch trips) deliberately stay on
 * fire-and-forget writeAudit so an audit outage can never block protection.
 */
export async function writeAuditOrThrow(event: AuditEvent): Promise<void> {
  void refreshPiiCache();
  const id = randomUUID();
  const ts = new Date().toISOString();
  const day = ts.slice(0, 10);
  const redactedDetail = event.detail
    ? Object.fromEntries(
        Object.entries(event.detail).map(([k, v]) => [
          k,
          typeof v === 'string' ? redactSync(v) : v,
        ]),
      )
    : undefined;
  const eventForWrite = {
    ...event,
    ...(redactedDetail ? { detail: redactedDetail } : {}),
  };
  const { ddbOk, s3Ok } = await persistAuditEvent(event, eventForWrite, id, ts, day);
  if (!ddbOk && !s3Ok) throw new AuditWriteFailedError(event.action);
}
