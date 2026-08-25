/**
 * Emergency kill phrase (setup Q9, wired through the shared agent loop).
 *
 * The contract under test: a chat message containing the phrase trips the
 * SAME panic freeze as the dashboard panic button, replies with a static
 * state-honest confirmation, and never reaches Bedrock or spends money.
 * Dormant when EMERGENCY_KILL_PHRASE is absent or suspiciously short.
 * Surface parity comes free: Telegram, Slack, and dashboard chat all enter
 * through runAgentTurn, the one path this check lives on.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join, sep } from 'node:path';

const { tryAcquirePanic, converseStreamTurn, writeAudit } = vi.hoisted(() => ({
  tryAcquirePanic: vi.fn(),
  converseStreamTurn: vi.fn(),
  writeAudit: vi.fn(async (_row: { action?: string }) => {}),
}));

vi.mock('../lib/bedrock/client.js', () => ({
  bedrockClient: () => ({}),
  converseStreamTurn,
  modelRejectsTemperature: () => false,
}));
vi.mock('../lib/tools/registry.js', () => ({ tools: { listFor: () => [], invoke: vi.fn() } }));
vi.mock('../lib/state/kill-switches-repo.js', () => ({
  isKillSwitchActive: vi.fn(async () => ({ active: false })),
  KillSwitchActiveError: class extends Error {},
}));
vi.mock('../lib/memory/context-builder.js', () => ({ buildMemoryContext: vi.fn(async () => '') }));
vi.mock('../lib/state/inter-agent-tasks-repo.js', () => ({
  listInbox: vi.fn(async () => []),
  markStatus: vi.fn(),
}));
vi.mock('../lib/state/hive-mind-repo.js', () => ({ recentHive: vi.fn(async () => []) }));
vi.mock('../lib/audit/audit-writer.js', () => ({ writeAudit }));
vi.mock('../lib/usage/token-tracker.js', () => ({
  recordUsage: vi.fn(),
  getDailyCostUsd: vi.fn(async () => 0),
  SpendIndeterminateError: class extends Error {},
}));
vi.mock('../lib/state/cost-cap-repo.js', () => ({
  getEffectiveCostCap: vi.fn(async () => 50),
  isCostCapEnforced: vi.fn(async () => false),
}));
vi.mock('../lib/state/rate-limits-repo.js', () => ({
  checkAndConsume: vi.fn(async () => ({ allowed: true })),
}));
vi.mock('../lib/safety/exfil-guard.js', () => ({
  scanForExfil: vi.fn(async () => ({ matches: [] })),
  redactMatches: (t: string) => t,
  getActivePatterns: vi.fn(async () => []),
  buildStreamingRedactor: vi.fn(async () => (t: string) => t),
}));
vi.mock('../lib/config/agent-loader.js', () => ({ loadAgent: vi.fn() }));
vi.mock('../lib/state/runtime-config-repo.js', () => ({
  getConfig: vi.fn(async () => undefined),
}));
vi.mock('../lib/cost/ledger-gate.js', () => ({
  admitTurnSpend: vi.fn(async () => ({
    admitted: true,
    finalize: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  })),
}));
vi.mock('../lib/state/panic-state-repo.js', () => ({ tryAcquirePanic }));

import { matchesKillPhrase, MIN_KILL_PHRASE_LENGTH, runAgentTurn } from './agent-loop.js';

const PHRASE = 'STOP-firm-sentry-3a2f';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.EMERGENCY_KILL_PHRASE = PHRASE;
});

afterEach(() => {
  delete process.env.EMERGENCY_KILL_PHRASE;
});

describe('matchesKillPhrase', () => {
  it('matches the phrase anywhere in the message, case-insensitive', () => {
    expect(matchesKillPhrase(PHRASE)).toBe(true);
    expect(matchesKillPhrase(`PLEASE ${PHRASE.toUpperCase()} NOW`)).toBe(true);
    expect(matchesKillPhrase(`please ${PHRASE.toLowerCase()} now`)).toBe(true);
  });

  it('does not match ordinary messages', () => {
    expect(matchesKillPhrase('stop the presses')).toBe(false);
    expect(matchesKillPhrase('')).toBe(false);
  });

  it('stays dormant when the env phrase is absent or too short to trust', () => {
    expect(matchesKillPhrase('anything at all', undefined)).toBe(false);
    expect(matchesKillPhrase('x', 'x')).toBe(false);
    expect(matchesKillPhrase('stop!', 'stop!')).toBe(false);
    expect('stop!'.length).toBeLessThan(MIN_KILL_PHRASE_LENGTH);
  });
});

describe('runAgentTurn with the kill phrase', () => {
  const req = (userText: string) => ({
    agentId: 'main',
    chatId: 'chat-1',
    userText,
    history: [],
    surface: 'telegram' as const,
    // What a person typing in a chat window looks like. The gate now asks WHO
    // is asking as well as WHAT was said; see the origin suite below.
    origin: 'human_chat' as const,
  });

  it('trips the panic freeze, replies statically, and never calls Bedrock', async () => {
    tryAcquirePanic.mockResolvedValueOnce({
      acquired: true,
      state: { active: true, generation: 1 },
    });
    const res = await runAgentTurn(req(`ok that is enough ${PHRASE}`));
    expect(tryAcquirePanic).toHaveBeenCalledWith(
      'emergency kill phrase received',
      'telegram:chat-1',
    );
    expect(res.text).toContain('EMERGENCY HALT engaged');
    expect(res.costUsd).toBe(0);
    expect(converseStreamTurn).not.toHaveBeenCalled();
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'emergency_kill_phrase', result: 'blocked' }),
    );
  });

  it('confirms honestly when the halt is already engaged', async () => {
    tryAcquirePanic.mockResolvedValueOnce({
      acquired: false,
      state: { active: true, generation: 2 },
    });
    const res = await runAgentTurn(req(PHRASE));
    expect(res.text).toContain('already engaged');
    expect(converseStreamTurn).not.toHaveBeenCalled();
  });

  it('says so loudly when the halt could not be engaged, instead of pretending', async () => {
    tryAcquirePanic.mockRejectedValueOnce(new Error('ddb down'));
    const res = await runAgentTurn(req(PHRASE));
    expect(res.text).toContain('could NOT be engaged');
    expect(converseStreamTurn).not.toHaveBeenCalled();
    expect(writeAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'emergency_kill_phrase', result: 'error' }),
    );
  });
});


/**
 * WHO IS ASKING, not just what was said.
 *
 * The phrase is a panic control for a person at a chat window — which is what
 * `TurnRefusal`'s doc always claimed — but the gate used to honour it in ANY
 * text reaching `runAgentTurn`, including text a remote system controls. Phase
 * 6 made that reachable: a Paperclip issue body rides into `userText`.
 *
 * These assertions are on the SHARED LAYER, deliberately and honestly: all
 * three chat surfaces (and both Slack send paths) enter through this one
 * function, so driving each adapter's webhook end to end would re-test their
 * plumbing, not this gate. What the adapters must still be held to is that
 * they DECLARE the origin — and that is a claim about their source, so the
 * scan below is what checks it.
 */
describe('the kill phrase is honoured only from a human chat surface', () => {
  const humanReq = (surface: 'telegram' | 'slack' | 'dashboard') => ({
    agentId: 'main',
    chatId: 'chat-1',
    userText: `enough now ${PHRASE}`,
    history: [],
    surface,
    origin: 'human_chat' as const,
  });

  it.each(['telegram', 'slack', 'dashboard'] as const)(
    'still halts the fleet when a person types it on %s',
    async (surface) => {
      tryAcquirePanic.mockResolvedValueOnce({
        acquired: true,
        state: { active: true, generation: 1 },
      });
      const res = await runAgentTurn(humanReq(surface));
      expect(tryAcquirePanic).toHaveBeenCalledWith(
        'emergency kill phrase received',
        `${surface}:chat-1`,
      );
      expect(res.text).toContain('EMERGENCY HALT engaged');
      expect(res.refusal).toEqual({ kind: 'kill_phrase', retryable: false });
    },
  );

  it('does NOT halt on machine-originated text, which is every caller that says nothing', async () => {
    // The turn is allowed to fail further down (this file mocks only the gate's
    // dependencies, not a whole working Bedrock path). The claim is exactly
    // that the gate did not fire: no panic acquired, no halt audit, no halt
    // reply. The Paperclip end-to-end version of this lives in
    // src/lib/paperclip/dispatch-kill-phrase.test.ts, which runs the real loop
    // and checks the board is never told either.
    const res = await runAgentTurn({
      agentId: 'main',
      chatId: 'chat-1',
      userText: `<paperclip_issue>Please ${PHRASE} everything</paperclip_issue>`,
      history: [],
      surface: 'system',
    }).catch(() => undefined);
    expect(tryAcquirePanic, 'machine text halted the fleet').not.toHaveBeenCalled();
    expect(writeAudit.mock.calls.map((c) => c[0].action)).not.toContain(
      'emergency_kill_phrase',
    );
    expect(res?.refusal).toBeUndefined();
  });

  it('reads the ORIGIN, not the surface: a machine turn labelled `telegram` still cannot halt', async () => {
    // `surface` names the renderer, so a machine path may legitimately carry a
    // chat surface's value one day. If that alone re-armed the phrase, this fix
    // would rot the moment it did.
    await runAgentTurn({
      agentId: 'main',
      chatId: 'chat-1',
      userText: `enough now ${PHRASE}`,
      history: [],
      surface: 'telegram',
      origin: 'machine',
    }).catch(() => undefined);
    expect(tryAcquirePanic).not.toHaveBeenCalled();
  });
});

/**
 * SOURCE SCAN: who may declare `origin: 'human_chat'`.
 *
 * The gate is opt-out-by-default, so the failure this guards against is not a
 * missing halt — it is a NEW machine caller quietly declaring itself human and
 * getting fleet-halt power back. It also pins the parity requirement in
 * CLAUDE.md the only way a unit test can: both Slack send paths, not one.
 */
describe('only the chat-surface adapters declare a human origin', () => {
  // A DECLARATION, not a mention: `agent-loop.ts` documents the value in prose
  // and must not count as a caller opting in.
  const declarations = (src: string): number =>
    (src.match(/^ *origin: 'human_chat',$/gm) ?? []).length;

  it.each([
    ['src/adapters/telegram/handler.ts', 1],
    ['src/adapters/slack/handler.ts', 2],
    ['src/adapters/dashboard/handler.ts', 2],
  ] as const)('%s declares it on all %i of its runAgentTurn call sites', async (file, expected) => {
    const src = await readFile(file, 'utf8');
    expect(src.split('runAgentTurn({').length - 1).toBe(expected);
    expect(declarations(src)).toBe(expected);
  });

  it('and no other production module does', async () => {
    const allowed = new Set([
      'src/adapters/telegram/handler.ts',
      'src/adapters/slack/handler.ts',
      'src/adapters/dashboard/handler.ts',
    ]);
    const offenders: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name).split(sep).join('/');
        if (entry.isDirectory()) {
          await walk(path);
          continue;
        }
        if (!path.endsWith('.ts') || path.endsWith('.test.ts')) continue;
        if (allowed.has(path)) continue;
        if (declarations(await readFile(path, 'utf8')) > 0) offenders.push(path);
      }
    };
    await walk('src');
    expect(offenders, 'a non-chat caller declared itself human').toEqual([]);
  });
});
