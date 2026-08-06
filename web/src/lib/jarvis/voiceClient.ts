/**
 * Jarvis voice client (Phase 1). Mints a scoped WS ticket over authenticated
 * HTTPS, opens the relay socket with ONLY the ticket in the subprotocol (never
 * the raw token, H10), captures the mic via an AudioWorklet at 16kHz, plays
 * back 24kHz PCM, handles barge-in, and drives the audio-reactive glow engine.
 * The canonical ws-schema is mirrored from the server.
 */

import { getToken } from '../api';
import workletUrl from './audio-worklet.js?url';
import {
  jarvisState,
  jarvisCaption,
  jarvisVoiceEnabled,
  jarvisMicPermission,
  dispatchToolCall,
  pushTurn,
  friendlyJarvisError,
  type JarvisSessionState,
} from './tools';
import { GlowEngine } from './glowEngine';

function setState(s: JarvisSessionState): void {
  jarvisState.value = s;
}

export class VoiceClient {
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  // The capture worklet module loads once per AudioContext; cached so playback
  // (the greeting) can prime the context on the click gesture without waiting
  // for the mic, and the mic path reuses the same load.
  private workletReady: Promise<void> | null = null;
  private playbackGain: GainNode | null = null;
  private playbackUntil = 0;
  private activeSources = new Set<AudioBufferSourceNode>();
  private glow = new GlowEngine();
  private reconnectAttempts = 0;
  private closing = false;
  private listening = false;
  private bargingIn = false;
  // Consecutive loud mic frames while Jarvis is speaking → client-side barge-in.
  private bargeFrames = 0;
  // Cancellation generation: bumped by disconnect() so any in-flight connect()
  // or startListening() that resolves afterwards bails instead of opening a
  // socket or the mic after the user left the widget (Codex review).
  private gen = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Whether the user wants the mic capturing RIGHT NOW (continuous on, or PTT
  // held). Set ONLY by the explicit entry points requestMic()/releaseMic() —
  // NOT by connect() — so a reconnect never re-arms the mic and a release before
  // the socket is ready never opens it. Connection establishment is separate.
  private wantMic = false;
  // Greeting protection. On a FRESH session we ask the server to greet
  // (greet:true). The greeting starts playing moments after session_ready, so
  // if we opened the mic hot the loud first frame would trip barge-in and clip
  // it. Instead we hold the mic until the greeting's first speaking_stop.
  //  - greetRequested: did THIS connect() ask for a greeting? Captured at
  //    connect() time because session_ready resets reconnectAttempts before we
  //    could re-derive it.
  //  - greetingActive: true between session_ready and the greeting finishing;
  //    suppresses barge-in and defers the mic open. Only set when we actually
  //    intended to open the mic (wantMic), so wantMic semantics stay intact.
  private greetRequested = false;
  private greetingActive = false;
  // Safety net: if the greeting never produces a speaking_stop (missing/failed
  // greeting), open the mic anyway so Jarvis can't get stuck deaf.
  private greetTimer: ReturnType<typeof setTimeout> | null = null;
  // How long to wait for the greeting's speaking_stop before opening the mic
  // regardless. Comfortably longer than a one-line greeting.
  private static readonly GREET_FALLBACK_MS = 6000;

  async connect(): Promise<void> {
    // Guard against double-connect (e.g. rapid PTT taps): a live/connecting
    // socket would otherwise be orphaned and its onclose would spawn a phantom
    // reconnect the server rejects with 4000.
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) return;
    this.closing = false;
    const g = this.gen;
    setState('connecting');
    this.glow.setState('connecting');
    // Greet only on a fresh, user-initiated connect — not on a transient
    // auto-reconnect (which would replay "How are you, sir?"). Capture it now:
    // session_ready resets reconnectAttempts, so we couldn't re-derive it there.
    const greet = this.reconnectAttempts === 0;
    this.greetRequested = greet;
    let ticket: string;
    try {
      const res = await fetch('/api/jarvis/ws-ticket', {
        method: 'POST',
        headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ greet }),
      });
      if (g !== this.gen) return; // disconnected while the ticket was in flight
      if (res.status === 503) {
        jarvisVoiceEnabled.value = false;
        setState('disabled');
        return;
      }
      if (!res.ok) throw new Error(`ticket ${res.status}`);
      ticket = ((await res.json()) as { ticket: string }).ticket;
    } catch {
      if (g !== this.gen) return;
      setState('error');
      jarvisCaption.value = friendlyJarvisError('connection_failed');
      return;
    }
    // Re-check after the awaits: never open the socket if disconnect() ran.
    if (g !== this.gen) return;

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/api/jarvis/voice`;
    const ws = new WebSocket(url, [ticket]);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    // Capture the socket instance and ignore callbacks from a superseded socket,
    // so a delayed old onclose/onmessage cannot stop the new capture, spawn a
    // phantom reconnect, or dispatch through the replacement (Codex review).
    ws.onmessage = (e) => {
      if (this.ws === ws) this.handleMessage(e.data);
    };
    ws.onclose = (e) => {
      if (this.ws === ws) this.onClose(e.code);
    };
    ws.onerror = () => {
      /* close handler runs next */
    };
  }

  /** Explicit "start capturing now": continuous start, or a push-to-talk press. */
  requestMic(): void {
    // Prime the AudioContext on THIS user gesture so Jarvis's greeting (which
    // arrives moments after session_ready, before the mic stream resolves) has a
    // live, resumed context to play through. Browsers only let audio start from
    // a gesture, so this must run synchronously here, not in the async connect().
    this.ensurePlaybackCtx();
    this.wantMic = true;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      void this.startListening(); // live socket → a repeat PTT press starts at once
    } else {
      void this.connect(); // not connected → connect; session_ready starts if wantMic
    }
  }

  /** Explicit "stop capturing" (push-to-talk release): mic off, session stays. */
  releaseMic(): void {
    this.wantMic = false;
    this.stopListening();
  }

  disconnect(): void {
    this.gen++; // cancel any in-flight connect()/startListening()
    this.wantMic = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.endGreeting(); // clear greeting protection + its safety timer
    this.greetRequested = false;
    this.closing = true;
    this.stopListening();
    this.glow.dispose();
    try {
      this.ws?.close(1000, 'client');
    } catch {
      /* already closing */
    }
    this.ws = null;
    void this.ctx?.close();
    this.ctx = null;
    // A new session builds a fresh context, so the worklet must reload and the
    // gain be recreated against it.
    this.workletReady = null;
    this.playbackGain = null;
    setState('idle');
  }

  // ── mic capture ───────────────────────────────────────────────────
  async startListening(): Promise<void> {
    if (this.listening) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      jarvisMicPermission.value = 'unavailable';
      return;
    }
    const g = this.gen;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch {
      jarvisMicPermission.value = 'denied';
      return;
    }
    jarvisMicPermission.value = 'granted';
    // The permission prompt can resolve long after the user released push-to-talk
    // or disconnected — never open the mic in that case; stop the late stream.
    if (g !== this.gen || !this.wantMic || this.closing) {
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;
    await this.initAudio();
    if (g !== this.gen || !this.wantMic || this.closing) {
      this.stopListening();
      return;
    }
    this.listening = true;
    setState('listening');
    this.glow.setState('listening');
  }

  // Mechanical: stop capture but DON'T touch wantMic, so a transient-drop
  // reconnect can resume continuous capture. PTT release clears wantMic via
  // releaseMic(); disconnect() clears it explicitly.
  stopListening(): void {
    this.listening = false;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    try {
      this.source?.disconnect();
      this.worklet?.disconnect();
    } catch {
      /* ignore */
    }
    this.source = null;
    this.worklet = null;
  }

  // ── greeting protection ───────────────────────────────────────────
  /** Start the safety timer that opens the mic if the greeting never produces a
   *  speaking_stop (so Jarvis can't get stuck deaf). Generation-guarded so a
   *  late fire after disconnect() is a no-op. */
  private armGreetFallback(): void {
    if (this.greetTimer !== null) clearTimeout(this.greetTimer);
    const g = this.gen;
    this.greetTimer = setTimeout(() => {
      this.greetTimer = null;
      if (g !== this.gen || this.closing || !this.greetingActive) return;
      this.endGreeting();
      if (this.wantMic) void this.startListening();
    }, VoiceClient.GREET_FALLBACK_MS);
  }

  /** Clear greeting protection: drop the active flag and the safety timer.
   *  Idempotent; called by the greeting's speaking_stop, the fallback, and
   *  disconnect(). */
  private endGreeting(): void {
    this.greetingActive = false;
    if (this.greetTimer !== null) {
      clearTimeout(this.greetTimer);
      this.greetTimer = null;
    }
  }

  /** Create + resume the playback context and gain. Synchronous + idempotent so
   *  it can run inside a click gesture; the capture worklet loads separately. */
  private ensurePlaybackCtx(): void {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.playbackGain = this.ctx.createGain();
      this.playbackGain.connect(this.ctx.destination);
      this.glow.attachOutput(this.playbackGain);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  /** Load the capture AudioWorklet module once per context (mic path only). */
  private ensureWorklet(): Promise<void> {
    this.ensurePlaybackCtx();
    if (!this.workletReady) this.workletReady = this.ctx!.audioWorklet.addModule(workletUrl);
    return this.workletReady;
  }

  private async initAudio(): Promise<void> {
    this.ensurePlaybackCtx();
    await this.ensureWorklet();
    if (this.ctx!.state === 'suspended') await this.ctx!.resume();
    if (!this.stream || !this.ctx) return;
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.worklet = new AudioWorkletNode(this.ctx, 'jarvis-capture');
    this.source.connect(this.worklet); // capture path
    this.glow.attachInput(this.source); // parallel tap (must NOT disconnect source)
    this.worklet.port.onmessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; buffer?: ArrayBuffer };
      if (data.type !== 'audio' || !data.buffer) return;
      // Instant barge-in: if Jarvis is mid-speech and the user starts talking,
      // cut Jarvis off right away rather than waiting for Nova's slower signal.
      // Suppressed while the opening greeting plays so it can't self-clip.
      if (!this.greetingActive && this.isSpeaking() && rms16(data.buffer) > BARGEIN_RMS) {
        if (++this.bargeFrames >= BARGEIN_FRAMES) {
          this.bargeFrames = 0;
          this.bargein();
        }
      } else {
        this.bargeFrames = 0;
      }
      this.send({ type: 'audio_in', b64: toBase64(data.buffer) });
    };
  }

  // ── playback (PCM; 24kHz Nova default, 16kHz for the Polly voice) ──
  private playback(b64: string, sampleRate = 24000): void {
    if (!this.ctx || !this.playbackGain) return;
    const bytes = fromBase64(b64);
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
    if (pcm.length === 0) return;
    // The buffer's native rate is the source rate; the AudioContext resamples to
    // the device on playback, so 16kHz Polly audio plays correctly when tagged.
    const buf = this.ctx.createBuffer(1, pcm.length, sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.playbackGain);
    const now = this.ctx.currentTime;
    const start = Math.max(now, this.playbackUntil);
    src.start(start);
    this.playbackUntil = start + buf.duration;
    this.activeSources.add(src);
    src.onended = () => this.activeSources.delete(src);
  }

  /** Stop + drop all scheduled Jarvis audio immediately. */
  private stopPlayback(): void {
    for (const s of this.activeSources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.activeSources.clear();
    this.playbackUntil = 0;
  }

  /** True while Jarvis's audio is still scheduled to play. */
  private isSpeaking(): boolean {
    return !!this.ctx && this.ctx.currentTime < this.playbackUntil;
  }

  bargein(): void {
    this.stopPlayback();
    // Drop any in-flight audio_out until the server acks the barge-in, so a late
    // frame doesn't resume the response the user just interrupted.
    this.bargingIn = true;
    this.send({ type: 'barge_in' });
    setState('listening');
    this.glow.setState('listening');
  }

  // ── messages ──────────────────────────────────────────────────────
  private send(msg: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private handleMessage(raw: string | ArrayBuffer): void {
    let msg: { type?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    switch (msg.type) {
      case 'session_ready':
        this.reconnectAttempts = 0;
        this.bargingIn = false;
        // Only open the mic if the user still wants it (push-to-talk may already
        // have been released before the socket became ready).
        if (this.wantMic) {
          if (this.greetRequested) {
            // Fresh session: hold the mic so the greeting (which plays moments
            // from now) can't trip barge-in on its own first frame. The mic
            // opens on the greeting's first speaking_stop (below), or via the
            // safety timer if the greeting never arrives.
            this.greetingActive = true;
            this.armGreetFallback();
          } else {
            // Reconnect: no greeting, resume capture immediately as before.
            void this.startListening();
          }
        }
        break;
      case 'audio_out':
        if (this.bargingIn) break; // discard until barge_in_ack
        setState('speaking');
        this.glow.setState('speaking');
        this.playback(String(msg.b64 ?? ''), typeof msg.rate === 'number' ? msg.rate : 24000);
        break;
      case 'interrupt':
        // The user started talking — stop Jarvis's audio now, but keep accepting
        // the next reply (the server already superseded the interrupted one).
        this.stopPlayback();
        if (this.listening) {
          setState('listening');
          this.glow.setState('listening');
        }
        break;
      case 'transcript': {
        const text = String(msg.text ?? '');
        const role = msg.role === 'user' ? 'user' : 'jarvis';
        jarvisCaption.value = text;
        if (text) pushTurn(role, text);
        break;
      }
      case 'tool_call': {
        const toolUseId = String(msg.toolUseId ?? '');
        const r = dispatchToolCall(String(msg.toolName ?? ''), (msg.input as Record<string, unknown>) ?? {});
        this.send({ type: 'tool_result', toolUseId, ok: r.ok, result: r.result ?? {} });
        break;
      }
      case 'speaking_stop':
        if (this.greetingActive) {
          // The greeting just finished: clear protection and open the mic now,
          // so the user hears the whole greeting and only then starts being
          // heard. Normal barge-in is active from this point on.
          this.endGreeting();
          if (this.wantMic) void this.startListening();
        } else if (this.listening) {
          setState('listening');
          this.glow.setState('listening');
        }
        break;
      case 'barge_in_ack':
        this.bargingIn = false;
        setState('listening');
        this.glow.setState('listening');
        break;
      case 'error': {
        // Render plain English while keeping the raw code for support (debug log).
        const code = String(msg.code ?? msg.message ?? 'stream');
        console.debug('[jarvis] voice error code:', code);
        jarvisCaption.value = friendlyJarvisError(code);
        break;
      }
      default:
        break;
    }
  }

  private onClose(code: number): void {
    this.stopListening();
    this.glow.setState('idle');
    if (this.closing) {
      setState('idle');
      return;
    }
    if (code === 4012) {
      // Voice disabled mid-session — fall back to the Phase-0 text path.
      jarvisVoiceEnabled.value = false;
      setState('idle');
      jarvisCaption.value = 'Voice is disabled. You can still type to Jarvis.';
      return;
    }
    if (code === 4000) {
      setState('idle');
      jarvisCaption.value = 'Jarvis is active in another tab.';
      return;
    }
    if (code === 4011 || code === 4003) {
      setState('disabled');
      return;
    }
    // Transient: exponential backoff reconnect, max 3. The timer is stored so
    // disconnect() can cancel it, and the generation is captured so a queued
    // reconnect never resurrects a client the user already dismissed.
    if (this.reconnectAttempts < 3) {
      const delay = Math.min(1000 * 2 ** this.reconnectAttempts, 10000);
      this.reconnectAttempts += 1;
      setState('connecting');
      // Tell the user we dropped and are coming back, rather than a silent spinner.
      jarvisCaption.value = friendlyJarvisError('connection_lost');
      const g = this.gen;
      this.reconnectTimer = setTimeout(() => {
        this.reconnectTimer = null;
        if (g === this.gen && !this.closing) void this.connect();
      }, delay);
    } else {
      setState('error');
      jarvisCaption.value = friendlyJarvisError('connection_failed');
    }
  }
}

// Shared singleton: the floating widget AND the /jarvis hero orb drive ONE
// client. A token gets exactly one live session (a second would be rejected at
// the lease with close 4000), and the shared jarvisState/caption signals keep
// both surfaces in sync — start a session on one, see it on the other.
let _shared: VoiceClient | null = null;
export function getVoiceClient(): VoiceClient {
  if (!_shared) _shared = new VoiceClient();
  return _shared;
}

// Client-side barge-in tuning: RMS over a 16-bit PCM frame (0..1). Normal speech
// sits ~0.1-0.3; 0.08 over a few frames means the user is genuinely talking, not
// room noise, so we cut Jarvis off without false-triggering on a stray sound.
const BARGEIN_RMS = 0.08;
const BARGEIN_FRAMES = 3;

/** RMS amplitude (0..1) of a 16-bit little-endian PCM frame. */
function rms16(buffer: ArrayBuffer): number {
  const a = new Int16Array(buffer);
  if (a.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const v = a[i] / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / a.length);
}

// ── base64 helpers ──────────────────────────────────────────────────
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
