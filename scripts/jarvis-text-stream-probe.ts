/**
 * Live end-to-end probe for the STREAMING Jarvis text turn.
 *
 * Drives the REAL buildJarvisRouter() POST /text-turn against REAL Bedrock
 * (ConverseStreamCommand) using the root DASHBOARD_TOKEN, and reports:
 *   - time-to-first transcript frame (the streaming latency win),
 *   - the count of incremental partials (final:false) + that they grow,
 *   - the single final:true transcript,
 *   - any tool_call / error / done frames.
 *
 * It reads prod admission tables (kill switch / canary / cost cap) read-only and
 * writes the usual jarvis usage + audit rows; it makes a real (small, ~cents)
 * Bedrock call. It does NOT start the server, schedulers, or the SQS listener.
 *
 * Run with creds + env:
 *   node --env-file=.env node_modules/.bin/tsx scripts/jarvis-text-stream-probe.ts
 */

import { buildJarvisRouter } from '../src/adapters/dashboard/jarvis.js';
import { bold, dim, green, red, yellow, section } from './lib/ansi.js';

const token = process.env.DASHBOARD_TOKEN ?? '';
if (!token || token === 'REPLACE_ME') {
  // eslint-disable-next-line no-console
  console.error(red('DASHBOARD_TOKEN missing — run with `node --env-file=.env tsx ...`'));
  process.exit(1);
}

interface Frame {
  event: string;
  data: string;
  atMs: number;
}

async function runTurn(prompt: string): Promise<void> {
  section(`PROMPT: ${prompt}`);
  const router = buildJarvisRouter();
  const t0 = Date.now();
  const res = await router.request(
    new Request('http://local/text-turn', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ text: prompt }),
    }),
  );

  // eslint-disable-next-line no-console
  console.log(dim(`HTTP ${res.status} after ${Date.now() - t0}ms`));
  if (res.status !== 200 || !res.body) {
    // eslint-disable-next-line no-console
    console.log(red(`non-streaming response: ${await res.text()}`));
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const frames: Frame[] = [];
  let firstTranscriptMs = -1;
  let partials = 0;
  let lastPartialLen = 0;
  let growing = true;
  let finalText = '';
  const toolCalls: string[] = [];

  const handle = (raw: string): void => {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of raw.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    const data = dataLines.join('\n');
    if (!data && event === 'message') return;
    frames.push({ event, data, atMs: Date.now() - t0 });

    if (event === 'transcript') {
      try {
        const t = JSON.parse(data) as { text: string; final?: boolean };
        if (t.final === false) {
          if (firstTranscriptMs < 0) firstTranscriptMs = Date.now() - t0;
          partials += 1;
          if (t.text.length < lastPartialLen) growing = false;
          lastPartialLen = t.text.length;
        } else {
          finalText = t.text;
        }
      } catch {
        /* ignore */
      }
    } else if (event === 'tool_call') {
      try {
        const tc = JSON.parse(data) as { toolName: string; input?: Record<string, unknown> };
        toolCalls.push(`${tc.toolName}(${JSON.stringify(tc.input ?? {})})`);
      } catch {
        /* ignore */
      }
    } else if (event === 'error') {
      // eslint-disable-next-line no-console
      console.log(red(`  error frame: ${data}`));
    }
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      handle(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
    }
  }

  const totalMs = Date.now() - t0;
  // eslint-disable-next-line no-console
  console.log(
    [
      `  ${bold('frames')}: ${frames.length}`,
      `  ${bold('time-to-first-transcript')}: ${firstTranscriptMs < 0 ? yellow('none') : green(`${firstTranscriptMs}ms`)}`,
      `  ${bold('partials (final:false)')}: ${partials} ${growing ? green('(cumulative ✓)') : red('(NOT growing ✗)')}`,
      `  ${bold('tool_calls')}: ${toolCalls.length ? toolCalls.join(', ') : dim('none')}`,
      `  ${bold('final')}: ${finalText ? green(JSON.stringify(finalText)) : yellow('(empty)')}`,
      `  ${bold('total')}: ${totalMs}ms`,
    ].join('\n'),
  );

  // Assertions for a healthy streaming turn (text turns only).
  if (finalText && partials < 2) {
    // eslint-disable-next-line no-console
    console.log(yellow('  ⚠ expected ≥2 partials for a streamed reply — was it a one-chunk response?'));
  }
}

async function main(): Promise<void> {
  await runTurn('In one short sentence, greet me, sir.');
  await runTurn('Take me to the agents page.');
  // eslint-disable-next-line no-console
  console.log('\n' + green(bold('streaming text-turn probe complete')));
  process.exit(0);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(red(`probe failed: ${err instanceof Error ? err.stack : String(err)}`));
  process.exit(1);
});
