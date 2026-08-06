import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Phase 0 exit-criterion proof, fully deterministic (Bedrock mocked):
 *   1. a text prompt drives a `navigate` tool_call over SSE and writes a
 *      `jarvis_navigate` audit row tagged origin:'jarvis';
 *   2. the fail-closed gate blocks the call with 503 when Jarvis is disabled.
 */

const { send, isJarvisEnabled, writeAudit, authenticateDashboardToken, isKillSwitchActive, recordUsage, getDailyCostUsd, synthesize } = vi.hoisted(() => ({
  send: vi.fn(),
  isJarvisEnabled: vi.fn(),
  writeAudit: vi.fn(async (_event: unknown) => {}),
  authenticateDashboardToken: vi.fn(async () => ({
    tokenHash: 'h',
    label: 'Root token',
    hashPrefix16: 'h',
    role: 'admin' as const,
  })),
  isKillSwitchActive: vi.fn(async (_name: string) => ({ active: false })),
  recordUsage: vi.fn(async () => true),
  getDailyCostUsd: vi.fn(async () => 0),
  // Polly is mocked so the narration path is hermetic: it returns a tiny PCM
  // buffer the text turn base64-encodes into an `audio` SSE frame. The typed
  // input param keeps `synthesize.mock.calls[0][0]` accessible under tsc.
  synthesize: vi.fn(async (_input: { text: string; ssml?: boolean; format?: string; voiceId?: string; engine?: string }) => ({
    bytes: Buffer.from([1, 0, 2, 0]),
    contentType: 'audio/pcm',
    format: 'pcm' as const,
    sampleRate: 16000,
  })),
}));

vi.mock('../../lib/bedrock/client.js', () => ({ bedrockClient: () => ({ send }) }));
vi.mock('../../lib/jarvis/jarvis-flags.js', () => ({
  isJarvisEnabled,
  isJarvisLaunchEnabled: () => true,
}));
vi.mock('../../lib/state/kill-switches-repo.js', async () => {
  const actual = await vi.importActual<typeof import('../../lib/state/kill-switches-repo.js')>(
    '../../lib/state/kill-switches-repo.js',
  );
  return { ...actual, isKillSwitchActive };
});
vi.mock('../../lib/audit/audit-writer.js', () => ({ writeAudit }));
vi.mock('../../lib/polly/synth.js', async (o) => ({ ...(await o<object>()), synthesize }));
vi.mock('../../lib/auth/dashboard-auth.js', () => ({
  authenticateDashboardToken,
  extractBearerToken: (h?: string) => (h ? h.replace(/^Bearer\s+/i, '') : ''),
}));
// The text turn meters every model call via recordUsage (a DDB write) and reads
// daily spend via getDailyCostUsd for the per-call cost cap. Mock both so the flow
// is hermetic: recordUsage CONFIRMS (no `usage_unconfirmed` short-circuit) and spend
// reads as $0 (under cap). The real cost-cap safety behavior is unchanged.
vi.mock('../../lib/usage/token-tracker.js', async () => {
  const actual = await vi.importActual<typeof import('../../lib/usage/token-tracker.js')>(
    '../../lib/usage/token-tracker.js',
  );
  return { ...actual, recordUsage, getDailyCostUsd };
});

import { buildJarvisRouter } from './jarvis.js';

// Build a mock ConverseStream response ({ stream }) from a Converse-style content
// array, so `send` returns the async-iterable shape the streaming text-turn reads.
type Block = { text: string } | { toolUse: { toolUseId: string; name: string; input?: unknown } };
function streamOf(content: Block[], stopReason: string) {
  async function* gen() {
    for (let i = 0; i < content.length; i++) {
      const b = content[i];
      if ('toolUse' in b) {
        yield { contentBlockStart: { contentBlockIndex: i, start: { toolUse: { toolUseId: b.toolUse.toolUseId, name: b.toolUse.name } } } };
        yield { contentBlockDelta: { contentBlockIndex: i, delta: { toolUse: { input: JSON.stringify(b.toolUse.input ?? {}) } } } };
        yield { contentBlockStop: { contentBlockIndex: i } };
      } else {
        yield { contentBlockDelta: { contentBlockIndex: i, delta: { text: b.text } } };
        yield { contentBlockStop: { contentBlockIndex: i } };
      }
    }
    yield { messageStop: { stopReason } };
    yield { metadata: { usage: { inputTokens: 10, outputTokens: 5 } } };
  }
  return { stream: gen() };
}

// Emit one assistant text block as MANY deltas, to exercise incremental streaming.
function streamChunks(parts: string[], stopReason: string) {
  async function* gen() {
    for (const p of parts) {
      yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: p } } };
    }
    yield { contentBlockStop: { contentBlockIndex: 0 } };
    yield { messageStop: { stopReason } };
    yield { metadata: { usage: { inputTokens: 10, outputTokens: 5 } } };
  }
  return { stream: gen() };
}

function req(body: unknown) {
  return new Request('http://local/text-turn', {
    method: 'POST',
    headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function reqPath(path: string, body: unknown) {
  return new Request(`http://local${path}`, {
    method: 'POST',
    headers: { authorization: 'Bearer test', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('jarvis text-turn flow (Phase 0 exit criterion)', () => {
  beforeEach(() => {
    send.mockReset();
    writeAudit.mockClear();
    isJarvisEnabled.mockReset();
    isKillSwitchActive.mockReset();
    isKillSwitchActive.mockResolvedValue({ active: false });
    synthesize.mockClear();
    delete process.env.CCE_TTS_ENABLED;
    // Let narrateSentence fall back to its code defaults (generative / Amy / 116%)
    // so the narration assertions are independent of any ambient env.
    delete process.env.JARVIS_TTS_ENGINE;
    delete process.env.JARVIS_TTS_VOICE_ID;
    delete process.env.JARVIS_TTS_RATE;
    process.env.BEDROCK_DEFAULT_MODEL = 'us.anthropic.claude-sonnet-4-6-v1:0';
  });

  it('drives a navigate tool_call and writes a jarvis_navigate audit row', async () => {
    isJarvisEnabled.mockResolvedValue(true);
    // Turn 1: the model asks to navigate. Turn 2: it narrates and stops.
    send
      .mockResolvedValueOnce(streamOf([{ toolUse: { toolUseId: 't1', name: 'navigate', input: { route: '/agents' } } }], 'tool_use'))
      .mockResolvedValueOnce(streamOf([{ text: 'Now showing agents. Two are healthy.' }], 'end_turn'));

    const router = buildJarvisRouter();
    const res = await router.request(req({ text: 'go to agents and tell me how they are doing' }));
    expect(res.status).toBe(200);
    const sse = await res.text();

    // The relay told the browser to navigate to /agents (setLocation) …
    expect(sse).toContain('event: tool_call');
    expect(sse).toContain('"toolName":"navigate"');
    expect(sse).toContain('"route":"/agents"');
    // … narrated a final transcript …
    expect(sse).toContain('event: transcript');
    expect(sse).toContain('event: done');

    // … and wrote the immutable jarvis_navigate row tagged origin:'jarvis'.
    const navRows = writeAudit.mock.calls
      .map((c) => c[0] as { action: string; detail?: Record<string, unknown> })
      .filter((e) => e.action === 'jarvis_navigate');
    expect(navRows).toHaveLength(1);
    expect(navRows[0].detail).toMatchObject({ origin: 'jarvis', route: '/agents', allowed: true });
    expect(navRows[0]).toMatchObject({ surface: 'dashboard', result: 'ok' });

    // session_start + session_end bookend the turn.
    const actions = writeAudit.mock.calls.map((c) => (c[0] as { action: string }).action);
    expect(actions).toContain('jarvis_session_start');
    expect(actions).toContain('jarvis_session_end');
  });

  it('forwards a show_card tool_call to the browser and reports ok to the model', async () => {
    isJarvisEnabled.mockResolvedValue(true);
    const card = {
      title: 'Spend today',
      metrics: [{ label: 'Today', value: '$4.12' }, { label: '7-day avg', value: '$3.80', delta: '+8%', tone: 'neutral' }],
      spark: [2.1, 3.4, 3.9, 4.12],
      footer: 'Under the daily cap.',
    };
    send
      .mockResolvedValueOnce(streamOf([{ toolUse: { toolUseId: 't1', name: 'show_card', input: card } }], 'tool_use'))
      .mockResolvedValueOnce(streamOf([{ text: 'About four dollars so far.' }], 'end_turn'));

    const router = buildJarvisRouter();
    const res = await router.request(req({ text: 'what is my spend today' }));
    expect(res.status).toBe(200);
    const sse = await res.text();

    // The display-only card is forwarded to the browser intact …
    expect(sse).toContain('"toolName":"show_card"');
    expect(sse).toContain('"title":"Spend today"');
    expect(sse).toContain('"spark":[2.1,3.4,3.9,4.12]');
    // … and the loop continued to the narrated final turn.
    expect(sse).toContain('About four dollars so far.');
    expect(sse).toContain('event: done');
  });

  it('forwards the highlight label alongside the target', async () => {
    isJarvisEnabled.mockResolvedValue(true);
    send
      .mockResolvedValueOnce(
        streamOf([{ toolUse: { toolUseId: 't1', name: 'highlight', input: { target: '[data-testid="cost-cap"]', label: 'Daily cost cap' } } }], 'tool_use'),
      )
      .mockResolvedValueOnce(streamOf([{ text: 'That control right there.' }], 'end_turn'));

    const router = buildJarvisRouter();
    const res = await router.request(req({ text: 'where is the cost cap' }));
    expect(res.status).toBe(200);
    const sse = await res.text();
    expect(sse).toContain('"toolName":"highlight"');
    expect(sse).toContain('"label":"Daily cost cap"');
  });

  it('honors a valid Anthropic model override on the text turn', async () => {
    isJarvisEnabled.mockResolvedValue(true);
    process.env.BEDROCK_HAIKU_MODEL = 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
    send.mockResolvedValueOnce(streamOf([{ text: 'Quick answer.' }], 'end_turn'));

    const router = buildJarvisRouter();
    const res = await router.request(
      req({ text: 'hello', model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' }),
    );
    expect(res.status).toBe(200);
    await res.text();
    const cmd = send.mock.calls[0][0] as { input: { modelId: string } };
    expect(cmd.input.modelId).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0');
    delete process.env.BEDROCK_HAIKU_MODEL;
  });

  it('ignores an unknown model override and uses the default (fail-closed allowlist)', async () => {
    isJarvisEnabled.mockResolvedValue(true);
    send.mockResolvedValueOnce(streamOf([{ text: 'Quick answer.' }], 'end_turn'));

    const router = buildJarvisRouter();
    const res = await router.request(req({ text: 'hello', model: 'openai.gpt-oss-120b-1:0' }));
    expect(res.status).toBe(200);
    await res.text();
    const cmd = send.mock.calls[0][0] as { input: { modelId: string } };
    // The non-Anthropic id is in the Playground catalog but NOT in the Jarvis
    // allowlist — the turn must run on the configured default.
    expect(cmd.input.modelId).toBe('us.anthropic.claude-sonnet-4-6-v1:0');
  });

  it('blocks the text turn (no model call) when bedrock_global is active', async () => {
    isJarvisEnabled.mockResolvedValue(true);
    isKillSwitchActive.mockImplementation(async (name: string) => ({ active: name === 'bedrock_global' }));
    const router = buildJarvisRouter();
    const res = await router.request(req({ text: 'go to agents' }));
    // The gate passed, so it's a 200 SSE stream — but the turn refuses the model.
    expect(res.status).toBe(200);
    const sse = await res.text();
    expect(sse).toContain('bedrock_disabled');
    expect(send).not.toHaveBeenCalled();
    const actions = writeAudit.mock.calls.map((c) => (c[0] as { action: string }).action);
    expect(actions).toContain('kill_switch_blocked');
  });

  it('stops mid-loop when bedrock_global flips active between tool turns', async () => {
    isJarvisEnabled.mockResolvedValue(true);
    // bedrock_global: inactive on the first per-call check, active on the second.
    let bedrockChecks = 0;
    isKillSwitchActive.mockImplementation(async (name: string) => {
      if (name === 'bedrock_global') {
        bedrockChecks += 1;
        return { active: bedrockChecks >= 2 };
      }
      return { active: false };
    });
    // Turn 1 asks for a tool (so the loop would continue to a 2nd model call).
    send.mockResolvedValueOnce(
      streamOf([{ toolUse: { toolUseId: 't1', name: 'navigate', input: { route: '/agents' } } }], 'tool_use'),
    );

    const router = buildJarvisRouter();
    const res = await router.request(req({ text: 'go to agents' }));
    expect(res.status).toBe(200);
    const sse = await res.text();
    // Exactly one model call happened; the 2nd was stopped by the flip.
    expect(send).toHaveBeenCalledTimes(1);
    expect(sse).toContain('bedrock_disabled');
  });

  it('streams assistant text as cumulative partials, then one final frame', async () => {
    isJarvisEnabled.mockResolvedValue(true);
    send.mockResolvedValueOnce(streamChunks(['Two ', 'agents ', 'are ', 'healthy.'], 'end_turn'));

    const router = buildJarvisRouter();
    const res = await router.request(req({ text: 'how are the agents' }));
    expect(res.status).toBe(200);
    const sse = await res.text();

    // Partials arrive as GROWING cumulative text with final:false …
    expect(sse).toContain('"text":"Two ","role":"assistant","final":false');
    expect(sse).toContain('"text":"Two agents ","role":"assistant","final":false');
    expect(sse).toContain('"text":"Two agents are ","role":"assistant","final":false');
    // … then exactly one final:true with the full trimmed text.
    expect(sse).toContain('"text":"Two agents are healthy.","role":"assistant","final":true');
    expect(sse.split('"final":true').length - 1).toBe(1);
    expect(sse).toContain('event: done');
  });

  it('emits model_error (keeping the partial) when the stream throws mid-way', async () => {
    isJarvisEnabled.mockResolvedValue(true);
    async function* boom() {
      yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'Hel' } } };
      throw new Error('stream broke');
    }
    send.mockResolvedValueOnce({ stream: boom() });

    const router = buildJarvisRouter();
    const res = await router.request(req({ text: 'hi' }));
    expect(res.status).toBe(200);
    const sse = await res.text();
    // The partial that streamed before the break is preserved …
    expect(sse).toContain('"text":"Hel","role":"assistant","final":false');
    // … and the turn surfaces a model_error rather than hanging.
    expect(sse).toContain('event: error');
    expect(sse).toContain('model_error');
  });

  it('blocks with 503 when jarvis_disabled (fail-closed gate)', async () => {
    isJarvisEnabled.mockResolvedValue(false);
    const router = buildJarvisRouter();
    const res = await router.request(req({ text: 'go to agents' }));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('jarvis_disabled');
    expect(send).not.toHaveBeenCalled();
  });

  it('narrates each committed sentence as an audio frame when speak:true (guided routine)', async () => {
    isJarvisEnabled.mockResolvedValue(true);
    process.env.CCE_TTS_ENABLED = '1';
    send.mockResolvedValueOnce(streamOf([{ text: 'We begin at the Overview.' }], 'end_turn'));

    const router = buildJarvisRouter();
    const res = await router.request(req({ text: 'run the demo walkthrough', speak: true }));
    expect(res.status).toBe(200);
    const sse = await res.text();

    // The committed sentence was synthesized (as SSML, generative voice) and
    // streamed as a base64 PCM frame.
    expect(synthesize).toHaveBeenCalledTimes(1);
    const synthInput = synthesize.mock.calls[0][0];
    expect(synthInput).toMatchObject({ ssml: true, format: 'pcm', engine: 'generative' });
    expect(synthInput.text).toContain('We begin at the Overview.');
    expect(synthInput.text).toContain('<prosody rate=');
    expect(sse).toContain('event: audio');
    expect(sse).toContain('"b64":"AQACAA=="'); // Buffer([1,0,2,0]) base64
    expect(sse).toContain('"rate":16000');
  });

  it('stays silent (no synth, no audio frame) when speak is absent', async () => {
    isJarvisEnabled.mockResolvedValue(true);
    process.env.CCE_TTS_ENABLED = '1';
    send.mockResolvedValueOnce(streamOf([{ text: 'Two agents are healthy.' }], 'end_turn'));

    const router = buildJarvisRouter();
    const res = await router.request(req({ text: 'how are the agents' }));
    expect(res.status).toBe(200);
    const sse = await res.text();

    expect(synthesize).not.toHaveBeenCalled();
    expect(sse).not.toContain('event: audio');
  });

  it('drops narration when the tts_disabled kill switch is active (one switch governs all audio)', async () => {
    isJarvisEnabled.mockResolvedValue(true);
    process.env.CCE_TTS_ENABLED = '1';
    isKillSwitchActive.mockImplementation(async (name: string) => ({ active: name === 'tts_disabled' }));
    send.mockResolvedValueOnce(streamOf([{ text: 'We begin at the Overview.' }], 'end_turn'));

    const router = buildJarvisRouter();
    const res = await router.request(req({ text: 'run the demo walkthrough', speak: true }));
    expect(res.status).toBe(200);
    const sse = await res.text();

    // Text still reached the user; audio did not.
    expect(sse).toContain('event: transcript');
    expect(synthesize).not.toHaveBeenCalled();
    expect(sse).not.toContain('event: audio');
  });

  it('does not narrate when CCE_TTS_ENABLED is unset, even with speak:true', async () => {
    isJarvisEnabled.mockResolvedValue(true);
    // CCE_TTS_ENABLED deliberately left unset (deleted in beforeEach).
    send.mockResolvedValueOnce(streamOf([{ text: 'We begin at the Overview.' }], 'end_turn'));

    const router = buildJarvisRouter();
    const res = await router.request(req({ text: 'run the demo walkthrough', speak: true }));
    expect(res.status).toBe(200);
    const sse = await res.text();
    expect(synthesize).not.toHaveBeenCalled();
    expect(sse).not.toContain('event: audio');
  });

  // ── Scripted Demo Walkthrough endpoint (POST /narrate) ──────────────
  it('POST /narrate returns base64 PCM for a line when narration is enabled', async () => {
    isJarvisEnabled.mockResolvedValue(true);
    process.env.CCE_TTS_ENABLED = '1';

    const router = buildJarvisRouter();
    const res = await router.request(reqPath('/narrate', { text: 'Welcome back, Emmanuel.' }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { b64: string; rate: number };
    expect(body).toMatchObject({ b64: 'AQACAA==', rate: 16000 });
    // Synthesized as SSML with the generative voice (same path as the text turn).
    expect(synthesize.mock.calls[0][0]).toMatchObject({ ssml: true, engine: 'generative' });
    expect(synthesize.mock.calls[0][0].text).toContain('Welcome back, Emmanuel.');
    expect(send).not.toHaveBeenCalled(); // no model call on this path
  });

  it('POST /narrate is 403 when CCE_TTS_ENABLED is unset', async () => {
    isJarvisEnabled.mockResolvedValue(true);
    const router = buildJarvisRouter();
    const res = await router.request(reqPath('/narrate', { text: 'hello' }));
    expect(res.status).toBe(403);
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('POST /narrate is 403 when the tts_disabled kill switch is active', async () => {
    isJarvisEnabled.mockResolvedValue(true);
    process.env.CCE_TTS_ENABLED = '1';
    isKillSwitchActive.mockImplementation(async (name: string) => ({ active: name === 'tts_disabled' }));
    const router = buildJarvisRouter();
    const res = await router.request(reqPath('/narrate', { text: 'hello' }));
    expect(res.status).toBe(403);
    expect(synthesize).not.toHaveBeenCalled();
  });

  it('POST /narrate rejects missing and over-long text', async () => {
    isJarvisEnabled.mockResolvedValue(true);
    process.env.CCE_TTS_ENABLED = '1';
    const router = buildJarvisRouter();
    const empty = await router.request(reqPath('/narrate', { text: '   ' }));
    expect(empty.status).toBe(400);
    const long = await router.request(reqPath('/narrate', { text: 'x'.repeat(601) }));
    expect(long.status).toBe(400);
    expect(synthesize).not.toHaveBeenCalled();
  });
});
