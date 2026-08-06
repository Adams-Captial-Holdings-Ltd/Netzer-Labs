/**
 * AWS connectivity and capability checks used by the setup wizard
 * and the status script.
 */

import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { CostExplorerClient, GetAnomalyMonitorsCommand } from '@aws-sdk/client-cost-explorer';
import {
  BedrockClient,
  ListInferenceProfilesCommand,
  type InferenceProfileSummary,
} from '@aws-sdk/client-bedrock';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';

export interface CallerIdentity {
  account: string;
  arn: string;
  userId: string;
}

export async function getCallerIdentity(region: string): Promise<CallerIdentity> {
  const sts = new STSClient({ region });
  const out = await sts.send(new GetCallerIdentityCommand({}));
  if (!out.Account || !out.Arn || !out.UserId) {
    throw new Error('STS returned incomplete identity');
  }
  return { account: out.Account, arn: out.Arn, userId: out.UserId };
}

export interface ResolvedModels {
  opus?: InferenceProfileSummary;
  sonnet?: InferenceProfileSummary;
  haiku?: InferenceProfileSummary;
  all: InferenceProfileSummary[];
}

/**
 * Lists Claude inference profiles in the given region and groups them
 * by model family. Returns the most recent version of each.
 *
 * We use cross-region inference profiles (with `us.`/`eu.` prefix)
 * by default since regional model IDs have spotty availability.
 */
export async function listClaudeInferenceProfiles(region: string): Promise<ResolvedModels> {
  const bedrock = new BedrockClient({ region });
  const out = await bedrock.send(new ListInferenceProfilesCommand({ maxResults: 100 }));
  const summaries = out.inferenceProfileSummaries ?? [];

  const claude = summaries.filter((s) => /claude/i.test(s.inferenceProfileName ?? ''));
  const opus = pickLatest(claude, /opus/i);
  const sonnet = pickLatest(claude, /sonnet/i);
  const haiku = pickLatest(claude, /haiku/i);

  return { opus, sonnet, haiku, all: claude };
}

function pickLatest(
  profiles: InferenceProfileSummary[],
  match: RegExp,
): InferenceProfileSummary | undefined {
  const matches = profiles.filter((p) => match.test(p.inferenceProfileName ?? ''));
  if (matches.length === 0) return undefined;
  // Sort by name descending so the most recent version (date suffix) wins.
  return matches.sort((a, b) =>
    (b.inferenceProfileName ?? '').localeCompare(a.inferenceProfileName ?? ''),
  )[0];
}

/**
 * Real InvokeModel call against the given profile. Confirms that not
 * only the API is reachable but the account has model access enabled
 * (which requires manual approval in the AWS console).
 */
export async function pingBedrockModel(
  region: string,
  modelOrProfileId: string,
): Promise<{ outputText: string; latencyMs: number }> {
  const runtime = new BedrockRuntimeClient({ region });
  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 20,
    messages: [{ role: 'user', content: 'reply with the word ok' }],
  });
  const start = Date.now();
  const out = await runtime.send(
    new InvokeModelCommand({
      modelId: modelOrProfileId,
      body,
      contentType: 'application/json',
      accept: 'application/json',
    }),
  );
  const latencyMs = Date.now() - start;
  if (!out.body) {
    throw new Error('InvokeModel returned empty body');
  }
  const decoded = JSON.parse(Buffer.from(out.body).toString('utf-8')) as {
    content?: Array<{ type: string; text?: string }>;
  };
  const text =
    decoded.content?.find((c) => c.type === 'text')?.text?.trim() ?? '<no text content>';
  return { outputText: text, latencyMs };
}

export function classifyBedrockError(err: unknown): {
  code: string;
  remedy: string;
  raw: string;
} {
  const e = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const name = e?.name ?? 'UnknownError';
  const message = e?.message ?? String(err);
  if (name === 'AccessDeniedException' || /access denied/i.test(message)) {
    return {
      code: 'AccessDeniedException',
      remedy:
        'Enable Anthropic model access in the Bedrock console: https://console.aws.amazon.com/bedrock/home#/model-catalog',
      raw: message,
    };
  }
  if (name === 'ValidationException' && /model identifier/i.test(message)) {
    return {
      code: 'ValidationException',
      remedy:
        'Model ID is invalid or not available in this region. Try a different region or pick from ListInferenceProfiles.',
      raw: message,
    };
  }
  if (name === 'UnrecognizedClientException') {
    return {
      code: 'UnrecognizedClientException',
      remedy: 'AWS credentials are invalid. Run: aws configure',
      raw: message,
    };
  }
  if (name === 'ThrottlingException') {
    return {
      code: 'ThrottlingException',
      remedy: 'Bedrock throttled this call. Retry or request a quota increase.',
      raw: message,
    };
  }
  return { code: name, remedy: 'Check AWS docs for this error code.', raw: message };
}

export interface AnomalyMonitorSummary {
  arn: string;
  name: string;
}

/** Minimal AWS-SDK-shaped client so tests can inject a `{ send }` fake. */
interface SendClient {
  send(command: unknown): Promise<unknown>;
}

/**
 * Find the account's existing DIMENSIONAL/SERVICE Cost Anomaly monitor, or
 * null when none exists (issue #49). AWS allows exactly ONE such monitor per
 * account and auto-creates "Default-Services-Monitor" the first time anomaly
 * detection is enabled, so a fresh CostGuardrails deploy on most accounts
 * collides unless it attaches to the existing monitor instead of creating one.
 *
 * Read-only (ce:GetAnomalyMonitors). Cost Explorer is a global service served
 * from us-east-1 regardless of the deploy region.
 */
export async function findServiceAnomalyMonitor(
  client?: SendClient,
): Promise<AnomalyMonitorSummary | null> {
  const ce: SendClient = client ?? new CostExplorerClient({ region: 'us-east-1' });
  let token: string | undefined;
  do {
    const out = (await ce.send(
      new GetAnomalyMonitorsCommand({ NextPageToken: token, MaxResults: 100 }),
    )) as {
      AnomalyMonitors?: Array<{
        MonitorArn?: string;
        MonitorName?: string;
        MonitorType?: string;
        MonitorDimension?: string;
      }>;
      NextPageToken?: string;
    };
    for (const m of out.AnomalyMonitors ?? []) {
      if (m.MonitorType === 'DIMENSIONAL' && m.MonitorDimension === 'SERVICE' && m.MonitorArn) {
        return { arn: m.MonitorArn, name: m.MonitorName ?? m.MonitorArn };
      }
    }
    token = out.NextPageToken;
  } while (token);
  return null;
}
