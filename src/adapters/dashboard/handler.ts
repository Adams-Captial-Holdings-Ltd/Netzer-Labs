/**
 * Dashboard read API — single-token bearer auth.
 *
 * Mounted at /api/* from server.ts. Routes:
 *   GET /api/agents              list configured agents + built-in defaults
 *   GET /api/sessions            recent sessions (per agent + chat)
 *   GET /api/usage?days=7        token usage rows from last N days
 *   GET /api/audit?days=1        audit log rows from last N days
 *   GET /api/kill-switches       current state of every kill switch
 *   POST /api/kill-switches      { name, active, reason }  — set a switch
 *
 * Auth: `Authorization: Bearer <DASHBOARD_TOKEN>` matched against the
 * value injected from the dashboard SecretsManager secret. Constant-time
 * compare to avoid timing oracles. The UI will land later; this API is
 * intentionally JSON-only so curl / Postman work today.
 */

import { Hono, type Context } from 'hono';
import { createHash, randomUUID } from 'node:crypto';
import {
  QueryCommand,
  ScanCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  authenticateDashboardToken,
  extractBearerToken,
  capabilitiesForPrincipal as libCapabilitiesForPrincipal,
  type TokenPrincipal,
} from '../../lib/auth/dashboard-auth.js';
import {
  CAPABILITIES,
  TEMPLATED_PROFILES,
  isCapability,
  isTemplatedProfileId,
  resolveCapabilities,
  type Capability,
  type CustomProfile,
} from '../../lib/auth/permissions.js';
import {
  createToken,
  linkTokenToUser,
  listTokens,
  revokeToken,
  revokeTokensForUser,
  isTokenRole,
  type TokenRole,
} from '../../lib/state/tokens-repo.js';
import {
  createUserInvite,
  createMagicToken as createUserMagicToken,
  consumeMagicToken as consumeUserMagicToken,
  getMagicToken,
  getUser,
  getUserByEmail,
  listUsers,
  activateUser,
  disableUser,
  recordLogin,
  setUserProfileId,
  LOGIN_TOKEN_TTL_MS,
  type UserProfile,
} from '../../lib/state/users-repo.js';
import { verifyMagicToken } from '../../lib/auth/magic-link.js';
import { checkAndConsume, checkAndConsumeStrict } from '../../lib/state/rate-limits-repo.js';
import { sendInviteEmail, sendLoginEmail } from '../../lib/email/invite-email.js';
import { humanizeToolName } from '../../lib/tools/humanize.js';
import { ddb } from '../../lib/state/ddb.js';
import { writeAudit, writeAuditOrThrow, type AuditEvent } from '../../lib/audit/audit-writer.js';
import { logger, truncateForLog } from '../../observability/logger.js';
import { listKnownAgents, loadAgent, listKnownAgentsAsync, invalidateAgentCache } from '../../lib/config/agent-loader.js';
import { publishInvalidation } from '../../lib/config/invalidation-publisher.js';
import {
  isKillSwitchActive,
  setKillSwitch,
  ALL_KILL_SWITCHES,
  KILL_SWITCH_META,
  type KillSwitchName,
} from '../../lib/state/kill-switches-repo.js';
import { runAgentTurn, KillSwitchActiveError, CostCapExceededError, type AttachmentBlock } from '../../agent/agent-loop.js';
import { processMedia, buildKbConfirmation, kindForMime, stageLabel } from '../../lib/media/process.js';
import { resolveOwnerChatId, isPrincipalScopedChatId } from '../../lib/identity/owner-alias.js';
import { runCommand } from '../../agent/commands.js';
import { listAvailableModels, pickDefaultModel, resolveModel } from '../../lib/bedrock/models.js';
import { converseTurn } from '../../lib/bedrock/client.js';
import { listPlaygroundModels, playgroundCost, playgroundMeteredCost } from '../../lib/bedrock/playground-catalog.js';
import { InFlightGate } from '../../lib/concurrency/bounded.js';
import {
  appendTurns,
  getSession,
  getFullHistory,
  deleteSession,
} from '../../lib/state/sessions-repo.js';
import { listMemoriesForChat, listMemoriesForAgent } from '../../lib/state/memories-repo.js';
import { ingestDocument, removeDocument, detectFormat, type IngestFormat } from '../../lib/vectors/ingest.js';
import {
  listDocuments,
  search as vectorSearch,
  presignUploadUrl,
  uploadKeyFor,
  isUploadKey,
  getObjectBuffer,
  deleteObject,
  objectS3Uri,
} from '../../lib/vectors/store.js';
import { embedOne } from '../../lib/vectors/embedder.js';
import { transcribeAudio } from '../../lib/transcribe/transcriber.js';
import {
  listScheduledTasksForAgent,
  cancelScheduledTask,
  createScheduledTask,
  updateScheduledTask,
} from '../../lib/state/scheduled-tasks-repo.js';
import { upsertSchedule } from '../../lib/scheduler/eb-scheduler.js';
import { nextOccurrenceUtc } from '../../lib/scheduler/local-time.js';
import { listRoutines } from '../../lib/jarvis/jarvis-routines.js';
import { listInbox } from '../../lib/state/inter-agent-tasks-repo.js';
import { recentHive } from '../../lib/state/hive-mind-repo.js';
import { getDailyCostUsd, getUsageByDay, recordUsage, usageAgentPartitions, PLAYGROUND_USAGE_AGENT, KNOWLEDGE_USAGE_AGENT, SpendIndeterminateError } from '../../lib/usage/token-tracker.js';
import {
  createMission,
  listMissionsForAgent,
  updateMissionStatus,
  reassignMission,
  MISSION_STATUSES,
  type MissionStatus,
} from '../../lib/state/mission-tasks-repo.js';
import { autoAssign } from '../../lib/tools/mission-tools.js';
import { registerMissionRoutes } from './missions.js';
import { paperclipRoutingEnabled } from '../../lib/missions/mission-acl.js';
import { addonConfigured, listAddons } from '../../lib/addons/registry.js';
import { exportChatData, purgeChatData } from '../../lib/tools/privacy-tools.js';
import { getMeeting } from '../../lib/warroom/meetings-repo.js';
import { getHistory } from '../../lib/warroom/publisher.js';
import { buildPdf, toPdfSafeText } from '../../lib/documents/pdf.js';
import {
  saveAgentFile,
  listRevisions,
  type AgentFileName,
} from '../../lib/state/agent-file-history-repo.js';
import { streamSSE } from 'hono/streaming';
import { buildCsv } from '../../lib/csv.js';
import {
  validateAgentId,
  createAgentFull,
  deleteAgentFull,
  activateAgent,
  deactivateAgent,
  connectTelegram,
  disconnectTelegram,
  validateTelegramToken,
  connectSlack,
  disconnectSlack,
  validateSlackToken,
  generateSlackManifest,
} from '../../lib/agents/agent-manager.js';
import { listAgents, getAgent } from '../../lib/state/agents-repo.js';
import { redactAgent } from '../../lib/agents/types.js';
import { listTemplates, getTemplate } from '../../lib/agents/templates.js';
import {
  getConfig,
  setConfig,
  getConfigCategory,
} from '../../lib/state/runtime-config-repo.js';
import { getEffectiveCostCap } from '../../lib/state/cost-cap-repo.js';
import { assembleStatusData, type AlarmRow } from '../status/data.js';
import { checkForUpdates } from '../../lib/updates/discovery.js';

const TABLE_SESSIONS = process.env.TABLE_SESSIONS ?? 'claudeclaw-sessions';

/**
 * WI-1.0, the containment gate owner decision 11 makes a release gate: every
 * reader of the sessions table must accept solely `AGENT#…`/`CHAT#…`.
 *
 * The table is shared. `jarvis-memory-repo.ts` already writes `PK=JARVIS#…`,
 * `SK=TURN#…` into it, and P1 adds one `SK=CHAT#<chatId>#MSG#…` record per
 * message. Every reader below Scans or Queries it and maps whatever comes back
 * into a conversation by stripping key prefixes, so without this an unrelated
 * row renders as a phantom conversation.
 *
 * Written as an ALLOWLIST — this exact shape — rather than as a blocklist of
 * the item types that exist today. A blocklist would have to be extended for
 * every future type, and the one that got forgotten is precisely the failure
 * this gate exists to prevent.
 *
 * It assumes a chatId carries no `#`, and nothing enforces that: an
 * already-prefixed id passes `safeDashboardChatId` verbatim, and a Paperclip
 * chatId embeds an externally supplied issueId unfiltered. A conversation whose
 * chatId contains `#` is therefore excluded, silently. The agentId is left
 * unconstrained beyond the prefix, because only the sort key distinguishes a
 * conversation from its own messages.
 */
export function isConversationRow(item: Record<string, unknown>): boolean {
  const sk = typeof item.SK === 'string' ? item.SK : '';
  return /^AGENT#./.test(typeof item.PK === 'string' ? item.PK : '') && /^CHAT#[^#]+$/.test(sk);
}

/**
 * The most items one listing reads before it stops and says `truncated`.
 * ponytail: every message row is READ only to be skipped, because there is no
 * index that selects conversation rows (A132); a GSI — decision 11 reopened —
 * is the upgrade if listing ever gets slow.
 */
const LISTING_READ_CEILING = 100_000;

/**
 * WI-1.2: the conversation rows of the sessions table, or of one agent's
 * partition, read to the END. P1 keeps a row per message beside every
 * conversation, so a read bounded by a count of ITEMS undercounts conversations
 * as soon as a partition fills with message rows — and said nothing when it did
 * (the WI-1.0 review finding). This pages until DynamoDB has nothing more,
 * keeps only conversation rows, and stops only at LISTING_READ_CEILING, which it
 * reports as `truncated` instead of dropping rows silently.
 */
export async function readConversationRows(
  projection: string,
  agentId?: string,
): Promise<{ rows: Record<string, unknown>[]; truncated: boolean }> {
  const rows: Record<string, unknown>[] = [];
  let read = 0;
  let startKey: Record<string, unknown> | undefined;
  do {
    const out = await ddb().send(
      agentId
        ? new QueryCommand({
            TableName: TABLE_SESSIONS,
            KeyConditionExpression: 'PK = :pk',
            ExpressionAttributeValues: { ':pk': `AGENT#${agentId}` },
            ProjectionExpression: projection,
            ExclusiveStartKey: startKey,
          })
        : new ScanCommand({ TableName: TABLE_SESSIONS, ProjectionExpression: projection, ExclusiveStartKey: startKey }),
    );
    read += out.Items?.length ?? 0;
    for (const item of out.Items ?? []) if (isConversationRow(item)) rows.push(item);
    startKey = out.LastEvaluatedKey;
  } while (startKey && read < LISTING_READ_CEILING);
  return { rows, truncated: startKey !== undefined };
}

/**
 * Constrain dashboard-initiated chatIds so a holder of the bearer
 * token can't write turns into another surface's session. Allowed
 * prefixes: dashboard:, system:, smoke:, test:. Everything else gets
 * the `dashboard:` prefix forced.
 */
/**
 * The dashboard token is a single shared secret, so we can't tell
 * which human is making any given request. The X-Dashboard-User
 * header lets ops voluntarily tag mutating requests (file edits,
 * purges) so the audit log records who did what. Format is free-form
 * but capped so the header can't be used to smuggle structure into
 * downstream queries.
 */
type DashboardCtx = {
  req: { header: (name: string) => string | undefined };
  get: (key: 'principal') => TokenPrincipal | undefined;
};

function operatorIdentity(c: { req: { header: (name: string) => string | undefined } }): string {
  const raw = (c.req.header('x-dashboard-user') ?? '').trim();
  if (!raw) return 'dashboard:anonymous';
  return `dashboard:${raw.replace(/[^A-Za-z0-9_.@-]/g, '_').slice(0, 64)}`;
}

/**
 * The owner stamped on the principal's conversations (WI-1.1). A PERSON owns
 * them, whichever token they signed in with: a magic-link session carries its
 * `userId`, and a token with no user of its own may be linked to one by an
 * audited admin action (owner decision 1). Before WI-1.1 this was the token
 * hash, and a member session mints a new token per login, so the next login
 * orphaned everything the last one wrote (A133). A token with no person keeps
 * its own hash, which is stable for the env root token and legacy tokens; its
 * conversations are not durable (decision 1, see personOf in the send routes).
 */
function dashboardIdentity(c: DashboardCtx): string {
  const p = getPrincipal(c);
  const person = p?.userId ?? p?.linkedUserId;
  if (person) return `dashboard:user:${person}`;
  if (p) return `dashboard:${p.tokenHash}`;
  const auth = c.req.header('authorization') ?? '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return 'dashboard:unknown';
  const hash = createHash('sha256').update(token).digest('hex');
  return `dashboard:${hash}`;
}

/** Decision 1: the person behind the principal, if there is one. */
function personOf(c: DashboardCtx): string | undefined {
  const p = getPrincipal(c);
  return p?.userId ?? p?.linkedUserId;
}

/**
 * Whether the caller owns a stored conversation (decisions 1 and 9). Also true
 * for a row the caller's OWN token wrote before WI-1.1, which carries
 * `dashboard:<tokenHash>`: stable for a token with no person, so that history
 * stays reachable until the legacy migration (WI-1.4) re-keys it. A row with no
 * owner belongs to nobody — only the audited admin override reaches it.
 */
function ownsConversation(c: DashboardCtx, owner: unknown): boolean {
  if (typeof owner !== 'string' || owner === '') return false;
  const p = getPrincipal(c);
  return owner === dashboardIdentity(c) || (p !== null && owner === `dashboard:${p.tokenHash}`);
}

export const ROLE_RANK: Record<TokenRole, number> = { viewer: 0, operator: 1, admin: 2 };

/**
 * Minimum role required for a request. Reads are viewer; routine mutations
 * are operator; security-sensitive surfaces (token management, flipping
 * kill switches) require admin. Panic + DLP live in their own routers and
 * are admin-gated there.
 */
export function requiredRole(method: string, subPath: string): TokenRole {
  if (subPath === '/whoami') return 'viewer';
  // Wave 4a member + custom-profile routes are authorized by the capability gate
  // (hasCapability), NOT the legacy ROLE_RANK rank. Returning 'viewer' here makes
  // the legacy gate a no-op for these paths so authorization runs through ONE
  // mechanism (the capability check inside each route) instead of two
  // independent gates. (The dashboard-wide unification — folding ROLE_RANK into
  // the capability model in the middleware — is the cross-file change noted in
  // contractNotes.)
  if (subPath === '/members' || subPath.startsWith('/members/')) return 'viewer';
  if (subPath === '/profiles' || subPath.startsWith('/profiles/')) return 'viewer';
  if (subPath.startsWith('/tokens')) return 'admin';
  // Kill-switch trips are gated on the security:write CAPABILITY inside POST
  // /kill-switches (the only kill-switch mutation). The legacy admin-role gate is
  // relaxed to viewer so the capability check is the single gate (same pattern as
  // /members, /profiles, and the cost-watch toggle below). Leaving it at 'admin'
  // dead-ended a custom profile that holds security:write but not the admin
  // template, which is exactly the principal the UI shows the control to.
  if (subPath.startsWith('/kill-switches') && method !== 'GET') return 'viewer';
  // Runtime config: reads stay viewer/operator. The COST category write (the
  // daily cost-watch toggle) is operator-tier and is gated on the config:write
  // CAPABILITY inside the route, so the legacy role gate is relaxed to viewer for
  // ONLY the operator-tier cost-watch toggle (the config:write check is then the
  // single gate, like /members does). It is the EXACT key, not the whole cost
  // category: daily_cap_usd must go through POST /cost-cap (validation + AWS
  // Budget sync + audit) and cost-watch bookkeeping keys are server-only, so
  // every other /config/cost/* write still requires admin via the rule below.
  if (subPath === '/config/cost/watch_enabled' && method !== 'GET') return 'viewer';
  if (subPath.startsWith('/config') && method !== 'GET') return 'admin';
  // Irreversible GDPR erasure is admin-only; the export (GET) stays operator.
  if (subPath.startsWith('/export') && method === 'DELETE') return 'admin';
  // Jarvis read-only co-pilot — viewer can use voice + read the manifest. The
  // /api/jarvis sub-router does its own auth + fail-closed isJarvisEnabled gate;
  // these entries codify the role matrix (Reference Contracts C, JARVIS-PLAN §5).
  if (subPath === '/jarvis/voice') return 'viewer';
  if (subPath === '/jarvis/manifest') return 'viewer';
  if (method === 'GET') return 'viewer';
  return 'operator';
}

function safeDashboardChatId(input: string | undefined): string {
  const raw = (input ?? '').trim();
  if (!raw) return `dashboard:${Date.now()}`;
  if (/^(dashboard|system|smoke|test):/.test(raw)) return raw;
  // Strip anything that looks like another surface's prefix and
  // re-key under dashboard: with the original embedded as a label.
  const sanitized = raw.replace(/[^A-Za-z0-9_:.-]/g, '_').slice(0, 100);
  return `dashboard:${sanitized}`;
}
const TABLE_TOKEN_USAGE = process.env.TABLE_TOKEN_USAGE ?? 'claudeclaw-token-usage';
const TABLE_AUDIT_LOG = process.env.TABLE_AUDIT_LOG ?? 'claudeclaw-audit-log';

// Process-wide ceiling on concurrent PAID Playground model calls. The SPA fans
// out one /playground/run per selected model in parallel, so the fan-out is
// spread across independent HTTP requests, not inside one handler — a chunked
// Promise.all cannot bound it. This gate caps how many of those paid calls run
// at the same time on this task; callers that lose the race get 429 (and spend
// nothing) instead of all firing at once before the cost cap can see them.
// Per-request rate limiting + the per-call cost-cap pre-check are the other two
// layers; this one stops a single burst from racing past the cap window.
const PLAYGROUND_MAX_CONCURRENT = Number(process.env.PLAYGROUND_MAX_CONCURRENT ?? 3);
const playgroundGate = new InFlightGate(
  Number.isFinite(PLAYGROUND_MAX_CONCURRENT) && PLAYGROUND_MAX_CONCURRENT > 0
    ? PLAYGROUND_MAX_CONCURRENT
    : 3,
);

const BUILTIN_DESCRIPTIONS: Record<string, string> = {
  main: 'Your daily AI assistant. General chat, memory, scheduling, web search, and tool use across Telegram and Slack.',
  ops: 'Operations agent. Scheduling, calendar, billing, and operational tasks.',
  research: 'Deep-research agent. Thorough analysis, citations, and synthesis over bullet lists.',
};

function extractDescription(agentId: string, systemPrompt: string): string {
  if (BUILTIN_DESCRIPTIONS[agentId]) return BUILTIN_DESCRIPTIONS[agentId];
  const first = systemPrompt.split('\n').find((l) => l.trim().length > 10 && !l.startsWith('#'));
  if (!first) return '';
  const cleaned = first.replace(/^You are [\w-]+,?\s*/i, '').replace(/\.$/, '').trim();
  const capped = cleaned.length > 120 ? cleaned.slice(0, 117) + '...' : cleaned;
  return capped.charAt(0).toUpperCase() + capped.slice(1);
}

const KILL_SWITCH_NAMES: readonly KillSwitchName[] = ALL_KILL_SWITCHES;

function getPrincipal(c: DashboardCtx): TokenPrincipal | null {
  return c.get('principal') ?? null;
}

type DashboardEnv = { Variables: { principal: TokenPrincipal } };

// ───────────────────────────────────────────────────────────────────────────
// Wave 4a: magic-link passwordless auth + RBAC.
//
// FROZEN SPEC: multi-user + RBAC in a single self-hosted deployment. Login is
// TRUE magic-link passwordless: no passwords stored, no argon2/bcrypt, no CRED
// items. Storage is the single claudeclaw-users table (single-table design):
//   - User profile: PK=USER#<uuid>, SK=PROFILE, GSI1PK=EMAIL#<emailLower>,
//     GSI1SK=USER (index `gsi1-email`).
//   - Magic token: PK=MAGIC#<sha256(rawToken)>, SK=STATE, ttl-enforced,
//     single-use (consumedAt + conditional write). Only the hash is stored.
//
// CONSOLIDATED: the user storage, magic-link, capability taxonomy, and per-user
// session-token revocation are the SECURITY-REVIEWED lib modules — there is no
// inline divergent copy. This handler delegates to:
//   - src/lib/state/users-repo.ts      (single-table users + magic tokens, the
//                                        correct `gsi1-email` index + ConsistentRead)
//   - src/lib/auth/magic-link.ts       (verifyMagicToken primitive)
//   - src/lib/auth/permissions.ts      (the ONE capability taxonomy + subset checks)
//   - src/lib/auth/dashboard-auth.ts   (capabilitiesForPrincipal)
//   - src/lib/state/tokens-repo.ts     (createToken binding + revokeTokensForUser
//                                        on the `gsi2-user` index with scan fallback)
// so the reviewed implementation is the one that actually runs the login /
// invite / member-management flows. Authorization funnels through ONE mechanism:
// the legacy requiredRole+ROLE_RANK gate stays only for the pre-Wave-4a routes,
// and every member / custom-profile route gates on the capability check below.
// ───────────────────────────────────────────────────────────────────────────

const TABLE_USERS = process.env.TABLE_USERS ?? 'claudeclaw-users';
const INVITE_TTL_MS = 72 * 60 * 60 * 1000; // 72h
const LOGIN_TTL_MS = LOGIN_TOKEN_TTL_MS; // 15m (from users-repo)

// Re-export the reviewed capability taxonomy so any external reader sees the one
// source of truth (permissions.ts), not a divergent local copy.
export { CAPABILITIES, isCapability, type Capability };

/** The admin capability that gates the member-management surface. */
const MEMBERS_ADMIN_CAP: Capability = 'members:write';

/** Read a custom profile definition row (PROFILE_DEF#<id> / DEF) as a lib
 * CustomProfile so permissions.resolveCapabilities can interpret it. The
 * `capabilities` array is filtered to known capabilities at resolution time, so
 * a garbage/unknown string in storage can never widen a grant. Returns null when
 * the row is missing / unreadable (fail closed). */
async function readCustomProfile(profileId: string): Promise<CustomProfile | null> {
  try {
    const out = await ddb().send(
      new GetCommand({
        TableName: TABLE_USERS,
        Key: { PK: `PROFILE_DEF#${profileId}`, SK: 'DEF' },
      }),
    );
    const item = out.Item;
    if (!item || !Array.isArray(item.capabilities)) return null;
    return {
      profileId,
      label: String(item.label ?? profileId),
      capabilities: (item.capabilities as unknown[]).filter(isCapability),
      createdBy: String(item.updatedBy ?? item.createdBy ?? 'dashboard'),
      createdAt: String(item.createdAt ?? item.updatedAt ?? ''),
      ...(item.updatedAt ? { updatedAt: String(item.updatedAt) } : {}),
    };
  } catch (err) {
    logger.warn(
      { profileId, errMessage: err instanceof Error ? err.message : String(err) },
      'custom profile read failed — failing closed',
    );
    return null;
  }
}

/**
 * Resolve a principal's effective capability set via the reviewed
 * dashboard-auth.capabilitiesForPrincipal. A custom profile id is loaded from
 * storage first so its capability set is honored; a template id or the env owner
 * token resolves without a read. Unknown / unreadable custom profile => empty set
 * (fail closed). Returns the resolved profileId + caps set.
 */
async function capabilitiesForPrincipal(
  p: TokenPrincipal,
): Promise<{ profileId: string; caps: Set<Capability> }> {
  const profileId = p.profileId ?? profileIdForRole(p.role);
  // owner (env root) + template ids resolve with no storage read.
  if (p.label === 'Root token' || profileId === 'owner' || isTemplatedProfileId(profileId)) {
    return { profileId, caps: new Set(libCapabilitiesForPrincipal(p)) };
  }
  // Custom profile — load the def so resolveCapabilities can interpret it.
  const custom = await readCustomProfile(profileId);
  return { profileId, caps: new Set(libCapabilitiesForPrincipal(p, custom)) };
}

/**
 * Bridge the legacy TokenRole (viewer/operator/admin) to a templated profileId
 * for tokens minted before Wave 4a (no profileId on the row). admin → admin,
 * operator → operator, viewer → viewer; the env root token is owner by env.
 */
function profileIdForRole(role: TokenRole): string {
  if (role === 'admin') return 'admin';
  if (role === 'operator') return 'operator';
  return 'viewer';
}

/** Resolve the full capability set for a profileId (template or custom) as a
 * Set, loading the custom profile def when needed. Used by the member-grant
 * subset checks (granted caps ⊆ actor caps). Unknown profile => null. */
async function capabilitiesForProfileId(profileId: string): Promise<Set<Capability> | null> {
  if (profileId === 'owner' || isTemplatedProfileId(profileId)) {
    return new Set(resolveCapabilities(profileId));
  }
  const custom = await readCustomProfile(profileId);
  if (!custom) return null;
  const caps = resolveCapabilities(profileId, custom);
  // A custom profile that resolves to nothing is treated as unknown so it is
  // never assignable (mirrors permissions.canAssignProfile).
  return caps.length ? new Set(caps) : null;
}

/**
 * The ONE capability-enforcement helper. Resolves the request principal's caps
 * and returns true iff it holds `need`. Every member / custom-profile route runs
 * through this (the reviewed permissions taxonomy), NOT the legacy requiredRole +
 * ROLE_RANK rank.
 */
async function hasCapability(c: DashboardCtx, need: Capability): Promise<boolean> {
  const p = getPrincipal(c);
  if (!p) return false;
  const { caps } = await capabilitiesForPrincipal(p);
  return caps.has(need);
}

// ── Users + magic-link: delegate to the reviewed users-repo / magic-link libs ──

/** Validate (read-only, no consume) a raw magic token via the reviewed primitives:
 * a point GetItem + magic-link.verifyMagicToken. Returns the row's userId on a
 * valid token, null for missing / expired / consumed / wrong-purpose (the caller
 * collapses all to an identical 404 — no enumeration oracle). */
async function validateMagicToken(
  rawToken: string,
  purpose: MagicPurpose,
): Promise<{ userId: string } | null> {
  if (!rawToken) return null;
  const row = await getMagicToken(rawToken).catch(() => null);
  const v = verifyMagicToken(rawToken, row, { expectedPurpose: purpose });
  if (!v.ok || !row) return null;
  return { userId: row.userId };
}

type MagicPurpose = 'invite' | 'login';

/** Mint a magic token for an EXISTING user (login / re-issued invite). Wraps
 * users-repo.createMagicToken and returns just the raw token for the email. */
async function createMagicToken(
  userId: string,
  purpose: MagicPurpose,
  ttlMs: number,
): Promise<string> {
  const { rawToken } = await createUserMagicToken({
    userId,
    purpose,
    expiresAtMs: Date.now() + ttlMs,
  });
  return rawToken;
}

/** Single-use consume via the reviewed users-repo conditional write. Returns the
 * userId on success, null on any failed precondition (missing / expired /
 * consumed / wrong-purpose) — identical handling, no oracle. */
async function consumeMagicToken(
  rawToken: string,
  purpose: MagicPurpose,
): Promise<{ userId: string } | null> {
  const token = await consumeUserMagicToken(rawToken, { purpose }).catch(() => null);
  return token ? { userId: token.userId } : null;
}

/**
 * Mint a per-user SESSION token in claudeclaw-dashboard-tokens carrying
 * userId + profileId via the reviewed tokens-repo.createToken binding. The
 * binding stamps GSI2PK=USER#<userId> on the row so revokeTokensForUser finds
 * every live session on disable / downgrade, and dashboard-auth resolves the
 * per-user profile straight off the token. Returns the raw bearer for the SPA.
 */
async function mintSessionToken(user: UserProfile): Promise<string> {
  const role = await roleForProfileId(user.profileId);
  const { raw } = await createToken(
    `member:${user.emailLower}`,
    `user:${user.userId}`,
    role,
    undefined,
    { userId: user.userId, profileId: user.profileId },
  );
  return raw;
}

/**
 * The legacy rungs, ranked, each pinned to the TEMPLATED capability set that
 * DEFINES it. The bridge stays in lockstep with the source of truth: the exact
 * caps a legacy role gates are exactly the templated profile's caps.
 *
 * A profile EARNS a legacy role only when it holds that role's ENTIRE templated
 * capability set (templated caps ⊆ profile caps — a SUBSET/superset rule, not a
 * single-capability touch). This never over-grants: a custom profile that holds
 * one admin-tier capability (e.g. members:write) but NOT the full admin template
 * is NOT admin; it falls through to the highest rung it fully covers, else viewer.
 */
const LEGACY_ROLE_TEMPLATES: ReadonlyArray<{
  role: TokenRole;
  caps: readonly Capability[];
}> = [
  // Highest first: pick the most privileged role fully covered, never wider.
  { role: 'admin', caps: TEMPLATED_PROFILES.admin },
  { role: 'operator', caps: TEMPLATED_PROFILES.operator },
  { role: 'viewer', caps: TEMPLATED_PROFILES.viewer },
];

/** True when every capability in `template` is present in `held` (template ⊆ held). */
function holdsAll(held: readonly Capability[], template: readonly Capability[]): boolean {
  const heldSet = new Set(held);
  return template.every((cap) => heldSet.has(cap));
}

/**
 * Map a profileId to the legacy TokenRole the session row stores, derived
 * FAITHFULLY from the profile's effective capabilities (the permissions taxonomy
 * is the source of truth) rather than collapsing every non-template id to viewer.
 * This keeps the remaining legacy role-gated API routes correct for custom
 * profiles until those routes are also capability-gated.
 *
 * SUBSET/SUPERSET rule (never over-grants): pick the HIGHEST legacy role whose
 * ENTIRE templated capability set is a subset of the profile's capabilities.
 *   - holds ALL admin-template caps    -> admin
 *   - else holds ALL operator-template -> operator
 *   - else                             -> viewer (viewer template is just
 *                                         dashboard:read; analyst/unknown land here)
 *
 * A members:write-only custom profile does NOT cover the full admin template, so
 * it resolves to viewer — not admin. The env root/owner is never weakened: owner
 * resolves to ALL_CAPABILITIES (a superset of the admin template) so it lands on
 * admin, and the explicit owner guard keeps that true without a storage read.
 */
async function roleForProfileId(profileId: string): Promise<TokenRole> {
  if (profileId === 'owner') return 'admin';
  // Templated ids resolve with no storage read; a custom id is loaded so its
  // stored capability set (filtered to known caps) drives the role. An unknown /
  // unreadable custom profile resolves to zero caps → viewer (fail closed).
  const caps = isTemplatedProfileId(profileId)
    ? resolveCapabilities(profileId)
    : resolveCapabilities(profileId, await readCustomProfile(profileId));
  for (const { role, caps: template } of LEGACY_ROLE_TEMPLATES) {
    if (holdsAll(caps, template)) return role;
  }
  return 'viewer';
}

/**
 * Flip a previously DISABLED user back to status=invited and re-stamp the invite
 * metadata. Used only by the re-invite path (createUserInvite refuses an email
 * that already has any row). Writes through the same users-repo row (PK=USER#id,
 * SK=PROFILE) + clears disabledAt so the row is a clean pending invite again.
 * Conditioned on the user existing.
 */
async function reinviteDisabledUser(userId: string, invitedBy: string): Promise<void> {
  const now = new Date().toISOString();
  await ddb().send(
    new UpdateCommand({
      TableName: TABLE_USERS,
      Key: { PK: `USER#${userId}`, SK: 'PROFILE' },
      UpdateExpression:
        'SET #status = :invited, invitedBy = :by, invitedAt = :at REMOVE disabledAt, activatedAt, lastLoginAt',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':invited': 'invited', ':by': invitedBy, ':at': now },
    }),
  );
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim().toLowerCase();
  return EMAIL_RE.test(t) ? t : null;
}

function sourceIp(c: DashboardCtx): string {
  return (
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    'unknown'
  );
}

/**
 * Fail-CLOSED rate limit on an auth route, keyed by BOTH source IP and email.
 * Uses checkAndConsumeStrict, which enforces a built-in default policy even when
 * no policy row is seeded (a seeded override still wins) and BLOCKS on any
 * limiter error. This guarantees brute-force / enumeration protection on a fresh
 * deploy. Returns true when the request must be REJECTED.
 */
async function authRateLimited(c: DashboardCtx, email: string | null): Promise<boolean> {
  const ip = sourceIp(c);
  try {
    const ipRes = await checkAndConsumeStrict(`auth_ip#${ip}`, 'auth_ip', { limit: 20, windowSec: 900 });
    if (!ipRes.allowed) return true;
    if (email) {
      const emRes = await checkAndConsumeStrict(`auth_email#${email}`, 'auth_email', { limit: 5, windowSec: 900 });
      if (!emRes.allowed) return true;
    }
    return false;
  } catch (err) {
    logger.warn(
      { errMessage: err instanceof Error ? err.message : String(err) },
      'auth rate-limit check threw — failing closed',
    );
    return true;
  }
}

/**
 * Build the public/auth router mounted at /api/auth. NO bearer-token middleware:
 * login + accept + verify are reached BEFORE a session exists. Each route does
 * its own fail-closed rate limiting and constant-work handling. The invite
 * CREATION route lives on the authenticated member router (admin capability).
 */
export function buildAuthRouter(): Hono {
  const auth = new Hono();

  // POST /api/auth/login { email } — ALWAYS 202 with constant work, no
  // enumeration. If an ACTIVE user exists, mint a login magic token (15m) and
  // email a <DASHBOARD_URL>/verify?token=<raw> link. We never reveal whether
  // the account exists, and we never return a uniquely-identifying 429 — a
  // rate-limited request also returns the same 202.
  auth.post('/login', async (c) => {
    const body = await c.req.json<{ email?: string }>().catch(() => null);
    const email = normalizeEmail(body?.email);
    const limited = await authRateLimited(c, email);
    void writeAudit({
      action: 'login_request',
      surface: 'dashboard',
      result: limited ? 'blocked' : 'ok',
      detail: { sourceIp: sourceIp(c), rateLimited: limited },
    });
    // Constant work + constant response regardless of existence / limit. Only
    // proceed to mint+send when not limited AND the user is active; otherwise
    // we still return the same 202.
    if (!limited && email) {
      try {
        const user = await getUserByEmail(email);
        if (user && user.status === 'active') {
          const raw = await createMagicToken(user.userId, 'login', LOGIN_TTL_MS);
          await sendLoginEmail(user.email, raw);
        }
      } catch (err) {
        logger.warn(
          { errMessage: err instanceof Error ? err.message : String(err) },
          'login magic-link issue failed (suppressed for constant response)',
        );
      }
    }
    return c.json({ status: 'accepted' }, 202);
  });

  // GET /api/auth/invite/:token — validate an invite token. Returns
  // { email, profileId } on success; an IDENTICAL 404 for missing / expired /
  // consumed (no enumeration). Read-only: does NOT consume the token.
  auth.get('/invite/:token', async (c) => {
    const limited = await authRateLimited(c, null);
    if (limited) return c.json({ error: 'not_found' }, 404);
    const raw = c.req.param('token');
    const state = await validateMagicToken(raw, 'invite').catch(() => null);
    if (!state) return c.json({ error: 'not_found' }, 404);
    const user = await getUser(state.userId).catch(() => null);
    if (!user || user.status === 'disabled') return c.json({ error: 'not_found' }, 404);
    return c.json({ email: user.email, profileId: user.profileId });
  });

  // POST /api/auth/invite/:token/accept — consume single-use, flip status=active,
  // mint a per-user session token (userId + profileId), return { token }. No
  // password step.
  auth.post('/invite/:token/accept', async (c) => {
    const limited = await authRateLimited(c, null);
    if (limited) return c.json({ error: 'not_found' }, 404);
    const raw = c.req.param('token');
    const state = await consumeMagicToken(raw, 'invite');
    if (!state) return c.json({ error: 'not_found' }, 404);
    const user = await getUser(state.userId);
    if (!user || user.status === 'disabled') return c.json({ error: 'not_found' }, 404);
    // Conditional invited→active flip (idempotent against a double POST). Falls
    // back to the already-active row if the flip no-ops so an at-most-once
    // session is still minted.
    const activated = (await activateUser(user.userId)) ?? user;
    const token = await mintSessionToken(activated);
    void writeAudit({
      action: 'user_activated',
      surface: 'dashboard',
      result: 'ok',
      userId: user.userId,
      detail: { emailLower: user.emailLower, profileId: user.profileId },
    });
    return c.json({ token, email: user.email, profileId: user.profileId });
  });

  // POST /api/auth/verify { token } — consume single-use login token, mint a
  // session token (userId + profileId), return { token }. No password.
  auth.post('/verify', async (c) => {
    const body = await c.req.json<{ token?: string }>().catch(() => null);
    const raw = typeof body?.token === 'string' ? body.token : '';
    const limited = await authRateLimited(c, null);
    if (limited) {
      void writeAudit({
        action: 'login_failure',
        surface: 'dashboard',
        result: 'blocked',
        detail: { sourceIp: sourceIp(c), reason: 'rate_limited' },
      });
      return c.json({ error: 'not_found' }, 404);
    }
    const state = raw ? await consumeMagicToken(raw, 'login') : null;
    if (!state) {
      void writeAudit({
        action: 'login_failure',
        surface: 'dashboard',
        result: 'blocked',
        detail: { sourceIp: sourceIp(c), reason: 'invalid_token' },
      });
      return c.json({ error: 'not_found' }, 404);
    }
    const user = await getUser(state.userId);
    if (!user || user.status !== 'active') {
      void writeAudit({
        action: 'login_failure',
        surface: 'dashboard',
        result: 'blocked',
        detail: { sourceIp: sourceIp(c), reason: 'inactive_user' },
      });
      return c.json({ error: 'not_found' }, 404);
    }
    await recordLogin(user.userId);
    const token = await mintSessionToken(user);
    void writeAudit({
      action: 'login_success',
      surface: 'dashboard',
      result: 'ok',
      userId: user.userId,
      detail: { emailLower: user.emailLower, profileId: user.profileId },
    });
    return c.json({ token, email: user.email, profileId: user.profileId });
  });

  // POST /api/auth/logout — revoke the caller's current session token. This is
  // the only auth route that needs a bearer, so it authenticates inline rather
  // than gating the whole router (login/accept/verify are pre-session).
  auth.post('/logout', async (c) => {
    const rawBearer = extractBearerToken(c.req.header('authorization'));
    const principal = await authenticateDashboardToken(rawBearer);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    // Never revoke the env break-glass root token.
    if (principal.label === 'Root token') {
      return c.json({ ok: true, note: 'root token not revokable via logout' });
    }
    const ok = await revokeToken(principal.tokenHash);
    return c.json({ ok });
  });

  return auth;
}

/**
 * Map a cost-cap enforcement refusal to a clean HTTP response (always 503, never
 * a generic 500). A NaN spendUsd means the daily total was indeterminate (the
 * strict fail-closed path); a real number means spend is over the cap. Exported
 * as a pure function so the mapping is unit-tested directly, without having to
 * mock the whole agent-turn machinery at the route level.
 */
export function costCapResponse(err: CostCapExceededError): {
  body: Record<string, unknown>;
  status: 503;
} {
  return Number.isNaN(err.spendUsd)
    ? { body: { error: 'cost_cap_unverifiable', capUsd: err.capUsd }, status: 503 }
    : { body: { error: 'cost_cap_exceeded', spendUsd: err.spendUsd, capUsd: err.capUsd }, status: 503 };
}

// ── The legacy mission stack (C-8: EXTRACT, DO NOT DELETE) ────────────────
//
// These four are the `/api/missions*` bodies verbatim, lifted out of
// `buildDashboardRouter` so the Paperclip ACL can be registered in front of
// them behind a flag whose PRIMARY ROLLBACK IS A FLAG FLIP rather than a
// revert. Nothing else changed: same repo calls, same envelopes, same status
// codes, same error slugs.
//
// THEY ARE NEVER CALLED FROM AN ACL HANDLER. The flag picks one whole stack at
// registration; a per-request fallback from Paperclip to DynamoDB is forbidden
// (it would answer a switched-off integration with stale board state and hide
// the outage). Their deletion is the last step of Phase 9, gated on two clean
// weeks — not this phase.

type MissionCtx = Context<DashboardEnv>;

async function legacyListMissions(c: MissionCtx): Promise<Response> {
  if (!(await hasCapability(c, 'missions:read'))) {
    return c.json({ error: 'forbidden', requiredCapability: 'missions:read' }, 403);
  }
  const owner = c.req.query('owner') ?? 'main';
  const rows = await listMissionsForAgent(owner, 100);
  return c.json({ owner, count: rows.length, missions: rows });
}

// Create a mission. Body: { prompt, agentId?, title? }. When agentId is
// omitted we reuse the same Haiku auto-assign the create_mission tool uses,
// falling back to 'main' if no agents can be picked. Returns the created
// mission (with assignmentReason when present). The Missions UI and
// the mission CLI both call this route.
async function legacyCreateMission(c: MissionCtx): Promise<Response> {
  // Mission mutation: require agents:write (operator-tier), the documented
  // capability, not just legacy operator rank. Mirrors the Scheduled cancel
  // gate so a capability-drifted token (operator rank, agents:write stripped)
  // is denied.
  if (!(await hasCapability(c, 'agents:write'))) {
    return c.json({ error: 'forbidden', requiredCapability: 'agents:write' }, 403);
  }
  const body = await c.req
    .json<{ prompt?: string; agentId?: string; title?: string }>()
    .catch(() => null);
  const prompt = body?.prompt?.trim();
  if (!prompt) {
    return c.json({ error: 'missing_prompt' }, 400);
  }
  // Title defaults to the first line of the prompt, capped so the headline
  // stays short.
  const title =
    body?.title?.trim() ||
    prompt.split('\n')[0].trim().slice(0, 80) ||
    'Untitled mission';

  let owner: string;
  let assignmentReason: string;
  const explicit = body?.agentId?.trim();
  if (explicit) {
    const known = listKnownAgents();
    if (!known.includes(explicit)) {
      return c.json(
        { error: 'unknown_agent', agentId: explicit, valid: known },
        400,
      );
    }
    owner = explicit;
    assignmentReason = 'explicit assignment';
  } else {
    try {
      const assign = await autoAssign(title, prompt);
      owner = assign.owner;
      assignmentReason = assign.reason;
    } catch (err) {
      logger.warn(
        { errMessage: err instanceof Error ? err.message : String(err) },
        'mission auto-assign failed; defaulting to main',
      );
      owner = 'main';
      assignmentReason = 'auto-assign failed; defaulted to main';
    }
  }

  const mission = await createMission({
    ownerAgent: owner,
    createdByAgent: 'dashboard',
    createdByChat: dashboardIdentity(c),
    title,
    body: prompt,
    assignmentReason,
  });
  return c.json({ mission }, 201);
}

async function legacyUpdateMissionStatus(
  c: Context<DashboardEnv, '/missions/:owner/:id/status'>,
): Promise<Response> {
  if (!(await hasCapability(c, 'agents:write'))) {
    return c.json({ error: 'forbidden', requiredCapability: 'agents:write' }, 403);
  }
  const owner = c.req.param('owner');
  const id = c.req.param('id');
  const body = await c.req
    .json<{ status: MissionStatus }>()
    .catch(() => null);
  if (!body || !body.status) {
    return c.json({ error: 'missing_status' }, 400);
  }
  // Reject anything that is not a real MissionStatus before it reaches the
  // repo. An arbitrary string was previously persisted into the status field
  // and the GSI1PK partition key, corrupting the board (the row dropped out
  // of every known status lane). 400 keeps garbage out of the index.
  if (!MISSION_STATUSES.includes(body.status)) {
    return c.json(
      { error: 'invalid_status', status: body.status, valid: MISSION_STATUSES },
      400,
    );
  }
  const ok = await updateMissionStatus(owner, id, body.status);
  if (!ok) {
    return c.json({ error: 'not_found', owner, id }, 404);
  }
  return c.json({ ok: true, owner, id, status: body.status });
}

// Reassign a mission to a different owner agent. Owner is part of the
// mission PK, so the repo moves the row across partitions. Body:
// { ownerAgent }. The Missions detail modal's Reassign action calls this.
async function legacyReassignMission(
  c: Context<DashboardEnv, '/missions/:owner/:id/reassign'>,
): Promise<Response> {
  if (!(await hasCapability(c, 'agents:write'))) {
    return c.json({ error: 'forbidden', requiredCapability: 'agents:write' }, 403);
  }
  const owner = c.req.param('owner');
  const id = c.req.param('id');
  const body = await c.req
    .json<{ ownerAgent?: string }>()
    .catch(() => null);
  const newOwner = body?.ownerAgent?.trim();
  if (!newOwner) {
    return c.json({ error: 'missing_ownerAgent' }, 400);
  }
  const known = listKnownAgents();
  if (!known.includes(newOwner)) {
    return c.json(
      { error: 'unknown_agent', agentId: newOwner, valid: known },
      400,
    );
  }
  const mission = await reassignMission(owner, id, newOwner);
  if (!mission) {
    return c.json({ error: 'not_found', owner, id }, 404);
  }
  return c.json({ ok: true, mission });
}

export function buildDashboardRouter(): Hono<DashboardEnv> {
  const router = new Hono<DashboardEnv>();

  router.use('*', async (c, next) => {
    const raw = extractBearerToken(c.req.header('authorization'));
    const principal = await authenticateDashboardToken(raw);
    if (!principal) {
      // M8: every failed dashboard auth is an always-audited security event.
      // Never log the token value; capture path + source IP for triage.
      const sourceIp =
        c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
        c.req.header('x-real-ip') ??
        null;
      logger.warn(
        { path: c.req.path, method: c.req.method, sourceIp },
        'dashboard auth failure',
      );
      void writeAudit({
        action: 'auth_failure',
        surface: 'dashboard',
        result: 'blocked',
        detail: {
          path: c.req.path,
          method: c.req.method,
          ...(sourceIp ? { sourceIp } : {}),
        },
      });
      return c.json({ error: 'unauthorized' }, 401);
    }
    // Per-request principal (not a module global) so concurrent requests
    // can't clobber each other's identity for audit attribution.
    c.set('principal', principal);
    // dashboard_read_disabled: gate read endpoints only, leave POST
    // (which includes the kill-switch toggle itself) reachable so we can
    // turn the switch off again.
    if (c.req.method === 'GET') {
      const blocked = await isKillSwitchActive('dashboard_read_disabled');
      if (blocked.active) {
        return c.json(
          { error: 'dashboard_read_disabled', reason: blocked.reason },
          503,
        );
      }
    }
    // Role enforcement. subPath strips the /api mount prefix.
    const subPath = c.req.path.replace(/^\/api/, '');
    const need = requiredRole(c.req.method, subPath);
    if (ROLE_RANK[principal.role] < ROLE_RANK[need]) {
      return c.json(
        { error: 'forbidden', requiredRole: need, yourRole: principal.role },
        403,
      );
    }
    await next();
  });

  // Wave 4b: whoami carries the caller's identity AND their resolved RBAC set so
  // the SPA can gate the sidebar / route guards on capabilities (web auth.ts
  // hasCapability) instead of the coarse legacy role. role + label stay for
  // backward compat with pre-4b clients. The principal is always present here —
  // the router-wide middleware (router.use('*')) rejects unauthenticated
  // requests with 401 before any route runs — but we still null-guard so a
  // future direct caller can't NPE.
  router.get('/whoami', async (c) => {
    const p = getPrincipal(c);
    if (!p) {
      // Defensive: the middleware should have 401'd already. Return the
      // backward-compatible empty shape rather than throwing.
      return c.json({
        role: 'viewer' as TokenRole,
        label: null,
        email: null,
        profileId: null,
        capabilities: [] as string[],
        hashPrefix: null,
        expiresAt: null,
      });
    }
    // Resolve the effective capability set + profileId through the ONE reviewed
    // helper (capabilitiesForPrincipal → dashboard-auth.capabilitiesForPrincipal),
    // the same path the per-route hasCapability gate uses, so whoami can never
    // report a set that disagrees with enforcement.
    const { profileId, caps } = await capabilitiesForPrincipal(p);
    // Email lives on the user row, not the token principal. Resolve it from the
    // bound userId (present on Wave-4a member sessions; absent on the env root /
    // legacy operator tokens → email stays null). Fail soft: a lookup error
    // never blocks whoami, it just omits the email.
    let email: string | null = null;
    if (p.userId) {
      const user = await getUser(p.userId).catch((err) => {
        logger.warn(
          { errMessage: err instanceof Error ? err.message : String(err) },
          'whoami user lookup failed — omitting email',
        );
        return null;
      });
      email = user?.email ?? null;
    }
    return c.json({
      role: p.role,
      label: p.label ?? null,
      email,
      profileId,
      capabilities: Array.from(caps).sort(),
      hashPrefix: p.hashPrefix16 ?? null,
      expiresAt: p.expiresAt ?? null,
    });
  });

  // Update discovery (IaC readiness item 46). Read-only, fail-silent, cached
  // in-process for 24h by the discovery module; a GitHub outage or rate limit
  // returns the cached/empty result and never degrades anything else. The
  // result is VERIFY-BEFORE-DISPLAY: until signed release metadata + trust
  // roots exist, `verified` is false and `reason` is 'unverified', and the
  // renderer must degrade to "update check unavailable/unverified" instead of
  // showing unverified claims. The dashboard banner that consumes this lives
  // in web/ and is a follow-up — this route is the contract it will read.
  router.get('/updates', async (c) => {
    return c.json(await checkForUpdates(process.env));
  });

  router.get('/agents', async (c) => {
    // Wave 5 granular RBAC: the Agents tab reads gate on agents:read (split from
    // the coarse dashboard:read; viewer holds it, so behaviour is unchanged).
    if (!(await hasCapability(c, 'agents:read'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'agents:read' }, 403);
    }
    const [builtinIds, dbAgents] = await Promise.all([
      listKnownAgentsAsync(),
      listAgents(),
    ]);
    const dbMap = new Map(dbAgents.map((a) => [a.agentId, a]));
    const agents = await Promise.all(
      builtinIds.map(async (id) => {
        const config = await loadAgent(id);
        const meta = dbMap.get(id);
        return {
          id: config.agentId,
          displayName: meta?.displayName ?? config.displayName,
          description: meta?.description || extractDescription(config.agentId, config.systemPrompt),
          model: meta?.model ?? config.model ?? null,
          status: meta?.status ?? 'active',
          personaPrefix: config.personaPrefix ?? null,
          systemPromptPreview: config.systemPrompt.slice(0, 200),
          telegramConnected: Boolean(meta?.telegramBotToken),
          slackConnected: Boolean(meta?.slackBotToken),
          createdAt: meta?.createdAt ?? null,
        };
      }),
    );
    // Also include DDB agents not in builtins
    for (const a of dbAgents) {
      if (!builtinIds.includes(a.agentId)) {
        const config = await loadAgent(a.agentId);
        agents.push({
          id: a.agentId,
          displayName: a.displayName,
          description: a.description,
          model: a.model ?? null,
          status: a.status,
          personaPrefix: config.personaPrefix ?? null,
          systemPromptPreview: config.systemPrompt.slice(0, 200),
          telegramConnected: Boolean(a.telegramBotToken),
          slackConnected: Boolean(a.slackBotToken),
          createdAt: a.createdAt ?? null,
        });
      }
    }
    return c.json({ agents });
  });

  // Aggregate rollup across every known agent. Must be registered before
  // the parametric /agents/:agentId/health so the literal segment wins.
  // Reuses computeAgentHealth (the same per-agent read) plus the existing
  // agent loader; stays a read.
  router.get('/agents/health', async (c) => {
    if (!(await hasCapability(c, 'agents:read'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'agents:read' }, 403);
    }
    const [builtinIds, dbAgents] = await Promise.all([
      listKnownAgentsAsync(),
      listAgents(),
    ]);
    const ids = new Set<string>(builtinIds);
    for (const a of dbAgents) ids.add(a.agentId);

    const agents = await Promise.all(
      Array.from(ids).map(async (agentId) => {
        const h = await computeAgentHealth(agentId);
        return { agentId, ...h };
      }),
    );

    // Compact rollup the Overview card can render without re-fetching
    // per-agent detail. Worst individual status drives `overall`.
    const counts = { healthy: 0, idle: 0, degraded: 0, error: 0 };
    let totalMessages24h = 0;
    let totalErrors24h = 0;
    for (const a of agents) {
      counts[a.status] += 1;
      totalMessages24h += a.messagesLast24h;
      totalErrors24h += a.errorsLast24h;
    }
    let overall: 'healthy' | 'idle' | 'degraded' | 'error';
    if (counts.error > 0) overall = 'error';
    else if (counts.degraded > 0) overall = 'degraded';
    else if (counts.healthy > 0) overall = 'healthy';
    else overall = 'idle';

    return c.json({
      generatedAt: new Date().toISOString(),
      overall,
      agentCount: agents.length,
      counts,
      totalMessages24h,
      totalErrors24h,
      agents,
    });
  });

  router.get('/agents/:agentId/health', async (c) => {
    if (!(await hasCapability(c, 'agents:read'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'agents:read' }, 403);
    }
    const agentId = c.req.param('agentId');
    const health = await computeAgentHealth(agentId);
    return c.json(health);
  });

  router.get('/agents/:agentId/file', async (c) => {
    if (!(await hasCapability(c, 'agents:read'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'agents:read' }, 403);
    }
    const agentId = c.req.param('agentId');
    const filename = (c.req.query('file') ?? 'CLAUDE.md') as AgentFileName;
    const agent = await loadAgent(agentId);
    // Current "file body" = whatever the loader resolved (S3 or built-in
    // default). Latest revision (if any) is returned as separate info.
    const body =
      filename === 'CLAUDE.md'
        ? agent.systemPrompt
        : `displayName: ${agent.displayName}\nmodel: ${agent.model ?? ''}\npersonaPrefix: ${agent.personaPrefix ?? ''}\niconUrl: ${agent.iconUrl ?? ''}\n`;
    return c.json({ agentId, filename, body });
  });

  router.put('/agents/:agentId/file', async (c) => {
    // Capability gate (matches the sibling GET's agents:read). Editing an
    // agent's CLAUDE.md is a stored-injection primitive, so it must check the
    // same capability model as the read, not only the weaker legacy role.
    if (!(await hasCapability(c, 'agents:write'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'agents:write' }, 403);
    }
    const agentId = c.req.param('agentId');
    const body = await c.req
      .json<{ filename?: AgentFileName; body: string; note?: string }>()
      .catch(() => null);
    if (!body || !body.body) {
      return c.json({ error: 'missing_body' }, 400);
    }
    const filename = body.filename ?? 'CLAUDE.md';
    const rev = await saveAgentFile({
      agentId,
      filename,
      body: body.body,
      editedBy: operatorIdentity(c),
      ...(body.note ? { note: body.note } : {}),
    });
    // Write to S3 so the agent-loader picks up the change
    const configBucket = process.env.CONFIG_BUCKET;
    if (configBucket) {
      const { S3Client, PutObjectCommand } = await import('@aws-sdk/client-s3');
      const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });
      await s3.send(new PutObjectCommand({
        Bucket: configBucket,
        Key: `agents/${agentId}/${filename}`,
        Body: body.body,
        ContentType: 'text/plain; charset=utf-8',
      }));
    }
    invalidateAgentCache(agentId);
    return c.json({
      ok: true,
      revId: rev.revId,
      bodyHash: rev.bodyHash,
    });
  });

  router.get('/agents/:agentId/history', async (c) => {
    const agentId = c.req.param('agentId');
    const limit = Math.max(1, Math.min(100, Number(c.req.query('limit') ?? 25)));
    const rows = await listRevisions(agentId, limit);
    // Don't ship full bodies in the list view — only metadata.
    return c.json({
      agentId,
      count: rows.length,
      revisions: rows.map((r) => ({
        revId: r.revId,
        filename: r.filename,
        bodyHash: r.bodyHash,
        editedBy: r.editedBy,
        note: r.note,
        createdAt: r.createdAt,
        chars: r.body.length,
      })),
    });
  });

  router.get('/agents/:agentId/history/:revId', async (c) => {
    const agentId = c.req.param('agentId');
    const revId = c.req.param('revId');
    const all = await listRevisions(agentId, 200);
    const rev = all.find((r) => r.revId === revId || r.revId.startsWith(revId));
    if (!rev) return c.json({ error: 'not_found' }, 404);
    return c.json(rev);
  });

  router.get('/agents/templates', (c) => {
    const templates = listTemplates().map((t) => ({
      id: t.id,
      displayName: t.displayName,
      description: t.description,
      tagline: t.tagline,
      icon: t.icon,
      category: t.category,
      suggestedModel: t.suggestedModel ?? null,
      suggestedKnowledgeScope: t.suggestedKnowledgeScope ?? null,
      suggestedFirstMessage: t.suggestedFirstMessage ?? null,
      claudeMdPreview: t.buildClaudeMd().slice(0, 300),
    }));
    return c.json({ templates });
  });

  // Full prompt for the gallery's "preview prompt" modal.
  router.get('/agents/templates/:id', (c) => {
    const t = getTemplate(c.req.param('id'));
    if (!t) return c.json({ error: 'not_found' }, 404);
    return c.json({
      id: t.id,
      displayName: t.displayName,
      description: t.description,
      tagline: t.tagline,
      icon: t.icon,
      category: t.category,
      claudeMd: t.buildClaudeMd(),
    });
  });

  router.post('/agents/validate-id', async (c) => {
    const body = await c.req.json<{ id?: string }>().catch(() => null);
    if (!body?.id) return c.json({ ok: false, error: 'missing id' }, 400);
    const result = await validateAgentId(body.id);
    return c.json(result);
  });

  router.post('/agents/create', async (c) => {
    // Defense-in-depth capability gate (matches PUT /agents/:agentId/file and
    // the scheduled-cancel route). The legacy requiredRole='operator' middleware
    // still runs first; this ADDITIONALLY denies a custom operator-rank profile
    // with agents:write stripped — the principal the UI shows the control to.
    if (!(await hasCapability(c, 'agents:write'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'agents:write' }, 403);
    }
    const body = await c.req.json<{
      id: string; name: string; description: string; model?: string; template?: string;
      knowledgeScope?: string;
    }>().catch(() => null);
    if (!body?.id || !body?.name) return c.json({ error: 'missing required fields' }, 400);
    try {
      const agent = await createAgentFull({
        id: body.id,
        name: body.name,
        description: body.description ?? '',
        model: body.model,
        template: body.template,
        // Template-suggested (or user-picked) vector corpus; previously this
        // was silently dropped and every new agent landed on 'default'.
        ...(body.knowledgeScope ? { knowledgeScope: body.knowledgeScope } : {}),
        createdBy: operatorIdentity(c),
      });
      return c.json({ ok: true, agent: redactAgent(agent) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ err: msg }, 'agent creation failed');
      return c.json({ error: msg }, 400);
    }
  });

  router.get('/agents/:id/detail', async (c) => {
    const agentId = c.req.param('id');
    const dbAgent = await getAgent(agentId);
    const isBuiltin = (await listKnownAgentsAsync()).includes(agentId);
    // A dashboard-created agent always has a complete DDB row.
    if (dbAgent && !isBuiltin) return c.json({ agent: redactAgent(dbAgent) });
    // Built-in agents (main, ops, research) are config-backed and may have NO
    // DDB row — or a PARTIAL one. Connecting a channel upserts a partial row
    // (creds + status only) via updateAgent, so reading it raw would blank out
    // the name/model. Merge: display fields come from the loaded config, channel
    // state + any saved overrides come from the row. Never returns secret values.
    const config = await loadAgent(agentId);
    if (config.agentId === agentId) {
      return c.json({
        agent: {
          agentId,
          displayName: dbAgent?.displayName ?? config.displayName,
          description: dbAgent?.description ?? '',
          model: dbAgent?.model ?? config.model ?? '',
          status: dbAgent?.status ?? 'active',
          // Surface the effective scope so the UI shows the real corpus for
          // built-in agents too, consistent with created agents' agent.yaml.
          knowledgeScope: dbAgent?.knowledgeScope ?? config.knowledgeScope ?? 'default',
          telegramConnected: Boolean(dbAgent?.telegramBotToken),
          telegramBotUsername: dbAgent?.telegramBotUsername,
          slackConnected: Boolean(dbAgent?.slackBotToken),
          slackAppId: dbAgent?.slackAppId,
          slackBotUsername: dbAgent?.slackBotUsername,
          createdAt: dbAgent?.createdAt ?? '',
          updatedAt: dbAgent?.updatedAt ?? '',
          createdBy: dbAgent?.createdBy ?? 'builtin',
        },
      });
    }
    return c.json({ error: 'not_found' }, 404);
  });

  router.patch('/agents/:id', async (c) => {
    // Defense-in-depth capability gate (see POST /agents/create).
    if (!(await hasCapability(c, 'agents:write'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'agents:write' }, 403);
    }
    const agentId = c.req.param('id');
    const body = await c.req
      .json<{
        displayName?: string;
        description?: string;
        model?: string;
        knowledgeScope?: string;
      }>()
      .catch(() => null);
    if (!body) return c.json({ error: 'invalid body' }, 400);
    // c.req.json<T>() is a cast, not a validator: build the update from an
    // explicit allowlist so arbitrary client-supplied keys can't land on the
    // agent metadata row unchecked.
    const updates: Partial<{
      displayName: string;
      description: string;
      model: string;
      knowledgeScope: string;
    }> = {};
    if (typeof body.displayName === 'string') updates.displayName = body.displayName;
    if (typeof body.description === 'string') updates.description = body.description;
    if (typeof body.model === 'string') updates.model = body.model;
    if (typeof body.knowledgeScope === 'string') updates.knowledgeScope = body.knowledgeScope;
    if (Object.keys(updates).length === 0) {
      return c.json({ error: 'no_updatable_fields' }, 400);
    }
    // Validate the model against the live catalog before it lands on the row.
    // The dropdown only offers catalog ids, but a direct API call could persist
    // a bogus model that then ValidationExceptions on every future turn for this
    // agent — exactly the "stuck / broken" failure we're hardening against.
    if (typeof updates.model === 'string') {
      const known = new Set(listAvailableModels(process.env).map((m) => m.id));
      if (!known.has(updates.model)) {
        return c.json(
          { error: 'unknown_model', model: updates.model, available: [...known] },
          400,
        );
      }
    }
    const { updateAgent } = await import('../../lib/state/agents-repo.js');
    await updateAgent(agentId, { ...updates, updatedAt: new Date().toISOString() });
    // knowledgeScope is read by the vector-search tool from agent.yaml in S3
    // (agent-loader -> fetchKnowledgeScope), not from the DDB row. Persist it
    // there too so the saved scope actually changes vector search, then drop
    // the loader cache so the next turn re-reads it.
    if (typeof updates.knowledgeScope === 'string') {
      await persistKnowledgeScopeToS3(agentId, updates.knowledgeScope);
    }
    // Bust the loader cache when anything the runtime reads through loadAgent
    // changes: knowledgeScope (read from S3 agent.yaml) or the per-agent model
    // (read from the DDB row). Without this the next turn keeps the cached
    // config for up to the 5-minute TTL.
    if (typeof updates.knowledgeScope === 'string' || typeof updates.model === 'string') {
      invalidateAgentCache(agentId);
      // Fan the bust out to peer tasks. invalidateAgentCache only clears THIS
      // task's cache; on a multi-task fleet the others would keep serving the old
      // model/scope for up to the loader's 5-minute TTL — the "my change didn't
      // take" symptom. Best-effort: a no-op without the SNS topic wired.
      void publishInvalidation('agent', agentId);
    }
    return c.json({ ok: true });
  });

  router.delete('/agents/:id', async (c) => {
    // Defense-in-depth capability gate (see POST /agents/create).
    if (!(await hasCapability(c, 'agents:write'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'agents:write' }, 403);
    }
    try {
      await deleteAgentFull(c.req.param('id'));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  router.post('/agents/:id/activate', async (c) => {
    // Defense-in-depth capability gate (see POST /agents/create).
    if (!(await hasCapability(c, 'agents:write'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'agents:write' }, 403);
    }
    await activateAgent(c.req.param('id'));
    return c.json({ ok: true });
  });

  router.post('/agents/:id/deactivate', async (c) => {
    // Defense-in-depth capability gate (see POST /agents/create).
    if (!(await hasCapability(c, 'agents:write'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'agents:write' }, 403);
    }
    await deactivateAgent(c.req.param('id'));
    return c.json({ ok: true });
  });

  router.post('/agents/:id/telegram/validate-token', async (c) => {
    const body = await c.req.json<{ token?: string }>().catch(() => null);
    if (!body?.token) return c.json({ ok: false, error: 'missing token' }, 400);
    const result = await validateTelegramToken(body.token);
    return c.json(result);
  });

  router.post('/agents/:id/telegram/connect', async (c) => {
    // Defense-in-depth capability gate (see POST /agents/create). Connecting a
    // channel stores bot credentials on the agent — a write.
    if (!(await hasCapability(c, 'agents:write'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'agents:write' }, 403);
    }
    const body = await c.req.json<{ token: string; webhookDomain?: string }>().catch(() => null);
    if (!body?.token) return c.json({ error: 'missing token' }, 400);
    try {
      await connectTelegram(c.req.param('id'), body.token, body.webhookDomain);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  router.post('/agents/:id/telegram/disconnect', async (c) => {
    // Defense-in-depth capability gate (see POST /agents/create).
    if (!(await hasCapability(c, 'agents:write'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'agents:write' }, 403);
    }
    try {
      await disconnectTelegram(c.req.param('id'));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  router.post('/agents/:id/slack/validate-token', async (c) => {
    const body = await c.req.json<{ botToken?: string; signingSecret?: string }>().catch(() => null);
    if (!body?.botToken) return c.json({ ok: false, error: 'missing botToken' }, 400);
    const result = await validateSlackToken(body.botToken);
    return c.json(result);
  });

  router.post('/agents/:id/slack/connect', async (c) => {
    // Defense-in-depth capability gate (see POST /agents/create). Connecting a
    // channel stores bot credentials on the agent — a write.
    if (!(await hasCapability(c, 'agents:write'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'agents:write' }, 403);
    }
    const body = await c.req.json<{ botToken: string; signingSecret: string }>().catch(() => null);
    if (!body?.botToken || !body?.signingSecret) return c.json({ error: 'missing fields' }, 400);
    try {
      await connectSlack(c.req.param('id'), body.botToken, body.signingSecret);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  router.post('/agents/:id/slack/disconnect', async (c) => {
    // Defense-in-depth capability gate (see POST /agents/create).
    if (!(await hasCapability(c, 'agents:write'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'agents:write' }, 403);
    }
    try {
      await disconnectSlack(c.req.param('id'));
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  router.get('/agents/:id/slack/manifest', async (c) => {
    const agentId = c.req.param('id');
    const domain = c.req.query('domain') ?? c.req.header('host') ?? 'your-domain.com';
    const agent = await getAgent(agentId);
    const displayName = agent?.displayName ?? agentId;
    const manifest = generateSlackManifest(agentId, displayName, domain);
    return c.json({ manifest });
  });

  // Model catalog for the Chat model picker. Lists every Bedrock model the
  // platform is configured for (env-driven via listAvailableModels) so an
  // operator can choose which one answers a given turn. chat:read-gated to
  // mirror the Chat tab itself; the payload is model labels + context windows,
  // never secrets. defaultModelId is what a turn falls back to with no override.
  router.get('/models', async (c) => {
    if (!(await hasCapability(c, 'chat:read'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'chat:read' }, 403);
    }
    const defaultModelId = pickDefaultModel(process.env);
    const models = listAvailableModels(process.env).map((m) => ({
      label: m.label,
      id: m.id,
      contextWindow: m.contextWindow,
      family: resolveModel(m.id).family,
      isDefault: m.id === defaultModelId,
    }));
    return c.json({ models, defaultModelId });
  });

  // ── Model Playground ───────────────────────────────────────────────
  // Raw "one prompt, many models, side by side" comparison surface. Unlike
  // the Chat tab (which runs the full Claude-tuned agent loop), the Playground
  // does a bare cross-provider Converse call — no tools, no memory, no
  // Anthropic-only prompt caching — so you can compare how *the model itself*
  // answers, including the non-Anthropic families AWS serves on Bedrock.

  // Catalog the picker shows. Used by both the Playground (chat:read) and the
  // Knowledge tab's grounded model test (vectors:read), so either capability
  // can read it. The payload is model labels only, never secrets.
  router.get('/playground/models', async (c) => {
    if (!(await hasCapability(c, 'chat:read')) && !(await hasCapability(c, 'vectors:read'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'chat:read' }, 403);
    }
    return c.json({ models: listPlaygroundModels(process.env) });
  });

  // Run ONE model against a prompt. The SPA fires this once per selected model
  // in parallel so each column resolves (or fails) independently — a model the
  // account can't access just reports its own error without sinking the batch.
  router.post('/playground/run', async (c) => {
    if (!(await hasCapability(c, 'chat:read'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'chat:read' }, 403);
    }
    const body = await c.req
      .json<{ prompt?: string; modelId?: string; system?: string }>()
      .catch(() => null);
    const prompt = (body?.prompt ?? '').trim();
    const modelId = body?.modelId ?? '';
    if (!prompt) {
      return c.json({ error: 'missing_prompt' }, 400);
    }
    // Allowlist: only models we publish in the catalog are invocable here, so
    // this endpoint can never be coerced into calling an arbitrary modelId.
    const model = listPlaygroundModels(process.env).find((m) => m.id === modelId);
    if (!model) {
      return c.json({ error: 'unknown_model' }, 400);
    }

    // Per-principal (and per-IP) rate limit. The SPA fans this out one call per
    // selected model, so a single "run" already costs N paid invocations; a
    // tight ticking of the run button can multiply that without bound. We
    // consume one token from the caller's quota AND the source IP's quota under
    // the shared 'playground' scope BEFORE any Bedrock spend. checkAndConsume is
    // opt-in (unlimited until an operator seeds POLICY#playground) and fails
    // open on a DDB blip, so this never bricks the surface; when a policy is
    // configured, exceeding it returns 429 and invokes ZERO models.
    const principalKey = dashboardIdentity(c);
    const ip = sourceIp(c);
    const limitChecks = [checkAndConsume(`playground#${principalKey}`, 'playground')];
    if (ip && ip !== 'unknown') {
      limitChecks.push(checkAndConsume(`playground_ip#${ip}`, 'playground'));
    }
    const limitResults = await Promise.all(limitChecks);
    const limited = limitResults.find((r) => !r.allowed);
    if (limited) {
      return c.json(
        { error: 'rate_limited', remaining: limited.remaining, resetAt: limited.resetAt },
        429,
      );
    }

    // Same safety gates the agent loop honors before spending Bedrock money.
    const killed = await isKillSwitchActive('bedrock_global');
    if (killed.active) {
      return c.json({ error: 'kill_switch_active', reason: killed.reason ?? null }, 503);
    }
    // Cost-cap pre-check. Always compare the day's spend to the effective cap
    // BEFORE invoking a model — not only when the cost_cap_per_day kill switch
    // is toggled on — so Playground fan-out can never push spend past the cap
    // unobserved. (Previously this only fired while the switch was active, which
    // left the cap structurally blind here.) Admit the call only while under cap.
    const capUsd = await getEffectiveCostCap();
    if (Number.isFinite(capUsd)) {
      // Strict read: an indeterminate spend total fails CLOSED (503), so a
      // DDB/IAM/throttle failure can never hide spend and admit a paid
      // fan-out past the cap. We run this BEFORE acquiring the concurrency
      // gate below, so there is no slot to release on this path.
      let spendUsd: number;
      try {
        spendUsd = await getDailyCostUsd({ strict: true });
      } catch (err) {
        if (err instanceof SpendIndeterminateError) {
          return c.json({ error: 'cost_cap_unverifiable' }, 503);
        }
        throw err;
      }
      if (spendUsd >= capUsd) {
        return c.json({ error: 'cost_cap_exceeded', spendUsd, capUsd }, 503);
      }
    }

    // Concurrency cap: admit at most PLAYGROUND_MAX_CONCURRENT paid calls in
    // flight across all parallel /playground/run requests on this task. A
    // caller that loses the race is rejected (429) and spends nothing rather
    // than firing alongside the rest before the cap window can catch up.
    if (!playgroundGate.tryAcquire()) {
      return c.json({ error: 'rate_limited', reason: 'too_many_concurrent' }, 429);
    }

    try {
      const out = await converseTurn({
        modelId,
        // Neutral, short system prompt so the comparison is about the model,
        // not a Claude-specific persona. Caller may override.
        systemPrompt: (body?.system ?? '').trim() || 'You are a helpful AI assistant. Answer clearly and concisely.',
        userText: prompt,
        disableCache: true, // cross-provider: no Anthropic cachePoint blocks
        omitTemperature: true, // some models (opus-4.7) reject it; compare on each model's default
        maxTokens: 1024,
      });
      // costUsd (number | null) is the HONEST price returned to the UI: null for
      // a model with no verified price, so the UI shows a dash rather than a
      // guess. meteredCost is what feeds the cost cap: it falls back to a
      // conservative estimate for unpriced models so an unpriced paid call is
      // never recorded as zero and left invisible to getDailyCostUsd() (and thus
      // the pre-invocation cap check above on the next call).
      const costUsd = playgroundCost(model, out.inputTokens, out.outputTokens);
      const meteredCost = playgroundMeteredCost(model, out.inputTokens, out.outputTokens);
      // AWAITED (not fire-and-forget): a failed usage write must be loud, not
      // silently drop spend from the cap. We cannot un-spend the call, so we log
      // loudly rather than fail the response (the money is already spent).
      // recordUsage returns FALSE on a caught DDB write failure (it does NOT
      // throw), so capture the boolean: a false return means the spend was NOT
      // metered and the cap is now blind to it. The surrounding try/catch stays
      // as a defensive backstop for an unexpected throw. A full per-process
      // circuit breaker is out of scope here; the per-principal rate limit plus
      // the concurrency cap already bound the blast radius during a usage-table
      // outage.
      try {
        const metered = await recordUsage({
          agentId: PLAYGROUND_USAGE_AGENT,
          chatId: `dashboard:playground:${dashboardIdentity(c)}`,
          surface: 'dashboard',
          modelId,
          inputTokens: out.inputTokens,
          outputTokens: out.outputTokens,
          costUsd: meteredCost,
          latencyMs: out.latencyMs,
          userId: dashboardIdentity(c),
        });
        if (!metered) {
          logger.error(
            { modelId },
            'playground: usage write returned false; spend NOT reflected in the daily cost cap',
          );
          void writeAudit({
            action: 'playground_meter_failed' as AuditEvent['action'],
            surface: 'dashboard',
            userId: dashboardIdentity(c),
            detail: { modelId },
            result: 'error',
          });
        }
      } catch (err) {
        logger.error(
          { modelId, errMessage: err instanceof Error ? err.message : String(err) },
          'playground: usage write failed; this spend is NOT reflected in the daily cost cap',
        );
      }
      void writeAudit({
        action: 'playground_run',
        surface: 'dashboard',
        userId: dashboardIdentity(c),
        detail: { modelId, provider: model.provider, inputTokens: out.inputTokens, outputTokens: out.outputTokens },
        result: 'ok',
      });
      return c.json({
        ok: true,
        modelId,
        provider: model.provider,
        name: model.name,
        text: out.text,
        inputTokens: out.inputTokens,
        outputTokens: out.outputTokens,
        costUsd, // number | null (null = no verified price for this model)
        latencyMs: out.latencyMs,
        stopReason: out.stopReason,
      });
    } catch (err) {
      // Model-level failure (AccessDenied, ValidationException, throttle, …).
      // 200 with ok:false so the SPA renders it in that model's column rather
      // than treating it as a transport error for the whole comparison. No
      // usage is recorded for a failed call (no tokens were billed).
      const msg = err instanceof Error ? err.message : String(err);
      const errName = (err as { name?: string }).name ?? 'Error';
      logger.warn({ modelId, errName, errMessage: truncateForLog(msg, 200) }, 'playground run failed');
      return c.json({ ok: false, modelId, provider: model.provider, name: model.name, error: errName, detail: msg });
    } finally {
      // Always release the concurrency slot, on success OR failure.
      playgroundGate.release();
    }
  });

  // SSE chat — same shape as /test-turn but streams chunks as they
  // arrive from Bedrock. POST keeps the user prompt out of access logs.
  router.post('/test-turn/stream', async (c) => {
    // Wave 5 (fix): same gate as POST /test-turn. The send still requires operator
    // (legacy requiredRole returns 'operator' for this POST — unchanged). We ADD an
    // explicit chat:read check so the streaming send agrees with the SPA's /chat
    // route guard. operator holds chat:read, so the operator send path is not
    // narrowed; a profile lacking chat:read just can't reach the stream either.
    if (!(await hasCapability(c, 'chat:read'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'chat:read' }, 403);
    }
    const body = await c.req
      .json<{
        text?: string;
        agentId?: string;
        chatId?: string;
        modelOverride?: string;
        /** Pre-staged uploads (presigned PUT to the vectors staging bucket). */
        attachments?: Array<{ s3Key?: string; fileName?: string; mimeType?: string }>;
      }>()
      .catch(() => null);
    const text = body?.text ?? '';
    const agentId = body?.agentId ?? 'main';
    const chatId = safeDashboardChatId(body?.chatId);
    const rawAttachments = Array.isArray(body?.attachments)
      ? body.attachments.slice(0, 3)
      : [];
    // File-only sends are allowed (parity with Telegram/Slack file drops).
    if (!text && rawAttachments.length === 0) {
      return c.json({ error: 'missing_text' }, 400);
    }
    // Validate staging keys up front — only presigned-upload keys are ever
    // read back (prevents pointing the loader at arbitrary bucket objects).
    for (const a of rawAttachments) {
      if (!a?.s3Key || !isUploadKey(a.s3Key)) {
        return c.json({ error: 'invalid_upload_key' }, 400);
      }
    }
    // WI-1.1 (decision 9): refuse a conversation the caller does not own before
    // anything touches it — slash commands included, since /newchat wipes a
    // history. The same 404 DELETE /sessions gives, so a chat id cannot be probed.
    const stored = await getSession(agentId, chatId);
    if (stored && !ownsConversation(c, stored.userId)) {
      return c.json({ error: 'not_found' }, 404);
    }
    return streamSSE(c, async (stream) => {
      // Command? send the reply as a single event and close. Skipped for
      // attachment turns — a caption starting with '/' is data, not a command
      // (parity with Telegram/Slack).
      if (rawAttachments.length === 0) {
        const cmd = await runCommand(agentId, chatId, text);
        if (cmd?.reply) {
          await stream.writeSSE({ event: 'reply', data: cmd.reply });
          await stream.writeSSE({ event: 'done', data: 'command' });
          return;
        }
      }

      // Attachments: load staged bytes, run the shared media pipeline
      // (raw-bucket archival, inline blocks, Transcribe, KB auto-ingest),
      // narrate stages over SSE, then clean up the staging object.
      let userText = text;
      const attachmentBlocks: AttachmentBlock[] = [];
      const kbConfirmations: string[] = [];
      const acks: string[] = [];
      for (const a of rawAttachments) {
        const s3Key = a.s3Key as string;
        const fileName = (a.fileName ?? s3Key.split('/').pop() ?? 'upload').slice(0, 120);
        try {
          const bytes = await getObjectBuffer(s3Key);
          const media = await processMedia(
            {
              surface: 'dashboard',
              agentId,
              targetAgentId: agentId,
              chatId,
              kind: kindForMime(a.mimeType),
              fileName,
              mimeType: a.mimeType,
              bytes,
            },
            (stage) => {
              void stream.writeSSE({
                event: 'media',
                data: JSON.stringify({ fileName, stage, label: stageLabel(stage, fileName) }),
              });
            },
          );
          attachmentBlocks.push(...media.blocks);
          if (media.transcript) {
            const label =
              media.transcriptKind === 'video' ? '[video transcript]' : '[transcribed audio]';
            userText = userText ? `${userText}\n\n${label} ${media.transcript}` : media.transcript;
          }
          if (media.ackText) acks.push(media.ackText);
          if (media.kb) kbConfirmations.push(buildKbConfirmation(media.kb, fileName));
        } catch (err) {
          logger.warn(
            { s3Key, errMessage: err instanceof Error ? err.message : String(err) },
            'dashboard chat attachment processing failed',
          );
          acks.push(`Couldn't process ${fileName}.`);
        } finally {
          void deleteObject(s3Key);
        }
      }
      if (rawAttachments.length > 0 && attachmentBlocks.length === 0 && userText === '' ) {
        // Nothing the model can see (KB-only docs land here; their acks
        // already carry the "indexed, ask me anything" line).
        await stream.writeSSE({ event: 'reply', data: acks.join('\n') || 'Stored the file.' });
        for (const k of kbConfirmations) {
          await stream.writeSSE({ event: 'kb', data: JSON.stringify({ text: k }) });
        }
        await stream.writeSSE({ event: 'done', data: 'media_only' });
        return;
      }
      if (rawAttachments.length > 0 && !userText) userText = 'What is this?';

      // Cross-surface peek (flag default OFF): when the authenticated member
      // is a configured owner (CCE_OWNER_DASHBOARD_EMAILS), inject their
      // recent Telegram/Slack conversation with this agent as READ-ONLY
      // context. Dashboard turns still persist under the dashboard: chatId —
      // the owner session is never written from here (write containment).
      // The peek source is hard-limited to principal-scoped chatIds; a Slack
      // channel session can never leak in.
      let peekNote: string | undefined;
      try {
        if ((await getConfig('sessions', 'cross_surface_peek')) === '1') {
          const principal = getPrincipal(c);
          const email = principal?.userId
            ? (await getUser(principal.userId))?.emailLower
            : undefined;
          const ownerChat = resolveOwnerChatId('dashboard', email);
          if (ownerChat && isPrincipalScopedChatId(ownerChat)) {
            const peekTurns = Math.max(
              1,
              Math.min(10, Number((await getConfig('sessions', 'cross_surface_peek_turns')) ?? 6)),
            );
            const ownerSession = await getSession(agentId, ownerChat);
            const recent = (ownerSession?.turns ?? []).slice(-peekTurns);
            if (recent.length > 0) {
              // Neutralize angle brackets exactly like the hive block so a
              // chat message can't close </other_surfaces> and inject
              // pseudo-structure into the system prompt.
              const lines = recent
                .map((t) => {
                  const safe = t.text.slice(0, 240).replace(/</g, '‹').replace(/>/g, '›');
                  return `- [${t.surface ?? 'chat'}] ${t.role === 'user' ? 'user' : 'you'}: ${safe}`;
                })
                .join('\n');
              peekNote = `<other_surfaces>\nThe same person's recent conversation with you on other chat surfaces (read-only background):\n${lines}\n</other_surfaces>`;
            }
          }
        }
      } catch {
        // Peek is best-effort context; never fail the turn over it.
      }

      const session = await getSession(agentId, chatId);
      const history = session?.turns ?? [];
      // Per-turn model: an explicit picker choice wins, else the chat's sticky
      // /model override, else the agent's configured model (resolved in the
      // loop). The non-stream /test-turn already does this; the stream path used
      // to drop the override entirely, so a /model switch (or the new Chat model
      // picker) silently had no effect on the streamed Chat tab.
      const modelOverride = body?.modelOverride ?? session?.modelOverride;
      try {
        const result = await runAgentTurn({
          agentId,
          chatId,
          userText,
          history,
          modelOverride,
          surface: 'dashboard',
          // A person typed this in a chat window. `origin` is the ONLY thing that
          // lets the emergency kill phrase halt the fleet, it defaults to 'machine',
          // and this is one of the five chat-surface call sites allowed to say so.
          origin: 'human_chat',
          // PARITY GAP, DELIBERATE (see CLAUDE.md, "chat surface parity"):
          // NO `replyChatId` IS PASSED, so `create_mission`'s assignment push
          // is skipped on this surface alone. The missing primitive is an
          // out-of-band channel: dashboard chat is request/response over an SSE
          // stream that exists only for the turn in flight, and there is no bot
          // identity that can post into it between turns. `deliverToReplyChat`
          // answers false for a `dashboard:` id rather than pretending, and the
          // long note at the emission site in `src/lib/tools/mission-tools.ts`
          // records the fallback this surface has and the chat surfaces do not
          // (its Missions tab renders the owner's board live). Marked here as
          // well as there because a skipped feature is invisible at the call
          // site that skips it.
          userId: dashboardIdentity(c),
          // Per-seat spend attribution: the users-table id of the signed-in
          // principal (magic-link session). Token/break-glass principals have
          // none and attribute nothing.
          ...(getPrincipal(c)?.userId ? { dashboardUserId: getPrincipal(c)!.userId } : {}),
          ...(attachmentBlocks.length > 0 ? { attachments: attachmentBlocks } : {}),
          ...(peekNote ? { systemNote: peekNote } : {}),
          onChunk: (cumulative) => {
            // fire and forget; await would serialize the stream
            void stream.writeSSE({ event: 'chunk', data: cumulative });
          },
          // Live tool status, mirroring Telegram/Slack (CLAUDE.md "Chat surface
          // parity"). Tool dispatch emits no chunks, so without this the Chat
          // tab shows only the typing dots while the agent works tools.
          onToolEvent: ({ name, callIndex }) => {
            void stream.writeSSE({
              event: 'tool',
              data: JSON.stringify({ label: humanizeToolName(name), step: callIndex + 1 }),
            });
          },
        });
        await stream.writeSSE({
          event: 'final',
          data: JSON.stringify({
            text: result.text,
            modelId: result.modelId,
            latencyMs: result.latencyMs,
            costUsd: result.costUsd,
            toolCallCount: result.toolCallCount,
          }),
        });
        // Knowledge-base confirmations after the answer — the Chat tab renders
        // these as chips under the assistant message (parity with the
        // Telegram/Slack follow-up message).
        if (!result.blocked) {
          for (const k of [...kbConfirmations, ...acks]) {
            await stream.writeSSE({ event: 'kb', data: JSON.stringify({ text: k }) });
          }
          // Generated media: the browser renders the presigned URL directly
          // (parity with Telegram sendPhoto / Slack file upload). Documents go
          // out as a distinct `artifact` event so the Chat tab renders a
          // download card rather than a broken <img> — and, critically, so the
          // usable link never depends on the model reproducing it in its reply.
          for (const m of result.media ?? []) {
            if (!m.presignedUrl) continue;
            await stream.writeSSE({
              event: m.kind === 'artifact' ? 'artifact' : 'image',
              data: JSON.stringify({
                url: m.presignedUrl,
                caption: m.caption ?? '',
                ...(m.kind === 'artifact'
                  ? { name: m.caption ?? 'document', contentType: m.contentType }
                  : {}),
              }),
            });
          }
        }
        // Guardrail-blocked exchanges are not persisted; a kept block notice
        // used to poison the session and re-trip the guardrail on every
        // subsequent turn until /newchat.
        if (!result.blocked) {
          const now = Math.floor(Date.now() / 1000);
          await appendTurns(agentId, chatId, [
            { role: 'user', text: userText, ts: now },
            { role: 'assistant', text: result.text, ts: now },
          ], undefined, { surface: 'dashboard', userId: dashboardIdentity(c), ephemeral: !personOf(c) });
        }
        await stream.writeSSE({ event: 'done', data: 'ok' });
      } catch (err) {
        // Emit a clean code for an enforcement refusal rather than the raw
        // message (which for the indeterminate strict block would read
        // "$NaN >= $50.00"). The Chat SSE consumer renders this error text.
        const data =
          err instanceof CostCapExceededError
            ? Number.isNaN(err.spendUsd)
              ? 'cost_cap_unverifiable'
              : 'cost_cap_exceeded'
            : err instanceof KillSwitchActiveError
              ? `kill_switch_active: ${err.reason}`
              : err instanceof Error
                ? err.message
                : String(err);
        await stream.writeSSE({ event: 'error', data });
      }
    });
  });

  router.get('/sessions', async (c) => {
    if (!(await hasCapability(c, 'sessions:read'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'sessions:read' }, 403);
    }
    const projection =
      'PK, SK, updatedAt, modelOverride, messageCount, firstMessage, createdAt, surface, userId';
    const agentId = c.req.query('agentId')?.trim();

    // Per-agent (e.g. the Agent detail Sessions tab) is a Query of one
    // partition; cross-agent Scans the table. Both read to the END — every
    // message is a row since P1, so a read bounded by items would undercount
    // conversations silently (readConversationRows).
    const { rows: items, truncated } = await readConversationRows(projection, agentId || undefined);

    // Decision 1: conversations are author-private. A non-admin sees only their
    // own; an admin sees every one, and seeing someone else's is audited.
    const isAdmin = await hasCapability(c, 'security:write');
    const conversations = items.filter((i) => isAdmin || ownsConversation(c, i.userId));
    if (isAdmin && conversations.some((i) => !ownsConversation(c, i.userId))) {
      void writeAudit({
        action: 'session_read_override',
        ...(agentId ? { agentId } : {}),
        detail: { scope: 'list', requestedBy: dashboardIdentity(c) },
        result: 'ok',
      });
    }
    const rows = conversations.map((i) => ({
      agentId: String(i.PK ?? '').replace(/^AGENT#/, ''),
      chatId: String(i.SK ?? '').replace(/^CHAT#/, ''),
      updatedAt: i.updatedAt as number,
      modelOverride: (i.modelOverride as string | undefined) ?? null,
      messageCount: (i.messageCount as number | undefined) ?? null,
      firstMessage: (i.firstMessage as string | undefined) ?? null,
      createdAt: (i.createdAt as number | undefined) ?? null,
      surface: (i.surface as string | undefined) ?? null,
      userId: (i.userId as string | undefined) ?? null,
    }));
    rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    return c.json({ sessions: rows.slice(0, 50), truncated });
  });

  router.get('/usage', async (c) => {
    if (!(await hasCapability(c, 'usage:read'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'usage:read' }, 403);
    }
    const days = Math.max(1, Math.min(30, Number(c.req.query('days') ?? 7)));
    const agentId = c.req.query('agentId') ?? 'main';
    // For 'all', aggregate across every authoritative usage partition (every
    // stored agent plus the synthetic jarvis/playground PKs); a specific agentId
    // is a single partition. We SUM totals while paging each partition/day to
    // completion, so the figures are accurate rather than capped to a row window,
    // while keeping only the first 200 rows for display (bounded memory). A high
    // scan guard backstops a pathological volume and, if ever hit, flips
    // `truncated` so the totals are never silently presented as complete.
    const USAGE_TOTALS_SCAN_GUARD = 200_000;
    let partitions: string[];
    // For 'all', an INCOMPLETE partition discovery (listAgents failed, falling
    // back to the known-agent cache) means the totals may omit some agents'
    // spend, so flag the response `truncated` rather than presenting a partial
    // sum as complete. This is a display read; it does not block.
    let partitionsIncomplete = false;
    if (agentId === 'all') {
      const disc = await usageAgentPartitions();
      partitions = disc.partitions;
      partitionsIncomplete = !disc.complete;
    } else {
      partitions = [agentId];
    }
    const totals = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      costUsd: 0,
      calls: 0,
    };
    const displayRows: DDBRow[] = [];
    let scanned = 0;
    let truncated = partitionsIncomplete;
    const usageToday = new Date();
    outer: for (const aid of partitions) {
      for (let i = 0; i < days; i++) {
        const d = new Date(usageToday);
        d.setUTCDate(usageToday.getUTCDate() - i);
        const day = d.toISOString().slice(0, 10);
        let startKey: Record<string, unknown> | undefined;
        try {
          do {
            const resp = await ddb().send(
              new QueryCommand({
                TableName: TABLE_TOKEN_USAGE,
                KeyConditionExpression: 'PK = :pk',
                ExpressionAttributeValues: { ':pk': `AGENT#${aid}#DAY#${day}` },
                ScanIndexForward: false,
                ExclusiveStartKey: startKey,
              }),
            );
            for (const r of (resp.Items ?? []) as DDBRow[]) {
              totals.inputTokens += Number(r.inputTokens ?? 0);
              totals.outputTokens += Number(r.outputTokens ?? 0);
              totals.cacheReadInputTokens += Number(r.cacheReadInputTokens ?? 0);
              totals.cacheWriteInputTokens += Number(r.cacheWriteInputTokens ?? 0);
              totals.costUsd += Number(r.costUsd ?? 0);
              totals.calls += 1;
              if (displayRows.length < 200) displayRows.push(r);
              scanned += 1;
              if (scanned >= USAGE_TOTALS_SCAN_GUARD) {
                truncated = true;
                break outer;
              }
            }
            startKey = resp.LastEvaluatedKey;
          } while (startKey);
        } catch (err) {
          // Fail soft per partition/day so one bad read does not 500 the page.
          logger.warn(
            { agentId: aid, day, errMessage: err instanceof Error ? err.message : String(err) },
            'usage aggregation failed for a day — skipping it',
          );
        }
      }
    }
    return c.json({ days, agentId, totals, rows: displayRows, truncated });
  });

  router.get('/usage/daily', async (c) => {
    // Usage tab read (also rendered as a summary on Overview). Gated on the
    // owning tab's cap, usage:read; viewer holds it so Overview is unaffected.
    if (!(await hasCapability(c, 'usage:read'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'usage:read' }, 403);
    }
    const days = Math.max(1, Math.min(90, Number(c.req.query('days') ?? 7)));
    const agentId = c.req.query('agentId') ?? 'all';
    const result = await getUsageByDay(agentId, days);
    return c.json({ days: result });
  });

  router.get('/audit', async (c) => {
    if (!(await hasCapability(c, 'audit:read'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'audit:read' }, 403);
    }
    const days = Math.max(1, Math.min(7, Number(c.req.query('days') ?? 1)));
    const rows = await collectAcrossDays(TABLE_AUDIT_LOG, days, (day) => ({
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `DAY#${day}` },
    }));
    return c.json({ days, count: rows.length, rows: rows.slice(0, 200) });
  });

  router.get('/kill-switches', async (c) => {
    // Wave 5 (fix): reading the kill-switch list is VIEWER-tier (kill-switches:read)
    // because the Overview renders a kill-switch SUMMARY card from this list — a
    // viewer must be able to read it or the Overview 403s. This matches the legacy
    // GET ladder (any viewer could read it). The kill-switch TRIP mutation on POST
    // stays security:write (admin/owner); only this GET read is viewer-held.
    if (!(await hasCapability(c, 'kill-switches:read'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'kill-switches:read' }, 403);
    }
    const switches = await Promise.all(
      KILL_SWITCH_NAMES.map(async (name) => {
        const state = await isKillSwitchActive(name);
        const meta = KILL_SWITCH_META[name];
        return { name, ...state, description: meta?.description ?? '', category: meta?.category ?? 'System' };
      }),
    );
    return c.json({ switches });
  });

  // Server-side agent turn — no Telegram/Slack needed. Useful for
  // smoke tests, scripts, and the future dashboard chat panel. Same
  // memory + tool + audit + usage path as the surface adapters; just
  // with surface='dashboard'.
  router.post('/test-turn', async (c) => {
    // Wave 5 (fix): the test-turn console is the Chat tab's send action. The send
    // ITSELF still requires operator (the legacy requiredRole gate returns
    // 'operator' for this POST — unchanged, not widened). We ADD an explicit
    // chat:read gate so the API agrees with the SPA's /chat route guard
    // (web auth.ts gates /chat on chat:read). operator already holds chat:read
    // (viewer-tier), so this never narrows the existing operator send path; it
    // only makes a profile that lacks chat:read unable to reach the console via
    // the API too, mirroring the UI.
    if (!(await hasCapability(c, 'chat:read'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'chat:read' }, 403);
    }
    const body = await c.req
      .json<{
        agentId?: string;
        chatId?: string;
        text: string;
        modelOverride?: string;
        persistTurns?: boolean;
      }>()
      .catch(() => null);
    if (!body || !body.text) {
      return c.json({ error: 'missing_text' }, 400);
    }
    // Chat-surface parity note: attachments are deliberately NOT supported
    // here — the Chat tab always sends via /test-turn/stream, which carries
    // the full media pipeline. This endpoint stays text-only for API smoke
    // tests and legacy callers.
    const agentId = body.agentId ?? 'main';
    const chatId = safeDashboardChatId(body.chatId);
    const persist = body.persistTurns ?? true;

    // WI-1.1: the same owner check as the streamed route, before the command
    // path. persistTurns:false still replays the stored history to the model.
    const session = await getSession(agentId, chatId);
    if (session && !ownsConversation(c, session.userId)) {
      return c.json({ error: 'not_found' }, 404);
    }

    // Slash command path — handled inline.
    const cmd = await runCommand(agentId, chatId, body.text);
    if (cmd?.reply) {
      return c.json({ kind: 'command', agentId, chatId, reply: cmd.reply });
    }

    const history = session?.turns ?? [];
    const modelOverride = body.modelOverride ?? session?.modelOverride;

    try {
      const result = await runAgentTurn({
        agentId,
        chatId,
        userText: body.text,
        history,
        modelOverride,
        surface: 'dashboard',
        // A person typed this in a chat window. `origin` is the ONLY thing that
        // lets the emergency kill phrase halt the fleet, it defaults to 'machine',
        // and this is one of the five chat-surface call sites allowed to say so.
        origin: 'human_chat',
        // PARITY GAP, DELIBERATE (see CLAUDE.md, "chat surface parity"): no
        // `replyChatId`, so the assignment push is skipped here too — same
        // missing primitive as the streamed route above, same note at the
        // emission site in `src/lib/tools/mission-tools.ts`.
        userId: dashboardIdentity(c),
        ...(getPrincipal(c)?.userId ? { dashboardUserId: getPrincipal(c)!.userId } : {}),
      });
      if (persist && !result.blocked) {
        const now = Math.floor(Date.now() / 1000);
        await appendTurns(agentId, chatId, [
          { role: 'user', text: body.text, ts: now },
          { role: 'assistant', text: result.text, ts: now },
        ], undefined, { surface: 'dashboard', userId: dashboardIdentity(c), ephemeral: !personOf(c) });
      }
      logger.info(
        {
          agentId,
          chatId,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          costUsd: result.costUsd,
          toolCallCount: result.toolCallCount,
          text: truncateForLog(result.text, 100),
        },
        'test-turn complete',
      );
      return c.json({ kind: 'agent_turn', agentId, chatId, ...result });
    } catch (err) {
      if (err instanceof KillSwitchActiveError) {
        return c.json({ error: 'kill_switch_active', reason: err.reason }, 503);
      }
      if (err instanceof CostCapExceededError) {
        // An intended enforcement refusal, NOT an internal failure, so it must
        // not surface as a 500 (which would invite clients to retry). Mapping
        // lives in the pure costCapResponse() helper (unit-tested).
        const mapped = costCapResponse(err);
        return c.json(mapped.body, mapped.status);
      }
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(
        { agentId, chatId, errMessage: msg },
        'test-turn failed',
      );
      return c.json({ error: 'turn_failed', detail: msg }, 500);
    }
  });

  router.get('/memories', async (c) => {
    if (!(await hasCapability(c, 'memories:read'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'memories:read' }, 403);
    }
    const agentId = c.req.query('agentId') ?? 'main';
    const chatId = c.req.query('chatId');
    // With a chatId we return that conversation's memories (existing behavior).
    // Without one we return the agent's memories across all chats, which the
    // per-agent Memories tab needs (it has no single chat to scope to).
    if (chatId) {
      const rows = await listMemoriesForChat(agentId, chatId, 50);
      return c.json({ agentId, chatId, memories: rows });
    }
    const rows = await listMemoriesForAgent(agentId, 50);
    return c.json({ agentId, chatId: null, memories: rows });
  });

  router.get('/tier', async (c) => {
    // Daily cost cap is the effective value: a runtime-config override wins
    // over the env default. getEffectiveCostCap fails open to the env default.
    const dailyCostCapUsd = await getEffectiveCostCap();
    return c.json({
      tier: Number(process.env.CCE_TIER ?? '1'),
      label: process.env.CCE_TIER_LABEL ?? 'Standard',
      xrayEnabled: process.env.CCE_XRAY_ENABLED === '1',
      dailyCostCapUsd,
    });
  });

  // Runtime config (claudeclaw-runtime-config). Reads are operator-visible
  // (default GET role), writes are admin-gated in requiredRole above. Values
  // are plain tunables (cost cap, idle timeout) so they are safe to echo back.
  router.get('/config', async (c) => {
    const category = c.req.query('category');
    if (category) {
      const values = await getConfigCategory(category);
      return c.json({ category, values });
    }
    // No category filter: aggregate the known runtime-config categories. New
    // categories get added here as later increments home more keys in the table.
    const categories = ['cost', 'sessions', 'rate_limits'];
    const result: Record<string, Record<string, string>> = {};
    await Promise.all(
      categories.map(async (cat) => {
        result[cat] = await getConfigCategory(cat);
      }),
    );
    return c.json({ categories: result });
  });

  router.get('/config/:category', async (c) => {
    const category = c.req.param('category');
    const values = await getConfigCategory(category);
    return c.json({ category, values });
  });

  // Single-key read. Reads stay viewer/operator (default GET role); the
  // matching POST below is admin-gated in requiredRole.
  router.get('/config/:category/:key', async (c) => {
    const category = c.req.param('category');
    const key = c.req.param('key');
    const value = await getConfig(category, key);
    return c.json({ category, key, value });
  });

  router.post('/config/:category/:key', async (c) => {
    const category = c.req.param('category');
    const key = c.req.param('key');
    // The COST category has ONE operator-writable key via this generic endpoint:
    // the cost-watch toggle (watch_enabled), gated on config:write. Everything
    // else under cost is locked down here so this endpoint cannot be used to
    // bypass the dedicated, validated paths:
    //   - daily_cap_usd MUST go through POST /cost-cap (numeric validation + AWS
    //     Budget sync + cost_cap_updated audit), so it is rejected here.
    //   - cost-watch bookkeeping keys (watch_last_run, watch_last_risk_total, …)
    //     are written by the cost-watch worker, never the dashboard.
    // (requiredRole already forces admin for any cost key other than
    // watch_enabled; this is the in-route allowlist that makes the intent
    // explicit and rejects even an admin from cap/bookkeeping writes here.)
    if (category === 'cost') {
      // Two cost keys are writable via this generic endpoint:
      //   - watch_enabled        the cost-watch toggle (config:write / operator)
      //   - report_async_enabled the async cost-report toggle (admin, already
      //                          enforced by requiredRole for non-watch keys)
      // Everything else is locked down so this endpoint can't bypass the
      // dedicated validated paths (daily_cap_usd → POST /cost-cap) or write the
      // worker's bookkeeping keys.
      const COST_WRITABLE_KEYS = new Set(['watch_enabled', 'report_async_enabled']);
      if (!COST_WRITABLE_KEYS.has(key)) {
        return c.json(
          {
            error: 'forbidden_key',
            detail:
              key === 'daily_cap_usd'
                ? 'Use POST /cost-cap to change the daily cost cap.'
                : 'This cost key is managed by the system and is not writable here.',
          },
          403,
        );
      }
      if (key === 'watch_enabled' && !(await hasCapability(c, 'config:write'))) {
        return c.json({ error: 'forbidden', requiredCapability: 'config:write' }, 403);
      }
    }
    const body = await c.req
      .json<{ value?: string; reason?: string }>()
      .catch(() => null);
    if (!body || typeof body.value !== 'string') {
      return c.json({ error: 'missing_value' }, 400);
    }
    const principal = getPrincipal(c);
    const updatedBy = principal?.label ?? 'dashboard';
    const before = await getConfig(category, key);
    await setConfig(category, key, body.value, { updatedBy });
    logger.warn(
      { category, key, value: body.value, reason: body.reason, updatedBy },
      'runtime config set',
    );
    // Durable audit: which key changed, by whom, old -> new value.
    void writeAudit({
      action: 'config_updated',
      surface: 'dashboard',
      result: 'ok',
      userId: principal?.hashPrefix16 ?? 'dashboard',
      operatorLabel: updatedBy,
      detail: {
        category,
        key,
        oldValue: before ?? null,
        newValue: body.value,
        ...(body.reason ? { reason: body.reason } : {}),
      },
    });
    return c.json({ ok: true, category, key, value: body.value });
  });

  router.get('/addons', async (c) => {
    const rows = await Promise.all(
      listAddons().map(async (a) => {
        const configured = addonConfigured(a.id);
        const ksState = a.killSwitch
          ? await isKillSwitchActive(a.killSwitch as KillSwitchName)
          : { active: false };
        return {
          id: a.id,
          title: a.title,
          category: a.category,
          description: a.description,
          required: a.required,
          killSwitch: a.killSwitch ?? null,
          killSwitchActive: ksState.active,
          configured,
          active: configured && !ksState.active,
        };
      }),
    );
    return c.json({ count: rows.length, addons: rows });
  });

  router.get('/cost-today', async (c) => {
    // Overview tab summary card — gated on overview:read (the Overview tab's own
    // cap). viewer holds it, so the Overview cost summary is unchanged.
    if (!(await hasCapability(c, 'overview:read'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'overview:read' }, 403);
    }
    const usd = await getDailyCostUsd();
    return c.json({
      day: new Date().toISOString().slice(0, 10),
      costUsd: usd,
    });
  });

  router.get('/vectors', async (c) => {
    if (!(await hasCapability(c, 'vectors:read'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'vectors:read' }, 403);
    }
    const scope = c.req.query('scope') ?? 'default';
    const docs = await listDocuments(scope);
    return c.json({ scope, count: docs.length, docs });
  });

  router.post('/ingest', async (c) => {
    // Ingest mutates the knowledge base — gated on agents:write per the
    // documented capability model (vectors:read is list-only).
    if (!(await hasCapability(c, 'agents:write'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'agents:write' }, 403);
    }
    const body = await c.req
      .json<{
        content?: string;
        contentBase64?: string;
        docId?: string;
        docTitle?: string;
        source?: string;
        scope?: string;
        format?: IngestFormat;
        tags?: string[];
      }>()
      .catch(() => null);
    if (!body || (!body.content && !body.contentBase64)) {
      return c.json({ error: 'missing_content_or_contentBase64' }, 400);
    }
    try {
      const result = await ingestDocument({
        ...(body.content ? { content: body.content } : {}),
        ...(body.contentBase64 ? { contentBase64: body.contentBase64 } : {}),
        ...(body.docId ? { docId: body.docId } : {}),
        ...(body.docTitle ? { docTitle: body.docTitle } : {}),
        ...(body.source ? { source: body.source } : {}),
        ...(body.scope ? { scope: body.scope } : {}),
        ...(body.format ? { format: body.format } : {}),
        ...(body.tags ? { tags: body.tags } : {}),
      });
      void writeAudit({
        action: 'knowledge_ingest',
        surface: 'dashboard',
        userId: dashboardIdentity(c),
        detail: {
          docId: result.docId,
          scope: result.scope,
          chunks: result.chunks,
          failed: result.failed,
          ...(body.docTitle ? { docTitle: body.docTitle } : {}),
          ...(body.source ? { source: body.source } : {}),
          ...(body.format ? { format: body.format } : {}),
        },
        result: 'ok',
      });
      return c.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ errMessage: msg }, 'ingest failed');
      return c.json({ error: 'ingest_failed', detail: msg }, 400);
    }
  });

  // Presigned upload URL: the dashboard PUTs a file straight to S3 with this,
  // bypassing the CloudFront WAF's 8KB request-body cap (which blocks PDFs sent
  // as base64 JSON). It then calls /ingest/stream with the returned key.
  router.post('/vectors/upload-url', async (c) => {
    if (!(await hasCapability(c, 'vectors:read'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'vectors:read' }, 403);
    }
    const body = await c.req.json<{ filename?: string }>().catch(() => null);
    const key = uploadKeyFor(body?.filename ?? 'upload', randomUUID());
    try {
      const url = await presignUploadUrl(key);
      return c.json({ url, key });
    } catch (err) {
      // Log it: this used to fail silently (no log line), so an operator hitting
      // "presign_failed" in the UI had nothing to debug against.
      const detail = err instanceof Error ? err.message : String(err);
      logger.warn({ errMessage: detail, filename: body?.filename ?? null }, 'presign upload url failed');
      return c.json({ error: 'presign_failed', detail }, 400);
    }
  });

  // Streaming ingest: emits the pipeline stages over SSE (extract ->
  // chunk -> embed{done,total} -> index -> done) so the UI can show processing
  // transparently. Accepts inline content/contentBase64 (small files) OR an
  // s3Key from a presigned upload (large files / PDFs). Mirrors the war-room SSE.
  router.post('/ingest/stream', async (c) => {
    // Ingest mutates the knowledge base — gated on agents:write per the
    // documented capability model (vectors:read is list-only).
    if (!(await hasCapability(c, 'agents:write'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'agents:write' }, 403);
    }
    const body = await c.req
      .json<{
        content?: string;
        contentBase64?: string;
        s3Key?: string;
        docId?: string;
        docTitle?: string;
        source?: string;
        scope?: string;
        format?: IngestFormat;
        tags?: string[];
      }>()
      .catch(() => null);
    if (!body || (!body.content && !body.contentBase64 && !body.s3Key)) {
      return c.json({ error: 'missing_content_contentBase64_or_s3Key' }, 400);
    }
    // Size ceilings for staged uploads. Binary docs are loaded fully into the
    // task's memory and base64'd (~1.33x), so we cap them well under the
    // Fargate task memory. Audio is streamed to Transcribe, not held in
    // memory, so it gets a higher ceiling — but note the transcriber's own
    // ~60s wait window bounds how long an audio file can practically be.
    const MAX_DOC_BYTES = 50 * 1024 * 1024;
    // Map a filename to an audio MIME the transcriber understands.
    const audioMimeFor = (name: string): string | undefined => {
      const l = name.toLowerCase();
      if (l.endsWith('.mp3')) return 'audio/mp3';
      if (l.endsWith('.m4a') || l.endsWith('.mp4')) return 'audio/mp4';
      if (l.endsWith('.wav')) return 'audio/wav';
      if (l.endsWith('.ogg') || l.endsWith('.oga')) return 'audio/ogg';
      if (l.endsWith('.flac')) return 'audio/flac';
      if (l.endsWith('.webm')) return 'audio/webm';
      return undefined;
    };
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj: unknown) => {
          try { controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`)); } catch { /* closed */ }
        };
        try {
          let content = body.content;
          let contentBase64 = body.contentBase64;
          const fmt: IngestFormat = body.format ?? detectFormat(body.docTitle ?? body.source);
          // Pull the bytes from the staging upload when an s3Key is given.
          if (body.s3Key) {
            if (!isUploadKey(body.s3Key)) {
              send({ stage: 'error', detail: 'invalid upload key' });
              return;
            }
            if (fmt === 'audio') {
              // Audio never enters the task's memory — Transcribe reads it
              // straight from S3. Emit a 'transcribe' stage so the UI shows
              // what's happening (it can take a while), then ingest the text.
              send({ stage: 'transcribe' });
              const mimeType = audioMimeFor(body.docTitle ?? body.s3Key);
              const { transcript } = await transcribeAudio({
                s3Uri: objectS3Uri(body.s3Key),
                mimeType,
                jobNameSuffix: 'kb-ingest',
              });
              if (!transcript.trim()) {
                send({ stage: 'error', detail: 'transcription produced no text (silent or unintelligible audio?)' });
                return;
              }
              content = transcript;
            } else {
              const buf = await getObjectBuffer(body.s3Key);
              const limit = MAX_DOC_BYTES;
              if (buf.length > limit) {
                send({
                  stage: 'error',
                  detail: `file is ${(buf.length / 1024 / 1024).toFixed(1)}MB, over the ${(limit / 1024 / 1024).toFixed(0)}MB limit for ${fmt} ingest`,
                });
                return;
              }
              if (fmt === 'pdf' || fmt === 'docx' || fmt === 'pptx') contentBase64 = buf.toString('base64');
              else content = buf.toString('utf8');
            }
          }
          const result = await ingestDocument(
            {
              ...(content ? { content } : {}),
              ...(contentBase64 ? { contentBase64 } : {}),
              ...(body.docId ? { docId: body.docId } : {}),
              ...(body.docTitle ? { docTitle: body.docTitle } : {}),
              ...(body.source ? { source: body.source } : {}),
              ...(body.scope ? { scope: body.scope } : {}),
              ...(body.format ? { format: body.format } : {}),
              ...(body.tags ? { tags: body.tags } : {}),
            },
            (ev) => send(ev),
          );
          send({ stage: 'done', docId: result.docId, chunks: result.chunks, failed: result.failed });
          void writeAudit({
            action: 'knowledge_ingest',
            surface: 'dashboard',
            userId: dashboardIdentity(c),
            detail: {
              docId: result.docId,
              scope: result.scope,
              chunks: result.chunks,
              failed: result.failed,
              ...(body.docTitle ? { docTitle: body.docTitle } : {}),
              ...(body.source ? { source: body.source } : {}),
              format: fmt,
            },
            // The doc was stored, so the audit result is 'ok'; the `failed`
            // count in detail above records when an ingest was only partial
            // (some chunks dropped on embed failure).
            result: 'ok',
          });
          // Clean up the staging object once it's safely indexed.
          if (body.s3Key) void deleteObject(body.s3Key);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ errMessage: msg }, 'ingest stream failed');
          send({ stage: 'error', detail: msg });
        } finally {
          try { controller.close(); } catch { /* already closed */ }
        }
      },
    });
    return new Response(stream, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
    });
  });

  // Retrieval test: embed the query and run the same cosine search the agents
  // use, so an operator can confirm an uploaded doc is actually findable.
  router.post('/vectors/search', async (c) => {
    if (!(await hasCapability(c, 'vectors:read'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'vectors:read' }, 403);
    }
    const body = await c.req.json<{ query?: string; scope?: string; topK?: number }>().catch(() => null);
    const query = body?.query?.trim();
    if (!query) return c.json({ error: 'missing_query' }, 400);
    const scope = body?.scope ?? 'default';
    try {
      const queryEmbedding = await embedOne(query);
      const hits = await vectorSearch({ scope, queryEmbedding, topK: Math.min(body?.topK ?? 5, 20) });
      return c.json({
        scope,
        query,
        hits: hits.map((h) => ({
          score: h.score,
          text: h.row.text,
          docId: h.row.metadata.docId,
          docTitle: h.row.metadata.docTitle ?? null,
          source: h.row.metadata.source ?? null,
          chunkIndex: h.row.metadata.chunkIndex,
          page: h.row.metadata.page ?? null,
        })),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ errMessage: msg }, 'vector search failed');
      return c.json({ error: 'search_failed', detail: msg }, 400);
    }
  });

  // Grounded model test: retrieve from a scope, then have a chosen model answer
  // USING those passages — so you can compare how different models respond with
  // the knowledge base (the Knowledge tab's "test with a model"). One model per
  // call; the SPA fans out for side-by-side compare and reuses it per turn for
  // the grounded chat (history[]). Mirrors how the agent's s3_vectors_search
  // tool formats passages so the test reflects real grounded behavior.
  router.post('/vectors/answer', async (c) => {
    if (!(await hasCapability(c, 'vectors:read'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'vectors:read' }, 403);
    }
    const body = await c.req
      .json<{
        query?: string;
        scope?: string;
        modelId?: string;
        topK?: number;
        history?: Array<{ role: 'user' | 'assistant'; text: string }>;
      }>()
      .catch(() => null);
    const query = body?.query?.trim();
    const modelId = body?.modelId ?? '';
    if (!query) return c.json({ error: 'missing_query' }, 400);
    const model = listPlaygroundModels(process.env).find((m) => m.id === modelId);
    if (!model) return c.json({ error: 'unknown_model' }, 400);
    const scope = body?.scope ?? 'default';
    const topK = Math.min(body?.topK ?? 5, 20);

    // Same safety gates as the Playground — this spends Bedrock money.
    const killed = await isKillSwitchActive('bedrock_global');
    if (killed.active) {
      return c.json({ error: 'kill_switch_active', reason: killed.reason ?? null }, 503);
    }
    // Always enforce the cap before paid work (mirrors /playground/run), NOT
    // only while the cost_cap_per_day kill switch is on, so this paid route can
    // never run past the cap unobserved. (The bedrock_global kill switch is
    // still honored above.)
    const capUsd = await getEffectiveCostCap();
    if (Number.isFinite(capUsd)) {
      // Strict read: an indeterminate spend total fails CLOSED (503) instead of
      // admitting a paid call on an understated partial.
      let spendUsd: number;
      try {
        spendUsd = await getDailyCostUsd({ strict: true });
      } catch (err) {
        if (err instanceof SpendIndeterminateError) {
          return c.json({ error: 'cost_cap_unverifiable' }, 503);
        }
        throw err;
      }
      if (spendUsd >= capUsd) {
        return c.json({ error: 'cost_cap_exceeded', spendUsd, capUsd }, 503);
      }
    }

    // Retrieve. A retrieval failure is its own (non-model) error.
    let hits;
    try {
      const queryEmbedding = await embedOne(query);
      hits = await vectorSearch({ scope, queryEmbedding, topK });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ ok: false, modelId, error: 'retrieval_failed', detail: msg });
    }

    // Format passages the same way the agent tool does, so the model sees the
    // knowledge in the same shape it would during a real run.
    const passages = hits.map((h, i) => {
      const m = h.row.metadata;
      const cite = m.docTitle ?? m.source ?? m.docId;
      return `[${i + 1}] (${h.score.toFixed(3)}) ${cite} #${m.chunkIndex}\n${h.row.text.trim()}`;
    });
    const context = passages.length
      ? passages.join('\n\n')
      : '(no relevant passages found in this scope)';
    const systemPrompt =
      'You answer questions strictly from the provided knowledge base passages. ' +
      'Use ONLY the information in the passages and cite the ones you use like [1], [2]. ' +
      'If the answer is not in the passages, say you do not have that information in the knowledge base.';
    const userText = `Knowledge base passages (scope: ${scope}):\n\n${context}\n\nQuestion: ${query}`;
    const history = (body?.history ?? [])
      .slice(-10)
      .map((t) => ({ role: t.role, content: [{ text: t.text }] }));

    try {
      const out = await converseTurn({
        modelId,
        systemPrompt,
        userText,
        history,
        disableCache: true,
        omitTemperature: true,
        maxTokens: 1024,
      });
      // costUsd is the HONEST price for the UI (null when the model has no
      // verified price). meteredCost feeds the cost cap: it falls back to a
      // conservative estimate for unpriced models so this paid call is never
      // recorded as zero. This route runs a paid converseTurn, so it MUST meter
      // its spend under the synthetic 'knowledge' partition (folded into
      // getDailyCostUsd via usageAgentPartitions); otherwise its Bedrock cost is
      // invisible to the cost cap even though the precheck above reads that cap.
      const costUsd = playgroundCost(model, out.inputTokens, out.outputTokens);
      const meteredCost = playgroundMeteredCost(model, out.inputTokens, out.outputTokens);
      const metered = await recordUsage({
        agentId: KNOWLEDGE_USAGE_AGENT,
        chatId: `dashboard:knowledge:${dashboardIdentity(c)}`,
        surface: 'dashboard',
        modelId,
        inputTokens: out.inputTokens,
        outputTokens: out.outputTokens,
        costUsd: meteredCost,
        latencyMs: out.latencyMs,
        userId: dashboardIdentity(c),
      });
      if (!metered) {
        logger.error(
          { modelId, scope },
          'knowledge answer: usage write returned false; this spend is NOT reflected in the daily cost cap',
        );
        void writeAudit({
          action: 'knowledge_meter_failed' as AuditEvent['action'],
          surface: 'dashboard',
          userId: dashboardIdentity(c),
          detail: { modelId, scope },
          result: 'error',
        });
      }
      void writeAudit({
        action: 'knowledge_answer',
        surface: 'dashboard',
        userId: dashboardIdentity(c),
        detail: { modelId, provider: model.provider, scope, hits: hits.length },
        result: 'ok',
      });
      return c.json({
        ok: true,
        modelId,
        provider: model.provider,
        name: model.name,
        answer: out.text,
        hits: hits.map((h) => ({
          score: h.score,
          text: h.row.text,
          docTitle: h.row.metadata.docTitle ?? null,
          source: h.row.metadata.source ?? null,
          chunkIndex: h.row.metadata.chunkIndex,
          page: h.row.metadata.page ?? null,
        })),
        inputTokens: out.inputTokens,
        outputTokens: out.outputTokens,
        costUsd,
        latencyMs: out.latencyMs,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const errName = (err as { name?: string }).name ?? 'Error';
      logger.warn({ modelId, scope, errName }, 'grounded answer failed');
      return c.json({ ok: false, modelId, provider: model.provider, name: model.name, error: errName, detail: msg });
    }
  });

  router.delete('/vectors/:scope/:docId', async (c) => {
    // Deleting a knowledge doc is a mutation — gated on agents:write per the
    // documented model. This route previously had NO capability check.
    if (!(await hasCapability(c, 'agents:write'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'agents:write' }, 403);
    }
    const scope = c.req.param('scope');
    const docId = c.req.param('docId');
    await removeDocument(scope, docId);
    void writeAudit({
      action: 'knowledge_delete',
      surface: 'dashboard',
      userId: dashboardIdentity(c),
      detail: { scope, docId },
      result: 'ok',
    });
    return c.json({ ok: true, scope, docId });
  });

  router.get('/scheduled', async (c) => {
    if (!(await hasCapability(c, 'scheduled:read'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'scheduled:read' }, 403);
    }
    const agentId = c.req.query('agentId') ?? 'main';
    const tasks = await listScheduledTasksForAgent(agentId, 200);
    return c.json({ agentId, count: tasks.length, tasks });
  });

  // Create a scheduled task from the dashboard ("morning brief to your
  // pocket"). Source is a free-text prompt OR a Jarvis routine (its prompt is
  // SNAPSHOTTED — later routine edits don't rewrite scheduled history).
  // Cadence is either an absolute startAtIso or a wall-clock atLocalTime +
  // IANA timezone (the backend does the conversion; clients and models get
  // UTC math wrong). Same operator-wide authority as the DELETE below.
  router.post('/scheduled', async (c) => {
    if (!(await hasCapability(c, 'agents:write'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'agents:write' }, 403);
    }
    const body = await c.req
      .json<{
        agentId?: string;
        promptText?: string;
        routineId?: string;
        startAtIso?: string;
        atLocalTime?: string;
        timezone?: string;
        intervalSec?: number;
        endAt?: string;
        description?: string;
        deliveryTarget?: { surface?: string; chatId?: string };
      }>()
      .catch(() => null);
    if (!body) return c.json({ error: 'invalid_json' }, 400);
    const agentId = (body.agentId ?? '').trim();
    if (!agentId || !listKnownAgents().includes(agentId)) {
      return c.json({ error: 'unknown_agent', agentId }, 400);
    }
    // Exactly one prompt source.
    let promptText = (body.promptText ?? '').trim();
    let sourceRoutineId: string | undefined;
    if (body.routineId) {
      if (promptText) return c.json({ error: 'prompt_or_routine_not_both' }, 400);
      const routine = (await listRoutines()).find((r) => r.id === body.routineId);
      if (!routine) return c.json({ error: 'unknown_routine', routineId: body.routineId }, 404);
      promptText = routine.prompt;
      sourceRoutineId = routine.id;
    }
    if (!promptText) return c.json({ error: 'missing_prompt' }, 400);
    if (promptText.length > 4000) return c.json({ error: 'prompt_too_long', max: 4000 }, 400);
    // First fire time.
    let nextRunAt: number;
    if (body.atLocalTime) {
      const timezone = (body.timezone ?? '').trim();
      if (!timezone) return c.json({ error: 'timezone_required_with_atLocalTime' }, 400);
      try {
        nextRunAt = nextOccurrenceUtc(body.atLocalTime, timezone);
      } catch (err) {
        return c.json({ error: 'invalid_local_time', detail: err instanceof Error ? err.message : String(err) }, 400);
      }
    } else if (body.startAtIso) {
      const t = Date.parse(body.startAtIso);
      if (!Number.isFinite(t)) return c.json({ error: 'invalid_startAtIso' }, 400);
      nextRunAt = Math.floor(t / 1000);
      if (nextRunAt < Math.floor(Date.now() / 1000) - 60) {
        return c.json({ error: 'startAt_in_the_past' }, 400);
      }
    } else {
      return c.json({ error: 'missing_start_time' }, 400);
    }
    // Delivery target (optional in the API; the dashboard form always sends
    // one because a system: chatId has nowhere to deliver without it).
    let deliveryTarget: { surface: 'telegram' | 'slack'; chatId: string } | undefined;
    if (body.deliveryTarget) {
      const surface = body.deliveryTarget.surface;
      const target = (body.deliveryTarget.chatId ?? '').trim();
      if (
        (surface !== 'telegram' && surface !== 'slack') ||
        !target ||
        !/^[A-Za-z0-9:._-]{1,100}$/.test(target)
      ) {
        return c.json({ error: 'invalid_delivery_target' }, 400);
      }
      deliveryTarget = { surface, chatId: target };
    }
    try {
      const task = await createScheduledTask({
        agentId,
        // Dashboard-created tasks run under a system chatId so they never
        // pollute a user session; delivery is via the explicit target.
        chatId: `system:dashboard-${randomUUID().slice(0, 8)}`,
        promptText,
        nextRunAt,
        ...(body.intervalSec !== undefined ? { intervalSec: Number(body.intervalSec) } : {}),
        ...(body.endAt ? { endAt: body.endAt } : {}),
        createdBy: 'user',
        ...(body.description ? { description: body.description.slice(0, 200) } : {}),
        ...(deliveryTarget ? { deliveryTarget } : {}),
        ...(body.timezone ? { timezone: body.timezone } : {}),
        ...(sourceRoutineId ? { sourceRoutineId } : {}),
        createdByIdentity: dashboardIdentity(c),
      });
      await upsertSchedule({ taskId: task.id, agentId, nextRunAtUnixSec: task.nextRunAt });
      void writeAudit({
        action: 'scheduled_task_created',
        agentId,
        chatId: task.chatId,
        surface: 'dashboard',
        userId: dashboardIdentity(c),
        detail: {
          taskId: task.id,
          nextRunAt: task.nextRunAt,
          intervalSec: task.intervalSec ?? null,
          deliveryTarget: deliveryTarget ?? null,
          sourceRoutineId: sourceRoutineId ?? null,
        },
        result: 'ok',
      });
      return c.json({ ok: true, task }, 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // The repo enforces the cadence floor; surface it as a 400.
      if (msg.includes('intervalSec')) return c.json({ error: 'interval_too_short', detail: msg }, 400);
      throw err;
    }
  });

  // Edit an ACTIVE scheduled task. Conditional update; done/cancelled tasks
  // are immutable (404 mirrors the DELETE semantics).
  router.put('/scheduled/:agentId/:taskId', async (c) => {
    if (!(await hasCapability(c, 'agents:write'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'agents:write' }, 403);
    }
    const agentId = c.req.param('agentId');
    const taskId = c.req.param('taskId');
    const body = await c.req
      .json<{
        promptText?: string;
        startAtIso?: string;
        atLocalTime?: string;
        timezone?: string;
        intervalSec?: number | null;
        endAt?: string | null;
        description?: string;
        deliveryTarget?: { surface?: string; chatId?: string } | null;
      }>()
      .catch(() => null);
    if (!body) return c.json({ error: 'invalid_json' }, 400);
    if (body.promptText !== undefined && (!body.promptText.trim() || body.promptText.length > 4000)) {
      return c.json({ error: 'invalid_prompt' }, 400);
    }
    let nextRunAt: number | undefined;
    if (body.atLocalTime) {
      const timezone = (body.timezone ?? '').trim();
      if (!timezone) return c.json({ error: 'timezone_required_with_atLocalTime' }, 400);
      try {
        nextRunAt = nextOccurrenceUtc(body.atLocalTime, timezone);
      } catch (err) {
        return c.json({ error: 'invalid_local_time', detail: err instanceof Error ? err.message : String(err) }, 400);
      }
    } else if (body.startAtIso) {
      const t = Date.parse(body.startAtIso);
      if (!Number.isFinite(t)) return c.json({ error: 'invalid_startAtIso' }, 400);
      nextRunAt = Math.floor(t / 1000);
    }
    let deliveryTarget: { surface: 'telegram' | 'slack'; chatId: string } | null | undefined;
    if (body.deliveryTarget === null) deliveryTarget = null;
    else if (body.deliveryTarget) {
      const surface = body.deliveryTarget.surface;
      const target = (body.deliveryTarget.chatId ?? '').trim();
      if ((surface !== 'telegram' && surface !== 'slack') || !/^[A-Za-z0-9:._-]{1,100}$/.test(target)) {
        return c.json({ error: 'invalid_delivery_target' }, 400);
      }
      deliveryTarget = { surface, chatId: target };
    }
    try {
      const updated = await updateScheduledTask(agentId, taskId, {
        ...(body.promptText !== undefined ? { promptText: body.promptText.trim() } : {}),
        ...(nextRunAt !== undefined ? { nextRunAt } : {}),
        ...(body.intervalSec !== undefined ? { intervalSec: body.intervalSec } : {}),
        ...(body.endAt !== undefined ? { endAt: body.endAt } : {}),
        ...(body.description !== undefined ? { description: body.description.slice(0, 200) } : {}),
        ...(deliveryTarget !== undefined ? { deliveryTarget } : {}),
        ...(body.timezone !== undefined ? { timezone: body.timezone } : {}),
      });
      if (!updated) return c.json({ error: 'not_found_or_not_active', agentId, taskId }, 404);
      // EB Scheduler must learn the new fire time or it fires on the stale one.
      if (nextRunAt !== undefined) {
        await upsertSchedule({ taskId: updated.id, agentId, nextRunAtUnixSec: updated.nextRunAt });
      }
      void writeAudit({
        action: 'scheduled_task_updated',
        agentId,
        chatId: updated.chatId,
        surface: 'dashboard',
        userId: dashboardIdentity(c),
        detail: { taskId: updated.id, nextRunAt: updated.nextRunAt, intervalSec: updated.intervalSec ?? null },
        result: 'ok',
      });
      return c.json({ ok: true, task: updated });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('intervalSec')) return c.json({ error: 'interval_too_short', detail: msg }, 400);
      throw err;
    }
  });

  router.delete('/scheduled/:agentId/:taskId', async (c) => {
    // Cancelling a scheduled task is a routine agent mutation — gated on
    // agents:write (operator-tier). Previously this relied ONLY on the legacy
    // operator ROLE_RANK gate in the router-wide middleware; the explicit
    // capability check makes the documented operator authority the enforced one
    // (a custom operator-rank profile with agents:write stripped is now denied).
    //
    // BY DESIGN: this single-control-plane deployment has no per-user agent
    // ownership, so operator+ (agents:write) may cancel ANY agent's scheduled
    // tasks. That is documented operator-wide authority, not an authorization
    // gap — there is intentionally no per-task / per-owner scoping to enforce.
    if (!(await hasCapability(c, 'agents:write'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'agents:write' }, 403);
    }
    const agentId = c.req.param('agentId');
    const taskId = c.req.param('taskId');
    // Resolve the target first so a no-op cancel reports an honest status
    // instead of 200 {ok:false}. Missing task -> 404; an already-cancelled
    // task -> 409; only a real active->cancelled transition is 200 {ok:true}.
    const tasks = await listScheduledTasksForAgent(agentId, 200);
    const target = tasks.find((t) => t.id === taskId || t.id.startsWith(taskId));
    if (!target) {
      return c.json({ error: 'not_found', agentId, taskId }, 404);
    }
    if (target.status === 'cancelled') {
      return c.json({ error: 'already_cancelled', agentId, taskId }, 409);
    }
    const ok = await cancelScheduledTask(agentId, taskId);
    if (!ok) {
      // Lost a race with another cancel/fire between the lookup and write.
      return c.json({ error: 'not_found', agentId, taskId }, 404);
    }
    return c.json({ ok: true, agentId, taskId });
  });

  router.get('/inbox', async (c) => {
    const agentId = c.req.query('agentId') ?? 'main';
    const rows = await listInbox(agentId, 50, ['queued', 'delivered']);
    return c.json({ agentId, count: rows.length, inbox: rows });
  });

  // Session transcript for the Sessions tab row-expand. Returns the actual turn
  // array. The GDPR /export route below returns session.turns as a COUNT (it is
  // also an agent tool, so its shape is frozen), which is why the Sessions page
  // could never render a transcript from it. Gated on sessions:read like the
  // list route so the read boundary is consistent.
  router.get('/sessions/transcript', async (c) => {
    if (!(await hasCapability(c, 'sessions:read'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'sessions:read' }, 403);
    }
    const agentId = c.req.query('agentId') ?? 'main';
    const chatId = c.req.query('chatId');
    if (!chatId) return c.json({ error: 'chatId_required' }, 400);
    const session = await getSession(agentId, chatId);
    const none = { turns: [], truncated: false };
    // Decision 1: author-private. Someone else's conversation reads exactly like
    // one that does not exist; an admin may read it, and that read is audited.
    if (session && !ownsConversation(c, session.userId)) {
      if (!(await hasCapability(c, 'security:write'))) return c.json(none);
      void writeAudit({
        action: 'session_read_override',
        agentId,
        chatId,
        detail: { scope: 'transcript', requestedBy: dashboardIdentity(c) },
        result: 'ok',
      });
    }
    // WI-1.3: the whole conversation, not only the 20-turn replay window.
    return c.json(session ? await getFullHistory(agentId, chatId, session) : none);
  });

  // War Room transcript PDF. Deliberately NOT under /api/warroom/* (that's
  // buildWarroomRouter in warroom.ts) so this router's own middleware — bearer
  // auth, dashboard_read_disabled, requiredRole (GET -> viewer) — is the only
  // one that runs; it then mirrors warroom.ts's own read gate (warroom:read
  // capability + the warroom_disabled kill switch) by hand.
  router.get('/warroom-transcripts/:id', async (c) => {
    if (!(await hasCapability(c, 'warroom:read'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'warroom:read' }, 403);
    }
    const disabled = await isKillSwitchActive('warroom_disabled').catch(() => ({ active: false }));
    if (disabled.active) return c.json({ error: 'war room disabled' }, 503);

    const meetingId = c.req.param('id');
    const meeting = await getMeeting(meetingId);
    if (!meeting) return c.json({ error: 'not_found' }, 404);

    // Page through the FULL history — getHistory returns one DDB page (default
    // limit 100) — so a room with >100 turns isn't silently truncated.
    const turns: Awaited<ReturnType<typeof getHistory>> = [];
    let sinceSeq = 0;
    for (;;) {
      const page = await getHistory(meetingId, sinceSeq, 100);
      turns.push(...page);
      if (page.length < 100) break;
      sinceSeq = page[page.length - 1]!.seq;
    }

    // pdfkit's built-in Helvetica is WinAnsi, so `buildPdf` REFUSES anything
    // outside it rather than emit a garbled file. That refusal is right for a
    // document the caller authored and wrong here: nobody controls what an
    // agent puts in a reply, and a single emoji would otherwise fail the whole
    // export. Substitute instead, so the transcript always downloads.
    const title = toPdfSafeText(meeting.title || 'War Room');
    let buf: Buffer;
    try {
      buf = await buildPdf({
        title,
        sections: [
          {
            body: toPdfSafeText(
              `Participants: ${(meeting.participants ?? []).join(', ')} · Created ${meeting.createdAt ?? ''}`,
            ),
          },
          ...turns.map((t) => ({
            heading: toPdfSafeText(t.type === 'agent' ? t.agentId || t.speaker : t.speaker),
            body: toPdfSafeText(t.content),
          })),
        ],
      });
    } catch (err) {
      // Backstop for anything substitution missed. A 500 here reads as "the
      // server is broken"; this says what actually happened.
      logger.warn({ meetingId, err }, 'war room transcript PDF failed to render');
      return c.json(
        { error: 'pdf_render_failed', detail: err instanceof Error ? err.message : String(err) },
        422,
      );
    }
    const slug =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 60) || 'war-room';
    return c.body(new Uint8Array(buf), 200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="war-room-${slug}.pdf"`,
    });
  });

  // Delete ONE conversation. Narrower than DELETE /export below, which is the
  // admin-only GDPR purge (memories + scheduled tasks + inbox + session); this
  // removes the conversation the Chat sidebar lists. Since P1 every message is
  // also its own record beside the conversation row (WI-1.2), so deleteSession
  // CASCADES: it removes the conversation's records first and the row last, so
  // a delete that stops part-way leaves the row to retry, never stray messages.
  router.delete('/sessions', async (c) => {
    // Destructive mutation, so agents:write — the operator-tier capability this
    // repo already uses for every per-tab delete (scheduled-task delete, vector
    // delete; see permissions.ts). requiredRole() independently rates a non-GET
    // /sessions as 'operator', so the two gates agree and no new capability or
    // profile change is needed.
    if (!(await hasCapability(c, 'agents:write'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'agents:write' }, 403);
    }
    const agentId = c.req.query('agentId') ?? 'main';
    const chatId = c.req.query('chatId');
    if (!chatId) return c.json({ error: 'chatId_required' }, 400);

    // Ownership is resolved HERE, from the STORED row against the authenticated
    // principal. Nothing the client sends can assert who owns a chat: the
    // identity comes from the bearer token via dashboardIdentity(), and the
    // owner comes from the persisted `userId` that appendTurns stamped. A
    // hand-edited chatId therefore cannot reach another user's conversation.
    //
    // Not-yours and does-not-exist deliberately return the SAME 404, so the
    // route cannot be used to enumerate other users' chat ids (the same
    // reasoning validateMagicToken applies to magic-link lookups above).
    const session = await getSession(agentId, chatId);
    const me = dashboardIdentity(c);
    const owned = ownsConversation(c, session?.userId);
    // Admin/owner-tier principals may remove any conversation on the agent —
    // the same tier that already holds the GDPR purge. Rows written before the
    // dashboard stamped `userId` (or by Telegram/Slack) have no owner to match,
    // so they are reachable only through this override.
    const isAdmin = await hasCapability(c, 'security:write');
    if (!session || (!owned && !isAdmin)) {
      return c.json({ error: 'not_found' }, 404);
    }

    await deleteSession(agentId, chatId);
    // Fire-and-forget, matching purgeChatData: an audit outage must never fail a
    // delete the database has already committed.
    void writeAudit({
      action: 'data_purged',
      agentId,
      chatId,
      detail: { scope: 'session', requestedBy: me, viaAdminOverride: !owned },
      result: 'ok',
    });
    return c.json({ deleted: true, agentId, chatId });
  });

  router.get('/export', async (c) => {
    // Full chat-data export (session count + memories + tasks + inbox +
    // missions). Carries the same per-chat data the Sessions tab reads, so gate
    // it on sessions:read; previously this GET had only the legacy viewer role
    // gate, letting any authenticated principal pull a full per-chat dump.
    if (!(await hasCapability(c, 'sessions:read'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'sessions:read' }, 403);
    }
    const agentId = c.req.query('agentId') ?? 'main';
    const chatId = c.req.query('chatId');
    if (!chatId) return c.json({ error: 'chatId_required' }, 400);
    // Decision 1: one chat's full export is its author's, or an audited admin's.
    const session = await getSession(agentId, chatId);
    if (!ownsConversation(c, session?.userId)) {
      if (!(await hasCapability(c, 'security:write'))) return c.json({ error: 'not_found' }, 404);
      void writeAudit({
        action: 'session_read_override',
        agentId,
        chatId,
        detail: { scope: 'chat-export', requestedBy: dashboardIdentity(c) },
        result: 'ok',
      });
    }
    const payload = await exportChatData(agentId, chatId);
    return c.json(payload);
  });

  router.delete('/export', async (c) => {
    const agentId = c.req.query('agentId') ?? 'main';
    const chatId = c.req.query('chatId');
    if (!chatId) return c.json({ error: 'chatId_required' }, 400);
    // GDPR-flavored: log the requestor so we can prove who authorized
    // the purge. Required header for DELETE to reduce blast radius
    // when the bearer is shared across operators.
    const operator = operatorIdentity(c);
    if (operator === 'dashboard:anonymous') {
      return c.json(
        {
          error: 'operator_required',
          hint: 'Set X-Dashboard-User header on destructive ops.',
        },
        400,
      );
    }
    const report = await purgeChatData(agentId, chatId, operator);
    return c.json(report);
  });

  // ── /api/missions* — ONE ROUTER, TWO STACKS, ONE FLAG (C-8) ────────────
  //
  // The Paperclip ACL is registered IN FRONT of the legacy handlers, on THIS
  // router object, so both are behind the router-wide middleware above — which
  // is where `403 {error:'forbidden', requiredRole:'operator', yourRole:'viewer'}`
  // comes from and why `authz-matrix.test.ts` passes unchanged through either
  // stack. Registering a sub-router elsewhere, or relaxing `requiredRole()` for
  // `/missions`, would each change that body. Neither is done.
  //
  // Hono's first matching handler that returns a Response ends the chain, so
  // when the ACL is registered the legacy four are unreachable, and when it is
  // not they serve. That is the off-switch: `CCE_PAPERCLIP_ENABLED` unset means
  // the ACL was never mounted, not that a request fell back to legacy after
  // trying Paperclip. There is no mid-request fallback anywhere below.
  if (paperclipRoutingEnabled()) {
    registerMissionRoutes(router, { hasCapability, identity: dashboardIdentity });
  }
  router.get('/missions', legacyListMissions);
  router.post('/missions', legacyCreateMission);
  router.post('/missions/:owner/:id/status', legacyUpdateMissionStatus);
  router.post('/missions/:owner/:id/reassign', legacyReassignMission);

  router.get('/hive', async (c) => {
    if (!(await hasCapability(c, 'hive:read'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'hive:read' }, 403);
    }
    const limit = Math.max(1, Math.min(100, Number(c.req.query('limit') ?? 25)));
    const notes = await recentHive(limit);
    return c.json({ count: notes.length, notes });
  });

  router.get('/notifications', async (c) => {
    const notifications: { id: string; type: string; title: string; detail: string; ts: string }[] = [];
    const now = Date.now();

    const ks = await Promise.all(
      KILL_SWITCH_NAMES.map(async (name) => {
        const state = await isKillSwitchActive(name);
        return { name, ...state };
      }),
    );
    for (const s of ks) {
      if (s.active && s.setAt) {
        const setTime = new Date(s.setAt).getTime();
        if (now - setTime < 86400000) {
          notifications.push({
            id: `ks-${s.name}`,
            type: 'kill_switch',
            title: `Kill switch active: ${s.name.replace(/_/g, ' ')}`,
            detail: s.reason ?? 'No reason given',
            ts: s.setAt,
          });
        }
      }
    }

    const cap = Number(process.env.CCE_DAILY_COST_CAP_USD ?? '50');
    const spend = await getDailyCostUsd();
    if (spend / cap > 0.8) {
      notifications.push({
        id: `cost-${new Date().toISOString().slice(0, 10)}`,
        type: 'cost_warning',
        title: `Spend at ${Math.round((spend / cap) * 100)}% of daily cap`,
        detail: `$${spend.toFixed(2)} of $${cap.toFixed(2)} cap`,
        ts: new Date().toISOString(),
      });
    }

    // Reuse the status assembler (CloudWatch DescribeAlarms, prefix-scoped,
    // fail-soft) instead of issuing our own SDK call. Any alarm in ALARM
    // is a health_change. This is the same read /api/posture/observability
    // and the status page rely on, so no duplicate describe call shape.
    try {
      const status = await assembleStatusData();
      const firing = status.alarms.filter((a: AlarmRow) => a.state === 'ALARM');
      for (const a of firing) {
        notifications.push({
          id: `alarm-${a.name}`,
          type: 'health_change',
          title: `Alarm firing: ${a.name}`,
          detail: a.reason ?? 'CloudWatch alarm is in ALARM state',
          ts: a.updatedAt ?? new Date().toISOString(),
        });
      }

      // Best-effort auth-anomaly signal. We do not have a cheap dedicated
      // counter at request time, so we derive it from the dashboard auth
      // failure alarm when it is firing (the AuthFailedAlarm wired to the
      // ops topic). This keeps the read to the single alarm describe above.
      const authAlarm = firing.find((a: AlarmRow) => /auth/i.test(a.name));
      if (authAlarm) {
        notifications.push({
          id: 'auth-anomaly',
          type: 'auth_anomaly',
          title: 'Elevated dashboard auth failures',
          detail:
            authAlarm.reason ??
            'Dashboard authentication failures crossed the alert threshold',
          ts: authAlarm.updatedAt ?? new Date().toISOString(),
        });
      }
    } catch (err) {
      logger.warn(
        { errMessage: err instanceof Error ? err.message : String(err) },
        'notifications: alarm read failed',
      );
    }

    return c.json({ notifications });
  });

  router.get('/tokens', async (c) => {
    const tokens = await listTokens();
    return c.json({
      tokens: tokens.map((t) => ({
        hashPrefix: t.tokenHash.slice(0, 16),
        label: t.label,
        createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt,
        createdBy: t.createdBy,
        active: t.active,
        role: t.role,
        expiresAt: t.expiresAt ?? null,
      })),
    });
  });

  router.post('/tokens', async (c) => {
    const body = await c.req
      .json<{ label?: string; role?: TokenRole; expiresInDays?: number }>()
      .catch(() => null);
    if (!body?.label) return c.json({ error: 'label_required' }, 400);
    if (body.role !== undefined && !isTokenRole(body.role)) {
      return c.json({ error: 'invalid_role', valid: ['viewer', 'operator', 'admin'] }, 400);
    }
    const role: TokenRole = body.role ?? 'operator';
    const expiresInDays =
      typeof body.expiresInDays === 'number' && body.expiresInDays > 0
        ? Math.min(3650, Math.floor(body.expiresInDays))
        : undefined;
    const identity = dashboardIdentity(c);
    const { raw, record } = await createToken(body.label, identity, role, expiresInDays);
    // A4: audit token creation. Record the label/role/hashPrefix only —
    // never the raw token value.
    const principal = getPrincipal(c);
    // C5c: privilege mint — the audit write is awaited and non-suppressible;
    // an unauditable mint returns 500 (the token exists; the operator retries
    // or investigates, but the failure is never silent).
    try {
      await writeAuditOrThrow({
        action: 'token_created',
        surface: 'dashboard',
        result: 'ok',
        userId: principal?.hashPrefix16 ?? 'dashboard',
        operatorLabel: principal?.label ?? 'dashboard',
        detail: {
          label: record.label,
          role: record.role,
          hashPrefix: record.tokenHash.slice(0, 16),
          ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
        },
      });
    } catch {
      return c.json({ error: 'token created but the audit write failed; investigate before reusing' }, 500);
    }
    return c.json({
      token: raw,
      hashPrefix: record.tokenHash.slice(0, 16),
      label: record.label,
      role: record.role,
      expiresAt: record.expiresAt ?? null,
    }, 201);
  });

  // Owner decision 1: link a token that has no person of its own — the env root
  // token, a legacy per-operator token — to exactly ONE user, once. Until it is
  // linked its conversations are not durable (see personOf); once linked, the
  // user owns them. Addressed by the hashPrefix GET /tokens hands out, like
  // DELETE /tokens/:hashPrefix, but it must name exactly one token: a link is
  // never moved, so an ambiguous prefix must not pick one.
  router.post('/tokens/:hashPrefix/link', async (c) => {
    if (!(await hasCapability(c, 'tokens:write'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'tokens:write' }, 403);
    }
    const prefix = c.req.param('hashPrefix');
    const body = await c.req.json<{ userId?: unknown }>().catch(() => null);
    const userId = typeof body?.userId === 'string' ? body.userId.trim() : '';
    if (!/^[0-9a-f]{16,64}$/.test(prefix)) return c.json({ error: 'invalid_hash_prefix' }, 400);
    if (!userId) return c.json({ error: 'userId_required' }, 400);
    const user = await getUser(userId);
    if (!user || user.status === 'disabled') return c.json({ error: 'unknown_user' }, 400);
    const matches = (await listTokens()).filter((t) => t.tokenHash.startsWith(prefix));
    if (matches.length !== 1) return c.json({ error: 'token_not_found' }, 404);
    const tokenHash = matches[0]!.tokenHash;
    const requestedBy = dashboardIdentity(c);
    const outcome = await linkTokenToUser(tokenHash, userId, requestedBy);
    if (outcome === 'not_found') return c.json({ error: 'token_not_found' }, 404);
    if (outcome === 'session_token') return c.json({ error: 'token_has_its_own_user' }, 409);
    if (outcome === 'already_linked') return c.json({ error: 'already_linked' }, 409);
    // C5c, as for a token mint: awaited and non-suppressible. An unauditable
    // link returns 500 — the link exists, and nobody should rely on it unseen.
    const principal = getPrincipal(c);
    try {
      await writeAuditOrThrow({
        action: 'token_linked',
        surface: 'dashboard',
        result: 'ok',
        userId: principal?.hashPrefix16 ?? 'dashboard',
        operatorLabel: principal?.label ?? 'dashboard',
        detail: { hashPrefix: tokenHash.slice(0, 16), userId, requestedBy },
      });
    } catch {
      return c.json({ error: 'token linked but the audit write failed; investigate before relying on it' }, 500);
    }
    return c.json({ linked: true, hashPrefix: tokenHash.slice(0, 16), userId });
  });

  router.delete('/tokens/:hashPrefix', async (c) => {
    const prefix = c.req.param('hashPrefix');
    const tokens = await listTokens();
    const match = tokens.find((t) => t.tokenHash.startsWith(prefix));
    if (!match) return c.json({ error: 'token_not_found' }, 404);
    const ok = await revokeToken(match.tokenHash);
    // A4: audit token revocation. Label/role/hashPrefix only, no token value.
    const principal = getPrincipal(c);
    // C5c: revocation still succeeded (protective direction) even if the
    // audit write fails, but the failure surfaces as 500 instead of silence.
    try {
      await writeAuditOrThrow({
        action: 'token_revoked',
        surface: 'dashboard',
        result: ok ? 'ok' : 'error',
        userId: principal?.hashPrefix16 ?? 'dashboard',
        operatorLabel: principal?.label ?? 'dashboard',
        detail: {
          label: match.label,
          role: match.role,
          hashPrefix: match.tokenHash.slice(0, 16),
        },
      });
    } catch {
      return c.json({ error: 'token revoked but the audit write failed', ok, hashPrefix: prefix }, 500);
    }
    return c.json({ ok, hashPrefix: prefix });
  });

  router.get('/audit/export', async (c) => {
    // Audit tab CSV export — same read surface as GET /audit, gated on audit:read.
    if (!(await hasCapability(c, 'audit:read'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'audit:read' }, 403);
    }
    const days = Math.max(1, Math.min(30, Number(c.req.query('days') ?? 7)));
    const rows = await collectAllPages(TABLE_AUDIT_LOG, days, (day) => ({
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `DAY#${day}` },
    }), 10_000);
    const today = new Date().toISOString().slice(0, 10);
    const truncated = rows.length >= 10_000;
    const headers = ['timestamp', 'action', 'agentId', 'chatId', 'userId', 'operatorLabel', 'surface', 'modelId', 'costUsd', 'latencyMs', 'result', 'detail'];
    const csvRows = rows.map((r) => [
      String(r.ts ?? ''), String(r.action ?? ''), String(r.agentId ?? ''),
      String(r.chatId ?? ''), String(r.userId ?? ''), String(r.operatorLabel ?? ''),
      String(r.surface ?? ''), String(r.modelId ?? ''),
      String(r.costUsd ?? ''), String(r.latencyMs ?? ''),
      String(r.result ?? ''), r.detail ? JSON.stringify(r.detail) : '',
    ]);
    const csv = buildCsv(headers, csvRows);
    c.header('Content-Type', 'text/csv; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="audit-log-${today}.csv"`);
    c.header('X-Export-Row-Count', String(csvRows.length));
    c.header('X-Export-Truncated', String(truncated));
    if (truncated) c.header('X-Export-Cap', '10000');
    return c.body(csv);
  });

  router.get('/usage/export', async (c) => {
    // Usage tab CSV export — same read surface as GET /usage, gated on usage:read.
    if (!(await hasCapability(c, 'usage:read'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'usage:read' }, 403);
    }
    const days = Math.max(1, Math.min(30, Number(c.req.query('days') ?? 7)));
    const agentId = c.req.query('agentId') ?? 'main';
    // 'all' exports across every authoritative usage partition (registered
    // agents plus the synthetic jarvis/playground PKs), the same set GET /usage
    // aggregates over, instead of falling back to a single agent and emitting a
    // partial file. A specific agentId keeps the single-partition export.
    const rows: DDBRow[] = [];
    // An incomplete partition discovery for 'all' (listAgents failed) means the
    // export may omit some agents' rows, so flag the file truncated. Display
    // read; does not block.
    let partitionsIncomplete = false;
    if (agentId === 'all') {
      const disc = await usageAgentPartitions();
      partitionsIncomplete = !disc.complete;
      for (const aid of disc.partitions) {
        if (rows.length >= 10_000) break;
        const part = await collectAllPages(TABLE_TOKEN_USAGE, days, (day) => ({
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: { ':pk': `AGENT#${aid}#DAY#${day}` },
        }), 10_000 - rows.length);
        for (const r of part) rows.push(r);
      }
    } else {
      const part = await collectAllPages(TABLE_TOKEN_USAGE, days, (day) => ({
        KeyConditionExpression: 'PK = :pk',
        ExpressionAttributeValues: { ':pk': `AGENT#${agentId}#DAY#${day}` },
      }), 10_000);
      for (const r of part) rows.push(r);
    }
    const today = new Date().toISOString().slice(0, 10);
    const truncated = rows.length >= 10_000 || partitionsIncomplete;
    const headers = ['timestamp', 'agentId', 'chatId', 'surface', 'modelId', 'inputTokens', 'outputTokens', 'costUsd', 'latencyMs', 'userId'];
    const csvRows = rows.map((r) => [
      String(r.ts ?? ''), String(r.agentId ?? ''), String(r.chatId ?? ''),
      String(r.surface ?? ''), String(r.modelId ?? ''),
      String(r.inputTokens ?? ''), String(r.outputTokens ?? ''),
      String(r.costUsd ?? ''), String(r.latencyMs ?? ''), String(r.userId ?? ''),
    ]);
    const csv = buildCsv(headers, csvRows);
    c.header('Content-Type', 'text/csv; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="usage-${agentId}-${today}.csv"`);
    c.header('X-Export-Row-Count', String(csvRows.length));
    c.header('X-Export-Truncated', String(truncated));
    if (truncated) c.header('X-Export-Cap', '10000');
    return c.body(csv);
  });

  router.get('/sessions/export', async (c) => {
    // Sessions tab CSV export — same read surface as GET /sessions, gated on
    // sessions:read.
    if (!(await hasCapability(c, 'sessions:read'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'sessions:read' }, 403);
    }
    // Read to the end and cap the FILE at 10,000 conversations — the cap used to
    // count items, and since P1 message rows are items too (readConversationRows).
    const EXPORT_CAP = 10_000;
    const { rows: allItems, truncated: readTruncated } = await readConversationRows(
      'PK, SK, updatedAt, modelOverride, messageCount, firstMessage, createdAt, surface, userId',
    );
    const today = new Date().toISOString().slice(0, 10);
    const headers = ['agentId', 'chatId', 'updatedAt', 'createdAt', 'surface', 'userId', 'messageCount', 'firstMessage', 'modelOverride'];
    // Decision 1, the same rule as GET /sessions: your own rows, or every row
    // for an admin with the override audited.
    const isAdmin = await hasCapability(c, 'security:write');
    const conversations = allItems.filter((i) => isAdmin || ownsConversation(c, i.userId));
    const truncated = readTruncated || conversations.length > EXPORT_CAP;
    if (isAdmin && conversations.some((i) => !ownsConversation(c, i.userId))) {
      void writeAudit({
        action: 'session_read_override',
        detail: { scope: 'export', requestedBy: dashboardIdentity(c) },
        result: 'ok',
      });
    }
    const csvRows = conversations.slice(0, EXPORT_CAP).map((i) => [
      String(i.PK ?? '').replace(/^AGENT#/, ''),
      String(i.SK ?? '').replace(/^CHAT#/, ''),
      String(i.updatedAt ?? ''), String(i.createdAt ?? ''),
      String(i.surface ?? ''), String(i.userId ?? ''),
      String(i.messageCount ?? ''), String(i.firstMessage ?? ''),
      String(i.modelOverride ?? ''),
    ]);
    const csv = buildCsv(headers, csvRows);
    c.header('Content-Type', 'text/csv; charset=utf-8');
    c.header('Content-Disposition', `attachment; filename="sessions-${today}.csv"`);
    c.header('X-Export-Row-Count', String(csvRows.length));
    c.header('X-Export-Truncated', String(truncated));
    if (truncated) c.header('X-Export-Cap', String(EXPORT_CAP));
    return c.body(csv);
  });

  router.post('/kill-switches', async (c) => {
    // Tripping a kill switch is a security-critical control: enforce the
    // documented security:write capability (admin/owner-only) explicitly here so
    // a custom admin-rank profile with security:write STRIPPED cannot trip
    // switches. The router-wide requiredRole gate still returns 'admin' for this
    // path (defense in depth); this capability check is the precise gate.
    if (!(await hasCapability(c, 'security:write'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'security:write' }, 403);
    }
    const body = await c.req.json<{
      name: KillSwitchName;
      active: boolean;
      reason?: string;
    }>();
    if (!KILL_SWITCH_NAMES.includes(body.name)) {
      return c.json(
        { error: 'unknown_switch', valid: [...KILL_SWITCH_NAMES] },
        400,
      );
    }
    // C1: attribution comes from the authenticated principal, never the
    // client. Capture the prior value so the audit records old -> new.
    const principal = getPrincipal(c);
    const operatorLabel = principal?.label ?? 'dashboard';
    const newValue = Boolean(body.active);
    const before = await isKillSwitchActive(body.name);
    await setKillSwitch(
      body.name,
      newValue,
      body.reason ?? 'set via dashboard API',
      operatorLabel,
    );
    logger.warn(
      { switch: body.name, active: newValue, reason: body.reason, operatorLabel },
      'kill switch set',
    );
    // C2: durable audit of which switch flipped, by whom, old -> new.
    void writeAudit({
      action: 'kill_switch_set',
      surface: 'dashboard',
      result: 'ok',
      userId: principal?.hashPrefix16 ?? 'dashboard',
      operatorLabel,
      detail: {
        switch: body.name,
        oldValue: before.active,
        newValue,
        ...(body.reason ? { reason: body.reason } : {}),
      },
    });
    return c.json({ ok: true, name: body.name, active: newValue });
  });

  // ── Member management (Wave 4a) ───────────────────────────────────────────
  // All routes are gated by the members:write capability via hasCapability (the
  // ONE enforcement mechanism), enforce NO self-escalation, and bound any
  // granted capability set to a SUBSET of the actor's own. The dashboard-wide
  // middleware above also applies, but member authorization is the capability
  // gate here, not the legacy requiredRole+ROLE_RANK rank. requiredRole returns
  // the GET/operator default for these paths; the real check is below.

  /** Resolve the actor's own caps + the userId behind their session token. */
  async function actorContext(
    c: DashboardCtx,
  ): Promise<{ caps: Set<Capability>; selfUserId: string | null }> {
    const p = getPrincipal(c);
    if (!p) return { caps: new Set(), selfUserId: null };
    const { caps } = await capabilitiesForPrincipal(p);
    // The session token row carries userId; resolve it so we can forbid self
    // role-change / self-disable. The env root token has no user row.
    let selfUserId: string | null = null;
    try {
      const tokensTable =
        process.env.TABLE_DASHBOARD_TOKENS ?? 'claudeclaw-dashboard-tokens';
      const out = await ddb().send(
        new GetCommand({
          TableName: tokensTable,
          Key: { PK: `TOKEN#${p.tokenHash}`, SK: 'META' },
        }),
      );
      const uid = out.Item?.userId;
      if (typeof uid === 'string' && uid) selfUserId = uid;
    } catch {
      // best-effort; root token / table-absent leaves selfUserId null
    }
    return { caps, selfUserId };
  }

  // GET /members — list members. Requires members:read (members:write implies
  // read via the templates, but gate on the read cap explicitly).
  router.get('/members', async (c) => {
    if (!(await hasCapability(c, 'members:read')) && !(await hasCapability(c, 'members:write'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'members:read' }, 403);
    }
    const users = await listUsers();
    return c.json({
      count: users.length,
      members: users.map((u) => ({
        userId: u.userId,
        email: u.email,
        profileId: u.profileId,
        status: u.status,
        invitedBy: u.invitedBy ?? null,
        invitedAt: u.invitedAt ?? null,
        activatedAt: u.activatedAt ?? null,
        lastLoginAt: u.lastLoginAt ?? null,
        disabledAt: u.disabledAt ?? null,
      })),
    });
  });

  // POST /members/invite { email, profileId } — admin capability. Creates a
  // USER (status=invited) + an invite magic token (72h) and emails the accept
  // link. Bounds the granted profile's caps to a subset of the actor's caps.
  router.post('/members/invite', async (c) => {
    const { caps: actorCaps } = await actorContext(c);
    if (!actorCaps.has(MEMBERS_ADMIN_CAP)) {
      return c.json({ error: 'forbidden', requiredCapability: MEMBERS_ADMIN_CAP }, 403);
    }
    const body = await c.req.json<{ email?: string; profileId?: string }>().catch(() => null);
    const email = normalizeEmail(body?.email);
    const profileId = (body?.profileId ?? '').trim();
    if (!email) return c.json({ error: 'invalid_email' }, 400);
    if (!profileId) return c.json({ error: 'missing_profileId' }, 400);

    // Resolve the granted profile's caps and require them to be a subset of the
    // actor's own (no privilege escalation). Unknown profile => 400.
    const grantCaps = await capabilitiesForProfileId(profileId);
    if (!grantCaps) return c.json({ error: 'unknown_profile', profileId }, 400);
    // owner is reserved for the env break-glass token; never grant it.
    if (profileId === 'owner') {
      return c.json({ error: 'cannot_grant_owner' }, 403);
    }
    for (const cap of grantCaps) {
      if (!actorCaps.has(cap)) {
        return c.json(
          { error: 'grant_exceeds_actor', capability: cap },
          403,
        );
      }
    }

    const existing = await getUserByEmail(email);
    if (existing && existing.status !== 'disabled') {
      return c.json({ error: 'already_exists', status: existing.status }, 409);
    }

    const principal = getPrincipal(c);
    const invitedBy = principal?.label ?? 'dashboard';
    let userId: string;
    let raw: string;
    if (existing) {
      // Re-invite of a previously disabled member: reuse the userId, flip the
      // profile + status back to invited via the reviewed users-repo ops, and
      // mint a fresh invite token. (createUserInvite refuses any existing email,
      // so the disabled-reuse path uses the granular updaters instead.)
      userId = existing.userId;
      await setUserProfileId(userId, profileId);
      await reinviteDisabledUser(userId, invitedBy);
      raw = await createMagicToken(userId, 'invite', INVITE_TTL_MS);
    } else {
      // New member: createUserInvite writes the profile row (with the gsi1-email
      // keys) + the invite magic token atomically, conditioned on the email
      // being free.
      const created = await createUserInvite({
        userId: randomUUID(),
        email,
        profileId,
        invitedBy,
        ttlMs: INVITE_TTL_MS,
      });
      userId = created.user.userId;
      raw = created.rawToken;
    }
    const send = await sendInviteEmail(email, raw, invitedBy);
    void writeAudit({
      action: 'user_invited',
      surface: 'dashboard',
      result: 'ok',
      userId,
      operatorLabel: invitedBy,
      detail: {
        emailLower: email,
        profileId,
        emailSent: send.sent,
        ...(send.skippedReason ? { emailSkipped: send.skippedReason } : {}),
      },
    });
    return c.json(
      {
        ok: true,
        userId,
        email,
        profileId,
        status: 'invited',
        emailSent: send.sent,
        ...(send.skippedReason ? { emailSkipped: send.skippedReason } : {}),
      },
      201,
    );
  });

  // PATCH /members/:id { profileId } — change a member's role/profile. Admin
  // capability, forbid self-change, bound the new profile's caps to a subset of
  // the actor's caps. On a downgrade, revoke the member's live session tokens.
  router.patch('/members/:id', async (c) => {
    const { caps: actorCaps, selfUserId } = await actorContext(c);
    if (!actorCaps.has(MEMBERS_ADMIN_CAP)) {
      return c.json({ error: 'forbidden', requiredCapability: MEMBERS_ADMIN_CAP }, 403);
    }
    const targetId = c.req.param('id');
    if (selfUserId && selfUserId === targetId) {
      return c.json({ error: 'cannot_change_self' }, 403);
    }
    const body = await c.req.json<{ profileId?: string }>().catch(() => null);
    const profileId = (body?.profileId ?? '').trim();
    if (!profileId) return c.json({ error: 'missing_profileId' }, 400);
    if (profileId === 'owner') return c.json({ error: 'cannot_grant_owner' }, 403);

    const grantCaps = await capabilitiesForProfileId(profileId);
    if (!grantCaps) return c.json({ error: 'unknown_profile', profileId }, 400);
    for (const cap of grantCaps) {
      if (!actorCaps.has(cap)) {
        return c.json({ error: 'grant_exceeds_actor', capability: cap }, 403);
      }
    }

    const target = await getUser(targetId);
    if (!target) return c.json({ error: 'not_found' }, 404);
    const prevProfile = target.profileId;
    await setUserProfileId(targetId, profileId);

    // Downgrade detection: if the new caps are not a superset of the old caps,
    // revoke live sessions so the member can't keep elevated access until token
    // expiry.
    const prevCaps = (await capabilitiesForProfileId(prevProfile)) ?? new Set<Capability>();
    let downgraded = false;
    for (const cap of prevCaps) {
      if (!grantCaps.has(cap)) {
        downgraded = true;
        break;
      }
    }
    let revoked = 0;
    if (downgraded) revoked = await revokeTokensForUser(targetId);

    void writeAudit({
      action: 'user_role_changed',
      surface: 'dashboard',
      result: 'ok',
      userId: targetId,
      operatorLabel: getPrincipal(c)?.label ?? 'dashboard',
      detail: {
        emailLower: target.emailLower,
        oldProfileId: prevProfile,
        newProfileId: profileId,
        downgraded,
        sessionsRevoked: revoked,
      },
    });
    return c.json({ ok: true, userId: targetId, profileId, downgraded, sessionsRevoked: revoked });
  });

  // POST /members/:id/disable — set status=disabled and revoke the member's
  // session tokens. Admin capability, forbid self-disable.
  router.post('/members/:id/disable', async (c) => {
    const { caps: actorCaps, selfUserId } = await actorContext(c);
    if (!actorCaps.has(MEMBERS_ADMIN_CAP)) {
      return c.json({ error: 'forbidden', requiredCapability: MEMBERS_ADMIN_CAP }, 403);
    }
    const targetId = c.req.param('id');
    if (selfUserId && selfUserId === targetId) {
      return c.json({ error: 'cannot_disable_self' }, 403);
    }
    const target = await getUser(targetId);
    if (!target) return c.json({ error: 'not_found' }, 404);
    await disableUser(targetId);
    const revoked = await revokeTokensForUser(targetId);
    void writeAudit({
      action: 'user_disabled',
      surface: 'dashboard',
      result: 'ok',
      userId: targetId,
      operatorLabel: getPrincipal(c)?.label ?? 'dashboard',
      detail: { emailLower: target.emailLower, sessionsRevoked: revoked },
    });
    return c.json({ ok: true, userId: targetId, status: 'disabled', sessionsRevoked: revoked });
  });

  // ── Custom profile CRUD (Wave 4a) ─────────────────────────────────────────
  // Stored in claudeclaw-users as PROFILE_DEF#<id> / DEF. Admin capability;
  // granted capability set must be a subset of the actor's own.

  router.get('/profiles', async (c) => {
    if (!(await hasCapability(c, 'members:read')) && !(await hasCapability(c, 'members:write'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'members:read' }, 403);
    }
    const templates = Object.entries(TEMPLATED_PROFILES).map(([id, caps]) => ({
      id,
      kind: 'template' as const,
      capabilities: [...caps],
    }));
    let custom: { id: string; kind: 'custom'; capabilities: string[] }[] = [];
    try {
      const out = await ddb().send(
        new ScanCommand({
          TableName: TABLE_USERS,
          FilterExpression: 'SK = :sk',
          ExpressionAttributeValues: { ':sk': 'DEF' },
          Limit: 200,
        }),
      );
      custom = (out.Items ?? []).map((i) => ({
        id: String(i.PK ?? '').replace(/^PROFILE_DEF#/, ''),
        kind: 'custom' as const,
        capabilities: Array.isArray(i.capabilities) ? (i.capabilities as string[]) : [],
      }));
    } catch (err) {
      logger.warn(
        { errMessage: err instanceof Error ? err.message : String(err) },
        'custom profile list failed',
      );
    }
    return c.json({ profiles: [...templates, ...custom], capabilities: [...CAPABILITIES] });
  });

  router.post('/profiles', async (c) => {
    const { caps: actorCaps } = await actorContext(c);
    if (!actorCaps.has(MEMBERS_ADMIN_CAP)) {
      return c.json({ error: 'forbidden', requiredCapability: MEMBERS_ADMIN_CAP }, 403);
    }
    const body = await c.req
      .json<{ id?: string; capabilities?: string[] }>()
      .catch(() => null);
    const id = (body?.id ?? '').trim().replace(/[^A-Za-z0-9_-]/g, '');
    if (!id) return c.json({ error: 'invalid_id' }, 400);
    if (isTemplatedProfileId(id) || id === 'owner') {
      return c.json({ error: 'reserved_profile_id', id }, 409);
    }
    const requested = Array.isArray(body?.capabilities) ? body!.capabilities : [];
    const caps: Capability[] = [];
    for (const cap of requested) {
      if (!isCapability(cap)) return c.json({ error: 'unknown_capability', capability: cap }, 400);
      if (!actorCaps.has(cap)) {
        return c.json({ error: 'grant_exceeds_actor', capability: cap }, 403);
      }
      caps.push(cap);
    }
    // Capture the prior caps BEFORE the overwrite so we can detect a shrink.
    const prevDef = await readCustomProfile(id);
    const prevCaps = new Set<Capability>(prevDef?.capabilities ?? []);
    await ddb().send(
      new PutCommand({
        TableName: TABLE_USERS,
        Item: {
          PK: `PROFILE_DEF#${id}`,
          SK: 'DEF',
          profileId: id,
          capabilities: caps,
          updatedBy: getPrincipal(c)?.label ?? 'dashboard',
          updatedAt: new Date().toISOString(),
        },
      }),
    );
    // If editing this profile REMOVED any capability, every user bound to it
    // still carries the old grant (and legacy rank) on their live token until it
    // expires. Revoke those sessions so the shrink takes effect immediately,
    // mirroring the per-member role-change downgrade path. (No-op on create or a
    // pure widen.)
    const newCaps = new Set<Capability>(caps);
    const shrunk = [...prevCaps].some((cap) => !newCaps.has(cap));
    let revoked = 0;
    if (shrunk) {
      try {
        const bound = (await listUsers()).filter((u) => u.profileId === id);
        for (const u of bound) revoked += await revokeTokensForUser(u.userId);
      } catch (err) {
        logger.warn(
          { errMessage: err instanceof Error ? err.message : String(err), profileId: id },
          'profile shrink session revoke failed',
        );
      }
    }
    void writeAudit({
      action: 'user_role_changed',
      surface: 'dashboard',
      result: 'ok',
      operatorLabel: getPrincipal(c)?.label ?? 'dashboard',
      detail: { kind: 'custom_profile_upsert', profileId: id, capabilities: caps, shrunk, sessionsRevoked: revoked },
    });
    return c.json({ ok: true, id, capabilities: caps, sessionsRevoked: revoked }, 201);
  });

  return router;
}

/**
 * Upsert the `knowledgeScope:` line in an agent's agent.yaml in S3. The
 * vector-search tool resolves an agent's scope by reading this file (via
 * agent-loader's fetchKnowledgeScope), so persisting only to the DDB row would
 * leave vector search unchanged. Reads the current yaml (flat `key: value`
 * lines), replaces the knowledgeScope line if present or appends it, and writes
 * it back. No-op when CONFIG_BUCKET is unset (local/dev).
 */
async function persistKnowledgeScopeToS3(
  agentId: string,
  scope: string,
): Promise<void> {
  const configBucket = process.env.CONFIG_BUCKET;
  if (!configBucket) return;
  const { S3Client, GetObjectCommand, PutObjectCommand, NoSuchKey } = await import(
    '@aws-sdk/client-s3'
  );
  const s3 = new S3Client({ region: process.env.AWS_REGION ?? 'us-east-1' });
  const key = `agents/${agentId}/agent.yaml`;

  let existing = '';
  try {
    const obj = await s3.send(
      new GetObjectCommand({ Bucket: configBucket, Key: key }),
    );
    existing = (await obj.Body?.transformToString()) ?? '';
  } catch (err) {
    const name = (err as { name?: string }).name ?? '';
    if (!(err instanceof NoSuchKey) && name !== 'NoSuchKey' && name !== 'NotFound') {
      throw err;
    }
    // Missing yaml is expected for CLAUDE.md-only agents; start from blank.
  }

  const line = `knowledgeScope: ${scope}`;
  const lines = existing ? existing.split('\n') : [];
  let replaced = false;
  const next = lines.map((l) => {
    const sep = l.indexOf(':');
    if (sep > 0 && l.slice(0, sep).trim() === 'knowledgeScope') {
      replaced = true;
      return line;
    }
    return l;
  });
  if (!replaced) {
    // Drop a trailing blank line if present, then append.
    while (next.length > 0 && next[next.length - 1].trim() === '') next.pop();
    next.push(line);
  }

  await s3.send(
    new PutObjectCommand({
      Bucket: configBucket,
      Key: key,
      Body: next.join('\n') + '\n',
      ContentType: 'text/yaml; charset=utf-8',
    }),
  );
}

export interface DDBRow {
  [k: string]: unknown;
}

async function collectAllPages(
  table: string,
  days: number,
  buildExpr: (day: string) => {
    KeyConditionExpression: string;
    ExpressionAttributeValues: Record<string, unknown>;
  },
  cap: number,
): Promise<DDBRow[]> {
  const today = new Date();
  const out: DDBRow[] = [];
  for (let i = 0; i < days; i++) {
    if (out.length >= cap) break;
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    const day = d.toISOString().slice(0, 10);
    const expr = buildExpr(day);
    try {
      let exclusiveStartKey: Record<string, unknown> | undefined;
      do {
        const resp = await ddb().send(
          new QueryCommand({
            TableName: table,
            KeyConditionExpression: expr.KeyConditionExpression,
            ExpressionAttributeValues: expr.ExpressionAttributeValues,
            ScanIndexForward: false,
            ExclusiveStartKey: exclusiveStartKey,
          }),
        );
        for (const r of resp.Items ?? []) {
          out.push(r);
          if (out.length >= cap) break;
        }
        exclusiveStartKey = resp.LastEvaluatedKey;
      } while (exclusiveStartKey && out.length < cap);
    } catch (err) {
      logger.warn(
        { table, day, errMessage: err instanceof Error ? err.message : String(err) },
        'export query failed for day',
      );
    }
  }
  return out;
}

export interface AgentHealth {
  lastMessageAt: string | null;
  messagesLast24h: number;
  errorsLast24h: number;
  avgLatencyMs: number;
  errorRate: number;
  status: 'healthy' | 'idle' | 'degraded' | 'error';
}

/**
 * Per-agent last-activity / error signal over the rolling 24h window.
 * Reads token-usage (volume + latency) and the audit-log GSI (errors).
 * Both reads fail soft so one bad partition does not break the rollup.
 */
export async function computeAgentHealth(agentId: string): Promise<AgentHealth> {
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(now - 86400000).toISOString().slice(0, 10);

  let messagesLast24h = 0;
  let totalLatency = 0;
  let lastMessageAt: string | null = null;

  for (const day of [today, yesterday]) {
    let startKey: Record<string, unknown> | undefined;
    try {
      do {
        const out = await ddb().send(
          new QueryCommand({
            TableName: TABLE_TOKEN_USAGE,
            KeyConditionExpression: 'PK = :pk',
            ExpressionAttributeValues: { ':pk': `AGENT#${agentId}#DAY#${day}` },
            ProjectionExpression: 'ts, latencyMs',
            ExclusiveStartKey: startKey,
          }),
        );
        for (const item of out.Items ?? []) {
          const ts = String(item.ts ?? '');
          const rowTime = new Date(ts).getTime();
          if (now - rowTime > 86400000) continue;
          messagesLast24h += 1;
          totalLatency += Number(item.latencyMs ?? 0);
          if (!lastMessageAt || ts > lastMessageAt) lastMessageAt = ts;
        }
        startKey = out.LastEvaluatedKey;
      } while (startKey);
    } catch (err) {
      logger.warn(
        { agentId, day, errMessage: err instanceof Error ? err.message : String(err) },
        'agent-health usage read failed',
      );
    }
  }

  let errorsLast24h = 0;
  try {
    const errOut = await ddb().send(
      new QueryCommand({
        TableName: TABLE_AUDIT_LOG,
        IndexName: 'GSI1',
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': `AGENT#${agentId}` },
        // No server-side FilterExpression: the row-level filter below counts
        // agent_turn_error OR result==='error', which a single action= filter
        // could not express. (A prior version referenced an undefined :act and
        // the whole query was rejected, silently leaving errorsLast24h at 0.)
        ScanIndexForward: false,
        Limit: 200,
      }),
    );
    for (const item of errOut.Items ?? []) {
      if (String(item.action) !== 'agent_turn_error' && String(item.result) !== 'error') continue;
      const ts = String(item.ts ?? '');
      if (now - new Date(ts).getTime() <= 86400000) errorsLast24h += 1;
    }
  } catch { /* GSI may not exist */ }

  const errorRate = messagesLast24h > 0 ? errorsLast24h / messagesLast24h : 0;
  const avgLatencyMs = messagesLast24h > 0 ? Math.round(totalLatency / messagesLast24h) : 0;

  let status: AgentHealth['status'];
  if (messagesLast24h === 0 && errorsLast24h === 0) status = 'idle';
  else if (errorRate > 0.2) status = 'error';
  else if (errorRate >= 0.05) status = 'degraded';
  else status = 'healthy';

  return {
    lastMessageAt,
    messagesLast24h,
    errorsLast24h,
    avgLatencyMs,
    errorRate: Math.round(errorRate * 100) / 100,
    status,
  };
}

export async function collectAcrossDays(
  table: string,
  days: number,
  buildExpr: (day: string) => {
    KeyConditionExpression: string;
    ExpressionAttributeValues: Record<string, unknown>;
  },
): Promise<DDBRow[]> {
  const today = new Date();
  const out: DDBRow[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    const day = d.toISOString().slice(0, 10);
    const expr = buildExpr(day);
    try {
      const resp = await ddb().send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: expr.KeyConditionExpression,
          ExpressionAttributeValues: expr.ExpressionAttributeValues,
          ScanIndexForward: false,
          Limit: 200,
        }),
      );
      for (const r of resp.Items ?? []) out.push(r);
    } catch (err) {
      logger.warn(
        {
          table,
          day,
          errMessage: err instanceof Error ? err.message : String(err),
        },
        'dashboard query failed for day',
      );
    }
  }
  return out;
}
