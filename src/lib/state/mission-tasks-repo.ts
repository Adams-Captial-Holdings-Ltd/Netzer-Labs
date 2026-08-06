/**
 * Mission tasks repo — work units bigger than a chat reply.
 *
 * Where `inter-agent-tasks` is a lightweight DM queue, missions are
 * persistent, status-tracked, and meant to land on a kanban-style view
 * in the dashboard. Haiku assigns the owner agent at creation time.
 *
 * Schema:
 *   PK = AGENT#<ownerAgent>
 *   SK = MISSION#<isoCreated>#<id>
 *   GSI1PK = STATUS#<open|in_progress|done|cancelled>#AGENT#<owner>
 *   GSI1SK = PRIORITY#<padded>#<isoCreated>
 */

import { randomUUID } from 'node:crypto';
import {
  DeleteCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { ddb } from './ddb.js';

const TABLE = process.env.TABLE_MISSION_TASKS ?? 'claudeclaw-mission-tasks';

/** Runtime list of valid mission statuses; the type below derives from it so
 * the two can never drift. Used to validate inbound status mutations before
 * they reach the status field and the GSI1PK partition key. */
export const MISSION_STATUSES = [
  'open',
  'in_progress',
  'done',
  'cancelled',
] as const;

export type MissionStatus = (typeof MISSION_STATUSES)[number];

export interface Mission {
  id: string;
  ownerAgent: string;
  createdByAgent: string;
  createdByChat: string;
  title: string;
  body: string;
  /** 0-100, higher = more urgent. */
  priority: number;
  status: MissionStatus;
  /** Optional rationale Haiku gave for picking the owner. */
  assignmentReason?: string;
  /** Optional ISO deadline. */
  dueAt?: string;
  createdAt: string;
  updatedAt: string;
}

function padPriority(n: number): string {
  return String(Math.max(0, Math.min(100, Math.round(n)))).padStart(3, '0');
}

export async function createMission(args: {
  ownerAgent: string;
  createdByAgent: string;
  createdByChat: string;
  title: string;
  body: string;
  priority?: number;
  assignmentReason?: string;
  dueAt?: string;
}): Promise<Mission> {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const priority = args.priority ?? 50;
  const mission: Mission = {
    id,
    ownerAgent: args.ownerAgent,
    createdByAgent: args.createdByAgent,
    createdByChat: args.createdByChat,
    title: args.title,
    body: args.body,
    priority,
    status: 'open',
    ...(args.assignmentReason ? { assignmentReason: args.assignmentReason } : {}),
    ...(args.dueAt ? { dueAt: args.dueAt } : {}),
    createdAt,
    updatedAt: createdAt,
  };
  await ddb().send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `AGENT#${args.ownerAgent}`,
        SK: `MISSION#${createdAt}#${id}`,
        GSI1PK: `STATUS#open#AGENT#${args.ownerAgent}`,
        GSI1SK: `PRIORITY#${padPriority(priority)}#${createdAt}`,
        ...mission,
      },
    }),
  );
  return mission;
}

export async function listMissionsForAgent(
  ownerAgent: string,
  limit = 25,
): Promise<Mission[]> {
  const out = await ddb().send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `AGENT#${ownerAgent}` },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return (out.Items ?? []).map((i) => toMission(i as Record<string, unknown>));
}

export async function listMissionsByStatus(
  ownerAgent: string,
  status: MissionStatus,
  limit = 25,
): Promise<Mission[]> {
  const out = await ddb().send(
    new QueryCommand({
      TableName: TABLE,
      IndexName: 'gsi1-status-agent-priority',
      KeyConditionExpression: 'GSI1PK = :pk',
      ExpressionAttributeValues: {
        ':pk': `STATUS#${status}#AGENT#${ownerAgent}`,
      },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return (out.Items ?? []).map((i) => toMission(i as Record<string, unknown>));
}

export async function updateMissionStatus(
  ownerAgent: string,
  missionId: string,
  status: MissionStatus,
): Promise<boolean> {
  const all = await listMissionsForAgent(ownerAgent, 200);
  const target = all.find((m) => m.id === missionId || m.id.startsWith(missionId));
  if (!target) return false;
  const now = new Date().toISOString();
  await ddb().send(
    new UpdateCommand({
      TableName: TABLE,
      Key: {
        PK: `AGENT#${ownerAgent}`,
        SK: `MISSION#${target.createdAt}#${target.id}`,
      },
      UpdateExpression:
        'SET #s = :s, updatedAt = :u, GSI1PK = :pk',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: {
        ':s': status,
        ':u': now,
        ':pk': `STATUS#${status}#AGENT#${ownerAgent}`,
      },
    }),
  );
  return true;
}

/**
 * Move a mission to a different owner agent. The owner is part of the
 * partition key (PK = AGENT#<owner>), so a reassign is a delete-then-put
 * under the new partition rather than an in-place SET. The mission id,
 * created timestamp, priority, status, and body are preserved; ownerAgent,
 * the GSI1PK owner segment, and updatedAt are rewritten. Returns the
 * reassigned mission, or null when no mission matches for the current owner.
 */
export async function reassignMission(
  currentOwner: string,
  missionId: string,
  newOwner: string,
): Promise<Mission | null> {
  const all = await listMissionsForAgent(currentOwner, 200);
  const target = all.find((m) => m.id === missionId || m.id.startsWith(missionId));
  if (!target) return null;
  if (newOwner === currentOwner) return target;

  const now = new Date().toISOString();
  const moved: Mission = { ...target, ownerAgent: newOwner, updatedAt: now };

  // Put the row under the new owner first so a failure between the two
  // writes leaves the mission discoverable rather than lost.
  await ddb().send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `AGENT#${newOwner}`,
        SK: `MISSION#${moved.createdAt}#${moved.id}`,
        GSI1PK: `STATUS#${moved.status}#AGENT#${newOwner}`,
        GSI1SK: `PRIORITY#${padPriority(moved.priority)}#${moved.createdAt}`,
        ...moved,
      },
    }),
  );
  await ddb().send(
    new DeleteCommand({
      TableName: TABLE,
      Key: {
        PK: `AGENT#${currentOwner}`,
        SK: `MISSION#${target.createdAt}#${target.id}`,
      },
    }),
  );
  return moved;
}

function toMission(i: Record<string, unknown>): Mission {
  return {
    id: String(i.id ?? ''),
    ownerAgent: String(i.ownerAgent ?? ''),
    createdByAgent: String(i.createdByAgent ?? ''),
    createdByChat: String(i.createdByChat ?? ''),
    title: String(i.title ?? ''),
    body: String(i.body ?? ''),
    priority: Number(i.priority ?? 50),
    status: (i.status as MissionStatus | undefined) ?? 'open',
    ...(i.assignmentReason ? { assignmentReason: String(i.assignmentReason) } : {}),
    ...(i.dueAt ? { dueAt: String(i.dueAt) } : {}),
    createdAt: String(i.createdAt ?? ''),
    updatedAt: String(i.updatedAt ?? i.createdAt ?? ''),
  };
}
