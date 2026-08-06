/**
 * Scripted Demo Walkthrough — a DETERMINISTIC, filming-grade tour.
 *
 * The live model-driven path lets Jarvis choose when to navigate vs. speak, so
 * the tab on screen could lead or lag the narration. For a shoot that has to be
 * contextually airtight, this runner removes the model from the loop: a fixed
 * sequence of (route, line) pairs is executed in lockstep —
 *   navigate -> wait for the page to render -> speak the line with its caption.
 * So the screen is ALWAYS on the page being talked about, every take, identical.
 *
 * Audio is the same Jarvis voice as everywhere else (server POST /api/jarvis/narrate
 * -> Polly generative "Amy", SSML rate), synthesized per line and prefetched in
 * parallel so stops play back-to-back with no gaps. If audio is unavailable the
 * tour still runs (caption held a readable beat per stop).
 */

import { getToken } from '../api';
import { jarvisState, jarvisCaption, dispatchToolCall, resetJarvisStream, pushTurn } from './tools';
import { stopJarvisNarration } from './textClient';

/** Routine id (slug of "Demo Walkthrough") that runs the scripted tour instead
 *  of the live model text-turn. Chips compare against this. */
export const DEMO_WALKTHROUGH_ROUTINE_ID = 'demo-walkthrough';

interface Stop {
  /** Route to land on before speaking; null keeps the current page (closing line). */
  route: string | null;
  line: string;
}

// Owner-facing welcome-back briefing. en-GB, no em dashes, no clichés. Routes
// match App.tsx exactly: Overview '/', Security Posture, Compliance, DLP, Cost, Audit.
const DEMO_WALKTHROUGH: Stop[] = [
  {
    route: '/',
    line: 'Welcome back Emmanuel. Let me catch you up on what your team has been doing.',
  },
  {
    // Stay on Overview and walk through what the agents have been up to. Mirrors
    // the seeded fleet activity (Research pricing, Ops rollout, Main coordinating).
    route: null,
    line: 'Research wrapped the competitor pricing, Ops staged the v1.2 rollout, and I pulled it all together.',
  },
  {
    route: null,
    line: 'That is your whole operation at a glance, three agents working, and all of it inside your own AWS account.',
  },
  {
    route: '/security-posture',
    line: 'Your kill switches are set the way you left them, and least privilege is holding across the board.',
  },
  {
    route: '/compliance',
    line: 'Your SOC 2 and HIPAA readiness is scored against the live setup, so you always know exactly where you stand.',
  },
  {
    route: '/dlp',
    line: 'Every response is checked before it leaves, so nothing sensitive has slipped out since you were last here.',
  },
  {
    route: '/cost',
    line: 'Spending is right in line with usual, and the daily cap is still well clear.',
  },
  {
    route: '/audit',
    line: 'And every action since you stepped away is logged, named, and reversible, so nothing here is a mystery.',
  },
  {
    route: null,
    line: 'You are all caught up. Everything is calm and under control.',
  },
];

// Give each page a beat to paint before Jarvis starts describing it, so the
// screen is unmistakably on the right tab when the line begins.
const RENDER_MS = 850;
// A small breath between stops.
const GAP_MS = 300;
// If a line's audio could not be synthesized, hold its caption this long so the
// tour still reads at a natural pace.
const FALLBACK_READ_MS = 2600;

let running = false;
let cancelled = false;
let audioCtx: AudioContext | null = null;
let activeSource: AudioBufferSourceNode | null = null;

function ensureCtx(): AudioContext | null {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return null;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    return audioCtx;
  } catch {
    return null;
  }
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function synthLine(text: string): Promise<{ b64: string; rate: number } | null> {
  try {
    const res = await fetch('/api/jarvis/narrate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { b64?: string; rate?: number };
    return j.b64 ? { b64: j.b64, rate: typeof j.rate === 'number' ? j.rate : 16000 } : null;
  } catch {
    return null;
  }
}

// Play one PCM clip; resolves when it finishes (or right away if it cannot play).
function playClip(b64: string, sampleRate: number): Promise<void> {
  const ctx = ensureCtx();
  if (!ctx) return Promise.resolve();
  const bytes = fromBase64(b64);
  const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  if (pcm.length === 0) return Promise.resolve();
  const buf = ctx.createBuffer(1, pcm.length, sampleRate);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  activeSource = src;
  return new Promise<void>((resolve) => {
    src.onended = () => {
      if (activeSource === src) activeSource = null;
      resolve();
    };
    src.start();
  });
}

/** True while the scripted walkthrough is playing (so the orb can stop it). */
export function isWalkthroughRunning(): boolean {
  return running;
}

/** Stop the walkthrough immediately and settle the orb. */
export function stopDemoWalkthrough(): void {
  cancelled = true;
  if (activeSource) {
    try {
      activeSource.stop();
    } catch {
      /* already stopped */
    }
    activeSource = null;
  }
  running = false;
  if (jarvisState.value === 'speaking' || jarvisState.value === 'thinking') {
    jarvisState.value = 'idle';
  }
}

/** Run the fixed, lockstep Demo Walkthrough. Call from a user gesture (chip click). */
export async function runDemoWalkthrough(): Promise<void> {
  if (running) return;
  running = true;
  cancelled = false;
  // Supersede any model-driven narration, and unlock audio inside the gesture.
  stopJarvisNarration();
  ensureCtx();
  resetJarvisStream();
  jarvisCaption.value = '';
  jarvisState.value = 'thinking';
  pushTurn('user', 'Demo Walkthrough');

  // Prefetch every line's audio in parallel so stops play with no synth gaps.
  const clips = DEMO_WALKTHROUGH.map((s) => synthLine(s.line));

  try {
    for (let i = 0; i < DEMO_WALKTHROUGH.length; i++) {
      if (cancelled) break;
      const stop = DEMO_WALKTHROUGH[i];
      // 1) Land on the page first.
      if (stop.route) dispatchToolCall('navigate', { route: stop.route });
      // 2) Let it render so the screen is on the tab before the words start.
      await delay(RENDER_MS);
      if (cancelled) break;
      // 3) Reveal caption + speak — now that the right page is showing.
      const clip = await clips[i];
      if (cancelled) break;
      jarvisCaption.value = stop.line;
      pushTurn('jarvis', stop.line);
      if (clip) {
        jarvisState.value = 'speaking';
        await playClip(clip.b64, clip.rate);
      } else {
        await delay(FALLBACK_READ_MS);
      }
      if (cancelled) break;
      await delay(GAP_MS);
    }
  } finally {
    running = false;
    if (jarvisState.value === 'speaking' || jarvisState.value === 'thinking') {
      jarvisState.value = 'idle';
    }
  }
}
