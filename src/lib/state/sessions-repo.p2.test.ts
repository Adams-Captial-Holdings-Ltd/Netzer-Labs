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
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('./ddb.js', () => ({ ddb: () => ({ send }) }));
vi.mock('../../agent/memory-ingest.js', () => ({ ingestEvictedTurns: vi.fn() }));
vi.mock('./runtime-config-repo.js', () => ({ getConfig: vi.fn(async () => undefined) }));

import { appendTurns, trimTurnsToBudget } from './sessions-repo.js';

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
  });
});
