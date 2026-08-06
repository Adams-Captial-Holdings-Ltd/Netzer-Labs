import { describe, it, expect, vi, beforeEach } from 'vitest';

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../state/ddb.js', () => ({ ddb: () => ({ send }) }));

import { mintWsTicket, consumeWsTicket, TICKET_TTL_SECONDS } from './ws-ticket.js';
import type { TokenPrincipal } from '../auth/dashboard-auth.js';

const principal: TokenPrincipal = {
  tokenHash: 'abc123hash',
  label: 'Ops token',
  hashPrefix16: 'abc123hash',
  role: 'operator',
};

describe('ws-ticket (H10)', () => {
  beforeEach(() => send.mockReset());

  it('mints a 256-bit ticket holding the resolved principal, never the raw token', async () => {
    send.mockResolvedValue({});
    const before = Math.floor(Date.now() / 1000);
    const ticket = await mintWsTicket(principal);
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{40,}$/); // base64url, 32 bytes

    const cmd = send.mock.calls[0][0];
    expect(cmd.constructor.name).toBe('PutCommand');
    const item = cmd.input.Item;
    expect(item.ticket).toBe(ticket);
    expect(item).toMatchObject({ tokenHash: 'abc123hash', role: 'operator', label: 'Ops token' });
    expect(item.expiresAt).toBeGreaterThanOrEqual(before + TICKET_TTL_SECONDS);
    // No raw token anywhere on the stored record.
    expect(JSON.stringify(item)).not.toContain('Bearer');
  });

  it('consumes a valid ticket atomically and returns the principal', async () => {
    send.mockResolvedValue({ Attributes: { tokenHash: 'h', role: 'viewer', label: 'V', greet: true } });
    const p = await consumeWsTicket('some-ticket');
    expect(p).toEqual({ tokenHash: 'h', role: 'viewer', label: 'V', greet: true });

    const cmd = send.mock.calls[0][0];
    expect(cmd.constructor.name).toBe('DeleteCommand');
    expect(cmd.input.ConditionExpression).toBe('attribute_exists(ticket) AND expiresAt >= :now');
    expect(cmd.input.ReturnValues).toBe('ALL_OLD');
    expect(cmd.input.Key).toEqual({ ticket: 'some-ticket' });
  });

  it('returns null for a consumed/expired ticket (the conditional delete returns no record)', async () => {
    // A consumed/expired ticket fails the conditional delete and yields no
    // ALL_OLD Attributes; consume resolves to null. (The real DDB throws
    // ConditionalCheckFailedException on the failed condition — exercised by
    // jarvis.integration.test.ts; consumeWsTicket maps that to null too.)
    send.mockResolvedValue({});
    expect(await consumeWsTicket('stale')).toBeNull();
  });

  it('returns null for an empty ticket without touching DDB', async () => {
    expect(await consumeWsTicket('')).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('fails closed (null) when the consume errors', async () => {
    send.mockImplementationOnce(() => Promise.reject(new Error('ddb down')));
    await expect(consumeWsTicket('x')).resolves.toBeNull();
  });
});
