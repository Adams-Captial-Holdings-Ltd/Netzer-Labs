import { describe, it, expect } from 'vitest';
import { generateSlackManifest } from './agent-manager.js';

/**
 * The generated manifest is what an operator pastes into Slack's "From a
 * manifest" flow. It must point only at routes the per-agent adapter actually
 * serves (just /slack/<agent>/events) and request only the scopes that adapter
 * needs — otherwise setup either fails or grants noise.
 */
describe('generateSlackManifest', () => {
  const manifest = generateSlackManifest('ops', 'Ops Bot', 'example.com') as {
    display_information: { name: string };
    oauth_config: { scopes: { bot: string[] } };
    settings: {
      event_subscriptions: { request_url: string; bot_events: string[] };
      interactivity?: unknown;
    };
  };

  it('targets the per-agent events URL on the given domain', () => {
    expect(manifest.settings.event_subscriptions.request_url).toBe(
      'https://example.com/slack/ops/events',
    );
  });

  it('subscribes to mentions and DMs', () => {
    expect(manifest.settings.event_subscriptions.bot_events).toEqual(
      expect.arrayContaining(['app_mention', 'message.im']),
    );
  });

  it('does NOT enable interactivity (no per-agent /interactive handler exists)', () => {
    expect(manifest.settings.interactivity).toBeUndefined();
  });

  it('requests chat:write.customize so the per-agent persona override works', () => {
    expect(manifest.oauth_config.scopes.bot).toContain('chat:write.customize');
  });

  it('does not request the unused commands scope', () => {
    expect(manifest.oauth_config.scopes.bot).not.toContain('commands');
  });

  it('uses the agent display name as the app + bot name', () => {
    expect(manifest.display_information.name).toBe('Ops Bot');
  });
});
