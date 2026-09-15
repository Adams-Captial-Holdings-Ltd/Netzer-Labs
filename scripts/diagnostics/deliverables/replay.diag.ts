/**
 * Deliverables parity, step 2: the replay's contract, hermetic.
 *
 * Every case drives `replay.ts` and `prompts.ts` through a fake `send`, so
 * nothing here reaches Bedrock. While those exports are SPECIFICATION stubs,
 * every case must fail on "not implemented" and on nothing else; the
 * IMPLEMENTATION phase makes them pass.
 *
 * Run it on the branch that carries production's tree: R7 characterises
 * production's document builders.
 *
 *   npx vitest run --config scripts/diagnostics/deliverables/vitest.diag.config.ts replay
 */
import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { turnCost } from '../../../src/lib/bedrock/models.js';
import {
  CAMPAIGN_CAP_USD,
  REPLAY_MODEL_ID,
  buildFirstRequest,
  buildLoopRequest,
  cannedToolResult,
  classifyStop,
  createBudget,
  evaluateDocument,
  planRuns,
  prepareEnv,
  profileBudget,
  runCampaign,
  runOne,
  worstCaseCallUsd,
  type Budget,
  type CallRecord,
  type CaptureFile,
  type Guardrail,
  type PlannedRun,
  type ProfileId,
  type RunDeps,
  type Send,
} from './replay.js';
import {
  CSV_HEADER,
  PROMPT_IDS,
  buildPrompts,
  csvFixture,
  exportPrompts,
  sourceText,
} from './prompts.js';

const REPO_ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const PROFILES: ProfileId[] = ['S', 'P', 'U'];

/** True when HEAD carries `commit`. A missing object throws. */
function carries(commit: string): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], { stdio: 'ignore' });
    return true;
  } catch (err) {
    if ((err as { status?: number }).status === 1) return false;
    throw err;
  }
}

const SYSTEM = [{ text: 'You are the production agent.' }, { cachePoint: { type: 'default' } }];
const TOOLS = {
  tools: [
    { toolSpec: { name: 'generate_document', description: 'Generate a file.', inputSchema: { json: { type: 'object' } } } },
    { toolSpec: { name: 'web_search', description: 'Search the web.', inputSchema: { json: { type: 'object' } } } },
    { cachePoint: { type: 'default' } },
  ],
};
const PLACEHOLDER_GUARDRAIL = { guardrailIdentifier: 'diag-guardrail-placeholder', guardrailVersion: 'DRAFT' };
const capturedInput = () => ({
  modelId: REPLAY_MODEL_ID,
  system: SYSTEM,
  messages: [{ role: 'user', content: [{ text: 'captured user text' }] }],
  inferenceConfig: { maxTokens: 8192, temperature: 0.7 },
  toolConfig: TOOLS,
  guardrailConfig: PLACEHOLDER_GUARDRAIL,
});
const CAPTURE: CaptureFile = {
  schema: 'deliverables-capture/1',
  headSha: 'de244e6387efdba177d550d1fb82a6d60291309e',
  agentPromptSource: 'builtin-default',
  guardrailPlaceholder: 'diag-guardrail-placeholder',
  firstCall: { command: 'ConverseStreamCommand', input: capturedInput() },
  toolLoopCalls: [{ command: 'ConverseCommand', input: capturedInput() }],
};
/** System text past 1,000 characters, so a request's guardrail units depend on its whole size. */
const LONG_SYSTEM = [{ text: 'Production agent rules. '.repeat(100) }, { cachePoint: { type: 'default' } }];
const LONG_CAPTURE: CaptureFile = {
  ...CAPTURE,
  firstCall: { command: 'ConverseStreamCommand', input: { ...capturedInput(), system: LONG_SYSTEM } },
  toolLoopCalls: [{ command: 'ConverseCommand', input: { ...capturedInput(), system: LONG_SYSTEM } }],
};

const PROMPT = { id: 'p-test', text: 'Write a one-page memo as a Word document.' };
const FIVE_PROMPTS = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, text: `prompt ${id}` }));
const GUARDRAIL = { id: 'gr-real', version: '3' };
const noSleep = async (): Promise<void> => {};
const run = (profile: ProfileId): PlannedRun => ({
  runId: `r1-${PROMPT.id}-${profile}`,
  rep: 1,
  promptId: PROMPT.id,
  profile,
});
/** An error carrying an SDK-style name, which is all the replay reads from it. */
const named = (name: string, message = `${name} from the fake`): Error => Object.assign(new Error(message), { name });
const depsFor = (send: Send, guardrail: Guardrail | null = null, budget: Budget = createBudget()): RunDeps => ({
  send,
  capture: CAPTURE,
  prompt: PROMPT,
  guardrail,
  budget,
  sleep: noSleep,
});
const tmpFile = (name: string): string => join(mkdtempSync(join(tmpdir(), 'replay-diag-')), name);

interface Step {
  stopReason: string;
  text?: string;
  toolUses?: { name: string; input: unknown }[];
  /** `null` answers without usage. */
  usage?: { inputTokens: number; outputTokens: number } | null;
  /** A streamed answer throws an error with this name after its text, before it stops. */
  streamError?: string;
}
interface Sent {
  command: string;
  input: Record<string, unknown>;
}
type Msg = { role: string; content: Record<string, unknown>[] };

/** A Bedrock stand-in: records each command's input and answers from `next`. */
function fakeBedrock(next: (command: string, input: Record<string, unknown>) => Step) {
  const sent: Sent[] = [];
  const send = vi.fn(async (command: { input: unknown }) => {
    const name = (command as unknown as { constructor: { name: string } }).constructor.name;
    const input = JSON.parse(JSON.stringify(command.input)) as Record<string, unknown>;
    sent.push({ command: name, input });
    const step = next(name, input);
    const usage = step.usage === null ? undefined : (step.usage ?? { inputTokens: 0, outputTokens: 50 });
    if (name === 'ConverseStreamCommand') {
      return {
        stream: (async function* () {
          if (step.text) yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: step.text } } };
          if (step.streamError) throw named(step.streamError);
          yield { messageStop: { stopReason: step.stopReason } };
          if (usage) yield { metadata: { usage } };
        })(),
      };
    }
    const content = [
      ...(step.text ? [{ text: step.text }] : []),
      ...(step.toolUses ?? []).map((t, i) => ({
        toolUse: { toolUseId: `tu-${i + 1}`, name: t.name, input: t.input },
      })),
    ];
    return { stopReason: step.stopReason, ...(usage ? { usage } : {}), output: { message: { role: 'assistant', content } } };
  });
  return { send, sent };
}

const scripted = (steps: Step[]) => () => steps.shift() ?? { stopReason: 'end_turn', text: 'done' };
const maxTokensOf = (input: Record<string, unknown>): number =>
  (input.inferenceConfig as { maxTokens: number }).maxTokens;
const endsWithToolResult = (input: Record<string, unknown>): boolean =>
  Boolean((input.messages as Msg[]).at(-1)?.content.some((b) => 'toolResult' in b));
const charsOf = (input: Record<string, unknown>): number => JSON.stringify(input).length;
/** What admission reserves for one call, and what an unmetered call is charged. */
const worstOf = (input: Record<string, unknown>): number => worstCaseCallUsd(charsOf(input), maxTokensOf(input));
/** R12: production's two priced guardrail policies, $0.25 per 1,000 text units of up to 1,000 characters. */
const guardrailUsd = (requestChars: number, outputTokens: number): number =>
  (Math.ceil(requestChars / 1000) + Math.ceil((outputTokens * 4) / 1000)) * 0.00025;

describe('replay contract (E1)', () => {
  it('R1 profiles: S 1024/8192, P 8192/8192, U 32000/32000', () => {
    expect(profileBudget('S')).toEqual({ first: 1024, loop: 8192 });
    expect(profileBudget('P')).toEqual({ first: 8192, loop: 8192 });
    expect(profileBudget('U')).toEqual({ first: 32000, loop: 32000 });
  });

  it('R2 only maxTokens varies; the rest is the capture, with the chosen guardrail', () => {
    const firsts = PROFILES.map((p) => buildFirstRequest(CAPTURE, PROMPT.text, p, GUARDRAIL));
    expect(firsts.map((r) => r.inferenceConfig?.maxTokens)).toEqual([1024, 8192, 32000]);
    const withoutCeiling = (r: object) => {
      const copy = JSON.parse(JSON.stringify(r)) as { inferenceConfig: { maxTokens?: number } };
      delete copy.inferenceConfig.maxTokens;
      return copy;
    };
    expect(withoutCeiling(firsts[0])).toEqual(withoutCeiling(firsts[1]));
    expect(withoutCeiling(firsts[1])).toEqual(withoutCeiling(firsts[2]));
    expect(firsts[0].modelId).toBe(REPLAY_MODEL_ID);
    expect(firsts[0].system).toEqual(CAPTURE.firstCall.input.system);
    expect(firsts[0].toolConfig).toEqual(CAPTURE.firstCall.input.toolConfig);
    expect(firsts[0].inferenceConfig?.temperature).toBe(0.7);
    expect(firsts[0].messages).toEqual([{ role: 'user', content: [{ text: PROMPT.text }] }]);
    expect(firsts[0].guardrailConfig).toEqual({ guardrailIdentifier: 'gr-real', guardrailVersion: '3' });
    expect(buildFirstRequest(CAPTURE, PROMPT.text, 'P', null).guardrailConfig).toBeUndefined();

    const messages = [{ role: 'user', content: [{ text: PROMPT.text }] }];
    const loops = PROFILES.map((p) => buildLoopRequest(CAPTURE, messages as never, p, GUARDRAIL));
    expect(loops.map((r) => r.inferenceConfig?.maxTokens)).toEqual([8192, 8192, 32000]);
    expect(loops[0].system).toEqual(CAPTURE.toolLoopCalls[0].input.system);
    expect(loops[0].toolConfig).toEqual(CAPTURE.toolLoopCalls[0].input.toolConfig);
    expect(loops[0].messages).toEqual(messages);
  });

  it('R3 one model and no fallback: a throttle never changes the model', async () => {
    const { send, sent } = fakeBedrock(() => {
      throw Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
    });
    const record = await runOne(run('P'), {
      send,
      capture: CAPTURE,
      prompt: PROMPT,
      guardrail: GUARDRAIL,
      budget: createBudget(),
      sleep: noSleep,
    });
    expect(record.status).toBe('error');
    expect(record.error).toMatch(/ThrottlingException/);
    expect(sent.length).toBeGreaterThan(0);
    expect(new Set(sent.map((s) => s.input.modelId))).toEqual(new Set([REPLAY_MODEL_ID]));
  });

  it('R4 environment: no .env, no endpoint override, no emulator credentials', () => {
    const env: NodeJS.ProcessEnv = { AWS_ENDPOINT_URL: 'http://127.0.0.1:4566', AWS_PROFILE: 'default' };
    prepareEnv(env);
    expect(env.AWS_ENDPOINT_URL).toBeUndefined();
    expect(env.AWS_PROFILE).toBe('default');
    expect(() => prepareEnv({ AWS_ACCESS_KEY_ID: 'local', AWS_SECRET_ACCESS_KEY: 'local' })).toThrow(/local/i);
    const source = readFileSync(new URL('./replay.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from ['"]dotenv|loadEnv\(/);
  });

  it('R5 budget: admission uses the worst case, and the campaign stops within the cap', async () => {
    expect(worstCaseCallUsd(30_000, 32_000)).toBeCloseTo(turnCost(REPLAY_MODEL_ID, 0, 32_000, 0, 10_000), 10);
    const budget = createBudget(30);
    expect(budget.admit(30)).toBe(true);
    budget.record(29);
    expect(budget.admit(1)).toBe(true);
    expect(budget.admit(1.01)).toBe(false);
    expect(budget.spentUsd()).toBe(29);

    // Every call burns its whole output budget and keeps calling a tool, so the
    // 75 planned runs would cost far more than the cap.
    const { send } = fakeBedrock((command, input) => {
      const usage = { inputTokens: 0, outputTokens: maxTokensOf(input) };
      if (command === 'ConverseStreamCommand') return { stopReason: 'tool_use', usage };
      if (!input.toolConfig) return { stopReason: 'end_turn', text: 'summary', usage };
      return { stopReason: 'tool_use', toolUses: [{ name: 'web_search', input: { query: 'x' } }], usage };
    });
    const summary = await runCampaign({
      capture: CAPTURE,
      prompts: FIVE_PROMPTS,
      guardrail: null,
      send,
      outFile: tmpFile('budget.jsonl'),
      repoRoot: REPO_ROOT,
      sleep: noSleep,
    });
    expect(summary.stoppedForBudget).toBe(true);
    expect(summary.spentUsd).toBeLessThanOrEqual(CAMPAIGN_CAP_USD);
    expect(summary.records).toHaveLength(75);
    const firstStop = summary.records.findIndex((r) => r.status === 'budget_exhausted');
    expect(firstStop).toBeGreaterThan(0);
    expect(summary.records.slice(firstStop).every((r) => r.status === 'budget_exhausted')).toBe(true);
    expect(summary.records.reduce((n, r) => n + r.costUsd, 0)).toBeCloseTo(summary.spentUsd, 6);
  });

  it('R6 dry run: 75 runs interleaved rep, prompt, profile, and nothing sent', async () => {
    const plan = planRuns(FIVE_PROMPTS.map((p) => p.id), 5);
    expect(plan).toHaveLength(75);
    expect(plan.slice(0, 4).map((r) => [r.rep, r.promptId, r.profile])).toEqual([
      [1, 'a', 'S'],
      [1, 'a', 'P'],
      [1, 'a', 'U'],
      [1, 'b', 'S'],
    ]);
    expect(plan.at(-1)).toMatchObject({ rep: 5, promptId: 'e', profile: 'U' });
    expect(new Set(plan.map((r) => r.runId)).size).toBe(75);

    const { send } = fakeBedrock(() => ({ stopReason: 'end_turn', text: 'x' }));
    const outFile = tmpFile('dry.jsonl');
    const summary = await runCampaign({
      capture: CAPTURE,
      prompts: FIVE_PROMPTS,
      guardrail: null,
      send,
      outFile,
      repoRoot: REPO_ROOT,
      dryRun: true,
    });
    expect(summary.planned).toHaveLength(75);
    expect(summary.records).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
    expect(existsSync(outFile)).toBe(false);
  });

  it("R7 file gates use production's validators and builders, and the file must reopen", async () => {
    const pdf = await evaluateDocument({
      format: 'pdf',
      spec: { title: 'SWOT', sections: [{ heading: 'Strengths', body: 'Brand.', table: { rows: [['a', 'b']] } }] },
    });
    expect(pdf).toMatchObject({ format: 'pdf', specValid: true, reopened: true, winAnsiRejected: false });
    expect(pdf.bytes).toBeGreaterThan(0);

    const docx = await evaluateDocument({ format: 'docx', spec: { title: 'Memo', sections: [{ body: 'Hello.' }] } });
    expect(docx).toMatchObject({ format: 'docx', specValid: true, reopened: true });

    const xlsx = await evaluateDocument({
      format: 'xlsx',
      spec: { title: 'Book', sheets: [{ name: 'Data', rows: [['a', 1], ['b', 2]] }] },
    });
    expect(xlsx).toMatchObject({ format: 'xlsx', specValid: true, reopened: true });

    const invalid = await evaluateDocument({ format: 'pdf', spec: {} });
    expect(invalid).toMatchObject({ specValid: false, bytes: 0, reopened: false });
    expect(invalid.validationError).toBeTruthy();

    // Characterises the tree: production (d828124) refuses; development builds it.
    const check = await evaluateDocument({ format: 'pdf', spec: { title: 'Status ✓', sections: [{ body: 'Done ✓' }] } });
    expect(check.winAnsiRejected).toBe(carries('d828124'));
  });

  it('R8 truncation: max_tokens with text is silent; with no text it is visible', () => {
    expect(classifyStop('max_tokens', 'partial')).toEqual({ silentTruncation: true, visibleTruncation: false });
    expect(classifyStop('max_tokens', '')).toEqual({ silentTruncation: false, visibleTruncation: true });
    expect(classifyStop('end_turn', 'done')).toEqual({ silentTruncation: false, visibleTruncation: false });
  });

  it('R9 the loop mirrors production, and other tools get canned results', async () => {
    const { send, sent } = fakeBedrock(
      scripted([
        { stopReason: 'tool_use' },
        { stopReason: 'tool_use', toolUses: [{ name: 'web_search', input: { query: 'x' } }] },
        { stopReason: 'end_turn', text: 'Here you go.' },
      ]),
    );
    const record = await runOne(run('P'), {
      send,
      capture: CAPTURE,
      prompt: PROMPT,
      guardrail: null,
      budget: createBudget(),
      sleep: noSleep,
    });
    expect(sent.map((s) => s.command)).toEqual(['ConverseStreamCommand', 'ConverseCommand', 'ConverseCommand']);
    // Production re-sends the first call's messages, non-streaming, on tool_use.
    expect(sent[1].input.messages).toEqual(sent[0].input.messages);
    const last = (sent[2].input.messages as Msg[]).at(-1);
    expect(last?.role).toBe('user');
    expect(last?.content[0]).toEqual({
      toolResult: {
        toolUseId: 'tu-1',
        content: [{ text: cannedToolResult('web_search').text }],
        status: 'success',
      },
    });
    expect(record).toMatchObject({ status: 'ok', stopReasons: ['tool_use', 'tool_use', 'end_turn'] });
    expect(record.calls.map((c) => c.kind)).toEqual(['first', 'loop', 'loop']);
    const source = readFileSync(new URL('./replay.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/src\/lib\/tools\//);
  });

  it('R10 one JSONL record per run, outside the repository, carrying the measurements', async () => {
    const refused = fakeBedrock(() => ({ stopReason: 'end_turn', text: 'x' }));
    await expect(
      runCampaign({
        capture: CAPTURE,
        prompts: [PROMPT],
        guardrail: null,
        send: refused.send,
        outFile: join(REPO_ROOT, 'runs.jsonl'),
        repoRoot: REPO_ROOT,
        reps: 1,
      }),
    ).rejects.toThrow(/inside the repository/);
    expect(refused.send).not.toHaveBeenCalled();

    const spec = { format: 'xlsx', spec: { title: 'Book', sheets: [{ name: 'Data', rows: [['a', 1]] }] } };
    const { send } = fakeBedrock((command, input) => {
      if (command === 'ConverseStreamCommand') {
        return { stopReason: 'tool_use', usage: { inputTokens: 0, outputTokens: 700 } };
      }
      if (endsWithToolResult(input)) return { stopReason: 'end_turn', text: 'Attached.' };
      return {
        stopReason: 'tool_use',
        toolUses: [{ name: 'generate_document', input: spec }],
        usage: { inputTokens: 0, outputTokens: 750 },
      };
    });
    const outFile = tmpFile('runs.jsonl');
    const summary = await runCampaign({
      capture: CAPTURE,
      prompts: [PROMPT],
      guardrail: null,
      send,
      outFile,
      repoRoot: REPO_ROOT,
      reps: 1,
      sleep: noSleep,
    });
    const lines = readFileSync(outFile, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(3);
    expect(summary.records).toHaveLength(3);
    expect(lines.map((l) => l.profile)).toEqual(PROFILES);
    for (const line of lines) {
      expect(line).toMatchObject({
        promptId: PROMPT.id,
        modelId: REPLAY_MODEL_ID,
        status: 'ok',
        headSha: CAPTURE.headSha,
        agentPromptSource: CAPTURE.agentPromptSource,
        stopReasons: ['tool_use', 'tool_use', 'end_turn'],
      });
      expect(line.documents[0]).toMatchObject({
        format: 'xlsx',
        specValid: true,
        reopened: true,
        specOutputTokens: 750,
      });
      expect(line.costUsd).toBeGreaterThan(0);
      expect(line.latencyMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('R11 an unmetered call is charged its worst case, and admission runs before every attempt', async () => {
    // A non-streaming round lost after it was sent is charged its worst case, and so is any other
    // failure that is not a request rejection, whatever its name.
    for (const name of ['TimeoutError', 'InternalServerException', 'SomethingUnexpected']) {
      const lost = fakeBedrock((command) => {
        if (command === 'ConverseStreamCommand') {
          return { stopReason: 'tool_use', usage: { inputTokens: 100, outputTokens: 20 } };
        }
        throw named(name, 'socket hang up');
      });
      const lostBudget = createBudget();
      const lostRecord = await runOne(run('P'), depsFor(lost.send, null, lostBudget));
      expect(lostRecord.status, name).toBe('error');
      expect(lost.sent, name).toHaveLength(2);
      const lostUsd = turnCost(REPLAY_MODEL_ID, 100, 20, 0, 0) + worstOf(lost.sent[1].input);
      expect(lostRecord.costUsd, name).toBeCloseTo(lostUsd, 10);
      expect(lostBudget.spentUsd(), name).toBeCloseTo(lostUsd, 10);
    }

    // Answers without usage, streamed and not: each charged its worst case.
    const unmetered = fakeBedrock((command) =>
      command === 'ConverseStreamCommand'
        ? { stopReason: 'tool_use', usage: null }
        : { stopReason: 'end_turn', text: 'Here you go.', usage: null },
    );
    const unmeteredBudget = createBudget();
    const unmeteredRecord = await runOne(run('S'), depsFor(unmetered.send, null, unmeteredBudget));
    expect(unmeteredRecord.status).toBe('ok');
    expect(unmetered.sent).toHaveLength(2);
    const unmeteredUsd = worstOf(unmetered.sent[0].input) + worstOf(unmetered.sent[1].input);
    expect(unmeteredRecord.costUsd).toBeCloseTo(unmeteredUsd, 10);
    expect(unmeteredBudget.spentUsd()).toBeCloseTo(unmeteredUsd, 10);

    // The same for rounds that build a document.
    const spec = { format: 'xlsx', spec: { title: 'Book', sheets: [{ name: 'Data', rows: [['a', 1]] }] } };
    const unmeteredDocument = fakeBedrock((command, input) => {
      if (command === 'ConverseStreamCommand') return { stopReason: 'tool_use', usage: null };
      if (endsWithToolResult(input)) return { stopReason: 'end_turn', text: 'Attached.', usage: null };
      return { stopReason: 'tool_use', toolUses: [{ name: 'generate_document', input: spec }], usage: null };
    });
    const unmeteredDocumentRecord = await runOne(run('S'), depsFor(unmeteredDocument.send));
    expect(unmeteredDocumentRecord.status).toBe('ok');
    expect(unmeteredDocumentRecord.documents).toHaveLength(1);

    // A stream that fails while being read keeps its worst-case charge, whatever the error's name:
    // Bedrock can end an accepted stream with a throttling or validation exception.
    for (const name of ['ModelStreamErrorException', 'ThrottlingException', 'ValidationException']) {
      const broken = fakeBedrock(() => ({ stopReason: 'end_turn', text: 'partial', streamError: name }));
      const brokenBudget = createBudget();
      const brokenRecord = await runOne(run('U'), depsFor(broken.send, null, brokenBudget));
      expect(brokenRecord.status, name).toBe('error');
      expect(broken.sent, name).toHaveLength(1);
      expect(brokenRecord.costUsd, name).toBeCloseTo(worstOf(broken.sent[0].input), 10);
      expect(brokenBudget.spentUsd(), name).toBeCloseTo(brokenRecord.costUsd, 10);
    }

    // A charged failure that is retried: the failure costs its worst case, the retry what it used.
    // Like the SDK's ModelTimeoutException, the fake carries `$fault: 'client'`; charging goes by name.
    const timeout = (): Error => Object.assign(named('ModelTimeoutException'), { $fault: 'client' });
    let attempts = 0;
    const flaky = fakeBedrock(() => {
      attempts++;
      if (attempts === 1) throw timeout();
      return { stopReason: 'end_turn', text: 'done', usage: { inputTokens: 10, outputTokens: 5 } };
    });
    const flakyBudget = createBudget();
    const flakySleep = vi.fn(async (_ms: number) => {});
    const flakyRecord = await runOne(run('S'), { ...depsFor(flaky.send, null, flakyBudget), sleep: flakySleep });
    expect(flakyRecord.status).toBe('ok');
    expect(flaky.sent).toHaveLength(2);
    expect(flakySleep.mock.calls).toEqual([[500]]);
    const flakyUsd = worstOf(flaky.sent[0].input) + turnCost(REPLAY_MODEL_ID, 10, 5, 0, 0);
    expect(flakyRecord.costUsd).toBeCloseTo(flakyUsd, 10);
    expect(flakyBudget.spentUsd()).toBeCloseTo(flakyUsd, 10);

    // A charged failure on every attempt is charged on each of them.
    const failing = fakeBedrock(() => {
      throw timeout();
    });
    const failingBudget = createBudget();
    const failingSleep = vi.fn(async (_ms: number) => {});
    const failingRecord = await runOne(run('S'), {
      ...depsFor(failing.send, null, failingBudget),
      sleep: failingSleep,
    });
    expect(failingRecord.status).toBe('error');
    expect(failing.sent).toHaveLength(3);
    expect(failingSleep.mock.calls).toEqual([[500], [1000]]);
    const failingUsd = 3 * worstOf(failing.sent[0].input);
    expect(failingRecord.costUsd).toBeCloseTo(failingUsd, 10);
    expect(failingBudget.spentUsd()).toBeCloseTo(failingUsd, 10);

    // Admission runs again before the retry and counts the charged failure: a cap just short of two
    // worst cases stops the run after one attempt.
    const firstWorst = worstCaseCallUsd(JSON.stringify(buildFirstRequest(CAPTURE, PROMPT.text, 'S', null)).length, 1024);
    const tight = createBudget(firstWorst * 2 - 1e-9);
    const timeouts = fakeBedrock(() => {
      throw timeout();
    });
    const tightRecord = await runOne(run('S'), depsFor(timeouts.send, null, tight));
    expect(tightRecord.status).toBe('budget_exhausted');
    expect(timeouts.sent).toHaveLength(1);
    expect(tight.spentUsd()).toBeCloseTo(firstWorst, 10);

    // A rejection is never charged, even after every retry and with a guardrail chosen. Retries follow
    // production: three attempts, 500 ms then 1000 ms apart, for the retryable names only.
    const retried = new Set(['ThrottlingException', 'ServiceUnavailableException', 'ModelNotReadyException']);
    for (const name of [
      'ThrottlingException',
      'ServiceUnavailableException',
      'ModelNotReadyException',
      'ValidationException',
      'AccessDeniedException',
      'ResourceNotFoundException',
      'ServiceQuotaExceededException',
      'CredentialsProviderError',
      'TokenProviderError',
      'ExpiredTokenException',
      'UnrecognizedClientException',
      'InvalidSignatureException',
    ]) {
      const rejected = fakeBedrock(() => {
        throw named(name);
      });
      const budget = createBudget();
      const sleep = vi.fn(async (_ms: number) => {});
      const record = await runOne(run('U'), { ...depsFor(rejected.send, GUARDRAIL, budget), sleep });
      expect(record.status, name).toBe('error');
      expect(record.error, name).toMatch(new RegExp(`^${name}:`));
      expect(record.costUsd, name).toBe(0);
      expect(budget.spentUsd(), name).toBe(0);
      expect(rejected.sent, name).toHaveLength(retried.has(name) ? 3 : 1);
      expect(sleep.mock.calls, name).toEqual(retried.has(name) ? [[500], [1000]] : []);
    }

    // Unmetered is not measured: the records keep the tokens Bedrock reported, which was none.
    const tokens = (c: CallRecord) => [c.inputTokens, c.outputTokens, c.cacheReadInputTokens, c.cacheWriteInputTokens];
    expect(unmeteredRecord.calls.map(tokens)).toEqual([
      [0, 0, 0, 0],
      [0, 0, 0, 0],
    ]);
    expect(unmeteredDocumentRecord.calls.map((c) => c.outputTokens)).toEqual([0, 0, 0]);
    expect(unmeteredDocumentRecord.documents[0].specOutputTokens).toBe(0);
  });

  it('R12 a chosen guardrail adds its text units to admission and to the charge', async () => {
    // A metered call: its tokens, plus guardrail units for the whole request and its output tokens.
    // The long system text makes the whole request's units differ from its messages' units.
    const answer = { stopReason: 'end_turn', text: 'done', usage: { inputTokens: 120, outputTokens: 2600 } };
    const metered = fakeBedrock(() => answer);
    const meteredRecord = await runOne(run('P'), { ...depsFor(metered.send, GUARDRAIL), capture: LONG_CAPTURE });
    expect(meteredRecord.status).toBe('ok');
    const meteredChars = charsOf(metered.sent[0].input);
    expect(meteredChars).toBeGreaterThan(2000);
    const tokensUsd = turnCost(REPLAY_MODEL_ID, 120, 2600, 0, 0);
    expect(meteredRecord.costUsd).toBeCloseTo(tokensUsd + guardrailUsd(meteredChars, 2600), 10);

    // No guardrail, no allowance.
    const plain = fakeBedrock(() => answer);
    const plainRecord = await runOne(run('P'), { ...depsFor(plain.send), capture: LONG_CAPTURE });
    expect(plainRecord.costUsd).toBeCloseTo(tokensUsd, 10);

    // Unmetered calls are charged both worst cases: a lost round, an answer without usage, and a
    // stream that fails while being read.
    const lost = fakeBedrock((command) => {
      if (command === 'ConverseStreamCommand') {
        return { stopReason: 'tool_use', usage: { inputTokens: 0, outputTokens: 10 } };
      }
      throw named('TimeoutError', 'socket hang up');
    });
    const lostBudget = createBudget();
    const lostRecord = await runOne(run('P'), { ...depsFor(lost.send, GUARDRAIL, lostBudget), capture: LONG_CAPTURE });
    const [firstSent, loopSent] = lost.sent;
    const lostUsd =
      turnCost(REPLAY_MODEL_ID, 0, 10, 0, 0) +
      guardrailUsd(charsOf(firstSent.input), 10) +
      worstOf(loopSent.input) +
      guardrailUsd(charsOf(loopSent.input), 8192);
    expect(lostRecord.costUsd).toBeCloseTo(lostUsd, 10);
    expect(lostBudget.spentUsd()).toBeCloseTo(lostUsd, 10);
    const silent = fakeBedrock(() => ({ stopReason: 'end_turn', text: 'done', usage: null }));
    const silentBudget = createBudget();
    const silentRecord = await runOne(run('S'), {
      ...depsFor(silent.send, GUARDRAIL, silentBudget),
      capture: LONG_CAPTURE,
    });
    const silentInput = silent.sent[0].input;
    const silentUsd = worstOf(silentInput) + guardrailUsd(charsOf(silentInput), 1024);
    expect(silentRecord.costUsd).toBeCloseTo(silentUsd, 10);
    expect(silentBudget.spentUsd()).toBeCloseTo(silentUsd, 10);
    const broken = fakeBedrock(() => ({
      stopReason: 'end_turn',
      text: 'partial',
      streamError: 'ModelStreamErrorException',
    }));
    const brokenBudget = createBudget();
    const brokenRecord = await runOne(run('U'), {
      ...depsFor(broken.send, GUARDRAIL, brokenBudget),
      capture: LONG_CAPTURE,
    });
    const brokenInput = broken.sent[0].input;
    const brokenUsd = worstOf(brokenInput) + guardrailUsd(charsOf(brokenInput), 32_000);
    expect(brokenRecord.costUsd).toBeCloseTo(brokenUsd, 10);
    expect(brokenBudget.spentUsd()).toBeCloseTo(brokenUsd, 10);

    // A metered non-streamed round after a streamed tool call: each call carries units for its own size.
    const rounds = fakeBedrock((command) =>
      command === 'ConverseStreamCommand'
        ? { stopReason: 'tool_use', usage: { inputTokens: 50, outputTokens: 30 } }
        : { stopReason: 'end_turn', text: 'Here you go.', usage: { inputTokens: 70, outputTokens: 1500 } },
    );
    const roundsBudget = createBudget();
    const roundsRecord = await runOne(run('P'), {
      ...depsFor(rounds.send, GUARDRAIL, roundsBudget),
      capture: LONG_CAPTURE,
    });
    const [streamedSent, roundSent] = rounds.sent;
    const roundsUsd =
      turnCost(REPLAY_MODEL_ID, 50, 30, 0, 0) +
      guardrailUsd(charsOf(streamedSent.input), 30) +
      turnCost(REPLAY_MODEL_ID, 70, 1500, 0, 0) +
      guardrailUsd(charsOf(roundSent.input), 1500);
    expect(roundsRecord.status).toBe('ok');
    expect(rounds.sent.map((s) => s.command)).toEqual(['ConverseStreamCommand', 'ConverseCommand']);
    expect(roundsRecord.costUsd).toBeCloseTo(roundsUsd, 10);
    expect(roundsBudget.spentUsd()).toBeCloseTo(roundsUsd, 10);

    // Admission reserves the whole guardrail worst case, before the first attempt and before a retry:
    // a cap a hair short of it refuses.
    const chars = JSON.stringify(buildFirstRequest(LONG_CAPTURE, PROMPT.text, 'U', GUARDRAIL)).length;
    const modelWorst = worstCaseCallUsd(chars, 32_000);
    const refused = fakeBedrock(() => ({ stopReason: 'end_turn', text: 'x' }));
    const refusedRecord = await runOne(run('U'), {
      ...depsFor(refused.send, GUARDRAIL, createBudget(modelWorst + guardrailUsd(chars, 32_000) - 1e-9)),
      capture: LONG_CAPTURE,
    });
    expect(refusedRecord.status).toBe('budget_exhausted');
    expect(refused.send).not.toHaveBeenCalled();
    const admitted = fakeBedrock(() => ({ stopReason: 'end_turn', text: 'x' }));
    const room = createBudget(modelWorst + guardrailUsd(chars, 32_000) + 1e-9);
    const admittedRecord = await runOne(run('U'), { ...depsFor(admitted.send, GUARDRAIL, room), capture: LONG_CAPTURE });
    expect(admittedRecord.status).toBe('ok');
    const retryChars = JSON.stringify(buildFirstRequest(LONG_CAPTURE, PROMPT.text, 'S', GUARDRAIL)).length;
    const retryWorst = worstCaseCallUsd(retryChars, 1024) + guardrailUsd(retryChars, 1024);
    const tight = createBudget(retryWorst * 2 - 1e-9);
    const timeouts = fakeBedrock(() => {
      throw named('ModelTimeoutException');
    });
    const tightRecord = await runOne(run('S'), { ...depsFor(timeouts.send, GUARDRAIL, tight), capture: LONG_CAPTURE });
    expect(tightRecord.status).toBe('budget_exhausted');
    expect(timeouts.sent).toHaveLength(1);
    expect(tight.spentUsd()).toBeCloseTo(retryWorst, 10);
  });

  it('R13 a credential error stops the campaign, and any other error does not', async () => {
    // Detection goes by the error's name, never its text: the other errors below mention tokens and credentials.
    const failCalls = (name: string, failing: number[], message = `${name} from the fake`) => {
      let calls = 0;
      return fakeBedrock(() => {
        calls++;
        if (failing.includes(calls)) throw named(name, message);
        return { stopReason: 'end_turn', text: 'done' };
      });
    };
    for (const name of [
      'CredentialsProviderError',
      'TokenProviderError',
      'ExpiredTokenException',
      'UnrecognizedClientException',
      'InvalidSignatureException',
      'AccessDeniedException',
    ]) {
      const { send } = failCalls(name, [2]);
      const outFile = tmpFile('credentials.jsonl');
      const summary = await runCampaign({
        capture: CAPTURE,
        prompts: FIVE_PROMPTS,
        guardrail: null,
        send,
        outFile,
        repoRoot: REPO_ROOT,
        sleep: noSleep,
      });
      expect(summary.records, name).toHaveLength(2);
      expect(summary.records.map((r) => r.status), name).toEqual(['ok', 'error']);
      expect(summary.records[1].error, name).toMatch(new RegExp(`^${name}:`));
      expect(summary, name).toMatchObject({ stoppedForCredentials: true, stoppedForBudget: false });
      expect(send, name).toHaveBeenCalledTimes(2);
      const lines = readFileSync(outFile, 'utf8').trim().split('\n');
      expect(lines, name).toHaveLength(2);
      // The stopping run is written in full before the stop: its JSONL line and its artifacts.
      expect(JSON.parse(lines[1]), name).toEqual(JSON.parse(JSON.stringify(summary.records[1])));
      const reply = join(dirname(outFile), 'credentials-artifacts', summary.records[1].runId, 'reply.txt');
      expect(existsSync(reply), name).toBe(true);
    }

    // Other failures leave the campaign running: rejections, charged failures, and a throttle that
    // outlasts its retries, even when their messages mention tokens or credentials.
    const credentialSounding = 'The security token or credentials included in the request are invalid.';
    for (const [name, failing] of [
      ['ValidationException', [2]],
      ['ResourceNotFoundException', [2]],
      ['ServiceQuotaExceededException', [2]],
      ['InternalServerException', [2]],
      ['ThrottlingException', [2, 3, 4]],
    ] as const) {
      const { send } = failCalls(name, [...failing], credentialSounding);
      const summary = await runCampaign({
        capture: CAPTURE,
        prompts: [PROMPT],
        guardrail: null,
        send,
        outFile: tmpFile('other-error.jsonl'),
        repoRoot: REPO_ROOT,
        reps: 1,
        sleep: noSleep,
      });
      expect(summary.records.map((r) => r.status), name).toEqual(['ok', 'error', 'ok']);
      expect(summary, name).toMatchObject({ stoppedForCredentials: false, stoppedForBudget: false });
    }

    // A budget stop is not a credential stop.
    const broke = await runCampaign({
      capture: CAPTURE,
      prompts: [PROMPT],
      guardrail: null,
      send: fakeBedrock(() => ({ stopReason: 'end_turn', text: 'x' })).send,
      outFile: tmpFile('budget-stop.jsonl'),
      repoRoot: REPO_ROOT,
      reps: 1,
      capUsd: 0,
      sleep: noSleep,
    });
    expect(broke).toMatchObject({ stoppedForBudget: true, stoppedForCredentials: false });
  });
});

describe('prompts contract (E1)', () => {
  it('P1 five prompts in plan order, each asking for its deliverable', () => {
    const prompts = buildPrompts();
    expect(prompts.map((p) => p.id)).toEqual([...PROMPT_IDS]);
    const [p1, p2, p3, p4, p5] = prompts;
    expect(p1).toMatchObject({ expects: 'pdf', standIn: true });
    expect(p1.text).toMatch(/SWOT/);
    expect(p1.text).toMatch(/PDF/);
    expect(p2.expects).toBe('pptx');
    expect(p2.text).toMatch(/\b10\b/);
    expect(p2.text).toMatch(/slide/i);
    expect(p3.expects).toBe('xlsx');
    expect(p3.text).toContain(csvFixture());
    expect(p4.expects).toBe('text');
    expect(p4.text).toContain(sourceText().text);
    expect(p4.text).toMatch(/2,000/);
    expect(p5.expects).toBe('docx');
    expect(p5.text).toMatch(/table/i);
  });

  it('P2 fixtures are deterministic and well formed', () => {
    const csv = csvFixture();
    expect(csvFixture()).toBe(csv);
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(201);
    expect(lines[0]).toBe(CSV_HEADER);
    for (const line of lines.slice(1)) {
      const cells = line.split(',');
      expect(cells).toHaveLength(7);
      expect(Number(cells[6])).toBeCloseTo(Math.round(Number(cells[4]) * Number(cells[5]) * 100) / 100, 2);
    }

    const source = sourceText();
    expect(sourceText().sha256).toBe(source.sha256);
    expect(source.sha256).toBe(createHash('sha256').update(source.text).digest('hex'));
    expect(source.words).toBeGreaterThanOrEqual(6000);
    expect(source.words).toBeLessThanOrEqual(6600);
    expect(source.text.trim().split(/\s+/)).toHaveLength(source.words);
  });

  it('P3 export writes the exact texts for System A, and never into the repository', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prompts-diag-'));
    const files = exportPrompts(dir, REPO_ROOT);
    const prompts = buildPrompts();
    expect(files).toHaveLength(5);
    prompts.forEach((p, i) => {
      expect(files[i]).toBe(join(dir, `${p.id}.txt`));
      expect(readFileSync(files[i], 'utf8')).toBe(p.text);
    });
    expect(() => exportPrompts(join(REPO_ROOT, 'prompts-out'), REPO_ROOT)).toThrow(/inside the repository/);
  });
});
