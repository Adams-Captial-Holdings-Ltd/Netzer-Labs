/**
 * Definitive test for the voice switch: feed a REAL spoken user turn (Polly
 * synthesizes it to 16kHz PCM) into a live Nova 2 Sonic session via the REAL
 * createNovaSonicSession, and confirm Nova replies with NATIVE audioOutput — the
 * audio the relay now forwards straight to the browser (no Polly on the reply).
 *
 * Billed (~$0.02). Run: node --env-file=.env tsx scripts/jarvis-nova-speech-probe.ts
 */
import { createNovaSonicSession } from '../src/lib/voice/nova-sonic.js';
import { synthesize } from '../src/lib/polly/synth.js';
import { bold, dim, green, red, yellow, section } from './lib/ansi.js';

const region = process.env.AWS_REGION ?? 'us-east-1';
const modelId = process.env.NOVA_SONIC_MODEL ?? 'amazon.nova-2-sonic-v1:0';
const voiceId = process.env.JARVIS_VOICE_ID ?? 'tiffany';

async function main(): Promise<void> {
  section('Nova native-audio reply probe (real speech in → native audio out)');

  // 1. Synthesize a user utterance to 16kHz PCM (what the browser mic would send).
  const utterance = 'Hello Jarvis, can you hear me? Say hello back in one short sentence.';
  const tts = await synthesize({ text: utterance, format: 'pcm', engine: 'neural', voiceId: 'Ruth', languageCode: 'en-US', sampleRate: '16000' });
  console.log(dim(`  synthesized ${tts.bytes.length} bytes of 16kHz PCM for the user turn`));

  let audioFrames = 0;
  let audioBytes = 0;
  let firstAudioMs = -1;
  const t0 = Date.now();
  const assistant: string[] = [];
  const user: string[] = [];
  let errored: string | null = null;

  const session = createNovaSonicSession(
    { modelId, region, systemPrompt: 'You are Jarvis, a warm British butler. Reply in one short spoken sentence.', tools: [], voiceId, maxTokens: 256 },
    {
      onAudioOut: (b64) => { if (firstAudioMs < 0) firstAudioMs = Date.now() - t0; audioFrames++; audioBytes += Math.floor((b64.length * 3) / 4); },
      onTextTranscript: (text, role) => { if (!text) return; (role === 'ASSISTANT' ? assistant : user).push(text); console.log(dim(`  [${role}] ${text}`)); },
      onBargeIn: () => {},
      onToolUse: async () => ({}),
      onError: (err) => { errored = err.message; console.log(red(`  onError: ${err.message}`)); },
      onClose: () => {},
      onUsage: () => {},
    },
  );

  // 2. Push the utterance as ~32ms frames (1024 bytes = 512 samples @16kHz), then a beat of silence.
  const FRAME = 1024;
  for (let off = 0; off < tts.bytes.length; off += FRAME) {
    session.pushAudio(tts.bytes.subarray(off, off + FRAME).toString('base64'));
    await new Promise((r) => setTimeout(r, 20));
  }
  const silence = Buffer.from(new Int16Array(512).buffer).toString('base64');
  for (let i = 0; i < 25; i++) { session.pushAudio(silence); await new Promise((r) => setTimeout(r, 40)); }

  // 3. Give Nova time to reply, then stop.
  await new Promise((r) => setTimeout(r, 8000));
  await session.stop();

  section('RESULT');
  console.log(`  ${bold('native audioOutput')}: ${audioFrames > 0 ? green(`${audioFrames} frames, ~${audioBytes} bytes, first @ ${firstAudioMs}ms`) : red('NONE ✗')}`);
  console.log(`  ${bold('user transcript (ASR)')}: ${user.length ? green(JSON.stringify([...new Set(user)])) : yellow('none')}`);
  console.log(`  ${bold('assistant transcript')}: ${assistant.length ? green(JSON.stringify([...new Set(assistant)])) : yellow('none')}`);
  console.log(`  ${bold('error')}: ${errored ? red(errored) : green('none')}`);
  const ok = audioFrames > 0;
  console.log('\n' + (ok ? green(bold('NATIVE AUDIO CONFIRMED ✓ — the relay can forward this')) : red(bold('NO NATIVE AUDIO ✗'))));
  process.exit(ok ? 0 : 2);
}

main().catch((e) => { console.error(red(e instanceof Error ? (e.stack ?? e.message) : String(e))); process.exit(1); });
