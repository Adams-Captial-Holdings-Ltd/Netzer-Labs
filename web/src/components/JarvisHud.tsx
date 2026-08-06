/**
 * Jarvis HUD layers: the cinematic spotlight (highlight tool), the floating
 * insight-card stack (show_card tool), and the contextual suggestion chips.
 *
 * Everything here is DISPLAY-ONLY. Card and label content arrives from the
 * model (which has only ever seen DLP-redacted data) and is clamped in
 * tools.ts/sanitizeCard; it renders as text nodes, never markup. The spotlight
 * resolves a selector against the live DOM but only draws over it — it cannot
 * click, read, or mutate anything.
 */

import { useEffect, useMemo, useState } from 'preact/hooks';
import { X } from 'lucide-preact';
import {
  jarvisCards,
  jarvisHighlight,
  dismissJarvisCard,
  type JarvisCard,
} from '../lib/jarvis/tools';

const SPOTLIGHT_MS = 6500;
const CARD_TTL_MS = 25000;

/**
 * Resolve a highlight target to an on-screen element, most-precise first:
 * CSS selector → data-testid → visible-text match. The text fallback is what
 * makes the tool usable in practice — the model knows what a control SAYS
 * ("New Agent") far more reliably than its selector. Matching is read-only:
 * we only measure the element's rect to draw over it.
 */
function resolveSpotlightTarget(target: string): Element | null {
  try {
    const el = document.querySelector(target);
    if (el) return el;
  } catch {
    /* not a valid selector — fall through */
  }
  try {
    const el = document.querySelector(`[data-testid="${target}"]`);
    if (el) return el;
  } catch {
    /* invalid attribute value — fall through */
  }
  const want = target.trim().toLowerCase();
  if (!want || want.length > 60) return null;
  const candidates = document.querySelectorAll(
    'button, a, [role="button"], h1, h2, h3, th, label, [data-jarvis-readable]',
  );
  // Ranked match: exact text → substring → word overlap. The fuzzy tier exists
  // because the model often guesses a near-label ("Create Agent" for the button
  // that says "New Agent") — for a read-only visual ring, the best near-match
  // beats showing nothing. Overlap needs at least half the asked-for words
  // (ignoring tiny ones) to land on a candidate.
  const wantWords = want.split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
  let partial: Element | null = null;
  let fuzzy: Element | null = null;
  let fuzzyScore = 0;
  for (const el of candidates) {
    const text = (el as HTMLElement).innerText?.trim().toLowerCase() ?? '';
    if (!text || text.length > 120) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue; // not visible
    if (text === want) return el;
    if (!partial && (text.includes(want) || want.includes(text))) partial = el;
    if (wantWords.length > 0) {
      const hits = wantWords.filter((w) => text.includes(w)).length;
      const score = hits / wantWords.length;
      // Prefer higher overlap; on ties prefer the shorter (more specific) text.
      if (
        score >= 0.5 &&
        (score > fuzzyScore ||
          (score === fuzzyScore && fuzzy && text.length < ((fuzzy as HTMLElement).innerText?.length ?? Infinity)))
      ) {
        fuzzy = el;
        fuzzyScore = score;
      }
    }
  }
  return partial ?? fuzzy;
}

// ── Spotlight (cinematic highlight) ─────────────────────────────────
/**
 * Dims the whole page through a cutout over the target and frames it with a
 * glowing reticle + corner brackets + optional label tag. Scrolls the target
 * into view, tracks scroll/resize, and auto-dismisses.
 */
export function JarvisSpotlight(): preact.JSX.Element | null {
  const hl = jarvisHighlight.value;
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    if (!hl) {
      setRect(null);
      return;
    }
    const el = resolveSpotlightTarget(hl.target);
    if (!el) {
      setRect(null);
      return;
    }
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const track = () => setRect(el!.getBoundingClientRect());
    track();
    const t = setTimeout(() => {
      if (jarvisHighlight.value?.ts === hl.ts) jarvisHighlight.value = null;
    }, SPOTLIGHT_MS);
    window.addEventListener('scroll', track, true);
    window.addEventListener('resize', track);
    return () => {
      clearTimeout(t);
      window.removeEventListener('scroll', track, true);
      window.removeEventListener('resize', track);
    };
  }, [hl?.ts]);

  if (!hl || !rect) return null;
  const pad = 8;
  const labelBelow = rect.top < 64; // tag flips under the box when near the top
  return (
    <div class="jarvis-spotlight" aria-hidden="true" data-testid="jarvis-spotlight">
      <div
        class="jarvis-spotlight-cutout"
        style={{
          left: rect.left - pad,
          top: rect.top - pad,
          width: rect.width + pad * 2,
          height: rect.height + pad * 2,
        }}
      >
        <span class="jarvis-spotlight-corner tl" />
        <span class="jarvis-spotlight-corner tr" />
        <span class="jarvis-spotlight-corner bl" />
        <span class="jarvis-spotlight-corner br" />
        {hl.label && (
          <div class={`jarvis-spotlight-label ${labelBelow ? 'below' : ''}`}>{hl.label}</div>
        )}
      </div>
    </div>
  );
}

// ── Insight cards (show_card) ───────────────────────────────────────
function Sparkline({ values }: { values: number[] }): preact.JSX.Element | null {
  const d = useMemo(() => {
    if (values.length < 2) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    const span = max - min || 1;
    const pts = values.map((v, i) => {
      const x = (i / (values.length - 1)) * 100;
      const y = 26 - ((v - min) / span) * 22;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return { line: pts.join(' '), area: `0,28 ${pts.join(' ')} 100,28` };
  }, [values]);
  if (!d) return null;
  return (
    <svg class="jarvis-card-spark" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true">
      <polygon points={d.area} fill="rgba(43,210,255,0.12)" />
      <polyline
        points={d.line}
        fill="none"
        stroke="var(--jarvis-blue)"
        stroke-width="1.6"
        stroke-linejoin="round"
        stroke-linecap="round"
        vector-effect="non-scaling-stroke"
      />
    </svg>
  );
}

function CardView({ card }: { card: JarvisCard }): preact.JSX.Element {
  // Auto-expire: each card removes itself after its TTL (keyed by id so a
  // dismissed-then-reshown stack never kills the wrong card).
  useEffect(() => {
    const t = setTimeout(() => dismissJarvisCard(card.id), CARD_TTL_MS);
    return () => clearTimeout(t);
  }, [card.id]);
  return (
    <div class="jarvis-card" data-testid="jarvis-card">
      <div class="jarvis-card-head">
        <span class="jarvis-card-title">{card.title}</span>
        <button
          type="button"
          class="jarvis-card-x"
          aria-label="Dismiss card"
          onClick={() => dismissJarvisCard(card.id)}
        >
          <X class="w-3 h-3" />
        </button>
      </div>
      <div class="jarvis-card-metrics">
        {card.metrics.map((m) => (
          <div key={m.label} class="jarvis-card-metric">
            <span class="jarvis-card-metric-label">{m.label}</span>
            <span class="jarvis-card-metric-value">{m.value}</span>
            {m.delta && <span class={`jarvis-card-metric-delta ${m.tone}`}>{m.delta}</span>}
          </div>
        ))}
      </div>
      {card.spark.length > 0 && <Sparkline values={card.spark} />}
      {card.footer && <div class="jarvis-card-footer">{card.footer}</div>}
    </div>
  );
}

/** The floating card stack. Mounted once globally (widget) and on /jarvis. */
export function JarvisCardLayer(): preact.JSX.Element | null {
  const cards = jarvisCards.value;
  if (cards.length === 0) return null;
  return (
    <div class="jarvis-card-stack" role="status" aria-live="polite">
      {cards.map((c) => (
        <CardView key={c.id} card={c} />
      ))}
    </div>
  );
}

// ── Contextual suggestion chips ─────────────────────────────────────
const ROUTE_SUGGESTIONS: Array<{ prefix: string; prompts: string[] }> = [
  { prefix: '/agents', prompts: ['Which agents are unhealthy?', 'What models are my agents running?'] },
  { prefix: '/usage', prompts: ["Summarize this week's usage", 'Which day was the most expensive?'] },
  { prefix: '/cost', prompts: ["What's my spend today vs the weekly average?", 'Is spend trending up?'] },
  { prefix: '/audit', prompts: ["Anything unusual in today's audit log?"] },
  { prefix: '/sessions', prompts: ['Summarize the recent sessions'] },
  { prefix: '/kill-switches', prompts: ['Are any kill switches tripped?'] },
  { prefix: '/vectors', prompts: ['How big is the knowledge base?'] },
  { prefix: '/missions', prompts: ['What missions are open right now?'] },
  { prefix: '/hive', prompts: ["What's new in the hive mind?"] },
  { prefix: '/scheduled', prompts: ['What runs next on the schedule?'] },
  { prefix: '/warroom', prompts: ['Who is in the war room?'] },
];
const DEFAULT_SUGGESTIONS = ['What needs my attention today?', 'Give me a tour of the dashboard'];

/** The 1–2 suggested questions for a route (plus a screen-aware default). */
export function suggestionsForRoute(route: string): string[] {
  const path = (route.split('?')[0] || '/').replace(/\/+$/, '') || '/';
  const hit = ROUTE_SUGGESTIONS.find((s) => path === s.prefix || path.startsWith(s.prefix + '/'));
  return (hit ? [...hit.prompts, 'What am I looking at?'] : DEFAULT_SUGGESTIONS).slice(0, 3);
}
