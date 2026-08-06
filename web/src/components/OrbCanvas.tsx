/**
 * The arc-reactor HUD ring canvas. A leaf that reads glowDriveRef each frame
 * (no signals) and renders the cinematic Jarvis HUD via drawHud. `state` drives
 * the accent + spin and is read through a ref so the rAF loop never restarts.
 * `size` scales the whole HUD — 132px for the floating widget, large for the
 * /jarvis hero orb. Shared by both so the look stays identical.
 */

import { useEffect, useRef } from 'preact/hooks';
import { glowDriveRef } from '../lib/jarvis/glowEngine';
import { drawHud } from '../lib/jarvis/hudRender';
import type { JarvisSessionState } from '../lib/jarvis/tools';

export function OrbCanvas({ state, size = 132 }: { state: JarvisSessionState; size?: number }): preact.JSX.Element {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<JarvisSessionState>(state);
  stateRef.current = state;
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = size * dpr;
    canvas.height = size * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    let raf = 0;
    const draw = (ts: number): void => {
      drawHud(ctx, ts, glowDriveRef, stateRef.current, size);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size]);
  return <canvas ref={ref} class="jarvis-orb-canvas" aria-hidden="true" style={{ width: size, height: size }} />;
}
