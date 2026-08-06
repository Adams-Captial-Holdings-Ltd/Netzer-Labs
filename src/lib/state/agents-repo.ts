/**
 * Agents repository — CRUD for agent metadata.
 *
 * Schema (DDB agents table):
 *   PK: AGENT#<agentId>
 *   SK: META
 *
 * All fields from AgentMetadata are stored as top-level attributes
 * alongside PK/SK. Callers pass plain agentId; the PK prefix is
 * handled internally.
 */

import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ddb } from './ddb.js';
import { logger } from '../../observability/logger.js';
import type { AgentMetadata, AgentStatus } from '../agents/types.js';

const TABLE = () => process.env.TABLE_AGENTS ?? 'claudeclaw-agents';
function pk(agentId: string) { return `AGENT#${agentId}`; }
const SK = 'META';

/** Strip DDB key attributes and return a clean AgentMetadata. */
function toAgent(item: Record<string, unknown>): AgentMetadata {
  const { PK, SK: _sk, ...rest } = item;
  return rest as unknown as AgentMetadata;
}

/**
 * List every agent in the table. Pages through ALL Scan pages: a single Scan
 * returns at most ~1MB, so without following LastEvaluatedKey a large fleet
 * would silently drop agents past the first page. Several callers depend on a
 * COMPLETE list (the usage/cost-cap accounting walk in token-tracker, the
 * agents list UI), so completeness matters here.
 */
export async function listAgents(): Promise<AgentMetadata[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const out = await ddb().send(
      new ScanCommand({
        TableName: TABLE(),
        FilterExpression: 'SK = :sk',
        ExpressionAttributeValues: { ':sk': SK },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    for (const i of out.Items ?? []) items.push(i as Record<string, unknown>);
    exclusiveStartKey = out.LastEvaluatedKey;
  } while (exclusiveStartKey);
  return items.map((i) => toAgent(i));
}

/** Fetch a single agent by id. Returns null when not found. */
export async function getAgent(agentId: string): Promise<AgentMetadata | null> {
  const out = await ddb().send(
    new GetCommand({
      TableName: TABLE(),
      Key: { PK: pk(agentId), SK },
    }),
  );
  if (!out.Item) return null;
  return toAgent(out.Item as Record<string, unknown>);
}

/**
 * Create a new agent. Fails with ConditionalCheckFailedException if
 * an agent with the same id already exists.
 */
export async function createAgent(agent: AgentMetadata): Promise<void> {
  await ddb().send(
    new PutCommand({
      TableName: TABLE(),
      Item: {
        PK: pk(agent.agentId),
        SK,
        ...agent,
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  );
  logger.info({ agentId: agent.agentId }, 'agent created');
}

/**
 * Partial update. Builds a SET expression dynamically from the
 * provided keys and always bumps updatedAt.
 */
export async function updateAgent(
  agentId: string,
  updates: Partial<AgentMetadata>,
): Promise<void> {
  const fields = { ...updates, updatedAt: new Date().toISOString() };

  // Reserved words in DDB (status, description, etc.) need
  // ExpressionAttributeNames to avoid conflicts.
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const setParts: string[] = [];
  const removeParts: string[] = [];

  let idx = 0;
  for (const [key, val] of Object.entries(fields)) {
    if (key === 'agentId') continue; // never update the primary id
    const nameAlias = `#f${idx}`;
    names[nameAlias] = key;
    if (val === undefined) {
      // Clearing a field MUST use REMOVE. The doc client is configured with
      // removeUndefinedValues:true (ddb.ts), so a SET with an undefined value
      // strips the :v alias and leaves a dangling reference -> DynamoDB
      // ValidationException. That is exactly what made Telegram/Slack Disconnect
      // silently fail and leave bot credentials in the row.
      removeParts.push(nameAlias);
    } else {
      const valAlias = `:v${idx}`;
      values[valAlias] = val;
      setParts.push(`${nameAlias} = ${valAlias}`);
    }
    idx++;
  }

  if (setParts.length === 0 && removeParts.length === 0) return;

  const clauses: string[] = [];
  if (setParts.length) clauses.push(`SET ${setParts.join(', ')}`);
  if (removeParts.length) clauses.push(`REMOVE ${removeParts.join(', ')}`);

  await ddb().send(
    new UpdateCommand({
      TableName: TABLE(),
      Key: { PK: pk(agentId), SK },
      UpdateExpression: clauses.join(' '),
      ExpressionAttributeNames: names,
      ...(Object.keys(values).length ? { ExpressionAttributeValues: values } : {}),
    }),
  );
  logger.info({ agentId, updatedFields: Object.keys(updates) }, 'agent updated');
}

/** Delete an agent row. */
export async function deleteAgent(agentId: string): Promise<void> {
  await ddb().send(
    new DeleteCommand({
      TableName: TABLE(),
      Key: { PK: pk(agentId), SK },
    }),
  );
  logger.info({ agentId }, 'agent deleted');
}

/** Convenience: flip an agent's status field. */
export async function setAgentStatus(
  agentId: string,
  status: AgentStatus,
): Promise<void> {
  await updateAgent(agentId, { status });
}
