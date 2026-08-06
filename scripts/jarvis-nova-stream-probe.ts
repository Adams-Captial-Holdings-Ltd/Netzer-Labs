/**
 * Jarvis Phase 1 pre-blocker #3 — open ONE live Nova 2 Sonic bidirectional
 * stream and log the RAW event envelope so the SCHEMA-TBD field casing in
 * nova-sonic.ts can be confirmed/corrected against the live model.
 *
 * It sends the documented init sequence + a few frames of silence, then logs:
 *   - every OUTPUT chunk's decoded JSON top-level keys + a small sample, and
 *   - any ValidationException (which reveals a wrong INPUT field name).
 *
 * Billed (a few seconds of a session, ~$0.01). Bounded to ~25s. Run with creds:
 *   tsx scripts/jarvis-nova-stream-probe.ts [--region=us-east-1]
 */

import {
  BedrockRuntimeClient,
  InvokeModelWithBidirectionalStreamCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { NodeHttp2Handler } from '@smithy/node-http-handler';
import { randomUUID } from 'node:crypto';
import { bold, dim, green, red, yellow, section } from './lib/ansi.js';

const region = process.argv.find((a) => a.startsWith('--region='))?.slice(9) ?? 'us-east-1';
const modelId = process.env.NOVA_SONIC_MODEL ?? 'amazon.nova-2-sonic-v1:0';

const enc = new TextEncoder();
const dec = new TextDecoder();
const wrap = (event: Record<string, unknown>) => ({ chunk: { bytes: enc.encode(JSON.stringify({ event })) } });

const promptName = randomUUID();
const sysContent = randomUUID();
const audioContent = randomUUID();

// 512 samples of silence (>=32ms @16kHz), base64.
const silence = Buffer.from(new Int16Array(512).buffer).toString('base64');

async function* input(): AsyncGenerator<{ chunk: { bytes: Uint8Array } }> {
  yield wrap({ sessionStart: { inferenceConfiguration: { maxTokens: 256, topP: 0.9, temperature: 0.7 } } });
  yield wrap({
    promptStart: {
      promptName,
      textOutputConfiguration: { mediaType: 'text/plain' },
      audioOutputConfiguration: { mediaType: 'audio/lpcm', sampleRateHertz: 24000, sampleSizeBits: 16, channelCount: 1, voiceId: 'tiffany', encoding: 'base64', audioType: 'SPEECH' },
      toolUseOutputConfiguration: { mediaType: 'application/json' },
      toolConfiguration: { tools: [] },
    },
  });
  yield wrap({ contentStart: { promptName, contentName: sysContent, type: 'TEXT', role: 'SYSTEM', textInputConfiguration: { mediaType: 'text/plain' } } });
  yield wrap({ textInput: { promptName, contentName: sysContent, content: 'You are a probe. Greet the user in one short sentence.' } });
  yield wrap({ contentEnd: { promptName, contentName: sysContent } });
  yield wrap({ contentStart: { promptName, contentName: audioContent, type: 'AUDIO', role: 'USER', audioInputConfiguration: { mediaType: 'audio/lpcm', sampleRateHertz: 16000, sampleSizeBits: 16, channelCount: 1, audioType: 'SPEECH', encoding: 'base64' } } });
  for (let i = 0; i < 20; i++) {
    yield wrap({ audioInput: { promptName, contentName: audioContent, content: silence } });
    await new Promise((r) => setTimeout(r, 40));
  }
  yield wrap({ contentEnd: { promptName, contentName: audioContent } });
  yield wrap({ promptEnd: { promptName } });
  yield wrap({ sessionEnd: {} });
}

async function main(): Promise<void> {
  section(`Nova 2 Sonic stream probe — ${modelId} @ ${region}`);
  console.log(dim('Opening a live bidirectional stream and logging the raw output event envelope…'));
  console.log('');

  const client = new BedrockRuntimeClient({
    region,
    requestHandler: new NodeHttp2Handler({ requestTimeout: 30_000, sessionTimeout: 30_000 }),
  });

  const seen = new Set<string>();
  let count = 0;
  const deadline = setTimeout(() => {
    console.log(yellow('\n(25s cap reached — closing)'));
    process.exit(0);
  }, 25_000);
  deadline.unref();

  try {
    const resp = await client.send(new InvokeModelWithBidirectionalStreamCommand({ modelId, body: input() }));
    if (!resp.body) {
      console.log(red('No response body.'));
      return;
    }
    for await (const out of resp.body as AsyncIterable<Record<string, unknown> & { chunk?: { bytes?: Uint8Array } }>) {
      const errKey = Object.keys(out).find((k) => k.endsWith('Exception'));
      if (errKey) {
        console.log(red(`STREAM ERROR: ${errKey}`), dim(JSON.stringify((out as Record<string, unknown>)[errKey])));
        continue;
      }
      const bytes = out.chunk?.bytes;
      if (!bytes) continue;
      count++;
      try {
        const parsed = JSON.parse(dec.decode(bytes)) as { event?: Record<string, unknown> };
        const evt = parsed.event ?? (parsed as Record<string, unknown>);
        const key = Object.keys(evt)[0] ?? '(none)';
        if (!seen.has(key)) {
          seen.add(key);
          const sample = JSON.stringify(evt[key]).slice(0, 160);
          console.log(`  ${green('NEW EVENT')} ${bold(key)}  ${dim(sample)}`);
        }
      } catch {
        console.log(dim(`  (unparseable chunk, ${bytes.length}b)`));
      }
    }
    console.log('');
    console.log(green(`Stream closed. ${count} output chunks. Distinct event keys: ${[...seen].join(', ') || '(none)'}`));
    console.log(dim('Compare these keys against nova-sonic.ts dispatch (audioOutput/textOutput/toolUse/contentEnd/completionEnd).'));
  } catch (err) {
    const name = (err as { name?: string }).name ?? '';
    console.log(red(`send failed: ${name}`));
    console.log(dim(err instanceof Error ? err.message : String(err)));
    if (name === 'ValidationException') console.log(yellow('→ an INPUT event field name/casing is wrong; the message above usually names the field.'));
    if (name === 'AccessDeniedException') console.log(yellow('→ missing bedrock:InvokeModel on the bidirectional model ARN.'));
    process.exit(1);
  } finally {
    clearTimeout(deadline);
  }
}

main().catch((e) => {
  console.error(red(e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
