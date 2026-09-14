/**
 * Deliverables parity, step 1: capture the exact Bedrock request that the REAL
 * agent loop builds, without reaching AWS.
 *
 * E1 varies only the output budget, so the replay must hold everything else
 * byte-identical to what production sends: system prompt, tool specs, cache
 * points, guardrail. Reading the code gives the shape of that request; only
 * running `runAgentTurn` gives its bytes and sizes.
 *
 * - Stores are mocked (the `agent-loop.board-scope.test.ts` set). The Bedrock
 *   client, the tool registry and the agent loader are real.
 * - Tools register exactly the way this tree's own `src/server.ts` registers
 *   them, so the tool list follows the checked-out tree.
 * - `BedrockRuntimeClient.prototype.send` is spied: each command's input is
 *   cloned at send time and a scripted reply comes back. The dead endpoint and
 *   placeholder credentials in `vitest.diag.config.ts` are the backstop.
 *
 * The gate: the first call's `inferenceConfig.maxTokens` is 8192 when this tree
 * carries 1abba67 (production) and 1024 when it does not (development before the
 * back-merge). Every tool-loop call is 8192 on both trees.
 *
 * Output: `<DIAG_OUT_DIR>/capture-<sha>.json`, default
 * `<os tmpdir>/netzer-deliverables-diag`. It holds the agent's system prompt, so
 * it is refused inside the repository and never committed.
 *
 *   npx vitest run --config scripts/diagnostics/deliverables/vitest.diag.config.ts
 *
 * Optional: DIAG_AGENT_ID (default `main`); DIAG_AGENT_PROMPT_FILE, a local copy
 * of `agents/<id>/CLAUDE.md` from the config bucket. Without it the loader falls
 * back to its built-in prompt, and the capture says so.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { S3Client } from '@aws-sdk/client-s3';

vi.hoisted(() => {
  for (const name of [
    'AWS_PROFILE',
    'AWS_DEFAULT_PROFILE',
    'AWS_SESSION_TOKEN',
    // No fallback chain: with these unset, buildFallbackChain returns [primary].
    'BEDROCK_OPUS_MODEL',
    'BEDROCK_SONNET_MODEL',
    'BEDROCK_HAIKU_MODEL',
  ]) {
    delete process.env[name];
  }
  process.env.BEDROCK_DEFAULT_MODEL = 'us.anthropic.claude-sonnet-4-6';
  // Set so the loader takes its real S3 path; the S3 spy below answers it.
  process.env.CONFIG_BUCKET = 'diag-config';
  // Registers generate_document. The other add-on gates stay unset on purpose.
  process.env.RAW_BUCKET = 'diag-raw';
  // Shape only. The replay must substitute production's real guardrail.
  process.env.BEDROCK_GUARDRAIL_ID = 'diag-guardrail-placeholder';
  process.env.BEDROCK_GUARDRAIL_VERSION = 'DRAFT';
  process.env.LOG_LEVEL = 'silent';
});

vi.mock('../../../src/lib/state/kill-switches-repo.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isKillSwitchActive: vi.fn(async () => ({ active: false })),
}));
vi.mock('../../../src/lib/memory/context-builder.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  buildMemoryContext: vi.fn(async () => ({
    text: '',
    layerCounts: { memories: 0, consolidations: 0, semantic: 0 },
  })),
}));
vi.mock('../../../src/lib/state/inter-agent-tasks-repo.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listInbox: vi.fn(async () => []),
  markStatus: vi.fn(async () => {}),
}));
vi.mock('../../../src/lib/state/hive-mind-repo.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recentHive: vi.fn(async () => []),
}));
vi.mock('../../../src/lib/audit/audit-writer.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  writeAudit: vi.fn(async () => {}),
}));
vi.mock('../../../src/lib/usage/token-tracker.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordUsage: vi.fn(async () => {}),
  getDailyCostUsd: vi.fn(async () => 0),
}));
vi.mock('../../../src/lib/state/cost-cap-repo.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getEffectiveCostCap: vi.fn(async () => 50),
  isCostCapEnforced: vi.fn(async () => false),
}));
vi.mock('../../../src/lib/state/rate-limits-repo.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkAndConsume: vi.fn(async () => ({ allowed: true, remaining: 9, resetAt: 0 })),
}));
vi.mock('../../../src/lib/safety/exfil-guard.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  scanForExfil: vi.fn(async () => ({ matches: [] })),
  redactMatches: (t: string) => t,
  getActivePatterns: vi.fn(async () => []),
  buildStreamingRedactor: vi.fn(async () => (t: string) => t),
}));
vi.mock('../../../src/lib/state/runtime-config-repo.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getConfig: vi.fn(async () => undefined),
}));
vi.mock('../../../src/lib/cost/ledger-gate.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  admitTurnSpend: vi.fn(async () => ({
    admitted: true,
    finalize: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
  })),
}));
vi.mock('../../../src/lib/state/panic-state-repo.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  tryAcquirePanic: vi.fn(),
}));
vi.mock('../../../src/lib/mcp/mcp-tools.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  mcpToolsFor: vi.fn(async () => []),
  isMcpToolName: () => false,
  invokeMcpTool: vi.fn(),
}));
vi.mock('../../../src/lib/state/agents-repo.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAgent: vi.fn(async () => undefined),
  listAgents: vi.fn(async () => []),
}));

import { runAgentTurn } from '../../../src/agent/agent-loop.js';
import { tools } from '../../../src/lib/tools/registry.js';

const MODEL_ID = 'us.anthropic.claude-sonnet-4-6';
const FIRST_CALL_CAP_COMMIT = '1abba67';
const TOOL_LOOP_MAX_TOKENS = 8192;
const AGENT_ID = process.env.DIAG_AGENT_ID || 'main';
const PROMPT_FILE = process.env.DIAG_AGENT_PROMPT_FILE;
// A stand-in: the incident's exact wording is not in the repository. The replay
// swaps the user message, so only its size here depends on this text.
const USER_TEXT = 'Create a SWOT analysis report as a PDF.';
const TOOL_INPUT = {
  format: 'pdf',
  spec: { title: 'SWOT', sections: [{ heading: 'Strengths', body: 'Placeholder.' }] },
};

interface Block {
  text?: string;
  cachePoint?: unknown;
  toolSpec?: { name?: string };
}
interface RequestInput {
  modelId?: string;
  system?: Block[];
  messages?: { role: string; content: unknown[] }[];
  inferenceConfig?: { maxTokens?: number; temperature?: number };
  toolConfig?: { tools?: Block[] };
  guardrailConfig?: unknown;
}
interface Captured {
  command: string;
  input: RequestInput;
}

const git = (...args: string[]): string => execFileSync('git', args, { encoding: 'utf8' }).trim();

/** True when HEAD carries the first-call output cap. A missing object throws. */
function carriesFirstCallCap(): boolean {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', FIRST_CALL_CAP_COMMIT, 'HEAD'], {
      stdio: 'ignore',
    });
    return true;
  } catch (err) {
    if ((err as { status?: number }).status === 1) return false;
    throw err;
  }
}

function outDir(): string {
  const dir = resolve(process.env.DIAG_OUT_DIR || join(tmpdir(), 'netzer-deliverables-diag'));
  const rel = relative(resolve(git('rev-parse', '--show-toplevel')), dir);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    throw new Error(
      `DIAG_OUT_DIR ${dir} is inside the repository. A capture holds the agent prompt; write it elsewhere.`,
    );
  }
  return dir;
}

function sizesOf(input: RequestInput) {
  const system = input.system ?? [];
  const toolBlocks = input.toolConfig?.tools ?? [];
  const specs = toolBlocks.filter((b) => b.toolSpec);
  const messages = input.messages ?? [];
  return {
    requestChars: JSON.stringify(input).length,
    systemChars: system.reduce((n, b) => n + (b.text?.length ?? 0), 0),
    toolCount: specs.length,
    toolsChars: JSON.stringify(specs).length,
    perTool: specs
      .map((b) => ({ name: b.toolSpec?.name ?? '', chars: JSON.stringify(b).length }))
      .sort((a, b) => b.chars - a.chars),
    historyChars: JSON.stringify(messages.slice(0, -1)).length,
    lastMessageChars: JSON.stringify(messages.at(-1)?.content ?? []).length,
    cachePoints: [...system, ...toolBlocks].filter((b) => b.cachePoint).length,
    guardrail: Boolean(input.guardrailConfig),
    inferenceConfig: input.inferenceConfig,
  };
}

const toolNames = (input: RequestInput): string[] =>
  (input.toolConfig?.tools ?? []).flatMap((b) => (b.toolSpec?.name ? [b.toolSpec.name] : []));

/** Register tools the way src/server.ts does on this tree, and return the modules. */
async function registerToolsLikeServer(): Promise<string[]> {
  const server = readFileSync(new URL('../../../src/server.ts', import.meta.url), 'utf8');
  const modules = [...server.matchAll(/^import '\.\/lib\/tools\/([\w-]+)\.js';/gm)].map((m) => m[1]);
  // @vite-ignore: Vite's dynamic-import-vars globs `*.js`, which matches no
  // TypeScript source. Resolved at run time instead, like a static import.
  for (const name of modules) await import(/* @vite-ignore */ `../../../src/lib/tools/${name}.js`);
  return modules;
}

function streamReply(stopReason: string, text: string) {
  return {
    $metadata: {},
    stream: (async function* () {
      if (text) yield { contentBlockDelta: { contentBlockIndex: 0, delta: { text } } };
      yield { messageStop: { stopReason } };
      yield { metadata: { usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } } };
    })(),
  };
}

function converseReply(stopReason: string, content: unknown[]) {
  return {
    $metadata: {},
    stopReason,
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    output: { message: { role: 'assistant', content } },
  };
}

const calls: Captured[] = [];
let script: unknown[] = [];
let toolModules: string[] = [];
const capture: Record<string, unknown> = {};

const request = () => ({
  agentId: AGENT_ID,
  chatId: 'diag-capture',
  userText: USER_TEXT,
  history: [],
  surface: 'dashboard' as const,
});

beforeAll(async () => {
  toolModules = await registerToolsLikeServer();

  vi.spyOn(BedrockRuntimeClient.prototype, 'send').mockImplementation((async (command: {
    constructor: { name: string };
    input: unknown;
  }) => {
    calls.push({ command: command.constructor.name, input: JSON.parse(JSON.stringify(command.input)) });
    if (script.length === 0) {
      throw new Error(`capture: unscripted Bedrock call #${calls.length} (${command.constructor.name})`);
    }
    return script.shift();
  }) as never);

  // The loader's S3 path. CLAUDE.md comes from DIAG_AGENT_PROMPT_FILE when set;
  // everything else is NoSuchKey, which the loader treats as "not configured".
  vi.spyOn(S3Client.prototype, 'send').mockImplementation((async (command: {
    constructor: { name: string };
    input: { Key?: string };
  }) => {
    if (command.constructor.name !== 'GetObjectCommand') {
      throw new Error(`capture: unexpected S3 ${command.constructor.name}`);
    }
    if (PROMPT_FILE && command.input.Key === `agents/${AGENT_ID}/CLAUDE.md`) {
      const text = readFileSync(PROMPT_FILE, 'utf8');
      return { Body: { transformToString: async () => text } };
    }
    throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
  }) as never);

  vi.spyOn(tools, 'invoke').mockResolvedValue({ text: 'PDF generated: SWOT.pdf (1,024 bytes).' });
});

beforeEach(() => {
  calls.length = 0;
  script = [];
});

afterAll(() => {
  if (!capture.firstCall) return;
  const headSha = git('rev-parse', 'HEAD');
  const file = join(outDir(), `capture-${headSha.slice(0, 12)}.json`);
  mkdirSync(outDir(), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify(
      {
        schema: 'deliverables-capture/1',
        headSha,
        agentLoopSha: git('log', '-1', '--format=%H', '--', 'src/agent/agent-loop.ts'),
        capturedAt: new Date().toISOString(),
        agentId: AGENT_ID,
        agentPromptSource: PROMPT_FILE ? `file:${basename(PROMPT_FILE)}` : 'builtin-default',
        toolModules,
        guardrailPlaceholder: process.env.BEDROCK_GUARDRAIL_ID,
        ...capture,
      },
      null,
      2,
    ),
  );
  console.log(`capture written: ${file}`);
});

describe('deliverables capture: the real request, off the wire', () => {
  it('first call: the output ceiling this tree actually sends', async () => {
    script = [streamReply('end_turn', 'Here is your SWOT analysis.')];

    await runAgentTurn(request());

    expect(calls.map((c) => c.command)).toEqual(['ConverseStreamCommand']);
    const first = calls[0].input;
    expect(first.modelId).toBe(MODEL_ID);
    expect(toolNames(first), 'tools did not register the way server.ts does').toContain(
      'generate_document',
    );
    expect(first.inferenceConfig?.maxTokens).toBe(carriesFirstCallCap() ? 8192 : 1024);

    capture.expectedFirstCallMaxTokens = carriesFirstCallCap() ? 8192 : 1024;
    capture.firstCall = { command: calls[0].command, input: first, sizes: sizesOf(first) };
  });

  it('tool loop: every round keeps the 8192 ceiling', async () => {
    script = [
      streamReply('tool_use', ''),
      converseReply('tool_use', [
        { toolUse: { toolUseId: 'tu-1', name: 'generate_document', input: TOOL_INPUT } },
      ]),
      converseReply('end_turn', [{ text: 'Your PDF is attached.' }]),
    ];

    await runAgentTurn(request());

    expect(calls.map((c) => c.command)).toEqual([
      'ConverseStreamCommand',
      'ConverseCommand',
      'ConverseCommand',
    ]);
    for (const loop of calls.slice(1)) {
      expect(loop.input.modelId).toBe(MODEL_ID);
      expect(loop.input.inferenceConfig?.maxTokens).toBe(TOOL_LOOP_MAX_TOKENS);
    }
    expect(tools.invoke).toHaveBeenCalledWith('generate_document', TOOL_INPUT, expect.anything());

    capture.toolLoopCalls = calls
      .slice(1)
      .map((c) => ({ command: c.command, input: c.input, sizes: sizesOf(c.input) }));
  });
});
