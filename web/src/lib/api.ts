const TOKEN_KEY = 'cce_token';
// The logged-in human's identity, surfaced to the backend on EVERY request via
// the X-Dashboard-User header so the audit log records who did what (closing the
// shared-token audit gap). Sourced from /whoami after login (set by auth.ts via
// setDashboardUser) and cached so a hard refresh tags requests with the right
// identity before whoami re-resolves. The backend sanitizes + caps this value,
// so it is a hint, never an authorization input — the bearer token alone
// authorizes; this only labels the actor in the audit trail.
const DASHBOARD_USER_KEY = 'cce_dashboard_user';

function readCachedDashboardUser(): string {
  try {
    return localStorage.getItem(DASHBOARD_USER_KEY) ?? '';
  } catch {
    return '';
  }
}

let dashboardUser = readCachedDashboardUser();

/**
 * Set (or clear, with an empty string) the identity sent on the
 * X-Dashboard-User header. auth.ts calls this with the email from /whoami after
 * login; clearToken() resets it on logout. Persisted so the header is correct
 * immediately on a hard refresh, before /whoami round-trips.
 */
export function setDashboardUser(identity: string): void {
  dashboardUser = identity;
  try {
    if (identity) localStorage.setItem(DASHBOARD_USER_KEY, identity);
    else localStorage.removeItem(DASHBOARD_USER_KEY);
  } catch {
    // localStorage unavailable (private mode/quota) — the in-memory value still
    // tags requests for this tab; persistence is best-effort.
  }
}

export function getDashboardUser(): string {
  return dashboardUser;
}

export function getToken(): string {
  return sessionStorage.getItem(TOKEN_KEY) ?? localStorage.getItem(TOKEN_KEY) ?? '';
}

function clearUnknownChatSlot(): void {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (key?.startsWith('cce_chat_draft:unknown/')) sessionStorage.removeItem(key);
    }
    sessionStorage.removeItem('cce_chat_active:unknown');
  } catch { /* Storage is best-effort. */ }
}

export function setToken(token: string, remember = false): void {
  clearUnknownChatSlot();
  sessionStorage.removeItem('cce_chat_active');
  if (remember) {
    localStorage.setItem(TOKEN_KEY, token);
    sessionStorage.removeItem(TOKEN_KEY);
  } else {
    sessionStorage.setItem(TOKEN_KEY, token);
    localStorage.removeItem(TOKEN_KEY);
  }
}

export function clearToken(): void {
  clearUnknownChatSlot();
  sessionStorage.removeItem('cce_chat_active');
  sessionStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_KEY);
  // Never let one session's cached reads bleed into the next.
  clearApiCache();
  // Drop the cached role/label so a new session never hydrates a stale (or
  // higher-privilege) nav before /whoami resolves for the new token.
  localStorage.removeItem('cce_role');
  localStorage.removeItem('cce_label');
  // Drop the cached audit identity so the next session never tags requests as
  // the previous human until the new /whoami resolves.
  setDashboardUser('');
  // Clean up legacy keys from old UIs
  localStorage.removeItem('cce_dashboard_token');
  sessionStorage.removeItem('claudeclaw_token');
}

export function isRemembered(): boolean {
  return localStorage.getItem(TOKEN_KEY) !== null;
}

/**
 * Authenticated file download for export endpoints that stream a CSV/blob rather
 * than JSON. Every export button must go through this, NOT a hand-rolled fetch:
 * it sources the bearer from getToken() (sessionStorage-first, so it works on
 * the default non-remembered and magic-link logins where the token is NOT in
 * localStorage) and it checks res.ok BEFORE saving, so a 401/403 error body is
 * never written to disk as a .csv. Throws on non-2xx with the backend's reason
 * so the caller can surface a real error toast.
 */
export async function downloadFile(path: string, filename: string): Promise<void> {
  const token = getToken();
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  const who = getDashboardUser();
  if (who) headers['X-Dashboard-User'] = who;
  const res = await fetch(`/api${path}`, { headers });
  if (res.status === 401) {
    clearToken();
    window.location.reload();
    throw new Error('unauthorized');
  }
  if (!res.ok) {
    const msg = await res
      .json()
      .then((b: { error?: string; detail?: string }) => b.detail || b.error || `HTTP ${res.status}`)
      .catch(() => `HTTP ${res.status}`);
    throw new Error(msg);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Authenticated artifact bytes, kept out of the JSON GET cache. */
export async function getBytes(path: string): Promise<ArrayBuffer> {
  const headers: Record<string, string> = { Authorization: `Bearer ${getToken()}` };
  const who = getDashboardUser();
  if (who) headers['X-Dashboard-User'] = who;
  const res = await fetch(`/api${path}`, { headers });
  if (res.status === 401) {
    clearToken();
    window.location.reload();
    throw new Error('unauthorized');
  }
  if (!res.ok) {
    const msg = await res.json()
      .then((b: { error?: string; detail?: string }) => b.detail || b.error || `HTTP ${res.status}`)
      .catch(() => `HTTP ${res.status}`);
    throw new Error(msg);
  }
  return res.arrayBuffer();
}

// ── Read-through cache (stale-while-revalidate) for GET requests ──────
// Every tab refetches its data on mount, so without this each revisit flashes
// a skeleton even for a page you just left. We serve the last response
// instantly while it's fresh (< TTL) and silently revalidate in the
// background, and we drop the whole cache on ANY mutation so a write is never
// followed by a stale read.
//
// TTL is 60s: every cache hit ALSO revalidates in the background, so a served
// entry is at most one-visit stale, and real mutations still bust everything
// immediately. The old 15s TTL meant any tab not revisited within 15s went
// back to a cold skeleton — which, combined with the /tldr POST wiping the
// cache after every tab visit (see READ_ONLY_POSTS), made EVERY tab switch a
// cold load. That was the "couple seconds on every tab" bug.
const CACHE_TTL_MS = 60_000;

// POST endpoints that are read-shaped RPCs, not mutations: they change nothing
// the dashboard reads back, so they must NOT invalidate the GET cache. /tldr
// fires after every tab's data loads — letting it clear the cache guaranteed
// the next tab switch was always cold, defeating this cache entirely.
const READ_ONLY_POSTS = [/^\/tldr$/, /^\/compliance\/analyze$/, /^\/cost\/report(\/start)?$/];
interface CacheEntry {
  data: unknown;
  ts: number;
}
const getCache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<unknown>>();
// Bumped on every clearApiCache(). A GET whose fetch started before a
// mutation's clear must NOT repopulate the cache when it resolves: its data
// predates the write, and committing it would silently resurrect pre-mutation
// state for the next TTL window ("a write is never followed by a stale read").
let cacheEpoch = 0;

/** Drop all cached GETs. Called after every mutation, and exposed for logout. */
export function clearApiCache(): void {
  getCache.clear();
  inflight.clear();
  cacheEpoch++;
}

async function request<T>(path: string, opts: RequestInit = {}, signal?: AbortSignal): Promise<T> {
  const method = (opts.method ?? 'GET').toUpperCase();

  const doFetch = async (sig?: AbortSignal): Promise<T> => {
    const token = getToken();
    const headers: Record<string, string> = {
      ...(opts.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
    // Tag every request with the logged-in human so the backend audit log can
    // attribute actions to a person, not just the shared bearer token. Omitted
    // when unknown (pre-login) so we never send an empty/misleading value.
    const who = getDashboardUser();
    if (who) headers['X-Dashboard-User'] = who;
    const res = await fetch(`/api${path}`, { ...opts, signal: sig, headers });
    if (res.status === 401) {
      clearToken();
      window.location.reload();
      throw new Error('unauthorized');
    }
    if (!res.ok) {
      // Non-JSON error bodies (e.g. a WAF/CloudFront block page) fall through to
      // the status code. NOT res.statusText: over HTTP/2 it is always the empty
      // string, and `||` (not ??) so an empty error field can't make a blank
      // toast either.
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        detail?: string;
      };
      const base = body.error || `HTTP ${res.status}`;
      // Surface the backend's `detail` when present — e.g. presign/ingest
      // failures carry the real reason there, and dropping it left the UI
      // showing only an opaque code like "presign_failed".
      throw new Error(body.detail && body.detail !== base ? `${base}: ${body.detail}` : base);
    }
    return res.json() as Promise<T>;
  };

  // Mutations bypass the cache and invalidate every cached read on success, so
  // the post-write GET (e.g. a kill-switch toggle's reload) is always fresh.
  // Read-shaped POSTs (TLDR, analysis) bypass the cache but PRESERVE it.
  if (method !== 'GET') {
    const out = await doFetch(signal);
    if (!(method === 'POST' && READ_ONLY_POSTS.some((re) => re.test(path)))) {
      clearApiCache();
    }
    return out;
  }

  const key = path;
  const hit = getCache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
    // Fresh-enough: return instantly and refresh in the background (deduped, no
    // caller signal so an unmount can't abort the cache warm-up).
    if (!inflight.has(key)) {
      const epochAtStart = cacheEpoch;
      const p = doFetch()
        .then((d) => {
          if (cacheEpoch === epochAtStart) getCache.set(key, { data: d, ts: Date.now() });
        })
        .catch(() => {})
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
    }
    return hit.data as T;
  }

  // Miss or stale: fetch with the caller's signal and cache the result. The
  // epoch check keeps a response that predates a concurrent mutation's
  // clearApiCache() out of the cache (still returned to this caller, though).
  const epochAtStart = cacheEpoch;
  const data = await doFetch(signal);
  if (cacheEpoch === epochAtStart) getCache.set(key, { data, ts: Date.now() });
  return data;
}

// Effective daily cost cap plus where the value comes from (runtime override
// vs the env default). Mirrors the GET /api/cost-cap response shape exactly:
// { dailyCapUsd: number, source: 'runtime-config' | 'env-default' }.
export interface CostCap {
  dailyCapUsd: number;
  source: 'runtime-config' | 'env-default';
}

// Token-bucket policy and live usage for a rate-limit key. Mirrors the
// /api/rate-limits/* response shapes.
export interface RateLimitPolicy {
  key: string;
  limit: number;
  windowSeconds: number;
}

export interface RateLimitUsage {
  key: string;
  used: number;
  limit: number;
  remaining: number;
  resetAt: string | null;
}

// A single read-only posture status card. Mirrors the PostureCard shape every
// GET /api/posture/* router returns. status drives the colored dot; value is an
// optional short metadata string (never a secret value).
export interface PostureCard {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'crit' | 'unknown';
  detail: string;
  value?: string;
}

export interface PostureResponse {
  cards: PostureCard[];
}

// An alert-email recipient and its SNS subscription state. Mirrors the
// GET /api/alerts/subscriptions response. status follows the SNS subscription
// lifecycle: 'PendingConfirmation' until the user clicks the AWS confirmation
// email, then 'Confirmed'. subscriptionArn is null while pending.
export interface AlertSubscription {
  email: string;
  status: 'PendingConfirmation' | 'Confirmed' | 'Unknown';
  subscriptionArn: string | null;
}

// A configured CloudWatch alarm / alert type rendered read-only on the
// Alerting page. status mirrors the CloudWatch alarm state.
export interface AlertAlarm {
  id: string;
  label: string;
  description: string;
  status: 'ok' | 'alarm' | 'insufficient' | 'unknown';
  metric?: string;
  threshold?: string;
}

export interface AlertsListResponse {
  subscriptions: AlertSubscription[];
  alarms: AlertAlarm[];
  topicArn: string | null;
}

// Coarse per-agent health status. Mirrors the backend computeAgentHealth
// status enum exactly. NOTE: 'down'/'unknown' are NOT returned by the backend.
export type AgentHealthStatus = 'healthy' | 'idle' | 'degraded' | 'error';

// Per-agent health rollup row. Mirrors one entry of GET /api/agents/health
// `agents[]`. Activity / error signal over the rolling 24h window.
export interface AgentHealth {
  agentId: string;
  lastMessageAt: string | null;
  messagesLast24h: number;
  errorsLast24h: number;
  avgLatencyMs: number;
  errorRate: number;
  status: AgentHealthStatus;
}

// Full GET /api/agents/health response. There is NO top-level `alarms` and NO
// `canary` key (those live on Security Posture > Observability). overall +
// counts drive the Overview health pill; agents[] drives the health card.
export interface AgentsHealthResponse {
  generatedAt: string;
  overall: AgentHealthStatus;
  agentCount: number;
  counts: { healthy: number; idle: number; degraded: number; error: number };
  totalMessages24h: number;
  totalErrors24h: number;
  agents: AgentHealth[];
}

// Health of one connected surface probe. Mirrors SurfaceHealth in
// src/lib/state/integrations-inventory.ts (status enum is ok|warn|unknown).
export interface SurfaceHealth {
  status: 'ok' | 'warn' | 'unknown';
  detail: string;
}

// One row of the per-agent integration matrix. Mirrors GET /api/integrations
// `entries[]` exactly. verificationMode is a boolean (signature/secret
// verification ON); softBypassRisk is true when the surface would accept
// unsigned/unverified inbound (the risk the UI flags).
export interface IntegrationEntry {
  surface: 'slack' | 'telegram';
  agentId: string;
  verificationMode: boolean;
  softBypassRisk: boolean;
  health: SurfaceHealth;
}

export interface IntegrationsResponse {
  generatedAt: string;
  entries: IntegrationEntry[];
}

// One secret's posture. Metadata only — NEVER a secret value. Mirrors GET
// /api/integrations/secrets-posture `secrets[]` exactly.
export interface SecretPosture {
  id: string;
  name: string;
  lastRotated: string | null;
  hasRotationSchedule: boolean;
  status: 'ok' | 'warn' | 'crit' | 'unknown';
  detail: string;
}

export interface SecretsPostureResponse {
  generatedAt: string;
  secrets: SecretPosture[];
}

// One MCP server agents can call tools on. Mirrors McpServerConfig in
// src/lib/mcp/types.ts, except the bearer token is write-only: the API returns
// hasBearerToken and never the value.
export interface McpServerEntry {
  id: string;
  name: string;
  url: string;
  auth: 'iam' | 'bearer' | 'none';
  /** Write-only; omit to keep the stored token when editing. */
  bearerToken?: string;
  hasBearerToken?: boolean;
  enabled: boolean;
  /** Agent ids that get this server's tools. Empty = every agent. */
  agents: string[];
}

export interface McpProbeResult {
  ok: boolean;
  tools: { name: string; description?: string }[];
  error?: string;
}

// AWS cost summary. Mirrors GET /api/cost/summary (CostSummary in
// src/lib/aws/cost-reader.ts). `available` is false when Cost Explorer is
// denied/errored, in which case `note` explains why and the figures are 0.
export interface CostServiceSlice {
  service: string;
  amountUsd: number;
}
export interface CostDailyPoint {
  date: string;
  amountUsd: number;
}
export interface CostSummary {
  generatedAt: string;
  currency: 'USD';
  available: boolean;
  note?: string;
  monthToDateUsd: number;
  lastMonthUsd: number;
  projectedMonthUsd: number;
  daysElapsed: number;
  daysInMonth: number;
  byService: CostServiceSlice[];
  daily: CostDailyPoint[];
}

// One flagged cost risk. Mirrors CostRisk in src/lib/aws/cost-reader.ts.
// estMonthlyUsd is what the resource costs now; estMonthlySavingsUsd is the
// recoverable portion. resourceIds identify what to act on.
export interface CostRisk {
  id: string;
  severity: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  region: string;
  estMonthlyUsd: number;
  estMonthlySavingsUsd: number;
  resourceIds: string[];
}
export interface CostRisksResult {
  generatedAt: string;
  available: boolean;
  note?: string;
  regionsScanned: string[];
  risks: CostRisk[];
  totalMonthlySavingsUsd: number;
}

// On-demand AI cost report. Mirrors the CostReport shape in
// src/lib/aws/cost-analyst.ts (POST /api/cost/report). Dollar figures on the
// drivers are the authoritative Cost Explorer amounts re-attached server-side,
// not model output. `available` is false when Cost Explorer data is missing,
// in which case the prose fields are empty and `note` explains why.
export type CostNecessity = 'essential' | 'review' | 'likely-waste';
export interface CostDriver {
  service: string;
  monthToDateUsd: number;
  sharePct: number;
  whatItIs: string;
  necessity: CostNecessity;
  assessment: string;
  // A cheaper service/config to switch to + rough saving, or '' if none.
  cheaperAlternative: string;
}
// A non-obvious recurring drain the mechanical waste scan misses (data egress,
// aged snapshots, over-retentive logs, over-provisioning, forgotten resources).
export interface HiddenCost {
  title: string;
  detail: string;
  estMonthlyUsd: number;
}
export interface CostOptimization {
  title: string;
  rationale: string;
  // What to switch TO for a substitution fix, or '' for a plain delete/right-size.
  alternative: string;
  estMonthlySavingsUsd: number;
  // Approximate monthly cost of this line AFTER the change; 0 when unknown.
  estNewMonthlyUsd: number;
  effort: 'low' | 'medium' | 'high';
  priority: 'high' | 'medium' | 'low';
}
// Cost remediation: a real AWS mutation applied from the Cost tab. Mirrors
// RemediationResult in src/lib/aws/cost-remediation.ts. status === 'applied'
// with verified === true is the ONLY combination that means the change actually
// landed in AWS; 'refused' means a pre-flight idleness check stopped it
// (nothing touched), 'failed' means the AWS call errored (e.g. perms not armed).
export type RemediationAction =
  | 'release-eip'
  | 'delete-ebs-volume'
  | 'delete-nat-gateway'
  | 'delete-vpc-endpoint'
  | 'delete-load-balancer'
  | 'set-log-retention';
export interface RemediationResult {
  action: RemediationAction;
  region: string;
  resourceId: string;
  status: 'applied' | 'refused' | 'failed';
  verified: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export interface CostReport {
  generatedAt: string;
  modelId: string;
  generationCostUsd: number;
  available: boolean;
  note?: string;
  headline: string;
  verdict: 'over-budget' | 'on-track' | 'unknown';
  totalEstSavingsUsd: number;
  // Authoritative pre-optimization month-end projection (Cost Explorer run-rate).
  projectedMonthlyNowUsd: number;
  // Projected month-end bill after applying the optimizations (now minus capped savings).
  projectedMonthlyAfterUsd: number;
  drivers: CostDriver[];
  hiddenCosts: HiddenCost[];
  optimizations: CostOptimization[];
  claudeCodePlan: string;
}

// IAM copilot. Draft is read-only; apply mutates IAM and is gated server-side
// (admin + runtime-config iam/apply_enabled + confirm + guardrails).
export interface IamFinding {
  type: string; // ERROR | SECURITY_WARNING | WARNING | SUGGESTION | INFO
  code: string;
  message: string;
}
export interface IamDraftResult {
  policyDocument: string;
  explanation: string;
  warnings: string[];
  findings: IamFinding[];
}
export type IamApplyAction =
  | 'create_policy'
  | 'put_role_policy'
  | 'attach_role_policy'
  | 'create_user'
  | 'put_user_policy'
  | 'attach_user_policy';
export interface IamApplyRequest {
  action: IamApplyAction;
  roleName?: string;
  userName?: string;
  policyName?: string;
  policyArn?: string;
  policyDocument?: string;
  allowDangerous?: boolean;
  confirm: true;
}

// ── Compliance (SOC 2 + HIPAA gap analysis) ──────────────────────────
// Mirrors the GET /api/compliance/summary + POST /api/compliance/analyze
// shapes (src/lib/compliance/*). Automated controls are graded from live
// posture evidence; manual controls require attestation and are excluded from
// the score.
export type ComplianceFrameworkId = 'soc2' | 'hipaa';
export type ControlStatus = 'met' | 'partial' | 'gap' | 'unknown' | 'manual';

export interface ControlEvidence {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'crit' | 'unknown';
  detail: string;
  value?: string;
}

export interface EvaluatedControl {
  id: string;
  framework: ComplianceFrameworkId;
  ref: string;
  title: string;
  category: string;
  intent: string;
  quickFix: string;
  manual: boolean;
  status: ControlStatus;
  evidence: ControlEvidence[];
}

export interface FrameworkResult {
  id: ComplianceFrameworkId;
  label: string;
  description: string;
  score: number;
  gradedCount: number;
  counts: Record<ControlStatus, number>;
  controls: EvaluatedControl[];
}

export interface ScanArea {
  id: string;
  label: string;
  total: number;
  ok: number;
  warn: number;
  crit: number;
  unknown: number;
}

export interface ComplianceSummary {
  generatedAt: string;
  evidenceCount: number;
  disclaimer: string;
  frameworks: FrameworkResult[];
  scan: { areas: ScanArea[] };
}

export interface RemediationBrief {
  generatedAt: string;
  markdown: string;
  stats: {
    soc2Score: number;
    hipaaScore: number;
    met: number;
    partial: number;
    gap: number;
    unknown: number;
    manual: number;
  };
}

export interface ControlAnalysis {
  controlId: string;
  framework: ComplianceFrameworkId;
  ref: string;
  title: string;
  edition: string;
  requirement: string;
  currentState: string;
  gaps: string[];
  remediation: string[];
  references: string[];
  modelId: string;
}

// The legacy 3-rung role, mirrored here so api.ts has no import cycle with
// auth.ts (auth.ts imports api.ts). auth.ts keeps `Role` as the canonical name
// the rest of the UI imports; this is the same union under a distinct name.
export type WhoAmIRole = 'viewer' | 'operator' | 'admin';

// Identity returned by GET /api/whoami. role/label are the legacy fields the
// existing nav already consumes; email/profileId/capabilities are the Wave 4b
// additions that drive the capability-aware UI. capabilities is the flat set
// resolved from the caller's profile (see src/lib/auth/permissions.ts).
export interface WhoAmI {
  role: WhoAmIRole;
  label: string | null;
  email: string | null;
  profileId: string | null;
  capabilities: string[];
}

// Shape returned by the magic-link consume routes (accept + verify). `token` is
// the per-user session bearer to store via the auth/onLogin flow.
export interface MagicConsumeResult {
  token: string;
  email: string;
  profileId: string;
}

// ── Seat administration (absorbed from PR #42; backend /api/seats) ──────────

export type SeatStatus = 'invited' | 'active' | 'suspended' | 'retired';
export type PolicyOutcome = 'allowed' | 'denied';

export interface Seat {
  seatId: string;
  userId: string;
  status: SeatStatus;
  policyId: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface SeatPolicy {
  policyId: string;
  label: string;
  allowedModels: string[];
  monthlySpendLimitUsd?: number;
  allowedTools: string[];
  createdAt: string;
  updatedAt: string;
}

export interface SeatUsageRow {
  usageId: string;
  seatId: string;
  userId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  policyId: string;
  policyOutcome: PolicyOutcome;
  denialReason?: string;
  sessionId?: string;
  createdAt: string;
}

export interface SeatPage<T> {
  items: T[];
  nextCursor?: string;
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, {}, signal),
  post: <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    request<T>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined }, signal),
  patch: <T>(path: string, body: unknown, signal?: AbortSignal) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }, signal),
  put: <T>(path: string, body: unknown, signal?: AbortSignal) =>
    request<T>(path, { method: 'PUT', body: JSON.stringify(body) }, signal),
  del: <T>(path: string, signal?: AbortSignal) => request<T>(path, { method: 'DELETE' }, signal),

  // Magic-link passwordless auth (Wave 4a backend, mounted at /api/auth). These
  // are the ONLY pre-session routes: login is called from the Login page with no
  // bearer; accept/verify are reached from an emailed link before any session
  // exists. login always resolves 202 (no account enumeration). accept/verify
  // return the per-user session token to store via the auth/onLogin flow.
  auth: {
    login: (email: string, signal?: AbortSignal) =>
      request<{ status: string }>('/auth/login', { method: 'POST', body: JSON.stringify({ email }) }, signal),
    // GET is read-only (does NOT consume the token); used to preview the invitee
    // email before they accept. A missing/expired/consumed token is a uniform
    // 404 (request() surfaces it as a thrown Error).
    inviteInfo: (token: string, signal?: AbortSignal) =>
      request<{ email: string; profileId: string }>(
        `/auth/invite/${encodeURIComponent(token)}`,
        {},
        signal,
      ),
    acceptInvite: (token: string, signal?: AbortSignal) =>
      request<MagicConsumeResult>(
        `/auth/invite/${encodeURIComponent(token)}/accept`,
        { method: 'POST' },
        signal,
      ),
    verify: (token: string, signal?: AbortSignal) =>
      request<MagicConsumeResult>('/auth/verify', { method: 'POST', body: JSON.stringify({ token }) }, signal),
  },

  whoami: (signal?: AbortSignal) => request<WhoAmI>('/whoami', {}, signal),

  // Generic runtime config key-value store backed by claudeclaw-runtime-config.
  // Reads can be operator; writes are admin-gated by the backend.
  config: {
    get: (category: string, key: string, signal?: AbortSignal) =>
      request<{ category: string; key: string; value: string | null }>(
        `/config/${encodeURIComponent(category)}/${encodeURIComponent(key)}`,
        {},
        signal,
      ),
    list: (category: string, signal?: AbortSignal) =>
      request<{ category: string; values: Record<string, string> }>(
        `/config/${encodeURIComponent(category)}`,
        {},
        signal,
      ),
    set: (category: string, key: string, value: string, signal?: AbortSignal) =>
      request<{ ok: true }>(
        `/config/${encodeURIComponent(category)}/${encodeURIComponent(key)}`,
        { method: 'POST', body: JSON.stringify({ value }) },
        signal,
      ),
  },

  // Daily cost cap. Reads are operator; writes are admin-gated by the backend.
  costCap: {
    get: (signal?: AbortSignal) => request<CostCap>('/cost-cap', {}, signal),
    set: (dailyCapUsd: number, reason?: string, signal?: AbortSignal) =>
      request<CostCap>(
        '/cost-cap',
        { method: 'POST', body: JSON.stringify({ dailyCapUsd, ...(reason ? { reason } : {}) }) },
        signal,
      ),
  },

  // IAM copilot. All admin-gated by the backend. draft/status are read-only;
  // apply mutates IAM and additionally requires the server-side kill switch.
  iam: {
    status: (signal?: AbortSignal) => request<{ applyEnabled: boolean }>('/iam/status', {}, signal),
    draft: (instruction: string, existingPolicy?: string, signal?: AbortSignal) =>
      request<IamDraftResult>(
        '/iam/draft',
        { method: 'POST', body: JSON.stringify({ instruction, ...(existingPolicy ? { existingPolicy } : {}) }) },
        signal,
      ),
    apply: (req: IamApplyRequest, signal?: AbortSignal) =>
      request<{ ok: true; detail: string; arn?: string }>(
        '/iam/apply',
        { method: 'POST', body: JSON.stringify(req) },
        signal,
      ),
  },

  // AWS cost visibility. Reads are operator-gated by the backend. summary is
  // live Cost Explorer spend + projection; risks is the waste scan. Both fail
  // soft (available:false) when Cost Explorer permission is missing.
  cost: {
    summary: (signal?: AbortSignal) => request<CostSummary>('/cost/summary', {}, signal),
    risks: (signal?: AbortSignal) => request<CostRisksResult>('/cost/risks', {}, signal),
    // On-demand AI cost report (cost:read; operator+). POST so it bypasses the
    // GET cache — each report is a fresh model call grounded in live spend.
    report: (signal?: AbortSignal) =>
      request<CostReport>('/cost/report', { method: 'POST' }, signal),
    // Whether to use the async (background + poll) report path. Settings toggle.
    reportMode: (signal?: AbortSignal) =>
      request<{ async: boolean }>('/cost/report/mode', {}, signal),
    // Async report: start a background generation (returns immediately) then poll
    // the result. Used when reportMode().async is true; richer + no 60s limit.
    reportStart: (signal?: AbortSignal) =>
      request<{ jobId: string; status: 'pending' }>('/cost/report/start', { method: 'POST' }, signal),
    reportResult: (signal?: AbortSignal) =>
      // Unique URL per poll so the 15s GET cache never returns a stale 'pending'
      // after the job has actually finished.
      request<{ status: 'idle' | 'pending' | 'done' | 'error'; report?: CostReport; error?: string }>(
        `/cost/report/result?_=${Date.now()}`,
        {},
        signal,
      ),
    // Whether the Apply (remediation) controls should show — armed server-side.
    remediationStatus: (signal?: AbortSignal) =>
      request<{ enabled: boolean }>('/cost/remediation/status', {}, signal),
    // Apply ONE remediation against real AWS (cost:write + armed). Always sends
    // confirm:true; the caller is responsible for confirming with the user first.
    remediate: (
      req: { action: RemediationAction; region: string; resourceId: string; retentionDays?: number },
      signal?: AbortSignal,
    ) =>
      request<RemediationResult>(
        '/cost/remediate',
        { method: 'POST', body: JSON.stringify({ ...req, confirm: true }) },
        signal,
      ),
  },

  // Rate-limit policies and live usage backed by claudeclaw-rate-limits.
  rateLimits: {
    getPolicy: (key: string, signal?: AbortSignal) =>
      request<RateLimitPolicy>(`/rate-limits/${encodeURIComponent(key)}/policy`, {}, signal),
    setPolicy: (key: string, policy: { limit: number; windowSeconds: number }, signal?: AbortSignal) =>
      request<RateLimitPolicy>(
        `/rate-limits/${encodeURIComponent(key)}/policy`,
        { method: 'POST', body: JSON.stringify(policy) },
        signal,
      ),
    getUsage: (key: string, signal?: AbortSignal) =>
      request<RateLimitUsage>(`/rate-limits/${encodeURIComponent(key)}/usage`, {}, signal),
    reset: (key: string, signal?: AbortSignal) =>
      request<{ ok: true }>(`/rate-limits/${encodeURIComponent(key)}/reset`, { method: 'POST' }, signal),
  },

  // Read-only security posture. Every method is a GET that returns status cards
  // describing AWS posture (network/WAF, encryption/secrets, IAM, observability).
  // These fail soft on the backend, so a denied describe call returns an
  // 'unknown' card rather than erroring the request.
  posture: {
    network: (signal?: AbortSignal) => request<PostureResponse>('/posture/network', {}, signal),
    security: (signal?: AbortSignal) => request<PostureResponse>('/posture/security', {}, signal),
    iam: (signal?: AbortSignal) => request<PostureResponse>('/posture/iam', {}, signal),
    observability: (signal?: AbortSignal) => request<PostureResponse>('/posture/observability', {}, signal),
  },

  // Ops alert recipients (SNS email subscriptions on the existing ops-alerts
  // topic) plus the configured CloudWatch alarms. Reads are operator; subscribe
  // and remove are admin-gated by the backend. Subscribing fires an AWS-native
  // SNS confirmation email; the subscription stays PendingConfirmation until
  // the recipient clicks the link.
  alerts: {
    list: (signal?: AbortSignal) => request<AlertsListResponse>('/alerts/subscriptions', {}, signal),
    subscribe: (email: string, signal?: AbortSignal) =>
      request<AlertSubscription>(
        '/alerts/subscribe',
        { method: 'POST', body: JSON.stringify({ email }) },
        signal,
      ),
    remove: (email: string, signal?: AbortSignal) =>
      request<{ ok: true }>(
        `/alerts/subscriptions/${encodeURIComponent(email)}`,
        { method: 'DELETE' },
        signal,
      ),
  },

  // Per-agent health rollup (overall + counts + per-agent 24h activity) used by
  // the Overview health pill and Agent Health card. Read-only; fails soft on
  // the backend. No alarm/canary signals live here.
  agentsHealth: (signal?: AbortSignal) => request<AgentsHealthResponse>('/agents/health', {}, signal),

  // Per-agent integration matrix and the integrations secrets posture. Reads
  // are operator. Secrets posture returns names + last-rotated only, never a
  // secret value.
  integrations: {
    list: (signal?: AbortSignal) => request<IntegrationsResponse>('/integrations', {}, signal),
    secretsPosture: (signal?: AbortSignal) =>
      request<SecretsPostureResponse>('/integrations/secrets-posture', {}, signal),
    // MCP servers agents can call tools on (AgentCore gateways / remote MCPs).
    // list is operator+, save is admin (server-enforced), probe does a live
    // tools/list against the endpoint and surfaces the transport error verbatim.
    mcpList: (signal?: AbortSignal) =>
      request<{ servers: McpServerEntry[] }>('/integrations/mcp', {}, signal),
    mcpSave: (servers: McpServerEntry[], signal?: AbortSignal) =>
      request<{ servers: McpServerEntry[] }>(
        '/integrations/mcp',
        { method: 'PUT', body: JSON.stringify({ servers }) },
        signal,
      ),
    mcpProbe: (id: string, signal?: AbortSignal) =>
      request<McpProbeResult>(
        `/integrations/mcp/${encodeURIComponent(id)}/probe`,
        { method: 'POST', body: '{}' },
        signal,
      ),
  },

  // Jarvis voice canary allowlist. Both routes are admin-gated server-side and
  // are EXEMPT from the fail-closed isJarvisEnabled gate (so the allowlist can be
  // bootstrapped). The path param is the token hash that identifies the allowed
  // principal. There is no list route (the table is keyed only by token hash),
  // so the UI is add/remove only.
  jarvisCanary: {
    add: (tokenHash: string, label?: string, signal?: AbortSignal) =>
      request<{ ok: true }>(
        `/jarvis/canary/${encodeURIComponent(tokenHash)}`,
        { method: 'POST', body: JSON.stringify(label ? { label } : {}) },
        signal,
      ),
    remove: (tokenHash: string, signal?: AbortSignal) =>
      request<{ ok: true }>(
        `/jarvis/canary/${encodeURIComponent(tokenHash)}`,
        { method: 'DELETE' },
        signal,
      ),
  },

  // SOC 2 / HIPAA compliance gap analysis (compliance:read; operator+). summary
  // scores the control catalog against live posture evidence (read-only, cached
  // on the backend). analyze runs the read-only AI analyst for one control and
  // invokes a model, so it bypasses the GET cache (POST).
  compliance: {
    summary: (signal?: AbortSignal) => request<ComplianceSummary>('/compliance/summary', {}, signal),
    brief: (signal?: AbortSignal) => request<RemediationBrief>('/compliance/brief', {}, signal),
    analyze: (controlId: string, signal?: AbortSignal) =>
      request<ControlAnalysis>(
        '/compliance/analyze',
        { method: 'POST', body: JSON.stringify({ controlId }) },
        signal,
      ),
  },

  // Seat administration (seats:read/write, seat-policies:read/write,
  // usage:org:read) + seat self-service (usage:self:read). The backend
  // re-checks every route; these helpers mirror src/adapters/dashboard/
  // seat-admin.ts exactly.
  seats: {
    list: (cursor?: string, signal?: AbortSignal) =>
      request<SeatPage<Seat>>(`/seats${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, {}, signal),
    create: (userId: string, policyId: string, signal?: AbortSignal) =>
      request<Seat>('/seats', { method: 'POST', body: JSON.stringify({ userId, policyId }) }, signal),
    update: (seatId: string, patch: { status?: SeatStatus; policyId?: string }, signal?: AbortSignal) =>
      request<Seat>(`/seats/${encodeURIComponent(seatId)}`, { method: 'PATCH', body: JSON.stringify(patch) }, signal),
    policies: (cursor?: string, signal?: AbortSignal) =>
      request<SeatPage<SeatPolicy>>(`/seats/policies${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, {}, signal),
    createPolicy: (
      body: { label: string; allowedModels: string[]; allowedTools?: string[]; monthlySpendLimitUsd?: number },
      signal?: AbortSignal,
    ) => request<SeatPolicy>('/seats/policies', { method: 'POST', body: JSON.stringify(body) }, signal),
    updatePolicy: (
      policyId: string,
      body: { label?: string; allowedModels?: string[]; allowedTools?: string[]; monthlySpendLimitUsd?: number },
      signal?: AbortSignal,
    ) =>
      request<SeatPolicy>(`/seats/policies/${encodeURIComponent(policyId)}`, { method: 'PATCH', body: JSON.stringify(body) }, signal),
    usage: (date?: string, cursor?: string, signal?: AbortSignal) => {
      const q = new URLSearchParams();
      if (date) q.set('date', date);
      if (cursor) q.set('cursor', cursor);
      const qs = q.toString();
      return request<SeatPage<SeatUsageRow> & { date: string }>(`/seats/usage${qs ? `?${qs}` : ''}`, {}, signal);
    },
    me: (signal?: AbortSignal) => request<{ seat: Seat; policy: SeatPolicy | null }>('/seats/me', {}, signal),
    myUsage: (date?: string, signal?: AbortSignal) =>
      request<SeatPage<SeatUsageRow> & { date: string }>(`/seats/me/usage${date ? `?date=${date}` : ''}`, {}, signal),
  },
};
