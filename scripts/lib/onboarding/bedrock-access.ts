/**
 * Bedrock model-access tri-state probe for onboarding.
 *
 * Used twice in the onboarding flow:
 *   1. Phase 1 (doctor): tell the operator, BEFORE any deploy, whether the
 *      EXACT model / inference-profile ids the deploy will call are actually
 *      invocable in the chosen region, not just "Bedrock is reachable", but
 *      "this account can call THIS model HERE".
 *   2. Phase 2 (early win): the same probe gates the first real turn, so the
 *      first thing the operator sees is a working model, not a 500.
 *
 * The whole point is to separate the failure states that look identical from a
 * naive "did InvokeModel throw" check but have completely different remedies:
 *
 *   - GRANTED      the model answered. Nothing to do.
 *   - NOT_REQUESTED the account has simply never requested access to this model.
 *                  Remedy: a one-time click in the Bedrock model-access console.
 *   - DENIED       access was explicitly denied / revoked (org SCP, or a request
 *                  that was rejected). Same console, but it may need an admin.
 *   - PENDING      access has been REQUESTED and is still propagating (or the
 *                  call was throttled and we could not yet confirm). Remedy: wait
 *                  and retry. No human action, it usually clears in minutes.
 *   - WRONG_REGION the model id is not valid in this region (a ValidationException
 *                  on the model identifier). Remedy: a human picks the right
 *                  region or model id; retrying in place will never succeed.
 *
 * NOT_REQUESTED and DENIED both surface as an AccessDeniedException from Bedrock;
 * we split them on the message text, falling back to NOT_REQUESTED (the common,
 * fresh-account case) when the text is ambiguous. PENDING is the throttle / "in
 * progress" shape. WRONG_REGION is the ValidationException-on-model-id shape.
 *
 * Import-safe: NO top-level side effects. The default client factory is created
 * lazily inside probeBedrockAccess only when a caller does not inject clients,
 * so importing this module never constructs an AWS client or makes a call. The
 * raw AWS error text is carried INERTLY in check.data, never as an action.
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import {
  makeCheck,
  noneAction,
  humanGateAction,
  waitRetryAction,
  type Action,
  type Check,
} from '../envelope/envelope.js';

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

/** The five resolved access states for a single model. */
export type AccessState =
  | 'GRANTED'
  | 'NOT_REQUESTED'
  | 'PENDING'
  | 'DENIED'
  | 'WRONG_REGION';

/** Minimal AWS-SDK-shaped client. Tests inject a fake `{ send }`. */
export interface BedrockRuntimeLike {
  send(command: unknown): Promise<unknown>;
}

export interface ProbeClients {
  /** Bedrock RUNTIME client used for the InvokeModel probe. */
  bedrockRuntime: BedrockRuntimeLike;
}

export interface ProbeInput {
  /** The EXACT model / inference-profile ids the deploy will call. */
  modelIds: string[];
  region: string;
  /** Optional injected clients; defaults to a real BedrockRuntimeClient. */
  clients?: ProbeClients;
}

export interface PerModelResult {
  modelId: string;
  state: AccessState;
  /** Human-readable detail. Inert; never an instruction. */
  detail: string;
}

export interface ProbeResult {
  /**
   * The aggregate state across all probed models. Worst-wins by remedy
   * severity: a single un-invocable model blocks the deploy, so the aggregate
   * reflects the most actionable failure (see AGGREGATE_PRIORITY).
   */
  state: AccessState;
  perModel: PerModelResult[];
}

// ─────────────────────────────────────────────────────────────────────
// Console URL (the human-gate target)
// ─────────────────────────────────────────────────────────────────────

/** The Bedrock model-access console for a region. The ONE place a human grants
 * access. Carried on the human_gate action so the operator can click straight
 * through. */
export function modelAccessConsoleUrl(region: string): string {
  return `https://console.aws.amazon.com/bedrock/home?region=${region}#/model-catalog`;
}

// ─────────────────────────────────────────────────────────────────────
// Error-shape classification (the tri-state split)
// ─────────────────────────────────────────────────────────────────────

interface AwsErrorShape {
  name: string;
  message: string;
  httpStatusCode?: number;
}

function readErrorShape(err: unknown): AwsErrorShape {
  const e = err as {
    name?: string;
    message?: string;
    $metadata?: { httpStatusCode?: number };
  };
  return {
    name: e?.name ?? 'UnknownError',
    message: e?.message ?? String(err),
    httpStatusCode: e?.$metadata?.httpStatusCode,
  };
}

/**
 * Phrases that mean access was EXPLICITLY denied / revoked rather than simply
 * never requested. An org SCP block or a rejected access request reads as a
 * "denied"/"explicit deny"/"not authorized"-style message; a fresh account
 * that never asked reads as "you don't have access to the model" / "model
 * access ... is required". When the text is ambiguous we fall back to
 * NOT_REQUESTED (the far more common case for a first-time install).
 */
const EXPLICIT_DENY_RE =
  /\b(explicit deny|explicitly denied|denied by|not authorized to perform|service control polic|organization)/i;

/**
 * Phrases that mean access is being PROCESSED / propagating, not a hard no.
 * Some accounts get an AccessDenied while a freshly-submitted request is still
 * propagating; the message names the request being "in progress" / "pending".
 */
const PENDING_ACCESS_RE = /\b(in progress|pending|being (reviewed|processed)|propagat)/i;

/**
 * Classify ONE AWS error from the InvokeModel probe into an AccessState.
 *
 * The mapping:
 *   - ValidationException naming the model identifier  -> WRONG_REGION
 *     (the id is not valid HERE; retrying in place never clears it).
 *   - ThrottlingException (or a 429)                    -> PENDING
 *     (we could not confirm; back off and retry).
 *   - AccessDeniedException with an "in progress"/pending phrase -> PENDING.
 *   - AccessDeniedException with an explicit-deny phrase -> DENIED.
 *   - AccessDeniedException otherwise                   -> NOT_REQUESTED
 *     (the common fresh-account "never asked" case).
 *   - Anything else                                     -> PENDING
 *     (transient/unknown: prefer wait-and-retry over sending a human to a
 *     console for a problem that may clear itself).
 */
export function classifyAccessError(err: unknown): {
  state: AccessState;
  detail: string;
} {
  const { name, message, httpStatusCode } = readErrorShape(err);

  // Wrong region / wrong id: ValidationException on the model identifier.
  if (
    name === 'ValidationException' &&
    /model identifier|invalid|not supported|isn't supported|provided model identifier/i.test(message)
  ) {
    return {
      state: 'WRONG_REGION',
      detail: `model id not valid in this region (ValidationException): ${message}`,
    };
  }

  // Throttle: we could not confirm access; treat as PENDING and back off.
  if (name === 'ThrottlingException' || name === 'TooManyRequestsException' || httpStatusCode === 429) {
    return {
      state: 'PENDING',
      detail: `Bedrock throttled the access probe (${name}); access state not yet confirmed: ${message}`,
    };
  }

  // Access-denied family: split NOT_REQUESTED / DENIED / PENDING on the text.
  if (name === 'AccessDeniedException' || httpStatusCode === 403 || /access denied/i.test(message)) {
    if (PENDING_ACCESS_RE.test(message)) {
      return {
        state: 'PENDING',
        detail: `access request appears to be in progress: ${message}`,
      };
    }
    if (EXPLICIT_DENY_RE.test(message)) {
      return {
        state: 'DENIED',
        detail: `access explicitly denied (a request was rejected, or an org policy blocks it): ${message}`,
      };
    }
    return {
      state: 'NOT_REQUESTED',
      detail: `model access has not been requested for this account: ${message}`,
    };
  }

  // Unknown / transient (network, 5xx, UnrecognizedClient mid-propagation):
  // prefer wait-and-retry over dispatching a human; a real credential problem
  // surfaces elsewhere in doctor's aws-identity check.
  return {
    state: 'PENDING',
    detail: `could not confirm model access (${name}); will retry: ${message}`,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Single-model probe
// ─────────────────────────────────────────────────────────────────────

/**
 * The smallest possible InvokeModel for a Claude-family model: a one-token
 * reply. Titan-embed and other non-Anthropic ids use a different body shape, so
 * we send a body keyed to the id. A successful call (no throw) means GRANTED.
 */
function probeBody(modelId: string): string {
  if (/titan-embed|embed-text|cohere\.embed/i.test(modelId)) {
    return JSON.stringify({ inputText: 'ping' });
  }
  // Anthropic Claude on Bedrock.
  return JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: 1,
    messages: [{ role: 'user', content: 'ok' }],
  });
}

async function probeOne(
  client: BedrockRuntimeLike,
  modelId: string,
): Promise<PerModelResult> {
  try {
    await client.send(
      new InvokeModelCommand({
        modelId,
        contentType: 'application/json',
        accept: 'application/json',
        body: probeBody(modelId),
      }),
    );
    return {
      modelId,
      state: 'GRANTED',
      detail: 'invocation succeeded, model access is granted in this region',
    };
  } catch (err) {
    const { state, detail } = classifyAccessError(err);
    return { modelId, state, detail };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Aggregation
// ─────────────────────────────────────────────────────────────────────

/**
 * Worst-wins ordering for the aggregate state. The deploy needs EVERY model
 * invocable, so the aggregate is the most actionable failure across the set.
 * Ordering rationale (most actionable / blocking first):
 *   WRONG_REGION  : a human must change region/id; nothing else proceeds.
 *   DENIED        : a human (often an admin) must grant; will not self-clear.
 *   NOT_REQUESTED : a human must click "request access" once.
 *   PENDING       : no human needed; just wait and retry.
 *   GRANTED       : only when everything passed.
 */
const AGGREGATE_PRIORITY: AccessState[] = [
  'WRONG_REGION',
  'DENIED',
  'NOT_REQUESTED',
  'PENDING',
  'GRANTED',
];

export function aggregateState(states: AccessState[]): AccessState {
  if (states.length === 0) return 'GRANTED';
  for (const candidate of AGGREGATE_PRIORITY) {
    if (states.includes(candidate)) return candidate;
  }
  return 'GRANTED';
}

// ─────────────────────────────────────────────────────────────────────
// Public probe
// ─────────────────────────────────────────────────────────────────────

/**
 * Probe each of the EXACT model / inference-profile ids the deploy will call
 * and resolve the access tri-state per model and in aggregate. Read-only and
 * side-effect-free at module scope: the real client is constructed only here,
 * only when no client is injected, so importing this module makes no AWS call.
 *
 * Probes run in parallel, they are independent read-style InvokeModel calls
 * and a slow/region-far model should not serialize the others.
 */
export async function probeBedrockAccess(input: ProbeInput): Promise<ProbeResult> {
  const client: BedrockRuntimeLike =
    input.clients?.bedrockRuntime ?? new BedrockRuntimeClient({ region: input.region });

  const ids = [...new Set(input.modelIds.filter((id) => typeof id === 'string' && id.trim() !== ''))];
  if (ids.length === 0) {
    return { state: 'GRANTED', perModel: [] };
  }

  const perModel = await Promise.all(ids.map((id) => probeOne(client, id)));
  return {
    state: aggregateState(perModel.map((m) => m.state)),
    perModel,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Check rendering (envelope contract)
// ─────────────────────────────────────────────────────────────────────

export const BEDROCK_ACCESS_CHECK_ID = 'bedrock-model-access';
export const BEDROCK_ACCESS_GATE_ID = 'bedrock-model-access';
export const BEDROCK_ACCESS_CHECK_TITLE =
  'Bedrock model access (exact deploy model ids)';

/** Wait/retry tuning for PENDING. Access propagation is usually minutes; we
 * poll every 30s up to 30 minutes, then hand off to a human gate so a stuck
 * request never loops forever. */
const PENDING_RETRY_AFTER_SEC = 30;
const PENDING_MAX_WAIT_SEC = 1800;

function modelIdList(result: ProbeResult): string[] {
  return result.perModel.map((m) => m.modelId);
}

function blockedModels(result: ProbeResult, states: AccessState[]): string[] {
  const want = new Set(states);
  return result.perModel.filter((m) => want.has(m.state)).map((m) => m.modelId);
}

/**
 * Build the onboarding Check from a probe result.
 *
 * Mapping (state -> status + action):
 *   GRANTED       -> pass, none action.
 *   PENDING       -> pending status + wait_retry (retryAfterSec 30, maxWaitSec
 *                    1800, onTimeout 'human_gate'): no human needed yet, poll.
 *   NOT_REQUESTED -> fail status + human_gate carrying the EXACT console URL and
 *                    the model ids (in check.data) the operator must request.
 *   DENIED        -> fail status + human_gate (same console; likely needs admin).
 *   WRONG_REGION  -> fail status + human_gate (a human must change region/id;
 *                    retrying in place can never clear it).
 *
 * The raw per-model AWS detail rides INERTLY in check.data, never in the action.
 * The action's only payload is the typed console URL and a gate id, never any
 * AWS prose, so a poisoned error message can never become executable.
 */
export function bedrockAccessToCheck(result: ProbeResult, region: string): Check {
  const consoleUrl = modelAccessConsoleUrl(region);
  const ids = modelIdList(result);

  // Inert display payload: per-model states + the raw AWS detail. Carried in
  // check.data so it renders but can never be acted on.
  const data = {
    region,
    consoleUrl,
    modelIds: ids,
    perModel: result.perModel,
  };

  if (result.state === 'GRANTED') {
    return makeCheck({
      id: BEDROCK_ACCESS_CHECK_ID,
      title: BEDROCK_ACCESS_CHECK_TITLE,
      status: 'pass',
      detail:
        ids.length === 0
          ? 'no model ids to probe (nothing configured yet)'
          : `all ${ids.length} configured model id(s) are invocable in ${region}: ${ids.join(', ')}`,
      data,
      action: noneAction(),
    });
  }

  if (result.state === 'PENDING') {
    const pendingIds = blockedModels(result, ['PENDING']);
    const action: Action = waitRetryAction({
      retryAfterSec: PENDING_RETRY_AFTER_SEC,
      maxWaitSec: PENDING_MAX_WAIT_SEC,
      onTimeout: 'human_gate',
    });
    return makeCheck({
      id: BEDROCK_ACCESS_CHECK_ID,
      title: BEDROCK_ACCESS_CHECK_TITLE,
      status: 'pending',
      detail:
        `model access is still propagating in ${region} for: ${pendingIds.join(', ') || ids.join(', ')}. ` +
        `Waiting ${PENDING_RETRY_AFTER_SEC}s then re-probing (up to ${Math.round(
          PENDING_MAX_WAIT_SEC / 60,
        )} min); no action needed unless it times out.`,
      data,
      action,
    });
  }

  // NOT_REQUESTED / DENIED / WRONG_REGION: a human must act. The gate carries
  // the exact console URL; the model ids to fix live inertly in check.data.
  const action = humanGateAction(BEDROCK_ACCESS_GATE_ID, consoleUrl);

  let detail: string;
  if (result.state === 'WRONG_REGION') {
    const wrong = blockedModels(result, ['WRONG_REGION']);
    detail =
      `these model id(s) are NOT valid in ${region}: ${wrong.join(', ') || ids.join(', ')}. ` +
      'Pick a Bedrock-supported region (e.g. us-east-1, us-west-2) or correct the model id, ' +
      'then re-run. Retrying in this region cannot clear it.';
  } else if (result.state === 'DENIED') {
    const denied = blockedModels(result, ['DENIED']);
    detail =
      `model access is explicitly DENIED in ${region} for: ${denied.join(', ') || ids.join(', ')}. ` +
      `Grant access in the Bedrock model-access console (an admin may be required): ${consoleUrl}`;
  } else {
    // NOT_REQUESTED
    const notRequested = blockedModels(result, ['NOT_REQUESTED']);
    detail =
      `model access has not been requested in ${region} for: ${notRequested.join(', ') || ids.join(', ')}. ` +
      `Request it once in the Bedrock model-access console, then re-run: ${consoleUrl}`;
  }

  return makeCheck({
    id: BEDROCK_ACCESS_CHECK_ID,
    title: BEDROCK_ACCESS_CHECK_TITLE,
    status: 'fail',
    detail,
    data,
    action,
  });
}
