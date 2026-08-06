/**
 * Skills dispatcher. Synchronous Lambda invoke with cached prior response.
 * Uses the same idempotency contract as hooks (EXT#<skillId>#<hash>).
 */

import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { createHash } from 'node:crypto';
import { ddb } from '../state/ddb.js';
import { isKillSwitchActive } from '../state/kill-switches-repo.js';
import { logger } from '../../observability/logger.js';
import { captureAwsClient } from '../observability/xray.js';
import type { SkillInvocation, SkillResult } from './types.js';

const region = process.env.AWS_REGION ?? 'us-east-1';
const IDEMPOTENCY_TABLE = process.env.TABLE_HOOK_IDEMPOTENCY ?? 'claudeclaw-hook-idempotency';

let _lambda: LambdaClient | null = null;
function lambda(): LambdaClient {
  if (!_lambda) _lambda = captureAwsClient(new LambdaClient({ region }));
  return _lambda;
}

function deriveInvocationId(skillId: string, input: Record<string, unknown>): string {
  const hash = createHash('sha256')
    .update(JSON.stringify(input))
    .digest('hex')
    .slice(0, 16);
  return `EXT#${skillId}#${hash}`;
}

async function getCachedResult(invocationId: string): Promise<SkillResult | null> {
  const out = await ddb().send(
    new GetCommand({
      TableName: IDEMPOTENCY_TABLE,
      Key: { PK: invocationId, SK: 'RESULT' },
    }),
  );
  if (!out.Item) return null;
  return { text: String(out.Item.text ?? ''), isError: Boolean(out.Item.isError), cached: true };
}

async function cacheResult(invocationId: string, result: SkillResult): Promise<void> {
  await ddb().send(
    new PutCommand({
      TableName: IDEMPOTENCY_TABLE,
      Item: {
        PK: invocationId,
        SK: 'RESULT',
        text: result.text,
        isError: result.isError,
        cachedAt: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + 3600,
      },
    }),
  );
}

export async function invokeSkill(
  lambdaArn: string,
  invocation: SkillInvocation,
): Promise<SkillResult> {
  const disabled = await isKillSwitchActive('skills_disabled').catch(() => ({ active: false }));
  if (disabled.active) {
    return { text: 'Skills are currently disabled.', isError: true, cached: false };
  }

  const invocationId = deriveInvocationId(invocation.skillId, invocation.input);
  const cached = await getCachedResult(invocationId);
  if (cached) return cached;

  try {
    const resp = await lambda().send(
      new InvokeCommand({
        FunctionName: lambdaArn,
        InvocationType: 'RequestResponse',
        Payload: Buffer.from(JSON.stringify(invocation)),
      }),
    );

    const payload = resp.Payload ? JSON.parse(Buffer.from(resp.Payload).toString()) : {};
    const result: SkillResult = {
      text: String(payload.text ?? payload.body ?? ''),
      isError: Boolean(payload.isError || resp.FunctionError),
      cached: false,
    };

    await cacheResult(invocationId, result);
    return result;
  } catch (err) {
    logger.error({ skillId: invocation.skillId, err: err instanceof Error ? err.message : String(err) }, 'skill invoke failed');
    return { text: `Skill invocation failed: ${err instanceof Error ? err.message : String(err)}`, isError: true, cached: false };
  }
}
