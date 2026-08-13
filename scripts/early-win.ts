/**
 * Netzar OS Enterprise · Early Win (onboarding Phase 2).
 *
 * `npm run early-win`
 *
 * The first thing an operator should see after doctor passes is a WORKING
 * model, not a wall of infra. This phase makes exactly ONE real, guardrailed
 * Bedrock turn through the EXACT model the deploy will use, and prints the one
 * line the model answered:
 *
 *     Claude answered: <one line>
 *
 * ZERO standing cost: this creates NO AWS resource. It invokes a model and
 * exits. The only spend is the tokens of a single tiny turn.
 *
 * The financial guard is the whole point of running this BEFORE the full atomic
 * spend ledger exists (the ledger is a Phase-3+ resource). We cannot rely on the
 * ledger here, so we cap spend three ways that are impossible to defeat from
 * inside a loop:
 *
 *   1. HARDCODED max output tokens (EARLY_WIN_MAX_OUTPUT_TOKENS). The InvokeModel
 *      body pins max_tokens to a tiny constant, so a single call can never run
 *      away.
 *   2. A tiny PRE-INIT call counter (a plain module-local integer, allocated
 *      before any AWS client). Every attempt decrements a hardcoded budget of
 *      attempts (EARLY_WIN_MAX_ATTEMPTS); once it hits zero we STOP, even if the
 *      classifier says "retryable". A bug that turned the retry into a loop still
 *      cannot exceed the attempt budget.
 *   3. BOUNDED, NON-EXPONENTIAL retries: only a transient/pending classification
 *      retries, with a fixed small delay, and only while the attempt counter
 *      allows it. NOT_REQUESTED / DENIED / WRONG_REGION never retry (a human must
 *      act), so they cost exactly one call.
 *
 * The probe reuses the SAME InvokeModel path the verify step and the doctor
 * Bedrock-access check use (src/lib/onboarding/bedrock-access.ts classifies the
 * error shapes), so "the early win worked" means "the deploy's model is
 * invocable here", not a different code path that could pass while the real one
 * fails.
 *
 * Output is the typed onboarding Envelope (command 'early-win'). Raw AWS text is
 * carried INERTLY in check.data, never as an executable action, exactly like
 * every other onboarding command.
 *
 * Import-safe: NO top-level side effects. No AWS client is constructed and no
 * call is made at module load; everything runs inside runEarlyWin / main, which
 * main() only invokes behind the import.meta.url guard. No em dashes by house
 * rule.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { fail } from './lib/ansi.js';
import { maybePrintHelp } from './lib/help.js';
import { parseEnvFile, resolveEnvFlag, envFileNameFor } from './lib/env-file.js';
import {
  makeCheck,
  makeEnvelope,
  noneAction,
  humanGateAction,
  waitRetryAction,
  printEnvelope,
  type Action,
  type Check,
  type Envelope,
} from './lib/envelope/envelope.js';
import {
  classifyAccessError,
  modelAccessConsoleUrl,
  type AccessState,
} from './lib/onboarding/bedrock-access.js';

// ─────────────────────────────────────────────────────────────────────
// HARDCODED spend guards. These are the pre-ledger ceiling and are
// deliberately small + constant so even a loop cannot overspend.
// ─────────────────────────────────────────────────────────────────────

/** Pin the model output to a tiny constant. A single turn can never run away. */
export const EARLY_WIN_MAX_OUTPUT_TOKENS = 32;

/**
 * Total InvokeModel attempts allowed across the WHOLE phase, transient retries
 * included. A plain integer budget the loop decrements; once it is exhausted we
 * stop regardless of classification. This is the hard backstop that makes a
 * runaway loop financially impossible before the ledger exists.
 */
export const EARLY_WIN_MAX_ATTEMPTS = 3;

/** Fixed (non-exponential) delay between transient retries, milliseconds. */
export const EARLY_WIN_RETRY_DELAY_MS = 1500;

export const EARLY_WIN_CHECK_ID = 'early-win-bedrock-turn';
export const EARLY_WIN_GATE_ID = 'early-win-bedrock-turn';
export const EARLY_WIN_CHECK_TITLE = 'First real Bedrock turn (early win)';

/** The exact line printed on success. The contract: this prefix, then one line. */
export const EARLY_WIN_ANSWER_PREFIX = 'Claude answered: ';

/** The single-line question we send. Kept short to keep input tokens minimal. */
const EARLY_WIN_PROMPT =
  'In one short sentence, say hello and confirm you are running on Amazon Bedrock.';

// ─────────────────────────────────────────────────────────────────────
// Minimal injected client shape (mirrors bedrock-access.ts BedrockRuntimeLike)
// ─────────────────────────────────────────────────────────────────────

export interface EarlyWinRuntimeLike {
  send(command: unknown): Promise<unknown>;
}

export interface RunEarlyWinInput {
  /** The EXACT model / inference-profile id the deploy will call. */
  modelId: string;
  region: string;
  /** Injected client; defaults to a real BedrockRuntimeClient inside runEarlyWin. */
  client?: EarlyWinRuntimeLike;
  /** Injectable sleeper (tests pass a no-op). Defaults to a real timeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable attempt budget (tests). Defaults to the hardcoded constant. */
  maxAttempts?: number;
}

export interface RunEarlyWinResult {
  /** GRANTED means the turn succeeded and `answer` is populated. */
  state: AccessState;
  /** The one-line model answer on success; undefined otherwise. */
  answer?: string;
  /** Number of InvokeModel attempts actually made (never exceeds the budget). */
  attempts: number;
  /** Inert AWS detail for display. Never an instruction. */
  detail: string;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// ─────────────────────────────────────────────────────────────────────
// Request / response shaping (Anthropic-on-Bedrock messages API)
// ─────────────────────────────────────────────────────────────────────

/**
 * The smallest Claude-on-Bedrock body that still produces a usable sentence,
 * with max_tokens pinned to the hardcoded ceiling so the call cannot run away.
 */
function earlyWinBody(): string {
  return JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: EARLY_WIN_MAX_OUTPUT_TOKENS,
    messages: [{ role: 'user', content: EARLY_WIN_PROMPT }],
  });
}

/** Decode the InvokeModel response body into the model's text, collapsed to one line. */
function decodeOneLine(body: unknown): string {
  // The SDK returns body as a Uint8Array. Be defensive about the shape so a
  // malformed payload degrades to a readable fallback rather than throwing.
  let text = '';
  try {
    const bytes = body as Uint8Array | undefined;
    const raw = bytes ? Buffer.from(bytes).toString('utf-8') : '';
    const decoded: { content?: Array<{ type?: string; text?: string }> } = raw
      ? (JSON.parse(raw) as { content?: Array<{ type?: string; text?: string }> })
      : {};
    text =
      decoded.content?.find((c) => c.type === 'text')?.text?.trim() ??
      decoded.content?.[0]?.text?.trim() ??
      '';
  } catch {
    text = '';
  }
  // Collapse to a single line: the contract is exactly one line of output.
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine === '' ? '(model returned an empty response)' : oneLine;
}

// ─────────────────────────────────────────────────────────────────────
// The bounded, metered probe
// ─────────────────────────────────────────────────────────────────────

/**
 * Make ONE guardrailed turn against the deploy model, retrying ONLY a transient
 * /pending classification and ONLY while the pre-init attempt budget allows it.
 * Creates no AWS resource. The attempt counter is the hard backstop: a runaway
 * retry cannot exceed `maxAttempts` InvokeModel calls no matter what the
 * classifier returns.
 */
export async function runEarlyWin(input: RunEarlyWinInput): Promise<RunEarlyWinResult> {
  const sleep = input.sleep ?? defaultSleep;
  // A tiny PRE-INIT integer budget, decremented per attempt. Defaults to the
  // hardcoded constant; never trust a caller to raise it past the ceiling.
  const budget = Math.min(
    input.maxAttempts ?? EARLY_WIN_MAX_ATTEMPTS,
    EARLY_WIN_MAX_ATTEMPTS,
  );

  const client: EarlyWinRuntimeLike =
    input.client ?? new BedrockRuntimeClient({ region: input.region });

  let attempts = 0;
  let lastState: AccessState = 'PENDING';
  let lastDetail = 'no attempt was made';

  // Loop is bounded by `attempts < budget`; nothing inside can extend it.
  while (attempts < budget) {
    attempts += 1;
    try {
      const out = (await client.send(
        new InvokeModelCommand({
          modelId: input.modelId,
          contentType: 'application/json',
          accept: 'application/json',
          body: earlyWinBody(),
        }),
      )) as { body?: unknown };
      const answer = decodeOneLine(out.body);
      return {
        state: 'GRANTED',
        answer,
        attempts,
        detail: `model ${input.modelId} answered in ${input.region} on attempt ${attempts}`,
      };
    } catch (err) {
      const { state, detail } = classifyAccessError(err);
      lastState = state;
      lastDetail = detail;
      // Only a PENDING (transient / propagating / throttled) result retries,
      // and only if the budget still allows another attempt. A human-action
      // state (NOT_REQUESTED / DENIED / WRONG_REGION) never retries: it would
      // burn calls on a problem that cannot self-clear.
      if (state === 'PENDING' && attempts < budget) {
        await sleep(EARLY_WIN_RETRY_DELAY_MS);
        continue;
      }
      break;
    }
  }

  return { state: lastState, attempts, detail: lastDetail };
}

// ─────────────────────────────────────────────────────────────────────
// Envelope assembly
// ─────────────────────────────────────────────────────────────────────

/**
 * Build the early-win Check from a probe result. The model answer and the raw
 * AWS detail ride INERTLY in check.data; the only action payload is a typed
 * console URL on a human gate or a typed wait/retry, never AWS prose.
 *
 * Mapping:
 *   GRANTED       -> pass, none action; data.answer holds the one line.
 *   PENDING       -> pending status + wait_retry (a human gate on timeout).
 *   NOT_REQUESTED -> fail status + human_gate (request access once).
 *   DENIED        -> fail status + human_gate (may need an admin).
 *   WRONG_REGION  -> fail status + human_gate (pick the right region / id).
 */
export function earlyWinToCheck(
  result: RunEarlyWinResult,
  modelId: string,
  region: string,
): Check {
  const consoleUrl = modelAccessConsoleUrl(region);
  const data = {
    region,
    modelId,
    consoleUrl,
    attempts: result.attempts,
    maxAttempts: EARLY_WIN_MAX_ATTEMPTS,
    maxOutputTokens: EARLY_WIN_MAX_OUTPUT_TOKENS,
    state: result.state,
    answer: result.answer,
    rawDetail: result.detail,
  };

  if (result.state === 'GRANTED') {
    return makeCheck({
      id: EARLY_WIN_CHECK_ID,
      title: EARLY_WIN_CHECK_TITLE,
      status: 'pass',
      detail:
        `the deploy model ${modelId} is invocable in ${region}; first real turn succeeded ` +
        `in ${result.attempts} attempt(s). Answer carried in check.data.answer.`,
      data,
      action: noneAction(),
    });
  }

  if (result.state === 'PENDING') {
    const action: Action = waitRetryAction({
      retryAfterSec: 30,
      maxWaitSec: 1800,
      onTimeout: 'human_gate',
    });
    return makeCheck({
      id: EARLY_WIN_CHECK_ID,
      title: EARLY_WIN_CHECK_TITLE,
      status: 'pending',
      detail:
        `model access for ${modelId} in ${region} is still propagating (or the probe was ` +
        `throttled) after ${result.attempts} bounded attempt(s). Wait and re-run early-win; ` +
        'no human action needed yet.',
      data,
      action,
    });
  }

  // NOT_REQUESTED / DENIED / WRONG_REGION: a human must act. The gate carries
  // the console URL; the model id to fix is inert in check.data.
  const action = humanGateAction(EARLY_WIN_GATE_ID, consoleUrl);
  let detail: string;
  if (result.state === 'WRONG_REGION') {
    detail =
      `model id ${modelId} is NOT valid in ${region}. Pick a Bedrock-supported region or ` +
      'correct the model id, then re-run early-win. Retrying in place cannot clear it.';
  } else if (result.state === 'DENIED') {
    detail =
      `model access is explicitly DENIED in ${region} for ${modelId}. Grant it in the Bedrock ` +
      `model-access console (an admin may be required): ${consoleUrl}`;
  } else {
    detail =
      `model access has not been requested in ${region} for ${modelId}. Request it once in the ` +
      `Bedrock model-access console, then re-run early-win: ${consoleUrl}`;
  }
  return makeCheck({
    id: EARLY_WIN_CHECK_ID,
    title: EARLY_WIN_CHECK_TITLE,
    status: 'fail',
    detail,
    data,
    action,
  });
}

export interface EarlyWinEnvelopeInput {
  result: RunEarlyWinResult;
  modelId: string;
  region: string;
  account?: string;
}

/** Assemble the typed onboarding Envelope for the early-win command. */
export function buildEarlyWinEnvelope(input: EarlyWinEnvelopeInput): Envelope {
  const check = earlyWinToCheck(input.result, input.modelId, input.region);
  return makeEnvelope({
    command: 'early-win',
    checks: [check],
    region: input.region,
    account: input.account,
    mode: 'chat',
  });
}

// ─────────────────────────────────────────────────────────────────────
// Model-id resolution (the EXACT id the deploy will call)
// ─────────────────────────────────────────────────────────────────────

/**
 * Resolve the single model id to probe from the env, preferring the deploy's
 * DEFAULT model, then Sonnet, then Haiku, then Opus. Returns undefined when no
 * Claude model id is configured (the caller surfaces that as a fail with a
 * remediation rather than probing nothing).
 */
export function resolveEarlyWinModelId(
  env: Record<string, string>,
): string | undefined {
  const candidates = [
    env.BEDROCK_DEFAULT_MODEL,
    env.BEDROCK_SONNET_MODEL,
    env.BEDROCK_HAIKU_MODEL,
    env.BEDROCK_OPUS_MODEL,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() !== '') return c.trim();
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────
// CLI entry (guarded; never runs on import)
// ─────────────────────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(__filename));

const log = (msg: string): void => {
  // eslint-disable-next-line no-console
  console.log(msg);
};

/**
 * The CLI body. Resolves the env + model id, runs the bounded probe, prints the
 * 'Claude answered: <one line>' contract line on success, then prints the typed
 * envelope (human, or JSON with --json). Returns the process exit code (0 only
 * when the turn succeeded). Side effects (stdout, process.exit) live here, never
 * at module scope.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  if (
    maybePrintHelp(argv, {
      command: 'npm run early-win',
      oneLiner: 'one bounded Bedrock probe: prove the deploy model answers before any deploy',
      flags: [
        ['--env=<name>', 'target .env.<name> instead of .env'],
        ['--json', 'typed I1 command envelope on stdout'],
      ],
      contract: 'One guardrailed model call, max 32 output tokens (~a cent at most); creates no AWS resource.',
      docs: 'AGENTS.md',
    })
  ) {
    return 0;
  }
  const jsonMode = argv.includes('--json');
  const envFlag = resolveEnvFlag(argv);
  const envPath = join(repoRoot, envFileNameFor(envFlag));

  if (!existsSync(envPath)) {
    const message =
      `No env file at ${envPath}. ` +
      (envFlag === 'prod'
        ? 'Run `npm run setup` first.'
        : 'Create it by copying .env.staging.example or following docs/staging.md.');
    log(fail(message));
    return 1;
  }

  const env = parseEnvFile(readFileSync(envPath, 'utf-8'));
  const region = env.AWS_REGION?.trim() || 'us-east-1';
  const account = env.AWS_ACCOUNT_ID?.trim() || undefined;
  const modelId = resolveEarlyWinModelId(env);

  if (!modelId) {
    // No model configured: emit a fail envelope rather than probing nothing.
    const check = makeCheck({
      id: EARLY_WIN_CHECK_ID,
      title: EARLY_WIN_CHECK_TITLE,
      status: 'fail',
      detail:
        'no Bedrock model id is configured (BEDROCK_DEFAULT_MODEL / BEDROCK_SONNET_MODEL / ' +
        'BEDROCK_HAIKU_MODEL / BEDROCK_OPUS_MODEL are all empty). Run `npm run setup` to pick a ' +
        'model, then re-run early-win.',
      data: { region, account },
      action: humanGateAction(EARLY_WIN_GATE_ID, modelAccessConsoleUrl(region)),
    });
    const envelope = makeEnvelope({
      command: 'early-win',
      checks: [check],
      region,
      account,
      mode: 'chat',
    });
    printEnvelope(envelope, { json: jsonMode, log });
    return 1;
  }

  const result = await runEarlyWin({ modelId, region });

  // The contract line, printed ONLY on a real successful turn, BEFORE the
  // envelope so it is the first thing the operator reads in human mode.
  if (result.state === 'GRANTED' && result.answer && !jsonMode) {
    log(EARLY_WIN_ANSWER_PREFIX + result.answer);
  }

  const envelope = buildEarlyWinEnvelope({ result, modelId, region, account });
  printEnvelope(envelope, { json: jsonMode, log });

  return envelope.ok ? 0 : 1;
}

// Execute only when invoked directly (tsx scripts/early-win.ts), never on import.
// Compare resolved paths, not `file://` URLs: import.meta.url percent-encodes
// (e.g. a space in the install path), so the old string compare silently
// no-oped the CLI on any path with a space or on Windows.
if (process.argv[1] !== undefined && resolve(process.argv[1]) === __filename) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error(
        fail(`fatal error during early-win: ${err instanceof Error ? err.message : String(err)}`),
      );
      process.exit(1);
    });
}
