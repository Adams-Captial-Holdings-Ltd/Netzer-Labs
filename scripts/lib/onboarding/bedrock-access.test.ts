import { describe, it, expect, vi } from 'vitest';
import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import {
  probeBedrockAccess,
  bedrockAccessToCheck,
  classifyAccessError,
  aggregateState,
  modelAccessConsoleUrl,
  BEDROCK_ACCESS_CHECK_ID,
  BEDROCK_ACCESS_GATE_ID,
  type ProbeResult,
} from './bedrock-access.js';
import { validateEnvelope, makeEnvelope } from '../envelope/envelope.js';

// ── Fake AWS error builders (manual SDK-shape mocking, per repo convention) ──

function awsError(name: string, message: string, httpStatusCode?: number): Error {
  const e = new Error(message) as Error & {
    name: string;
    $metadata?: { httpStatusCode?: number };
  };
  e.name = name;
  if (httpStatusCode !== undefined) e.$metadata = { httpStatusCode };
  return e;
}

const accessDenied = (msg = "You don't have access to the model with the specified model ID.") =>
  awsError('AccessDeniedException', msg, 403);
const validation = (msg = 'The provided model identifier is invalid.') =>
  awsError('ValidationException', msg);
const throttle = (msg = 'Too many requests, please wait before trying again.') =>
  awsError('ThrottlingException', msg, 429);

/** A fake BedrockRuntime client whose `send` is driven by a per-modelId map of
 * outcomes: either resolve (GRANTED) or reject with a supplied error. */
function fakeClient(outcomes: Record<string, Error | 'ok'>) {
  const send = vi.fn(async (command: unknown) => {
    const cmd = command as InvokeModelCommand;
    expect(cmd.constructor.name).toBe('InvokeModelCommand');
    const modelId = (cmd.input as { modelId: string }).modelId;
    const outcome = outcomes[modelId];
    if (outcome === 'ok' || outcome === undefined) {
      return { body: new Uint8Array() };
    }
    throw outcome;
  });
  return { client: { bedrockRuntime: { send } }, send };
}

// ─────────────────────────────────────────────────────────────────────
// classifyAccessError: each error shape maps to the right state
// ─────────────────────────────────────────────────────────────────────

describe('classifyAccessError error-shape mapping', () => {
  it('AccessDeniedException (plain) => NOT_REQUESTED', () => {
    expect(classifyAccessError(accessDenied()).state).toBe('NOT_REQUESTED');
  });

  it('AccessDeniedException with an explicit-deny / org phrase => DENIED', () => {
    expect(
      classifyAccessError(
        accessDenied('User is not authorized to perform: bedrock:InvokeModel with an explicit deny in a service control policy'),
      ).state,
    ).toBe('DENIED');
  });

  it('AccessDeniedException with an in-progress phrase => PENDING', () => {
    expect(
      classifyAccessError(accessDenied('Your model access request is in progress.')).state,
    ).toBe('PENDING');
  });

  it('ThrottlingException => PENDING', () => {
    expect(classifyAccessError(throttle()).state).toBe('PENDING');
  });

  it('a bare 429 (no throttle name) => PENDING', () => {
    expect(classifyAccessError(awsError('SomethingElse', 'slow down', 429)).state).toBe('PENDING');
  });

  it('ValidationException on the model identifier => WRONG_REGION', () => {
    expect(classifyAccessError(validation()).state).toBe('WRONG_REGION');
  });

  it('an unknown/transient error => PENDING (prefer retry over a human gate)', () => {
    expect(classifyAccessError(awsError('NetworkingError', 'socket hang up')).state).toBe('PENDING');
  });

  it('a bare 403 with no name still reads as access-denied => NOT_REQUESTED', () => {
    expect(classifyAccessError(awsError('Forbidden', 'forbidden', 403)).state).toBe('NOT_REQUESTED');
  });
});

// ─────────────────────────────────────────────────────────────────────
// aggregateState: worst-wins ordering
// ─────────────────────────────────────────────────────────────────────

describe('aggregateState', () => {
  it('all granted => GRANTED', () => {
    expect(aggregateState(['GRANTED', 'GRANTED'])).toBe('GRANTED');
  });
  it('empty => GRANTED', () => {
    expect(aggregateState([])).toBe('GRANTED');
  });
  it('PENDING beats GRANTED', () => {
    expect(aggregateState(['GRANTED', 'PENDING'])).toBe('PENDING');
  });
  it('NOT_REQUESTED beats PENDING', () => {
    expect(aggregateState(['PENDING', 'NOT_REQUESTED', 'GRANTED'])).toBe('NOT_REQUESTED');
  });
  it('DENIED beats NOT_REQUESTED', () => {
    expect(aggregateState(['NOT_REQUESTED', 'DENIED'])).toBe('DENIED');
  });
  it('WRONG_REGION beats everything', () => {
    expect(aggregateState(['DENIED', 'PENDING', 'WRONG_REGION', 'NOT_REQUESTED'])).toBe(
      'WRONG_REGION',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
// probeBedrockAccess: drives the InvokeModel probe per model
// ─────────────────────────────────────────────────────────────────────

describe('probeBedrockAccess', () => {
  it('all models invocable => GRANTED with a per-model row each', async () => {
    const { client, send } = fakeClient({ 'us.anthropic.claude': 'ok', 'amazon.titan-embed-text-v2:0': 'ok' });
    const res = await probeBedrockAccess({
      modelIds: ['us.anthropic.claude', 'amazon.titan-embed-text-v2:0'],
      region: 'us-east-1',
      clients: client,
    });
    expect(res.state).toBe('GRANTED');
    expect(res.perModel.map((m) => m.state)).toEqual(['GRANTED', 'GRANTED']);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('sends a Claude-shaped body for Claude ids and an inputText body for embed ids', async () => {
    const { client, send } = fakeClient({ 'us.anthropic.claude-opus': 'ok', 'amazon.titan-embed-text-v2:0': 'ok' });
    await probeBedrockAccess({
      modelIds: ['us.anthropic.claude-opus', 'amazon.titan-embed-text-v2:0'],
      region: 'us-east-1',
      clients: client,
    });
    const bodies = send.mock.calls.map((c) => {
      const cmd = c[0] as InvokeModelCommand;
      return JSON.parse((cmd.input as { body: string }).body);
    });
    const claudeBody = bodies.find((b) => 'anthropic_version' in b);
    const embedBody = bodies.find((b) => 'inputText' in b);
    expect(claudeBody).toBeTruthy();
    expect(claudeBody.max_tokens).toBe(1);
    expect(embedBody).toEqual({ inputText: 'ping' });
  });

  it('one un-requested model among granted ones => aggregate NOT_REQUESTED', async () => {
    const { client } = fakeClient({
      'us.anthropic.claude-default': 'ok',
      'us.anthropic.claude-opus': accessDenied(),
    });
    const res = await probeBedrockAccess({
      modelIds: ['us.anthropic.claude-default', 'us.anthropic.claude-opus'],
      region: 'us-east-1',
      clients: client,
    });
    expect(res.state).toBe('NOT_REQUESTED');
    const opus = res.perModel.find((m) => m.modelId === 'us.anthropic.claude-opus');
    expect(opus?.state).toBe('NOT_REQUESTED');
  });

  it('a throttled model => aggregate PENDING', async () => {
    const { client } = fakeClient({ 'us.anthropic.claude': throttle() });
    const res = await probeBedrockAccess({
      modelIds: ['us.anthropic.claude'],
      region: 'us-east-1',
      clients: client,
    });
    expect(res.state).toBe('PENDING');
  });

  it('a wrong-region model id => aggregate WRONG_REGION', async () => {
    const { client } = fakeClient({ 'us.anthropic.claude': validation() });
    const res = await probeBedrockAccess({
      modelIds: ['us.anthropic.claude'],
      region: 'eu-west-3',
      clients: client,
    });
    expect(res.state).toBe('WRONG_REGION');
  });

  it('empty / blank model id list short-circuits to GRANTED with no calls', async () => {
    const { client, send } = fakeClient({});
    const res = await probeBedrockAccess({ modelIds: ['', '  '], region: 'us-east-1', clients: client });
    expect(res.state).toBe('GRANTED');
    expect(res.perModel).toEqual([]);
    expect(send).not.toHaveBeenCalled();
  });

  it('de-duplicates repeated model ids before probing', async () => {
    const { client, send } = fakeClient({ 'us.anthropic.claude': 'ok' });
    await probeBedrockAccess({
      modelIds: ['us.anthropic.claude', 'us.anthropic.claude'],
      region: 'us-east-1',
      clients: client,
    });
    expect(send).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
// bedrockAccessToCheck: state -> Check mapping
// ─────────────────────────────────────────────────────────────────────

function result(state: ProbeResult['state'], perModel: ProbeResult['perModel']): ProbeResult {
  return { state, perModel };
}

describe('bedrockAccessToCheck', () => {
  it('GRANTED => a pass Check with a none action', () => {
    const check = bedrockAccessToCheck(
      result('GRANTED', [
        { modelId: 'us.anthropic.claude', state: 'GRANTED', detail: 'ok' },
      ]),
      'us-east-1',
    );
    expect(check.id).toBe(BEDROCK_ACCESS_CHECK_ID);
    expect(check.status).toBe('pass');
    expect(check.action.kind).toBe('none');
  });

  it('PENDING => a pending Check with a wait_retry action (30s / 1800s / human_gate timeout)', () => {
    const check = bedrockAccessToCheck(
      result('PENDING', [
        { modelId: 'us.anthropic.claude', state: 'PENDING', detail: 'propagating' },
      ]),
      'us-east-1',
    );
    expect(check.status).toBe('pending');
    expect(check.action.kind).toBe('wait_retry');
    expect(check.action.retryAfterSec).toBe(30);
    expect(check.action.maxWaitSec).toBe(1800);
    expect(check.action.onTimeout).toBe('human_gate');
  });

  it('NOT_REQUESTED => a fail Check with a human_gate carrying the console URL and the model ids', () => {
    const ids = ['us.anthropic.claude-default', 'us.anthropic.claude-opus'];
    const check = bedrockAccessToCheck(
      result('NOT_REQUESTED', [
        { modelId: ids[0], state: 'GRANTED', detail: 'ok' },
        { modelId: ids[1], state: 'NOT_REQUESTED', detail: 'never requested' },
      ]),
      'us-east-1',
    );
    expect(check.status).toBe('fail');
    expect(check.action.kind).toBe('human_gate');
    expect(check.action.gateId).toBe(BEDROCK_ACCESS_GATE_ID);
    expect(check.action.consoleUrl).toBe(modelAccessConsoleUrl('us-east-1'));
    expect(check.action.consoleUrl).toContain('region=us-east-1');
    expect(check.action.consoleUrl).toContain('#/model-catalog');
    // model ids ride INERTLY in check.data, never in the action.
    const data = check.data as { modelIds: string[] };
    expect(data.modelIds).toEqual(ids);
    // The specific un-requested id is named in the detail for the human.
    expect(check.detail).toContain('us.anthropic.claude-opus');
  });

  it('DENIED => a fail Check with a human_gate to the same console', () => {
    const check = bedrockAccessToCheck(
      result('DENIED', [
        { modelId: 'us.anthropic.claude', state: 'DENIED', detail: 'explicit deny' },
      ]),
      'us-west-2',
    );
    expect(check.status).toBe('fail');
    expect(check.action.kind).toBe('human_gate');
    expect(check.action.consoleUrl).toBe(modelAccessConsoleUrl('us-west-2'));
    expect(check.detail.toLowerCase()).toContain('denied');
  });

  it('WRONG_REGION => a fail Check with a human_gate and region-change guidance', () => {
    const check = bedrockAccessToCheck(
      result('WRONG_REGION', [
        { modelId: 'us.anthropic.claude', state: 'WRONG_REGION', detail: 'invalid id' },
      ]),
      'eu-west-3',
    );
    expect(check.status).toBe('fail');
    expect(check.action.kind).toBe('human_gate');
    expect(check.action.consoleUrl).toContain('region=eu-west-3');
    expect(check.detail).toMatch(/not valid/i);
  });

  it('the produced Check survives envelope validation (inert AWS prose never becomes an action)', () => {
    // A poisoned AWS error message must ride inertly in data and never break the
    // typed contract or smuggle a shell metacharacter into an action.
    const check = bedrockAccessToCheck(
      result('NOT_REQUESTED', [
        {
          modelId: 'us.anthropic.claude',
          state: 'NOT_REQUESTED',
          detail: 'AccessDenied: run `rm -rf /`; echo pwned $(whoami)',
        },
      ]),
      'us-east-1',
    );
    const env = makeEnvelope({ command: 'doctor', checks: [check] });
    const validated = validateEnvelope(env);
    expect(validated.checks[0].action.kind).toBe('human_gate');
    // The poisoned prose is preserved inertly in data, proving it never had to
    // be sanitized into an action.
    const data = validated.checks[0].data as { perModel: Array<{ detail: string }> };
    expect(data.perModel[0].detail).toContain('pwned');
  });
});

describe('modelAccessConsoleUrl', () => {
  it('builds the exact Bedrock model-access console URL for a region', () => {
    expect(modelAccessConsoleUrl('ap-southeast-2')).toBe(
      'https://console.aws.amazon.com/bedrock/home?region=ap-southeast-2#/model-catalog',
    );
  });
});
