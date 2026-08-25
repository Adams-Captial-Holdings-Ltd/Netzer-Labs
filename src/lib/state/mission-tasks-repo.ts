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
 *   GSI1PK = STATUS#<open|in_progress|blocked|in_review|done|cancelled>#AGENT#<owner>
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
 * they reach the status field and the GSI1PK partition key.
 *
 * THE ORDER IS THE BOARD'S LANE ORDER, left to right, and it is contract: the
 * `invalid_status` 400 serialises `valid: MISSION_STATUSES` verbatim, and
 * `MISSION_STATUS_WORDS` builds the `/missions [...]` help line from it.
 *
 * `blocked` and `in_review` (Phase 9) are the two Paperclip statuses this list
 * used to have no room for, so `toMissionStatus` collapsed them into `open`
 * and `in_progress` and a stalled mission read as merely un-started.
 *
 * THE ORDER IS THE REPOSITORY OWNER'S DECISION, and the rationale is the point:
 * it reads as the STORY OF A TASK — you start it (open), you work it
 * (in_progress), you get stuck (blocked), you unstick it and send it for review
 * (in_review), it lands (done). It also keeps the four original lanes — open,
 * in_progress, done, cancelled — in their existing RELATIVE positions, so
 * nobody has to relearn a board they already know; the two new lanes are
 * inserted between them rather than displacing them.
 *
 * WIDENING THIS LIST ALSO WIDENS THE LEGACY DYNAMODB PATH, deliberately.
 * `MISSION_STATUSES` is what the dashboard's status route validates against
 * before a value reaches the `status` attribute and the GSI1PK partition key,
 * so a legacy install will now ACCEPT `blocked`/`in_review` writes. That is
 * the right call and it is not a widening of what the legacy path can PRODUCE:
 * nothing on it mints either value (Haiku assignment opens `open`, the repo's
 * own transitions are the four old words), so the only way one arrives is an
 * operator pressing a lane button that the very same six-lane board draws.
 * Accepting a status the board can render and refusing it in the store would
 * be the drift this constant exists to prevent — and the guard still keeps
 * arbitrary strings out of the partition key, which is the whole job. */
export const MISSION_STATUSES = [
  'open',
  'in_progress',
  'blocked',
  'in_review',
  'done',
  'cancelled',
] as const;

export type MissionStatus = (typeof MISSION_STATUSES)[number];

export const MISSION_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
export type MissionPriority = (typeof MISSION_PRIORITIES)[number];

export interface Mission {
  id: string;
  ownerAgent: string;
  createdByAgent: string;
  createdByChat: string;
  title: string;
  body: string;
  priority: MissionPriority;
  status: MissionStatus;
  /** Optional rationale Haiku gave for picking the owner. */
  assignmentReason?: string;
  createdAt: string;
  updatedAt: string;
}

function priorityRank(priority: MissionPriority): string {
  // Keep the legacy 000-100 sort-key scale so pre-Phase-9 numeric rows and new
  // four-band rows remain correctly interleaved in the same GSI partition.
  return String({ critical: 95, high: 80, medium: 50, low: 20 }[priority]).padStart(3, '0');
}

/** Reads pre-Phase-9 numeric DynamoDB rows without leaking the retired domain. */
export function normalizeMissionPriority(value: unknown): MissionPriority {
  if (MISSION_PRIORITIES.includes(value as MissionPriority)) return value as MissionPriority;
  const score = Number(value);
  if (!Number.isFinite(score)) return 'medium';
  if (score >= 90) return 'critical';
  if (score >= 70) return 'high';
  if (score >= 40) return 'medium';
  return 'low';
}

export async function createMission(args: {
  ownerAgent: string;
  createdByAgent: string;
  createdByChat: string;
  title: string;
  body: string;
  priority?: MissionPriority;
  assignmentReason?: string;
}): Promise<Mission> {
  const id = randomUUID();
  const createdAt = new Date().toISOString();
  const priority = args.priority ?? 'medium';
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
        GSI1SK: `PRIORITY#${priorityRank(priority)}#${createdAt}`,
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
        GSI1SK: `PRIORITY#${priorityRank(moved.priority)}#${moved.createdAt}`,
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
    priority: normalizeMissionPriority(i.priority),
    status: (i.status as MissionStatus | undefined) ?? 'open',
    ...(i.assignmentReason ? { assignmentReason: String(i.assignmentReason) } : {}),
    createdAt: String(i.createdAt ?? ''),
    updatedAt: String(i.updatedAt ?? i.createdAt ?? ''),
  };
}
