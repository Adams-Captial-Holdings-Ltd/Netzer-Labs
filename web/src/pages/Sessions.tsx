import { useState, useEffect } from 'preact/hooks';
import { api, downloadFile } from '../lib/api';
import { Skeleton, SkeletonTableRow } from '../components/Skeleton';
import { Select } from '../components/Select';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { EmptySessions } from '../components/Icons';
import { Badge } from '../components/Badge';
import { Pagination } from '../components/Pagination';
import { TldrBar } from '../components/TldrBar';
import { DataMeta } from '../components/DataMeta';
import { toast } from '../components/Toast';
import { formatSessionId, formatRelativeTime, formatDuration, formatModelName } from '../lib/format';
import { useAgentNames } from '../lib/useAgentNames';

// The backend (GET /sessions) caps the cross-agent list at this many rows and
// returns NO true total, so the page can only honestly say "first N" once the
// cap is hit. Keep this in sync with handler.ts rows.slice(0, 50).
const SESSIONS_CAP = 50;

interface Session {
  agentId: string;
  chatId: string;
  updatedAt: number;
  modelOverride: string | null;
  messageCount: number | null;
  firstMessage: string | null;
  createdAt: number | null;
  surface: string | null;
  userId: string | null;
}

interface Turn { role: string; text: string; ts: number }

export function Sessions() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  // Distinct error state for the LIST fetch (separate from turnsError, which
  // covers the transcript). When set, the page shows ErrorState instead of the
  // empty state so a 403/500/network failure is not mistaken for "no sessions".
  const [loadError, setLoadError] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [turnsLoading, setTurnsLoading] = useState(false);
  const [turnsError, setTurnsError] = useState(false);
  const [filterAgent, setFilterAgent] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const { nameFor } = useAgentNames();

  function loadSessions(signal?: AbortSignal) {
    setLoading(true);
    setLoadError(false);
    api.get<{ sessions: Session[] }>('/sessions', signal)
      .then((d) => { setSessions(d.sessions); setUpdatedAt(Date.now()); })
      .catch((err) => {
        if ((err as Error)?.name === 'AbortError') return;
        setLoadError(true);
      })
      .finally(() => {
        if (!signal?.aborted) setLoading(false);
      });
  }

  useEffect(() => {
    const ac = new AbortController();
    loadSessions(ac.signal);
    return () => ac.abort();
  }, []);

  async function handleExport() {
    // Routed through downloadFile so the bearer comes from getToken() and a
    // 401/403 body is never written to disk as a .csv. /sessions/export takes no
    // params; it returns the full sessions table as CSV.
    const today = new Date().toISOString().slice(0, 10);
    setExporting(true);
    try {
      await downloadFile('/sessions/export', `sessions-${today}.csv`);
      toast('Export ready', 'success');
    } catch (err) {
      toast(`Export failed. ${err instanceof Error ? err.message : 'unknown error'}`, 'error');
    } finally {
      setExporting(false);
    }
  }

  async function toggleExpand(s: Session) {
    const key = `${s.agentId}:${s.chatId}`;
    if (expandedId === key) {
      setExpandedId(null);
      return;
    }
    setExpandedId(key);
    setTurnsLoading(true);
    setTurnsError(false);
    try {
      // /sessions/transcript returns the real turn ARRAY. (The old /export route
      // returns session.turns as a COUNT, which is why this panel was always empty.)
      const data = await api.get<{ turns?: Turn[] }>(`/sessions/transcript?agentId=${encodeURIComponent(s.agentId)}&chatId=${encodeURIComponent(s.chatId)}`);
      setTurns(data.turns ?? []);
    } catch {
      setTurns([]);
      setTurnsError(true);
    }
    setTurnsLoading(false);
  }

  const uniqueAgents = [...new Set(sessions.map((s) => s.agentId))];
  const filtered = filterAgent ? sessions.filter((s) => s.agentId === filterAgent) : sessions;
  const paginated = filtered.slice(page * pageSize, (page + 1) * pageSize);

  function surfaceBadge(surface: string | null) {
    if (!surface) return null;
    const variant = surface === 'telegram' ? 'info' : surface === 'slack' ? 'warning' : 'default';
    return <Badge variant={variant}>{surface.charAt(0).toUpperCase() + surface.slice(1)}</Badge>;
  }

  return (
    <div>
      <TldrBar
        tab="Sessions"
        ready={!loading}
        data={{
          total: sessions.length,
          agents: uniqueAgents,
          recent: sessions.slice(0, 12).map((s) => ({
            agent: s.agentId,
            surface: s.surface,
            messages: s.messageCount,
            updatedAt: s.updatedAt,
          })),
        }}
      />
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 data-tour="sessions-title" class="text-display-sm text-primary font-bold">Sessions</h1>
          <p class="text-body-sm text-secondary mt-1">{sessions.length} conversations</p>
          {!loading && !loadError && (
            <div class="mt-1">
              <DataMeta
                updatedAt={updatedAt ?? undefined}
                // No true total from the backend; the list is capped server-side,
                // so be honest with "first N" only once the cap is hit.
                note={sessions.length >= SESSIONS_CAP ? `Showing first ${SESSIONS_CAP}` : undefined}
                onRefresh={() => loadSessions()}
              />
            </div>
          )}
        </div>
        <div data-tour="sessions-controls" class="flex gap-3">
          <Select
            value={filterAgent}
            onChange={setFilterAgent}
            options={[{ value: '', label: 'All agents' }, ...uniqueAgents.map((a) => ({ value: a, label: nameFor(a) }))]}
          />
          <Button variant="secondary" disabled={exporting} onClick={handleExport}>
            Download CSV
          </Button>
        </div>
      </div>

      <div data-tour="sessions-table" class="bg-surface border border-border rounded-xl overflow-hidden">
        <div class="overflow-x-auto"><table class="w-full text-left">
          <thead>
            <tr class="border-b border-border bg-surface-elevated">
              <th class="px-4 py-3 text-overline text-muted uppercase tracking-wider font-semibold">Preview</th>
              <th class="px-4 py-3 text-overline text-muted uppercase tracking-wider font-semibold">Channel</th>
              <th class="px-4 py-3 text-overline text-muted uppercase tracking-wider font-semibold">Agent</th>
              <th class="px-4 py-3 text-overline text-muted uppercase tracking-wider font-semibold">Messages</th>
              <th class="px-4 py-3 text-overline text-muted uppercase tracking-wider font-semibold">Duration</th>
              <th class="px-4 py-3 text-overline text-muted uppercase tracking-wider font-semibold">Last Active</th>
              <th class="px-4 py-3 text-overline text-muted uppercase tracking-wider font-semibold">Model</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border">
            {loading
              ? Array.from({ length: 5 }).map((_, i) => <SkeletonTableRow key={i} cols={7} />)
              : loadError
              ? null
              : paginated.map((s) => {
                  const key = `${s.agentId}:${s.chatId}`;
                  const expanded = expandedId === key;
                  return (
                    <>
                      <tr
                        key={key}
                        onClick={() => toggleExpand(s)}
                        class="cursor-pointer hover:bg-surface-hover transition-colors"
                      >
                        <td class="px-4 py-3 text-body-sm text-primary truncate max-w-[240px]" title={s.chatId}>
                          {s.firstMessage ? s.firstMessage.slice(0, 80) + (s.firstMessage.length > 80 ? '...' : '') : formatSessionId(s.chatId, s.surface)}
                        </td>
                        <td class="px-4 py-3">{surfaceBadge(s.surface)}</td>
                        <td class="px-4 py-3 text-body-sm font-medium text-primary" title={s.agentId}>{nameFor(s.agentId)}</td>
                        <td class="px-4 py-3 text-body-sm text-secondary">{s.messageCount ?? '--'}</td>
                        <td class="px-4 py-3 text-body-sm text-secondary">
                          {s.createdAt && s.updatedAt ? formatDuration(s.createdAt, s.updatedAt) : '--'}
                        </td>
                        <td class="px-4 py-3 text-body-sm text-secondary">
                          {s.updatedAt ? formatRelativeTime(s.updatedAt) : '--'}
                        </td>
                        <td class="px-4 py-3">
                          {s.modelOverride
                            ? <Badge variant="info">{formatModelName(s.modelOverride)}</Badge>
                            : <span class="text-body-sm text-muted">default</span>}
                        </td>
                      </tr>
                      {expanded && (
                        <tr key={`${key}-detail`}>
                          <td colspan={7} class="px-4 py-4 bg-bg-sunken">
                            {turnsLoading ? (
                              <div class="space-y-2">
                                <Skeleton height="40px" />
                                <Skeleton height="40px" />
                              </div>
                            ) : turnsError ? (
                              <p class="text-body-sm text-danger text-center py-4">Could not load transcript. Try again.</p>
                            ) : turns.length === 0 ? (
                              <p class="text-body-sm text-muted text-center py-4">No turns recorded</p>
                            ) : (
                              <div class="space-y-3 max-h-96 overflow-y-auto">
                                {turns.map((t, i) => (
                                  <div key={i} class="flex gap-3">
                                    <Badge variant={t.role === 'user' ? 'info' : 'success'}>{t.role}</Badge>
                                    <pre class="text-body-sm text-primary flex-1 whitespace-pre-wrap font-sans break-words">{t.text}</pre>
                                  </div>
                                ))}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
          </tbody>
        </table></div>
        {!loading && loadError && (
          <ErrorState
            title="Could not load sessions"
            message="The sessions list failed to load. This is an error, not an empty result. Check your connection or permissions and try again."
            onRetry={() => loadSessions()}
          />
        )}
        {!loading && !loadError && filtered.length === 0 && (
          <EmptyState icon={<EmptySessions />} title="No sessions" description="Conversations will appear here when agents are used." />
        )}
        {!loading && !loadError && filtered.length > 0 && (
          <Pagination
            page={page}
            pageSize={pageSize}
            total={filtered.length}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
        )}
      </div>
    </div>
  );
}
