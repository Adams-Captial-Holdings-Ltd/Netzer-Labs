import { describe, it, expect, vi, beforeEach } from 'vitest';

// setKillSwitch must tear down THIS task's own live Jarvis sessions when a
// teardown-relevant switch is activated — the fanout listener skips self-origin
// messages and prod has no SNS topic, so without this the writer's own sessions
// survive the kill (Codex review finding 4).

const { sendMock, teardownMock } = vi.hoisted(() => ({
  sendMock: vi.fn(async () => ({})),
  teardownMock: vi.fn(async () => {}),
}));
vi.mock('./ddb.js', () => ({ ddb: () => ({ send: sendMock }) }));
vi.mock('../config/invalidation-publisher.js', () => ({ publishInvalidation: vi.fn() }));
vi.mock('../voice/session-registry.js', async () => {
  const actual = await vi.importActual<typeof import('../voice/session-registry.js')>(
    '../voice/session-registry.js',
  );
  return { ...actual, teardownAllJarvisSessions: teardownMock };
});

import { setKillSwitch } from './kill-switches-repo.js';

describe('setKillSwitch local Jarvis teardown', () => {
  beforeEach(() => {
    teardownMock.mockClear();
    sendMock.mockClear();
  });

  it('tears down local sessions when activating jarvis_disabled', async () => {
    await setKillSwitch('jarvis_disabled', true, 'test', 'tester');
    expect(teardownMock).toHaveBeenCalledWith('jarvis_disabled');
  });

  it('maps jarvis_voice_disabled to the voice-drop teardown reason', async () => {
    await setKillSwitch('jarvis_voice_disabled', true, 'test', 'tester');
    expect(teardownMock).toHaveBeenCalledWith('jarvis_voice_disabled');
  });

  it('tears down on bedrock_global and dashboard_read_disabled activation', async () => {
    await setKillSwitch('bedrock_global', true, 'test', 'tester');
    await setKillSwitch('dashboard_read_disabled', true, 'test', 'tester');
    expect(teardownMock).toHaveBeenCalledWith('bedrock_global');
    expect(teardownMock).toHaveBeenCalledWith('dashboard_read_disabled');
  });

  it('does NOT tear down when DEactivating a switch (clearing never drops a session)', async () => {
    await setKillSwitch('jarvis_disabled', false, 'test', 'tester');
    expect(teardownMock).not.toHaveBeenCalled();
  });

  it('does NOT tear down for a non-Jarvis switch', async () => {
    await setKillSwitch('tool_use', true, 'test', 'tester');
    expect(teardownMock).not.toHaveBeenCalled();
  });
});
