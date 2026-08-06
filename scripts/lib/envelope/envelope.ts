/**
 * I1 typed command contract (onboarding plan, increment I1).
 *
 * ONE JSON envelope shared by every onboarding command: doctor, bootstrap,
 * setup, deploy, verify, destroy, early-win. The envelope is the ONLY thing
 * that flows between a command and whatever drives the next step (a human, a
 * chat surface, an orchestrator). Its job is fail-closed: raw AWS text and
 * data are carried inertly in `check.data`, NEVER as instructions, and the
 * only executable thing in the contract is a typed `Action` with a fixed
 * `kind`, a known `commandId`, and shell-safe `args`. That is the whole point
 * of validateEnvelope: injected AWS prose (a bucket description, an error
 * message that says "run rm -rf ...") can NEVER round-trip into an executable
 * action, because prose is not a typed Action and string args carrying shell
 * metacharacters are rejected before anything can act on them.
 *
 * Import-safe: no top-level side effects. The print helpers are pure string
 * builders plus an explicit `log` injection; nothing runs on import.
 */

import { z } from 'zod';
import { bold, dim, fail, gray, ok, warn } from '../ansi.js';

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

export type Status = 'pass' | 'warn' | 'fail' | 'skip' | 'pending';

export type CommandId =
  | 'doctor'
  | 'bootstrap'
  | 'setup'
  | 'deploy'
  | 'verify'
  | 'destroy'
  | 'early-win';

export type ActionKind = 'run_command' | 'human_gate' | 'wait_retry' | 'none';

export type OnTimeout = 'human_gate' | 'reconcile' | 'destroy' | 'fail';

export interface Action {
  kind: ActionKind;
  commandId?: CommandId;
  args?: Record<string, unknown>;
  consoleUrl?: string;
  gateId?: string;
  retryAfterSec?: number;
  maxWaitSec?: number;
  onTimeout?: OnTimeout;
}

export interface Check {
  id: string;
  title: string;
  status: Status;
  detail: string;
  /** INERT raw AWS text/data, never instructions. Carried for display only. */
  data?: unknown;
  action: Action;
}

export interface Summary {
  pass: number;
  warn: number;
  fail: number;
  skip: number;
  pending: number;
}

export interface Envelope {
  schemaVersion: 1;
  command: CommandId;
  runId?: string;
  account?: string;
  region?: string;
  mode?: 'chat' | 'infra-only';
  generatedAt: string;
  checks: Check[];
  summary: Summary;
  /** fail === 0 && pending === 0. */
  ok: boolean;
}

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

export const ENVELOPE_SCHEMA_VERSION = 1 as const;

// STATUSES is the one enum-value array with a real consumer (summarize iterates
// it). The schemas below intentionally use inline literals, so the parallel
// COMMAND_IDS / ACTION_KINDS / ON_TIMEOUTS arrays were dead and were removed.
export const STATUSES: readonly Status[] = ['pass', 'warn', 'fail', 'skip', 'pending'];

/**
 * Shell metacharacters that must NEVER appear in an action arg string. This
 * is the core fail-closed guard: an arg is fed to a command builder, so a
 * value carrying `;`, `|`, `&`, backtick, `$`, `(`, `)`, `<`, `>`, or any
 * newline/carriage-return could smuggle a second command. Reject at parse time.
 */
const SHELL_METACHAR_RE = /[;|&`$()<>\n\r]/;

export function hasShellMetacharacters(value: string): boolean {
  return SHELL_METACHAR_RE.test(value);
}

// ─────────────────────────────────────────────────────────────────────
// Zod schemas
// ─────────────────────────────────────────────────────────────────────

export const statusSchema = z.enum(['pass', 'warn', 'fail', 'skip', 'pending']);

export const commandIdSchema = z.enum([
  'doctor',
  'bootstrap',
  'setup',
  'deploy',
  'verify',
  'destroy',
  'early-win',
]);

export const actionKindSchema = z.enum(['run_command', 'human_gate', 'wait_retry', 'none']);

export const onTimeoutSchema = z.enum(['human_gate', 'reconcile', 'destroy', 'fail']);

/**
 * A JSON-safe args record. Values may be string / number / boolean / null, or
 * arrays of those. Every STRING value (top-level or nested in an array) is
 * checked for shell metacharacters and rejected if present, so a tainted AWS
 * value can never ride an arg into a command.
 */
const argScalarSchema = z.union([
  z
    .string()
    .refine((s) => !hasShellMetacharacters(s), {
      message: 'arg string contains a forbidden shell metacharacter (one of ; | & ` $ ( ) < > newline)',
    }),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const argsSchema = z.record(z.union([argScalarSchema, z.array(argScalarSchema)]));

export const actionSchema = z
  .object({
    kind: actionKindSchema,
    commandId: commandIdSchema.optional(),
    args: argsSchema.optional(),
    consoleUrl: z.string().optional(),
    gateId: z.string().optional(),
    retryAfterSec: z.number().nonnegative().optional(),
    maxWaitSec: z.number().nonnegative().optional(),
    onTimeout: onTimeoutSchema.optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (a.kind === 'run_command' && !a.commandId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['commandId'],
        message: 'action kind "run_command" requires a commandId',
      });
    }
    if (a.kind === 'human_gate' && !a.gateId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['gateId'],
        message: 'action kind "human_gate" requires a gateId',
      });
    }
    if (a.kind === 'wait_retry' && a.retryAfterSec === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['retryAfterSec'],
        message: 'action kind "wait_retry" requires retryAfterSec',
      });
    }
  });

export const checkSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    status: statusSchema,
    detail: z.string(),
    data: z.unknown().optional(),
    action: actionSchema,
  })
  .strict();

export const summarySchema = z
  .object({
    pass: z.number().int().nonnegative(),
    warn: z.number().int().nonnegative(),
    fail: z.number().int().nonnegative(),
    skip: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
  })
  .strict();

export const envelopeSchema = z
  .object({
    schemaVersion: z.literal(1),
    command: commandIdSchema,
    runId: z.string().optional(),
    account: z.string().optional(),
    region: z.string().optional(),
    mode: z.enum(['chat', 'infra-only']).optional(),
    generatedAt: z.string().min(1),
    checks: z.array(checkSchema),
    summary: summarySchema,
    ok: z.boolean(),
  })
  .strict()
  .superRefine((env, ctx) => {
    const computed = summarize(env.checks);
    for (const key of STATUSES) {
      if (env.summary[key] !== computed[key]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['summary', key],
          message: `summary.${key} is ${env.summary[key]} but the checks contain ${computed[key]}; summary must match the checks`,
        });
      }
    }
    const expectedOk = computed.fail === 0 && computed.pending === 0;
    if (env.ok !== expectedOk) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ok'],
        message: `ok is ${env.ok} but must be ${expectedOk} (ok === fail === 0 && pending === 0)`,
      });
    }
  });

// ─────────────────────────────────────────────────────────────────────
// Action builders
// ─────────────────────────────────────────────────────────────────────

export function noneAction(): Action {
  return { kind: 'none' };
}

export function runCommandAction(commandId: CommandId, args?: Record<string, unknown>): Action {
  return args === undefined
    ? { kind: 'run_command', commandId }
    : { kind: 'run_command', commandId, args };
}

export function humanGateAction(gateId: string, consoleUrl?: string): Action {
  return consoleUrl === undefined
    ? { kind: 'human_gate', gateId }
    : { kind: 'human_gate', gateId, consoleUrl };
}

export function waitRetryAction(opts: {
  retryAfterSec: number;
  maxWaitSec?: number;
  onTimeout?: OnTimeout;
}): Action {
  const action: Action = { kind: 'wait_retry', retryAfterSec: opts.retryAfterSec };
  if (opts.maxWaitSec !== undefined) action.maxWaitSec = opts.maxWaitSec;
  if (opts.onTimeout !== undefined) action.onTimeout = opts.onTimeout;
  return action;
}

// ─────────────────────────────────────────────────────────────────────
// Check + envelope builders
// ─────────────────────────────────────────────────────────────────────

export type CheckPartial = Partial<Check> & Pick<Check, 'id' | 'title' | 'status'>;

/**
 * Build a Check from a partial. `detail` defaults to '' and `action` defaults
 * to a none-action so a caller can declare a passing check with just id/title/
 * status. Tainted AWS data goes in `data`, never in `action`.
 */
export function makeCheck(partial: CheckPartial): Check {
  return {
    id: partial.id,
    title: partial.title,
    status: partial.status,
    detail: partial.detail ?? '',
    ...(partial.data !== undefined ? { data: partial.data } : {}),
    action: partial.action ?? noneAction(),
  };
}

export function summarize(checks: Check[]): Summary {
  const summary: Summary = { pass: 0, warn: 0, fail: 0, skip: 0, pending: 0 };
  for (const c of checks) summary[c.status] += 1;
  return summary;
}

export interface MakeEnvelopeInput {
  command: CommandId;
  checks: Check[];
  runId?: string;
  account?: string;
  region?: string;
  mode?: 'chat' | 'infra-only';
  generatedAt?: string;
}

/**
 * Assemble an Envelope, computing `summary` and `ok` from the checks so the
 * two can never drift from the source of truth. `ok` is true only when there
 * are no failing AND no pending checks. A pending check (e.g. a human gate
 * still open, a wait still retrying) keeps the run not-ok by design.
 */
export function makeEnvelope(input: MakeEnvelopeInput): Envelope {
  const summary = summarize(input.checks);
  const envelope: Envelope = {
    schemaVersion: ENVELOPE_SCHEMA_VERSION,
    command: input.command,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    checks: input.checks,
    summary,
    ok: summary.fail === 0 && summary.pending === 0,
  };
  if (input.runId !== undefined) envelope.runId = input.runId;
  if (input.account !== undefined) envelope.account = input.account;
  if (input.region !== undefined) envelope.region = input.region;
  if (input.mode !== undefined) envelope.mode = input.mode;
  return envelope;
}

// ─────────────────────────────────────────────────────────────────────
// Validation (fail-closed)
// ─────────────────────────────────────────────────────────────────────

/**
 * Parse + validate an envelope read from ANY source (a file, a chat message,
 * another command's stdout). THROWS a readable multi-line Error on prose,
 * malformed JSON-shaped input, missing typed fields, a summary that does not
 * match the checks, or any action arg carrying a shell metacharacter. This is
 * the I1 proof: untrusted AWS prose can never become an executable action,
 * because anything that is not a fully typed envelope is rejected here.
 *
 * Accepts either an already-parsed object or a raw JSON string.
 */
export function validateEnvelope(json: unknown): Envelope {
  let candidate: unknown = json;
  if (typeof json === 'string') {
    try {
      candidate = JSON.parse(json);
    } catch (err) {
      throw new Error(
        `not a valid command envelope: input is a string but not JSON ` +
          `(${err instanceof Error ? err.message : String(err)}). ` +
          'Raw prose is never an executable contract.',
      );
    }
  }
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error(
      'not a valid command envelope: expected a JSON object with typed fields, ' +
        'got ' +
        (Array.isArray(candidate) ? 'an array' : typeof candidate) +
        '. Prose or scalars can never be an executable contract.',
    );
  }
  const parsed = envelopeSchema.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`command envelope failed validation (fail-closed):\n${issues}`);
  }
  return parsed.data;
}

// ─────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────

function statusGlyphLine(check: Check): string {
  const label = `${check.id} ${dim('·')} ${check.title}`;
  switch (check.status) {
    case 'pass':
      return ok(label);
    case 'warn':
      return warn(label);
    case 'fail':
      return fail(label);
    case 'skip':
      return `${gray('—')}  ${gray(label)}`;
    case 'pending':
      return `${gray('…')}  ${gray(label)}`;
  }
}

function describeAction(action: Action): string | undefined {
  switch (action.kind) {
    case 'none':
      return undefined;
    case 'run_command':
      return `next: run ${action.commandId ?? '(unknown command)'}`;
    case 'human_gate':
      return `next: human gate ${action.gateId ?? ''}`.trim() +
        (action.consoleUrl ? `, ${action.consoleUrl}` : '');
    case 'wait_retry':
      return `next: wait ${action.retryAfterSec ?? 0}s and retry` +
        (action.onTimeout ? ` (on timeout: ${action.onTimeout})` : '');
  }
}

/**
 * Concise human-readable rendering reusing the status-glyph style. Pure: it
 * returns a string and never logs, so callers choose the sink.
 */
export function renderEnvelopeHuman(env: Envelope): string {
  const lines: string[] = [];
  const header = `${env.command}${env.runId ? ` · run ${env.runId}` : ''}`;
  lines.push(bold(header));
  const ctx = [
    env.account ? `account ${env.account}` : null,
    env.region ? `region ${env.region}` : null,
    env.mode ? `mode ${env.mode}` : null,
  ].filter((s): s is string => s !== null);
  if (ctx.length > 0) lines.push(dim(ctx.join(' · ')));
  for (const check of env.checks) {
    lines.push(statusGlyphLine(check));
    if (check.detail) {
      for (const detailLine of check.detail.split('\n')) lines.push(dim(`     ${detailLine}`));
    }
    const actionLine = describeAction(check.action);
    if (actionLine) lines.push(dim(`     ↳ ${actionLine}`));
  }
  const s = env.summary;
  lines.push('');
  lines.push(bold('Summary'));
  lines.push(gray('─'.repeat(40)));
  lines.push(
    `  ${s.pass} pass · ${s.warn} warn · ${s.fail} fail · ${s.skip} skip · ${s.pending} pending`,
  );
  lines.push(`  ${env.ok ? ok('ok') : fail('not ok')}`);
  return lines.join('\n');
}

export interface PrintOptions {
  json?: boolean;
  log?: (msg: string) => void;
}

/**
 * Print an envelope. `{ json: true }` emits the canonical machine envelope
 * (stable enough to feed validateEnvelope on the other side); otherwise the
 * human rendering. The sink is injectable for tests; defaults to console.log.
 */
export function printEnvelope(env: Envelope, opts: PrintOptions = {}): void {
  // eslint-disable-next-line no-console
  const log = opts.log ?? ((msg: string) => console.log(msg));
  if (opts.json) {
    log(JSON.stringify(env, null, 2));
    return;
  }
  log(renderEnvelopeHuman(env));
}
