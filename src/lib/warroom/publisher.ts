import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../state/ddb.js';
import type { WarroomTurn } from './types.js';
import { touchMeetingActivity } from './meetings-repo.js';

const TURNS_TABLE = process.env.TABLE_WARROOM_TURNS ?? 'claudeclaw-warroom-turns';
const MEETINGS_TABLE = process.env.TABLE_WARROOM_MEETINGS ?? 'claudeclaw-warroom-meetings';

export async function allocateSeq(meetingId: string): Promise<number> {
  const result = await ddb().send(
    new UpdateCommand({
      TableName: MEETINGS_TABLE,
      Key: { PK: `MEETING#${meetingId}`, SK: 'META' },
      UpdateExpression: 'ADD nextSeq :one',
      ExpressionAttributeValues: { ':one': 1 },
      ReturnValues: 'ALL_NEW',
    }),
  );
  return ((result.Attributes as Record<string, unknown>).nextSeq as number) ?? 1;
}

export async function writeTurn(turn: WarroomTurn): Promise<void> {
  await ddb().send(
    new PutCommand({
      TableName: TURNS_TABLE,
      Item: {
        PK: `MEETING#${turn.meetingId}`,
        SK: `SEQ#${String(turn.seq).padStart(10, '0')}`,
        ...turn,
      },
    }),
  );
}

export async function publishTurn(
  meetingId: string,
  speaker: string,
  type: 'user' | 'agent' | 'system',
  content: string,
  agentId?: string,
): Promise<WarroomTurn> {
  const seq = await allocateSeq(meetingId);
  const turn: WarroomTurn = {
    meetingId,
    seq,
    speaker,
    type,
    content,
    ts: new Date().toISOString(),
    agentId,
  };
  await writeTurn(turn);
  // Denormalize recency + the first-message preview onto the meeting so the room
  // list shows a real title + timestamp. Fire-and-forget: never fail the turn
  // write on a list-cosmetics update. Preview only from user turns (the first
  // one wins via if_not_exists server-side).
  void touchMeetingActivity(
    meetingId,
    turn.ts,
    type === 'user' ? content.slice(0, 140) : undefined,
  ).catch(() => {});
  return turn;
}

export async function getHistory(
  meetingId: string,
  sinceSeq = 0,
  limit = 100,
): Promise<WarroomTurn[]> {
  const { QueryCommand } = await import('@aws-sdk/lib-dynamodb');
  const out = await ddb().send(
    new QueryCommand({
      TableName: TURNS_TABLE,
      KeyConditionExpression: 'PK = :pk AND SK > :sk',
      ExpressionAttributeValues: {
        ':pk': `MEETING#${meetingId}`,
        ':sk': `SEQ#${String(sinceSeq).padStart(10, '0')}`,
      },
      Limit: limit,
    }),
  );
  return (out.Items ?? []) as WarroomTurn[];
}
