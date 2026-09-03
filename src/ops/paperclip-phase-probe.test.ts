import { describe, expect, it } from 'vitest';
import {
  PAPERCLIP_PHASE_PROBE_FAILURE_MARKER,
  PAPERCLIP_PHASE_PROBE_SUCCESS_MARKERS,
  paperclipPhaseProbeFailureLine,
  redactShape,
  runPaperclipPhaseProbe,
  type PaperclipPhaseProbeDeps,
} from './paperclip-phase-probe.js';

const AGENT_SECRET = 'agent-api-key-never-log';
const ENV = {
  PAPERCLIP_BASE_URL: 'https://paperclip.internal',
  PAPERCLIP_COMPANY_ID: 'company-live',
  PAPERCLIP_AGENT_KEYS_JSON: JSON.stringify({ main: AGENT_SECRET }),
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function text(body: string, contentType = 'text/plain'): Response {
  return new Response(body, { status: 200, headers: { 'content-type': contentType } });
}

function sequence(items: Array<Response | Error>): NonNullable<PaperclipPhaseProbeDeps['fetchFn']> {
  let index = 0;
  return async () => {
    const item = items[index++];
    if (item === undefined) throw new Error('test response sequence exhausted');
    if (item instanceof Error) throw item;
    return item;
  };
}

async function failureLine(deps: PaperclipPhaseProbeDeps): Promise<string> {
  try {
    await runPaperclipPhaseProbe(deps);
  } catch (error) {
    return paperclipPhaseProbeFailureLine(error);
  }
  throw new Error('expected probe failure');
}

describe('Paperclip phase probe redaction', () => {
  it('records structure and primitive types without recording values', () => {
    const shape = redactShape({
      id: 'secret-uuid',
      title: 'operator text',
      count: 3,
      enabled: true,
      nested: [{ token: 'never-log-me' }],
      missing: null,
      '123e4567-e89b-12d3-a456-426614174000': { name: 'hidden dynamic key' },
    });
    expect(shape).toEqual({
      count: 'number',
      enabled: 'boolean',
      id: 'string',
      missing: 'null',
      nested: [{ token: 'string' }],
      title: 'string',
      '<uuid-key>': { name: 'string' },
    });
    expect(JSON.stringify(shape)).not.toContain('secret-uuid');
    expect(JSON.stringify(shape)).not.toContain('never-log-me');
    expect(JSON.stringify(shape)).not.toContain('123e4567');
  });

  it('emits every success marker with redacted live response shapes', async () => {
    const responseSecrets = [
      'org-secret',
      'whoami-secret',
      'list-secret',
      'created-secret',
      'get-secret',
      'update-secret',
      'delete-secret',
    ];
    const logs: string[] = [];
    await runPaperclipPhaseProbe({
      env: ENV,
      uuid: () => 'fixed-probe-id',
      log: (line) => logs.push(line),
      fetchFn: sequence([
        json({ title: responseSecrets[0] }),
        json({ email: responseSecrets[1] }),
        json([{ description: responseSecrets[2] }]),
        text(`<svg><text>${responseSecrets[0]}</text></svg>`, 'image/svg+xml'),
        json({ id: 'goal-live-id', title: responseSecrets[3] }),
        json({ id: 'goal-live-id', title: responseSecrets[4] }),
        json({ id: 'goal-live-id', title: responseSecrets[5] }),
        json({ deleted: true, value: responseSecrets[6] }),
      ]),
    });

    const records = logs.map((line) =>
      JSON.parse(line.slice('PAPERCLIP_PHASE_PROBE '.length)) as { name: string },
    );
    expect(records.map((record) => record.name)).toEqual(PAPERCLIP_PHASE_PROBE_SUCCESS_MARKERS);
    const output = logs.join('\n');
    expect(output).not.toContain(AGENT_SECRET);
    expect(output).not.toContain('goal-live-id');
    expect(output).not.toContain('fixed-probe-id');
    for (const secret of responseSecrets) expect(output).not.toContain(secret);
  });

  it('normalizes attacker-controlled success content types before logging', async () => {
    const headerSecret = 'attacker-secret-content-type';
    const logs: string[] = [];
    await runPaperclipPhaseProbe({
      env: ENV,
      log: (line) => logs.push(line),
      fetchFn: sequence([
        text('opaque', `application/${headerSecret}`),
        json({ ok: true }),
        json([]),
        text('<svg/>', 'image/svg+xml'),
        json({ id: 'goal-live-id' }),
        json({ id: 'goal-live-id' }),
        json({ id: 'goal-live-id' }),
        json({ deleted: true }),
      ]),
    });

    const output = logs.join('\n');
    expect(logs).toHaveLength(PAPERCLIP_PHASE_PROBE_SUCCESS_MARKERS.length);
    expect(output).toContain('"contentType":"other"');
    expect(output).not.toContain(headerSecret);
  });

  it('redacts malformed agent JSON from the failure marker', async () => {
    const secret = '{"main":"agent-secret-fragment"';
    const line = await failureLine({ env: { ...ENV, PAPERCLIP_AGENT_KEYS_JSON: secret } });
    expect(line).toContain(`${PAPERCLIP_PHASE_PROBE_FAILURE_MARKER} PaperclipPhaseProbeError`);
    expect(line).toContain('invalid-agent-keys-json');
    expect(line).not.toContain(secret);
    expect(line).not.toContain('agent-secret-fragment');
  });

  it.each([
    ['PAPERCLIP_BASE_URL', 'missing-base-url'],
    ['PAPERCLIP_COMPANY_ID', 'missing-company-id'],
    ['PAPERCLIP_AGENT_KEYS_JSON', 'missing-agent-keys-json'],
  ] as const)('reports a controlled code when %s is absent', async (name, code) => {
    const secret = 'missing-input-never-log';
    const line = await failureLine({ env: { ...ENV, [name]: `   `, unrelated: secret } });
    expect(line).toContain(code);
    expect(line).not.toContain(secret);
  });

  it('redacts unusable agent JSON shapes from the failure marker', async () => {
    for (const [agentJson, code] of [
      ['["array-agent-secret"]', 'agent-keys-json-not-an-object'],
      ['{"agent-secret-key":""}', 'no-usable-agent-key'],
    ] as const) {
      const line = await failureLine({
        env: { ...ENV, PAPERCLIP_AGENT_KEYS_JSON: agentJson },
      });
      expect(line).toContain(code);
      expect(line).not.toContain('array-agent-secret');
      expect(line).not.toContain('agent-secret-key');
    }
  });

  it('redacts invalid response JSON from the failure marker', async () => {
    const secret = '{"token":"response-secret-fragment"';
    const line = await failureLine({
      env: ENV,
      fetchFn: sequence([
        new Response(secret, { headers: { 'content-type': 'application/json' } }),
      ]),
    });
    expect(line).toContain('response-body-invalid-json');
    expect(line).not.toContain(secret);
    expect(line).not.toContain('response-secret-fragment');
  });

  it('redacts JSON error responses on a rejected request', async () => {
    const secret = 'paperclip-error-response-secret';
    const line = await failureLine({
      env: ENV,
      fetchFn: sequence([json({ error: secret }, 503)]),
    });
    expect(line).toContain('request-rejected (HTTP 503)');
    expect(line).not.toContain(secret);
  });

  it('redacts fetch, response metadata, and response body errors', async () => {
    const cases: Array<{ secret: string; response: Error | Response; code: string }> = [
      {
        secret: 'fetch-error-secret',
        response: new Error('fetch-error-secret'),
        code: 'request-failed-before-response',
      },
      {
        secret: 'metadata-error-secret',
        response: {
          headers: { get: () => { throw new Error('metadata-error-secret'); } },
        } as unknown as Response,
        code: 'response-metadata-unreadable',
      },
      {
        secret: 'body-error-secret',
        response: {
          headers: { get: () => 'application/json' },
          text: async () => { throw new Error('body-error-secret'); },
        } as unknown as Response,
        code: 'response-body-unreadable',
      },
    ];

    for (const item of cases) {
      const line = await failureLine({ env: ENV, fetchFn: sequence([item.response]) });
      expect(line).toContain(item.code);
      expect(line).not.toContain(item.secret);
    }
  });

  it('redacts invalid SVG and missing goal-id response bodies', async () => {
    const svgSecret = 'not-svg-response-secret';
    const svgLogs: string[] = [];
    const svgLine = await failureLine({
      env: ENV,
      log: (line) => svgLogs.push(line),
      fetchFn: sequence([
        json({ ok: true }),
        json({ ok: true }),
        json([]),
        text(svgSecret, 'image/svg+xml'),
      ]),
    });
    expect(svgLine).toContain('org-svg-invalid');
    expect(`${svgLine}\n${svgLogs.join('\n')}`).not.toContain(svgSecret);

    const goalSecret = 'goal-create-response-secret';
    const goalLogs: string[] = [];
    const goalLine = await failureLine({
      env: ENV,
      log: (line) => goalLogs.push(line),
      fetchFn: sequence([
        json({ ok: true }),
        json({ ok: true }),
        json([]),
        text('<svg/>', 'image/svg+xml'),
        json({ title: goalSecret }),
      ]),
    });
    expect(goalLine).toContain('goal-create-missing-id');
    expect(`${goalLine}\n${goalLogs.join('\n')}`).not.toContain(goalSecret);
  });

  it('keeps cleanup errors silent and redacts the primary failure body', async () => {
    const primarySecret = 'goal-get-error-secret';
    const cleanupSecret = 'cleanup-error-secret';
    const line = await failureLine({
      env: ENV,
      fetchFn: sequence([
        json({ ok: true }),
        json({ ok: true }),
        json([]),
        text('<svg/>', 'image/svg+xml'),
        json({ id: 'goal-live-id' }),
        json({ error: primarySecret }, 500),
        new Error(cleanupSecret),
      ]),
    });
    expect(line).toContain('request-rejected (HTTP 500)');
    expect(line).not.toContain(primarySecret);
    expect(line).not.toContain(cleanupSecret);
  });

  it('never prints unexpected Error or non-Error input', () => {
    expect(paperclipPhaseProbeFailureLine(new Error('unexpected-error-secret'))).toBe(
      `${PAPERCLIP_PHASE_PROBE_FAILURE_MARKER} Error: unexpected-probe-failure`,
    );
    expect(paperclipPhaseProbeFailureLine('unexpected-string-secret')).toBe(
      `${PAPERCLIP_PHASE_PROBE_FAILURE_MARKER} NonError: unexpected-probe-failure`,
    );
  });
});
