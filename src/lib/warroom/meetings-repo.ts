import { randomUUID } from 'node:crypto';
import {
  GetCommand,
  PutCommand,
  UpdateCommand,
  ScanCommand,
  QueryCommand,
  DeleteCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { ddb } from '../state/ddb.js';
import type { Meeting } from './types.js';

const TABLE = process.env.TABLE_WARROOM_MEETINGS ?? 'claudeclaw-warroom-meetings';
const TURNS_TABLE = process.env.TABLE_WARROOM_TURNS ?? 'claudeclaw-warroom-turns';

export async function createMeeting(args: {
  createdBy: string;
  title: string;
  participants: string[];
  toolPolicyOverride?: Record<string, boolean>;
  importMemoriesFrom?: string[];
}): Promise<Meeting> {
  const meetingId = randomUUID();
  const meeting: Meeting = {
    meetingId,
    createdBy: args.createdBy,
    title: args.title,
    status: 'active',
    participants: args.participants,
    membershipVersion: 1,
    toolPolicyOverride: args.toolPolicyOverride,
    importMemoriesFrom: args.importMemoriesFrom ?? [],
    createdAt: new Date().toISOString(),
  };
  await ddb().send(
    new PutCommand({
      TableName: TABLE,
      Item: { PK: `MEETING#${meetingId}`, SK: 'META', ...meeting },
    }),
  );
  return meeting;
}

export async function getMeeting(meetingId: string): Promise<Meeting | null> {
  const out = await ddb().send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: `MEETING#${meetingId}`, SK: 'META' },
    }),
  );
  return out.Item ? (out.Item as Meeting) : null;
}

export async function endMeeting(meetingId: string): Promise<void> {
  await ddb().send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `MEETING#${meetingId}`, SK: 'META' },
      UpdateExpression: 'SET #s = :s, endedAt = :t',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': 'ended', ':t': new Date().toISOString() },
    }),
  );
}

export async function addParticipant(meetingId: string, userId: string): Promise<number> {
  try {
    const result = await ddb().send(
      new UpdateCommand({
        TableName: TABLE,
        Key: { PK: `MEETING#${meetingId}`, SK: 'META' },
        UpdateExpression: 'SET participants = list_append(participants, :p), membershipVersion = membershipVersion + :one',
        // A double-submitted add (double-click, retry after a timeout that
        // actually landed) must not duplicate the id: a duplicate replies
        // twice per round, spends double, and eats one of the capped
        // responder slots.
        ConditionExpression: 'NOT contains(participants, :uid)',
        ExpressionAttributeValues: { ':p': [userId], ':one': 1, ':uid': userId },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return (result.Attributes as Meeting).membershipVersion;
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      // Already a participant: idempotent success.
      const meeting = await getMeeting(meetingId);
      if (meeting) return meeting.membershipVersion;
    }
    throw err;
  }
}

export async function removeParticipant(meetingId: string, userId: string): Promise<number> {
  const meeting = await getMeeting(meetingId);
  if (!meeting) throw new Error('meeting not found');
  const updated = meeting.participants.filter((p) => p !== userId);
  const result = await ddb().send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `MEETING#${meetingId}`, SK: 'META' },
      UpdateExpression: 'SET participants = :p, membershipVersion = membershipVersion + :one',
      ExpressionAttributeValues: { ':p': updated, ':one': 1 },
      ReturnValues: 'ALL_NEW',
    }),
  );
  return (result.Attributes as Meeting).membershipVersion;
}

/**
 * Stamp recency (and, once, the first-message preview) onto the meeting META row
 * so the room list can render a meaningful title + timestamp without scanning
 * every transcript. lastActivityAt is bumped on every turn; preview is written
 * once via if_not_exists, so it captures the FIRST user message and never gets
 * overwritten by later turns. Called fire-and-forget from publishTurn — a
 * failure here must never fail the turn write.
 */
export async function touchMeetingActivity(
  meetingId: string,
  ts: string,
  preview?: string,
): Promise<void> {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = { ':t': ts };
  let expr = 'SET lastActivityAt = :t';
  if (preview !== undefined && preview !== '') {
    names['#p'] = 'preview';
    values[':p'] = preview;
    expr += ', #p = if_not_exists(#p, :p)';
  }
  await ddb().send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `MEETING#${meetingId}`, SK: 'META' },
      UpdateExpression: expr,
      ...(Object.keys(names).length ? { ExpressionAttributeNames: names } : {}),
      ExpressionAttributeValues: values,
    }),
  );
}

/**
 * Permanently delete a meeting and its transcript. Removes the transcript rows
 * first (paged + batched), then the META row, so a partial failure leaves the
 * meeting listable for a retry rather than orphaning turns under a meeting that
 * has vanished. Idempotent: deleting an already-gone meeting is a no-op.
 */
export async function deleteMeeting(meetingId: string): Promise<void> {
  let lastKey: Record<string, unknown> | undefined;
  do {
    const out = await ddb().send(
      new QueryCommand({
        TableName: TURNS_TABLE,
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': `MEETING#${meetingId}` },
        ProjectionExpression: 'PK, SK',
        ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        Limit: 100,
      }),
    );
    const items = (out.Items ?? []) as Array<{ PK: string; SK: string }>;
    for (let i = 0; i < items.length; i += 25) {
      const chunk = items.slice(i, i + 25);
      await ddb().send(
        new BatchWriteCommand({
          RequestItems: {
            [TURNS_TABLE]: chunk.map((it) => ({ DeleteRequest: { Key: { PK: it.PK, SK: it.SK } } })),
          },
        }),
      );
    }
    lastKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  await ddb().send(
    new DeleteCommand({
      TableName: TABLE,
      Key: { PK: `MEETING#${meetingId}`, SK: 'META' },
    }),
  );
}

export async function listMyMeetings(userId: string, limit = 20): Promise<Meeting[]> {
  const out = await ddb().send(
    new ScanCommand({
      TableName: TABLE,
      FilterExpression: 'SK = :sk AND (createdBy = :uid OR contains(participants, :uid))',
      ExpressionAttributeValues: { ':sk': 'META', ':uid': userId },
      Limit: limit * 10,
    }),
  );
  // Most-recently-active first (fall back to createdAt for rooms that predate
  // the lastActivityAt denormalization), so the list reads newest-at-top.
  const recency = (m: Meeting) => Date.parse(m.lastActivityAt ?? m.createdAt ?? '') || 0;
  return ((out.Items ?? []) as Meeting[])
    .sort((a, b) => recency(b) - recency(a))
    .slice(0, limit);
}
