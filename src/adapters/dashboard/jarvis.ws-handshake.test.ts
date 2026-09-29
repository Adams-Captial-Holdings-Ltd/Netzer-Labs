import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';

/**
 * Phase 1 WS handshake close-code contract (H4/H6/H8/H11/H15). Drives
 * handleJarvisConnection with a fake socket and overrides only the leaf
 * functions it calls (preserving every other real export via importOriginal so
 * transitive importers keep working).
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
const m = vi.hoisted(() => ({
  consumeWsTicket: vi.fn(),
  lookupToken: vi.fn(),
  isExpired: vi.fn(() => false),
  isJarvisEnabled: vi.fn(async () => true),
  isKillSwitchActive: vi.fn(async (_n?: string) => ({ active: false })),
  readSwitchFailClosed: vi.fn(async (_n?: string) => ({ present: true, active: false })),
  getCurrentPanicState: vi.fn(async () => ({ active: false, generation: 0 })),
  checkAndConsume: vi.fn(async () => ({ allowed: true, remaining: 4, resetAt: 0 })),
  getEffectiveCostCap: vi.fn(async () => 50),
  admitSession: vi.fn(
    async (): Promise<{ ok: boolean; slotIndex?: number; expiresAt?: number; reason?: string }> => ({
      ok: true,
      slotIndex: 0,
      expiresAt: 0,
    }),
  ),
  heartbeat: vi.fn(async () => true),
  releaseSession: vi.fn(async () => {}),
  writeAudit: vi.fn(async (_e: unknown) => {}),
  // Jarvis now speaks with Nova's native audio (no Polly on the voice path). The
  // stub stays only to prove synthesize is NOT called from the voice relay.
  synthesize: vi.fn(async () => ({
    bytes: Buffer.from([1, 0, 2, 0]),
    contentType: 'audio/pcm',
    format: 'pcm' as const,
    sampleRate: 16000,
  })),
  lastCallbacks: { value: null as any },
}));

vi.mock('../../lib/jarvis/ws-ticket.js', async (o) => ({ ...(await o<object>()), consumeWsTicket: m.consumeWsTicket }));
vi.mock('../../lib/state/tokens-repo.js', async (o) => ({ ...(await o<object>()), lookupToken: m.lookupToken, isExpired: m.isExpired }));
vi.mock('../../lib/jarvis/jarvis-flags.js', async (o) => ({ ...(await o<object>()), isJarvisEnabled: m.isJarvisEnabled, readSwitchFailClosed: m.readSwitchFailClosed }));
vi.mock('../../lib/state/kill-switches-repo.js', async (o) => ({ ...(await o<object>()), isKillSwitchActive: m.isKillSwitchActive }));
vi.mock('../../lib/state/panic-state-repo.js', async (o) => ({ ...(await o<object>()), getCurrentPanicState: m.getCurrentPanicState }));
vi.mock('../../lib/state/rate-limits-repo.js', async (o) => ({ ...(await o<object>()), checkAndConsume: m.checkAndConsume }));
vi.mock('../../lib/state/cost-cap-repo.js', async (o) => ({ ...(await o<object>()), getEffectiveCostCap: m.getEffectiveCostCap }));
vi.mock('../../lib/voice/session-leases.js', async (o) => ({ ...(await o<object>()), admitSession: m.admitSession, heartbeat: m.heartbeat, releaseSession: m.releaseSession }));
vi.mock('../../lib/audit/audit-writer.js', async (o) => ({ ...(await o<object>()), writeAudit: m.writeAudit }));
vi.mock('../../lib/polly/synth.js', async (o) => ({ ...(await o<object>()), synthesize: m.synthesize }));
// Never open a real Nova stream in the handshake test — capture the callbacks
// (so we can drive the voice dispatch) and return an inert session.
vi.mock('../../lib/voice/nova-sonic.js', async (o) => ({
  ...(await o<object>()),
  createNovaSonicSession: (_opts: unknown, cb: unknown) => {
    m.lastCallbacks.value = cb;
    return { pushAudio: () => {}, stop: async () => {}, isActive: true };
  },
}));

import { handleJarvisConnection } from './jarvis.js';
import { teardownAllJarvisSessions } from '../../lib/voice/session-registry.js';

interface FakeWs {
  readyState: number;
  close: (code: number, reason: string) => void;
  send: (d: string) => void;
  on: (ev: string, fn: (...a: unknown[]) => void) => void;
  _closes: Array<{ code: number; reason: string }>;
  _sends: Array<{ type?: string }>;
  _listeners: Record<string, (...a: unknown[]) => void>;
}

function fakeWs(): FakeWs {
  const _closes: Array<{ code: number; reason: string }> = [];
  const _sends: Array<{ type?: string }> = [];
  const _listeners: Record<string, (...a: unknown[]) => void> = {};
  return {
    readyState: 1, // OPEN
    close: (code, reason) => _closes.push({ code, reason }),
    send: (d) => _sends.push(JSON.parse(d)),
    on: (ev, fn) => { _listeners[ev] = fn; },
    _closes,
    _sends,
    _listeners,
  };
}

const req = (ticket: string) => ({ headers: { 'sec-websocket-protocol': ticket } });
const validPrincipal = { tokenHash: 'h', role: 'viewer' as const, label: 'V' };
const activeToken = { active: true, role: 'viewer', expiresAt: undefined };

async function run(ticket = 'tok'): Promise<FakeWs> {
  const ws = fakeWs();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await handleJarvisConnection(ws as any, req(ticket) as any, () => {});
  return ws;
}

describe('jarvis WS handshake — close codes', () => {
  beforeEach(() => {
    Object.values(m).forEach((fn: unknown) => {
      if (fn && typeof (fn as { mockReset?: unknown }).mockReset === 'function') (fn as { mockReset: () => void }).mockReset();
    });
    m.lastCallbacks.value = null;
    m.consumeWsTicket.mockResolvedValue(validPrincipal);
    m.lookupToken.mockResolvedValue(activeToken);
    m.isExpired.mockReturnValue(false);
    m.isJarvisEnabled.mockResolvedValue(true);
    m.isKillSwitchActive.mockResolvedValue({ active: false });
    m.readSwitchFailClosed.mockResolvedValue({ present: true, active: false });
    m.getCurrentPanicState.mockResolvedValue({ active: false, generation: 0 });
    m.checkAndConsume.mockResolvedValue({ allowed: true, remaining: 4, resetAt: 0 });
    m.getEffectiveCostCap.mockResolvedValue(50);
    m.admitSession.mockResolvedValue({ ok: true, slotIndex: 0, expiresAt: 0 });
    m.heartbeat.mockResolvedValue(true);
    m.releaseSession.mockResolvedValue(undefined);
    m.writeAudit.mockResolvedValue(undefined);
    m.synthesize.mockResolvedValue({
      bytes: Buffer.from([1, 0, 2, 0]),
      contentType: 'audio/pcm',
      format: 'pcm',
      sampleRate: 16000,
    });
  });
  afterEach(async () => { await teardownAllJarvisSessions('shutdown'); });

  it('4001 — missing/consumed ticket', async () => {
    m.consumeWsTicket.mockResolvedValue(null);
    expect((await run())._closes[0].code).toBe(4001);
    // An empty subprotocol never even calls consume.
    const ws = await run('');
    expect(ws._closes[0].code).toBe(4001);
  });

  it('4011 — token revoked/expired since the ticket was minted (H4)', async () => {
    m.lookupToken.mockResolvedValue(null);
    expect((await run())._closes[0].code).toBe(4011);
    m.lookupToken.mockResolvedValue(activeToken);
    m.isExpired.mockReturnValue(true);
    expect((await run())._closes[0].code).toBe(4011);
  });

  it('root/env token connects when the tokens table is empty (fail-open like HTTP, H4)', async () => {
    const prev = process.env.DASHBOARD_TOKEN;
    process.env.DASHBOARD_TOKEN = 'root-secret-token-1234567890';
    const rootHash = createHash('sha256').update(process.env.DASHBOARD_TOKEN).digest('hex');
    m.consumeWsTicket.mockResolvedValue({ tokenHash: rootHash, role: 'admin', label: 'Root token' });
    m.lookupToken.mockResolvedValue(null); // dashboard-tokens table is empty / root unseeded
    const ws = await run();
    expect(ws._closes.find((c) => c.code === 4011), 'root must not be 4011-rejected').toBeUndefined();
    expect(ws._sends.some((s) => s.type === 'session_ready')).toBe(true);
    ws._listeners.close?.();
    process.env.DASHBOARD_TOKEN = prev;
  });

  it('4003 — isJarvisEnabled false (launch flag / kill / canary, H11)', async () => {
    m.isJarvisEnabled.mockResolvedValue(false);
    expect((await run())._closes[0].code).toBe(4003);
  });

  it('4009 — dashboard_read_disabled active (H13)', async () => {
    m.isKillSwitchActive.mockImplementation(async (n?: string) => ({ active: n === 'dashboard_read_disabled' }));
    expect((await run())._closes[0].code).toBe(4009);
  });

  it('4012 — jarvis_voice_disabled active → client uses text path (H8)', async () => {
    // Admission now reads the voice gate fail-closed via readSwitchFailClosed.
    m.readSwitchFailClosed.mockImplementation(async (n?: string) => ({ present: true, active: n === 'jarvis_voice_disabled' }));
    expect((await run())._closes[0].code).toBe(4012);
  });

  it('4029 — handshake rate limited', async () => {
    m.checkAndConsume.mockResolvedValue({ allowed: false, remaining: 0, resetAt: 0 });
    expect((await run())._closes[0].code).toBe(4029);
  });

  it('4000 — same-token newcomer rejected, incumbent untouched (H6)', async () => {
    m.admitSession.mockResolvedValue({ ok: false, reason: 'token_conflict' });
    expect((await run())._closes[0].code).toBe(4000);
  });

  it('4013 — daily spend cap reached (H5)', async () => {
    m.admitSession.mockResolvedValue({ ok: false, reason: 'spend_cap' });
    expect((await run())._closes[0].code).toBe(4013);
  });

  it('4009 — a gate flips during admission, caught by the final guarded recheck (H15)', async () => {
    // isJarvisEnabled passes the handshake gate, but panic is now active by the
    // time the post-admission recheck (isStillAdmissible) reads it.
    m.getCurrentPanicState.mockResolvedValue({ active: true, generation: 1 });
    expect((await run())._closes[0].code).toBe(4009);
  });

  it('carries the person behind the token into the voice session, as the HTTP path does', async () => {
    // The ticket holds only the token's hash, role and label. Without the person,
    // the voice `sessions` answer filtered out every conversation a member owns
    // (decisions 1 and 9; the second critic's NEW-7).
    // The principal the whole session runs as, as admission first sees it.
    const sessionPrincipal = async (record: Record<string, unknown>) => {
      m.isJarvisEnabled.mockClear();
      m.lookupToken.mockResolvedValue({ ...activeToken, ...record });
      (await run())._listeners.close?.();
      return (m.isJarvisEnabled.mock.calls[0] as unknown[] | undefined)?.[0];
    };

    expect(await sessionPrincipal({ userId: 'user-a' })).toMatchObject({ tokenHash: 'h', userId: 'user-a' });
    expect(await sessionPrincipal({ linkedUserId: 'user-b' })).toMatchObject({ tokenHash: 'h', linkedUserId: 'user-b' });
  });

  it('admits a valid handshake → session_ready, no close', async () => {
    const ws = await run();
    expect(ws._closes).toHaveLength(0);
    expect(ws._sends.some((s) => s.type === 'session_ready')).toBe(true);
    expect(m.admitSession).toHaveBeenCalledOnce();
    // Trigger the close listener to clear the heartbeat + max-session timers.
    ws._listeners.close?.();
  });

  it('voice callbacks: forwards Nova native audio, captions assistant turns, blocks an above-role navigate (audited)', async () => {
    const ws = await run();
    const cb = m.lastCallbacks.value as {
      onAudioOut: (b: string) => void;
      onTextTranscript: (text: string, role: 'USER' | 'ASSISTANT') => void;
      onToolUse: (id: string, name: string, input: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
    expect(cb).toBeTruthy();

    // The greeting "kick" is synthesized once via Polly and fed to Nova at session
    // start; its phantom USER transcript is SUPPRESSED (never forwarded as a user turn).
    expect(m.synthesize).toHaveBeenCalled();
    cb.onTextTranscript('hello, hello, good day to you.', 'USER'); // the kick echo
    expect(ws._sends.some((s) => (s as { type?: string; role?: string }).type === 'transcript' && (s as { role?: string }).role === 'user')).toBe(false);

    // Nova 2 Sonic speaks natively — its 24kHz PCM frames are forwarded straight to
    // the browser (no Polly on replies). The transcript is the on-screen caption;
    // the empty end-of-turn marker becomes speaking_stop.
    cb.onAudioOut('PCM24K');
    cb.onTextTranscript('Right away, sir.', 'ASSISTANT');
    cb.onTextTranscript('  Right away, sir.  ', 'ASSISTANT'); // Nova's whitespace-variant copy → deduped
    cb.onTextTranscript('', 'ASSISTANT'); // end-of-turn → speaking_stop
    const audioOut = ws._sends.find((s) => (s as { type?: string }).type === 'audio_out') as
      | { b64?: string; rate?: number }
      | undefined;
    expect(audioOut?.b64).toBe('PCM24K');
    expect(audioOut?.rate).toBe(24000);
    // The near-duplicate (leading/trailing whitespace) is suppressed — the line is
    // forwarded exactly once, trimmed.
    const sirTranscripts = ws._sends.filter(
      (s) => (s as { type?: string; role?: string; text?: string }).type === 'transcript' && (s as { text?: string }).text === 'Right away, sir.',
    );
    expect(sirTranscripts).toHaveLength(1);
    expect(ws._sends.some((s) => (s as { type?: string }).type === 'speaking_stop')).toBe(true);

    // A viewer cannot navigate to /kill-switches — the relay re-validates the
    // route server-side (isRouteAllowed) and audits the block.
    const r = await cb.onToolUse('t1', 'navigate', { route: '/kill-switches' });
    expect(r).toMatchObject({ error: 'ROUTE_FORBIDDEN' });
    const navBlocked = m.writeAudit.mock.calls.some((c) => {
      const e = c[0] as { action?: string; result?: string };
      return e.action === 'jarvis_navigate' && e.result === 'blocked';
    });
    expect(navBlocked).toBe(true);

    ws._listeners.close?.();
  });
});
