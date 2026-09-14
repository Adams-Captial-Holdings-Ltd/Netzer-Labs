/**
 * Deliverables parity, step 2 (E1): replay the captured production request
 * against real Bedrock, varying ONLY the output budget.
 *
 * SPEND BOUNDARY. `main()` calls Bedrock with real credentials and costs money.
 * Never run it without the user's explicit go. The campaign is capped at
 * CAMPAIGN_CAP_USD. The blind judge (step 3) is separately approved.
 *
 * Design (frozen in SPECIFICATION; `replay.diag.ts` is the contract):
 * - Input is a capture written by `capture.diag.ts` on the production tree.
 *   System blocks, tool specs, cache points and temperature are copied from it
 *   byte for byte. The user message is the prompt text. Only
 *   `inferenceConfig.maxTokens` changes, per profile:
 *     S = 1024 first / 8192 tool rounds  (production before 2026-08-24)
 *     P = 8192 / 8192                    (production today; the control)
 *     U = 32000 / 32000                  (unconstrained)
 * - The guardrail is an explicit choice: production's real id and version, or
 *   null when production has none. The capture only holds a placeholder.
 * - One model, no fallback chain. Throttling retries stay on that model.
 * - The run mirrors production's loop: a streamed first call; on `tool_use`,
 *   the same messages re-sent non-streaming; up to TOOL_ROUND_LIMIT rounds.
 * - generate_document is evaluated with production's own validate*Spec and
 *   build* functions, and the file must reopen. Every other tool gets a canned
 *   result; no product tool handler runs.
 * - Budget: before every call, spent + worst case must stay within the cap, or
 *   the campaign stops and the remaining runs are recorded `budget_exhausted`.
 * - Environment: never loads `.env`, and deletes AWS_ENDPOINT_URL before any
 *   client exists, like `scripts/e2e-three-corpus.ts`.
 * - Output: one JSONL record per run, refused inside the repository.
 *
 * Run it on the local branch that carries production's tree (`diag/prod-capture`)
 * so the builders are production's.
 */
import type {
  ConverseCommandInput,
  ConverseStreamCommandInput,
  Message,
} from '@aws-sdk/client-bedrock-runtime';

export const REPLAY_MODEL_ID = 'us.anthropic.claude-sonnet-4-6';
export const CAMPAIGN_CAP_USD = 30;
export const RUNS_PER_CELL = 5;
/** Production's TOOL_TURN_LIMIT. */
export const TOOL_ROUND_LIMIT = 8;

export type ProfileId = 'S' | 'P' | 'U';

export interface CapturedCall {
  command: string;
  input: Record<string, unknown>;
}

/** The subset of `capture-<sha>.json` the replay reads. */
export interface CaptureFile {
  schema: 'deliverables-capture/1';
  headSha: string;
  agentPromptSource: string;
  guardrailPlaceholder?: string;
  firstCall: CapturedCall;
  toolLoopCalls: CapturedCall[];
}

export interface Guardrail {
  id: string;
  version: string;
}

export interface PromptRef {
  id: string;
  text: string;
}

export interface PlannedRun {
  runId: string;
  rep: number;
  promptId: string;
  profile: ProfileId;
}

export interface CallRecord {
  kind: 'first' | 'loop';
  maxTokens: number;
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  textChars: number;
  toolUses: string[];
  latencyMs: number;
}

export interface DocumentGate {
  format: string;
  specChars: number;
  specValid: boolean;
  validationError?: string;
  bytes: number;
  reopened: boolean;
  reopenError?: string;
  winAnsiRejected: boolean;
  /** Output tokens of the model call that emitted this spec. */
  specOutputTokens?: number;
}

export interface RunRecord {
  runId: string;
  rep: number;
  promptId: string;
  profile: ProfileId;
  modelId: string;
  status: 'ok' | 'error' | 'budget_exhausted';
  error?: string;
  calls: CallRecord[];
  stopReasons: string[];
  documents: DocumentGate[];
  silentTruncation: boolean;
  visibleTruncation: boolean;
  guardrailIntervened: boolean;
  costUsd: number;
  latencyMs: number;
  headSha: string;
  agentPromptSource: string;
}

/** Sends one SDK command. Production passes `(c) => client.send(c)`. */
export type Send = (command: { input: unknown }) => Promise<unknown>;

export interface Budget {
  /** True when spent + worstCaseUsd stays within the cap. */
  admit(worstCaseUsd: number): boolean;
  record(actualUsd: number): void;
  spentUsd(): number;
}

export interface RunDeps {
  send: Send;
  capture: CaptureFile;
  prompt: PromptRef;
  guardrail: Guardrail | null;
  budget: Budget;
  sleep?: (ms: number) => Promise<void>;
}

export interface CampaignOptions {
  capture: CaptureFile;
  prompts: PromptRef[];
  guardrail: Guardrail | null;
  send: Send;
  outFile: string;
  repoRoot: string;
  dryRun?: boolean;
  capUsd?: number;
  reps?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface CampaignSummary {
  planned: PlannedRun[];
  records: RunRecord[];
  spentUsd: number;
  stoppedForBudget: boolean;
}

const notImplemented = (name: string): never => {
  throw new Error(`not implemented: ${name}`);
};

/** Deletes AWS_ENDPOINT_URL; refuses local-emulator credentials. */
export function prepareEnv(_env: NodeJS.ProcessEnv): void {
  notImplemented('prepareEnv');
}

export function profileBudget(_profile: ProfileId): { first: number; loop: number } {
  return notImplemented('profileBudget');
}

/** Interleaved rep -> prompt -> profile, so a budget stop leaves every cell sampled. */
export function planRuns(_promptIds: string[], _reps?: number): PlannedRun[] {
  return notImplemented('planRuns');
}

export function buildFirstRequest(
  _capture: CaptureFile,
  _userText: string,
  _profile: ProfileId,
  _guardrail: Guardrail | null,
): ConverseStreamCommandInput {
  return notImplemented('buildFirstRequest');
}

export function buildLoopRequest(
  _capture: CaptureFile,
  _messages: Message[],
  _profile: ProfileId,
  _guardrail: Guardrail | null,
): ConverseCommandInput {
  return notImplemented('buildLoopRequest');
}

/**
 * Worst case for one call: ceil(requestChars / 3) input tokens, all priced as
 * cache writes, plus maxTokens of output, through production's turnCost.
 */
export function worstCaseCallUsd(_requestChars: number, _maxTokens: number): number {
  return notImplemented('worstCaseCallUsd');
}

export function createBudget(_capUsd?: number): Budget {
  return notImplemented('createBudget');
}

export function classifyStop(
  _stopReason: string,
  _text: string,
): { silentTruncation: boolean; visibleTruncation: boolean } {
  return notImplemented('classifyStop');
}

/** Validate, build and reopen one generate_document input with production's code. */
export async function evaluateDocument(_toolInput: unknown): Promise<DocumentGate> {
  return notImplemented('evaluateDocument');
}

export function cannedToolResult(_name: string): { text: string; status: 'success' } {
  return notImplemented('cannedToolResult');
}

export async function runOne(_run: PlannedRun, _deps: RunDeps): Promise<RunRecord> {
  return notImplemented('runOne');
}

export async function runCampaign(_opts: CampaignOptions): Promise<CampaignSummary> {
  return notImplemented('runCampaign');
}
