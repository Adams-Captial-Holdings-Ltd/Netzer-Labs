import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * /model sets the AGENT'S saved default (the same field the dashboard edits),
 * not a per-chat override. These tests pin that contract: a switch persists via
 * updateAgent, busts the loader cache locally AND fans the bust out to peer
 * tasks (publishInvalidation 'agent'), clears any stale per-chat override, and
 * rejects unknown model ids instead of saving a default that would
 * ValidationException on every future turn.
 */

const {
  loadAgentMock,
  updateAgentMock,
  invalidateMock,
  publishMock,
  getSessionMock,
  setModelOverrideMock,
} = vi.hoisted(() => ({
  loadAgentMock: vi.fn(),
  updateAgentMock: vi.fn(async () => {}),
  invalidateMock: vi.fn(),
  publishMock: vi.fn(),
  getSessionMock: vi.fn(async () => null),
  setModelOverrideMock: vi.fn(async () => {}),
}));

vi.mock('../lib/config/agent-loader.js', () => ({
  listKnownAgents: () => ['main', 'ops', 'research'],
  loadAgent: loadAgentMock,
  invalidateAgentCache: invalidateMock,
}));
vi.mock('../lib/state/agents-repo.js', () => ({ updateAgent: updateAgentMock }));
vi.mock('../lib/config/invalidation-publisher.js', () => ({ publishInvalidation: publishMock }));
vi.mock('../lib/state/sessions-repo.js', () => ({
  clearSession: vi.fn(async () => {}),
  setModelOverride: setModelOverrideMock,
  setWarroomMode: vi.fn(async () => {}),
  getSession: getSessionMock,
}));
// War-room imports run at module load but no /model test exercises them.
vi.mock('../lib/warroom/meetings-repo.js', () => ({
  createMeeting: vi.fn(),
  getMeeting: vi.fn(),
  endMeeting: vi.fn(),
}));
vi.mock('../lib/warroom/publisher.js', () => ({ publishTurn: vi.fn(), getHistory: vi.fn() }));
vi.mock('../lib/warroom/orchestrator.js', () => ({ parseMentions: () => [] }));

import { runCommand } from './commands.js';

const OPUS = 'us.anthropic.claude-opus-4-7';
const SONNET = 'us.anthropic.claude-sonnet-4-6';
const HAIKU = 'us.anthropic.claude-haiku-4-5';

beforeEach(() => {
  vi.clearAllMocks();
  process.env.BEDROCK_OPUS_MODEL = OPUS;
  process.env.BEDROCK_SONNET_MODEL = SONNET;
  process.env.BEDROCK_DEFAULT_MODEL = SONNET;
  process.env.BEDROCK_HAIKU_MODEL = HAIKU;
  delete process.env.BEDROCK_OPUS_1M_MODEL;
  delete process.env.BEDROCK_SONNET_1M_MODEL;
  loadAgentMock.mockResolvedValue({ agentId: 'main', displayName: 'Main', systemPrompt: '' });
  getSessionMock.mockResolvedValue(null);
});

describe('/model — shows the agent\'s real configured model', () => {
  it('reports the agent default (not just the env default) and marks it active', async () => {
    loadAgentMock.mockResolvedValue({ agentId: 'main', displayName: 'Main', systemPrompt: '', model: OPUS });
    const r = await runCommand('main', 'tg:1', '/model');
    expect(r?.reply).toContain(`Current model: ${OPUS}`);
    expect(r?.reply).toContain('opus — 200.0k (active)');
    // Pure read: no persistence, no cache bust.
    expect(updateAgentMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
  });

  it('flags when the agent is on the platform default with no per-agent model', async () => {
    const r = await runCommand('main', 'tg:1', '/model');
    expect(r?.reply).toContain('platform default — no per-agent model set');
    expect(r?.reply).toContain(`Current model: ${SONNET}`);
  });
});

describe('/model <label> — persists the agent default fleet-wide', () => {
  it('writes the model, busts local + peer caches, and clears stale overrides', async () => {
    const r = await runCommand('research', 'tg:1', '/model opus');
    expect(updateAgentMock).toHaveBeenCalledWith('research', { model: OPUS });
    expect(invalidateMock).toHaveBeenCalledWith('research');
    expect(publishMock).toHaveBeenCalledWith('agent', 'research');
    expect(setModelOverrideMock).toHaveBeenCalledWith('research', 'tg:1', null);
    expect(r?.reply).toContain('research model set to opus');
    expect(r?.reply).toContain("agent's default now");
  });

  it('accepts a raw Bedrock id, not just a label', async () => {
    await runCommand('main', 'tg:1', `/model ${HAIKU}`);
    expect(updateAgentMock).toHaveBeenCalledWith('main', { model: HAIKU });
  });

  it('rejects an unknown model instead of persisting a broken default', async () => {
    const r = await runCommand('main', 'tg:1', '/model gpt-5');
    expect(updateAgentMock).not.toHaveBeenCalled();
    expect(publishMock).not.toHaveBeenCalled();
    expect(r?.reply).toContain('Unknown model "gpt-5"');
    expect(r?.reply).toContain('opus, sonnet, haiku');
  });
});

describe('/model reset — back to the platform default', () => {
  it('removes the stored model and fans the bust out', async () => {
    const r = await runCommand('ops', 'tg:1', '/model reset');
    expect(updateAgentMock).toHaveBeenCalledWith('ops', { model: undefined });
    expect(invalidateMock).toHaveBeenCalledWith('ops');
    expect(publishMock).toHaveBeenCalledWith('agent', 'ops');
    expect(setModelOverrideMock).toHaveBeenCalledWith('ops', 'tg:1', null);
    expect(r?.reply).toContain(`platform default: ${SONNET}`);
  });
});
