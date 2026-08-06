/**
 * Per-agent Slack credential management.
 *
 * Each agent can have its own Slack app with separate bot token + signing
 * secret. Credentials are resolved in two layers:
 *
 *   1. SLACK_AGENT_TOKENS_JSON env var (JSON object keyed by agentId)
 *   2. DDB agents table (slackBotToken / slackSigningSecret columns)
 *
 * Env-var layer wins. DDB results are cached for CACHE_TTL_MS.
 */

import { logger } from '../../observability/logger.js';
import { listAgents } from '../../lib/state/agents-repo.js';

export interface SlackAgentCreds {
  botToken: string;
  signingSecret: string;
}

let cachedAgentTokens: Record<string, SlackAgentCreds> = {};
let envTokens: Record<string, SlackAgentCreds> | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 60_000;

function loadFromEnv(): Record<string, SlackAgentCreds> {
  if (envTokens) return envTokens;
  const raw = process.env.SLACK_AGENT_TOKENS_JSON ?? '';
  if (!raw) {
    envTokens = {};
    return envTokens;
  }
  try {
    envTokens = JSON.parse(raw) as Record<string, SlackAgentCreds>;
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'failed to parse SLACK_AGENT_TOKENS_JSON',
    );
    envTokens = {};
  }
  return envTokens;
}

export function getSlackAgentCreds(agentId: string): SlackAgentCreds | undefined {
  return loadFromEnv()[agentId] ?? cachedAgentTokens[agentId];
}

export async function getSlackAgentCredsAsync(agentId: string): Promise<SlackAgentCreds | undefined> {
  const sync = getSlackAgentCreds(agentId);
  if (sync) return sync;
  if (Date.now() < cacheExpiry && agentId in cachedAgentTokens) {
    return cachedAgentTokens[agentId];
  }
  try {
    const agents = await listAgents();
    const agent = agents.find((a) => a.agentId === agentId);
    if (agent?.slackBotToken && agent?.slackSigningSecret) {
      cachedAgentTokens[agentId] = {
        botToken: agent.slackBotToken,
        signingSecret: agent.slackSigningSecret,
      };
      cacheExpiry = Date.now() + CACHE_TTL_MS;
      return cachedAgentTokens[agentId];
    }
  } catch (err) {
    logger.warn(
      { agentId, err: err instanceof Error ? err.message : String(err) },
      'failed to fetch slack agent creds from DDB',
    );
  }
  return undefined;
}

export function refreshSlackTokenCache(): void {
  envTokens = null;
  cachedAgentTokens = {};
  cacheExpiry = 0;
}
