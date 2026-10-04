import { useState, useEffect } from 'preact/hooks';
import { lazy, Suspense } from 'preact/compat';
import type { ComponentType } from 'preact';
import { Route, Switch, Router, useLocation } from 'wouter-preact';
import { api, getToken, setToken } from './lib/api';
import {
  currentRole,
  loadRole,
  hasCapability,
} from './lib/auth';
import './lib/theme';
import { Sidebar, sidebarCollapsed } from './components/Sidebar';
import { Header } from './components/Header';
import { ToastContainer } from './components/Toast';
import { JarvisWidget } from './components/JarvisWidget';
import { ErrorState } from './components/ErrorState';
import { EmptyState } from './components/EmptyState';
import { TourOverlay } from './components/TourOverlay';
import { ErrorBoundary } from './components/ErrorBoundary';

// Pre-auth pages stay eager: Login is the first paint for an unauthenticated
// user, and /accept + /verify are magic-link landing pages where an extra
// chunk fetch is one more thing that can fail between email and session.
// GettingStarted stays eager because its module-level constant is read below,
// which puts the module in the eager graph regardless. NotFound is tiny.
import { GettingStarted, GETTING_STARTED_SEEN_KEY } from './pages/GettingStarted';
import { Login } from './pages/Login';
import { AcceptInvite } from './pages/AcceptInvite';
import { VerifyLogin } from './pages/VerifyLogin';
import { NotFound } from './pages/NotFound';

// Every other routed page is a lazy chunk so the entry bundle stays small;
// shared deps (markdown renderer, icon set) split into common chunks. Pages
// use named exports, hence the `.then` default-export shims.
//
// A failed dynamic import here is almost always a deploy racing an open
// session: chunks are hashed per build and served from each task's local
// dist/web, so after an image swap the old hashes 404 for every tab the
// session has not visited yet. preact/compat lazy() caches a rejection
// forever (the ErrorBoundary's "try again" would just re-throw it), so
// instead reload the page ONCE to pick up the new index.html and its fresh
// chunk names. The sessionStorage guard stops a reload loop when the asset
// is genuinely unreachable (real outage) — the second failure falls through
// to the ErrorBoundary. The never-resolving promise keeps the Suspense
// "Loading..." up during the reload instead of flashing an error.
const CHUNK_RELOAD_KEY = 'cce_chunk_reloaded';
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- pages have heterogeneous prop shapes
type PageModule = { default: ComponentType<any> };
function lazyRoute(load: () => Promise<PageModule>) {
  return lazy(() =>
    load().then(
      (m) => {
        try {
          sessionStorage.removeItem(CHUNK_RELOAD_KEY);
        } catch {
          /* storage unavailable (private mode): guard just stays set */
        }
        return m;
      },
      (err): Promise<PageModule> => {
        let alreadyReloaded = true;
        try {
          alreadyReloaded = sessionStorage.getItem(CHUNK_RELOAD_KEY) === '1';
          if (!alreadyReloaded) sessionStorage.setItem(CHUNK_RELOAD_KEY, '1');
        } catch {
          /* storage unavailable: can't guard a loop, so don't auto-reload */
        }
        if (!alreadyReloaded) {
          location.reload();
          return new Promise<PageModule>(() => {});
        }
        throw err;
      },
    ),
  );
}

const Overview = lazyRoute(() => import('./pages/Overview').then((m) => ({ default: m.Overview })));
const Seats = lazyRoute(() => import('./pages/Seats').then((m) => ({ default: m.Seats })));
const MySeat = lazyRoute(() => import('./pages/MySeat').then((m) => ({ default: m.MySeat })));
const Agents = lazyRoute(() => import('./pages/Agents').then((m) => ({ default: m.Agents })));
const AgentDetail = lazyRoute(() => import('./pages/AgentDetail').then((m) => ({ default: m.AgentDetail })));
const Chat = lazyRoute(() => import('./pages/Chat').then((m) => ({ default: m.Chat })));
const Playground = lazyRoute(() => import('./pages/Playground').then((m) => ({ default: m.Playground })));
const Sessions = lazyRoute(() => import('./pages/Sessions').then((m) => ({ default: m.Sessions })));
const Usage = lazyRoute(() => import('./pages/Usage').then((m) => ({ default: m.Usage })));
const Cost = lazyRoute(() => import('./pages/Cost').then((m) => ({ default: m.Cost })));
const AuditLog = lazyRoute(() => import('./pages/AuditLog').then((m) => ({ default: m.AuditLog })));
const KillSwitches = lazyRoute(() => import('./pages/KillSwitches').then((m) => ({ default: m.KillSwitches })));
const DLP = lazyRoute(() => import('./pages/DLP').then((m) => ({ default: m.DLP })));
const Panic = lazyRoute(() => import('./pages/Panic').then((m) => ({ default: m.Panic })));
const RateLimits = lazyRoute(() => import('./pages/RateLimits').then((m) => ({ default: m.RateLimits })));
const SecurityPosture = lazyRoute(() => import('./pages/SecurityPosture').then((m) => ({ default: m.SecurityPosture })));
const Compliance = lazyRoute(() => import('./pages/Compliance').then((m) => ({ default: m.Compliance })));
const Alerting = lazyRoute(() => import('./pages/Alerting').then((m) => ({ default: m.Alerting })));
const Integrations = lazyRoute(() => import('./pages/Integrations').then((m) => ({ default: m.Integrations })));
const Vectors = lazyRoute(() => import('./pages/Vectors').then((m) => ({ default: m.Vectors })));
const WorkInbox = lazyRoute(() => import('./pages/work/Inbox').then(m => ({ default: m.Inbox })));
const WorkCases = lazyRoute(() => import('./pages/work/Cases').then(m => ({ default: m.Cases })));
const WorkCaseDetail = lazyRoute(() => import('./pages/work/CaseDetail').then(m => ({ default: m.CaseDetail })));
const WorkApprovals = lazyRoute(() => import('./pages/work/Approvals').then(m => ({ default: m.Approvals })));
const WorkApprovalDetail = lazyRoute(() => import('./pages/work/ApprovalDetail').then(m => ({ default: m.ApprovalDetail })));
const Missions = lazyRoute(() => import('./pages/Missions').then((m) => ({ default: m.Missions })));
const Memories = lazyRoute(() => import('./pages/Memories').then((m) => ({ default: m.Memories })));
const HiveMind = lazyRoute(() => import('./pages/HiveMind').then((m) => ({ default: m.HiveMind })));
const ScheduledTasks = lazyRoute(() => import('./pages/ScheduledTasks').then((m) => ({ default: m.ScheduledTasks })));
const WarRoom = lazyRoute(() => import('./pages/WarRoom').then((m) => ({ default: m.WarRoom })));
const Settings = lazyRoute(() => import('./pages/Settings').then((m) => ({ default: m.Settings })));
const Members = lazyRoute(() => import('./pages/Members'));
const Jarvis = lazyRoute(() => import('./routes/Jarvis').then((m) => ({ default: m.Jarvis })));

function AuthGate({ children }: { children: preact.ComponentChildren }) {
  const [token, setTokenState] = useState(getToken());

  if (!token) {
    return (
      <Login onLogin={(t, remember) => {
        setToken(t, remember);
        setTokenState(t);
      }} />
    );
  }

  return <>{children}</>;
}

/**
 * Capability gate for the Wave 4a/4b permission profiles, now the AUTHORITATIVE
 * client gate for every privileged route (Wave 4c). It replaces the legacy
 * viewer/operator/admin role-rank gate (RequireRole) so templated profiles
 * (viewer/analyst/operator/admin/owner) AND fully custom profiles both work off
 * one mechanism: hasCapability(), the same flat capability check the backend
 * uses (src/lib/auth/permissions.ts). The env root/owner token resolves to
 * ALL_CAPABILITIES so it passes every gate.
 *
 * currentRole resolves to null only before /whoami has been attempted; while it
 * is null we show the neutral "checking" state. The capability set hydrates from
 * the same localStorage cache as the role and is set by the same loadRole()
 * call, so "role resolved" is a sound proxy for "capabilities resolved" — until
 * then we fail closed (no flash of a privileged surface). The backend is the
 * real authority; this only hides a surface the principal can't use.
 */
function RequireCapability({
  need,
  label,
  children,
}: {
  need: string;
  label: string;
  children: preact.ComponentChildren;
}) {
  if (currentRole.value === null) {
    return <div class="text-body-sm text-muted py-16 text-center">Checking permissions...</div>;
  }
  if (!hasCapability(need)) {
    return (
      <EmptyState
        title={`${label} access required`}
        description={`This page needs the "${need}" permission. Your account does not hold it. Ask an administrator to update your profile.`}
      />
    );
  }
  return <>{children}</>;
}

function WorkRedirect() {
  const [, setLocation] = useLocation();
  useEffect(() => { setLocation('/work', { replace: true }); }, [setLocation]);
  return <div role="status" class="skeleton h-12 w-full"><span class="sr-only">Loading Work</span></div>;
}

function AppShell() {
  const collapsed = sidebarCollapsed.value;
  const [location, setLocation] = useLocation();
  const [workEnabled, setWorkEnabled] = useState<boolean | null>(null);
  const [workStatusError, setWorkStatusError] = useState(false);
  const [workStatusVersion, setWorkStatusVersion] = useState(0);

  useEffect(() => { loadRole(); }, []);
  useEffect(() => {
    const ac = new AbortController();
    setWorkStatusError(false);
    async function check() {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const result = await api.get<{ enabled: unknown }>(`/work/status?_=${Date.now()}-${workStatusVersion}-${attempt}`, ac.signal);
          if (typeof result.enabled !== 'boolean') throw new Error('invalid_work_status');
          if (!ac.signal.aborted) setWorkEnabled(result.enabled);
          return;
        } catch {
          if (ac.signal.aborted) return;
          if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
      if (!ac.signal.aborted) { setWorkEnabled(false); setWorkStatusError(true); }
    }
    void check();
    return () => ac.abort();
  }, [workStatusVersion]);

  // First sign-in lands on the Getting Started checklist (replacing the old
  // OnboardingWizard modal). The legacy 'cce_onboarded' key marks existing
  // installs as already onboarded so nobody who has used the dashboard gets
  // redirected after the upgrade. The page itself sets the seen key.
  useEffect(() => {
    const seen =
      localStorage.getItem(GETTING_STARTED_SEEN_KEY) || localStorage.getItem('cce_onboarded');
    if (!seen && location !== '/getting-started') {
      setLocation('/getting-started');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Warm the GET cache for the most-visited tabs once the shell is idle, so a
  // first click on Agents/Sessions/Audit/Kill Switches paints instantly instead
  // of cold-fetching behind a skeleton. The last two entries are the Overview's
  // OWN unique reads (its other three are shared with the tabs above) — without
  // them, returning to the landing page was the one cold tab switch left, gated
  // on the slowest endpoint. Fire-and-forget: failures are ignored (the tab
  // will just fetch normally) and the 1.5s delay keeps the prefetch from
  // competing with the landing page's own requests.
  useEffect(() => {
    const t = setTimeout(() => {
      for (const path of [
        '/agents',
        '/sessions',
        '/kill-switches',
        '/audit?days=7',
        '/cost-today',
        '/usage/daily?agentId=all&days=7',
      ]) {
        api.get(path).catch(() => {});
      }
    }, 1500);
    return () => clearTimeout(t);
  }, []);

  const workFailure = (
    <ErrorState message="Could not check Work availability. Try again."
      onRetry={() => setWorkStatusVersion(v => v + 1)} />
  );

  return (
    <div class="min-h-screen bg-page">
      <a href="#main-content" class="skip-to-content">Skip to content</a>
      <Sidebar workEnabled={workEnabled} />
      <div
        class={`transition-all duration-normal ${collapsed ? 'lg:ml-[var(--sidebar-width-collapsed)]' : 'lg:ml-[var(--sidebar-width)]'}`}
      >
        <Header />
        <main id="main-content" data-jarvis-readable class="p-4 sm:p-6 lg:p-8 page-enter" role="main">
          <ErrorBoundary>
          {/* Chunk-load errors trigger lazyRoute's one-shot reload (deploy
              swapped the hashed chunks under an open session); only a repeat
              failure surfaces through the ErrorBoundary above. The fallback
              matches the RequireCapability "checking" state so tab switches
              don't flash a different layout. The TourOverlay and Jarvis
              spotlight poll for their targets, so a lazy page mounting a beat
              later is already handled. */}
          <Suspense fallback={<div class="text-body-sm text-muted py-16 text-center">Loading...</div>}>
          <Switch>
            {/* Wave 5 (granular RBAC): the 12 data tabs the old coarse
                dashboard:read umbrella exposed are now each gated on their own
                per-tab read capability. Every templated profile that held
                dashboard:read (viewer and up) ALSO holds all 12 per-tab viewer
                reads (src/lib/auth/permissions.ts VIEWER_CAPS), so templated
                behaviour is IDENTICAL — no principal loses a tab. The split only
                lets a CUSTOM profile grant a single tab. Each need= here MUST
                equal the route's cap in the Jarvis route-manifest (ROUTE_TABLE)
                and the matching Sidebar minCapability so nav and route never
                diverge. The env root/owner resolves to ALL_CAPABILITIES and
                passes every gate. The :param detail routes (/agents/:id,
                /chat/:agentId) inherit access from their parent tab and are
                intentionally left ungated here (a child of an already-granted
                tab). */}
            <Route path="/"><RequireCapability need="overview:read" label="Overview"><Overview /></RequireCapability></Route>
            <Route path="/agents"><RequireCapability need="agents:read" label="Agents"><Agents /></RequireCapability></Route>
            <Route path="/agents/:id" component={AgentDetail} />
            <Route path="/chat"><RequireCapability need="chat:read" label="Chat"><Chat /></RequireCapability></Route>
            <Route path="/chat/:agentId" component={Chat} />
            <Route path="/playground"><RequireCapability need="chat:read" label="Playground"><Playground /></RequireCapability></Route>
            <Route path="/sessions"><RequireCapability need="sessions:read" label="Sessions"><Sessions /></RequireCapability></Route>
            <Route path="/usage"><RequireCapability need="usage:read" label="Usage"><Usage /></RequireCapability></Route>
            {/* Cost dashboard ROUTE → cost:write (operator-tier). This PRESERVES
                the pre-Wave-4 baseline gate (RequireRole need="operator"): the
                /cost surface stays operator-or-stricter and is NOT widened to the
                analyst-tier cost:read. cost:write lives in operator/admin/owner,
                exactly the principals the operator role gated. The in-page cost-cap
                edit controls also gate on cost:write (see Cost.tsx). Gating the
                route on cost:read would let an analyst-tier principal reach a
                surface that previously required operator — a permissiveness
                regression — so we keep the operator-tier capability here. */}
            <Route path="/cost"><RequireCapability need="cost:write" label="Cost"><Cost /></RequireCapability></Route>
            <Route path="/audit"><RequireCapability need="audit:read" label="Audit Log"><AuditLog /></RequireCapability></Route>
            {/* Security CONTROL surfaces (mutations) → security:write. Old gate was
                admin; security:write is admin/owner-only, so the same principals
                pass — equivalent, never wider. */}
            <Route path="/kill-switches"><RequireCapability need="security:write" label="Kill Switches"><KillSwitches /></RequireCapability></Route>
            <Route path="/dlp"><RequireCapability need="security:write" label="DLP &amp; Exfil"><DLP /></RequireCapability></Route>
            <Route path="/panic"><RequireCapability need="security:write" label="Panic"><Panic /></RequireCapability></Route>
            <Route path="/rate-limits"><RequireCapability need="security:write" label="Rate Limits"><RateLimits /></RequireCapability></Route>
            {/* Security/posture READ surfaces → operator-tier read capabilities.
                The corrected taxonomy separates READ from the admin-only
                security:read (IAM) and security:write (mutations): posture-read
                is posture:read and integrations-read is integrations:read, both
                granted to operator + admin + owner. This RESTORES operator read
                access to the two surfaces (the pre-Wave-4 baseline was the
                operator role), without widening to viewer/analyst. The backend
                posture/integrations GET routes must accept the SAME capability
                (operator-or-stricter); see contractNotes for the cross-file
                follow-up that defines these caps in the templated profiles. */}
            <Route path="/security-posture"><RequireCapability need="posture:read" label="Security Posture"><SecurityPosture /></RequireCapability></Route>
            {/* Compliance gap analysis (SOC 2 + HIPAA) → compliance:read, an
                operator-tier READ that re-reads the same posture signals
                posture:read exposes. Matches the Sidebar minCapability so nav
                visibility and route access never diverge. */}
            <Route path="/compliance"><RequireCapability need="compliance:read" label="Compliance"><Compliance /></RequireCapability></Route>
            <Route path="/alerting"><RequireCapability need="security:write" label="Alerting"><Alerting /></RequireCapability></Route>
            <Route path="/integrations"><RequireCapability need="integrations:read" label="Integrations"><Integrations /></RequireCapability></Route>
            <Route path="/vectors"><RequireCapability need="vectors:read" label="Knowledge"><Vectors /></RequireCapability></Route>
            <Route path="/work"><RequireCapability need="work:read" label="Work">{workStatusError ? workFailure : <WorkInbox />}</RequireCapability></Route>
            <Route path="/work/cases"><RequireCapability need="work:read" label="Cases">{workStatusError ? workFailure : <WorkCases />}</RequireCapability></Route>
            <Route path="/work/cases/:caseId"><RequireCapability need="work:read" label="Case">{workStatusError ? workFailure : <WorkCaseDetail />}</RequireCapability></Route>
            <Route path="/work/approvals"><RequireCapability need="work:read" label="Approvals">{workStatusError ? workFailure : <WorkApprovals />}</RequireCapability></Route>
            <Route path="/work/approvals/:approvalId"><RequireCapability need="work:read" label="Approval">{workStatusError ? workFailure : <WorkApprovalDetail />}</RequireCapability></Route>
            <Route path="/missions">{workEnabled === null ? <div role="status"><span class="sr-only">Loading Work</span><div class="skeleton h-8 w-1/3 mb-3" /><div class="skeleton h-12 w-full" /></div> : workEnabled && hasCapability('work:read') ? <WorkRedirect /> : <RequireCapability need="missions:read" label="Missions"><Missions /></RequireCapability>}</Route>
            <Route path="/memories"><RequireCapability need="memories:read" label="Memories"><Memories /></RequireCapability></Route>
            <Route path="/hive"><RequireCapability need="hive:read" label="Hive Mind"><HiveMind /></RequireCapability></Route>
            <Route path="/scheduled"><RequireCapability need="scheduled:read" label="Scheduled"><ScheduledTasks /></RequireCapability></Route>
            <Route path="/warroom"><RequireCapability need="warroom:read" label="War Room"><WarRoom /></RequireCapability></Route>
            {/* The Members page is READABLE by members:read (operator + admin +
                owner) — the backend GET /members and GET /profiles accept
                members:read OR members:write. Mutations inside the page gate on
                members:write (see Members.tsx). Gating the route on members:read
                matches the backend's read authorization; the page itself stays
                read-only for a members:read principal. */}
            <Route path="/getting-started" component={GettingStarted} />
            <Route path="/seats"><RequireCapability need="seats:read" label="Seats"><Seats /></RequireCapability></Route>
            <Route path="/my-seat"><RequireCapability need="usage:self:read" label="My Seat"><MySeat /></RequireCapability></Route>
            <Route path="/members">
              <RequireCapability need="members:read" label="Team">
                <Members />
              </RequireCapability>
            </Route>
            <Route path="/settings" component={Settings} />
            {/* Jarvis gates itself via the fail-closed manifest; no capability gate. */}
            <Route path="/jarvis" component={Jarvis} />
            <Route component={NotFound} />
          </Switch>
          </Suspense>
          </ErrorBoundary>
        </main>
      </div>
      <ToastContainer />
      <JarvisWidget />
      <TourOverlay />
    </div>
  );
}

export function App() {
  return (
    <Router base="/dashboard">
      {/*
        Pre-auth routes. /accept and /verify are reached from a magic-link
        email BEFORE the user has a session, so they MUST render outside the
        AuthGate. Each stores the returned session token via the shared onLogin
        flow (setToken) and then redirects into the authenticated shell. Every
        other path falls through to AuthGate → AppShell.
      */}
      <Switch>
        <Route path="/accept">
          <AcceptInvite
            onLogin={(t: string, remember: boolean) => setToken(t, remember)}
          />
        </Route>
        <Route path="/verify">
          <VerifyLogin
            onLogin={(t: string, remember: boolean) => setToken(t, remember)}
          />
        </Route>
        <Route>
          <AuthGate>
            <AppShell />
          </AuthGate>
        </Route>
      </Switch>
    </Router>
  );
}
