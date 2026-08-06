/**
 * Durable run-state (onboarding plan, spine).
 *
 * One JSON document at `.cladeclaw/run-state.json` under the repo cwd that
 * records EVERYTHING an interrupted onboarding run needs to resume safely:
 * the phase reached, the bootstrap primitives created, a write-ahead inventory
 * of every resource we PLAN to create (appended BEFORE the create call, so an
 * interrupt mid-create still leaves a record the destroy sweep can find), the
 * open/satisfied human gates, the cost acknowledgement, and a resume class
 * that tells the resumer whether it can safely continue, must reconcile, must
 * pause at a human gate, or must destroy and start over.
 *
 * Fail-closed reads: a present-but-malformed state file THROWS rather than
 * being silently treated as absent, because misreading run-state could orphan
 * real AWS resources. Writes are ATOMIC: a temp file in the same directory is
 * written then renamed, so a crash mid-write never leaves a half-written
 * document that the next read would reject.
 *
 * Import-safe: no top-level side effects, no fs touched on import, and the run
 * id is generated only inside initRunState (never at module load).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

export type Phase = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type RunStatus = 'in-progress' | 'verified' | 'destroyed' | 'failed';

export type ResumeClass = 'safe-resume' | 'reconcile' | 'human-gate' | 'destroy-required';

export interface InventoryItem {
  id: string;
  type: string;
  phase: Phase;
  plannedAt: string;
  observedAt?: string;
  region?: string;
}

export interface HumanGate {
  gateId: string;
  kind: string;
  status: 'open' | 'satisfied';
  recordedAt: string;
  note?: string;
}

export interface CostAck {
  acknowledgedAt: string;
  standingMonthlyUsd: number;
  dailyCapUsd: number;
  mode: string;
}

export interface BootstrapState {
  stateBucket?: string;
  lockTable?: string;
  ecrRepo?: string;
  scopedRoleArn?: string;
  tripwireArmed?: boolean;
  tripwireArmedAt?: string;
}

export interface RunState {
  schemaVersion: 1;
  runId: string;
  createdAt: string;
  updatedAt: string;
  phase: Phase;
  mode?: string;
  account?: string;
  region?: string;
  status: RunStatus;
  qualifier?: string;
  bootstrap?: BootstrapState;
  writeAheadInventory: InventoryItem[];
  humanGates: HumanGate[];
  costAck?: CostAck;
  resumeClass?: ResumeClass;
}

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

export const RUN_STATE_SCHEMA_VERSION = 1 as const;

/** Directory name (kept verbatim per the spine contract). */
export const RUN_STATE_DIR_NAME = '.cladeclaw';
export const RUN_STATE_FILE_NAME = 'run-state.json';

const PHASES = [0, 1, 2, 3, 4, 5, 6, 7] as const;

// ─────────────────────────────────────────────────────────────────────
// Zod schema
// ─────────────────────────────────────────────────────────────────────

const phaseSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
  z.literal(6),
  z.literal(7),
]);

const inventoryItemSchema = z
  .object({
    id: z.string().min(1),
    type: z.string().min(1),
    phase: phaseSchema,
    plannedAt: z.string().min(1),
    observedAt: z.string().optional(),
    region: z.string().optional(),
  })
  .strict();

const humanGateSchema = z
  .object({
    gateId: z.string().min(1),
    kind: z.string().min(1),
    status: z.enum(['open', 'satisfied']),
    recordedAt: z.string().min(1),
    note: z.string().optional(),
  })
  .strict();

const costAckSchema = z
  .object({
    acknowledgedAt: z.string().min(1),
    standingMonthlyUsd: z.number().nonnegative(),
    dailyCapUsd: z.number().nonnegative(),
    mode: z.string().min(1),
  })
  .strict();

const bootstrapSchema = z
  .object({
    stateBucket: z.string().optional(),
    lockTable: z.string().optional(),
    ecrRepo: z.string().optional(),
    scopedRoleArn: z.string().optional(),
    tripwireArmed: z.boolean().optional(),
    tripwireArmedAt: z.string().optional(),
  })
  .strict();

export const runStateSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().min(1),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    phase: phaseSchema,
    mode: z.string().optional(),
    account: z.string().optional(),
    region: z.string().optional(),
    status: z.enum(['in-progress', 'verified', 'destroyed', 'failed']),
    qualifier: z.string().optional(),
    bootstrap: bootstrapSchema.optional(),
    writeAheadInventory: z.array(inventoryItemSchema),
    humanGates: z.array(humanGateSchema),
    costAck: costAckSchema.optional(),
    resumeClass: z.enum(['safe-resume', 'reconcile', 'human-gate', 'destroy-required']).optional(),
  })
  .strict();

// ─────────────────────────────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────────────────────────────

export function runStateDir(cwd: string = process.cwd()): string {
  return join(cwd, RUN_STATE_DIR_NAME);
}

export function runStatePath(cwd: string = process.cwd()): string {
  return join(runStateDir(cwd), RUN_STATE_FILE_NAME);
}

// ─────────────────────────────────────────────────────────────────────
// Read / write
// ─────────────────────────────────────────────────────────────────────

/**
 * Read the run-state document. Returns null when the file does not exist (a
 * fresh checkout). THROWS when the file is present but malformed, failing
 * closed so a corrupt state never silently looks like "no install".
 */
export function readRunState(cwd: string = process.cwd()): RunState | null {
  const path = runStatePath(cwd);
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new Error(
      `cannot read run-state at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(
      `run-state at ${path} is present but not valid JSON ` +
        `(${err instanceof Error ? err.message : String(err)}); refusing to treat a corrupt ` +
        'state as absent. Inspect or remove the file before re-running.',
    );
  }
  const parsed = runStateSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`run-state at ${path} failed validation (fail-closed):\n${issues}`);
  }
  return parsed.data;
}

/**
 * Write the run-state document ATOMICALLY: a unique temp file in the SAME
 * directory is written first, then renamed over the target. A crash mid-write
 * therefore leaves either the old file or the new one, never a truncated one.
 * `updatedAt` is refreshed on every write.
 */
export function writeRunState(state: RunState, cwd: string = process.cwd()): RunState {
  const dir = runStateDir(cwd);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const next: RunState = { ...state, updatedAt: new Date().toISOString() };
  // Validate before persisting so we never write a malformed document.
  const parsed = runStateSchema.safeParse(next);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`refusing to write malformed run-state:\n${issues}`);
  }
  const path = runStatePath(cwd);
  const tmp = join(dir, `.${RUN_STATE_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`);
  const body = JSON.stringify(next, null, 2) + '\n';
  try {
    writeFileSync(tmp, body, { encoding: 'utf-8', mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // best-effort cleanup; surface the original error below
    }
    throw err instanceof Error ? err : new Error(String(err));
  }
  return next;
}

// ─────────────────────────────────────────────────────────────────────
// Init
// ─────────────────────────────────────────────────────────────────────

export interface InitRunStateInput {
  runId?: string;
  phase?: Phase;
  mode?: string;
  account?: string;
  region?: string;
  qualifier?: string;
  cwd?: string;
}

/**
 * Create the run-state directory + file if absent and return the state. NEVER
 * clobbers an existing run-state: if one is already present it is read back
 * and returned unchanged, so two invocations cannot reset an in-flight run.
 * The run id is generated here (crypto.randomUUID), never at module load.
 */
export function initRunState(input: InitRunStateInput = {}): RunState {
  const cwd = input.cwd ?? process.cwd();
  const existing = readRunState(cwd);
  if (existing) return existing;
  const now = new Date().toISOString();
  const state: RunState = {
    schemaVersion: RUN_STATE_SCHEMA_VERSION,
    runId: input.runId ?? randomUUID(),
    createdAt: now,
    updatedAt: now,
    phase: input.phase ?? 0,
    status: 'in-progress',
    writeAheadInventory: [],
    humanGates: [],
  };
  if (input.mode !== undefined) state.mode = input.mode;
  if (input.account !== undefined) state.account = input.account;
  if (input.region !== undefined) state.region = input.region;
  if (input.qualifier !== undefined) state.qualifier = input.qualifier;
  return writeRunState(state, cwd);
}

// ─────────────────────────────────────────────────────────────────────
// Patch helpers (read-modify-write, atomic)
// ─────────────────────────────────────────────────────────────────────

function requireState(cwd: string): RunState {
  const state = readRunState(cwd);
  if (!state) {
    throw new Error(
      `no run-state at ${runStatePath(cwd)}; call initRunState before patching it`,
    );
  }
  return state;
}

export type RunStatePatch = Partial<Omit<RunState, 'schemaVersion' | 'runId' | 'createdAt'>>;

/**
 * Read-modify-write the run-state. Accepts either a partial (shallow merge) or
 * a function that receives the current state and returns the next one. Always
 * persists atomically via writeRunState.
 */
export function patchRunState(
  patch: RunStatePatch | ((current: RunState) => RunState),
  cwd: string = process.cwd(),
): RunState {
  const current = requireState(cwd);
  const next =
    typeof patch === 'function'
      ? patch(current)
      : ({ ...current, ...patch } as RunState);
  // Protect the immutable identity fields.
  next.schemaVersion = current.schemaVersion;
  next.runId = current.runId;
  next.createdAt = current.createdAt;
  return writeRunState(next, cwd);
}

export function setPhase(phase: Phase, cwd: string = process.cwd()): RunState {
  if (!PHASES.includes(phase)) {
    throw new Error(`setPhase: invalid phase ${phase} (expected 0..7)`);
  }
  return patchRunState({ phase }, cwd);
}

export function setMode(mode: string, cwd: string = process.cwd()): RunState {
  return patchRunState({ mode }, cwd);
}

/**
 * Write-ahead: append a PLANNED resource to the inventory BEFORE the create
 * call. Re-recording the same id updates the planned row in place (idempotent
 * retries do not duplicate). This is what lets the destroy sweep find a
 * resource even if the process died between the write-ahead and the create.
 */
export function recordPlannedResource(
  item: InventoryItem,
  cwd: string = process.cwd(),
): RunState {
  return patchRunState((current) => {
    const inventory = current.writeAheadInventory.slice();
    const idx = inventory.findIndex((i) => i.id === item.id);
    if (idx >= 0) inventory[idx] = { ...inventory[idx], ...item };
    else inventory.push(item);
    return { ...current, writeAheadInventory: inventory };
  }, cwd);
}

/**
 * Mark a previously planned resource as OBSERVED (confirmed to exist in AWS).
 * Throws when the id was never write-ahead recorded, so an observe can never
 * silently invent inventory that no create preceded.
 */
export function markObserved(
  id: string,
  observedAt: string = new Date().toISOString(),
  cwd: string = process.cwd(),
): RunState {
  return patchRunState((current) => {
    const inventory = current.writeAheadInventory.slice();
    const idx = inventory.findIndex((i) => i.id === id);
    if (idx < 0) {
      throw new Error(
        `markObserved: "${id}" is not in the write-ahead inventory; record it with ` +
          'recordPlannedResource before observing it',
      );
    }
    inventory[idx] = { ...inventory[idx], observedAt };
    return { ...current, writeAheadInventory: inventory };
  }, cwd);
}

/** Add a human gate, or update the existing one with the same gateId in place. */
export function addOrUpdateHumanGate(
  gate: HumanGate,
  cwd: string = process.cwd(),
): RunState {
  return patchRunState((current) => {
    const gates = current.humanGates.slice();
    const idx = gates.findIndex((g) => g.gateId === gate.gateId);
    if (idx >= 0) gates[idx] = { ...gates[idx], ...gate };
    else gates.push(gate);
    return { ...current, humanGates: gates };
  }, cwd);
}

export function recordCostAck(ack: CostAck, cwd: string = process.cwd()): RunState {
  return patchRunState({ costAck: ack }, cwd);
}

export function setStatus(status: RunStatus, cwd: string = process.cwd()): RunState {
  return patchRunState({ status }, cwd);
}

export function setResumeClass(resumeClass: ResumeClass, cwd: string = process.cwd()): RunState {
  return patchRunState({ resumeClass }, cwd);
}

export function setVerified(cwd: string = process.cwd()): RunState {
  return patchRunState({ status: 'verified' }, cwd);
}

/**
 * Stamp the tripwire as armed on the bootstrap sub-record. Merges into any
 * existing bootstrap state rather than replacing it.
 */
export function armTripwire(
  at: string = new Date().toISOString(),
  cwd: string = process.cwd(),
): RunState {
  return patchRunState((current) => {
    const bootstrap: BootstrapState = {
      ...(current.bootstrap ?? {}),
      tripwireArmed: true,
      tripwireArmedAt: at,
    };
    return { ...current, bootstrap };
  }, cwd);
}

/** Merge fields into the bootstrap sub-record (bucket/table/repo/role names). */
export function patchBootstrap(
  patch: BootstrapState,
  cwd: string = process.cwd(),
): RunState {
  return patchRunState((current) => {
    const bootstrap: BootstrapState = { ...(current.bootstrap ?? {}), ...patch };
    return { ...current, bootstrap };
  }, cwd);
}
