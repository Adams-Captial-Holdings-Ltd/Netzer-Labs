/**
 * Kill switches — global on/off toggles for risky behaviors.
 *
 * Stored in DDB so any task can flip a switch in seconds. Reads are
 * cached locally for 30s to keep hot-path latency low. Fail-open: if
 * DDB is unreachable, treat the switch as off and log loudly (a hard
 * fail-closed would brick the entire bot on a transient DDB hiccup).
 *
 * Switches we honor today:
 *   bedrock_global              — block ALL Bedrock calls
 *   tool_use                    — block tool dispatch (model can still chat)
 *   memory_writes               — block add_memory / memory ingest
 *   telegram_posting            — block outbound Telegram sends
 *   slack_posting               — block outbound Slack sends
 *   audit_log_disabled          — drop audit log writes (DDB + S3)
 *   cost_cap_per_day            — block Bedrock when today's spend exceeds CCE_DAILY_COST_CAP_USD
 *   memory_ingest_disabled      — skip Haiku memory ingest on session eviction
 *   tool_dispatch_disabled      — alias of tool_use kept for granular ops
 *   guardrail_disabled          — bypass Bedrock guardrail attach
 *   dashboard_read_disabled     — return 503 from /api/* GET endpoints
 *   media_upload_disabled       — refuse Telegram media downloads
 *
 * v5.6 switches:
 *   memory_consolidation_disabled  — skip nightly memory consolidation
 *   memory_context_v2_disabled     — fall back to v4 memory context path
 *   exfil_guard_disabled           — bypass DLP exfil scanning
 *   exfil_custom_patterns_disabled — ignore customer-supplied DLP patterns
 *   warroom_disabled               — reject all war room API calls
 *   warroom_router_disabled        — skip Haiku intent routing in war room
 *   warroom_intervention_disabled  — disable intervention gate in war room
 *   hooks_disabled                 — skip all hook dispatch
 *   skills_disabled                — skip all skill invocations
 *   extension_deployer_disabled    — reject extension deployments
 *   chaos_bedrock_throttle_opus    — inject synthetic throttle on Opus
 *   chaos_bedrock_throttle_sonnet  — inject synthetic throttle on Sonnet
 *   chaos_bedrock_throttle_haiku   — inject synthetic throttle on Haiku
 *   chaos_secrets_throttle         — inject synthetic throttle on SecretsManager
 *   sessions_frozen                — block new agent turns from being processed
 */

import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './ddb.js';
import { logger } from '../../observability/logger.js';
import { publishInvalidation } from '../config/invalidation-publisher.js';
import { teardownAllJarvisSessions, JARVIS_TEARDOWN_SWITCHES } from '../voice/session-registry.js';

const TABLE = process.env.TABLE_KILL_SWITCHES ?? 'claudeclaw-kill-switches';
const CACHE_TTL_MS = 30_000;

export type KillSwitchName =
  | 'bedrock_global'
  | 'tool_use'
  | 'memory_writes'
  | 'telegram_posting'
  | 'slack_posting'
  | 'audit_log_disabled'
  | 'cost_cap_per_day'
  | 'memory_ingest_disabled'
  | 'tool_dispatch_disabled'
  | 'guardrail_disabled'
  | 'dashboard_read_disabled'
  | 'media_upload_disabled'
  // per-add-on switches (Phase G)
  | 'image_gen_disabled'
  | 'tts_disabled'
  | 'email_send_disabled'
  | 'web_search_disabled'
  | 'document_gen_disabled'
  | 'pii_redaction_enabled'
  // v5.6: memory consolidation + context
  | 'memory_consolidation_disabled'
  | 'memory_context_v2_disabled'
  // v5.6: exfil guard
  | 'exfil_guard_disabled'
  | 'exfil_custom_patterns_disabled'
  // v5.6: war room
  | 'warroom_disabled'
  | 'warroom_router_disabled'
  | 'warroom_intervention_disabled'
  // v5.6: hooks + skills + extensions
  | 'hooks_disabled'
  | 'skills_disabled'
  | 'extension_deployer_disabled'
  // v5.6: chaos injection
  | 'chaos_bedrock_throttle_opus'
  | 'chaos_bedrock_throttle_sonnet'
  | 'chaos_bedrock_throttle_haiku'
  | 'chaos_secrets_throttle'
  // integration signature verification
  // session processing
  | 'sessions_frozen'
  // Jarvis voice co-pilot (read-only navigator). jarvis_disabled is the
  // runtime emergency kill (denies everyone incl. canary, tears down live
  // sessions); jarvis_voice_disabled drops audio → text-only; jarvis_canary_mode
  // active = staged rollout (admit allowlisted tokens only). See JARVIS-PLAN.md
  // §1b H7/H8/H11.
  | 'jarvis_disabled'
  | 'jarvis_voice_disabled'
  | 'jarvis_canary_mode'
  // chat media: auto KB ingest of files dropped in chat + video understanding.
  // media_upload_disabled already stops ALL media downloads upstream; these
  // scope finer (ingest-only / video-only).
  | 'chat_kb_ingest_disabled'
  | 'video_processing_disabled'
  // in-app OAuth connect flows + the Salesforce tool surface
  | 'oauth_connect_disabled'
  | 'salesforce_disabled'
  // Paperclip missions integration
  | 'paperclip_disabled';

export const ALL_KILL_SWITCHES: readonly KillSwitchName[] = [
  'bedrock_global',
  'tool_use',
  'memory_writes',
  'telegram_posting',
  'slack_posting',
  'audit_log_disabled',
  'cost_cap_per_day',
  'memory_ingest_disabled',
  'tool_dispatch_disabled',
  'guardrail_disabled',
  'dashboard_read_disabled',
  'media_upload_disabled',
  'image_gen_disabled',
  'tts_disabled',
  'email_send_disabled',
  'web_search_disabled',
  'document_gen_disabled',
  'pii_redaction_enabled',
  'memory_consolidation_disabled',
  'memory_context_v2_disabled',
  'exfil_guard_disabled',
  'exfil_custom_patterns_disabled',
  'warroom_disabled',
  'warroom_router_disabled',
  'warroom_intervention_disabled',
  'hooks_disabled',
  'skills_disabled',
  'extension_deployer_disabled',
  'chaos_bedrock_throttle_opus',
  'chaos_bedrock_throttle_sonnet',
  'chaos_bedrock_throttle_haiku',
  'chaos_secrets_throttle',
  'sessions_frozen',
  'jarvis_disabled',
  'jarvis_voice_disabled',
  'jarvis_canary_mode',
  'chat_kb_ingest_disabled',
  'video_processing_disabled',
  'oauth_connect_disabled',
  'salesforce_disabled',
  'paperclip_disabled',
];

interface CacheEntry {
  active: boolean;
  reason?: string;
  expiresAt: number;
}

const cache = new Map<KillSwitchName, CacheEntry>();

export interface KillSwitchState {
  active: boolean;
  reason?: string;
  setAt?: string;
  setBy?: string;
}

/**
 * Thrown when a request is blocked by an active kill switch (most commonly
 * `bedrock_global`). Defined here, not in the agent loop, so low-level modules
 * such as the Bedrock guard can throw it without importing the agent loop (which
 * would create an import cycle). Re-exported from `agent/agent-loop` for
 * back-compat with existing import sites.
 */
export class KillSwitchActiveError extends Error {
  constructor(public reason: string, public switchName: string = 'bedrock_global') {
    super(`${switchName} kill switch active: ${reason}`);
    this.name = 'KillSwitchActiveError';
  }
}

export async function isKillSwitchActive(name: KillSwitchName): Promise<KillSwitchState> {
  const cached = cache.get(name);
  if (cached && cached.expiresAt > Date.now()) {
    return { active: cached.active, reason: cached.reason };
  }
  try {
    const out = await ddb().send(
      new GetCommand({
        TableName: TABLE,
        Key: { PK: `SWITCH#${name}`, SK: 'STATUS' },
      }),
    );
    const item = out.Item as
      | { active?: boolean; reason?: string; setAt?: string; setBy?: string }
      | undefined;
    const active = Boolean(item?.active);
    cache.set(name, {
      active,
      reason: item?.reason,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
    return { active, reason: item?.reason, setAt: item?.setAt, setBy: item?.setBy };
  } catch (err) {
    logger.warn(
      { switch: name, err: err instanceof Error ? err.message : String(err) },
      'kill switch read failed — failing open',
    );
    return { active: false };
  }
}

export async function setKillSwitch(
  name: KillSwitchName,
  active: boolean,
  reason: string,
  setBy: string,
  opts?: { publish?: boolean },
): Promise<void> {
  await ddb().send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `SWITCH#${name}`,
        SK: 'STATUS',
        active,
        reason,
        setBy,
        setAt: new Date().toISOString(),
      },
    }),
  );
  cache.delete(name);
  // Tear down THIS task's own live Jarvis sessions on a teardown-relevant switch.
  // The fanout listener skips self-origin messages (and prod has no SNS topic),
  // so without this the writer task's own voice sessions would survive the kill
  // until a per-turn re-check or timeout (Codex review). Peers are covered by the
  // fanout / 30s cache poll. Only on activation; idempotent so the panic batch's
  // extra sweeps are harmless.
  if (active) {
    const reason = JARVIS_TEARDOWN_SWITCHES[name];
    if (reason) {
      void teardownAllJarvisSessions(reason).catch((err) => {
        logger.warn(
          { switch: name, err: err instanceof Error ? err.message : String(err) },
          'jarvis local teardown after kill-switch set failed',
        );
      });
    }
  }
  // Best-effort SNS fanout so peer tasks invalidate immediately instead of
  // waiting out the 30s cache TTL. Never throws; the local delete above is the
  // writer's own invalidation and the 30s poll covers correctness if this fails.
  // publish:false is used by the panic fan-out, which trips ~35 switches then
  // sends a single 'all' broadcast, so per-switch publishes would be redundant
  // amplification on the latency-sensitive freeze path.
  if (opts?.publish !== false) {
    void publishInvalidation('kill_switch', name);
  }
}

export function invalidateKillSwitchCache(name?: KillSwitchName): void {
  if (name) cache.delete(name);
  else cache.clear();
}

export interface KillSwitchMeta {
  description: string;
  category: 'Cost Controls' | 'Safety & Guardrails' | 'Integrations' | 'Agent Behavior' | 'System';
}

export const KILL_SWITCH_META: Record<KillSwitchName, KillSwitchMeta> = {
  bedrock_global: { description: 'Block all Bedrock API calls. Complete AI shutdown.', category: 'Cost Controls' },
  cost_cap_per_day: { description: 'Block Bedrock when daily spend exceeds the configured cap.', category: 'Cost Controls' },
  tool_use: { description: 'Block all tool dispatch. Model can still chat but cannot execute tools.', category: 'Safety & Guardrails' },
  tool_dispatch_disabled: { description: 'Granular alias for tool_use. Blocks tool execution.', category: 'Safety & Guardrails' },
  guardrail_disabled: { description: 'Bypass Bedrock guardrail attachment on requests.', category: 'Safety & Guardrails' },
  exfil_guard_disabled: { description: 'Bypass DLP exfiltration scanning on outbound content.', category: 'Safety & Guardrails' },
  exfil_custom_patterns_disabled: { description: 'Ignore customer-supplied DLP regex patterns.', category: 'Safety & Guardrails' },
  pii_redaction_enabled: { description: 'Enable PII redaction on audit log detail fields.', category: 'Safety & Guardrails' },
  memory_writes: { description: 'Block add_memory and memory ingest operations.', category: 'Agent Behavior' },
  memory_ingest_disabled: { description: 'Skip Haiku memory ingest on session turn eviction.', category: 'Agent Behavior' },
  memory_consolidation_disabled: { description: 'Skip nightly memory consolidation job.', category: 'Agent Behavior' },
  memory_context_v2_disabled: { description: 'Fall back to v4 memory context retrieval path.', category: 'Agent Behavior' },
  hooks_disabled: { description: 'Skip all hook dispatch for agent events.', category: 'Agent Behavior' },
  skills_disabled: { description: 'Skip all skill invocations during agent turns.', category: 'Agent Behavior' },
  sessions_frozen: { description: 'Block new agent turns from being processed.', category: 'Agent Behavior' },
  jarvis_disabled: { description: 'Jarvis emergency kill. Refuses new voice/text sessions and tears down live ones (denies everyone including canary).', category: 'Agent Behavior' },
  jarvis_voice_disabled: { description: 'Disable Jarvis audio. Live sessions close 4012 and drop to the text path; text Jarvis still works.', category: 'Agent Behavior' },
  jarvis_canary_mode: { description: 'Jarvis staged rollout. When active, only allowlisted tokens may open a session.', category: 'Agent Behavior' },
  telegram_posting: { description: 'Block outbound Telegram message sends.', category: 'Integrations' },
  slack_posting: { description: 'Block outbound Slack message sends.', category: 'Integrations' },
  media_upload_disabled: { description: 'Refuse chat media downloads and processing (Telegram, Slack, dashboard chat).', category: 'Integrations' },
  chat_kb_ingest_disabled: { description: 'Stop auto-ingesting chat-dropped documents into the knowledge base. Inline analysis still works.', category: 'Integrations' },
  oauth_connect_disabled: { description: 'Disable the in-app OAuth Connect flows (start + callback refuse).', category: 'Integrations' },
  salesforce_disabled: { description: 'Disable the Salesforce query/record tools.', category: 'Integrations' },
  paperclip_disabled: { description: 'Disable the Paperclip integration.', category: 'Integrations' },
  video_processing_disabled: { description: 'Disable video understanding (transcript + keyframes) for chat-uploaded videos. Files are still stored.', category: 'Integrations' },
  image_gen_disabled: { description: 'Disable image generation add-on.', category: 'Integrations' },
  tts_disabled: { description: 'Disable text-to-speech add-on.', category: 'Integrations' },
  email_send_disabled: { description: 'Disable email send add-on.', category: 'Integrations' },
  web_search_disabled: { description: 'Disable web search add-on.', category: 'Integrations' },
  document_gen_disabled: { description: 'Disable document generation add-on.', category: 'Integrations' },
  warroom_disabled: { description: 'Reject all War Room API calls and meetings.', category: 'Integrations' },
  warroom_router_disabled: { description: 'Skip Haiku intent routing in War Room conversations.', category: 'Integrations' },
  warroom_intervention_disabled: { description: 'Disable intervention gate in War Room.', category: 'Integrations' },
  audit_log_disabled: { description: 'Drop audit log writes to DDB and S3. Logged to stdout only.', category: 'System' },
  dashboard_read_disabled: { description: 'Return 503 from all GET /api/* dashboard endpoints.', category: 'System' },
  extension_deployer_disabled: { description: 'Reject all extension deployments.', category: 'System' },
  chaos_bedrock_throttle_opus: { description: 'Inject synthetic throttle on Opus model calls.', category: 'System' },
  chaos_bedrock_throttle_sonnet: { description: 'Inject synthetic throttle on Sonnet model calls.', category: 'System' },
  chaos_bedrock_throttle_haiku: { description: 'Inject synthetic throttle on Haiku model calls.', category: 'System' },
  chaos_secrets_throttle: { description: 'Inject synthetic throttle on SecretsManager calls.', category: 'System' },
};
