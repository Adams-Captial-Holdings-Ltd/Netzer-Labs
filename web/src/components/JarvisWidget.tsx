/**
 * Floating Jarvis widget (Phase 1): the glowing mic orb + live caption strip +
 * "now showing" nav chip + highlight reticle. Lives on every route (mounted in
 * AppShell beside ToastContainer). The orb's CSS layers + the canvas dot-ring
 * track the audio-reactive glow vars; nothing here re-renders per audio frame.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useLocation } from 'wouter-preact';
import { Mic, MicOff, Loader2, Volume2, Play, X } from 'lucide-preact';
import {
  jarvisState,
  jarvisCaption,
  jarvisNavChip,
  jarvisEnabled,
  jarvisVoiceEnabled,
  jarvisPushToTalk,
  jarvisMicPermission,
  jarvisWidgetPos,
  jarvisWidgetHidden,
  setJarvisWidgetHidden,
  saveWidgetPos,
  registerNavigate,
  loadJarvisManifest,
} from '../lib/jarvis/tools';
import { stopJarvis, isJarvisBusy } from '../lib/jarvis/stop';
import { jarvisRoutines, loadJarvisRoutines } from '../lib/jarvis/routines';
import { runJarvisTextTurn } from '../lib/jarvis/textClient';
import { runDemoWalkthrough, DEMO_WALKTHROUGH_ROUTINE_ID } from '../lib/jarvis/walkthrough';
import { getVoiceClient, type VoiceClient } from '../lib/jarvis/voiceClient';
import { JarvisSpotlight, JarvisCardLayer, suggestionsForRoute } from './JarvisHud';
import { OrbCanvas } from './OrbCanvas';
import { sidebarCollapsed } from './Sidebar';
import '../lib/jarvis/jarvis.css';

// Drag tuning: a press must travel this far before it counts as a drag (so a tap
// still toggles the mic). HALO is the orb's full glow-ring footprint (OrbCanvas is
// 132px) — the widget box IS this size, so the clamp keeps the whole orb on-screen
// and the caption floats off this box without ever overlapping the glow.
const DRAG_THRESHOLD = 6;
const HALO = 132;
const SIDEBAR_ORB_GAP = 8;

export function JarvisWidget(): preact.JSX.Element | null {
  const [location, setLocation] = useLocation();
  const clientRef = useRef<VoiceClient | null>(null);
  // Active drag gesture (null when not dragging). suppressClickRef swallows the
  // click that fires at the end of a drag so a reposition never toggles the mic.
  const dragRef = useRef<{ id: number; sx: number; sy: number; bx: number; by: number; moved: boolean } | null>(null);
  const suppressClickRef = useRef(false);

  useEffect(() => {
    registerNavigate(setLocation);
    void loadJarvisManifest();
    void loadJarvisRoutines();
    // Shared client — do NOT disconnect on unmount; the /jarvis hero orb may own
    // the same live session (the widget is global and effectively never unmounts).
    clientRef.current = getVoiceClient();
  }, []);

  // Re-render on resize so the position clamp below tracks the live viewport
  // (a dragged orb must follow the window edge in, not vanish past it).
  const [viewportTick, setViewportTick] = useState(0);
  useEffect(() => {
    const onResize = () => setViewportTick((n) => n + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const collapsed = sidebarCollapsed.value;
  const chatRoute = location.startsWith('/chat');
  const [chatSidebarAnchor, setChatSidebarAnchor] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (!chatRoute || window.innerWidth < 1024) {
      setChatSidebarAnchor(null);
      return;
    }
    const nav = document.querySelector<HTMLElement>('aside nav[aria-label="Main"]');
    const sidebar = nav?.closest<HTMLElement>('aside');
    if (!nav || !sidebar) {
      setChatSidebarAnchor(null);
      return;
    }
    const rail = sidebar.getBoundingClientRect();
    const navigation = nav.getBoundingClientRect();
    const links = nav.querySelectorAll<HTMLElement>('a');
    const lastLink = links.item(links.length - 1);
    const listBottom = Math.min(lastLink?.getBoundingClientRect().bottom ?? navigation.top, navigation.bottom);
    const accountControls = sidebar.querySelector<HTMLElement>('[aria-label="Account controls"]');
    const footerTop = accountControls?.getBoundingClientRect().top ?? navigation.bottom;
    const bandBottom = Math.min(navigation.bottom, footerTop);
    const middle = (listBottom + bandBottom) / 2;
    const minCenter = listBottom + 26 + SIDEBAR_ORB_GAP;
    const maxCenter = bandBottom - 26 - SIDEBAR_ORB_GAP;
    const centerY = maxCenter >= minCenter
      ? Math.max(minCenter, Math.min(maxCenter, middle))
      : maxCenter;
    setChatSidebarAnchor({
      left: rail.left + (rail.width - HALO) / 2,
      top: centerY - HALO / 2,
    });
  }, [chatRoute, collapsed, viewportTick]);

  const state = jarvisState.value;
  const enabled = jarvisEnabled.value;
  const caption = jarvisCaption.value;
  const navChip = jarvisNavChip.value;
  const perm = jarvisMicPermission.value;
  // Contextual ask-me chips: revealed while the pointer rests on the orb (or the
  // chips themselves) and Jarvis is idle — they would fight the caption during a
  // live exchange. The container is pointer-events-none, so hover lives on the
  // interactive elements with a short grace timer to bridge the gap between them.
  const [hovered, setHovered] = useState(false);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function hoverIn() {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = null;
    setHovered(true);
  }
  function hoverOut() {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    hoverTimerRef.current = setTimeout(() => setHovered(false), 500);
  }
  useNavChipDismiss(navChip?.ts);

  // Apply the engine's state class to <html> for the idle breathing baseline.
  useEffect(() => {
    const root = document.documentElement;
    if (!root.className.includes('jarvis-')) root.classList.add('jarvis-idle');
  }, []);

  // Escape is the universal "get me out". Bound globally (not on the orb) so it
  // works while a tour has the page dimmed and focus is wherever the user left it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') stopJarvis();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The /jarvis tab IS the orb (full immersive experience), so the floating
  // widget steps aside there to avoid two orbs competing for one session.
  if (!enabled || jarvisWidgetHidden.value || location === '/jarvis') return null;

  /** The X: stop everything, then get off the screen. */
  function onCloseClick() {
    stopJarvis();
    setJarvisWidgetHidden(true);
  }

  function onMicClick() {
    // A running tour/narration owns the orb: tapping it means "stop", not
    // "poke the voice client" (which would leave the tour navigating on).
    if (isJarvisBusy()) {
      stopJarvis();
      return;
    }
    const c = clientRef.current;
    if (!c) return;
    if (state === 'idle' || state === 'error' || state === 'disabled') {
      c.requestMic();
    } else if (state === 'speaking') {
      c.bargein();
    } else {
      c.disconnect();
    }
  }

  const icon =
    state === 'connecting' || state === 'thinking' ? (
      <Loader2 class="w-[18px] h-[18px] animate-spin" />
    ) : state === 'speaking' ? (
      <Volume2 class="w-[18px] h-[18px]" />
    ) : state === 'error' ? (
      <MicOff class="w-[18px] h-[18px]" />
    ) : (
      <Mic class="w-[18px] h-[18px]" />
    );

  const ptt = jarvisPushToTalk.value;
  const voiceOff = jarvisVoiceEnabled.value === false;
  // Clamp the restored position to the CURRENT viewport. The drag handler clamps
  // live moves, but the persisted value is replayed verbatim — a position saved
  // on a larger window would otherwise park the orb off-screen ("where did my
  // Jarvis go?"). Clamped at render (not written back) so shrinking a window
  // never destroys the position the user chose on the big one.
  const rawPos = jarvisWidgetPos.value;
  const pos = rawPos
    ? {
        x: Math.max(4, Math.min(window.innerWidth - HALO - 4, rawPos.x)),
        y: Math.max(4, Math.min(window.innerHeight - HALO - 4, rawPos.y)),
      }
    : null;

  // Float the caption off the orb box so it never overlaps the glow ring and never
  // runs off-screen: above by default, flipped below when the orb is near the top;
  // left-aligned by default, right-aligned when the orb is near the right edge.
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
  const effectivePos = pos ?? (chatRoute && window.innerWidth >= 1024 && chatSidebarAnchor
    ? { x: chatSidebarAnchor.left, y: chatSidebarAnchor.top }
    : null);
  const captionBelow = !!effectivePos && effectivePos.y < 170;
  const captionRight = !!effectivePos && effectivePos.x > vw - 300;
  const captionPos = {
    [captionBelow ? 'top' : 'bottom']: 'calc(100% + 8px)',
    [captionRight ? 'right' : 'left']: '0',
  } as Record<string, string>;

  // ── Drag-to-move (coexists with click-to-talk and push-to-talk) ──────
  function onOrbPointerDown(e: PointerEvent) {
    const btn = e.currentTarget as HTMLElement;
    btn.setPointerCapture?.(e.pointerId);
    const widget = btn.closest('[data-testid="jarvis-widget"]') as HTMLElement | null;
    const r = widget?.getBoundingClientRect();
    dragRef.current = { id: e.pointerId, sx: e.clientX, sy: e.clientY, bx: r?.left ?? 0, by: r?.top ?? 0, moved: false };
    if (ptt) clientRef.current?.requestMic(); // a tap-hold is push-to-talk; a drag cancels it below
  }
  function onOrbPointerMove(e: PointerEvent) {
    const d = dragRef.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.sx;
    const dy = e.clientY - d.sy;
    if (!d.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    if (!d.moved) {
      d.moved = true;
      if (ptt) clientRef.current?.releaseMic(); // press became a drag → not a PTT hold
    }
    const x = Math.max(4, Math.min(window.innerWidth - HALO - 4, d.bx + dx));
    const y = Math.max(4, Math.min(window.innerHeight - HALO - 4, d.by + dy));
    jarvisWidgetPos.value = { x, y }; // live move; persisted on pointer-up
  }
  function onOrbPointerUp() {
    const d = dragRef.current;
    dragRef.current = null;
    if (d?.moved) {
      suppressClickRef.current = true;
      if (jarvisWidgetPos.value) saveWidgetPos(jarvisWidgetPos.value);
    } else if (ptt) {
      clientRef.current?.releaseMic(); // genuine PTT tap release
    }
  }
  function onOrbPointerCancel() {
    const d = dragRef.current;
    dragRef.current = null;
    if (ptt && !d?.moved) clientRef.current?.releaseMic();
  }
  function onOrbClick() {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return; // this click ends a drag, not a tap
    }
    if (!ptt) onMicClick();
  }

  return (
    <div
      data-testid="jarvis-widget"
      // The widget box IS the orb's glow footprint (HALO×HALO). The orb centers in
      // it; the caption + hints float OFF it (absolute) so they never shift the
      // orb's anchor or overlap the glow. Default anchor: content area, clear of the
      // On desktop chat, center the 52px control in the house nav's unused
      // lower band. Other routes and narrow screens keep their existing anchor.
      // A remembered drag still supplies left/top below and takes precedence.
      class={`fixed ${chatRoute && chatSidebarAnchor ? 'left-0 top-0' : 'left-5 lg:left-[calc(var(--sidebar-width)_+_1.5rem)]'} z-[60] grid place-items-center pointer-events-none [&_button]:pointer-events-auto ${chatRoute ? (chatSidebarAnchor ? '' : 'bottom-52') : 'bottom-5'}`}
      style={
        pos
          ? { left: `${pos.x}px`, top: `${pos.y}px`, right: 'auto', bottom: 'auto', width: `${HALO}px`, height: `${HALO}px` }
          : chatRoute && window.innerWidth >= 1024 && chatSidebarAnchor
            ? { left: `${chatSidebarAnchor.left}px`, top: `${chatSidebarAnchor.top}px`, right: 'auto', bottom: 'auto', width: `${HALO}px`, height: `${HALO}px` }
            : { width: `${HALO}px`, height: `${HALO}px` }
      }
    >
      <OrbCanvas state={state} />
      <button
        data-testid="mic-button"
        type="button"
        class="jarvis-orb"
        // touch-action:none so a drag on touch devices moves the orb instead of
        // scrolling the page. Pointer capture (set on down) keeps move/up firing
        // on THIS button even if the finger drifts off, and releasing on cancel/
        // lost-capture means a drag-away never leaves push-to-talk mic on.
        style={{ touchAction: 'none' }}
        aria-label={`Jarvis (${state})`}
        onClick={onOrbClick}
        onPointerDown={onOrbPointerDown}
        onPointerMove={onOrbPointerMove}
        onPointerUp={onOrbPointerUp}
        onPointerCancel={onOrbPointerCancel}
        onLostPointerCapture={onOrbPointerCancel}
        onMouseEnter={hoverIn}
        onMouseLeave={hoverOut}
      >
        {icon}
      </button>

      {/* Dismiss. Always in the DOM (not hover-only) so it is reachable by
          keyboard and findable mid-tour, when the user most wants it. */}
      <button
        data-testid="jarvis-close"
        type="button"
        class="jarvis-orb-close"
        aria-label="Close Jarvis"
        title="Close Jarvis (Esc)"
        onClick={onCloseClick}
        onMouseEnter={hoverIn}
        onMouseLeave={hoverOut}
      >
        <X class="w-3 h-3" />
      </button>

      {hovered && state === 'idle' && !caption && (
        <div
          data-testid="jarvis-suggestions"
          class="jarvis-suggestions"
          style={captionPos}
          onMouseEnter={hoverIn}
          onMouseLeave={hoverOut}
        >
          {jarvisRoutines.value
            .filter((r) => r.showOnHover)
            .map((r) => (
              <span key={`routine-${r.id}`} class="inline-flex items-center">
                <button
                  type="button"
                  class="jarvis-suggestion-chip jarvis-routine-chip"
                  title={r.prompt}
                  onClick={() => {
                    setHovered(false);
                    if (r.id === DEMO_WALKTHROUGH_ROUTINE_ID) void runDemoWalkthrough();
                    else void runJarvisTextTurn(r.prompt, { speak: true });
                  }}
                >
                  <Play class="w-3 h-3" />
                  {r.name}
                </button>
                {/* Schedule this routine: deep-link into the Scheduled Tasks
                    create modal with the routine preselected (?routineId=). */}
                <button
                  type="button"
                  class="jarvis-suggestion-chip"
                  style={{ padding: '2px 6px', marginLeft: '-4px' }}
                  title={`Schedule "${r.name}" to run automatically`}
                  aria-label={`Schedule ${r.name}`}
                  onClick={() => {
                    setHovered(false);
                    window.location.href = `/dashboard/scheduled?routineId=${encodeURIComponent(r.id)}`;
                  }}
                >
                  ⏰
                </button>
              </span>
            ))}
          {suggestionsForRoute(location).map((p) => (
            <button
              key={p}
              type="button"
              class="jarvis-suggestion-chip"
              onClick={() => {
                setHovered(false);
                void runJarvisTextTurn(p);
              }}
            >
              {p}
            </button>
          ))}
        </div>
      )}

      {caption && (
        <div data-testid="caption" class="jarvis-caption jarvis-caption-float text-body-sm" role="status" aria-live="polite" style={captionPos}>
          <span class="font-mono text-[11px] uppercase tracking-wide opacity-70">{state === 'listening' ? 'YOU' : 'JARVIS'}</span>
          <div>{caption}</div>
        </div>
      )}

      {perm === 'denied' && (
        <div class="jarvis-caption jarvis-caption-float text-caption" style={captionPos}>Microphone blocked. Allow it in your browser, or use the /jarvis text box.</div>
      )}
      {perm === 'unavailable' && (
        <div class="jarvis-caption jarvis-caption-float text-caption" style={captionPos}>Microphone needs HTTPS. Use the /jarvis text box instead.</div>
      )}
      {voiceOff && (
        <div class="jarvis-caption jarvis-caption-float text-caption" style={captionPos}>Voice is disabled right now. Type to Jarvis on the /jarvis tab.</div>
      )}

      {navChip && (
        <div data-testid="navigation-chip" class="jarvis-navchip fixed left-1/2 top-4 -translate-x-1/2 px-4 py-1.5 text-caption flex items-center gap-2">
          <Volume2 class="w-3.5 h-3.5" />
          Now showing {navChip.label}
        </div>
      )}

      <JarvisSpotlight />
      <JarvisCardLayer />
    </div>
  );
}

/** Auto-dismiss the nav chip 4s after it changes (keyed by its timestamp). */
function useNavChipDismiss(ts: number | undefined) {
  useEffect(() => {
    if (ts === undefined) return;
    const t = setTimeout(() => {
      if (jarvisNavChip.value?.ts === ts) jarvisNavChip.value = null;
    }, 4000);
    return () => clearTimeout(t);
  }, [ts]);
}
