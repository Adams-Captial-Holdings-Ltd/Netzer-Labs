/**
 * Cinematic Jarvis HUD renderer (the "arc-reactor" orb). Drawn on a canvas
 * behind the mic core: a slow tick gauge, counter-rotating gyroscope arcs, an
 * audio-reactive equalizer halo (the 5 glow-engine bands), a radar sweep, a
 * pulsing core ring, and cardinal reticle ticks. Pure + framework-agnostic so
 * it can be previewed standalone; `ctx` is pre-scaled to dpr, coords in CSS px.
 */

export interface HudDrive {
  level: number;
  bands: Float32Array | number[];
}

export function drawHud(
  ctx: CanvasRenderingContext2D,
  ts: number,
  drive: HudDrive,
  state: string,
  size: number,
): void {
  const R = size / 2;
  ctx.clearRect(0, 0, size, size);

  const level = Math.max(0, Math.min(1, drive.level || 0));
  const bands = drive.bands ?? [0, 0, 0, 0, 0];
  const CYAN = '127,233,255';
  // JARVIS cyan at rest/listen, amber when speaking, violet while thinking.
  const accent =
    state === 'speaking' ? '255,184,102' : state === 'thinking' ? '170,150,255' : state === 'error' ? '255,140,90' : CYAN;
  const tip = state === 'speaking' ? '255,232,200' : '215,250,255';
  const spin = state === 'thinking' ? 2.1 : state === 'connecting' ? 1.6 : 1;
  const slow = ts * 0.00018 * spin;
  const med = ts * 0.00055 * spin;

  ctx.save();
  ctx.translate(R, R);

  // 1 — outer tick gauge
  ctx.save();
  ctx.rotate(slow);
  const tickR = R * 0.95;
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2;
    const major = i % 6 === 0;
    const len = major ? 8 : 3.5;
    const co = Math.cos(a);
    const si = Math.sin(a);
    ctx.beginPath();
    ctx.moveTo(co * (tickR - len), si * (tickR - len));
    ctx.lineTo(co * tickR, si * tickR);
    ctx.lineWidth = major ? 1.4 : 0.8;
    ctx.strokeStyle = `rgba(${CYAN},${major ? 0.5 : 0.2})`;
    ctx.stroke();
  }
  ctx.restore();

  // 2 — counter-rotating gyroscope arcs
  const arcs = (radius: number, rot: number, segs: number, gap: number, width: number, alpha: number, color: string): void => {
    ctx.save();
    ctx.rotate(rot);
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    ctx.shadowBlur = 9;
    ctx.shadowColor = `rgba(${color},0.85)`;
    const step = (Math.PI * 2) / segs;
    for (let i = 0; i < segs; i++) {
      const a0 = i * step;
      ctx.beginPath();
      ctx.arc(0, 0, radius, a0, a0 + step - gap);
      ctx.strokeStyle = `rgba(${color},${alpha})`;
      ctx.stroke();
    }
    ctx.restore();
  };
  arcs(R * 0.84, med, 3, 0.55, 2.4, 0.55 + level * 0.4, accent);
  arcs(R * 0.74, -med * 1.35, 5, 0.4, 1.5, 0.32 + level * 0.45, CYAN);
  arcs(R * 0.66, med * 0.8, 2, 0.9, 1.2, 0.22 + level * 0.35, CYAN);

  // 3 — reactive equalizer halo. The AI (speaking) reads LOUDER than the user
  // (listening): taller, brighter bars plus a closed "voiceprint" ring, so it's
  // implicitly obvious who is talking — your voice vs Jarvis's.
  const ai = state === 'speaking';
  const baseR = R * 0.52;
  const N = 72;
  const lenScale = ai ? 30 : 17;
  const barW = ai ? 2.2 : 1.3;
  const aBoost = ai ? 0.26 : 0.1;
  ctx.shadowBlur = ai ? 9 : 5;
  ctx.shadowColor = `rgba(${tip},0.9)`;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 - Math.PI / 2 + med * 0.25;
    const pos = (i / N) * 5;
    const bi = Math.floor(pos);
    const f = pos - bi;
    const b = (bands[bi % 5] || 0) * (1 - f) + (bands[(bi + 1) % 5] || 0) * f;
    const len = 2.5 + b * lenScale + level * (ai ? 8 : 4);
    const co = Math.cos(a);
    const si = Math.sin(a);
    const al = aBoost + b * 0.7 + level * 0.18;
    ctx.beginPath();
    ctx.moveTo(co * baseR, si * baseR);
    ctx.lineTo(co * (baseR + len), si * (baseR + len));
    ctx.lineWidth = barW;
    ctx.strokeStyle = `rgba(${tip},${Math.min(0.97, al)})`;
    ctx.stroke();
  }
  ctx.shadowBlur = 0;

  // AI voiceprint ring — a closed loop that breathes with the bands, drawn only
  // while Jarvis speaks. Gives the AI an extra, distinct layer the user's input
  // visual does not have.
  if (ai) {
    const wr = R * 0.49;
    ctx.beginPath();
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2 - Math.PI / 2;
      const pos = (i / N) * 5;
      const bi = Math.floor(pos);
      const f = pos - bi;
      const b = (bands[bi % 5] || 0) * (1 - f) + (bands[(bi + 1) % 5] || 0) * f;
      const r = wr + b * 12 + level * 4;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.lineWidth = 1.6;
    ctx.shadowBlur = 12;
    ctx.shadowColor = `rgba(${accent},0.9)`;
    ctx.strokeStyle = `rgba(${accent},${0.45 + level * 0.45})`;
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  // 4 — radar sweep (fading trailing wedge)
  const sweepR = R * 0.5;
  const head = med * 1.6;
  const TAIL = 26;
  for (let i = 0; i < TAIL; i++) {
    const a = head - i * 0.06;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a) * sweepR, Math.sin(a) * sweepR);
    ctx.lineWidth = 2;
    ctx.strokeStyle = `rgba(${accent},${(1 - i / TAIL) * 0.1})`;
    ctx.stroke();
  }

  // 5 — pulsing inner core ring
  ctx.beginPath();
  ctx.arc(0, 0, R * 0.43, 0, Math.PI * 2);
  ctx.lineWidth = 1.6;
  ctx.shadowBlur = 10;
  ctx.shadowColor = `rgba(${accent},1)`;
  ctx.strokeStyle = `rgba(${accent},${0.55 + level * 0.4})`;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // 6 — cardinal reticle ticks
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2;
    const co = Math.cos(a);
    const si = Math.sin(a);
    ctx.beginPath();
    ctx.moveTo(co * (R * 0.45), si * (R * 0.45));
    ctx.lineTo(co * (R * 0.49), si * (R * 0.49));
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = `rgba(${accent},0.7)`;
    ctx.stroke();
  }

  ctx.restore();
}
