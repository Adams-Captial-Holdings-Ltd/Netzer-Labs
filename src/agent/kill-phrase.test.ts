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

const { tryAcquirePanic, converseStreamTurn, writeAudit } = vi.hoisted(() => ({
  tryAcquirePanic: vi.fn(),
  converseStreamTurn: vi.fn(),
  writeAudit: vi.fn(async () => {}),
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
