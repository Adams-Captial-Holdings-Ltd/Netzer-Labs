/**
 * appendTurns must never write a session item DynamoDB will refuse.
 *
 * MAX_TURNS caps the stored window by count, not bytes. Once the output ceiling
 * is raised (runtime-config `agent/max_output_tokens`), a handful of long
 * replies pushes the item past DynamoDB's 400KB limit, the Put throws, and the
 * turn is lost: one reply's size breaking the whole chat. The window must also
 * still start with a user turn, because Bedrock rejects a conversation whose
 * first message is the assistant's.
 *
 * This pins the WIRING at the storage seam. The trimTurnsToBudget unit tests
 * would still pass if appendTurns never called it. DynamoDB, memory ingest and
 * runtime-config are mocked, and Date is faked: nothing leaves the process.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

const { send, ingestEvictedTurns } = vi.hoisted(() => ({
  send: vi.fn(),
  ingestEvictedTurns: vi.fn(),
}));

vi.mock('./ddb.js', () => ({ ddb: () => ({ send }) }));
vi.mock('../../agent/memory-ingest.js', () => ({ ingestEvictedTurns }));
vi.mock('./runtime-config-repo.js', () => ({ getConfig: vi.fn(async () => undefined) }));

import { appendTurns, type Turn } from './sessions-repo.js';

const exchange = (tag: string, reply: number): Turn[] => [
  { role: 'user', text: tag.repeat(200), ts: 1 },
  { role: 'assistant', text: tag.repeat(reply), ts: 1 },
];

describe('appendTurns byte budget', () => {
  let stored: Record<string, unknown> | undefined;
  let written: Record<string, unknown> | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-18T12:00:00Z'));
    written = undefined;
    send.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof GetCommand) return { Item: stored };
      if (cmd instanceof PutCommand) {
        written = cmd.input.Item;
        return {};
      }
      throw new Error('unexpected DynamoDB command');
    });
  });

  afterEach(() => vi.useRealTimers());

  it('keeps the written item under 400KB and the window user-first', async () => {
    // Six stored exchanges with 64KB replies, all already ingested: what a
    // raised ceiling produces well inside the 20-turn count cap.
    stored = {
      PK: 'AGENT#main',
      SK: 'CHAT#tg-1',
      turns: ['a', 'b', 'c', 'd', 'e', 'f'].flatMap((tag) => exchange(tag, 64_000)),
      turnsTotal: 12,
      turnsIngested: 12,
      version: 7,
    };

    await appendTurns('main', 'tg-1', exchange('g', 64_000), undefined, { surface: 'telegram' });

    expect(written).toBeDefined();
    const turns = written!.turns as Turn[];
    // JSON is at least as large as DynamoDB's own item size for this shape
    // (every attribute name and string is quoted), so under 400KB here is
    // under DynamoDB's limit.
    expect(Buffer.byteLength(JSON.stringify(written), 'utf8')).toBeLessThan(400 * 1024);
    expect(turns[0]?.role).toBe('user');
    // The newest exchange survives the trim whole.
    expect(turns.slice(-2).map((t) => t.text)).toEqual(exchange('g', 64_000).map((t) => t.text));
    // Evicting fires the ingest backstop even below the cadence threshold.
    expect(ingestEvictedTurns).toHaveBeenCalledTimes(1);
  });
});
