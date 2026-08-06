import { useState, useEffect } from 'preact/hooks';
import { api, downloadFile } from '../lib/api';
import { toast } from '../components/Toast';
import { SkeletonTableRow } from '../components/Skeleton';
import { Select } from '../components/Select';
import { Pagination } from '../components/Pagination';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { EmptyAudit } from '../components/Icons';
import { RawJsonBlock, type RawJsonField } from '../components/RawJsonBlock';
import { InfoTooltip } from '../components/InfoTooltip';
import { DataMeta } from '../components/DataMeta';
import { hasDefinition } from '../lib/glossary';
import { useAgentNames } from '../lib/useAgentNames';

interface AuditRow {
  PK?: string;
  SK?: string;
  action?: string;
  agentId?: string;
  userId?: string;
  operatorLabel?: string;
  surface?: string;
  modelId?: string;
  costUsd?: number;
  latencyMs?: number;
  result?: string;
  detail?: Record<string, unknown>;
  [k: string]: unknown;
}

function formatActor(row: AuditRow): string {
  if (row.operatorLabel) return row.operatorLabel;
  if (row.userId?.startsWith('dashboard:')) return row.userId.slice(10, 26) + '...';
  if (row.userId) return row.userId;
  return '--';
}

function formatActorTooltip(row: AuditRow): string {
  if (row.operatorLabel && row.userId) return `${row.operatorLabel} (${row.userId.slice(0, 26)})`;
  if (row.userId) return row.userId;
  return '';
}

// Labeled fields surfaced in the expanded-row detail. Order matters; RawJsonBlock
// renders them top to bottom and falls back to "--" for missing values. The "raw
// JSON" toggle (built into RawJsonBlock) still shows the full untouched record.
const DETAIL_FIELDS: RawJsonField[] = [
  {
    key: 'action',
    label: 'Action',
    render: (v) => {
      const action = v == null ? '' : String(v);
      if (!action) return '--';
      return (
        <span class="inline-flex items-center gap-1.5">
          <Badge>{action}</Badge>
          {hasDefinition(action) && <InfoTooltip term={action} />}
        </span>
      );
    },
  },
  { key: 'ts', label: 'Time' }, // ISO -> local readable time via RawJsonBlock
  { key: 'userId', label: 'Actor' },
  { key: 'operatorLabel', label: 'Operator' },
  {
    key: 'surface',
    label: 'Surface',
    render: (v) => {
      const surface = v == null ? '' : String(v);
      if (!surface) return '--';
      return (
        <span class="inline-flex items-center gap-1.5">
          {surface}
          {hasDefinition(surface) && <InfoTooltip term={surface} />}
        </span>
      );
    },
  },
  { key: 'agentId', label: 'Agent' },
  { key: 'modelId', label: 'Model' },
  {
    key: 'costUsd',
    label: 'Cost',
    render: (v) => (typeof v === 'number' ? `$${v.toFixed(4)}` : '--'),
  },
  {
    key: 'latencyMs',
    label: 'Latency',
    render: (v) => (typeof v === 'number' ? `${v} ms` : '--'),
  },
  { key: 'result', label: 'Result' },
  { key: 'detail', label: 'Detail' },
];

const ACTION_FILTER_OPTIONS = [
  { value: '', label: 'All actions' },
  { value: 'agent_turn', label: 'Agent turn' },
  { value: 'kill_switch', label: 'Kill switch' },
  { value: 'tool_invoke', label: 'Tool invoke' },
  { value: 'memory_', label: 'Memory' },
  { value: 'data_purged', label: 'Data purge' },
  { value: 'agent_file', label: 'File edit' },
  { value: 'panic_', label: 'Panic' },
  { value: 'warroom_', label: 'War room' },
  { value: 'exfil_', label: 'DLP/Exfil' },
];

export function AuditLog() {
  const [rows, setRows] = useState<AuditRow[]>([]);
  // The backend's TRUE pre-cap count (GET /audit returns { count, rows }, where
  // rows is sliced to the most recent 200). count lets us be honest when the
  // window holds more events than the 200 we render.
  const [total, setTotal] = useState<number | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  // Distinct error state for the /audit fetch so a 403/500/network failure shows
  // ErrorState instead of the "No audit events" empty state. Cleared on each load.
  const [loadError, setLoadError] = useState(false);
  const [days, setDays] = useState(7);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [search, setSearch] = useState('');
  const [actionFilter, setActionFilter] = useState('');
  const { nameFor } = useAgentNames();

  function load() {
    setLoading(true);
    setLoadError(false);
    api.get<{ rows: AuditRow[]; count?: number }>(`/audit?days=${days}`)
      .then((d) => {
        setRows(d.rows);
        setTotal(d.count ?? null);
        setUpdatedAt(Date.now());
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); setPage(0); }, [days]);
  useEffect(() => {
    if (!autoRefresh) return;
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [autoRefresh, days]);

  const filtered = rows.filter((r) => {
    if (actionFilter && !String(r.action ?? '').includes(actionFilter)) return false;
    if (search) {
      const q = search.toLowerCase();
      const haystack = [
        r.action, r.agentId, r.userId, r.operatorLabel, r.surface,
        r.detail ? JSON.stringify(r.detail) : '',
      ].join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });

  const [exporting, setExporting] = useState(false);

  async function handleExport() {
    // The backend GET /audit/export only reads `days` (handler.ts:1217); it does
    // not accept the action/search filters, so the export respects the active
    // time window but not the in-page action/search filters. Surfacing those in
    // the export needs a backend change (see deferred), so we don't fake it here.
    // Routed through downloadFile so the bearer is read with getToken()
    // (sessionStorage-first) and a non-2xx is surfaced instead of being written
    // to disk as a .csv error body.
    setExporting(true);
    try {
      await downloadFile(
        `/audit/export?days=${days}&format=csv`,
        `audit-log-${new Date().toISOString().slice(0, 10)}.csv`,
      );
      toast('Audit log exported', 'success');
    } catch (e) {
      toast(`Export failed. ${(e as Error).message}`, 'error');
    } finally {
      setExporting(false);
    }
  }

  return (
    <div>
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 data-tour="audit-title" class="text-display-sm text-primary font-bold">Audit Log</h1>
          <p class="text-body-sm text-secondary mt-1">{filtered.length} events in last {days} day{days > 1 ? 's' : ''}</p>
          {!loading && !loadError && (
            <div class="mt-1">
              <DataMeta
                updatedAt={updatedAt ?? undefined}
                // The backend slices to the most recent 200; when the window
                // holds more, say so honestly against the true count.
                note={total != null && total > rows.length
                  ? `Showing the most recent ${rows.length.toLocaleString()} of ${total.toLocaleString()}`
                  : undefined}
              />
            </div>
          )}
        </div>
        <div data-tour="audit-controls" class="flex items-center gap-3">
          <label class="flex items-center gap-2 text-body-sm text-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh((e.target as HTMLInputElement).checked)}
              class="w-4 h-4 rounded border-border text-primary focus:ring-primary"
            />
            Auto-refresh
          </label>
          <Select
            value={String(days)}
            onChange={(v) => setDays(Number(v))}
            options={[
              { value: '1', label: 'Last 24 hours' },
              { value: '3', label: 'Last 3 days' },
              { value: '7', label: 'Last 7 days' },
            ]}
          />
          <Button variant="secondary" size="sm" onClick={handleExport} disabled={exporting}>
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.75" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" /></svg>
            {exporting ? 'Exporting...' : 'Export CSV'}
          </Button>
        </div>
      </div>

      <div data-tour="audit-filters" class="flex gap-3 mb-4">
        <input
          type="text"
          value={search}
          onInput={(e) => { setSearch((e.target as HTMLInputElement).value); setPage(0); }}
          placeholder="Search by actor, action, agent..."
          class="flex-1 px-3 py-2 bg-surface border border-border rounded-lg text-body-sm text-primary placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-accent"
        />
        <Select
          value={actionFilter}
          onChange={(v) => { setActionFilter(v); setPage(0); }}
          options={ACTION_FILTER_OPTIONS}
        />
      </div>

      <div data-tour="audit-table" class="bg-surface border border-border rounded-xl overflow-hidden">
        <div class="overflow-x-auto">
          <table class="w-full text-left">
            <thead>
              <tr class="border-b border-border bg-surface-elevated">
                <th class="px-4 py-3 text-overline text-muted uppercase tracking-wider font-semibold">Time</th>
                <th class="px-4 py-3 text-overline text-muted uppercase tracking-wider font-semibold">Actor</th>
                <th class="px-4 py-3 text-overline text-muted uppercase tracking-wider font-semibold">Action</th>
                <th class="px-4 py-3 text-overline text-muted uppercase tracking-wider font-semibold">Agent</th>
                <th class="px-4 py-3 text-overline text-muted uppercase tracking-wider font-semibold">Surface</th>
                <th class="px-4 py-3 text-overline text-muted uppercase tracking-wider font-semibold">Details</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border">
              {loading
                ? Array.from({ length: 8 }).map((_, i) => <SkeletonTableRow key={i} cols={6} />)
                : loadError
                ? null
                : filtered.slice(page * pageSize, (page + 1) * pageSize).map((r, i) => {
                    const idx = page * pageSize + i;
                    const ts = String(r.SK ?? '').replace(/^TS#/, '');
                    const expanded = expandedIdx === idx;
                    return (
                      <>
                        <tr
                          key={idx}
                          onClick={() => setExpandedIdx(expanded ? null : idx)}
                          class="cursor-pointer hover:bg-surface-hover transition-colors"
                        >
                          <td class="px-4 py-2.5 text-body-sm text-secondary font-mono whitespace-nowrap">{ts.slice(0, 19)}</td>
                          <td class="px-4 py-2.5 text-body-sm text-secondary" title={formatActorTooltip(r)}>{formatActor(r)}</td>
                          <td class="px-4 py-2.5">
                            <span class="inline-flex items-center gap-1.5">
                              <Badge variant={r.action?.includes('error') || r.result === 'error' ? 'danger' : r.action?.includes('kill') || r.action?.includes('blocked') ? 'warning' : 'default'}>
                                {r.action ?? '--'}
                              </Badge>
                              {r.action && hasDefinition(r.action) && (
                                <span onClick={(e) => e.stopPropagation()}>
                                  <InfoTooltip term={r.action} />
                                </span>
                              )}
                            </span>
                          </td>
                          <td class="px-4 py-2.5 text-body-sm text-secondary" title={r.agentId ?? undefined}>{r.agentId ? nameFor(r.agentId) : '--'}</td>
                          <td class="px-4 py-2.5 text-body-sm text-secondary">{r.surface ?? '--'}</td>
                          <td class="px-4 py-2.5 text-body-sm text-muted truncate max-w-[200px]">
                            {r.costUsd ? `$${Number(r.costUsd).toFixed(4)}` : r.detail ? Object.keys(r.detail).join(', ') : ''}
                          </td>
                        </tr>
                        {expanded && (
                          <tr key={`${idx}-detail`}>
                            <td colspan={6} class="px-4 py-4 bg-bg-sunken">
                              <RawJsonBlock title="Event" data={r} fields={DETAIL_FIELDS} />
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
            </tbody>
          </table>
        </div>
        {!loading && loadError && (
          <ErrorState
            title="Could not load audit log"
            message="The audit events failed to load. This is an error, not an empty log. Check your connection or permissions and try again."
            onRetry={load}
          />
        )}
        {!loading && !loadError && filtered.length === 0 && (
          <EmptyState icon={<EmptyAudit />} title="No audit events" description="Events will appear as actions are taken in the system." />
        )}
        {!loading && !loadError && filtered.length > 0 && (
          <Pagination page={page} pageSize={pageSize} total={filtered.length} onPageChange={setPage} onPageSizeChange={setPageSize} />
        )}
      </div>
    </div>
  );
}
