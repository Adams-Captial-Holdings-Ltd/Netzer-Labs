/**
 * Consolidations repo. Stores the results of memory consolidation runs.
 *
 * Schema:
 *   PK = AGENT#<agentId>
 *   SK = CONSOL#<consolidationId>
 */

import { PutCommand, QueryCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { createHash } from 'node:crypto';
import { ddb } from './ddb.js';

const TABLE = process.env.TABLE_CONSOLIDATIONS ?? 'claudeclaw-consolidations';

export interface Consolidation {
  consolidationId: string;
  agentId: string;
  chatId: string;
  summary: string;
  sourceMemoryIds: string[];
  importance: number;
  createdAt: string;
}

export function deriveConsolidationId(agentId: string, chatId: string, memoryIds: string[]): string {
  const sorted = [...memoryIds].sort();
  const hash = createHash('sha256')
    .update(`${agentId}:${chatId}:${sorted.join(',')}`)
    .digest('hex')
    .slice(0, 16);
  return `consol-${hash}`;
}

export async function getConsolidation(
  agentId: string,
  consolidationId: string,
): Promise<Consolidation | null> {
  const out = await ddb().send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: `AGENT#${agentId}`, SK: `CONSOL#${consolidationId}` },
    }),
  );
  return out.Item ? (out.Item as Consolidation) : null;
}

export async function writeConsolidation(c: Consolidation): Promise<void> {
  await ddb().send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `AGENT#${c.agentId}`,
        SK: `CONSOL#${c.consolidationId}`,
        ...c,
      },
    }),
  );
}

export async function listConsolidations(
  agentId: string,
  chatId?: string,
  limit = 20,
): Promise<Consolidation[]> {
  const out = await ddb().send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `AGENT#${agentId}`,
        ':sk': 'CONSOL#',
      },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  const items = (out.Items ?? []) as Consolidation[];
  if (chatId) return items.filter((c) => c.chatId === chatId);
  return items;
}
