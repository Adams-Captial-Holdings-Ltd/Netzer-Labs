import { describe, expect, it } from 'vitest';
// @ts-expect-error Lambda asset intentionally has no TypeScript declaration file.
import { handler } from './index.js';

describe('power-switch handler', () => {
  it('rejects the former Scheduler event as unsupported', async () => {
    const result = await handler({ source: 'cce.power.scheduler', action: 'auto-pause' });

    expect(result).toEqual({ ok: false, code: 400, error: 'unsupported event' });
  });
});
