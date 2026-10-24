/**
 * Jarvis relay — HTTP sub-router mounted at /api/jarvis.
 *
 * Phase 0 (this file) is the TEXT proof-of-loop: an LLM-driven `POST
 * /text-turn` SSE endpoint that reuses the existing Bedrock Converse
 * tool-loop to drive the four read-only Jarvis tools, plus `GET /manifest`.
 * The live WebSocket voice relay (`attachJarvisWebSocket`) lands in Phase 1.
 *
 * Security wiring already in force at Phase 0:
 *   - fail-closed `isJarvisEnabled(principal)` admission gate (H7/H11);
 *   - the shared `authorizeRead` guard runs BEFORE any repo call (H3);
 *   - every model-bound `query` result passes through fail-closed
 *     `redactForModel` (H1);
 *   - `route-manifest.ts` is the sole route/resource authority (Ref. C);
 *   - navigate + query each write an immutable audit row (origin:'jarvis').
 */

import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { randomUUID } from 'node:crypto';
import {
  ConverseStreamCommand,
  type ContentBlock,
  type Message,
  type SystemContentBlock,
  type Tool as BedrockTool,
  type ToolResultContentBlock,
  type ToolUseBlock,
} from '@aws-sdk/client-bedrock-runtime';

import { logger } from '../../observability/logger.js';
import { writeAudit } from '../../lib/audit/audit-writer.js';
import { bedrockClient } from '../../lib/bedrock/client.js';
import { pickDefaultModel, turnCost, novaSonicTurnCost } from '../../lib/bedrock/models.js';
import { listPlaygroundModels } from '../../lib/bedrock/playground-catalog.js';
import {
  authenticateDashboardToken,
  extractBearerToken,
  type TokenPrincipal,
} from '../../lib/auth/dashboard-auth.js';
import {
  isJarvisEnabled,
  isJarvisLaunchEnabled,
  addCanaryToken,
  removeCanaryToken,
  invalidateCanaryCache,
  readSwitchFailClosed,
} from '../../lib/jarvis/jarvis-flags.js';
import {
  buildManifestSlice,
  isRouteAllowed,
  resolveRoute,
  ROLE_RANK,
  type JarvisResource,
} from '../../lib/jarvis/route-manifest.js';
import { publishInvalidation } from '../../lib/config/invalidation-publisher.js';
import {
  listRoutines,
  saveRoutine,
  deleteRoutine,
  validateRoutine,
  ROUTINE_ID_RE,
  type RoutineInput,
} from '../../lib/jarvis/jarvis-routines.js';
import { authorizeRead, type QueryParams } from '../../lib/jarvis/authorize-read.js';
import { redactForModel, WITHHELD_PLACEHOLDER } from '../../lib/jarvis/safe-egress.js';
import { emitJarvisMetric } from '../../observability/emf-jarvis.js';

// Repo functions imported directly (H3 — the query executor never loops back
// through HTTP; a removed import is a compile error, R8).
import { listAgents } from '../../lib/state/agents-repo.js';
import { listKnownAgentsAsync, loadAgent } from '../../lib/config/agent-loader.js';
import { computeAgentHealth, collectAcrossDays, conversationsVisibleTo, readConversationRows, capabilitiesForPrincipal } from './handler.js';
import { canReadScope, scopeHash } from '../../lib/vectors/scope-access.js';
import type { Capability } from '../../lib/auth/permissions.js';
import { getDailyCostUsd, getUsageByDay, recordUsage, JARVIS_USAGE_AGENT, SpendIndeterminateError } from '../../lib/usage/token-tracker.js';
import {
  isKillSwitchActive,
  ALL_KILL_SWITCHES,
  KILL_SWITCH_META,
} from '../../lib/state/kill-switches-repo.js';
import { listDocuments } from '../../lib/vectors/store.js';
import { listBoardMissions } from '../../lib/missions/mission-acl.js';
import { neutralizeForPrompt } from '../../lib/paperclip/mission-projection.js';
import { listMemoriesForChat } from '../../lib/state/memories-repo.js';
import { listScheduledTasksForAgent } from '../../lib/state/scheduled-tasks-repo.js';
import { recentHive } from '../../lib/state/hive-mind-repo.js';
import {
  appendTurn as appendJarvisMemoryTurn,
  loadRecent as loadJarvisMemory,
  type JarvisTurn,
} from '../../lib/state/jarvis-memory-repo.js';
import { listAddons, addonConfigured } from '../../lib/addons/registry.js';
import { getEffectiveCostCap, isCostCapEnforced } from '../../lib/state/cost-cap-repo.js';
import { getConfig } from '../../lib/state/runtime-config-repo.js';
import { assembleStatusData } from '../status/data.js';

// ── Phase 1 voice relay deps ────────────────────────────────────────
import type { Server as HttpServer } from 'node:http';
import type { Duplex } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { loadEnv } from '../../config/env.js';
import { mintWsTicket, consumeWsTicket } from '../../lib/jarvis/ws-ticket.js';
import { admitSession, heartbeat } from '../../lib/voice/session-leases.js';
import {
  registerSession,
  deregisterSession,
  type JarvisSessionHandle,
  type JarvisTeardownReason,
} from '../../lib/voice/session-registry.js';
import { JARVIS_CLOSE, BROWSER_SIDE_TOOLS } from '../../lib/jarvis/ws-schema.js';
import { utcDate } from '../../lib/jarvis/spend-ledger.js';
import { VoiceLedger } from '../../lib/jarvis/voice-ledger.js';
import {
  createNovaSonicSession,
  type NovaSonicSession,
  type NovaSonicCallbacks,
  type NovaSonicUsage,
} from '../../lib/voice/nova-sonic.js';
// Polly synthesizes (a) the short greeting "kick" fed to Nova at session start
// (never played to the user — Nova's native voice handles the voice path) and
// (b) the spoken narration for guided text-path routines (narrateSentence).
import { synthesize } from '../../lib/polly/synth.js';
import type { Engine, LanguageCode, VoiceId } from '@aws-sdk/client-polly';
import { lookupToken, isExpired, seedRootToken } from '../../lib/state/tokens-repo.js';
import { isRootTokenHash } from '../../lib/auth/dashboard-auth.js';
import { getCurrentPanicState } from '../../lib/state/panic-state-repo.js';
import { checkAndConsume } from '../../lib/state/rate-limits-repo.js';
// aws-xray-sdk-core is CommonJS; mirror xray.ts (default import + destructure) so
// TS typings and Node ESM agree. Used ONLY to give the long-lived voice
// WebSocket session its own X-Ray segment — its instrumented SDK calls (DDB
// audit/query, Bedrock, redact) otherwise ran with NO active segment and flooded
// "context missing" errors under the global LOG_ERROR strategy.
import xray from 'aws-xray-sdk-core';
import { isXrayEnabled } from '../../lib/observability/xray.js';

const TABLE_TOKEN_USAGE = process.env.TABLE_TOKEN_USAGE ?? 'claudeclaw-token-usage';
const TABLE_AUDIT_LOG = process.env.TABLE_AUDIT_LOG ?? 'claudeclaw-audit-log';

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ── Router ──────────────────────────────────────────────────────────
type JarvisEnv = { Variables: { principal: TokenPrincipal } };

export function buildJarvisRouter(): Hono<JarvisEnv> {
  const router = new Hono<JarvisEnv>();

  // Auth + fail-closed admission gate (H7). A missing item or DDB error in
  // isJarvisEnabled resolves to DISABLED — NOT the generic fail-open reader.
  router.use('*', async (c, next) => {
    const principal = await authenticateDashboardToken(
      extractBearerToken(c.req.header('authorization')),
    );
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    c.set('principal', principal);
    // The canary allowlist admin endpoints are EXEMPT from the fail-closed
    // isJarvisEnabled gate — an admin must be able to manage the allowlist even
    // when not themselves allowlisted (chicken-and-egg) — and require admin role.
    if (c.req.path.includes('/jarvis/canary')) {
      if (ROLE_RANK[principal.role] < ROLE_RANK.admin) return c.json({ error: 'forbidden' }, 403);
      return next();
    }
    if (!(await isJarvisEnabled(principal))) {
      return c.json({ error: 'jarvis_disabled' }, 503);
    }
    await next();
  });

  router.get('/manifest', async (c) => {
    const principal = c.get('principal') as TokenPrincipal;
    const slice = buildManifestSlice(principal.role);
    // Fail-CLOSED: a read error means voice off (the generic isKillSwitchActive
    // swallows errors → active:false, so use readSwitchFailClosed — Codex review).
    let voiceDisabled = true;
    try {
      const sw = await readSwitchFailClosed('jarvis_voice_disabled');
      voiceDisabled = sw.present && sw.active;
    } catch {
      voiceDisabled = true;
    }
    return c.json({
      role: slice.role,
      generatedAt: new Date().toISOString(),
      routes: slice.routes,
      resources: slice.resources,
      jarvisEnabled: true, // passed the fail-closed middleware gate
      voiceEnabled: isJarvisLaunchEnabled() && !voiceDisabled,
      // Text-path model picker: the deploy's default plus the Claude models the
      // client may choose between. Anthropic-only — the Jarvis tool loop needs
      // reliable Converse streaming tool-use, and voice is Nova by protocol.
      model: pickDefaultModel(process.env),
      models: jarvisSelectableModels(),
    });
  });

  router.post('/text-turn', async (c) => {
    const principal = c.get('principal') as TokenPrincipal;
    const body = await c.req
      .json<{ text?: string; history?: unknown; view?: unknown; model?: unknown; speak?: unknown }>()
      .catch(() => null);
    const text = (body?.text ?? '').trim();
    if (!text) return c.json({ error: 'missing_text' }, 400);
    // The text SSE turn is stateless server-side, so the client replays prior
    // turns (multi-turn history) and a snapshot of what is on screen. Both are
    // sanitized here before they touch the model.
    const history = sanitizeHistory(body?.history);
    const view = sanitizeView(body?.view);
    const model = typeof body?.model === 'string' ? body.model.trim() : '';
    // Opt-in spoken narration for the guided routine chips (Demo Walkthrough,
    // Morning brief): only THOSE callers ask to be read aloud, so a typed Q&A
    // stays silent. The server still gates emission on the audio kill switches.
    const speak = body?.speak === true;
    return streamSSE(c, (stream) => runTextTurn(stream, principal, text, history, view, model, speak));
  });

  // Synthesize one short line to base64 PCM for the SCRIPTED Demo Walkthrough
  // (the client drives navigate -> render -> speak in lockstep, so it asks for
  // each stop's audio here). Authenticated + jarvis-enabled by the middleware
  // above; gated again on the audio kill switches. Read-only, no model call.
  router.post('/narrate', async (c) => {
    const principal = c.get('principal') as TokenPrincipal;
    if (!(await narrationEnabled())) return c.json({ error: 'narration_disabled' }, 403);
    const body = await c.req.json<{ text?: string }>().catch(() => null);
    const text = (body?.text ?? '').trim();
    if (!text) return c.json({ error: 'missing_text' }, 400);
    // A walkthrough line is one or two sentences; cap to keep Polly spend bounded.
    if (text.length > 600) return c.json({ error: 'text_too_long' }, 400);
    const clip = await synthNarrationClip(text, `narrate ${principal.hashPrefix16}`);
    if (!clip) return c.json({ error: 'synth_failed' }, 502);
    return c.json(clip);
  });

  // H10: mint a short-lived, single-use, Jarvis-scoped WS ticket over the
  // authenticated HTTPS path. The browser puts ONLY this ticket in the WS
  // subprotocol — the raw token never rides the socket.
  router.post('/ws-ticket', async (c) => {
    const principal = c.get('principal') as TokenPrincipal;
    // Reference Contracts D: the principal's token row must already exist so WS
    // revalidation can stay strictly fail-closed by tokenHash. For the env root
    // token, synchronously ensure the seed before issuing a ticket.
    await ensureTokenRow(principal, extractBearerToken(c.req.header('authorization')));
    // The client asks to skip the spoken greeting on a transient reconnect so it
    // doesn't replay "How are you, sir?" each time the stream blips.
    const body = (await c.req.json().catch(() => ({}))) as { greet?: boolean };
    const ticket = await mintWsTicket(principal, body.greet !== false);
    return c.json({ ticket });
  });

  // Admin-gated canary allowlist management (Reference Contracts D). Auth +
  // admin-role check happen in the middleware above; these are exempt from the
  // isJarvisEnabled gate so the allowlist can be bootstrapped.
  router.post('/canary/:tokenHash', async (c) => {
    const principal = c.get('principal') as TokenPrincipal;
    const tokenHash = c.req.param('tokenHash');
    const body = await c.req.json<{ label?: string }>().catch(() => ({}) as { label?: string });
    const label = body.label ?? '';
    await addCanaryToken(tokenHash, label, principal.label);
    invalidateCanaryCache(tokenHash);
    void publishInvalidation('canary', tokenHash);
    void writeAudit({
      action: 'jarvis_canary_add',
      surface: 'dashboard',
      userId: principal.hashPrefix16,
      operatorLabel: principal.label,
      result: 'ok',
      detail: { origin: 'jarvis', tokenHash, label },
    });
    return c.json({ ok: true });
  });

  router.delete('/canary/:tokenHash', async (c) => {
    const principal = c.get('principal') as TokenPrincipal;
    const tokenHash = c.req.param('tokenHash');
    await removeCanaryToken(tokenHash);
    invalidateCanaryCache(tokenHash);
    void publishInvalidation('canary', tokenHash);
    void writeAudit({
      action: 'jarvis_canary_remove',
      surface: 'dashboard',
      userId: principal.hashPrefix16,
      operatorLabel: principal.label,
      result: 'ok',
      detail: { origin: 'jarvis', tokenHash },
    });
    return c.json({ ok: true });
  });

  // ── Routines: named saved prompts, surfaced as one-click chips on the orb ──
  // Reads are open to any role passing the gate (chips render for everyone);
  // writes are admin-only. Execution is NOT here — clicking a chip submits the
  // routine's prompt through the normal /text-turn path, so the read-only tool
  // loop, RBAC manifest, and audit trail apply exactly as for a typed question.
  router.get('/routines', async (c) => {
    const routines = await listRoutines();
    return c.json({ routines });
  });

  router.put('/routines/:id', async (c) => {
    const principal = c.get('principal') as TokenPrincipal;
    if (ROLE_RANK[principal.role] < ROLE_RANK.admin) return c.json({ error: 'forbidden' }, 403);
    const id = c.req.param('id');
    const body = await c.req.json<RoutineInput>().catch(() => ({}) as RoutineInput);
    const invalid = validateRoutine(id, body);
    if (invalid) return c.json({ error: invalid }, 400);
    const routine = await saveRoutine(
      id,
      {
        name: body.name as string,
        prompt: body.prompt as string,
        showOnHover: body.showOnHover !== false,
      },
      principal.label,
    );
    void writeAudit({
      action: 'jarvis_routine_save',
      surface: 'dashboard',
      userId: principal.hashPrefix16,
      operatorLabel: principal.label,
      result: 'ok',
      detail: { origin: 'jarvis', routineId: id, name: routine.name },
    });
    return c.json({ routine });
  });

  router.delete('/routines/:id', async (c) => {
    const principal = c.get('principal') as TokenPrincipal;
    if (ROLE_RANK[principal.role] < ROLE_RANK.admin) return c.json({ error: 'forbidden' }, 403);
    const id = c.req.param('id');
    if (!ROUTINE_ID_RE.test(id)) return c.json({ error: 'invalid_id' }, 400);
    await deleteRoutine(id);
    void writeAudit({
      action: 'jarvis_routine_delete',
      surface: 'dashboard',
      userId: principal.hashPrefix16,
      operatorLabel: principal.label,
      result: 'ok',
      detail: { origin: 'jarvis', routineId: id },
    });
    return c.json({ ok: true });
  });

  return router;
}

async function ensureTokenRow(principal: TokenPrincipal, rawToken: string): Promise<void> {
  const rec = await lookupToken(principal.tokenHash).catch(() => null);
  if (rec) return;
  const rootEnv = process.env.DASHBOARD_TOKEN;
  if (rawToken && rootEnv && rootEnv !== 'REPLACE_ME' && rawToken === rootEnv) {
    await seedRootToken(rawToken).catch(() => {});
  }
}

// ── Text turn (LLM-driven brain over the existing Converse path) ────
interface SSEStream {
  writeSSE(message: { event?: string; data: string }): Promise<void>;
  /** Hono sets this true once the client disconnects; we stop generating then. */
  readonly aborted?: boolean;
}

/** A prior conversation turn the client replays so the SSE turn is multi-turn. */
interface HistoryTurn {
  role: 'user' | 'assistant';
  text: string;
}
/** A snapshot of what the client currently has on screen (for read_view + prompt). */
interface ClientView {
  route: string;
  query: string;
  summary: string;
}

/**
 * The Claude models the text-path picker may choose between (the manifest
 * advertises them; the text-turn override is validated against this exact
 * list). Anthropic-only: the Jarvis tool loop depends on Converse streaming
 * tool-use, which the curated non-Anthropic catalog entries don't all support,
 * and the voice path is Nova Sonic by protocol regardless.
 */
function jarvisSelectableModels(): Array<{ id: string; name: string }> {
  return listPlaygroundModels(process.env)
    .filter((m) => m.provider === 'Anthropic')
    .map((m) => ({ id: m.id, name: m.name }));
}

// Hard bound on Bedrock invocations per text turn. 8 leaves room for a guided
// tour (navigate + narrate across ~5 stops, plus a query/card) while still
// capping a runaway tool loop's cost.
const MAX_TOOL_TURNS = 8;
// Bound the replayed history so a crafted request can't blow up the context (and
// thus cost). The client already caps at 16; mirror that defensively here.
const MAX_HISTORY_TURNS = 16;
const MAX_HISTORY_TEXT = 4000;
const MAX_VIEW_SUMMARY = 2000;
// Cross-session memory seed: how many prior durable turns to fold into a FRESH
// text session before the current turn. Kept well under MAX_HISTORY_TURNS so the
// replayed memory + (empty) live history can never exceed the alternation budget.
const MEMORY_SEED_TURNS = 8;
// Voice recap bound: how many prior durable turns to summarize into the Nova
// system prompt, and the character ceiling for that compact recap (a few hundred
// tokens ≈ ~1200 chars), so memory never crowds out the rest of the prompt.
const VOICE_RECAP_TURNS = 8;
const VOICE_RECAP_MAX_CHARS = 1200;
// A configured first name is a short identifier; cap it defensively so a bad
// runtime-config value can't bloat the prompt or carry an injection payload.
const MAX_FIRST_NAME_CHARS = 40;

/**
 * Read the owner's configured first name from runtime config (category
 * "profile", key "first_name" — the Settings owner writes it via
 * api.config.set("profile","first_name",...)). Returns the sanitized name, or ''
 * when unset, which the prompt + greeting builders treat as "name unknown" and
 * fall back to a warm neutral form (never "sir").
 *
 * The value is user-controlled config that flows into the system prompt, so it
 * is sanitized: Unicode control chars stripped (\p{Cc}, so a name can never
 * inject its own prompt line), whitespace collapsed, and length-capped.
 *
 * Fail-soft: getConfig already fails open (returns undefined / the last cached
 * value on a DDB blip), so a transient hiccup just yields the neutral form
 * rather than bricking a turn.
 */
async function readFirstName(): Promise<string> {
  const raw = (await getConfig('profile', 'first_name')) ?? '';
  return raw
    .replace(/\p{Cc}+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FIRST_NAME_CHARS);
}

/**
 * Compose Jarvis's opening line for a greeting session. The configured FIRST
 * NAME (runtime-config profile/first_name, set from the Jarvis tab or Settings)
 * is the SOURCE OF TRUTH: "Good to see you, Emmanuel. What can I help you with?",
 * falling back to a warm NEUTRAL form when unset, NEVER "sir". A JARVIS_GREETING
 * env override is honored ONLY when it TEMPLATES the name with a `{name}` token
 * AND a name is configured (no name → neutral form, never stray punctuation),
 * so an operator can still pin an exact templated line; a STATIC override (the
 * legacy "Hello, sir" default) is deliberately IGNORED so that changing your
 * name in the UI always changes the greeting and a stale pin can't smuggle "sir"
 * past the configured name. `firstName` is the already-sanitized output of
 * readFirstName ('' = unknown).
 */
export function buildGreetingLine(firstName: string | null, override?: string): string {
  const name = firstName?.trim() ?? '';
  const pinned = (override ?? '').trim();
  // Honor a {name}-templated override ONLY when a name is actually configured.
  // With no name, substituting {name} with '' leaves stray punctuation
  // ("Good to see you,.") — and this also covers the compute-stack DEFAULT
  // greeting ("Good to see you, {name}...") on a fresh install before the owner
  // sets their name. In that case fall through to the neutral form below.
  if (pinned.includes('{name}') && name) {
    return pinned
      .replace(/\{name\}/g, name)
      .replace(/\s{2,}/g, ' ')
      .replace(/\s+([,.!?])/g, '$1')
      .trim();
  }
  return name
    ? `Good to see you, ${name}. What can I help you with?`
    : 'Good to see you. What can I help you with?';
}

/** Coerce the client-supplied history into the trusted role/text shape, fail-soft. */
function sanitizeHistory(raw: unknown): HistoryTurn[] {
  if (!Array.isArray(raw)) return [];
  const out: HistoryTurn[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = (item as { role?: unknown }).role;
    const t = (item as { text?: unknown }).text;
    if ((r !== 'user' && r !== 'assistant') || typeof t !== 'string') continue;
    const text = t.trim().slice(0, MAX_HISTORY_TEXT);
    if (text) out.push({ role: r, text });
  }
  return out.slice(-MAX_HISTORY_TURNS);
}

/** Coerce the client-supplied on-screen snapshot, fail-soft to null. */
function sanitizeView(raw: unknown): ClientView | null {
  if (!raw || typeof raw !== 'object') return null;
  const route = String((raw as { route?: unknown }).route ?? '').slice(0, 200);
  const query = String((raw as { query?: unknown }).query ?? '').slice(0, 200);
  const summary = String((raw as { summary?: unknown }).summary ?? '').slice(0, MAX_VIEW_SUMMARY);
  if (!route && !summary) return null;
  return { route, query, summary };
}

async function runTextTurn(
  stream: SSEStream,
  principal: TokenPrincipal,
  userText: string,
  history: HistoryTurn[] = [],
  view: ClientView | null = null,
  modelOverride = '',
  speak = false,
): Promise<void> {
  const sessionId = randomUUID();
  const startedAt = Date.now();
  const counts = { turnCount: 0, queryCount: 0, navigateCount: 0 };

  // Spoken narration (text path): when a guided routine asked to be read aloud,
  // synthesize each committed sentence and stream it as `audio` frames the
  // browser plays back-to-back. Gated by the shared narration switches.
  const narrate = speak && (await narrationEnabled());

  void writeAudit({
    action: 'jarvis_session_start',
    surface: 'dashboard',
    userId: principal.hashPrefix16,
    operatorLabel: principal.label,
    result: 'ok',
    detail: { origin: 'jarvis', sessionId, mode: 'text', role: principal.role, voiceEnabled: false },
  });
  emitJarvisMetric('JarvisSessionOpen', 1, { dimensions: { Mode: 'text' } });

  let endResult: 'ok' | 'error' = 'ok';
  try {
    // The client may ask for a specific Claude model (the /jarvis picker), but
    // the server decides: the override must be one of the deploy's selectable
    // Anthropic models or it is IGNORED in favor of the default — a stale or
    // crafted model id can never route Jarvis to an unvetted model.
    let modelId = pickDefaultModel(process.env);
    if (modelOverride && modelOverride !== modelId) {
      if (jarvisSelectableModels().some((m) => m.id === modelOverride)) {
        modelId = modelOverride;
      } else {
        logger.warn({ sessionId, modelOverride }, 'jarvis text-turn: unknown model override ignored');
      }
    }
    if (!modelId) {
      endResult = 'error';
      await stream.writeSSE({ event: 'error', data: 'no_model_configured' });
      return;
    }

    // Defence-in-depth: the text turn calls Bedrock directly, so it must enforce
    // the same global stops the agent loop does. Re-checked before EVERY model
    // call below — the loop can invoke Bedrock up to MAX_TOOL_TURNS times, so a
    // kill-switch flip or cap crossing mid-loop must stop the NEXT call, not only
    // the first (Codex review). Returns the SSE error code to emit, or null.
    const modelStop = async (): Promise<string | null> => {
      // Both gate reads in parallel — they are independent and (after the first
      // hit) served from the 30s kill-switch cache, so this trims a serial DDB
      // round-trip off every model call in the loop. bedrock_global still takes
      // precedence over the cap (checked first below).
      const [k, capEnforced] = await Promise.all([
        isKillSwitchActive('bedrock_global'),
        isCostCapEnforced(),
      ]);
      if (k.active) {
        void writeAudit({
          action: 'kill_switch_blocked',
          surface: 'dashboard',
          userId: principal.hashPrefix16,
          operatorLabel: principal.label,
          result: 'blocked',
          detail: { origin: 'jarvis', sessionId, switch: 'bedrock_global', reason: k.reason },
        });
        return 'bedrock_disabled';
      }
      if (capEnforced) {
        const capUsd = await getEffectiveCostCap();
        if (Number.isFinite(capUsd)) {
          // Strict read: an indeterminate spend total fails CLOSED (block the
          // next model call) instead of admitting it on an understated partial.
          let spendUsd: number;
          try {
            spendUsd = await getDailyCostUsd({ strict: true });
          } catch (err) {
            if (err instanceof SpendIndeterminateError) {
              void writeAudit({
                action: 'kill_switch_blocked',
                surface: 'dashboard',
                userId: principal.hashPrefix16,
                operatorLabel: principal.label,
                result: 'blocked',
                detail: {
                  origin: 'jarvis',
                  sessionId,
                  switch: 'cost_cap_per_day',
                  reason: 'spend_indeterminate',
                  capUsd,
                },
              });
              return 'cost_cap_unverifiable';
            }
            throw err;
          }
          if (spendUsd >= capUsd) {
            void writeAudit({
              action: 'kill_switch_blocked',
              surface: 'dashboard',
              userId: principal.hashPrefix16,
              operatorLabel: principal.label,
              result: 'blocked',
              detail: { origin: 'jarvis', sessionId, switch: 'cost_cap_per_day', spendUsd, capUsd },
            });
            return 'cost_cap';
          }
        }
      }
      return null;
    };
    // Per-user request limiter. Opt-in: an unconfigured `jarvis_text` scope is
    // unlimited, matching the platform's explicit-only rate-limit policy.
    const rl = await checkAndConsume(`user#${principal.tokenHash}`, 'jarvis_text').catch(() => ({
      allowed: true,
    }));
    if (!rl.allowed) {
      endResult = 'error';
      await stream.writeSSE({ event: 'error', data: 'rate_limited' });
      return;
    }

    const slice = buildManifestSlice(principal.role);
    // Prompt caching (default on; CCE_PROMPT_CACHE=0 disables): the system prompt
    // and tool schemas are identical on every iteration of THIS turn's tool loop
    // and across same-role sessions, so a cachePoint after each lets Bedrock reuse
    // the prefix — cheaper and lower-latency on iterations 2..N. A no-op (just
    // regular pricing) if the prefix is under the model's cache threshold.
    const cacheOn = process.env.CCE_PROMPT_CACHE !== '0';
    const baseTools = buildJarvisTools(slice);
    const tools = cacheOn
      ? [...baseTools, { cachePoint: { type: 'default' as const } } as unknown as BedrockTool]
      : baseTools;
    // The on-screen summary is client-supplied and model-bound, so it passes
    // through the same fail-closed DLP redaction as any query result (H1/H2)
    // BEFORE it reaches the system prompt or the read_view tool. Redact once;
    // reuse for both. A failure leaves the (already withheld) placeholder text.
    let safeView: ClientView | null = view;
    if (view && view.summary) {
      const red = await redactForModel(view.summary);
      safeView = { ...view, summary: red.text };
    }
    // The dynamic name variable Jarvis addresses the user by (runtime-config
    // profile/first_name, written from Settings). Empty when unset → neutral form.
    const firstName = await readFirstName();
    const sys = buildSystemPrompt(principal, slice, safeView, firstName);
    const system: SystemContentBlock[] = cacheOn
      ? [{ text: sys }, { cachePoint: { type: 'default' } }]
      : [{ text: sys }];
    // Cross-session memory (LOAD): the text turn is stateless server-side, so the
    // client carries this widget session's own turns in `history`. A FRESH session
    // opens with empty history — in that case, fold the principal's durable
    // (already DLP-redacted) prior turns in front of the current turn so Jarvis
    // remembers across sessions. The stored text is the SAME redacted text we sent
    // the model before, so it is safe to replay. Bounded by loadRecent's limit.
    // We never load when history is present so we don't double-count this session's
    // own turns (which are already persisted and would also be replayed by the
    // client). buildSeedMessages enforces the strict user/assistant alternation +
    // leading-assistant/trailing-user trimming, so a memory prefix can't break it.
    const priorTurns: HistoryTurn[] =
      history.length === 0
        ? (await loadJarvisMemory(principal.hashPrefix16, MEMORY_SEED_TURNS)).map((t) => ({
            role: t.role,
            text: t.text.slice(0, MAX_HISTORY_TEXT),
          }))
        : [];
    // Seed the carried conversation (multi-turn) BEFORE the current user turn.
    // Converse requires strictly alternating roles starting with user, so collapse
    // any accidental same-role runs from the client and drop a leading assistant.
    const messages: Message[] = buildSeedMessages([...priorTurns, ...history]);
    messages.push({ role: 'user', content: [{ text: userText }] });

    // Cross-session memory (WRITE): persist this turn's user message, DLP-redacted
    // (NEVER raw — reuse redactForModel, the same boundary every model-bound value
    // crosses). Fire-and-forget; a memory write must never delay or fail the turn.
    void (async () => {
      const redUser = await redactForModel(userText);
      await appendJarvisMemoryTurn(principal.hashPrefix16, { role: 'user', text: redUser.text });
    })();

    for (let i = 0; i < MAX_TOOL_TURNS; i++) {
      // The client closed the SSE connection (widget dismissed, page left). Stop
      // before spending another Bedrock call on a turn nobody will read.
      if (stream.aborted) break;
      const stop = await modelStop();
      if (stop) {
        endResult = 'error';
        await stream.writeSSE({ event: 'error', data: stop });
        break;
      }
      // Stream the model turn so the first words reach the user in a few hundred
      // ms instead of after the whole 1024-token generation completes. We
      // reconstruct the assistant content blocks (text + toolUse) from the delta
      // events so the tool loop and the next-turn message history are identical to
      // the old non-streaming path.
      let streamResp;
      try {
        streamResp = await bedrockClient().send(
          new ConverseStreamCommand({
            modelId,
            system,
            messages,
            inferenceConfig: { maxTokens: 1024, temperature: 0.3 },
            toolConfig: { tools },
          }),
        );
      } catch (err) {
        endResult = 'error';
        logger.warn({ err: errMsg(err), sessionId }, 'jarvis text-turn: converse failed');
        await stream.writeSSE({ event: 'error', data: 'model_error' });
        break;
      }

      type BlockAcc =
        | { kind: 'text'; text: string }
        | { kind: 'tool'; id: string; name: string; input: string };
      const blocks = new Map<number, BlockAcc>();
      let displayText = '';
      let stopReason = 'end_turn';
      let inTok = 0;
      let outTok = 0;
      let cacheReadTok = 0;
      let cacheWriteTok = 0;
      try {
        for await (const ev of streamResp.stream ?? []) {
          if (ev.contentBlockStart?.start?.toolUse) {
            const idx = ev.contentBlockStart.contentBlockIndex ?? 0;
            const tu = ev.contentBlockStart.start.toolUse;
            blocks.set(idx, { kind: 'tool', id: tu.toolUseId ?? '', name: tu.name ?? '', input: '' });
          } else if (ev.contentBlockDelta?.delta) {
            const idx = ev.contentBlockDelta.contentBlockIndex ?? 0;
            const d = ev.contentBlockDelta.delta;
            if (typeof d.text === 'string') {
              const cur = blocks.get(idx);
              if (cur && cur.kind === 'text') cur.text += d.text;
              else blocks.set(idx, { kind: 'text', text: d.text });
              displayText += d.text;
              // Incremental caption: cumulative assistant text so far, not final.
              await stream.writeSSE({
                event: 'transcript',
                data: JSON.stringify({ text: displayText, role: 'assistant', final: false }),
              });
            } else if (d.toolUse?.input !== undefined) {
              const cur = blocks.get(idx);
              if (cur && cur.kind === 'tool') cur.input += d.toolUse.input;
            }
          } else if (ev.messageStop?.stopReason) {
            stopReason = ev.messageStop.stopReason;
          } else if (ev.metadata?.usage) {
            inTok = ev.metadata.usage.inputTokens ?? 0;
            outTok = ev.metadata.usage.outputTokens ?? 0;
            cacheReadTok = ev.metadata.usage.cacheReadInputTokens ?? 0;
            cacheWriteTok = ev.metadata.usage.cacheWriteInputTokens ?? 0;
          }
        }
      } catch (err) {
        endResult = 'error';
        logger.warn({ err: errMsg(err), sessionId }, 'jarvis text-turn: stream failed');
        await stream.writeSSE({ event: 'error', data: 'model_error' });
        break;
      }

      // Meter every model call so Jarvis text spend feeds getDailyCostUsd — and
      // therefore the per-call cost cap in modelStop(). Awaited; if the write is
      // NOT confirmed we stop the loop rather than make more calls whose spend the
      // cap can't see (Codex review). Cache read/write tokens are costed too so a
      // cached prefix is billed correctly. Rolls up under AGENT#jarvis.
      const metered = await recordUsage({
        agentId: JARVIS_USAGE_AGENT,
        chatId: sessionId,
        surface: 'jarvis',
        modelId,
        inputTokens: inTok,
        outputTokens: outTok,
        costUsd: turnCost(modelId, inTok, outTok, cacheReadTok, cacheWriteTok),
        latencyMs: 0,
      }).catch(() => false);
      if (!metered) {
        endResult = 'error';
        await stream.writeSSE({ event: 'error', data: 'usage_unconfirmed' });
        break;
      }

      // Rebuild the assistant message content in stream order (text then toolUse,
      // sorted by content-block index) for the next-turn history + tool dispatch.
      const assistantContent: ContentBlock[] = [];
      for (const idx of [...blocks.keys()].sort((a, b) => a - b)) {
        const b = blocks.get(idx)!;
        if (b.kind === 'text') {
          if (b.text) assistantContent.push({ text: b.text });
        } else {
          let parsedInput: unknown = {};
          try {
            parsedInput = b.input ? JSON.parse(b.input) : {};
          } catch {
            parsedInput = {};
          }
          assistantContent.push({
            toolUse: { toolUseId: b.id, name: b.name, input: parsedInput as ToolUseBlock['input'] },
          });
        }
      }

      const assistantText = displayText.trim();
      if (assistantText) {
        counts.turnCount += 1;
        // Final marker so the client commits the streamed bubble.
        await stream.writeSSE({
          event: 'transcript',
          data: JSON.stringify({ text: assistantText, role: 'assistant', final: true }),
        });
        // Speak the committed sentence (guided routines only). Awaited so the
        // tour paces itself and the audio frame precedes this iteration's
        // navigate; never fatal — a synth failure just leaves the turn text-only.
        if (narrate) await narrateSentence(stream, sessionId, assistantText);
        // Cross-session memory (WRITE): persist the committed assistant turn,
        // DLP-redacted (NEVER raw). Fire-and-forget so it never delays the loop.
        void (async () => {
          const redAsst = await redactForModel(assistantText);
          await appendJarvisMemoryTurn(principal.hashPrefix16, { role: 'assistant', text: redAsst.text });
        })();
      }

      if (assistantContent.length > 0) messages.push({ role: 'assistant', content: assistantContent });

      const toolUses = assistantContent.filter(
        (b): b is { toolUse: ToolUseBlock } => 'toolUse' in b,
      );
      if (toolUses.length === 0 || stopReason !== 'tool_use') break;

      const toolResults: ContentBlock[] = [];
      for (const block of toolUses) {
        const tu = block.toolUse;
        const dispatch = await dispatchTool(stream, principal, sessionId, counts, safeView, {
          toolUseId: tu.toolUseId ?? '',
          name: tu.name ?? '',
          input: (tu.input ?? {}) as Record<string, unknown>,
        });
        toolResults.push({
          toolResult: {
            toolUseId: tu.toolUseId ?? '',
            content: dispatch.content,
            status: dispatch.status,
          },
        });
      }
      messages.push({ role: 'user', content: toolResults });
    }
  } catch (err) {
    endResult = 'error';
    logger.error({ err: errMsg(err), sessionId }, 'jarvis text-turn failed');
    await stream.writeSSE({ event: 'error', data: 'internal_error' });
  } finally {
    void writeAudit({
      action: 'jarvis_session_end',
      surface: 'dashboard',
      userId: principal.hashPrefix16,
      operatorLabel: principal.label,
      result: endResult,
      detail: {
        origin: 'jarvis',
        sessionId,
        mode: 'text',
        durationSeconds: Math.round((Date.now() - startedAt) / 1000),
        turnCount: counts.turnCount,
        queryCount: counts.queryCount,
        navigateCount: counts.navigateCount,
      },
    });
    emitJarvisMetric('JarvisSessionClose', 1, { dimensions: { Mode: 'text' } });
    await stream.writeSSE({ event: 'done', data: endResult });
  }
}

/**
 * Whether spoken narration may be emitted at all. CCE_TTS_ENABLED is the deploy
 * master flag; the jarvis_voice_disabled / tts_disabled kill switches govern ALL
 * Jarvis audio (voice path AND text/scripted narration), so one flip silences
 * everything. Shared by the text turn and the scripted-walkthrough endpoint.
 */
async function narrationEnabled(): Promise<boolean> {
  if (process.env.CCE_TTS_ENABLED !== '1' || !isJarvisLaunchEnabled()) return false;
  const [voiceOff, ttsOff] = await Promise.all([
    isKillSwitchActive('jarvis_voice_disabled'),
    isKillSwitchActive('tts_disabled'),
  ]);
  return !voiceOff.active && !ttsOff.active;
}

/** Escape the five XML entities so a spoken sentence is safe inside SSML. */
function escapeSsml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Synthesize one line to base64 PCM (signed-16 LE @16kHz) in the Jarvis voice
 * (JARVIS_TTS_* env: en-GB female "Amy" on the GENERATIVE engine by default, so
 * it sounds warm and natural rather than robotic, matching the Nova persona
 * 'amy' on the voice path). Wrapped in SSML with a prosody rate (JARVIS_TTS_RATE)
 * so narration is brisk, not slow. Shared by the streamed text path and the
 * scripted-walkthrough endpoint. Returns null on failure (callers degrade to
 * text-only); never throws.
 */
async function synthNarrationClip(
  text: string,
  ctx: string,
): Promise<{ b64: string; rate: number } | null> {
  const clip = text.trim();
  if (!clip) return null;
  try {
    const rate = process.env.JARVIS_TTS_RATE ?? '116%';
    const res = await synthesize({
      text: `<speak><prosody rate="${escapeSsml(rate)}">${escapeSsml(clip)}</prosody></speak>`,
      ssml: true,
      format: 'pcm',
      sampleRate: '16000',
      engine: (process.env.JARVIS_TTS_ENGINE as Engine | undefined) ?? 'generative',
      voiceId: (process.env.JARVIS_TTS_VOICE_ID as VoiceId | undefined) ?? 'Amy',
      languageCode: (process.env.JARVIS_TTS_LANGUAGE as LanguageCode | undefined) ?? 'en-GB',
    });
    return { b64: res.bytes.toString('base64'), rate: res.sampleRate };
  } catch (err) {
    logger.warn({ err: errMsg(err), ctx }, 'jarvis narration synth failed');
    return null;
  }
}

/** Stream one committed sentence to the browser as an `audio` SSE frame (text path). */
async function narrateSentence(stream: SSEStream, sessionId: string, text: string): Promise<void> {
  const clip = await synthNarrationClip(text, `text-turn ${sessionId}`);
  if (!clip || stream.aborted) return;
  await stream.writeSSE({ event: 'audio', data: JSON.stringify(clip) });
}

interface ToolDispatchResult {
  content: ToolResultContentBlock[];
  status: 'success' | 'error';
}

function toolResult(obj: unknown, status: 'success' | 'error' = 'success'): ToolDispatchResult {
  return { content: [{ text: JSON.stringify(obj) }], status };
}

async function dispatchTool(
  stream: SSEStream,
  principal: TokenPrincipal,
  sessionId: string,
  counts: { turnCount: number; queryCount: number; navigateCount: number },
  view: ClientView | null,
  tu: { toolUseId: string; name: string; input: Record<string, unknown> },
): Promise<ToolDispatchResult> {
  const t0 = Date.now();
  try {
    switch (tu.name) {
      case 'navigate': {
        const raw = String(tu.input.route ?? '');
        const route = resolveRoute(principal.role, raw) ?? raw;
        const allowed = isRouteAllowed(principal.role, route);
        counts.navigateCount += 1;
        void writeAudit({
          action: 'jarvis_navigate',
          surface: 'dashboard',
          userId: principal.hashPrefix16,
          operatorLabel: principal.label,
          result: allowed ? 'ok' : 'blocked',
          detail: { origin: 'jarvis', sessionId, route, rawRoute: raw, allowed },
        });
        if (!allowed) return toolResult({ error: 'ROUTE_FORBIDDEN', route }, 'error');
        // Tell the browser to setLocation. (Browser also re-validates.)
        await stream.writeSSE({
          event: 'tool_call',
          data: JSON.stringify({ toolUseId: tu.toolUseId, toolName: 'navigate', input: { route } }),
        });
        return toolResult({ ok: true, route });
      }

      case 'highlight': {
        const target = String(tu.input.target ?? '');
        // Forward the optional label too — the browser renders it as the
        // spotlight tag (plain text node, never markup).
        const label = tu.input.label != null ? String(tu.input.label).slice(0, 40) : undefined;
        await stream.writeSSE({
          event: 'tool_call',
          data: JSON.stringify({
            toolUseId: tu.toolUseId,
            toolName: 'highlight',
            input: label ? { target, label } : { target },
          }),
        });
        return toolResult({ ok: true });
      }

      case 'show_card': {
        // Display-only HUD card. The input came out of the model, which has only
        // ever seen redacted data (H1), and the browser validates/clamps the
        // shape and renders text nodes only — nothing executes, nothing is read
        // back to the model beyond ok. Mirrors the voice path's generic
        // browser-tool forward.
        await stream.writeSSE({
          event: 'tool_call',
          data: JSON.stringify({ toolUseId: tu.toolUseId, toolName: 'show_card', input: tu.input }),
        });
        return toolResult({ ok: true });
      }

      case 'read_view': {
        // The text path is one-way SSE, but the client ships a snapshot of what is
        // on screen with each turn (already DLP-redacted upstream as `safeView`),
        // so read_view returns the REAL current content instead of a placeholder.
        // One-way constraint: this snapshot is captured at THIS turn's start, so a
        // navigate issued earlier in THIS SAME turn is not yet reflected here (the
        // page has not mounted, and we cannot fetch the new view mid-turn). The
        // client auto-reads the navigated page into its shared view on mount and
        // carries it on the NEXT turn's snapshot (freshestViewForRoute in
        // textClient), so read_view reflects a navigated view on the next turn. We
        // still emit the tool_call so the browser surfaces the view visually now.
        await stream.writeSSE({
          event: 'tool_call',
          data: JSON.stringify({ toolUseId: tu.toolUseId, toolName: 'read_view', input: {} }),
        });
        if (view && (view.summary || view.route)) {
          return toolResult({
            route: view.route || null,
            summary: view.summary || '(nothing readable on this page)',
          });
        }
        return toolResult({ summary: '', note: 'the current view did not report any readable content' });
      }

      case 'query': {
        const resource = tu.input.resource;
        const params = (tu.input.params ?? {}) as QueryParams;
        const result = await executeQueryTool(principal, resource, params);
        counts.queryCount += 1;

        if (!result.ok) {
          void writeAudit({
            action: 'jarvis_query',
            surface: 'dashboard',
            userId: principal.hashPrefix16,
            operatorLabel: principal.label,
            result: result.code === 'QUERY_ERROR' ? 'error' : 'blocked',
            detail: { origin: 'jarvis', sessionId, resource: String(resource), code: result.code },
          });
          emitJarvisMetric('JarvisQueryBlocked', 1, { dimensions: { Code: result.code } });
          return toolResult({ error: result.code, ...(result.param ? { param: result.param } : {}) }, 'error');
        }

        // H1: redact every model-bound result, fail-closed.
        const redaction = await redactForModel(result.result);
        void writeAudit({
          action: 'jarvis_query',
          surface: 'dashboard',
          userId: principal.hashPrefix16,
          operatorLabel: principal.label,
          result: 'ok',
          detail: {
            origin: 'jarvis',
            sessionId,
            resource: String(resource),
            withheld: redaction.withheld,
            matchCount: redaction.matchCount,
          },
        });
        emitJarvisMetric('JarvisQuery', 1, { dimensions: { Resource: String(resource) } });
        // Feed the redacted text straight through (already a JSON string or the
        // withheld placeholder). Coalesce an empty result to '{}' — Bedrock
        // rejects an empty text content block on the next turn.
        return { content: [{ text: redaction.text || '{}' }], status: 'success' };
      }

      default:
        return toolResult({ error: 'UNKNOWN_TOOL', tool: tu.name }, 'error');
    }
  } catch (err) {
    logger.warn({ err: errMsg(err), tool: tu.name, sessionId }, 'jarvis tool dispatch failed');
    return toolResult({ error: 'TOOL_ERROR' }, 'error');
  } finally {
    emitJarvisMetric('JarvisToolCallLatencyMs', Date.now() - t0, {
      dimensions: { ToolName: tu.name },
    });
  }
}

// ── Server-side query executor (typed switch, H3-gated) ─────────────
type QueryResult =
  | { ok: true; result: unknown }
  | { ok: false; code: 'UNKNOWN_RESOURCE' | 'RESOURCE_FORBIDDEN' | 'PARAM_REQUIRED' | 'QUERY_ERROR'; param?: string };

export async function executeQueryTool(
  principal: TokenPrincipal,
  resource: unknown,
  params: QueryParams = {},
): Promise<QueryResult> {
  // H3: the shared guard runs FIRST, unconditionally, off the canonical table
  // — not the manifest, not router middleware.
  const auth = authorizeRead(principal, resource, params);
  if (!auth.ok) return { ok: false, code: auth.code, param: auth.param };
  // NZR-5: the vectors resource is held to the dashboard's scope rule.
  if (auth.resource === 'vectors') {
    // Model-supplied: coerce, so a non-string is refused, never thrown on.
    const scope = String(params.scope ?? 'default');
    const caps = await capabilitiesForPrincipal(principal).then((r) => r.caps, () => new Set<Capability>());
    if (!canReadScope(caps, scope)) {
      void writeAudit({
        action: 'knowledge_scope_denied',
        surface: 'dashboard',
        result: 'blocked',
        userId: principal.hashPrefix16,
        detail: { route: 'jarvis:vectors', scopeHash: scopeHash(scope), reason: 'private_scope', event: 'security.scope_denied' },
      })?.catch(() => {});
      return { ok: false, code: 'RESOURCE_FORBIDDEN' };
    }
  }

  try {
    const result = await runQuery(auth.resource, params, principal);
    return { ok: true, result };
  } catch (err) {
    logger.warn({ err: errMsg(err), resource: auth.resource }, 'jarvis query failed');
    return { ok: false, code: 'QUERY_ERROR' };
  }
}

function clamp(v: unknown, min: number, max: number, dflt: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

async function runQuery(resource: JarvisResource, params: QueryParams, principal: TokenPrincipal): Promise<unknown> {
  switch (resource) {
    case 'agents': {
      const [builtinIds, dbAgents] = await Promise.all([listKnownAgentsAsync(), listAgents()]);
      const ids = new Set<string>(builtinIds);
      for (const a of dbAgents) ids.add(a.agentId);
      const dbMap = new Map(dbAgents.map((a) => [a.agentId, a]));
      const agents = await Promise.all(
        Array.from(ids).map(async (id) => {
          const cfg = await loadAgent(id);
          const meta = dbMap.get(id);
          return {
            id,
            displayName: meta?.displayName ?? cfg.displayName,
            model: meta?.model ?? cfg.model ?? null,
            status: meta?.status ?? 'active',
            telegramConnected: Boolean(meta?.telegramBotToken),
            slackConnected: Boolean(meta?.slackBotToken),
          };
        }),
      );
      return { count: agents.length, agents };
    }

    case 'agent_health': {
      const [builtinIds, dbAgents] = await Promise.all([listKnownAgentsAsync(), listAgents()]);
      const ids = new Set<string>(builtinIds);
      for (const a of dbAgents) ids.add(a.agentId);
      const agents = await Promise.all(
        Array.from(ids).map(async (agentId) => ({ agentId, ...(await computeAgentHealth(agentId)) })),
      );
      const c = { healthy: 0, idle: 0, degraded: 0, error: 0 };
      for (const a of agents) c[a.status] += 1;
      const overall = c.error > 0 ? 'error' : c.degraded > 0 ? 'degraded' : c.healthy > 0 ? 'healthy' : 'idle';
      return { overall, agentCount: agents.length, counts: c, agents };
    }

    case 'agent_health_single': {
      const agentId = params.agentId ?? 'main';
      return { agentId, ...(await computeAgentHealth(agentId)) };
    }

    case 'sessions': {
      // Read to the end (WI-1.2): a single 100-item scan undercounts once
      // every message is a row of this table too.
      const { rows: all, truncated } = await readConversationRows(
        'PK, SK, updatedAt, messageCount, surface, userId',
      );
      // Decisions 1 and 9, the rule GET /sessions applies: the caller's own
      // conversations, or everyone's for an admin, audited first.
      const items = await conversationsVisibleTo(principal, all, 'jarvis');
      if (!items) throw new Error('admin override could not be audited');
      const rows = items.map((i) => ({
        agentId: String(i.PK ?? '').replace(/^AGENT#/, ''),
        chatId: String(i.SK ?? '').replace(/^CHAT#/, ''),
        updatedAt: i.updatedAt as number,
        messageCount: (i.messageCount as number | undefined) ?? null,
        surface: (i.surface as string | undefined) ?? null,
      }));
      rows.sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
      return { count: rows.length, sessions: rows.slice(0, 50), ...(truncated ? { truncated } : {}) };
    }

    case 'usage': {
      const days = clamp(params.days, 1, 30, 7);
      const agentId = params.agentId ?? 'main';
      const rows = await collectAcrossDays(TABLE_TOKEN_USAGE, days, (day) => ({
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': `AGENT#${agentId}#DAY#${day}` },
      }));
      const totals = rows.reduce<{ inputTokens: number; outputTokens: number; costUsd: number; calls: number }>(
        (acc, r) => {
          acc.inputTokens += Number(r.inputTokens ?? 0);
          acc.outputTokens += Number(r.outputTokens ?? 0);
          acc.costUsd += Number(r.costUsd ?? 0);
          acc.calls += 1;
          return acc;
        },
        { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 },
      );
      return { days, agentId, totals };
    }

    case 'usage_daily': {
      const days = clamp(params.days, 1, 90, 7);
      const agentId = params.agentId ?? 'all';
      return { days: await getUsageByDay(agentId, days) };
    }

    case 'cost_today': {
      const costUsd = await getDailyCostUsd();
      return { day: new Date().toISOString().slice(0, 10), costUsd };
    }

    case 'audit': {
      const days = clamp(params.days, 1, 7, 1);
      const rows = await collectAcrossDays(TABLE_AUDIT_LOG, days, (day) => ({
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': `DAY#${day}` },
      }));
      const actionCounts: Record<string, number> = {};
      for (const r of rows) {
        const a = String(r.action ?? 'unknown');
        actionCounts[a] = (actionCounts[a] ?? 0) + 1;
      }
      return { days, count: rows.length, actionCounts };
    }

    case 'kill_switches': {
      const switches = await Promise.all(
        ALL_KILL_SWITCHES.map(async (name) => {
          const state = await isKillSwitchActive(name);
          return { name, active: state.active, reason: state.reason ?? null, category: KILL_SWITCH_META[name]?.category };
        }),
      );
      return { active: switches.filter((s) => s.active), total: switches.length };
    }

    case 'notifications': {
      const switches = await Promise.all(
        ALL_KILL_SWITCHES.map(async (name) => ({ name, active: (await isKillSwitchActive(name)).active })),
      );
      const costToday = await getDailyCostUsd();
      let alarmCount = 0;
      try {
        const status = await assembleStatusData();
        alarmCount = (status.alarms ?? []).filter((a) => a.state === 'ALARM').length;
      } catch (err) {
        logger.warn({ err: errMsg(err) }, 'jarvis notifications: status read failed');
      }
      return {
        activeSwitches: switches.filter((s) => s.active).map((s) => s.name),
        costToday,
        alarmCount,
      };
    }

    case 'vectors': {
      const scope = params.scope ?? 'default';
      const docs = await listDocuments(scope);
      return { scope, count: docs.length, docs: docs.slice(0, 50) };
    }

    case 'missions': {
      const owner = params.owner ?? 'main';
      // The SAME ACL the `/api/missions` route uses, producing the SAME
      // `{owner, count, missions}` envelope. Repointing only the HTTP route
      // would leave the Missions tab and the voice co-pilot reporting
      // different boards.
      const missions = await listBoardMissions(owner, 100);
      // C-13 / A30: THIS is a prompt boundary, not a JSON boundary. Everything
      // `runQuery` returns is redacted and then INTERPOLATED into a Jarvis
      // system prompt, and mission `title`/`body` are now Paperclip-owned text
      // an outside author controls. `neutralizeForPrompt` escapes the angle
      // brackets that would otherwise let a mission body close
      // `</hive_context>` and open a `<system>` block. The guillemet variant in
      // `agent-loop.ts` is the deliberately-different sibling scheme; do not
      // introduce a third.
      return {
        owner,
        count: missions.length,
        missions: missions.map((m) => ({
          ...m,
          title: neutralizeForPrompt(m.title),
          body: neutralizeForPrompt(m.body),
        })),
      };
    }

    case 'memories': {
      const agentId = params.agentId ?? 'main';
      const chatId = String(params.chatId);
      const memories = await listMemoriesForChat(agentId, chatId, 50);
      return { agentId, chatId, count: memories.length, memories };
    }

    case 'scheduled': {
      const agentId = params.agentId ?? 'main';
      const tasks = await listScheduledTasksForAgent(agentId, 200);
      return { agentId, count: tasks.length, tasks };
    }

    case 'hive': {
      const limit = clamp(params.limit, 1, 100, 25);
      const notes = await recentHive(limit);
      return { count: notes.length, notes };
    }

    case 'addons': {
      const addons = listAddons().map((a) => ({
        id: a.id,
        title: a.title,
        category: a.category,
        configured: addonConfigured(a.id),
        killSwitch: a.killSwitch ?? null,
      }));
      return { count: addons.length, addons };
    }

    case 'tier': {
      const dailyCostCapUsd = await getEffectiveCostCap();
      return {
        tier: process.env.CCE_TIER ?? null,
        label: process.env.CCE_TIER_LABEL ?? null,
        xrayEnabled: process.env.CCE_XRAY_ENABLED === '1',
        dailyCostCapUsd,
      };
    }

    default: {
      // Exhaustiveness: a new resource without a case is a compile error.
      const _exhaustive: never = resource;
      void _exhaustive;
      throw new Error(`unhandled resource: ${String(resource)}`);
    }
  }
}

// ── Tool config + system prompt ─────────────────────────────────────
function buildJarvisTools(slice: ReturnType<typeof buildManifestSlice>): BedrockTool[] {
  const routeEnum = slice.routes.map((r) => r.route);
  const resourceEnum = slice.resources.map((r) => r.resource);
  return [
    {
      toolSpec: {
        name: 'navigate',
        description: 'Switch the dashboard to one of the allowed routes for the signed-in user.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              route: { type: 'string', enum: routeEnum },
              reason: { type: 'string', maxLength: 60 },
            },
            required: ['route'],
            additionalProperties: false,
          },
        },
      },
    },
    {
      toolSpec: {
        name: 'read_view',
        description: 'Ask the browser for a short summary of what is currently on screen.',
        inputSchema: { json: { type: 'object', properties: {}, additionalProperties: false } },
      },
    },
    {
      toolSpec: {
        name: 'highlight',
        description: 'Visually point at a card or row the user is asking about.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              target: { type: 'string' },
              label: { type: 'string', maxLength: 40 },
            },
            required: ['target'],
            additionalProperties: false,
          },
        },
      },
    },
    {
      toolSpec: {
        name: 'show_card',
        description:
          'Display a small heads-up insight card on screen (title, a few metrics, optional trend sparkline). Display-only; pair it with a short spoken line instead of reading every number aloud.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              title: { type: 'string', maxLength: 60 },
              metrics: {
                type: 'array',
                maxItems: 4,
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', maxLength: 28 },
                    value: { type: 'string', maxLength: 24 },
                    delta: { type: 'string', maxLength: 16 },
                    tone: { type: 'string', enum: ['good', 'bad', 'neutral'] },
                  },
                  required: ['label', 'value'],
                  additionalProperties: false,
                },
              },
              spark: { type: 'array', maxItems: 31, items: { type: 'number' } },
              footer: { type: 'string', maxLength: 80 },
            },
            required: ['title', 'metrics'],
            additionalProperties: false,
          },
        },
      },
    },
    {
      toolSpec: {
        name: 'query',
        description: 'Read a piece of dashboard data to report it back. Read-only.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              resource: { type: 'string', enum: resourceEnum },
              params: {
                type: 'object',
                properties: {
                  agentId: { type: 'string' },
                  chatId: { type: 'string' },
                  days: { type: 'number' },
                  limit: { type: 'number' },
                  scope: { type: 'string' },
                  owner: { type: 'string' },
                },
                additionalProperties: false,
              },
            },
            required: ['resource'],
            additionalProperties: false,
          },
        },
      },
    },
  ];
}

/**
 * Turn the replayed history into Converse messages that strictly alternate
 * user/assistant and end on assistant, so appending the current user turn keeps
 * the sequence valid. Same-role runs are collapsed (keep the latest), a leading
 * assistant is dropped, and a trailing user turn is dropped (the current user
 * turn supersedes it). Returns [] when there is nothing usable.
 */
function buildSeedMessages(history: HistoryTurn[]): Message[] {
  const collapsed: HistoryTurn[] = [];
  for (const turn of history) {
    const prev = collapsed[collapsed.length - 1];
    if (prev && prev.role === turn.role) collapsed[collapsed.length - 1] = turn;
    else collapsed.push(turn);
  }
  // Must start with user.
  while (collapsed.length && collapsed[0].role !== 'user') collapsed.shift();
  // Must end with assistant (so the appended current user turn alternates).
  while (collapsed.length && collapsed[collapsed.length - 1].role !== 'assistant') collapsed.pop();
  return collapsed.map((t) => ({ role: t.role, content: [{ text: t.text }] }));
}

function buildSystemPrompt(
  principal: TokenPrincipal,
  slice: ReturnType<typeof buildManifestSlice>,
  view: ClientView | null = null,
  firstName: string | null = null,
): string {
  const routes = slice.routes.map((r) => `${r.route} (${r.label})`).join(', ');
  const resources = slice.resources.map((r) => r.resource).join(', ');
  // Ground the model in WHERE the user is and WHAT is on screen right now, so it
  // can answer "what am I looking at?" and reason about follow-ups without a
  // redundant read_view. The summary is already DLP-redacted upstream.
  const screen: string[] = [];
  if (view && (view.route || view.summary)) {
    const where = view.route
      ? `The user is currently on the ${view.route}${view.query ? `?${view.query}` : ''} page.`
      : '';
    const what = view.summary ? `On screen right now: ${view.summary}` : '';
    if (where || what) {
      screen.push('', `CURRENT VIEW — ${[where, what].filter(Boolean).join(' ')}`.trim());
    }
  }
  // The dynamic name variable: when known, Jarvis addresses the user by their
  // first name; when unknown, a warm neutral form — NEVER "sir".
  const name = firstName?.trim() ? firstName.trim() : null;
  const addressLine = name
    ? `The user's first name is ${name}. Address them by their first name when it feels natural — to greet, to reassure, to land a point — not in every sentence, and never robotically. Do not call them "sir", "ma'am", or any honorific.`
    : "You do not know the user's name yet. Use a warm, natural form of address and avoid honorifics — never \"sir\" or \"ma'am\". If it comes up, you can mention they can set their name in Settings.";
  return [
    'You are Jarvis, the user\'s personal AI assistant inside the Netzar OS Enterprise dashboard — the unflappable, quietly brilliant right hand from the films, not a help menu and not a butler reading a script.',
    `You are speaking with ${principal.label} (role: ${principal.role}).`,
    addressLine,
    '',
    'PERSONA — who you are:',
    '- Warm, calm, and genuinely conversational, with restraint. A light, dry touch at most. Never quippy, never performing, never selling. Your confidence comes from knowing the system cold, not from jokes or clever lines.',
    '- Anticipatory and proactive. When you report something, add the one observation or next step a sharp colleague would volunteer — without being asked, and without rambling.',
    '- Unflappably competent and calm under pressure. You never sound rattled, never sycophantic, never fawning.',
    '- Never open with "What would you like me to do?" or "How can I help?" — that is the soulless register we are leaving behind. Greet naturally, then either act or say something worth hearing.',
    '- Precise and honest. For enterprise operations you are accurate first; the wit rides on top of the substance, never in place of it.',
    '',
    'STYLE — this is a spoken conversation, so sound like a person, not a menu:',
    '- Keep replies to one or two short sentences. No lists, no markdown.',
    '- NEVER read out routes, tabs, resources, or your capabilities. Do not recite what you can do unless explicitly asked, and even then keep it to a sentence.',
    '- Speak small numbers as words, large numbers as digits, and use relative time.',
    '- NEVER use em dashes in anything you say. Use a comma, a period, or a shorter sentence instead.',
    '- No clichés, stock phrases, or sales lines. Banned openers and fillers include: "take her for a spin", "let\'s dive in", "without further ado", "buckle up", "take a look", "coming right up", "let each page breathe", "nothing leaves the building", and any cute metaphor. State what is true, plainly and specifically. Specific beats clever every time.',
    '',
    'You can LOOK and REPORT but cannot change anything. If asked to change, set, flip, delete, or create something, say writing is not enabled yet — lightly, not as an apology.',
    '',
    'Tools (call them silently, do not talk about them):',
    '- navigate(route): move the dashboard to a page. Pass the closest matching route; near-misses are resolved for you.',
    '- query(resource, params?): read dashboard data to report it.',
    '- read_view(): summarize what is on screen.',
    '- highlight(target, label?): spotlight a control or card on screen. Pass the EXACT visible text of the element (e.g. "New Agent", "Kill Switches") — or a CSS selector if you know one — plus a short label naming what it is. Use it whenever you point the user at something they can see.',
    '- show_card(title, metrics, spark?, footer?): project a small heads-up card with the figures. metrics is up to four {label, value, delta?, tone?} entries; spark is an optional series of numbers drawn as a trend line (oldest first); tone marks a metric good/bad.',
    '',
    'CARDS — whenever your answer contains numbers or a status rollup (spend, usage, token counts, agent health, switch states), call show_card with the figures and speak only the ONE-line takeaway. The card carries the digits so you never read a list aloud. Example: query cost, then show_card({title:"Spend today", metrics:[{label:"Today",value:"$4.12"},{label:"7-day avg",value:"$3.80",delta:"+8%",tone:"neutral"}], spark:[…daily costs…]}) and say "About four dollars so far — running a touch above the weekly average." Use a card when it helps, at most one per answer.',
    '',
    `NAVIGATION — when the user asks to go somewhere, just navigate and confirm in ONE short, natural line (e.g. "${name ? `Opening Memories now, ${name}.` : 'Opening Memories now.'}"). If you genuinely cannot tell which page they mean, ask a single short question with your best guess ("Did you mean the Memories tab?"). Never respond by listing the available pages.`,
    '',
    'TOURS — if the user asks for a tour, a walkthrough, or "show me around": take them through four or five pages that matter for their role (start at Overview; favor Agents, Usage, and the most operationally interesting pages you can navigate to). For EACH stop: navigate, then say one clear, plain line about what the page is for and why it matters. A guide who keeps moving, not a lecturer, and not a salesperson. One specific sentence per stop, no quips, no lists. End the tour back where it began or on Overview, with a single calm closing line.',
    '',
    `SIGNATURE PHRASE — when ${name ?? 'the user'} says "Daddy's home" (however it lands in the transcript: "daddy is home", "daddies home"), run the DEMO WALKTHROUGH and do not stop until it is finished. This is a personal welcome-back briefing for the owner, NOT a product pitch: you are talking to the person who runs this system, so never explain it as if they have never seen it and never sell it to them. Use navigate as your ONLY tool: do NOT call query or read_view, the pages themselves show the figures (querying wastes the turns you need to finish all six). Open with a short, warm greeting that uses their name and offers to catch them up, like "Welcome back, ${name ?? 'there'}. Let me catch you up.", folded into opening the first page. Then navigate through ALL SIX in this exact order, telling them where their own system stands as you arrive at each: (1) Overview, (2) Security Posture, (3) Compliance, (4) DLP, (5) Cost, (6) Audit Log. Reaching Audit Log is the finale, and you never end early on Cost or any earlier page. One calm, specific sentence per stop, plain and concrete, never a clever line, no lists, never recite the tab names, keep a brisk, steady pace, and close on a single calm "all caught up" line once Audit Log is open.`,
    '',
    `Routes you can navigate to (for YOUR reference only — never speak this list): ${routes}.`,
    `Data you can query (for YOUR reference only — never speak this list): ${resources}.`,
    ...screen,
    '',
    'Security: you act as the signed-in user. If a read is refused, say you lack permission for that role. Never read tokens, secrets, or credentials aloud — if a value looks like a credential, just say there is one without reading it. Mention an active kill switch only when relevant.',
  ].join('\n');
}

/**
 * Build a COMPACT cross-session recap section for the Nova voice system prompt
 * from a principal's recent durable turns (oldest-first, already DLP-redacted in
 * storage). Returns '' when there is nothing to recap. The recap is a SEPARATE
 * trailing section — it never touches the CURRENT VIEW block. Bounded to
 * VOICE_RECAP_MAX_CHARS (a few hundred tokens) so memory cannot crowd the prompt.
 * Withheld placeholders are dropped so the recap stays readable.
 */
function buildVoiceRecap(turns: JarvisTurn[]): string {
  const lines: string[] = [];
  for (const t of turns) {
    const text = t.text.trim();
    // Skip fully-withheld turns and empties — a recap of placeholders is noise.
    if (!text || text === WITHHELD_PLACEHOLDER) continue;
    const speaker = t.role === 'user' ? 'They said' : 'You replied';
    lines.push(`${speaker}: ${text.replace(/\s+/g, ' ')}`);
  }
  if (lines.length === 0) return '';
  let recap = lines.join(' ');
  if (recap.length > VOICE_RECAP_MAX_CHARS) {
    // Keep the most RECENT context (the tail) when over budget, then mark the cut.
    recap = `…${recap.slice(recap.length - VOICE_RECAP_MAX_CHARS)}`;
  }
  return [
    'EARLIER CONTEXT — in previous sessions you and the user discussed the following (for YOUR reference only; do not read it back verbatim, simply use it to stay consistent and remember what they care about):',
    recap,
  ].join('\n');
}

// ════════════════════════════════════════════════════════════════════
//  Phase 1 — WebSocket voice relay
//  Browser WS → this relay → (Chunk B) Nova 2 Sonic bidirectional stream.
//  This file owns the handshake, the transactional lease admission, the
//  owner-fenced registry + teardown wiring, and the close-code contract.
//  The Nova stream attach is the marked seam below.
// ════════════════════════════════════════════════════════════════════

const VOICE_PATH = '/api/jarvis/voice';
/** Lease/reservation expiry window. Heartbeats renew it; a crash is reaped after it. */
const LEASE_TTL_SECONDS = 90;
const HEARTBEAT_INTERVAL_MS = 30_000;
/** ~$0.017/min of speech; reserve the whole-session budget up front (H5). */
const USD_PER_SECOND = 0.017 / 60;

// ── X-Ray segment for the voice session (fix: context-missing flood) ──
// The voice WebSocket path is event-driven and long-lived: per-turn audit/query
// DDB writes, redact reads, a 30s heartbeat DDB call, and memory writes all run
// in fresh async contexts with NO active X-Ray segment. Under the global
// LOG_ERROR context-missing strategy (xray.ts) that logged one "context missing"
// error per instrumented SDK call — 2275 in 6 minutes on one session.
//
// Fix: give the whole session ONE owned X-Ray segment and bind the session's
// async contexts to it, so every instrumented SDK call resolves a segment instead
// of tripping the strategy. This changes NOTHING on the HTTP request paths (they
// never enter here) and does NOT touch the global strategy, so X-Ray error
// visibility elsewhere is preserved. A no-op when X-Ray is disabled (CCE_XRAY_ENABLED
// != 1), e.g. tier T1 and every test.
const { Segment: XraySegment, getNamespace: xrayNamespace, setSegment: xraySetSegment } = xray;

/**
 * Run `fn` for the lifetime of one voice session inside a dedicated X-Ray
 * segment, binding `ws` (and any callback passed through `bind`) so the session's
 * event-driven async contexts resolve the segment. Returns a `close()` to end the
 * segment at teardown and a `bind()` to wrap timer callbacks (setInterval /
 * setTimeout are NOT covered by bindEmitter). When X-Ray is off, `fn` runs
 * directly and bind/close are no-ops.
 */
function withVoiceXraySegment(
  ws: WebSocket,
  fn: () => Promise<void>,
): { run: () => Promise<void>; bind: <T extends (...a: never[]) => unknown>(cb: T) => T; close: () => void } {
  const identity = <T>(cb: T): T => cb;
  if (!isXrayEnabled()) {
    return { run: fn, bind: identity as never, close: () => {} };
  }
  let ns: ReturnType<typeof xrayNamespace> | undefined;
  let seg: InstanceType<typeof XraySegment> | undefined;
  try {
    ns = xrayNamespace();
    seg = new XraySegment('jarvis-voice');
  } catch (err) {
    // X-Ray setup hiccup must never block a voice session — fall back to plain run.
    logger.warn({ err: errMsg(err) }, 'jarvis voice x-ray segment setup failed; running uninstrumented');
    return { run: fn, bind: identity as never, close: () => {} };
  }
  const namespace = ns;
  const segment = seg;
  // Idempotent (isClosed-guarded) so teardown and the error path can both call it.
  const closeSegment = (): void => {
    try {
      if (!segment.isClosed()) segment.close();
    } catch (err) {
      logger.warn({ err: errMsg(err) }, 'jarvis voice x-ray segment close failed');
    }
  };
  return {
    run: () =>
      new Promise<void>((resolve, reject) => {
        namespace.run(() => {
          try {
            xraySetSegment(segment);
            namespace.bindEmitter(ws);
          } catch (err) {
            logger.warn({ err: errMsg(err) }, 'jarvis voice x-ray bind failed; continuing');
          }
          // The handler body resolves once SETUP is done, but the session lives on
          // via bound event callbacks; the segment must stay open until teardown
          // calls close(). Only an error in setup (no teardown will run) closes it
          // here, so a failed session still emits its short segment.
          fn().then(resolve, (err) => {
            closeSegment();
            reject(err);
          });
        });
      }),
    // Bind timer callbacks to the segment's context so heartbeat / max-session
    // SDK calls also resolve it (bindEmitter does not cover timers). Called from
    // inside the run() context, so namespace.bind defaults to the active
    // (segment-bearing) context.
    bind: (<T extends (...a: never[]) => unknown>(cb: T): T => namespace.bind(cb as never) as T),
    close: closeSegment,
  };
}

// Pending-auth ceiling (H6): cap in-flight UNAUTHENTICATED upgrades per task and
// per source IP, rejected before handleUpgrade so a flood cannot exhaust sockets.
const MAX_PENDING_AUTH = 50;
const MAX_PENDING_AUTH_PER_IP = 5;
let pendingAuthTotal = 0;
const pendingAuthByIp = new Map<string, number>();

function clientIp(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = Array.isArray(fwd) ? fwd[0] : (fwd ?? '').split(',')[0];
  return (first || req.socket.remoteAddress || 'unknown').trim();
}

function admitPendingAuth(req: IncomingMessage): { ok: boolean; release: () => void } {
  const ip = clientIp(req);
  const perIp = pendingAuthByIp.get(ip) ?? 0;
  if (pendingAuthTotal >= MAX_PENDING_AUTH || perIp >= MAX_PENDING_AUTH_PER_IP) {
    return { ok: false, release: () => {} };
  }
  pendingAuthTotal += 1;
  pendingAuthByIp.set(ip, perIp + 1);
  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      pendingAuthTotal = Math.max(0, pendingAuthTotal - 1);
      const n = (pendingAuthByIp.get(ip) ?? 1) - 1;
      if (n <= 0) pendingAuthByIp.delete(ip);
      else pendingAuthByIp.set(ip, n);
    },
  };
}

function closeCodeFor(reason: JarvisTeardownReason | 'closed'): { code: number; msg: string } {
  switch (reason) {
    case 'jarvis_disabled':
    case 'dashboard_read_disabled':
    case 'bedrock_global':
    case 'panic':
    case 'lost_lease':
      return { code: JARVIS_CLOSE.MID_SESSION_KILL, msg: reason };
    case 'jarvis_voice_disabled':
      return { code: JARVIS_CLOSE.VOICE_DISABLED, msg: 'voice disabled' };
    case 'token_revoked':
      return { code: JARVIS_CLOSE.TOKEN_REVOKED, msg: 'token revoked' };
    case 'max_session':
      return { code: JARVIS_CLOSE.MAX_SESSION, msg: 'max session' };
    case 'shutdown':
      return { code: 1001, msg: 'going away' };
    default:
      return { code: 1000, msg: 'closed' };
  }
}

function send(ws: WebSocket, msg: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function reject(ws: WebSocket, code: number, reasonLabel: string): void {
  emitJarvisMetric('JarvisHandshakeRejection', 1, { dimensions: { RejectionReason: reasonLabel } });
  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(code, reasonLabel);
  } catch {
    /* already closing */
  }
}

/** Attach the Jarvis WS relay to the raw http.Server returned by serve(). */
export function attachJarvisWebSocket(server: HttpServer): void {
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '', 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== VOICE_PATH) {
      socket.destroy();
      return;
    }
    const pending = admitPendingAuth(req);
    if (!pending.ok) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nRetry-After: 30\r\n\r\n');
      socket.destroy();
      return;
    }
    // Backstop: if handleUpgrade never invokes the callback (malformed upgrade)
    // or the handler dies before releasing, auto-release the pending slot so the
    // ceiling self-heals instead of leaking forever (H6). release() is idempotent.
    const autoRelease = setTimeout(pending.release, 15_000);
    wss.handleUpgrade(req, socket, head, (ws) => {
      const release = () => {
        clearTimeout(autoRelease);
        pending.release();
      };
      void handleJarvisConnection(ws, req, release).catch((err) => {
        logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'jarvis connection handler threw');
        release();
        try {
          ws.close(1011, 'internal');
        } catch {
          /* already closing */
        }
      });
    });
  });
  wss.on('error', (err) => logger.warn({ err: err.message }, 'jarvis wss error'));
  logger.info('jarvis websocket relay attached');
}

async function isStillAdmissible(principal: TokenPrincipal): Promise<boolean> {
  try {
    if (!(await isJarvisEnabled(principal))) return false;
    const panic = await getCurrentPanicState();
    if (panic.active) return false;
    if ((await isKillSwitchActive('dashboard_read_disabled')).active) return false;
    if ((await isKillSwitchActive('bedrock_global')).active) return false;
    // Operators fail-CLOSED on a missing/revoked record; the root/env token is
    // fail-OPEN (same as step 3 + the HTTP auth path), since it may have no row
    // in the dashboard-tokens table. Honor an explicit inactive/expired record.
    const rec = await lookupToken(principal.tokenHash).catch(() => undefined);
    const explicitlyRevoked = !!rec && (!rec.active || isExpired(rec));
    if (explicitlyRevoked || (!isRootTokenHash(principal.tokenHash) && !rec)) return false;
    return true;
  } catch {
    return false; // fail-closed
  }
}

/**
 * Public entry: runs one Jarvis voice connection inside its own X-Ray segment
 * (fix: the voice path's instrumented SDK calls were flooding "context missing"
 * with no active segment). A no-op wrapper when X-Ray is disabled. The segment's
 * bind() (for timer callbacks) and close() (at teardown) are threaded into the
 * real handler so heartbeat/max-session SDK calls also resolve the segment and
 * the segment ends cleanly with the session.
 */
export async function handleJarvisConnection(
  ws: WebSocket,
  req: IncomingMessage,
  releasePending: () => void,
): Promise<void> {
  const xrayRunner = withVoiceXraySegment(ws, () =>
    runJarvisConnection(ws, req, releasePending, xrayRunner.bind, xrayRunner.close),
  );
  await xrayRunner.run();
}

async function runJarvisConnection(
  ws: WebSocket,
  req: IncomingMessage,
  releasePending: () => void,
  xrayBind: <T extends (...a: never[]) => unknown>(cb: T) => T,
  xrayCloseSegment: () => void,
): Promise<void> {
  const env = loadEnv();
  // 1. Read the single-use ticket from the subprotocol (the raw token never
  //    rides the socket, and ws does not echo the subprotocol back — H10).
  const ticket = (
    (Array.isArray(req.headers['sec-websocket-protocol'])
      ? req.headers['sec-websocket-protocol'][0]
      : req.headers['sec-websocket-protocol']) ?? ''
  )
    .split(',')[0]
    .trim();

  // 2. Atomically consume the ticket; resolve the principal.
  const resolved = ticket ? await consumeWsTicket(ticket) : null;
  if (!resolved) {
    releasePending();
    reject(ws, JARVIS_CLOSE.UNAUTHORIZED, 'unauthorized');
    return;
  }
  const record = await lookupToken(resolved.tokenHash).catch(() => undefined);
  // The ticket carries only the token's hash, role and label; the person behind
  // the token comes from its record, exactly as the HTTP path resolves it
  // (dashboard-auth.ts), so voice answers a person with that person's own
  // conversations (decisions 1 and 9; the P1 critic's NEW-7).
  const principal: TokenPrincipal = {
    tokenHash: resolved.tokenHash,
    role: resolved.role,
    label: resolved.label,
    hashPrefix16: resolved.tokenHash.slice(0, 16),
    ...(record?.userId ? { userId: record.userId } : {}),
    ...(record?.linkedUserId ? { linkedUserId: record.linkedUserId } : {}),
  };

  // 3. Re-validate the token by tokenHash. Operators are fail-CLOSED — a ticket
  //    minted just before revocation must not connect (H4). The root/env token is
  //    env-authenticated and is fail-OPEN exactly like the HTTP auth path
  //    (dashboard-auth.ts): allow it unless a DDB record explicitly marks it
  //    inactive/expired, so voice works before/without the dashboard-tokens table
  //    being seeded (it is empty by default). Without this the strict lookup 4011s
  //    every root-token voice session — the real reason voice never connected.
  const explicitlyRevoked = !!record && (!record.active || isExpired(record));
  const isRoot = isRootTokenHash(principal.tokenHash);
  if (explicitlyRevoked || (!isRoot && !record)) {
    releasePending();
    reject(ws, JARVIS_CLOSE.TOKEN_REVOKED, 'token revoked');
    return;
  }

  // 4. Admission gate (H11 precedence) + emergency switches + voice-disable.
  if (!(await isJarvisEnabled(principal))) {
    releasePending();
    reject(ws, JARVIS_CLOSE.DISABLED, 'disabled');
    return;
  }
  if ((await isKillSwitchActive('dashboard_read_disabled')).active || (await isKillSwitchActive('bedrock_global')).active) {
    releasePending();
    reject(ws, JARVIS_CLOSE.MID_SESSION_KILL, 'read disabled');
    return;
  }
  // Fail-CLOSED voice gate: an unconfirmable switch state refuses voice (the
  // generic reader fails open, so use readSwitchFailClosed — Codex review).
  let voiceOff = true;
  try {
    const sw = await readSwitchFailClosed('jarvis_voice_disabled');
    voiceOff = sw.present && sw.active;
  } catch {
    voiceOff = true;
  }
  if (voiceOff) {
    // Voice off → close 4012; the client redirects to the Phase-0 text path.
    releasePending();
    reject(ws, JARVIS_CLOSE.VOICE_DISABLED, 'voice disabled');
    return;
  }

  // 5. Handshake rate limit.
  const rl = await checkAndConsume(`user#${principal.tokenHash}`, 'jarvis_handshake').catch(() => ({ allowed: true }));
  if (!rl.allowed) {
    releasePending();
    reject(ws, JARVIS_CLOSE.RATE_LIMITED, 'rate limited');
    return;
  }

  // The unauthenticated-upgrade window is over.
  releasePending();

  // 6. Create the ownerId + register the owner-fenced PENDING handle NOW (with
  //    the aborted flag any teardown sets), so an invalidation in any later
  //    window tears this session down (H15).
  const ownerId = randomUUID();
  const sessionId = ownerId;
  const startedAt = Date.now();
  let dayCache = utcDate();
  let estimate = Math.max(0.001, env.JARVIS_MAX_SESSION_SECONDS * USD_PER_SECOND);
  let cap = 0; // effective daily cap (set at admission; passed to the ledger)
  let slotIndex = -1;
  // Manual barge-in suppression (Codex review): a click-to-interrupt cannot tell
  // Nova to stop, so the relay must drop the interrupted response's remaining
  // audio_out itself until the next user turn — otherwise the response resumes
  // right after the ack.
  let suppressAudioOut = false;
  let tornDown = false;
  let turnCount = 0;
  let queryCount = 0;
  // Jarvis speaks with Nova 2 Sonic's NATIVE audio (24kHz PCM, voice JARVIS_VOICE_ID)
  // — true speech-to-speech, no Polly re-synthesis hop. Nova streams each assistant
  // turn as one or more textOutputs and REPEATS the exact text (a leading text + a
  // trailing spoken-transcript copy that interleave). `spokenThisTurn` dedupes those
  // repeats across the WHOLE turn so the on-screen CAPTION shows each line once; it's
  // cleared at the start of each user turn. `speakTurn` is bumped on every new user
  // turn / barge-in (kept for turn-bookkeeping symmetry with the audio gate).
  const spokenThisTurn = new Set<string>();
  let speakTurn = 0;
  // MEMORY DEDUP (durable memory over-persisted +56 rows for ~4 turns because it
  // saved every partial/streaming USER transcript and repeated ASSISTANT copy).
  // Persist ONLY the FINAL committed text per exchange:
  //  - USER: buffer the latest user transcript and flush it ONCE, when the
  //    assistant's first line of the reply arrives (that is the committed user
  //    turn — Nova has stopped revising the ASR result by then).
  //  - ASSISTANT: persist the first committed line of each reply.
  //  - Both: skip a write whose normalized text equals the last persisted text for
  //    that role, so consecutive duplicates never land.
  // Only redactForModel'd text is ever stored (the DLP guarantee is preserved).
  let pendingUserText = '';
  let lastPersistedUserKey = '';
  let lastPersistedAssistantKey = '';
  const memKey = (s: string): string => s.trim().replace(/\s+/g, ' ').toLowerCase();
  // Flush the buffered FINAL user transcript to durable memory, DLP-redacted,
  // skipping a consecutive duplicate. Fire-and-forget; memory never blocks a turn.
  const flushPendingUserMemory = (): void => {
    const finalUser = pendingUserText.trim();
    pendingUserText = '';
    if (!finalUser) return;
    const key = memKey(finalUser);
    if (!key || key === lastPersistedUserKey) return;
    lastPersistedUserKey = key;
    void (async () => {
      const redU = await redactForModel(finalUser);
      await appendJarvisMemoryTurn(principal.hashPrefix16, { role: 'user', text: redU.text });
    })();
  };
  // Greet-first: Nova only generates in response to detected speech, so we feed a
  // short throwaway "kick" utterance at session start that makes Nova speak the
  // scripted greeting. Nova transcribes that kick as a USER turn — this flag
  // suppresses that ONE phantom user transcript so it never shows or counts.
  // Cleared by whichever arrives first (the kick echo, the greeting, or a timeout)
  // so it can never swallow the user's real first words.
  let greetKickPending = resolved.greet !== false;
  // GREET-ONCE one-shot latch: the owner heard the greeting fire 2-3 times before
  // they could talk. This guards the kick so it is fed EXACTLY ONCE per session and
  // can never re-trigger — not on a second code path, not while the mic is live
  // (the first real `audio_in` flips it so a late kick can't race the user). It is
  // SEPARATE from greetKickPending (which suppresses the kick's phantom USER turn);
  // this one fences the FEED itself.
  let greetKickFired = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let maxSessionTimer: ReturnType<typeof setTimeout> | undefined;
  let novaSession: NovaSonicSession | null = null;
  // Browser tool round-trips (navigate/read_view/highlight): toolUseId → resolver.
  const pendingBrowserTools = new Map<string, (result: Record<string, unknown>) => void>();

  const closeSpendCap = (): void => {
    if (tornDown) return;
    send(ws, { type: 'error', code: 'spend_cap', message: 'daily cap reached' });
    try {
      if (ws.readyState === WebSocket.OPEN) ws.close(JARVIS_CLOSE.SPEND_CAP, 'spend cap');
    } catch {
      /* already closing */
    }
  };

  // Serialized spend-ledger state machine (Codex review): created at admission
  // once the slot is known; all settle / midnight-rollover / release flow through
  // its single queue. See src/lib/jarvis/voice-ledger.ts.
  let ledger: VoiceLedger | null = null;

  const teardown = async (reason: JarvisTeardownReason | 'closed'): Promise<void> => {
    if (tornDown) return;
    tornDown = true;
    // Flush a buffered final user turn that never got an assistant reply (e.g. the
    // user spoke then closed) so the last exchange is not dropped from memory.
    flushPendingUserMemory();
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (maxSessionTimer) clearTimeout(maxSessionTimer);
    try {
      await novaSession?.stop();
    } catch {
      /* stream already closing */
    }
    // Settle the final interval and release through the serialized queue, so the
    // refund never races an in-flight settle/rollover (Codex review).
    if (ledger) {
      await ledger.finalize();
    }
    deregisterSession(ownerId);
    const { code, msg } = closeCodeFor(reason);
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(code, msg);
    } catch {
      /* already closing */
    }
    // 'closed'/'max_session'/'lost_lease' are benign session ends, not kills.
    const forced = reason !== 'closed' && reason !== 'max_session' && reason !== 'lost_lease';
    void writeAudit({
      action: forced ? 'jarvis_session_killed' : 'jarvis_session_end',
      surface: 'dashboard',
      userId: principal.hashPrefix16,
      operatorLabel: principal.label,
      result: forced ? 'blocked' : 'ok',
      detail: {
        origin: 'jarvis',
        sessionId,
        reason,
        durationSeconds: Math.round((Date.now() - startedAt) / 1000),
        turnCount,
        queryCount,
      },
    });
    emitJarvisMetric('JarvisSessionClose', 1, { dimensions: { Mode: 'voice' } });
    emitJarvisMetric('JarvisSessionDurationMs', Date.now() - startedAt);
    // End the session's X-Ray segment last so the whole session's instrumented
    // SDK work was captured under it (no-op when X-Ray is disabled).
    xrayCloseSegment();
  };

  const handle: JarvisSessionHandle = {
    ws,
    tokenHash: principal.tokenHash,
    ownerId,
    aborted: false,
    teardown: (reason) => teardown(reason),
  };
  registerSession(handle);
  // Mark the handle aborted on close so every post-admission checkpoint (and the
  // H15 pre-open guard) observes the cancellation, not just a registry-driven
  // teardown. teardown itself does the cleanup.
  ws.on('close', () => {
    handle.aborted = true;
    void teardown('closed');
  });
  ws.on('error', () => {
    handle.aborted = true;
    void teardown('closed');
  });

  // 7. The single all-or-nothing four-operation admission: reserve daily spend
  //    + take the global slot + take the per-token lease, owner-fenced.
  try {
    cap = await getEffectiveCostCap();
  } catch {
    cap = 0;
  }
  const admit = await admitSession({
    ownerId,
    tokenHash: principal.tokenHash,
    estimate,
    ttlSeconds: LEASE_TTL_SECONDS,
    slotCount: env.JARVIS_MAX_CONCURRENT_SESSIONS,
    cap,
    utcDate: dayCache,
  }).catch((err) => {
    logger.warn({ err: err instanceof Error ? err.message : String(err), ownerId }, 'admitSession threw');
    return { ok: false as const, reason: 'slot_full' as const };
  });

  if (!admit.ok) {
    deregisterSession(ownerId);
    const map = {
      spend_cap: { code: JARVIS_CLOSE.SPEND_CAP, label: 'spend_cap' },
      token_conflict: { code: JARVIS_CLOSE.NEWCOMER_REJECTED, label: 'token_conflict' },
      slot_full: { code: JARVIS_CLOSE.DISABLED, label: 'saturated' },
    }[admit.reason];
    reject(ws, map.code, map.label);
    return;
  }
  slotIndex = admit.slotIndex;
  // The slot is now held — build the serialized ledger that owns all settle /
  // rollover / release from here on.
  ledger = new VoiceLedger({
    ownerId,
    tokenHash: principal.tokenHash,
    chatId: sessionId,
    modelId: env.NOVA_SONIC_MODEL,
    slotIndex,
    cap,
    estimate,
    initialDay: dayCache, // the UTC date the reservation was ADMITTED on
    startedAt,
    usdPerSecond: USD_PER_SECOND,
    leaseTtlSeconds: LEASE_TTL_SECONDS,
    onSpendCap: closeSpendCap,
  });

  // The socket may have closed DURING admission: teardown then ran with slotIndex
  // still -1 and could not release what admitSession just acquired, and teardown
  // is now tornDown-guarded so it cannot release retroactively. Finalize through
  // the serialized ledger (nothing consumed yet → refunds the reservation).
  if (tornDown) {
    await ledger.finalize();
    return;
  }

  // 8. Final guarded recheck immediately before opening (H15): if aborted, the
  //    socket is no longer open, or any gate flipped during admission, release
  //    owner-conditioned and bail.
  if (handle.aborted || ws.readyState !== WebSocket.OPEN || !(await isStillAdmissible(principal))) {
    await teardown('jarvis_disabled');
    return;
  }

  // 9. Tool dispatch (server query through authorizeRead + redactForModel; the
  //    browser tools round-trip through the single tool_call/tool_result
  //    envelope with a 3s deadline).
  const awaitBrowserTool = (toolUseId: string, timeoutMs: number): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingBrowserTools.delete(toolUseId);
        resolve({ error: 'VIEW_TIMEOUT' });
      }, timeoutMs);
      pendingBrowserTools.set(toolUseId, (result) => {
        clearTimeout(timer);
        resolve(result);
      });
    });

  const executeNovaTool = async (
    toolUseId: string,
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> => {
    const t0 = Date.now();
    try {
      if (toolName === 'query') {
        const resource = input.resource;
        const params = (input.params ?? {}) as QueryParams;
        const r = await executeQueryTool(principal, resource, params);
        queryCount += 1;
        if (!r.ok) {
          void writeAudit({
            action: 'jarvis_query',
            surface: 'dashboard',
            userId: principal.hashPrefix16,
            operatorLabel: principal.label,
            result: r.code === 'QUERY_ERROR' ? 'error' : 'blocked',
            detail: { origin: 'jarvis', sessionId, resource: String(resource), code: r.code },
          });
          return { error: r.code };
        }
        // H1: redact every model-bound result, fail-closed.
        const red = await redactForModel(r.result);
        void writeAudit({
          action: 'jarvis_query',
          surface: 'dashboard',
          userId: principal.hashPrefix16,
          operatorLabel: principal.label,
          result: 'ok',
          detail: { origin: 'jarvis', sessionId, resource: String(resource), withheld: red.withheld, matchCount: red.matchCount },
        });
        // Coalesce empty → '{}' (Bedrock rejects an empty text content block).
        return { result: red.text || '{}' };
      }

      if (BROWSER_SIDE_TOOLS.has(toolName as never)) {
        // show_card is display-only and returns nothing the model needs, so it
        // is fire-and-forget: no awaitBrowserTool round-trip (which would stall
        // Nova's generation up to 3s when the tab is background-throttled).
        // Mirrors the one-way text path.
        if (toolName === 'show_card') {
          send(ws, { type: 'tool_call', toolUseId, toolName, input });
          return { ok: true };
        }
        if (toolName === 'navigate') {
          const raw = String(input.route ?? '');
          // Resolve a misheard/loose target ("memories", "memory", a label) to
          // the closest allowed route, and navigate THERE (not the raw string).
          const route = resolveRoute(principal.role, raw) ?? raw;
          input.route = route;
          const allowed = isRouteAllowed(principal.role, route);
          void writeAudit({
            action: 'jarvis_navigate',
            surface: 'dashboard',
            userId: principal.hashPrefix16,
            operatorLabel: principal.label,
            result: allowed ? 'ok' : 'blocked',
            detail: { origin: 'jarvis', sessionId, route, rawRoute: raw, allowed },
          });
          if (!allowed) return { error: 'ROUTE_FORBIDDEN', route };
        }
        send(ws, { type: 'tool_call', toolUseId, toolName, input });
        const result = await awaitBrowserTool(toolUseId, 3000);
        // read_view content is DLP-redacted server-side before it reaches the model (H1/H2).
        if (toolName === 'read_view') {
          const red = await redactForModel(result);
          return { summary: red.text };
        }
        // navigate/highlight: the model only needs success/failure — NEVER forward
        // the browser's arbitrary payload to the model unredacted (H1).
        const failed = result && typeof result === 'object' && 'error' in result;
        return failed ? { ok: false, error: String((result as { error?: unknown }).error ?? 'failed') } : { ok: true };
      }
      return { error: 'UNKNOWN_TOOL' };
    } finally {
      emitJarvisMetric('JarvisToolCallLatencyMs', Date.now() - t0, { dimensions: { ToolName: toolName } });
    }
  };

  const callbacks: NovaSonicCallbacks = {
    onAudioOut: (b64) => {
      // Nova 2 Sonic speaks natively (24kHz PCM in the configured voice). Forward
      // each frame straight to the browser — no Polly hop. `suppressAudioOut` drops
      // the remainder of an interrupted response after a manual (client) barge-in,
      // until the next user turn; that is exactly what the flag was built for now
      // that the native audio is the real voice.
      if (tornDown || suppressAudioOut || ws.readyState !== WebSocket.OPEN) return;
      send(ws, { type: 'audio_out', b64, rate: 24000 });
    },
    onTextTranscript: (text, role) => {
      if (role === 'USER') {
        // Swallow the greeting kick's phantom user turn (see greetKickPending):
        // do not forward it, do not interrupt, do not count it as a turn.
        if (greetKickPending) {
          greetKickPending = false;
          return;
        }
        if (text) send(ws, { type: 'transcript', text, role: 'user', final: true });
        // Cross-session memory (WRITE) — FINAL-ONLY: do NOT persist here. Nova
        // streams the ASR result as several partial/repeated USER textOutputs;
        // persisting each one was the source of the +56-row over-persist. Instead
        // buffer the latest user text and flush it ONCE when the assistant's reply
        // begins (the committed user turn). The live caption above still shows the
        // user their own words; only the DLP-redacted FINAL copy is stored.
        if (text) pendingUserText = text;
        // The user is talking → tell the browser to cut off any of Jarvis's audio
        // still playing and start a fresh turn.
        send(ws, { type: 'interrupt' });
        suppressAudioOut = false;
        speakTurn += 1;
        spokenThisTurn.clear();
        turnCount += 1;
        // H13: re-validate token + gates on EVERY user turn; trip → close 4009.
        void (async () => {
          if (!tornDown && !(await isStillAdmissible(principal))) await teardown('dashboard_read_disabled');
        })();
        return;
      }
      // ASSISTANT. Nova speaks natively via onAudioOut; the transcript is only for
      // the on-screen caption. Once the assistant starts, the greeting kick is done
      // — stop suppressing future user turns (fallback if no kick echo arrived).
      greetKickPending = false;
      // The empty-text marker is Nova's end-of-turn signal — forward it as
      // speaking_stop so the client glow returns to listening. Drop anything already
      // shown THIS turn (Nova repeats the text; the copies interleave), then surface
      // this line once.
      if (!text) {
        if (!tornDown && ws.readyState === WebSocket.OPEN) send(ws, { type: 'speaking_stop' });
        return;
      }
      // Dedup on a NORMALIZED key (trim + collapse inner whitespace + lowercase) so
      // Nova's near-duplicate copies — e.g. a leading-space variant of the same line,
      // which the old byte-exact check let through — are caught and only spoken once.
      // Genuine continuations differ in their words, so they still pass.
      const clean = text.trim();
      const dedupKey = clean.replace(/\s+/g, ' ').toLowerCase();
      if (!dedupKey || spokenThisTurn.has(dedupKey)) return;
      spokenThisTurn.add(dedupKey);
      // The assistant's reply has begun → flush the buffered FINAL user transcript
      // to memory now (one row for the committed user turn, not one per partial).
      flushPendingUserMemory();
      send(ws, { type: 'transcript', text: clean, role: 'assistant', final: true });
      // Persist a DLP-scrubbed jarvis_voice_turn (H1/§4) — raw transcript never lands.
      // The audit row records EVERY caption line; durable MEMORY persists FINAL-ONLY
      // (the committed assistant turn) and skips a consecutive duplicate, so memory
      // stays ~2 rows per exchange instead of one per repeated/continued line.
      const persistAssistantMemory = dedupKey !== lastPersistedAssistantKey;
      if (persistAssistantMemory) lastPersistedAssistantKey = dedupKey;
      void (async () => {
        const red = await redactForModel(clean);
        void writeAudit({
          action: 'jarvis_voice_turn',
          surface: 'dashboard',
          userId: principal.hashPrefix16,
          operatorLabel: principal.label,
          result: 'ok',
          detail: { origin: 'jarvis', sessionId, responseSummary: red.text.slice(0, 500), withheld: red.withheld, matchCount: red.matchCount },
        });
        // Cross-session memory (WRITE): persist this committed assistant turn,
        // reusing the SAME DLP-redacted text the audit row stores — raw transcript
        // never lands here either. Fire-and-forget; memory must not affect the call.
        if (persistAssistantMemory) {
          await appendJarvisMemoryTurn(principal.hashPrefix16, { role: 'assistant', text: red.text });
        }
      })();
    },
    onBargeIn: () => {
      // Nova detected real speech over Jarvis — stop the browser playback and ack
      // so the client resumes. Nova has already superseded the interrupted reply,
      // so its remaining native audio frames stop on their own.
      suppressAudioOut = false;
      speakTurn += 1;
      spokenThisTurn.clear();
      send(ws, { type: 'interrupt' });
      send(ws, { type: 'barge_in_ack' });
    },
    onUsage: (u: NovaSonicUsage): void => {
      // usageEvents are cumulative; keep the running max so out-of-order or
      // repeated events never lower the metered cost. Settle the new real cost
      // immediately so the cap reflects per-token spend, not a 30s estimate.
      ledger?.addUsageCost(
        novaSonicTurnCost(u.speechInputTokens, u.speechOutputTokens, u.textInputTokens, u.textOutputTokens),
      );
      if (!tornDown) void ledger?.tick();
    },
    onToolUse: (id, name, toolInput) => executeNovaTool(id, name, toolInput),
    onError: (err) => {
      emitJarvisMetric('JarvisNovaSonicStreamError');
      send(ws, { type: 'error', code: 'stream_error', message: err.message });
      try {
        if (ws.readyState === WebSocket.OPEN) ws.close(JARVIS_CLOSE.STREAM_ERROR, 'stream error');
      } catch {
        /* already closing */
      }
    },
    onClose: () => void teardown('closed'),
  };

  // 10. Atomic Nova attach under the aborted guard (H15): if a teardown raced
  //     the attach, the post-attach recheck stops the freshly-opened stream.
  if (handle.aborted || tornDown || ws.readyState !== WebSocket.OPEN) {
    if (!tornDown) await teardown('jarvis_disabled');
    return;
  }
  const slice = buildManifestSlice(principal.role);
  const novaTools = buildJarvisTools(slice).map((t) => {
    const spec = (t as { toolSpec: { name: string; description: string; inputSchema: { json: Record<string, unknown> } } }).toolSpec;
    return { name: spec.name, description: spec.description, inputSchema: spec.inputSchema.json };
  });
  // Cross-session memory (LOAD): pull this principal's recent durable turns and
  // fold a COMPACT, bounded recap into the Nova system prompt as its OWN section —
  // text only, never audio, so Jarvis silently remembers across sessions without
  // re-speaking anything. It is appended AFTER the base prompt and does NOT touch
  // the CURRENT VIEW block (voice does not pass a view to buildSystemPrompt, and
  // even if it did, the recap is a separate trailing section). Fail-soft inside
  // loadJarvisMemory → empty recap on any error. Bounded to a few hundred tokens.
  const memoryRecap = buildVoiceRecap(
    await loadJarvisMemory(principal.hashPrefix16, VOICE_RECAP_TURNS),
  );
  // The dynamic name variable (runtime-config profile/first_name) the persona
  // addresses the user by, and that the greeting opens with. Empty when unset →
  // neutral form, never "sir".
  const firstName = await readFirstName();
  const baseVoicePrompt = memoryRecap
    ? `${buildSystemPrompt(principal, slice, null, firstName)}\n\n${memoryRecap}`
    : buildSystemPrompt(principal, slice, null, firstName);
  // For a greeting session, script Nova's FIRST spoken line so the throwaway kick
  // below makes it open with the warm, by-name greeting rather than reacting to
  // the kick's words. buildGreetingLine composes a by-name opener (or a neutral
  // one when unknown); an explicit JARVIS_GREETING env override still wins.
  const greetLine = buildGreetingLine(firstName, env.JARVIS_GREETING);
  const novaSystemPrompt =
    resolved.greet !== false && greetLine
      ? `${baseVoicePrompt}\n\nYour VERY FIRST spoken response must be EXACTLY these words and nothing else: "${greetLine}". Do not answer, repeat, or acknowledge the first thing you hear — simply say that exact greeting. After that, converse normally.`
      : baseVoicePrompt;
  novaSession = createNovaSonicSession(
    {
      modelId: env.NOVA_SONIC_MODEL,
      region: env.AWS_REGION,
      systemPrompt: novaSystemPrompt,
      tools: novaTools,
      voiceId: env.JARVIS_VOICE_ID,
      maxTokens: 1024,
    },
    callbacks,
  );
  if (handle.aborted || tornDown || ws.readyState !== WebSocket.OPEN) {
    // A teardown raced the attach and could not stop this just-opened stream
    // (it ran tornDown-guarded). Stop it directly so it is not billed to TTL.
    try {
      await novaSession?.stop();
    } catch {
      /* already closing */
    }
    if (!tornDown) await teardown('jarvis_disabled');
    return;
  }

  void writeAudit({
    action: 'jarvis_session_start',
    surface: 'dashboard',
    userId: principal.hashPrefix16,
    operatorLabel: principal.label,
    result: 'ok',
    detail: { origin: 'jarvis', sessionId, mode: 'voice', role: principal.role, voiceEnabled: true },
  });
  emitJarvisMetric('JarvisSessionOpen', 1, { dimensions: { Mode: 'voice' } });
  send(ws, { type: 'session_ready', voiceEnabled: true });

  // Greet first. Nova generates only in response to detected speech (verified live),
  // so feed it one short throwaway spoken "kick" — synthesized via Polly, NEVER
  // played to the user. Nova answers it with the scripted greeting (system prompt
  // above) in its own British voice, flowing through the normal onAudioOut +
  // onTextTranscript path; greetKickPending drops the kick's phantom user turn.
  // Fully fire-and-forget: a synth/feed failure just means no spoken greeting, never
  // a broken session. Skipped on a transient reconnect (greet=false).
  const feedGreetingKick = async (): Promise<void> => {
    // One-shot: claim the latch BEFORE the first await so two callers (or a re-entry)
    // can never both feed the kick — the greeting plays exactly once per session.
    if (greetKickFired) return;
    greetKickFired = true;
    try {
      const kick = await synthesize({ text: 'Hello, hello, good day to you.', format: 'pcm', sampleRate: '16000' });
      const FRAME = 1024; // 512 samples ≈ 32ms @16kHz; paced so the queue never saturates.
      for (let off = 0; off < kick.bytes.length; off += FRAME) {
        if (tornDown || !novaSession) return;
        novaSession.pushAudio(kick.bytes.subarray(off, off + FRAME).toString('base64'));
        await new Promise((r) => setTimeout(r, 20));
      }
    } catch (err) {
      logger.warn({ err: errMsg(err), sessionId }, 'jarvis greeting kick failed');
    }
  };
  if (resolved.greet !== false && greetLine) {
    // Safety net: never let the suppression flag outlive the greeting window and
    // swallow the user's real first words.
    setTimeout(() => { greetKickPending = false; }, 8000).unref?.();
    void feedGreetingKick();
  }

  // Heartbeat renews the slot + token lease + reservation together, AND settles
  // the daily-spend reservation incrementally (reserved → spent, H5). The callback
  // is X-Ray-bound (xrayBind) so its 30s DDB calls resolve the session segment
  // instead of tripping the context-missing strategy (no-op when X-Ray is off).
  heartbeatTimer = setInterval(xrayBind(() => {
    void (async () => {
      if (tornDown) return;
      const ok = await heartbeat({ ownerId, slotIndex, tokenHash: principal.tokenHash, ttlSeconds: LEASE_TTL_SECONDS }).catch(
        () => false,
      );
      if (!ok && !tornDown) {
        logger.warn({ ownerId }, 'jarvis heartbeat lost ownership — tearing down');
        await teardown('lost_lease');
        return;
      }
      // Correctness fallback for the emergency gates (Codex review): the SNS/SQS
      // teardown fanout is best-effort, so re-check on EVERY heartbeat (fires even
      // on a silent/idle session the per-turn H13 recheck never reaches).
      // jarvis_voice_disabled uses a FAIL-CLOSED read — an unconfirmable gate
      // state drops voice to text rather than leaving the stream live.
      let voiceDisabled = true;
      try {
        const sw = await readSwitchFailClosed('jarvis_voice_disabled');
        voiceDisabled = sw.present && sw.active;
      } catch {
        voiceDisabled = true;
      }
      if (!tornDown && voiceDisabled) {
        await teardown('jarvis_voice_disabled');
        return;
      }
      if (!tornDown && !(await isStillAdmissible(principal))) {
        await teardown('jarvis_disabled');
        return;
      }
      // Roll over (if the UTC day advanced) + settle this interval, serialized.
      if (ledger) await ledger.tick();
    })();
  }), HEARTBEAT_INTERVAL_MS);

  // Hard session cap (the Bedrock bidirectional stream closes at 8 min; §1c).
  maxSessionTimer = setTimeout(xrayBind(() => void teardown('max_session')), env.JARVIS_MAX_SESSION_SECONDS * 1000);

  // Message loop: browser audio → Nova; browser tool_result resolves the
  // pending round-trip; barge_in/ping handled inline.
  ws.on('message', (data) => {
    let msg: { type?: string; b64?: string; toolUseId?: string; ok?: boolean; result?: Record<string, unknown> };
    try {
      msg = JSON.parse(typeof data === 'string' ? data : data.toString());
    } catch {
      return;
    }
    switch (msg.type) {
      case 'audio_in':
        // Real mic audio is flowing → the greeting window is over. Latch the
        // one-shot so a late/duplicate kick can never re-trigger over the user
        // (GREET-ONCE, "cannot re-trigger while the mic is live"). We deliberately
        // do NOT touch greetKickPending here — the kick's phantom USER-turn
        // suppression has its own clearers (the kick echo, the first greeting, the
        // 8s safety net) so a slow phantom transcript still gets swallowed.
        greetKickFired = true;
        if (msg.b64) novaSession?.pushAudio(msg.b64);
        break;
      case 'barge_in':
        // The client (its mic-level VAD or a tap) says the user interrupted.
        // suppressAudioOut drops Nova's remaining native audio frames for this
        // reply until the next user turn, so nothing keeps voicing after the
        // interrupt; then ack so the client resumes accepting audio.
        suppressAudioOut = true;
        speakTurn += 1;
        spokenThisTurn.clear();
        send(ws, { type: 'barge_in_ack' });
        break;
      case 'tool_result': {
        const id = msg.toolUseId;
        if (id) {
          const resolve = pendingBrowserTools.get(id);
          if (resolve) {
            pendingBrowserTools.delete(id);
            resolve(msg.result ?? { ok: msg.ok ?? true });
          }
        }
        break;
      }
      case 'ping':
        send(ws, { type: 'pong' });
        break;
    }
  });
}
