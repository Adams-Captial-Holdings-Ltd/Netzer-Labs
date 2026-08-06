/**
 * Inter-agent task queue.
 *
 * Lets one agent push a unit of work to another. The recipient picks
 * up the task from its inbox the next time it runs a turn, or on a
 * dedicated /api/inter-agent/drain.
 *
 * Schema:
 *   PK = AGENT#<toAgent>
 *   SK = TASK#<isoTime>#<id>
 *   GSI1PK = FROM#<fromAgent>
 *   GSI1SK = <isoTime>#<id>
 */

import { randomUUID } from 'node:crypto';
import {
  DeleteCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ddb } from './ddb.js';

const TABLE = process.env.TABLE_INTER_AGENT_TASKS ?? 'claudeclaw-inter-agent-tasks';
const TTL_DAYS = 7;

export type InterAgentTaskStatus = 'queued' | 'delivered' | 'completed';

export interface InterAgentTask {
  id: string;
  fromAgent: string;
  toAgent: string;
  fromChat: string;
  /** Optional chat scope on the recipient side (so reply lands somewhere). */
  toChat?: string;
  messageText: string;
  /** "fyi" = no reply expected. "request" = recipient should reply. */
  intent: 'fyi' | 'request';
  status: InterAgentTaskStatus;
  createdAt: string;
}

export async function sendInterAgent(args: {
  fromAgent: string;
  fromChat: string;
  toAgent: string;
  toChat?: string;
  messageText: string;
  intent?: 'fyi' | 'request';
}): Promise<InterAgentTask> {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const ttl = Math.floor(Date.now() / 1000) + TTL_DAYS * 86400;
  const task: InterAgentTask = {
    id,
    fromAgent: args.fromAgent,
    fromChat: args.fromChat,
    toAgent: args.toAgent,
    ...(args.toChat ? { toChat: args.toChat } : {}),
    messageText: args.messageText,
    intent: args.intent ?? 'fyi',
    status: 'queued',
    createdAt,
  };
  await ddb().send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `AGENT#${args.toAgent}`,
        SK: `TASK#${createdAt}#${id}`,
        GSI1PK: `FROM#${args.fromAgent}`,
        GSI1SK: `${createdAt}#${id}`,
        ttl,
        ...task,
      },
    }),
  );
  return task;
}

export async function listInbox(
  toAgent: string,
  limit = 50,
  statuses: InterAgentTaskStatus[] = ['queued', 'delivered'],
): Promise<InterAgentTask[]> {
  const out = await ddb().send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `AGENT#${toAgent}` },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  const rows = (out.Items ?? []).map((i) =>
    toTask(i as Record<string, unknown>),
  );
  return rows.filter((r) => statuses.includes(r.status));
}

export async function markStatus(
  task: InterAgentTask,
  status: InterAgentTaskStatus,
): Promise<void> {
  await ddb().send(
    new UpdateCommand({
      TableName: TABLE,
      Key: {
        PK: `AGENT#${task.toAgent}`,
        SK: `TASK#${task.createdAt}#${task.id}`,
      },
      UpdateExpression: 'SET #s = :s',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': status },
    }),
  );
}

export async function deleteInterAgentTask(task: InterAgentTask): Promise<void> {
  await ddb().send(
    new DeleteCommand({
      TableName: TABLE,
      Key: {
        PK: `AGENT#${task.toAgent}`,
        SK: `TASK#${task.createdAt}#${task.id}`,
      },
    }),
  );
}

function toTask(i: Record<string, unknown>): InterAgentTask {
  return {
    id: String(i.id ?? ''),
    fromAgent: String(i.fromAgent ?? ''),
    toAgent: String(i.toAgent ?? ''),
    fromChat: String(i.fromChat ?? ''),
    ...(i.toChat ? { toChat: String(i.toChat) } : {}),
    messageText: String(i.messageText ?? ''),
    intent: (i.intent as 'fyi' | 'request' | undefined) ?? 'fyi',
    status: (i.status as InterAgentTaskStatus | undefined) ?? 'queued',
    createdAt: String(i.createdAt ?? ''),
  };
}
