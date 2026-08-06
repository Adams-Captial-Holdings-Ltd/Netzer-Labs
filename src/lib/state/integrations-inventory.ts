/**
 * Integrations inventory (READ-ONLY).
 *
 * Builds a per-agent inventory of every connected messaging surface
 * (Slack / Telegram) by reading the agents repo and cross-referencing the
 * global signature-verification kill switches. For each connected surface we
 * report whether signature/secret verification is ON, whether the surface is
 * at soft-bypass risk (it would accept unsigned/unverified inbound), and a
 * webhook health probe.
 *
 * This module NEVER returns secret VALUES. We only ever read the presence of a
 * token/signing-secret (a boolean), never the bytes. Telegram health reuses the
 * webhook-monitor probe helpers; Slack has no equivalent inbound webhook to
 * poke (Slack pushes events to us), so we report configured / last-seen state.
 *
 * Every AWS / network read fails soft: a failed agents scan yields an empty
 * inventory, and a failed Telegram probe degrades that one surface to
 * health.status='unknown' rather than throwing.
 */

import { listAgents } from './agents-repo.js';
import { getBotTokenAsync } from '../../adapters/telegram/send.js';
import { getWebhookInfo, syntheticWebhookTest } from '../../agent/webhook-monitor.js';
import { logger } from '../../observability/logger.js';
import type { AgentMetadata } from '../agents/types.js';

export type IntegrationSurface = 'slack' | 'telegram';

export interface SurfaceHealth {
  /**
   * ok      - probe succeeded and surface looks healthy
   * warn    - probe succeeded but found a problem (errors / stuck updates)
   * unknown - we could not probe (no token, probe failed, or N/A for Slack)
   */
  status: 'ok' | 'warn' | 'unknown';
  detail: string;
}

export interface IntegrationEntry {
  surface: IntegrationSurface;
  agentId: string;
  /** Whether signature/secret verification is currently ON for this surface. */
  verificationMode: boolean;
  /**
   * True when the surface would currently accept unsigned/unverified inbound,
   * i.e. the break-glass signature-check kill switch is active OR no signing
   * secret is configured at all. Reflects the Inc-1 webhook hardening.
   */
  softBypassRisk: boolean;
  health: SurfaceHealth;
}

export interface IntegrationsInventory {
  generatedAt: string;
  entries: IntegrationEntry[];
}

/**
 * Resolve a Telegram webhook health probe for one agent. Reuses the
 * webhook-monitor helpers so probe behaviour stays identical to the live
 * monitor. Never throws; degrades to 'unknown' on any failure.
 */
async function probeTelegramHealth(
  agentId: string,
): Promise<SurfaceHealth> {
  let botToken: string | undefined;
  try {
    botToken = await getBotTokenAsync(agentId);
  } catch {
    botToken = undefined;
  }
  if (!botToken) {
    return { status: 'unknown', detail: 'bot token not resolvable; cannot probe webhook' };
  }

  const info = await getWebhookInfo(botToken);
  if (!info) {
    return { status: 'unknown', detail: 'getWebhookInfo failed or returned not-ok' };
  }

  const problems: string[] = [];
  if (info.last_error_message) {
    const errorAge = info.last_error_date
      ? Math.floor(Date.now() / 1000) - info.last_error_date
      : 999;
    if (errorAge < 300) {
      problems.push(`recent webhook error (${errorAge}s ago): ${info.last_error_message}`);
    }
  }
  if (info.pending_update_count > 5) {
    problems.push(`${info.pending_update_count} pending updates (messages stuck)`);
  }

  // Synthetic POST only when we have the shared webhook secret; otherwise we
  // cannot exercise the WAF/ALB path without it. Absence is not a problem here.
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET ?? '';
  if (info.url && webhookSecret) {
    const probe = await syntheticWebhookTest(info.url, webhookSecret);
    if (!probe.ok) {
      problems.push(`synthetic webhook POST returned ${probe.status} (expected 200)`);
    }
  }

  if (!info.url) {
    return { status: 'warn', detail: 'no webhook URL set on the bot' };
  }
  if (problems.length > 0) {
    return { status: 'warn', detail: problems.join('; ') };
  }
  return {
    status: 'ok',
    detail: `webhook configured, ${info.pending_update_count} pending`,
  };
}

/**
 * Slack pushes events to us (Events API), so there is no inbound webhook to
 * poke the way Telegram exposes getWebhookInfo. Report configured/last-seen
 * state from the agent record instead.
 */
function slackHealth(agent: AgentMetadata): SurfaceHealth {
  const hasSigningSecret = Boolean(agent.slackSigningSecret);
  if (!hasSigningSecret) {
    return {
      status: 'warn',
      detail: 'bot token present but no signing secret configured',
    };
  }
  return {
    status: 'ok',
    detail: agent.slackAppId
      ? `configured (app ${agent.slackAppId})`
      : 'configured',
  };
}

/**
 * Build the full integration inventory across all agents.
 *
 * @param opts.probeHealth when false, skip the live Telegram network probes
 *   (health is reported 'unknown' with a 'probe skipped' note). Useful when the
 *   caller only wants the static verification/soft-bypass posture cheaply.
 */
export async function getIntegrationsInventory(
  opts: { probeHealth?: boolean } = {},
): Promise<IntegrationsInventory> {
  const probeHealth = opts.probeHealth !== false;
  const generatedAt = new Date().toISOString();

  let agents: AgentMetadata[] = [];
  try {
    agents = await listAgents();
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'integrations inventory: listAgents failed — failing soft to empty',
    );
    return { generatedAt, entries: [] };
  }

  // Wave A: the signature-check bypass switches were REMOVED (an unsigned
  // request carries an attacker-controlled principal, defeating the sender
  // allowlist). Verification now rides solely on secret presence; a missing
  // secret means ingress is CLOSED, not unverified.

  const entries: IntegrationEntry[] = [];

  for (const agent of agents) {
    // Telegram surface.
    if (agent.telegramBotToken) {
      // Telegram verification rides on the shared webhook secret. It is ON
      // unless the break-glass switch is flipped. Soft-bypass risk when the
      // switch is active OR the deployment has no webhook secret configured.
      const hasTelegramSecret = Boolean(process.env.TELEGRAM_WEBHOOK_SECRET);
      const verificationMode = hasTelegramSecret;
      const softBypassRisk = !hasTelegramSecret;
      const health = probeHealth
        ? await probeTelegramHealth(agent.agentId)
        : ({ status: 'unknown', detail: 'probe skipped' } satisfies SurfaceHealth);
      entries.push({
        surface: 'telegram',
        agentId: agent.agentId,
        verificationMode,
        softBypassRisk,
        health,
      });
    }

    // Slack surface.
    if (agent.slackBotToken) {
      // Slack verification is HMAC over the signing secret. It is ON when a
      // signing secret is present AND the break-glass switch is not flipped.
      const hasSigningSecret = Boolean(agent.slackSigningSecret);
      const verificationMode = hasSigningSecret;
      const softBypassRisk = !hasSigningSecret;
      entries.push({
        surface: 'slack',
        agentId: agent.agentId,
        verificationMode,
        softBypassRisk,
        health: slackHealth(agent),
      });
    }
  }

  return { generatedAt, entries };
}
