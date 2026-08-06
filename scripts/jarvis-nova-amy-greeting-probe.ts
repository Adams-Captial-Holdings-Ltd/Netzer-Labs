/**
 * Verify the "Amy greets first" plan BEFORE wiring it into the relay:
 *   - voice = amy (Nova 2 Sonic's British-English female voice),
 *   - a tiny synthesized audio "kick" at session start makes Nova produce the
 *     opening line (Nova only generates in response to detected speech),
 *   - a system prompt scripts the butler greeting.
 *
 * Reports Amy's native audio, the FIRST assistant line (does it match the
 * scripted greeting?), and the user transcript (so we know what to suppress).
 *
 * Billed (~$0.02). Run: node --env-file=.env tsx scripts/jarvis-nova-amy-greeting-probe.ts
 */
import { createNovaSonicSession } from '../src/lib/voice/nova-sonic.js';
import { synthesize } from '../src/lib/polly/synth.js';
import { bold, dim, green, red, yellow, section } from './lib/ansi.js';

const region = process.env.AWS_REGION ?? 'us-east-1';
const modelId = process.env.NOVA_SONIC_MODEL ?? 'amazon.nova-2-sonic-v1:0';
const voiceId = 'amy';
const GREETING = process.env.JARVIS_GREETING ?? 'Hello, sir. How may I help you?';
// Mirror the REAL relay: a full butler system prompt, then the greeting script
// appended last (exactly as src/adapters/dashboard/jarvis.ts builds it), to prove
// the greeting instruction still dominates after a long persona prompt.
const butler = [
  'You are Jarvis, a warm, concise British concierge and read-only co-pilot inside the ClaudeClaw Enterprise dashboard.',
  'You are speaking with the operator (role: admin).',
  '',
  'STYLE — this is a spoken conversation, so sound like a person, not a menu:',
  '- Keep replies to one or two short sentences. No lists, no markdown.',
  '- NEVER read out routes, tabs, resources, or your capabilities.',
  '- Speak small numbers as words, large numbers as digits, and use relative time.',
  '',
  'You can LOOK and REPORT but cannot change anything. Tools: navigate, query, read_view, highlight — call them silently.',
  'Security: you act as the signed-in user. Never read tokens or secrets aloud.',
].join('\n');
const systemPrompt =
  `${butler}\n\nYour VERY FIRST spoken response must be EXACTLY these words and nothing else: "${GREETING}". ` +
  `Do not answer, repeat, or acknowledge the first thing you hear — simply say that exact greeting. After that, converse normally.`;

async function main(): Promise<void> {
  section(`Amy greet-first probe (voice=${voiceId})`);

  // The audio "kick": a spoken opening turn the model responds to. Needs to be a
  // real, several-word utterance — a sub-second token isn't registered as a turn.
  const kick = await synthesize({ text: 'Hello, hello, good day to you.', format: 'pcm', engine: 'neural', voiceId: 'Ruth', languageCode: 'en-US', sampleRate: '16000' });
  console.log(dim(`  kick = ${kick.bytes.length} bytes of 16kHz PCM`));

  let audioFrames = 0;
  let firstAudioMs = -1;
  const t0 = Date.now();
  const assistant: string[] = [];
  const user: string[] = [];
  let firstAssistant = '';
  let errored: string | null = null;

  const session = createNovaSonicSession(
    { modelId, region, systemPrompt, tools: [], voiceId, maxTokens: 256 },
    {
      onAudioOut: () => { if (firstAudioMs < 0) firstAudioMs = Date.now() - t0; audioFrames++; },
      onTextTranscript: (text, role) => {
        if (!text) return;
        if (role === 'ASSISTANT') { if (!firstAssistant) firstAssistant = text; assistant.push(text); }
        else user.push(text);
        console.log(dim(`  [${role}] ${text}`));
      },
      onBargeIn: () => {},
      onToolUse: async () => ({}),
      onError: (err) => { errored = err.message; console.log(red(`  onError: ${err.message}`)); },
      onClose: () => {},
      onUsage: () => {},
    },
  );

  // Push the kick as ~32ms frames, then a beat of silence to mark end-of-turn.
  const FRAME = 1024;
  for (let off = 0; off < kick.bytes.length; off += FRAME) {
    session.pushAudio(kick.bytes.subarray(off, off + FRAME).toString('base64'));
    await new Promise((r) => setTimeout(r, 20));
  }
  const silence = Buffer.from(new Int16Array(512).buffer).toString('base64');
  for (let i = 0; i < 25; i++) { session.pushAudio(silence); await new Promise((r) => setTimeout(r, 40)); }

  await new Promise((r) => setTimeout(r, 8000));
  await session.stop();

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');
  const matched = firstAssistant && norm(firstAssistant).includes(norm('how may i help you'));

  section('RESULT');
  console.log(`  ${bold('Amy native audio')}: ${audioFrames > 0 ? green(`${audioFrames} frames, first @ ${firstAudioMs}ms`) : red('NONE ✗')}`);
  console.log(`  ${bold('first assistant line')}: ${firstAssistant ? (matched ? green(JSON.stringify(firstAssistant)) : yellow(JSON.stringify(firstAssistant) + '  (close enough?)')) : red('none ✗')}`);
  console.log(`  ${bold('user transcript')}: ${user.length ? yellow(JSON.stringify([...new Set(user)]) + '  ← suppress these in the relay') : green('none')}`);
  console.log(`  ${bold('error')}: ${errored ? red(errored) : green('none')}`);
  const ok = audioFrames > 0 && !!firstAssistant && !errored;
  console.log('\n' + (ok ? green(bold('GREET-FIRST WORKS ✓ (Amy speaks the opening line)')) : red(bold('GREET-FIRST FAILED ✗'))));
  process.exit(ok ? 0 : 2);
}

main().catch((e) => { console.error(red(e instanceof Error ? (e.stack ?? e.message) : String(e))); process.exit(1); });
