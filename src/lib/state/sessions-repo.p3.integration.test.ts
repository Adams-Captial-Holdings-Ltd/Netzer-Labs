/**
 * Integration test: P3's attachments against a real DynamoDB (Floci locally,
 * LocalStack in CI).
 *
 * Written BEFORE the change, as the bar (netzar-chat-plan/p3-proof.sh rows M-10, M-11).
 *
 * The unit table (fake-dynamo.ts) applies no projection (P95). Today's delete reads a
 * conversation's records with `ProjectionExpression: 'PK, SK'`; a cascade that kept
 * that read would get NO file keys back from real DynamoDB and leave every stored
 * file behind — while the unit test, which hands back whole items, passed. So the
 * delete is proved here, where DynamoDB applies its own projection.
 *
 * S3 is intercepted at the SDK, and no bucket is made: the CI emulator needs
 * path-style addressing that the app's S3 clients do not use
 * (scripts/destroy.integration.test.ts), and what this proves is which keys
 * DynamoDB hands back and that they are deleted before the records — not S3's own
 * delete, which is the SDK's.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { S3Client, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { ensureLocalStack, configureLocalAwsEnv, createDdbTable } from '../../__test-utils__/localstack.js';

const SESSIONS = 'claudeclaw-integ-p3-sessions';

beforeAll(async () => {
  configureLocalAwsEnv();
  process.env.TABLE_SESSIONS = SESSIONS;
  process.env.RAW_BUCKET = 'claudeclaw-integ-p3-raw';
  // Keep memory ingest inert: it would call Bedrock, which is not emulated here.
  process.env.BEDROCK_HAIKU_MODEL = 'integ-noop';
  await ensureLocalStack();
  await createDdbTable({ name: SESSIONS, partitionKey: { name: 'PK', type: 'S' }, sortKey: { name: 'SK', type: 'S' } });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const repo = () => import('./sessions-repo.js');
const client = async () => (await import('./ddb.js')).ddb();
const PERSON = { surface: 'dashboard' as const, userId: 'dashboard:user:user-a', ephemeral: false };

function file(chatId: string, n: number) {
  return {
    id: `upload-${n}`,
    name: `plan-${n}.docx`,
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    size: 2000 + n,
    key: `dashboard/${chatId}/2026/09/24/${n}-plan-${n}.docx`,
  };
}

async function everything(agentId: string, chatId: string): Promise<Record<string, unknown>[]> {
  const out = await (await client()).send(
    new QueryCommand({
      TableName: SESSIONS,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
      ExpressionAttributeValues: { ':pk': `AGENT#${agentId}`, ':p': `CHAT#${chatId}` },
      ConsistentRead: true,
    }),
  );
  return out.Items ?? [];
}

describe('chat attachments (P3) — on DynamoDB', () => {
  it('keeps a message\'s attachments through DynamoDB', async () => {
    const { appendTurns, getFullHistory, getSession } = await repo();
    const chat = `dashboard:${Date.now()}1`;
    await appendTurns('main', chat, [
      { role: 'user', text: 'two plans', ts: 1, attachments: [file(chat, 1), file(chat, 2)] },
      { role: 'assistant', text: 'read both', ts: 1 },
    ], undefined, PERSON);

    const { turns } = await getFullHistory('main', chat, (await getSession('main', chat))!);

    expect(turns[0]!.attachments).toEqual([file(chat, 1), file(chat, 2)]);
    expect(turns[1]!.attachments).toBeUndefined();
  });

  it('finds a deleted conversation\'s stored files on DynamoDB and deletes them first', async () => {
    const { appendTurns, deleteSession } = await repo();
    const chat = `dashboard:${Date.now()}2`;
    await appendTurns('main', chat, [
      { role: 'user', text: 'first', ts: 1, attachments: [file(chat, 1)] },
      { role: 'assistant', text: 'ok', ts: 1 },
    ], undefined, PERSON);
    await appendTurns('main', chat, [
      { role: 'user', text: 'second', ts: 2, attachments: [file(chat, 2)] },
      { role: 'assistant', text: 'ok', ts: 2 },
    ], undefined, PERSON);
    const deleted: string[] = [];
    let rowsWhenFilesWent = -1;
    vi.spyOn(S3Client.prototype, 'send').mockImplementation(async (cmd: unknown) => {
      if (!(cmd instanceof DeleteObjectsCommand)) throw new Error('unexpected S3 command');
      rowsWhenFilesWent = (await everything('main', chat)).length;
      deleted.push(...(cmd.input.Delete?.Objects ?? []).map((o) => String(o.Key)));
      return {} as never;
    });

    await deleteSession('main', chat);

    expect(deleted.sort()).toEqual([file(chat, 1).key, file(chat, 2).key].sort());
    // When the files were deleted, every row was still there: the conversation row
    // and its four message records.
    expect(rowsWhenFilesWent).toBe(5);
    expect(await everything('main', chat)).toEqual([]);
  });
});
