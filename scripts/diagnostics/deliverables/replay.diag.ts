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
import { join } from 'node:path';
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
  type CaptureFile,
  type PlannedRun,
  type ProfileId,
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
const tmpFile = (name: string): string => join(mkdtempSync(join(tmpdir(), 'replay-diag-')), name);

interface Step {
  stopReason: string;
  text?: string;
  toolUses?: { name: string; input: unknown }[];
  usage?: { inputTokens: number; outputTokens: number };
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
    const usage = step.usage ?? { inputTokens: 0, outputTokens: 50 };
    if (name === 'ConverseStreamCommand') {
      return {
        stream: (async function* () {
          if (step.text) yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text: step.text } } };
          yield { messageStop: { stopReason: step.stopReason } };
          yield { metadata: { usage } };
        })(),
      };
    }
    const content = [
      ...(step.text ? [{ text: step.text }] : []),
      ...(step.toolUses ?? []).map((t, i) => ({
        toolUse: { toolUseId: `tu-${i + 1}`, name: t.name, input: t.input },
      })),
    ];
    return { stopReason: step.stopReason, usage, output: { message: { role: 'assistant', content } } };
  });
  return { send, sent };
}

const scripted = (steps: Step[]) => () => steps.shift() ?? { stopReason: 'end_turn', text: 'done' };
const maxTokensOf = (input: Record<string, unknown>): number =>
  (input.inferenceConfig as { maxTokens: number }).maxTokens;
const endsWithToolResult = (input: Record<string, unknown>): boolean =>
  Boolean((input.messages as Msg[]).at(-1)?.content.some((b) => 'toolResult' in b));

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
