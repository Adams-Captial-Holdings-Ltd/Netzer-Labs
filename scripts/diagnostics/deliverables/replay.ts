/**
 * Deliverables parity, step 2 (E1): replay the captured production request
 * against real Bedrock, varying ONLY the output budget.
 *
 * SPEND BOUNDARY. With `--spend`, `main()` calls Bedrock with real credentials
 * and costs money. Never pass it without the user's explicit go. The campaign is
 * capped at CAMPAIGN_CAP_USD. The blind judge (step 3) is separately approved.
 *
 *   npx tsx scripts/diagnostics/deliverables/replay.ts --capture <capture.json>
 *     Dry run: prints the plan and the worst-case estimate, sends nothing.
 *   npx tsx scripts/diagnostics/deliverables/replay.ts --capture <capture.json> \
 *     --out <file outside the repo> --spend (--guardrail <id:version> | --no-guardrail)
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
 *   the same messages re-sent non-streaming; up to TOOL_ROUND_LIMIT rounds; then
 *   one tool-less synthesis call if the loop ended calling tools with no text.
 * - generate_document is evaluated with production's own validate*Spec and
 *   build* functions, and the file must reopen. Every other tool gets a canned
 *   result; no product tool handler runs.
 * - Budget: before every call, spent + worst case must stay within the cap, or
 *   the campaign stops and the remaining runs are recorded `budget_exhausted`.
 * - Environment: never loads `.env`, and deletes AWS_ENDPOINT_URL before any
 *   client exists, like `scripts/e2e-three-corpus.ts`.
 * - Output: one JSONL record per run, refused inside the repository. A live run
 *   also keeps what the judge needs in `<out name>-artifacts/<runId>/`: each
 *   built document as `doc-<n>.<format>`, and the final reply as `reply.txt`.
 *
 * Run it on the local branch that carries production's tree (`diag/prod-capture`)
 * so the builders are production's.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  ConverseStreamCommand,
  type ContentBlock,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  type ConverseStreamCommandInput,
  type ConverseStreamCommandOutput,
  type Message,
  type TokenUsage,
  type ToolUseBlock,
} from '@aws-sdk/client-bedrock-runtime';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { turnCost } from '../../../src/lib/bedrock/models.js';
import { buildDocx } from '../../../src/lib/documents/docx.js';
import { buildPdf } from '../../../src/lib/documents/pdf.js';
import { validateDocumentSpec, validateSpreadsheetSpec } from '../../../src/lib/documents/types.js';
import { buildXlsx } from '../../../src/lib/documents/xlsx.js';
import { REPO_ROOT, buildPrompts, refuseInsideRepo } from './prompts.js';

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
  /** A valid spec the builder refused, e.g. characters the PDF font cannot render. */
  buildError?: string;
  bytes: number;
  reopened: boolean;
  reopenError?: string;
  winAnsiRejected: boolean;
  /** Output tokens of the model call that emitted this spec. */
  specOutputTokens?: number;
  /** The built file, relative to `<out name>-artifacts/`. Live runs only. */
  file?: string;
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

/** Sends one SDK command. `main()` passes the real client's `send`; the contract passes a fake. */
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

const PROFILES: readonly ProfileId[] = ['S', 'P', 'U'];
const BUDGETS: Record<ProfileId, { first: number; loop: number }> = {
  S: { first: 1024, loop: 8192 },
  P: { first: 8192, loop: 8192 },
  U: { first: 32000, loop: 32000 },
};
/** Production's withRetry: these errors, 3 attempts on the same model, 500 ms x 2^n between them. */
const RETRYABLE = new Set([
  'ThrottlingException',
  'ServiceUnavailableException',
  'ModelNotReadyException',
  'ModelTimeoutException',
]);
const MAX_ATTEMPTS = 3;
/** Production's forced-synthesis instruction, verbatim. */
const SYNTHESIS_INSTRUCTION =
  'Answer my last request now, in words, using what you found above. Do not call any more tools.';
const PLACEHOLDER_LINK = 'https://diag.invalid/replay-placeholder-link';
/** Production refuses an unknown format with exactly this text, before validating and without a prefix. */
const FORMAT_ERROR = 'format must be one of: pdf, docx, xlsx';

class BudgetRefused extends Error {}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Deletes AWS_ENDPOINT_URL; refuses local-emulator credentials. */
export function prepareEnv(env: NodeJS.ProcessEnv): void {
  delete env.AWS_ENDPOINT_URL;
  if (env.AWS_ACCESS_KEY_ID === 'local') {
    throw new Error('AWS_ACCESS_KEY_ID is "local", the emulator placeholder; sign in to the real account first.');
  }
}

export function profileBudget(profile: ProfileId): { first: number; loop: number } {
  return { ...BUDGETS[profile] };
}

/** Interleaved rep -> prompt -> profile, so a budget stop leaves the cells evenly sampled. */
export function planRuns(promptIds: string[], reps = RUNS_PER_CELL): PlannedRun[] {
  const plan: PlannedRun[] = [];
  for (let rep = 1; rep <= reps; rep++) {
    for (const promptId of promptIds) {
      for (const profile of PROFILES) plan.push({ runId: `r${rep}-${promptId}-${profile}`, rep, promptId, profile });
    }
  }
  return plan;
}

/** The captured call with only its messages, maxTokens and guardrail replaced. */
function fromCapture(
  call: CapturedCall | undefined,
  messages: Message[],
  maxTokens: number,
  guardrail: Guardrail | null,
): ConverseCommandInput {
  if (!call) throw new Error('the capture has no tool-loop call');
  const {
    messages: _capturedMessages,
    guardrailConfig: _placeholder,
    inferenceConfig,
    ...captured
  } = call.input as unknown as ConverseCommandInput;
  return {
    ...captured,
    messages,
    inferenceConfig: { ...inferenceConfig, maxTokens },
    ...(guardrail
      ? { guardrailConfig: { guardrailIdentifier: guardrail.id, guardrailVersion: guardrail.version } }
      : {}),
  };
}

export function buildFirstRequest(
  capture: CaptureFile,
  userText: string,
  profile: ProfileId,
  guardrail: Guardrail | null,
): ConverseStreamCommandInput {
  const messages: Message[] = [{ role: 'user', content: [{ text: userText }] }];
  return fromCapture(capture.firstCall, messages, BUDGETS[profile].first, guardrail);
}

export function buildLoopRequest(
  capture: CaptureFile,
  messages: Message[],
  profile: ProfileId,
  guardrail: Guardrail | null,
): ConverseCommandInput {
  return fromCapture(capture.toolLoopCalls[0], messages, BUDGETS[profile].loop, guardrail);
}

/**
 * Worst case for one call: ceil(requestChars / 3) input tokens, all priced as
 * cache writes, plus maxTokens of output, through production's turnCost.
 */
export function worstCaseCallUsd(requestChars: number, maxTokens: number): number {
  return turnCost(REPLAY_MODEL_ID, 0, maxTokens, 0, Math.ceil(requestChars / 3));
}

export function createBudget(capUsd = CAMPAIGN_CAP_USD): Budget {
  let spent = 0;
  return {
    admit: (worstCaseUsd) => spent + worstCaseUsd <= capUsd,
    record: (actualUsd) => {
      spent += actualUsd;
    },
    spentUsd: () => spent,
  };
}

export function classifyStop(
  stopReason: string,
  text: string,
): { silentTruncation: boolean; visibleTruncation: boolean } {
  const cut = stopReason === 'max_tokens';
  const hasText = text.trim().length > 0;
  return { silentTruncation: cut && hasText, visibleTruncation: cut && !hasText };
}

/** Production's display-name rule for a generated document. */
function fileNameFor(spec: unknown, format: string): string {
  const title = typeof (spec as { title?: unknown } | null)?.title === 'string' ? (spec as { title: string }).title : '';
  const safe = title.trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
  return `${safe || 'document'}.${format}`;
}

async function reopen(format: string, bytes: Buffer): Promise<void> {
  if (format === 'pdf') {
    const { PDFParse } = (await import('pdf-parse')) as typeof import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(bytes) });
    try {
      if (!((await parser.getText()).total > 0)) throw new Error('the PDF has no pages');
    } finally {
      await parser.destroy().catch(() => {});
    }
  } else if (format === 'docx') {
    const zip = await JSZip.loadAsync(bytes);
    if (!zip.file('word/document.xml')) throw new Error('the DOCX has no word/document.xml');
  } else {
    const workbook = new ExcelJS.Workbook();
    // exceljs types its input as an ArrayBuffer; a Node Buffer is what it reads at run time.
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
    if (workbook.worksheets.length < 1) throw new Error('the XLSX has no worksheet');
  }
}

async function buildDocument(toolInput: unknown): Promise<{ gate: DocumentGate; bytes?: Buffer }> {
  const { format, spec } = (toolInput ?? {}) as { format?: unknown; spec?: unknown };
  const gate: DocumentGate = {
    format: String(format ?? ''),
    specChars: JSON.stringify(toolInput ?? null).length,
    specValid: false,
    bytes: 0,
    reopened: false,
    winAnsiRejected: false,
  };
  let build: () => Promise<Buffer>;
  try {
    if (format === 'xlsx') {
      const valid = validateSpreadsheetSpec(spec);
      build = () => buildXlsx(valid);
    } else if (format === 'pdf' || format === 'docx') {
      const valid = validateDocumentSpec(spec);
      build = () => (format === 'pdf' ? buildPdf(valid) : buildDocx(valid));
    } else {
      throw new Error(FORMAT_ERROR);
    }
    gate.specValid = true;
  } catch (err) {
    gate.validationError = errorMessage(err);
    return { gate };
  }
  let bytes: Buffer;
  try {
    bytes = await build();
  } catch (err) {
    gate.buildError = errorMessage(err);
    gate.winAnsiRejected = /cannot render/.test(gate.buildError);
    return { gate };
  }
  gate.bytes = bytes.length;
  try {
    await reopen(gate.format, bytes);
    gate.reopened = true;
  } catch (err) {
    gate.reopenError = errorMessage(err);
  }
  return { gate, bytes };
}

/** Validate, build and reopen one generate_document input with production's code. */
export async function evaluateDocument(toolInput: unknown): Promise<DocumentGate> {
  return (await buildDocument(toolInput)).gate;
}

export function cannedToolResult(name: string): { text: string; status: 'success' } {
  return { text: `${name} is unavailable in this environment and returned no data.`, status: 'success' };
}

interface RunOutcome {
  record: RunRecord;
  /** Built bytes, index-aligned with record.documents; undefined where nothing was built. */
  files: (Buffer | undefined)[];
  reply: string;
}

interface Exchange {
  stopReason: string;
  text: string;
  content: ContentBlock[];
  outputTokens: number;
}

function newRecord(run: PlannedRun, capture: CaptureFile, status: RunRecord['status']): RunRecord {
  return {
    ...run,
    modelId: REPLAY_MODEL_ID,
    status,
    calls: [],
    stopReasons: [],
    documents: [],
    silentTruncation: false,
    visibleTruncation: false,
    guardrailIntervened: false,
    costUsd: 0,
    latencyMs: 0,
    headSha: capture.headSha,
    agentPromptSource: capture.agentPromptSource,
  };
}

async function sendWithRetry(deps: RunDeps, command: () => { input: unknown }): Promise<unknown> {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await deps.send(command());
    } catch (err) {
      const name = (err as { name?: string }).name ?? '';
      if (!RETRYABLE.has(name) || attempt === MAX_ATTEMPTS - 1) throw err;
      await sleep(500 * 2 ** attempt);
    }
  }
}

/** One admitted, metered model call. The first call streams, like production's. */
async function exchange(
  deps: RunDeps,
  record: RunRecord,
  kind: CallRecord['kind'],
  request: ConverseCommandInput,
): Promise<Exchange> {
  const maxTokens = request.inferenceConfig?.maxTokens ?? 0;
  const worstUsd = worstCaseCallUsd(JSON.stringify(request).length, maxTokens);
  if (!deps.budget.admit(worstUsd)) throw new BudgetRefused('budget exhausted');
  const t0 = Date.now();
  let stopReason = 'unknown';
  let content: ContentBlock[] = [];
  let usage: TokenUsage | undefined;
  if (kind === 'first') {
    const res = (await sendWithRetry(deps, () => new ConverseStreamCommand(request))) as ConverseStreamCommandOutput;
    let streamed = '';
    try {
      for await (const event of res.stream ?? []) {
        if (event.contentBlockDelta?.delta?.text) streamed += event.contentBlockDelta.delta.text;
        if (event.messageStop?.stopReason) stopReason = event.messageStop.stopReason;
        if (event.metadata?.usage) usage = event.metadata.usage;
      }
    } catch (err) {
      // Sent and possibly billed, but unmetered: charge the worst case so the cap stays conservative.
      deps.budget.record(worstUsd);
      record.costUsd += worstUsd;
      throw err;
    }
    content = streamed ? [{ text: streamed }] : [];
  } else {
    const res = (await sendWithRetry(deps, () => new ConverseCommand(request))) as ConverseCommandOutput;
    stopReason = res.stopReason ?? 'unknown';
    content = res.output?.message?.content ?? [];
    usage = res.usage;
  }
  const text = content.map((block) => block.text ?? '').join('').trim();
  const inputTokens = usage?.inputTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  const cacheReadInputTokens = usage?.cacheReadInputTokens ?? 0;
  const cacheWriteInputTokens = usage?.cacheWriteInputTokens ?? 0;
  const cost = turnCost(REPLAY_MODEL_ID, inputTokens, outputTokens, cacheReadInputTokens, cacheWriteInputTokens);
  deps.budget.record(cost);
  record.costUsd += cost;
  record.stopReasons.push(stopReason);
  record.calls.push({
    kind,
    maxTokens,
    stopReason,
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheWriteInputTokens,
    textChars: text.length,
    toolUses: content.flatMap((block) => (block.toolUse?.name ? [block.toolUse.name] : [])),
    latencyMs: Date.now() - t0,
  });
  return { stopReason, text, content, outputTokens };
}

/** generate_document gets production's result text, with a placeholder link; anything else a canned one. */
async function runTool(
  use: ToolUseBlock,
  outputTokens: number,
  outcome: RunOutcome,
): Promise<{ text: string; status: 'success' | 'error' }> {
  if (use.name !== 'generate_document') return cannedToolResult(use.name ?? '');
  const { gate, bytes } = await buildDocument(use.input);
  gate.specOutputTokens = outputTokens;
  outcome.record.documents.push(gate);
  outcome.files.push(bytes);
  const failure = gate.validationError ?? gate.buildError;
  if (failure === FORMAT_ERROR) return { text: FORMAT_ERROR, status: 'error' };
  if (failure) return { text: `spec invalid or build failed: ${failure}`, status: 'error' };
  const name = fileNameFor((use.input as { spec?: unknown } | undefined)?.spec, gate.format);
  return {
    text: [
      `${gate.format.toUpperCase()} generated: ${name} (${gate.bytes.toLocaleString()} bytes).`,
      'It is attached for download. Direct link, valid 24h:',
      PLACEHOLDER_LINK,
    ].join('\n'),
    status: 'success',
  };
}

async function execute(run: PlannedRun, deps: RunDeps): Promise<RunOutcome> {
  const t0 = Date.now();
  const outcome: RunOutcome = { record: newRecord(run, deps.capture, 'ok'), files: [], reply: '' };
  const { record } = outcome;
  const loopRequest = (messages: Message[]) => buildLoopRequest(deps.capture, messages, run.profile, deps.guardrail);
  try {
    const first = buildFirstRequest(deps.capture, deps.prompt.text, run.profile, deps.guardrail);
    let out = await exchange(deps, record, 'first', first);
    if (out.stopReason === 'tool_use') {
      // Production drops the streamed reply and re-sends the same messages without streaming.
      const messages: Message[] = [...(first.messages ?? [])];
      for (let round = 0; round < TOOL_ROUND_LIMIT; round++) {
        out = await exchange(deps, record, 'loop', loopRequest(messages));
        messages.push({ role: 'assistant', content: out.content });
        const toolUses = out.content.flatMap((block) => (block.toolUse ? [block.toolUse] : []));
        if (toolUses.length === 0 || out.stopReason !== 'tool_use') break;
        const results: ContentBlock[] = [];
        for (const use of toolUses) {
          const result = await runTool(use, out.outputTokens, outcome);
          results.push({
            toolResult: { toolUseId: use.toolUseId ?? '', content: [{ text: result.text }], status: result.status },
          });
        }
        messages.push({ role: 'user', content: results });
      }
      if (!out.text && out.stopReason === 'tool_use') {
        // Production's forced synthesis: no tools, and the instruction rides inside the trailing user turn.
        const instruction: ContentBlock = { text: SYNTHESIS_INSTRUCTION };
        const tail = messages.at(-1);
        const synthMessages: Message[] =
          tail?.role === 'user'
            ? [...messages.slice(0, -1), { role: 'user', content: [...(tail.content ?? []), instruction] }]
            : [...messages, { role: 'user', content: [instruction] }];
        const { toolConfig: _tools, ...synthesis } = loopRequest(synthMessages);
        out = await exchange(deps, record, 'loop', synthesis);
      }
    }
    outcome.reply = out.text;
  } catch (err) {
    if (err instanceof BudgetRefused) {
      record.status = 'budget_exhausted';
    } else {
      record.status = 'error';
      record.error = `${(err as { name?: string }).name ?? 'Error'}: ${errorMessage(err)}`;
    }
  }
  Object.assign(record, classifyStop(record.stopReasons.at(-1) ?? '', outcome.reply), {
    guardrailIntervened: record.stopReasons.includes('guardrail_intervened'),
    latencyMs: Date.now() - t0,
  });
  return outcome;
}

export async function runOne(run: PlannedRun, deps: RunDeps): Promise<RunRecord> {
  return (await execute(run, deps)).record;
}

function assertCapture(capture: CaptureFile): void {
  if (capture.schema !== 'deliverables-capture/1') {
    throw new Error(`capture schema is ${String(capture.schema)}; expected deliverables-capture/1`);
  }
  if (capture.firstCall?.input?.modelId !== REPLAY_MODEL_ID) {
    throw new Error(`the capture calls ${String(capture.firstCall?.input?.modelId)}; the replay pins ${REPLAY_MODEL_ID}`);
  }
  if (!capture.toolLoopCalls?.[0]) throw new Error('the capture has no tool-loop call');
}

function saveArtifacts(dir: string, { record, files, reply }: RunOutcome): void {
  mkdirSync(dir, { recursive: true });
  record.documents.forEach((doc, i) => {
    const bytes = files[i];
    if (!bytes) return;
    const name = `doc-${i + 1}.${doc.format}`;
    writeFileSync(join(dir, name), bytes);
    doc.file = `${record.runId}/${name}`;
  });
  writeFileSync(join(dir, 'reply.txt'), reply);
}

export async function runCampaign(opts: CampaignOptions): Promise<CampaignSummary> {
  refuseInsideRepo(opts.outFile, opts.repoRoot);
  assertCapture(opts.capture);
  const planned = planRuns(
    opts.prompts.map((p) => p.id),
    opts.reps,
  );
  const summary: CampaignSummary = { planned, records: [], spentUsd: 0, stoppedForBudget: false };
  if (opts.dryRun) return summary;

  mkdirSync(dirname(opts.outFile), { recursive: true });
  // 'wx' refuses an existing file, so two campaigns never mix in one record set.
  writeFileSync(opts.outFile, '', { flag: 'wx' });
  const artifactsDir = join(dirname(opts.outFile), `${parse(opts.outFile).name}-artifacts`);
  const budget = createBudget(opts.capUsd);
  const prompts = new Map(opts.prompts.map((p) => [p.id, p]));
  for (const run of planned) {
    let record: RunRecord;
    if (summary.stoppedForBudget) {
      record = newRecord(run, opts.capture, 'budget_exhausted');
    } else {
      const outcome = await execute(run, {
        send: opts.send,
        capture: opts.capture,
        prompt: prompts.get(run.promptId) as PromptRef,
        guardrail: opts.guardrail,
        budget,
        sleep: opts.sleep,
      });
      saveArtifacts(join(artifactsDir, run.runId), outcome);
      record = outcome.record;
      summary.stoppedForBudget = record.status === 'budget_exhausted';
    }
    summary.records.push(record);
    appendFileSync(opts.outFile, `${JSON.stringify(record)}\n`);
  }
  summary.spentUsd = budget.spentUsd();
  return summary;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      capture: { type: 'string' },
      out: { type: 'string' },
      reps: { type: 'string' },
      spend: { type: 'boolean' },
      guardrail: { type: 'string' },
      'no-guardrail': { type: 'boolean' },
    },
  });
  if (!values.capture) throw new Error('--capture <capture-<sha>.json> is required');
  if (values.out) refuseInsideRepo(values.out, REPO_ROOT);
  const capture = JSON.parse(readFileSync(values.capture, 'utf8')) as CaptureFile;
  assertCapture(capture);
  const reps = Number(values.reps ?? RUNS_PER_CELL);
  if (!Number.isInteger(reps) || reps < 1) throw new Error('--reps must be a positive integer');
  let guardrail: Guardrail | null = null;
  if (values.guardrail !== undefined) {
    // Split on the last colon: a guardrail identifier may be an ARN.
    const at = values.guardrail.lastIndexOf(':');
    const id = values.guardrail.slice(0, at);
    const version = values.guardrail.slice(at + 1);
    if (at < 1 || !version) throw new Error('--guardrail must be <id>:<version>');
    guardrail = { id, version };
  }

  const prompts = buildPrompts();
  const plan = planRuns(
    prompts.map((p) => p.id),
    reps,
  );
  const guardrailLabel = guardrail
    ? `${guardrail.id}:${guardrail.version}`
    : values['no-guardrail']
      ? 'none (--no-guardrail)'
      : 'not chosen';
  console.log(`Capture ${capture.headSha.slice(0, 12)}, agent prompt ${capture.agentPromptSource}`);
  console.log(`Model ${REPLAY_MODEL_ID}, no fallback. Guardrail: ${guardrailLabel}.`);
  let worstUsd = 0;
  for (const prompt of prompts) {
    for (const profile of PROFILES) {
      const { first, loop } = BUDGETS[profile];
      const chars = JSON.stringify(buildFirstRequest(capture, prompt.text, profile, guardrail)).length;
      const perRun = worstCaseCallUsd(chars, first) + (TOOL_ROUND_LIMIT + 1) * worstCaseCallUsd(chars, loop);
      worstUsd += perRun * reps;
      console.log(
        `  ${prompt.id.padEnd(22)} ${profile}  maxTokens ${String(first).padStart(5)}/${String(loop).padStart(5)}` +
          `  first request ${String(chars).padStart(6)} chars  worst $${perRun.toFixed(2)} per run x ${reps}`,
      );
    }
  }
  console.log(
    `${plan.length} runs, interleaved rep > prompt > profile. Worst case if every run made all ` +
      `${TOOL_ROUND_LIMIT + 2} calls at the first request's size: $${worstUsd.toFixed(2)}. ` +
      `Admission re-checks every real request against the $${CAMPAIGN_CAP_USD} cap.`,
  );
  if (!values.spend) {
    console.log('Dry run: nothing sent, nothing written. Sending needs --spend, --out, and --guardrail or --no-guardrail.');
    return;
  }
  if ((values.guardrail !== undefined) === Boolean(values['no-guardrail'])) {
    throw new Error('--spend needs exactly one of --guardrail <id:version> or --no-guardrail');
  }
  if (!values.out) throw new Error('--spend needs --out <file outside the repository>');
  prepareEnv(process.env);
  const client = new BedrockRuntimeClient({ region: 'us-east-1' });
  const summary = await runCampaign({
    capture,
    prompts,
    guardrail,
    send: (command) => client.send(command as ConverseCommand),
    outFile: values.out,
    repoRoot: REPO_ROOT,
    reps,
  });
  const count = (status: RunRecord['status']) => summary.records.filter((r) => r.status === status).length;
  console.log(
    `Spent $${summary.spentUsd.toFixed(2)} of $${CAMPAIGN_CAP_USD}. ok ${count('ok')}, error ${count('error')}, ` +
      `budget_exhausted ${count('budget_exhausted')}. Records: ${values.out}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(errorMessage(err));
    process.exitCode = 1;
  });
}
