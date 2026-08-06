import { useState, useEffect, useCallback } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { api, type AgentsHealthResponse, type AgentHealth } from '../lib/api';
import { Skeleton } from '../components/Skeleton';
import { StatusDot } from '../components/StatusDot';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Sparkline } from '../components/Sparkline';
import { TldrBar } from '../components/TldrBar';
import { DataMeta } from '../components/DataMeta';
import { PowerCard } from '../components/PowerCard';
import { formatSessionId, formatRelativeTime } from '../lib/format';
import { hasCapability } from '../lib/auth';
import { useAgentNames } from '../lib/useAgentNames';

// Per-agent status -> StatusDot status. Matches the backend healthy|idle|
// degraded|error enum (no down/unknown — the backend never returns those).
const HEALTH_DOT: Record<AgentHealth['status'], 'healthy' | 'idle' | 'degraded' | 'error'> = {
  healthy: 'healthy',
  idle: 'idle',
  degraded: 'degraded',
  error: 'error',
};

const HEALTH_BADGE: Record<AgentHealth['status'], { variant: 'success' | 'warning' | 'danger' | 'muted'; label: string }> = {
  healthy: { variant: 'success', label: 'Healthy' },
  idle: { variant: 'muted', label: 'Idle' },
  degraded: { variant: 'warning', label: 'Degraded' },
  error: { variant: 'danger', label: 'Error' },
};

// Overall rollup status -> pill dot color.
const OVERALL_DOT: Record<AgentsHealthResponse['overall'], string> = {
  healthy: 'bg-success',
  idle: 'bg-gray-300 dark:bg-gray-600',
  degraded: 'bg-warning',
  error: 'bg-danger',
};

interface AgentSummary {
  id: string;
  displayName: string;
  status: string;
  model: string | null;
}

interface Session {
  agentId: string;
  chatId: string;
  updatedAt: number;
  surface?: string | null;
  firstMessage?: string | null;
}

interface KillSwitch {
  name: string;
  active: boolean;
  reason?: string;
}

interface DailyData {
  date: string;
  costUsd: number;
  calls: number;
}

export function Overview() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [killSwitches, setKillSwitches] = useState<KillSwitch[]>([]);
  const [costToday, setCostToday] = useState<number | null>(null);
  const [dailyData, setDailyData] = useState<DailyData[]>([]);
  const [health, setHealth] = useState<AgentsHealthResponse | null>(null);
  const { nameFor } = useAgentNames();
  const [loading, setLoading] = useState(true);
  // Freshness stamp for the cached stat cards (15s client cache + server cost
  // cache), set once the core loads settle. Lets a reader tell how fresh the
  // numbers are and refresh on demand, since there is no auto-refresh here.
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  const load = useCallback((signal: AbortSignal) => {
    setLoading(true);

    // Wave 5 RBAC: each summary card fetches INDEPENDENTLY and fails SOFT. A
    // profile that lacks one card's capability (a 403 on that endpoint) sees the
    // Overview with that single card hidden/empty instead of a broken page; the
    // templated viewer/operator/admin hold every cap these endpoints need, so
    // they get the full Overview. We use Promise.allSettled over the per-card
    // loads (instead of Promise.all, which would reject the whole page if any one
    // endpoint 403s) and only flip `loading` off once they all settle.
    //
    // failSoft swallows a 403 (the backend's capability denial — `{ error:
    // 'forbidden' }`, so err.message === 'forbidden') so the card is hidden on
    // purpose. ANY OTHER failure (network, 5xx) is logged, not hidden silently,
    // so a real backend problem is still visible in the console. An aborted
    // request (unmount) is ignored — it is not a real error.
    const failSoft = (card: string, err: unknown) => {
      if (signal.aborted) return;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg === 'forbidden' || msg === 'unauthorized') return; // 403 → hide card
      console.error(`Overview card "${card}" failed to load:`, err);
    };

    const loads = [
      api
        .get<{ agents: AgentSummary[] }>('/agents', signal)
        .then((a) => setAgents(a.agents))
        .catch((e) => failSoft('agents', e)),
      api
        .get<{ sessions: Session[] }>('/sessions', signal)
        .then((s) => setSessions(s.sessions))
        .catch((e) => failSoft('sessions', e)),
      api
        .get<{ switches: KillSwitch[] }>('/kill-switches', signal)
        .then((k) => setKillSwitches(k.switches))
        .catch((e) => failSoft('kill-switches', e)),
      api
        .get<{ costUsd: number }>('/cost-today', signal)
        .then((c) => setCostToday(c.costUsd))
        .catch((e) => failSoft('cost-today', e)),
      api
        .get<{ days: DailyData[] }>('/usage/daily?agentId=all&days=7', signal)
        .then((d) => setDailyData(d.days ?? []))
        .catch((e) => failSoft('usage-daily', e)),
    ];

    Promise.allSettled(loads).finally(() => {
      if (!signal.aborted) {
        setUpdatedAt(Date.now());
        setLoading(false);
      }
    });

    // Health rollup loads independently so it never blocks the core stats and
    // fails soft if the profile lacks access or the backend degrades.
    api
      .agentsHealth(signal)
      .then((h) => setHealth(h))
      .catch((e) => failSoft('agent-health', e));
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    load(ac.signal);
    return () => ac.abort();
  }, [load]);

  const activeAgents = agents.filter((a) => a.status === 'active').length;
  const trippedSwitches = killSwitches.filter((k) => k.active).length;
  const now = Math.floor(Date.now() / 1000);
  const todaySessions = sessions.filter((s) => now - s.updatedAt < 86400).length;

  const spendValues = dailyData.map((d) => d.costUsd);
  const yesterday = dailyData.length >= 2 ? dailyData[dailyData.length - 2].costUsd : 0;
  const today = costToday ?? 0;
  const delta = yesterday > 0 ? ((today - yesterday) / yesterday) * 100 : 0;
  const deltaStr = delta > 0 ? `+${delta.toFixed(0)}%` : delta < 0 ? `${delta.toFixed(0)}%` : '';

  const stats = [
    { label: "Today's Spend", value: costToday !== null ? `$${costToday.toFixed(2)}` : '--', color: 'text-primary', extra: deltaStr },
    { label: 'Active Agents', value: String(activeAgents), color: 'text-success' },
    {
      label: 'Sessions (24h)',
      value: String(todaySessions),
      color: 'text-primary',
      // Spend with zero chat sessions = the activity came from direct API
      // calls, which don't create sessions. Say that instead of "0 (via API)".
      sub: todaySessions === 0 && today > 0 ? "today's spend was direct API use" : undefined,
    },
    { label: 'Kill Switches', value: trippedSwitches > 0 ? `${trippedSwitches} tripped` : 'All clear', color: trippedSwitches > 0 ? 'text-danger' : 'text-success' },
  ];

  // Jarvis screen-awareness (H2): expose a compact summary of what is actually on
  // screen so read_view returns the live Overview numbers, not a blanket DOM scrape.
  // Rebuilt as the independent loads (core stats, then health) resolve.
  useEffect(() => {
    const w = window as unknown as { getJarvisSummary?: () => string };
    w.getJarvisSummary = () => {
      const parts: string[] = ['Page: Overview (system health at a glance).'];
      if (loading) return parts.concat('Stats are still loading.').join(' ');
      parts.push(
        `Today's spend ${costToday !== null ? '$' + costToday.toFixed(2) : 'unknown'}${deltaStr ? ` (${deltaStr} vs yesterday)` : ''}.`,
        `${activeAgents} of ${agents.length} agents active.`,
        `${todaySessions} session${todaySessions === 1 ? '' : 's'} in the last 24 hours.`,
        trippedSwitches > 0
          ? `${trippedSwitches} kill switch${trippedSwitches > 1 ? 'es' : ''} tripped: ${killSwitches.filter((k) => k.active).map((k) => k.name).join(', ')}.`
          : 'All kill switches clear.',
      );
      if (health) {
        const c = health.counts;
        parts.push(
          `Overall health ${health.overall ?? 'idle'}: ${c?.healthy ?? 0} healthy, ${c?.degraded ?? 0} degraded, ${c?.error ?? 0} in error, ${c?.idle ?? 0} idle.`,
        );
      }
      if (sessions.length) {
        const recent = sessions.slice(0, 3).map((sn) => sn.agentId).join(', ');
        parts.push(`Most recent sessions on agents: ${recent}.`);
      }
      return parts.join(' ');
    };
    return () => {
      const ww = window as unknown as { getJarvisSummary?: () => string };
      if (ww.getJarvisSummary) delete ww.getJarvisSummary;
    };
  }, [loading, costToday, deltaStr, activeAgents, agents.length, todaySessions, trippedSwitches, killSwitches, health, sessions]);

  return (
    <div>
      <TldrBar
        tab="Overview"
        ready={!loading}
        data={{
          todaySpendUsd: costToday,
          spendDeltaPctVsYesterday: Math.round(delta),
          activeAgents,
          totalAgents: agents.length,
          sessions24h: todaySessions,
          trippedKillSwitches: trippedSwitches,
          health: health?.overall,
          healthCounts: health?.counts,
        }}
      />
      <div class="mb-8" data-tour="overview-title">
        <h1 class="text-display-sm text-primary font-bold">Overview</h1>
        <p class="text-body-sm text-secondary mt-1">System health at a glance</p>
        {!loading && (
          <div class="mt-1">
            <DataMeta
              updatedAt={updatedAt ?? undefined}
              onRefresh={() => { const ac = new AbortController(); load(ac.signal); }}
            />
          </div>
        )}
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8" data-tour="overview-stats">
        {loading
          ? Array.from({ length: 4 }).map((_, i) => (
              <div key={i} class="bg-surface border border-border rounded-xl p-5">
                <Skeleton height="12px" width="60%" class="mb-3" />
                <Skeleton height="28px" width="40%" />
              </div>
            ))
          : stats.map((s, idx) => (
              <div key={s.label} class="bg-surface border border-border rounded-xl p-5 hover:border-border-strong transition-colors">
                <p class="text-caption text-muted uppercase tracking-wider mb-1">{s.label}</p>
                <div class="flex items-end gap-2">
                  <p class={`text-display-sm font-bold ${s.color}`}>{s.value}</p>
                  {s.extra && (
                    <span class={`text-xs font-medium mb-1 ${delta >= 0 ? 'text-danger' : 'text-success'}`}>{s.extra}</span>
                  )}
                </div>
                {s.sub && <p class="text-xs text-muted mt-1">{s.sub}</p>}
                {idx === 0 && spendValues.length > 1 && (
                  <div class="mt-2">
                    <Sparkline data={spendValues} color="var(--color-accent)" />
                  </div>
                )}
              </div>
            ))}
      </div>

      {health && (
        <div class="flex flex-wrap items-center gap-2 mb-8">
          <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-surface border border-border text-caption">
            <span class={`h-2 w-2 rounded-full ${OVERALL_DOT[health.overall ?? 'idle']}`} aria-hidden="true" />
            <span class="text-secondary">
              {(() => {
                const c = health.counts;
                const errorN = c?.error ?? 0;
                const degradedN = c?.degraded ?? 0;
                const healthyN = c?.healthy ?? 0;
                const idleN = c?.idle ?? 0;
                if (errorN > 0) return `${errorN} agent${errorN > 1 ? 's' : ''} in error`;
                if (degradedN > 0) return `${degradedN} agent${degradedN > 1 ? 's' : ''} degraded`;
                if (healthyN > 0) return `${healthyN} agent${healthyN === 1 ? '' : 's'} healthy`;
                if (idleN > 0) return `${idleN} agent${idleN === 1 ? '' : 's'} idle`;
                return 'No agents reporting';
              })()}
            </span>
          </span>
          <span class="text-caption text-muted">
            {(health.totalMessages24h ?? 0).toLocaleString()} msg / {(health.totalErrors24h ?? 0).toLocaleString()} err (24h)
          </span>
          {hasCapability('security:write') && (
            <Link href="/alerting" class="text-caption text-primary hover:underline ml-1">Configure alerts</Link>
          )}
        </div>
      )}

      <div class="flex gap-3 mb-8" data-tour="overview-quick-actions">
        <Link href="/agents">
          <Button variant="primary" size="sm">
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
            New Agent
          </Button>
        </Link>
        <Link href="/warroom">
          <Button variant="secondary" size="sm">Open War Room</Button>
        </Link>
        <Link href="/audit">
          <Button variant="secondary" size="sm">View Audit Log</Button>
        </Link>
      </div>

      <PowerCard />

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div class="bg-surface border border-border rounded-xl" data-tour="overview-agents-card">
          <div class="px-5 py-4 border-b border-border flex items-center justify-between">
            <h2 class="text-heading-sm font-semibold">Agents</h2>
            <Link href="/agents" class="text-caption text-primary hover:underline">View all</Link>
          </div>
          <div class="divide-y divide-border">
            {loading
              ? Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} class="px-5 py-3 flex items-center gap-3">
                    <Skeleton width="32px" height="32px" rounded />
                    <div class="flex-1 space-y-1.5">
                      <Skeleton height="14px" width="40%" />
                      <Skeleton height="10px" width="25%" />
                    </div>
                  </div>
                ))
              : agents.slice(0, 6).map((a) => (
                  <Link key={a.id} href={`/agents/${a.id}`} class="block px-5 py-3 flex items-center gap-3 hover:bg-surface-hover transition-colors">
                    <div class="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                      <svg class="w-4 h-4 text-primary" fill="none" stroke="currentColor" stroke-width="1.75" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8" /><rect x="4" y="8" width="16" height="12" rx="2" /><path d="M2 14h2" /><path d="M20 14h2" /><path d="M15 13v2" /><path d="M9 13v2" /></svg>
                    </div>
                    <div class="flex-1 min-w-0">
                      <p class="text-body-sm font-medium text-primary truncate">{a.displayName}</p>
                      <p class="text-overline text-muted font-mono">{a.id}</p>
                    </div>
                    <StatusDot status={a.status === 'active' ? 'active' : 'inactive'} />
                  </Link>
                ))}
          </div>
        </div>

        <div class="bg-surface border border-border rounded-xl" data-tour="overview-sessions-card">
          <div class="px-5 py-4 border-b border-border flex items-center justify-between">
            <h2 class="text-heading-sm font-semibold">Recent Sessions</h2>
            <Link href="/sessions" class="text-caption text-primary hover:underline">View all</Link>
          </div>
          <div class="divide-y divide-border">
            {loading
              ? Array.from({ length: 5 }).map((_, i) => (
                  <div key={i} class="px-5 py-3 space-y-1.5">
                    <Skeleton height="14px" width="60%" />
                    <Skeleton height="10px" width="30%" />
                  </div>
                ))
              : sessions.slice(0, 8).map((s) => (
                  <div key={`${s.agentId}-${s.chatId}`} class="px-5 py-3 hover:bg-surface-hover transition-colors">
                    <div class="flex items-center justify-between">
                      <div class="min-w-0">
                        <p class="text-body-sm font-medium text-primary truncate" title={s.chatId}>
                          {s.firstMessage ? s.firstMessage.slice(0, 60) + (s.firstMessage.length > 60 ? '...' : '') : formatSessionId(s.chatId, s.surface)}
                        </p>
                        <p class="text-overline text-muted" title={s.agentId}>{nameFor(s.agentId)}</p>
                      </div>
                      <span class="text-caption text-muted shrink-0">
                        {s.updatedAt ? formatRelativeTime(s.updatedAt) : '--'}
                      </span>
                    </div>
                  </div>
                ))}
            {!loading && sessions.length === 0 && (
              <div class="px-5 py-8 text-center text-body-sm text-muted">No sessions yet</div>
            )}
          </div>
        </div>
      </div>

      {health && (health.agents?.length ?? 0) > 0 && (
        <div class="mt-6 bg-surface border border-border rounded-xl">
          <div class="px-5 py-4 border-b border-border flex items-center justify-between">
            <h2 class="text-heading-sm font-semibold">Agent Health</h2>
            {hasCapability('integrations:read') && (
              <Link href="/integrations" class="text-caption text-primary hover:underline">Integrations</Link>
            )}
          </div>
          <div class="divide-y divide-border">
            {(health.agents ?? []).map((a) => {
              const badge = HEALTH_BADGE[a?.status] ?? HEALTH_BADGE.idle;
              return (
                <div key={a?.agentId} class="px-5 py-3 flex items-center gap-3">
                  <StatusDot status={HEALTH_DOT[a?.status] ?? 'idle'} />
                  <div class="flex-1 min-w-0">
                    <p class="text-body-sm font-medium text-primary truncate" title={a?.agentId ?? undefined}>{a?.agentId ? nameFor(a.agentId) : 'unknown'}</p>
                    <p class="text-overline text-muted">
                      {(a?.messagesLast24h ?? 0).toLocaleString()} msg · {(a?.errorsLast24h ?? 0).toLocaleString()} err · {Math.round(a?.avgLatencyMs ?? 0)}ms avg
                    </p>
                  </div>
                  <Badge variant={badge.variant}>{badge.label}</Badge>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {trippedSwitches > 0 && (
        <div class="mt-6 bg-danger/10 border border-danger/20 rounded-xl p-5">
          <div class="flex items-center gap-3">
            <svg class="w-6 h-6 text-danger shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><line x1="8" y1="11" x2="16" y2="11" /></svg>
            <div>
              <h3 class="text-heading-sm font-semibold text-danger">{trippedSwitches} Kill Switch{trippedSwitches > 1 ? 'es' : ''} Active</h3>
              <p class="text-body-sm text-secondary mt-1">
                {killSwitches.filter((k) => k.active).map((k) => k.name).join(', ')}
              </p>
            </div>
            {hasCapability('security:write') && (
              <Link href="/kill-switches" class="ml-auto">
                <Button variant="danger" size="sm">Manage</Button>
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
