import { GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../state/ddb.js';

const TABLE = process.env.TABLE_EXTENSIONS_REGISTRY ?? 'claudeclaw-extensions-registry';

export interface HookRegistration {
  hookId: string;
  event: string;
  lambdaArn: string;
  enabled: boolean;
  createdAt: string;
}

export async function getHook(hookId: string): Promise<HookRegistration | null> {
  const out = await ddb().send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: `HOOK#${hookId}`, SK: 'META' },
    }),
  );
  return out.Item ? (out.Item as HookRegistration) : null;
}

export async function listHooksForEvent(event: string): Promise<HookRegistration[]> {
  const out = await ddb().send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `EVENT#${event}` },
    }),
  );
  return ((out.Items ?? []) as HookRegistration[]).filter((h) => h.enabled);
}

export async function registerHook(hook: HookRegistration): Promise<void> {
  await ddb().send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `HOOK#${hook.hookId}`,
        SK: 'META',
        ...hook,
      },
    }),
  );
  await ddb().send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `EVENT#${hook.event}`,
        SK: `HOOK#${hook.hookId}`,
        ...hook,
      },
    }),
  );
}
