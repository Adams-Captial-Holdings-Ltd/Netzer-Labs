/**
 * Jarvis browser tool registry + shared signals (Phase 0).
 *
 * The allowed routes come from the GET /api/jarvis/manifest RESPONSE — the
 * server `route-manifest.ts` is the authority. We do NOT derive routes from
 * NAV_ITEMS and keep no client ROUTES_BY_ROLE copy (Reference Contracts C).
 *
 * All three browser tools (navigate, read_view, highlight) are dispatched from
 * the relay's `tool_call` events through the single envelope. `read_view`
 * returns ONLY an allow-listed page summary — never a blanket #main-content
 * scrape (H2). The signals are shared with the /jarvis console now and with the
 * floating widget in Phase 1.
 */

import { signal } from '@preact/signals';

export type JarvisSessionState =
  | 'idle'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'error'
  | 'disabled';

export interface JarvisTurn {
  id: string;
  role: 'user' | 'jarvis';
  text: string;
  ts: number;
}
export interface JarvisNavEvent {
  route: string;
  label: string;
  ts: number;
}
export interface JarvisManifestRoute {
  route: string;
  label: string;
  section: string;
}
export interface JarvisManifestResource {
  resource: string;
  description: string;
  acceptedParams: string[];
  minRole: string;
}
export interface JarvisManifest {
  role: string;
  generatedAt: string;
  routes: JarvisManifestRoute[];
  resources: JarvisManifestResource[];
  jarvisEnabled: boolean;
  voiceEnabled: boolean;
  /** The deploy's default text model + the Claude models the picker offers. */
  model?: string;
  models?: Array<{ id: string; name: string }>;
}

// ── Shared signals ──────────────────────────────────────────────────
export const jarvisState = signal<JarvisSessionState>('idle');
export const jarvisCaption = signal<string>('');
export const jarvisTurns = signal<JarvisTurn[]>([]);
export const jarvisNavChip = signal<JarvisNavEvent | null>(null);
export const jarvisNavHistory = signal<JarvisNavEvent[]>([]);
// Spotlight request: a selector/test-id to ring on screen plus an optional short
// label tag naming what it is. ts keys the auto-dismiss timer.
export const jarvisHighlight = signal<{ target: string; label: string | null; ts: number } | null>(
  null,
);

// ── HUD insight cards (show_card) ───────────────────────────────────
// Display-only cards the model projects beside its spoken answer. Everything in
// here is clamped on arrival (shape, lengths, counts) and rendered as TEXT NODES
// only — a card can never carry markup or actions. Newest first, small cap.
export interface JarvisCardMetric {
  label: string;
  value: string;
  delta: string | null;
  tone: 'good' | 'bad' | 'neutral';
}
export interface JarvisCard {
  id: string;
  title: string;
  metrics: JarvisCardMetric[];
  spark: number[];
  footer: string | null;
  ts: number;
}
const MAX_CARDS = 3;
export const jarvisCards = signal<JarvisCard[]>([]);

export function dismissJarvisCard(id: string): void {
  jarvisCards.value = jarvisCards.value.filter((c) => c.id !== id);
}

/** Clamp arbitrary show_card input into a safe JarvisCard, or null if unusable. */
function sanitizeCard(input: Record<string, unknown>): JarvisCard | null {
  const title = String(input.title ?? '').slice(0, 60).trim();
  if (!title) return null;
  const rawMetrics = Array.isArray(input.metrics) ? input.metrics : [];
  const metrics: JarvisCardMetric[] = [];
  for (const m of rawMetrics.slice(0, 4)) {
    if (!m || typeof m !== 'object') continue;
    const mm = m as Record<string, unknown>;
    const label = String(mm.label ?? '').slice(0, 28).trim();
    const value = String(mm.value ?? '').slice(0, 24).trim();
    if (!label || !value) continue;
    const tone = mm.tone === 'good' || mm.tone === 'bad' ? mm.tone : 'neutral';
    metrics.push({
      label,
      value,
      delta: mm.delta != null ? String(mm.delta).slice(0, 16) : null,
      tone,
    });
  }
  if (metrics.length === 0) return null;
  const spark = (Array.isArray(input.spark) ? input.spark : [])
    .slice(0, 31)
    .map(Number)
    .filter((n) => Number.isFinite(n));
  const footer = input.footer != null ? String(input.footer).slice(0, 80).trim() : null;
  return { id: uid(), title, metrics, spark: spark.length >= 2 ? spark : [], footer, ts: Date.now() };
}
// The last on-screen summary read (by read_view or auto-read after a navigate),
// tagged with the route it was taken on. The text path reads this (via
// freshestViewForRoute) when building the next turn so the model carries what was
// most recently captured for the current page — in particular the page a prior
// turn's navigate auto-read into this signal AFTER that turn's synchronous
// readView() had already run (H2).
export const jarvisLastView = signal<{ route: string; summary: string; ts: number } | null>(null);
export const jarvisManifest = signal<JarvisManifest | null>(null);
export const jarvisEnabled = signal<boolean>(true);
// Voice-specific (Phase 1).
export const jarvisVoiceEnabled = signal<boolean>(true);
export const jarvisPushToTalk = signal<boolean>(localStorage.getItem('cce_jarvis_ptm') === 'true');
// Text-path model override ('' = the deploy default). Sent with every text
// turn; the SERVER validates it against its own Anthropic allowlist and falls
// back to the default on anything stale or unknown. Voice is Nova regardless.
const TEXT_MODEL_KEY = 'cce_jarvis_model';
export const jarvisTextModel = signal<string>(localStorage.getItem(TEXT_MODEL_KEY) ?? '');
export function setJarvisTextModel(id: string): void {
  jarvisTextModel.value = id;
  try {
    if (id) localStorage.setItem(TEXT_MODEL_KEY, id);
    else localStorage.removeItem(TEXT_MODEL_KEY);
  } catch {
    /* storage unavailable — keep the in-memory choice */
  }
}
export const jarvisMicPermission = signal<'unknown' | 'granted' | 'denied' | 'unavailable'>('unknown');

// The floating orb's X. Persisted so "close it" survives a reload; cleared when
// the user opens the /jarvis tab, which is how the orb comes back. Separate from
// jarvisEnabled, which is the ADMIN kill switch — a user dismissing the widget
// must not read as the fleet-wide feature being off.
const WIDGET_HIDDEN_KEY = 'cce_jarvis_widget_hidden';
export const jarvisWidgetHidden = signal<boolean>(localStorage.getItem(WIDGET_HIDDEN_KEY) === 'true');
export function setJarvisWidgetHidden(hidden: boolean): void {
  jarvisWidgetHidden.value = hidden;
  try {
    if (hidden) localStorage.setItem(WIDGET_HIDDEN_KEY, 'true');
    else localStorage.removeItem(WIDGET_HIDDEN_KEY);
  } catch {
    /* storage unavailable — keep the in-memory choice */
  }
}

// Draggable widget position (viewport px, top-left of the widget). null → use the
// default bottom-left CSS anchor. Persisted so a moved orb stays put across reloads.
const WIDGET_POS_KEY = 'cce_jarvis_widget_pos';
function loadWidgetPos(): { x: number; y: number } | null {
  try {
    const raw = localStorage.getItem(WIDGET_POS_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as { x?: unknown; y?: unknown };
    return typeof p.x === 'number' && typeof p.y === 'number' ? { x: p.x, y: p.y } : null;
  } catch {
    return null;
  }
}
export const jarvisWidgetPos = signal<{ x: number; y: number } | null>(loadWidgetPos());
/** Persist the dragged position (called on drag end, not on every move). */
export function saveWidgetPos(pos: { x: number; y: number }): void {
  jarvisWidgetPos.value = pos;
  try {
    localStorage.setItem(WIDGET_POS_KEY, JSON.stringify(pos));
  } catch {
    /* storage unavailable — keep the in-memory position */
  }
}

// ── Navigation binding (wouter setLocation, registered by the page) ──
let navigateFn: ((route: string) => void) | null = null;
export function registerNavigate(fn: (route: string) => void): void {
  navigateFn = fn;
}

function uid(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// ── Friendly errors ─────────────────────────────────────────────────
// The server speaks in raw codes (the SSE `error` event data and the voice
// `error` message both carry one of these), but a code is meaningless to a
// user. Map each known code to plain English plus a next step, centralized here
// so the text path, the voice path, and the console all render the same wording.
// Unknown codes fall back to a generic line. The raw code is kept available for
// support via console.debug at the call site and a title attribute on the row.
const JARVIS_ERROR_COPY: Record<string, string> = {
  rate_limited: 'Too many requests right now. Wait a few seconds and try again.',
  usage_unconfirmed: 'Could not confirm usage limits. Try again in a moment.',
  model_error: 'The assistant model had a problem. Try again.',
  no_model_configured: 'No assistant model is configured yet. Ask an administrator to set one.',
  cost_cap: 'The daily spend cap has been reached. Try again later or raise the cap.',
  bedrock_disabled: 'The assistant is paused by a kill switch. An administrator controls this.',
  internal_error: 'Something went wrong on our side. Try again in a moment.',
  connection_lost: 'Connection lost. Reconnecting…',
  connection_failed: 'Could not reach the assistant. Check your connection and try again.',
};

/**
 * Plain-English text for a raw Jarvis error code, with a next step. Unknown
 * codes get a generic fallback so the user never sees a bare token. The raw
 * code stays available to callers (they log it via console.debug and set it as
 * a title attribute) so support can still see exactly what fired.
 */
export function friendlyJarvisError(code: string): string {
  const key = (code || '').trim();
  return JARVIS_ERROR_COPY[key] ?? 'Something went wrong. Try again.';
}

// ── Manifest ────────────────────────────────────────────────────────
import { getToken } from '../api';

export async function loadJarvisManifest(): Promise<JarvisManifest | null> {
  try {
    const res = await fetch('/api/jarvis/manifest', {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) {
      jarvisEnabled.value = false;
      jarvisManifest.value = null;
      return null;
    }
    const m = (await res.json()) as JarvisManifest;
    jarvisManifest.value = m;
    jarvisEnabled.value = m.jarvisEnabled;
    // Seed voice-enabled from the manifest on mount so the "Voice is off" hint
    // shows proactively when voice is disabled, instead of only appearing after
    // a failed orb click. The voice client still flips this to false on a live
    // 503/4012 if voice is pulled mid-session.
    jarvisVoiceEnabled.value = m.voiceEnabled;
    return m;
  } catch {
    jarvisEnabled.value = false;
    jarvisManifest.value = null;
    return null;
  }
}

function routeAllowed(route: string): boolean {
  const m = jarvisManifest.value;
  if (!m) return false;
  const path = route.split('?')[0].replace(/\/+$/, '') || '/';
  if (path.split('/').includes('..')) return false; // mirror the server traversal guard
  return m.routes.some(
    (r) => path === r.route || (r.route !== '/' && path.startsWith(r.route + '/')),
  );
}

/** The route + query the user is currently looking at, surfaced to the model so
 *  it can reason about where it is without guessing. Path only (no hash). */
export function currentRoute(): { route: string; query: string } {
  return {
    route: location.pathname || '/',
    query: location.search ? location.search.replace(/^\?/, '') : '',
  };
}

/** Cap on any single read so a page's text cannot crowd the model context. */
const READ_VIEW_MAX_CHARS = 2000;

/**
 * Page summary for read_view, in strict precedence:
 *  1. a page-provided getJarvisSummary() hook (the RICH, curated summary), else
 *  2. [data-jarvis-readable] elements (opt-in readable regions), else
 *  3. '' — no blanket scrape. read_view returns ONLY allow-listed content (H2),
 *     so a page that registered neither a hook nor readable markers is silent.
 *
 * The opt-in design is the only read path: pages that curate their summary
 * (Cost, Overview, Kill Switches) expose it deliberately; everything else is
 * not readable rather than scraped wholesale.
 *
 * Settings/token routes and [data-jarvis-private] subtrees are excluded BEFORE
 * any DOM read so credential-bearing pages and subtrees are never read.
 */
export function readView(): string {
  const w = window as unknown as { getJarvisSummary?: () => string };
  if (typeof w.getJarvisSummary === 'function') {
    try {
      return String(w.getJarvisSummary()).slice(0, READ_VIEW_MAX_CHARS);
    } catch {
      /* curated hook threw — fall through to the readable-markers path */
    }
  }
  // Hard gate: never scrape settings/token routes by any DOM path below.
  if (/\/(settings|tokens)\b/i.test(location.pathname)) return '';
  const nodes = Array.from(document.querySelectorAll('[data-jarvis-readable]')).filter(
    (n) => !n.closest('[data-jarvis-private]'),
  );
  if (nodes.length > 0) {
    const readable = nodes
      .map((n) => (n as HTMLElement).innerText.trim())
      .filter(Boolean)
      .join(' • ')
      .slice(0, READ_VIEW_MAX_CHARS);
    if (readable) return readable;
  }
  return '';
}

/**
 * The freshest summary the client has for `route`, reconciling two sources:
 *  - a synchronous readView() of the DOM right now, and
 *  - jarvisLastView, which a prior turn's navigate auto-read AFTER that turn's own
 *    synchronous readView() had already run (the new page mounts a tick later).
 * Prefer jarvisLastView ONLY when it is for this same route AND carries content a
 * bare readView() doesn't have yet (e.g. the page reports its summary via a hook
 * that has since mounted). This is what lets the text path carry a navigated view
 * on the NEXT turn even though the SSE turn that navigated was one-way.
 */
export function freshestViewForRoute(route: string): string {
  const now = readView();
  const last = jarvisLastView.value;
  const here = (route || '/').split('?')[0].replace(/\/+$/, '') || '/';
  if (last) {
    const there = (last.route || '/').split('?')[0].replace(/\/+$/, '') || '/';
    // Same page, and the captured summary has content the live read is still
    // missing → use the captured one (the post-navigate auto-read beat us here).
    if (there === here && last.summary && !now) return last.summary;
  }
  return now;
}

/**
 * Read the on-screen summary AFTER the just-navigated page has had a chance to
 * mount and register its getJarvisSummary hook. wouter's setLocation re-renders
 * on the next tick and each page sets its hook in a post-render effect, so an
 * immediate read would catch the OLD page. We poll briefly for the new route's
 * hook (it replaces the previous one on mount) and resolve with whatever it
 * reports — a freshly mounted page legitimately answers "still loading".
 */
export function readViewAfterNavigate(expectedRoute: string, timeoutMs = 1200): Promise<string> {
  const target = expectedRoute.split('?')[0].replace(/\/+$/, '') || '/';
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const tick = () => {
      const here = (location.pathname || '/').replace(/\/+$/, '') || '/';
      const arrived = here === target || here.startsWith(target + '/');
      if (arrived) {
        // One more frame so the page's render/effect has flushed before we read.
        requestAnimationFrame(() => resolve(readView()));
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        resolve(readView());
        return;
      }
      setTimeout(tick, 60);
    };
    tick();
  });
}

export interface ToolCallResult {
  ok: boolean;
  result?: unknown;
}

/** Execute a relay-initiated browser tool. */
export function dispatchToolCall(toolName: string, input: Record<string, unknown>): ToolCallResult {
  switch (toolName) {
    case 'navigate': {
      const route = String(input.route ?? '');
      if (!routeAllowed(route)) return { ok: false, result: { error: 'ROUTE_FORBIDDEN', route } };
      navigateFn?.(route);
      const label = jarvisManifest.value?.routes.find((r) => r.route === route)?.label ?? route;
      const ev: JarvisNavEvent = { route, label, ts: Date.now() };
      jarvisNavChip.value = ev;
      jarvisNavHistory.value = [ev, ...jarvisNavHistory.value].slice(0, 25);
      // Auto-read the new view: once the page mounts, capture its summary into the
      // shared signal so the model can see what it just opened. The voice path's
      // server-side navigate follows up with its own read_view round-trip; the text
      // path is one-way for the turn that navigated, so it carries this captured
      // view on the NEXT turn via freshestViewForRoute (see textClient).
      void readViewAfterNavigate(route).then((summary) => {
        if (summary) jarvisLastView.value = { route, summary, ts: Date.now() };
      });
      return { ok: true, result: { route } };
    }
    case 'highlight': {
      const target = String(input.target ?? '');
      if (!target) return { ok: false, result: { error: 'NO_TARGET' } };
      jarvisHighlight.value = {
        target,
        label: input.label != null ? String(input.label).slice(0, 40) : null,
        ts: Date.now(),
      };
      return { ok: true };
    }
    case 'show_card': {
      const card = sanitizeCard(input);
      if (!card) return { ok: false, result: { error: 'BAD_CARD' } };
      jarvisCards.value = [card, ...jarvisCards.value].slice(0, MAX_CARDS);
      return { ok: true };
    }
    case 'read_view': {
      const { route } = currentRoute();
      // Prefer the freshest client-tracked view for this route: if a prior
      // navigate auto-read the (now-mounted) page into jarvisLastView, surface
      // that rather than a bare DOM read that may still be empty.
      const summary = freshestViewForRoute(route);
      jarvisLastView.value = { route, summary, ts: Date.now() };
      return { ok: true, result: { route, summary } };
    }
    default:
      return { ok: false, result: { error: 'UNKNOWN_TOOL', tool: toolName } };
  }
}

export function pushTurn(role: 'user' | 'jarvis', text: string): void {
  jarvisTurns.value = [...jarvisTurns.value, { id: uid(), role, text, ts: Date.now() }];
}

// ── Streaming assistant turns (text path) ───────────────────────────
// The text relay streams partial assistant transcripts (final:false) and a final
// one (final:true). Render the streamed text IN PLACE as one growing bubble
// rather than appending a turn per delta. `streamingId` tracks the live bubble; a
// final (or an explicit reset on a new turn / error) closes it so the next reply
// starts fresh.
let streamingId: string | null = null;

/** Clear any in-flight streamed bubble. Call at the start of a turn or on error. */
export function resetJarvisStream(): void {
  streamingId = null;
}

/** Upsert the live assistant bubble with `text`; when `final`, commit and close it. */
export function streamJarvisTurn(text: string, final: boolean): void {
  if (!text && !streamingId) return;
  const turns = jarvisTurns.value;
  if (streamingId) {
    jarvisTurns.value = turns.map((t) => (t.id === streamingId ? { ...t, text } : t));
  } else {
    const id = uid();
    streamingId = id;
    jarvisTurns.value = [...turns, { id, role: 'jarvis', text, ts: Date.now() }];
  }
  if (final) streamingId = null;
}
