/**
 * Jarvis mic capture worklet (plain JS — the AudioWorklet scope has no module
 * system and no btoa). Downsamples the mic (typically 48kHz) to 16kHz via
 * linear interpolation, accumulates >= 512 samples (>= 32ms — the AWS Nova
 * minimum, NOT 20ms), converts Float32 -> Int16, and posts the raw Int16 buffer
 * (transferable) to the main thread, which base64-encodes it for the WS.
 */
class JarvisCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.ratio = sampleRate / this.targetRate; // `sampleRate` is a worklet global
    this.acc = new Float32Array(0);
    this.frame = 512; // >= 32ms at 16kHz
    this._pos = 0; // fractional read position into the input stream
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const chan = input[0];

    // Resample this 128-sample render quantum into the accumulator.
    const outCount = Math.floor((chan.length - this._pos) / this.ratio) + 1;
    const out = new Float32Array(outCount);
    let n = 0;
    let p = this._pos;
    for (; p < chan.length && n < outCount; p += this.ratio) {
      const i0 = Math.floor(p);
      const i1 = Math.min(i0 + 1, chan.length - 1);
      const frac = p - i0;
      out[n++] = chan[i0] * (1 - frac) + chan[i1] * frac;
    }
    this._pos = p - chan.length;

    // Append to the accumulator.
    const merged = new Float32Array(this.acc.length + n);
    merged.set(this.acc, 0);
    merged.set(out.subarray(0, n), this.acc.length);
    this.acc = merged;

    // Flush whole >=512-sample frames as Int16.
    while (this.acc.length >= this.frame) {
      const block = this.acc.subarray(0, this.frame);
      const pcm = new Int16Array(this.frame);
      for (let i = 0; i < this.frame; i++) {
        const s = Math.max(-1, Math.min(1, block[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage({ type: 'audio', buffer: pcm.buffer }, [pcm.buffer]);
      this.acc = this.acc.slice(this.frame);
    }
    return true;
  }
}

registerProcessor('jarvis-capture', JarvisCaptureProcessor);
