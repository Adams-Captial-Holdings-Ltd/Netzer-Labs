/**
 * P2 (step 4) — decision 41 at the storage layer.
 *
 * Written BEFORE the change, as the bar (netzar-chat-plan/p2-proof.sh row B-10).
 *
 * A saved assistant turn now carries each tool's result (capped at 2 KB). The
 * replay window has a byte budget (trimTurnsToBudget) because stored turns already
 * reached DynamoDB's item ceiling once; without a rule, tool logs would push
 * CONVERSATION turns out of the window to make room for themselves. The owner's
 * rule (decision 41): a lost tool log is an inconvenience, a lost turn is a broken
 * conversation — so tool output goes first, oldest first, and only then are turns
 * cut (still only at a user turn, M29).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GetCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('./ddb.js', () => ({ ddb: () => ({ send }) }));
vi.mock('../../agent/memory-ingest.js', () => ({ ingestEvictedTurns: vi.fn() }));
vi.mock('./runtime-config-repo.js', () => ({ getConfig: vi.fn(async () => undefined) }));

import { appendTurns, getFullHistory, trimTurnsToBudget } from './sessions-repo.js';

const OUTPUT = 'o'.repeat(2000);

function tool(toolUseId: string) {
  return { label: 'web search', step: 1, toolUseId, output: OUTPUT, isError: false, truncated: false };
}

describe('turn lifecycle (P2) — sessions repo', () => {
  it('drops tool output before any turn when a conversation is over budget', () => {
    const turns = [
      { role: 'user' as const, text: 'q1', ts: 1 },
      { role: 'assistant' as const, text: 'a1', ts: 2, tools: [tool('t1'), tool('t2')] },
      { role: 'user' as const, text: 'q2', ts: 3 },
      { role: 'assistant' as const, text: 'a2', ts: 4, tools: [tool('t3')] },
    ];

    // The four texts fit easily; the 6 KB of tool output does not.
    const { kept, dropped } = trimTurnsToBudget(turns as never, 3000);

    expect(dropped).toEqual([]);
    expect(kept.map((t) => t.text)).toEqual(['q1', 'a1', 'q2', 'a2']);
    const calls = kept.flatMap((t) => (t as { tools?: Array<{ toolUseId: string; output: string; truncated: boolean }> }).tools ?? []);
    // Oldest output first; the newest one survives because the window now fits.
    expect(calls.map((c) => c.toolUseId)).toEqual(['t1', 't2', 't3']);
    expect(calls.map((c) => c.output.length)).toEqual([0, 0, OUTPUT.length]);
    expect(calls.map((c) => c.truncated)).toEqual([true, true, false]);
    // The input turns are not mutated: the caller's copy still has every output.
    expect(turns[1]!.tools![0]!.output).toBe(OUTPUT);

    // With every output gone and still over budget, turns are cut as before —
    // and only at a user turn.
    const tight = trimTurnsToBudget(turns as never, 150);
    expect(tight.dropped.length).toBeGreaterThan(0);
    expect(tight.kept[0]?.role ?? 'user').toBe('user');
  });

  describe('a message record that carries tool results', () => {
    let records: Array<Record<string, unknown>> = [];

    beforeEach(() => {
      send.mockReset();
      records = [];
      send.mockImplementation(async (cmd: unknown) => {
        if (cmd instanceof GetCommand) return { Item: undefined };
        if (cmd instanceof TransactWriteCommand) {
          records = (cmd.input.TransactItems ?? []).slice(1).map((t) => t.Put?.Item as Record<string, unknown>);
          return {};
        }
        throw new Error('unexpected DynamoDB command');
      });
    });

    it('stays under the item limit when a long reply carries many tool results', async () => {
      // Before P2 a record held text alone, capped at 350,000 bytes. Tool results now
      // ride on the same record, so a reply near that cap plus a long tool run would
      // cross DynamoDB's 400 KB item limit and fail the WHOLE append — the turn and
      // its window lost together. The results are the smaller, capped part (2 KB
      // each); the text is what gives way.
      const tools = Array.from({ length: 40 }, (_, i) => ({
        label: 'web search', step: i + 1, toolUseId: `tu-${i}`, output: 'o'.repeat(2048), isError: false, truncated: true,
      }));

      await appendTurns('main', 'dashboard:p2-big', [
        { role: 'user', text: 'make the big document', ts: 1 },
        { role: 'assistant', text: 'd'.repeat(349_000), ts: 1, tools },
      ], undefined, { surface: 'dashboard', userId: 'dashboard:user:user-a', ephemeral: false });

      expect(records).toHaveLength(2);
      for (const r of records) expect(Buffer.byteLength(JSON.stringify(r), 'utf8')).toBeLessThan(400 * 1024);
      const reply = records[1]!;
      expect((reply.tools as unknown[]).length).toBe(40);
      expect(reply.truncated).toBe(true);
    });

    it('stays under the item limit however many tool results a reply carries', async () => {
      // The step 4 review: 70 results of 2,048 characters that take three bytes each in
      // UTF-8 are about 430 KB of tools alone, so giving way on the text cannot save the
      // record, and the whole append fails. The oldest outputs give way first, as they
      // do in the replay window (decision 41); every call stays listed.
      const tools = Array.from({ length: 70 }, (_, i) => ({
        label: 'web search', step: i + 1, toolUseId: `tu-${i}`, output: '\u754c'.repeat(2048), isError: false, truncated: false,
      }));

      await appendTurns('main', 'dashboard:p2-many', [
        { role: 'user', text: 'run everything', ts: 1 },
        { role: 'assistant', text: 'done', ts: 1, tools },
      ], undefined, { surface: 'dashboard', userId: 'dashboard:user:user-a', ephemeral: false });

      const reply = records[1]!;
      expect(Buffer.byteLength(JSON.stringify(reply), 'utf8')).toBeLessThan(400 * 1024);
      const kept = reply.tools as Array<{ toolUseId: string; output: string; truncated: boolean }>;
      expect(kept).toHaveLength(70);
      expect(kept[69]!.output).toBe('\u754c'.repeat(2048)); // the newest result survives
      expect(kept[0]!.output).toBe(''); // the oldest gave way
      expect(kept[0]!.truncated).toBe(true);
    });

    it('writes the stopped mark on the message record', async () => {
      await appendTurns('main', 'dashboard:p2-stop', [
        { role: 'user', text: 'tell me everything', ts: 1 },
        { role: 'assistant', text: 'Partial', ts: 1, status: 'stopped' },
      ], undefined, { surface: 'dashboard', userId: 'dashboard:user:user-a', ephemeral: false });

      expect(records[1]).toMatchObject({ role: 'assistant', text: 'Partial', status: 'stopped' });
    });
  });

  it('brings back the stopped mark and the tool results when a conversation is reopened', async () => {
    // The step 4 review: the browser suite reloads against the dev mock, whose own
    // store keeps both fields, so nothing proved the REAL read path returns them.
    const tools = [{ label: 'web search', step: 1, toolUseId: 'tu-1', output: '3 pages', isError: false, truncated: false }];
    send.mockReset();
    send.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof QueryCommand) {
        return {
          Items: [
            { PK: 'AGENT#main', SK: 'CHAT#dashboard:p2-reload#MSG#1', seq: 1, role: 'assistant', text: 'Partial', ts: 2, status: 'stopped', tools },
            { PK: 'AGENT#main', SK: 'CHAT#dashboard:p2-reload#MSG#0', seq: 0, role: 'user', text: 'tell me everything', ts: 1 },
          ],
        };
      }
      throw new Error('unexpected DynamoDB command');
    });

    const { turns } = await getFullHistory('main', 'dashboard:p2-reload', { turns: [], turnsTotal: 2 } as never);

    expect(turns).toHaveLength(2);
    expect(turns[1]).toMatchObject({ role: 'assistant', text: 'Partial', status: 'stopped', tools });
  });
});
