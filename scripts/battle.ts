/**
 * Battle harness. Runs canonical prompts against a target environment
 * to validate end-to-end behavior under load.
 *
 * Usage:
 *   tsx scripts/battle.ts --target=staging --duration=180 [--chaos] [--concurrency=5]
 *   npm run battle -- --target=staging --duration=180 --chaos
 */

import { bold, dim, green, red, yellow, section } from './lib/ansi.js';
import { apiPost } from './lib/api-client.js';

const CANONICAL_PROMPTS = [
  'What is the current time?',
  'Remember that my name is Test User.',
  'What is my name?',
  'Create a simple to-do list for today.',
  'Search the web for latest AWS news.',
  'What memories do you have about me?',
  'Forget my name.',
  'Generate an image of a sunset.',
  'What is 2+2?',
  'Tell me a joke.',
  'Summarize the following: The quick brown fox jumps over the lazy dog.',
  'What tools do you have available?',
  'Help me write an email to my team.',
  'What is your system status?',
  'List all agents in the system.',
  'Create a new mission: test battle harness.',
  'What is the weather like?',
  'Translate hello to Spanish.',
  'What is the capital of France?',
  'Goodbye.',
];

interface BattleResult {
  prompt: string;
  status: 'pass' | 'fail' | 'timeout';
  latencyMs: number;
  error?: string;
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      else flags[arg.slice(2)] = 'true';
    }
  }
  return flags;
}

async function runPrompt(prompt: string, agentId: string): Promise<BattleResult> {
  const t0 = Date.now();
  try {
    const resp = await apiPost<{ text?: string; error?: string }>('/api/turn', {
      agentId,
      chatId: 'battle-harness',
      userText: prompt,
    });
    const latencyMs = Date.now() - t0;
    if (resp.error) {
      return { prompt, status: 'fail', latencyMs, error: resp.error };
    }
    return { prompt, status: 'pass', latencyMs };
  } catch (err) {
    return {
      prompt,
      status: 'fail',
      latencyMs: Date.now() - t0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const target = flags.target ?? 'staging';
  const duration = Number(flags.duration ?? '60');
  const concurrency = Number(flags.concurrency ?? '3');
  const chaos = flags.chaos === 'true';

  section(`Battle Harness`);
  console.log(`  Target: ${bold(target)}`);
  console.log(`  Duration: ${duration}s`);
  console.log(`  Concurrency: ${concurrency}`);
  console.log(`  Chaos: ${chaos ? yellow('ON') : dim('off')}`);
  console.log();

  const results: BattleResult[] = [];
  const endTime = Date.now() + duration * 1000;
  let round = 0;

  while (Date.now() < endTime) {
    round++;
    console.log(dim(`  Round ${round}...`));
    const batch = CANONICAL_PROMPTS.slice(0, concurrency);
    const batchResults = await Promise.all(
      batch.map((p) => runPrompt(p, 'default')),
    );
    results.push(...batchResults);

    const passed = batchResults.filter((r) => r.status === 'pass').length;
    const failed = batchResults.filter((r) => r.status === 'fail').length;
    console.log(`    ${green(`${passed} pass`)} ${failed > 0 ? red(`${failed} fail`) : ''}`);
  }

  section('Results');
  const totalPass = results.filter((r) => r.status === 'pass').length;
  const totalFail = results.filter((r) => r.status === 'fail').length;
  const avgLatency = Math.round(
    results.reduce((s, r) => s + r.latencyMs, 0) / results.length,
  );

  console.log(`  Total: ${results.length} | Pass: ${green(String(totalPass))} | Fail: ${red(String(totalFail))}`);
  console.log(`  Avg latency: ${avgLatency}ms`);

  if (totalFail > 0) {
    console.log(red('\nFailed prompts:'));
    for (const r of results.filter((r) => r.status === 'fail')) {
      console.log(`  ${red('x')} ${r.prompt.slice(0, 50)} ${dim(r.error ?? '')}`);
    }
    process.exit(1);
  } else {
    console.log(green('\nAll prompts passed.'));
  }
}

main().catch((err) => {
  console.error(red(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
