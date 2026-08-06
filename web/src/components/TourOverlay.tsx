/**
 * Renders the guided tour (lib/tour/engine.ts): dims the page, spotlights the
 * current step's target, and shows a tooltip card with the step copy and
 * Back / Next / Skip-tab / Exit controls.
 *
 * Robustness rules that keep the tour from ever wedging:
 *  - Navigation: when the active step's tab route differs from the location we
 *    navigate first and only then resolve the target.
 *  - Targets resolve by [data-tour] → [data-testid] → CSS selector, polled for
 *    up to ~3.2s (pages fetch data before their controls mount).
 *  - A step whose target never appears either auto-skips (optional steps — the
 *    element is permission- or data-dependent) or falls back to a centered
 *    card, so a missing anchor can never strand the user.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { useLocation } from 'wouter-preact';
import { Button } from './Button';
import {
  currentStep,
  currentTab,
  endTour,
  nextStep,
  prevStep,
  skipTab,
  tourProgress,
  tourState,
} from '../lib/tour/engine';

const POLL_MS = 160;
const POLL_TRIES = 20; // ~3.2s

function resolveTarget(target: string): Element | null {
  try {
    const el = document.querySelector(`[data-tour="${target}"]`);
    if (el) return el;
  } catch {
    /* fall through */
  }
  try {
    const el = document.querySelector(`[data-testid="${target}"]`);
    if (el) return el;
  } catch {
    /* fall through */
  }
  try {
    return document.querySelector(target);
  } catch {
    return null;
  }
}

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

type Resolution =
  | { kind: 'pending' }
  | { kind: 'found'; el: Element }
  | { kind: 'missing' };

export function TourOverlay(): preact.JSX.Element | null {
  const st = tourState.value;
  const [location, setLocation] = useLocation();
  const [res, setRes] = useState<Resolution>({ kind: 'pending' });
  const [rect, setRect] = useState<DOMRect | null>(null);
  // Measured card height for placement; 0 = not yet measured for this step.
  const [cardH, setCardH] = useState(0);
  const cardRef = useRef<HTMLDivElement>(null);
  // Identity of the step being resolved, so stale polls can't clobber state.
  const stepKey = st ? `${st.tabIdx}:${st.stepIdx}` : '';

  const tab = st ? currentTab(st) : null;
  const step = st ? currentStep(st) : null;
  const onRoute = !!tab && (location === tab.route || (tab.route !== '/' && location.startsWith(tab.route)));

  // Navigate to the step's tab when we aren't there yet.
  useEffect(() => {
    if (!st || !tab) return;
    if (!onRoute) setLocation(tab.route);
  }, [stepKey, onRoute]);

  // Resolve the step target (poll — pages mount controls after data loads).
  useEffect(() => {
    if (!st || !step) return;
    setRes({ kind: 'pending' });
    setRect(null);
    if (!onRoute) return; // wait for navigation; effect re-runs via onRoute
    if (!step.target) {
      setRes({ kind: 'missing' }); // intentional centered step
      return;
    }
    let tries = 0;
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      const el = step.target ? resolveTarget(step.target) : null;
      if (el && visible(el)) {
        setRes({ kind: 'found', el });
        return;
      }
      tries += 1;
      if (tries >= POLL_TRIES) {
        if (step.optional) {
          // Permission- or data-dependent element that isn't there for this
          // user — skip forward silently rather than show an orphaned card.
          nextStep();
        } else {
          setRes({ kind: 'missing' });
        }
        return;
      }
      setTimeout(tick, POLL_MS);
    };
    tick();
    return () => {
      cancelled = true;
    };
  }, [stepKey, onRoute]);

  // Track the found element's rect through scroll/resize, and keep it in view.
  useEffect(() => {
    if (res.kind !== 'found') return;
    const el = res.el;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const track = () => setRect(el.getBoundingClientRect());
    track();
    window.addEventListener('scroll', track, true);
    window.addEventListener('resize', track);
    return () => {
      window.removeEventListener('scroll', track, true);
      window.removeEventListener('resize', track);
    };
  }, [res]);

  // Measure the rendered card so placement can use its real height (step copy
  // varies a lot). Re-measures per step and once resolution settles.
  useLayoutEffect(() => {
    setCardH(0);
  }, [stepKey]);
  useLayoutEffect(() => {
    if (cardRef.current) {
      const h = cardRef.current.offsetHeight;
      if (h && h !== cardH) setCardH(h);
    }
  });

  // Keyboard: ← back, → / Enter next, Esc exit.
  useEffect(() => {
    if (!st) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        endTour(false);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        nextStep();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        prevStep();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [!!st]);

  if (!st || !tab || !step) return null;

  const spot = res.kind === 'found' && rect ? rect : null;
  const pad = 8;
  const progress = tourProgress(st);
  const isFirst = st.tabIdx === 0 && st.stepIdx === 0;
  const lastStepOfTab = st.stepIdx === tab.steps.length - 1;
  const isLast = st.tabIdx === st.tabs.length - 1 && lastStepOfTab;
  const nextLabel = isLast ? 'Finish' : lastStepOfTab ? `Next: ${st.tabs[st.tabIdx + 1]?.label ?? 'Done'}` : 'Next';

  // Tooltip placement: under the spotlight when the MEASURED card fits there,
  // else above it, else clamped inside the viewport (overlapping the spotlight
  // as a last resort — a reachable Next button beats a pristine spotlight).
  // cardH comes from a post-render measure; until it lands we use an estimate,
  // so a long step can never push the controls below the fold.
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cardW = Math.min(400, vw - 24);
  const h = cardH || 260;
  let cardStyle: Record<string, string | number>;
  if (spot) {
    const left = Math.max(12, Math.min(spot.left, vw - cardW - 12));
    let top = spot.bottom + pad + 12; // preferred: below the spotlight
    if (top + h > vh - 12) top = spot.top - pad - 12 - h; // flip above
    top = Math.max(12, Math.min(top, vh - h - 12)); // final clamp on-screen
    cardStyle = { left, top, width: cardW };
  } else {
    cardStyle = { left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: cardW };
  }

  return (
    <div class="fixed inset-0 z-[70]" data-testid="tour-overlay" role="dialog" aria-modal="true" aria-label="Guided tour">
      {/* Backdrop. With a spotlight, four dim strips surround the target so it
          stays at full brightness (a giant box-shadow "cutout" does not paint
          reliably in Chromium at viewport-scale spreads); otherwise a flat dim. */}
      {spot ? (
        (() => {
          const x0 = Math.max(0, spot.left - pad);
          const y0 = Math.max(0, spot.top - pad);
          const x1 = Math.min(vw, spot.right + pad);
          const y1 = Math.min(vh, spot.bottom + pad);
          const dim = 'absolute bg-black/60 pointer-events-none';
          return (
            <>
              <div class={dim} style={{ left: 0, top: 0, width: vw, height: y0 }} />
              <div class={dim} style={{ left: 0, top: y1, width: vw, height: Math.max(0, vh - y1) }} />
              <div class={dim} style={{ left: 0, top: y0, width: x0, height: y1 - y0 }} />
              <div class={dim} style={{ left: x1, top: y0, width: Math.max(0, vw - x1), height: y1 - y0 }} />
              <div
                class="absolute rounded-xl pointer-events-none border-2"
                style={{ left: x0, top: y0, width: x1 - x0, height: y1 - y0, borderColor: 'var(--color-primary, #6366f1)' }}
              />
            </>
          );
        })()
      ) : (
        <div class="absolute inset-0 bg-black/60" />
      )}
      {res.kind === 'pending' && (
        <div class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-white/90 text-sm bg-black/70 px-4 py-2 rounded-lg">
          Loading {tab.label}…
        </div>
      )}
      {res.kind !== 'pending' && (
        <div
          ref={cardRef}
          class="absolute bg-surface border border-border rounded-xl shadow-xl p-4"
          style={cardStyle}
          data-testid="tour-card"
        >
          <div class="flex items-center justify-between mb-2">
            <span class="text-overline uppercase tracking-wider text-claw-400 font-semibold">
              {tab.label}
              {st.tabs.length > 1 && (
                <span class="text-muted font-normal"> · tab {st.tabIdx + 1} of {st.tabs.length}</span>
              )}
            </span>
            <button
              onClick={() => endTour(false)}
              class="text-xs text-muted hover:text-secondary transition-colors"
              aria-label="Exit tour"
              data-testid="tour-exit"
            >
              Exit
            </button>
          </div>
          <h2 class="text-base font-semibold text-primary mb-1.5">{step.title}</h2>
          <p class="text-sm text-secondary leading-relaxed mb-4">{step.body}</p>
          {/* Progress bar across the whole run */}
          <div class="h-1 bg-border rounded-full mb-3 overflow-hidden" aria-hidden="true">
            <div
              class="h-full bg-primary rounded-full transition-all duration-200"
              style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
            />
          </div>
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs text-muted shrink-0">{progress.done} of {progress.total}</span>
            <div class="flex items-center gap-2">
              {!st.single && !isLast && (
                <button
                  onClick={skipTab}
                  class="text-xs text-muted hover:text-secondary transition-colors px-1"
                  data-testid="tour-skip-tab"
                >
                  Skip tab
                </button>
              )}
              {!isFirst && (
                <Button variant="secondary" size="sm" onClick={prevStep}>
                  Back
                </Button>
              )}
              <Button variant="primary" size="sm" onClick={nextStep}>
                {nextLabel}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
