/**
 * Seat / seat-policy / seat-usage persistence.
 *
 * Single-table design in the EXISTING claudeclaw-users table (no new table),
 * mirroring how custom profiles co-locate there. Key namespaces, chosen to
 * never collide with the table's other item kinds (USER#<id>/PROFILE user
 * rows, MAGIC#<hash>/STATE magic tokens, PROFILE_DEF#<id>/DEF custom
 * profiles — and note listUsers() scans with FilterExpression SK='PROFILE',
 * which none of these SKs match):
 *
 *   PK = SEATS               SK = SEAT#<seatId>                 seat rows
 *   PK = USER#<userId>       SK = SEAT                          user→seat link
 *   PK = SEAT_POLICIES       SK = POLICY#<policyId>             policy rows
 *   PK = USAGE#<yyyy-mm-dd>  SK = SEAT#<seatId>#<ts>#<usageId>  usage rows
 *
 * The usage partition is per-day and the SK leads with the seatId, so
 * "one seat's usage for a day" is a begins_with key condition, not a filter.
 * Lists are cursor-paginated (base64url LastEvaluatedKey), never scans.
 *
 * Absorbed from PR #42's seat-repo, minus the workspace item kinds.
 */

import {
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { ddb } from '../state/ddb.js';
import type { Page, Seat, SeatPolicy, SeatUsage } from './seat-model.js';

const TABLE = process.env.TABLE_USERS ?? 'claudeclaw-users';

function encodeCursor(key: Record<string, unknown> | undefined): string | undefined {
  if (!key) return undefined;
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): Record<string, unknown> | undefined {
  if (!cursor) return undefined;
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    // A garbage cursor restarts the list rather than 500ing the page.
    return undefined;
  }
}

function nowIso(now = Date.now()): string {
  return new Date(now).toISOString();
}

/**
 * Write a seat: the canonical row plus the USER#<userId>/SEAT link item that
 * makes "which seat does this user hold" a point read. One seat per user by
 * design — a second putSeat for the same user repoints the link.
 */
export async function putSeat(seat: Seat): Promise<Seat> {
  await ddb().send(
    new PutCommand({
      TableName: TABLE,
      Item: { PK: 'SEATS', SK: `SEAT#${seat.seatId}`, ...seat },
    }),
  );
  await ddb().send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `USER#${seat.userId}`,
        SK: 'SEAT',
        seatId: seat.seatId,
        userId: seat.userId,
        policyId: seat.policyId,
        status: seat.status,
        updatedAt: seat.updatedAt,
      },
    }),
  );
  return seat;
}

export async function getSeat(seatId: string): Promise<Seat | null> {
  const out = await ddb().send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: 'SEATS', SK: `SEAT#${seatId}` },
    }),
  );
  return (out.Item as Seat | undefined) ?? null;
}

export async function getSeatForUser(userId: string): Promise<Seat | null> {
  const link = await ddb().send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: `USER#${userId}`, SK: 'SEAT' },
    }),
  );
  const seatId = typeof link.Item?.seatId === 'string' ? link.Item.seatId : null;
  return seatId ? getSeat(seatId) : null;
}

export async function listSeats(
  args: { limit?: number; cursor?: string } = {},
): Promise<Page<Seat>> {
  const out = await ddb().send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': 'SEATS', ':sk': 'SEAT#' },
      Limit: args.limit ?? 50,
      ExclusiveStartKey: decodeCursor(args.cursor),
    }),
  );
  return {
    items: (out.Items ?? []) as Seat[],
    nextCursor: encodeCursor(out.LastEvaluatedKey),
  };
}

export async function putSeatPolicy(policy: SeatPolicy): Promise<SeatPolicy> {
  await ddb().send(
    new PutCommand({
      TableName: TABLE,
      Item: { PK: 'SEAT_POLICIES', SK: `POLICY#${policy.policyId}`, ...policy },
    }),
  );
  return policy;
}

export async function getSeatPolicy(policyId: string): Promise<SeatPolicy | null> {
  const out = await ddb().send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: 'SEAT_POLICIES', SK: `POLICY#${policyId}` },
    }),
  );
  return (out.Item as SeatPolicy | undefined) ?? null;
}

export async function listSeatPolicies(
  args: { limit?: number; cursor?: string } = {},
): Promise<Page<SeatPolicy>> {
  const out = await ddb().send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: { ':pk': 'SEAT_POLICIES', ':sk': 'POLICY#' },
      Limit: args.limit ?? 50,
      ExclusiveStartKey: decodeCursor(args.cursor),
    }),
  );
  return {
    items: (out.Items ?? []) as SeatPolicy[],
    nextCursor: encodeCursor(out.LastEvaluatedKey),
  };
}

export async function putSeatUsage(usage: SeatUsage): Promise<SeatUsage> {
  await ddb().send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `USAGE#${usage.createdAt.slice(0, 10)}`,
        SK: `SEAT#${usage.seatId}#${usage.createdAt}#${usage.usageId}`,
        ...usage,
      },
    }),
  );
  return usage;
}

/** Org-wide usage for one day, newest first. */
export async function listSeatUsage(args: {
  date: string;
  limit?: number;
  cursor?: string;
}): Promise<Page<SeatUsage>> {
  const out = await ddb().send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `USAGE#${args.date}` },
      Limit: args.limit ?? 50,
      ExclusiveStartKey: decodeCursor(args.cursor),
      ScanIndexForward: false,
    }),
  );
  return {
    items: (out.Items ?? []) as SeatUsage[],
    nextCursor: encodeCursor(out.LastEvaluatedKey),
  };
}

/**
 * One seat's usage for one day, newest first. A key condition (the SK leads
 * with the seatId), not a post-filter, so a busy org day cannot starve one
 * seat's page.
 */
export async function listSeatUsageForSeat(args: {
  date: string;
  seatId: string;
  limit?: number;
  cursor?: string;
}): Promise<Page<SeatUsage>> {
  const out = await ddb().send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
      ExpressionAttributeValues: {
        ':pk': `USAGE#${args.date}`,
        ':sk': `SEAT#${args.seatId}#`,
      },
      Limit: args.limit ?? 50,
      ExclusiveStartKey: decodeCursor(args.cursor),
      ScanIndexForward: false,
    }),
  );
  return {
    items: (out.Items ?? []) as SeatUsage[],
    nextCursor: encodeCursor(out.LastEvaluatedKey),
  };
}

export function newSeat(
  args: Partial<Seat> & Pick<Seat, 'seatId' | 'userId' | 'policyId'>,
): Seat {
  const ts = args.createdAt ?? nowIso();
  return {
    seatId: args.seatId,
    userId: args.userId,
    status: args.status ?? 'active',
    policyId: args.policyId,
    createdAt: ts,
    createdBy: args.createdBy ?? 'system',
    updatedAt: args.updatedAt ?? ts,
    updatedBy: args.updatedBy ?? args.createdBy ?? 'system',
  };
}

export function patchSeat(existing: Seat, patch: Partial<Seat>, actor: string): Seat {
  return {
    ...existing,
    status: patch.status ?? existing.status,
    policyId: patch.policyId ?? existing.policyId,
    updatedAt: nowIso(),
    updatedBy: actor,
  };
}
