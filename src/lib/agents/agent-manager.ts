/**
 * Agent Manager: orchestration layer coordinating DDB, S3, Secrets
 * Manager, and cache invalidation for agent lifecycle operations.
 *
 * All mutations flow through here so side-effects (S3 writes, cache
 * invalidation, webhook registration) stay consistent.
 */

import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import {
  listAgents,
  getAgent,
  createAgent as dbCreateAgent,
  updateAgent,
  deleteAgent as dbDeleteAgent,
  setAgentStatus,
} from '../state/agents-repo.js';
import { invalidateAgentCache } from '../config/agent-loader.js';
import { pickDefaultModel } from '../bedrock/models.js';
import { getTemplate } from './templates.js';
import type { AgentMetadata, CreateAgentOpts } from './types.js';
import { logger } from '../../observability/logger.js';
import { captureAwsClient } from '../observability/xray.js';

/* ------------------------------------------------------------------ */
/*  S3 setup (mirrors agent-loader.ts pattern)                        */
/* ------------------------------------------------------------------ */

const region = process.env.AWS_REGION ?? 'us-east-1';
const bucket = process.env.CONFIG_BUCKET ?? '';

let _s3: S3Client | null = null;
function s3(): S3Client {
  if (!_s3) _s3 = captureAwsClient(new S3Client({ region }));
  return _s3;
}

/* ------------------------------------------------------------------ */
/*  Validation                                                        */
/* ------------------------------------------------------------------ */

const AGENT_ID_RE = /^[a-z][a-z0-9_-]{0,29}$/;

export async function validateAgentId(
  id: string,
): Promise<{ ok: boolean; error?: string; suggestions?: string[] }> {
  if (!AGENT_ID_RE.test(id)) {
    return {
      ok: false,
      error:
        'Agent ID must start with a lowercase letter, contain only lowercase letters, digits, hyphens, and underscores, and be 1-30 characters.',
    };
  }

  const existing = await listAgents();
  const taken = new Set(existing.map((a) => a.agentId));

  if (!taken.has(id)) return { ok: true };

  // Suggest alternatives
  const suggestions: string[] = [];
  for (let n = 2; n <= 5; n++) {
    const candidate = `${id}-${n}`;
    if (!taken.has(candidate) && AGENT_ID_RE.test(candidate)) {
      suggestions.push(candidate);
    }
  }

  return {
    ok: false,
    error: `Agent ID "${id}" is already in use.`,
    suggestions: suggestions.length > 0 ? suggestions : undefined,
  };
}

/* ------------------------------------------------------------------ */
/*  Agent CRUD                                                        */
/* ------------------------------------------------------------------ */

export async function createAgentFull(
  // knowledgeScope is widened in here (rather than on the shared CreateAgentOpts
  // type) so creation can stamp an explicit scope into agent.yaml; defaults to
  // "default" so the vector-search tool always has a scope to read.
  opts: CreateAgentOpts & { knowledgeScope?: string },
): Promise<AgentMetadata> {
  const validation = await validateAgentId(opts.id);
  if (!validation.ok) {
    throw new Error(validation.error);
  }

  const templateId = opts.template ?? 'blank';
  const template = getTemplate(templateId);
  if (!template) {
    throw new Error(`Unknown template: "${templateId}"`);
  }

  const knowledgeScope = opts.knowledgeScope ?? 'default';

  const now = new Date().toISOString();
  const metadata: AgentMetadata = {
    agentId: opts.id,
    displayName: opts.name,
    description: opts.description,
    // Default a new agent to the platform's configured default model rather than
    // a hardcoded id, so new agents track BEDROCK_DEFAULT_MODEL instead of being
    // pinned to whatever Sonnet build was current when this line was written.
    model: opts.model ?? (pickDefaultModel(process.env) || 'us.anthropic.claude-sonnet-4-6'),
    template: templateId,
    status: 'creating',
    knowledgeScope,
    createdAt: now,
    updatedAt: now,
    createdBy: opts.createdBy ?? 'system',
  };

  // 1. Write DDB row
  await dbCreateAgent(metadata);
  logger.info({ agentId: opts.id, template: templateId }, 'agent row created in DDB');

  // 2. Write CLAUDE.md to S3
  await s3().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: `agents/${opts.id}/CLAUDE.md`,
      // Built lazily so the embedded "Today is ..." date is creation time,
      // not the orchestrator task's boot time.
      Body: template.buildClaudeMd(),
      ContentType: 'text/markdown; charset=utf-8',
    }),
  );

  // 3. Write agent.yaml to S3
  const yamlContent = [
    `name: ${opts.name}`,
    `description: ${opts.description}`,
    `model: ${metadata.model}`,
    // Explicit scope so the vector-search tool (which reads agent.yaml, not the
    // DDB row) always resolves a corpus for newly created agents.
    `knowledgeScope: ${knowledgeScope}`,
  ].join('\n');

  await s3().send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: `agents/${opts.id}/agent.yaml`,
      Body: yamlContent,
      ContentType: 'text/yaml; charset=utf-8',
    }),
  );

  logger.info({ agentId: opts.id }, 'agent S3 config written');

  // 4. Set status to inactive (creation complete, not yet connected)
  await setAgentStatus(opts.id, 'inactive');
  metadata.status = 'inactive';
  metadata.updatedAt = new Date().toISOString();

  // 5. Invalidate cache
  invalidateAgentCache(opts.id);

  logger.info({ agentId: opts.id }, 'agent creation complete');
  return metadata;
}

export async function deleteAgentFull(agentId: string): Promise<void> {
  const agent = await getAgent(agentId);
  if (!agent) {
    throw new Error(`Agent "${agentId}" not found.`);
  }

  // Delete S3 files
  await Promise.all([
    s3().send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: `agents/${agentId}/CLAUDE.md`,
      }),
    ),
    s3().send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: `agents/${agentId}/agent.yaml`,
      }),
    ),
  ]);

  // Delete DDB row
  await dbDeleteAgent(agentId);

  // Invalidate cache
  invalidateAgentCache(agentId);

  logger.info({ agentId }, 'agent fully deleted (DDB + S3)');
}

/* ------------------------------------------------------------------ */
/*  Activate / Deactivate                                             */
/* ------------------------------------------------------------------ */

export async function activateAgent(agentId: string): Promise<void> {
  await setAgentStatus(agentId, 'active');
  invalidateAgentCache(agentId);
  logger.info({ agentId }, 'agent activated');
}

export async function deactivateAgent(agentId: string): Promise<void> {
  await setAgentStatus(agentId, 'inactive');
  invalidateAgentCache(agentId);
  logger.info({ agentId }, 'agent deactivated');
}

/* ------------------------------------------------------------------ */
/*  Telegram integration                                              */
/* ------------------------------------------------------------------ */

export async function validateTelegramToken(
  token: string,
): Promise<{ ok: boolean; username?: string; botId?: number; error?: string }> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const body = (await res.json()) as {
      ok: boolean;
      result?: { id: number; username: string };
      description?: string;
    };
    if (!body.ok) {
      return { ok: false, error: body.description ?? 'Telegram rejected the token.' };
    }
    return {
      ok: true,
      username: body.result!.username,
      botId: body.result!.id,
    };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to reach Telegram API: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function connectTelegram(
  agentId: string,
  botToken: string,
  webhookDomain?: string,
): Promise<void> {
  // Validate the token
  const validation = await validateTelegramToken(botToken);
  if (!validation.ok) {
    throw new Error(`Invalid Telegram token: ${validation.error}`);
  }

  // Check that this bot is not already connected to another agent
  const agents = await listAgents();
  for (const a of agents) {
    if (a.agentId !== agentId && a.telegramBotId === validation.botId) {
      throw new Error(
        `Telegram bot @${validation.username} (${validation.botId}) is already connected to agent "${a.agentId}".`,
      );
    }
  }

  // Update agent in DDB
  await updateAgent(agentId, {
    telegramBotToken: botToken,
    telegramBotUsername: validation.username,
    telegramBotId: validation.botId,
  });

  // Register webhook if domain provided
  if (webhookDomain) {
    const webhookUrl = `https://${webhookDomain}/tg/${agentId}/webhook`;
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;

    const res = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        ...(secret ? { secret_token: secret } : {}),
      }),
    });
    const body = (await res.json()) as { ok: boolean; description?: string };
    if (!body.ok) {
      logger.warn({ agentId, description: body.description }, 'setWebhook failed');
      throw new Error(`Failed to set Telegram webhook: ${body.description}`);
    }
    logger.info({ agentId, webhookUrl }, 'telegram webhook registered');
  }

  // Activate the agent
  await setAgentStatus(agentId, 'active');
  invalidateAgentCache(agentId);

  logger.info(
    { agentId, botUsername: validation.username, botId: validation.botId },
    'telegram connected',
  );
}

export async function disconnectTelegram(agentId: string): Promise<void> {
  const agent = await getAgent(agentId);
  if (!agent) {
    throw new Error(`Agent "${agentId}" not found.`);
  }

  // Delete webhook if token exists
  if (agent.telegramBotToken) {
    try {
      await fetch(`https://api.telegram.org/bot${agent.telegramBotToken}/deleteWebhook`, {
        method: 'POST',
      });
    } catch (err) {
      logger.warn(
        { agentId, err: err instanceof Error ? err.message : String(err) },
        'deleteWebhook call failed (non-fatal)',
      );
    }
  }

  // Clear telegram fields
  await updateAgent(agentId, {
    telegramBotToken: undefined,
    telegramBotUsername: undefined,
    telegramBotId: undefined,
  });

  // If no Slack connected either, deactivate
  if (!agent.slackBotToken) {
    await setAgentStatus(agentId, 'inactive');
  }

  invalidateAgentCache(agentId);
  logger.info({ agentId }, 'telegram disconnected');
}

/* ------------------------------------------------------------------ */
/*  Slack integration                                                 */
/* ------------------------------------------------------------------ */

export async function validateSlackToken(
  botToken: string,
): Promise<{ ok: boolean; appId?: string; botUsername?: string; error?: string }> {
  try {
    const res = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${botToken}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    const body = (await res.json()) as {
      ok: boolean;
      app_id?: string;
      user?: string;
      error?: string;
    };
    if (!body.ok) {
      return { ok: false, error: body.error ?? 'Slack rejected the token.' };
    }
    return {
      ok: true,
      appId: body.app_id,
      botUsername: body.user,
    };
  } catch (err) {
    return {
      ok: false,
      error: `Failed to reach Slack API: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function connectSlack(
  agentId: string,
  botToken: string,
  signingSecret: string,
): Promise<void> {
  const validation = await validateSlackToken(botToken);
  if (!validation.ok) {
    throw new Error(`Invalid Slack token: ${validation.error}`);
  }

  await updateAgent(agentId, {
    slackBotToken: botToken,
    slackSigningSecret: signingSecret,
    slackAppId: validation.appId,
    slackBotUsername: validation.botUsername,
  });

  await setAgentStatus(agentId, 'active');
  invalidateAgentCache(agentId);

  logger.info(
    { agentId, appId: validation.appId, botUsername: validation.botUsername },
    'slack connected',
  );
}

export async function disconnectSlack(agentId: string): Promise<void> {
  const agent = await getAgent(agentId);
  if (!agent) {
    throw new Error(`Agent "${agentId}" not found.`);
  }

  await updateAgent(agentId, {
    slackBotToken: undefined,
    slackSigningSecret: undefined,
    slackAppId: undefined,
    slackBotUsername: undefined,
  });

  // If no Telegram connected either, deactivate
  if (!agent.telegramBotToken) {
    await setAgentStatus(agentId, 'inactive');
  }

  invalidateAgentCache(agentId);
  logger.info({ agentId }, 'slack disconnected');
}

/* ------------------------------------------------------------------ */
/*  Slack manifest generator                                          */
/* ------------------------------------------------------------------ */

export function generateSlackManifest(
  agentId: string,
  displayName: string,
  domain: string,
): object {
  return {
    display_information: {
      name: displayName,
      description: 'ClaudeClaw agent',
      background_color: '#0f1419',
    },
    features: {
      bot_user: {
        display_name: displayName,
        always_online: true,
      },
    },
    oauth_config: {
      scopes: {
        bot: [
          'app_mentions:read',
          'channels:history',
          'groups:history',
          'im:history',
          'chat:write',
          'chat:write.customize',
          // files:read powers chat file uploads (downloading url_private);
          // files:write powers generated-image delivery. Existing apps need
          // a reinstall after adding scopes (the OAuth Connect button makes
          // that one click).
          'files:read',
          'files:write',
        ],
      },
      // In-app OAuth Connect (Integrations tab) installs/reinstalls the
      // app through this redirect.
      redirect_urls: [`https://${domain}/api/oauth/callback`],
    },
    settings: {
      event_subscriptions: {
        request_url: `https://${domain}/slack/${agentId}/events`,
        bot_events: ['app_mention', 'message.im'],
      },
      // Interactivity is intentionally omitted. The per-agent Slack adapter
      // only serves /slack/<agent>/events; enabling interactivity here would
      // point Slack at a /interactive URL with no handler. Re-add this block
      // (and the matching route) when per-agent Block Kit callbacks land.
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}
