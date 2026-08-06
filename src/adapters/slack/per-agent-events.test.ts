import { describe, it, expect } from 'vitest';
import { buildSlackRouter } from './handler.js';

/**
 * The per-agent Slack events route must answer Slack's one-time
 * `url_verification` challenge BEFORE it requires stored credentials or a
 * valid signature. Slack fires that challenge the moment an operator creates
 * the app from the generated manifest — which is before any bot token or
 * signing secret exists to paste into the dashboard. If the route gated the
 * handshake behind creds, app creation would fail with "Your URL didn't
 * respond", the chicken-and-egg that makes Slack setup painful.
 */
describe('per-agent slack events: url_verification handshake', () => {
  it('echoes the challenge with no creds and no signature', async () => {
    const router = buildSlackRouter();
    const res = await router.request('/brand-new-agent/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'url_verification', challenge: 'c-9f2a1' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { challenge: string };
    expect(body.challenge).toBe('c-9f2a1');
  });

  it('returns 400 on malformed JSON before touching creds', async () => {
    const router = buildSlackRouter();
    const res = await router.request('/brand-new-agent/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    expect(res.status).toBe(400);
  });
});
