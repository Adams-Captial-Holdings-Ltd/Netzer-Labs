/**
 * Audio-reactive glow engine (07). Taps the VoiceClient's input/output audio,
 * computes amplitude + 5 frequency bands at 60fps, and writes CSS custom
 * properties on <html> via direct CSSOM mutation — the compositor reads them
 * during paint with ZERO Preact involvement. The canvas orb reads the shared
 * `glowDriveRef` (no getComputedStyle, no signals). Both analysers are dead-end
 * taps (never connected to destination), so no audio ever routes to speakers
 * through the engine.
 */

export type GlowSource = 'user' | 'jarvis' | 'idle';
export type VoiceState = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';

export interface GlowDriveRef {
  level: number;
  bands: Float32Array;
  peak: number;
  source: GlowSource;
}

/** Module singleton; identity never changes, fields mutate in place. */
export const glowDriveRef: GlowDriveRef = {
  level: 0,
  bands: new Float32Array(5),
  peak: 0,
  source: 'idle',
};

const STATE_CLASSES = ['jarvis-idle', 'jarvis-connecting', 'jarvis-listening', 'jarvis-thinking', 'jarvis-speaking', 'jarvis-error'];

const ATTACK = 0.3;
const RELEASE = 0.08;
const NOISE_GATE = 0.015;
const AGC_DECAY = 0.9995;
const AGC_FLOOR = 0.04;
const PEAK_DECAY = 0.94;

function prefersReducedMotion(): boolean {
  return typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export class GlowEngine {
  readonly drive = glowDriveRef;
  private inputAnalyser: AnalyserNode | null = null;
  private outputAnalyser: AnalyserNode | null = null;
  private input: AudioNode | null = null;
  private output: AudioNode | null = null;
  private state: VoiceState = 'idle';
  private running = false;
  private raf = 0;

  private readonly timeBuf = new Uint8Array(256);
  private readonly freqBuf = new Uint8Array(128);
  private readonly bandEnv = new Float32Array(5);
  private env = 0;
  private peakRms = AGC_FLOOR;
  private bandBins: Array<[number, number]> = [];
  private reduced = false;

  constructor() {
    this.onVisibility = this.onVisibility.bind(this);
    this.tick = this.tick.bind(this);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.onVisibility);
  }

  attachInput(node: AudioNode): void {
    // Disconnect any prior tap first so reconnects don't accumulate orphaned
    // AnalyserNodes that dispose() would never reclaim.
    if (this.input && this.inputAnalyser) {
      try {
        this.input.disconnect(this.inputAnalyser);
      } catch {
        /* already gone */
      }
    }
    const a = node.context.createAnalyser();
    a.fftSize = 256;
    a.smoothingTimeConstant = 0;
    node.connect(a); // parallel dead-end tap (do NOT disconnect the worklet path)
    this.inputAnalyser = a;
    this.input = node;
    this.computeBins(node.context.sampleRate);
  }

  attachOutput(node: AudioNode): void {
    if (this.output && this.outputAnalyser) {
      try {
        this.output.disconnect(this.outputAnalyser);
      } catch {
        /* already gone */
      }
    }
    const a = node.context.createAnalyser();
    a.fftSize = 256;
    a.smoothingTimeConstant = 0;
    node.connect(a); // parallel dead-end tap
    this.outputAnalyser = a;
    this.output = node;
    this.computeBins(node.context.sampleRate);
  }

  private computeBins(sampleRate: number): void {
    const edges = [20, 80, 250, 2000, 6000, 20000];
    const binHz = sampleRate / 256;
    this.bandBins = [];
    for (let i = 0; i < 5; i++) {
      const lo = Math.max(0, Math.floor(edges[i] / binHz));
      const hi = Math.min(127, Math.ceil(edges[i + 1] / binHz));
      this.bandBins.push([lo, Math.max(lo + 1, hi)]);
    }
  }

  setState(state: VoiceState): void {
    this.state = state;
    if (typeof document !== 'undefined') {
      const root = document.documentElement;
      root.classList.remove(...STATE_CLASSES);
      root.classList.add(`jarvis-${state}`);
    }
    this.drive.source = state === 'listening' ? 'user' : state === 'speaking' ? 'jarvis' : 'idle';
    if (state === 'listening' || state === 'speaking') this.start();
    else this.stop();
  }

  start(): void {
    if (this.running) return;
    this.reduced = prefersReducedMotion();
    if (this.reduced) {
      this.writeVar('--jarvis-level', 0.3);
      return; // no rAF under reduced motion
    }
    this.running = true;
    this.raf = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    // Decay the vars to rest so the orb settles instead of snapping dark.
    this.env = 0;
    this.drive.level = 0;
    this.drive.peak = 0;
    this.drive.bands.fill(0);
    this.writeVar('--jarvis-level', 0);
    this.writeVar('--jarvis-amp', 0);
    this.writeVar('--jarvis-peak', 0);
  }

  dispose(): void {
    this.stop();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.onVisibility);
    try {
      this.input?.disconnect(this.inputAnalyser as AudioNode);
      this.output?.disconnect(this.outputAnalyser as AudioNode);
    } catch {
      /* already disconnected */
    }
    this.inputAnalyser = this.outputAnalyser = null;
  }

  private onVisibility(): void {
    if (typeof document === 'undefined') return;
    if (document.hidden) this.stop();
    else if (this.state === 'listening' || this.state === 'speaking') this.start();
  }

  private analyser(): AnalyserNode | null {
    if (this.state === 'listening') return this.inputAnalyser;
    if (this.state === 'speaking') return this.outputAnalyser;
    return null;
  }

  private tick(): void {
    if (!this.running) return;
    const a = this.analyser();
    if (a) {
      a.getByteTimeDomainData(this.timeBuf);
      let sum = 0;
      for (let i = 0; i < this.timeBuf.length; i++) {
        const n = (this.timeBuf[i] - 128) / 128;
        sum += n * n;
      }
      const rawRms = Math.sqrt(sum / this.timeBuf.length);
      const gated = rawRms < NOISE_GATE ? 0 : rawRms;
      this.peakRms = Math.max(this.peakRms * AGC_DECAY, gated);
      const norm = Math.min(1, gated / Math.max(this.peakRms, AGC_FLOOR));
      const coeff = norm > this.env ? ATTACK : RELEASE;
      this.env += coeff * (norm - this.env);
      this.drive.level = this.env;
      this.drive.peak = Math.max(this.drive.peak * PEAK_DECAY, norm);

      a.getByteFrequencyData(this.freqBuf);
      for (let b = 0; b < 5; b++) {
        const [lo, hi] = this.bandBins[b];
        let s = 0;
        for (let i = lo; i < hi; i++) s += this.freqBuf[i];
        const v = s / ((hi - lo) * 255);
        this.bandEnv[b] += (v > this.bandEnv[b] ? ATTACK : RELEASE) * (v - this.bandEnv[b]);
        this.drive.bands[b] = this.bandEnv[b];
      }

      this.writeVar('--jarvis-level', this.env);
      this.writeVar('--jarvis-amp', this.env);
      this.writeVar('--jarvis-peak', this.drive.peak);
      for (let b = 0; b < 5; b++) this.writeVar(`--jarvis-band-${b + 1}`, this.bandEnv[b]);
    }
    this.raf = requestAnimationFrame(this.tick);
  }

  private writeVar(name: string, v: number): void {
    if (typeof document !== 'undefined') document.documentElement.style.setProperty(name, v.toFixed(3));
  }
}
