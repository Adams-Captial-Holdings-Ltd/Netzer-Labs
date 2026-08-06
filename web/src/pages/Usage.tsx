import { useState, useEffect } from 'preact/hooks';
import { api, downloadFile, type CostCap } from '../lib/api';
import { Skeleton } from '../components/Skeleton';
import { ErrorState } from '../components/ErrorState';
import { Select } from '../components/Select';
import { Button } from '../components/Button';
import { Pagination } from '../components/Pagination';
import { BarChart } from '../components/BarChart';
import { TldrBar } from '../components/TldrBar';
import { toast } from '../components/Toast';
import { formatModelName } from '../lib/format';

interface UsageRow {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  model?: string;
  SK?: string;
}

interface UsageData {
  days: number;
  agentId: string;
  totals: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
    cacheWriteInputTokens: number;
    costUsd: number;
    calls: number;
  };
  rows: UsageRow[];
  // True only if the backend hit its very high scan guard (an extreme volume),
  // meaning the totals are a lower bound rather than complete.
  truncated?: boolean;
}

interface AgentSummary { id: string; displayName: string }
interface DailyData { date: string; costUsd: number; calls: number }

export function Usage() {
  const [data, setData] = useState<UsageData | null>(null);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [dailyData, setDailyData] = useState<DailyData[]>([]);
  const [agentId, setAgentId] = useState('main');
  const [days, setDays] = useState(7);
  const [loading, setLoading] = useState(true);
  // Distinct error state for the metrics fetch so a 403/500/network failure
  // shows ErrorState instead of four "--" cards that look like genuinely-zero
  // usage. Cleared at the start of every load.
  const [loadError, setLoadError] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [costCap, setCostCap] = useState<CostCap | null>(null);
  const [costToday, setCostToday] = useState<number>(0);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    api.get<{ agents: AgentSummary[] }>('/agents').then((d) => setAgents(d.agents)).catch(() => {});
    // Effective daily cap and today's spend for the cap-vs-projection callout.
    // Independent of the per-agent usage query so a failure never blanks it.
    api.costCap.get().then(setCostCap).catch(() => {});
    api.get<{ costUsd: number }>('/cost-today').then((d) => setCostToday(d.costUsd)).catch(() => {});
  }, []);

  function loadUsage(signal?: AbortSignal) {
    setLoading(true);
    setLoadError(false);
    setPage(0);
    Promise.all([
      api.get<UsageData>(`/usage?agentId=${agentId}&days=${days}`, signal),
      api.get<{ days: DailyData[] }>(`/usage/daily?agentId=${agentId}&days=${days}`, signal),
    ]).then(([u, d]) => {
      setData(u);
      setDailyData(d.days ?? []);
    }).catch((err) => {
      if ((err as Error)?.name === 'AbortError') return;
      setLoadError(true);
    }).finally(() => {
      if (!signal?.aborted) setLoading(false);
    });
  }

  useEffect(() => {
    const ac = new AbortController();
    loadUsage(ac.signal);
    return () => ac.abort();
  }, [agentId, days]);

  async function handleExport() {
    // Routed through downloadFile so the bearer comes from getToken() and a
    // 401/403 body is never written to disk as a .csv. The /usage/export route
    // now handles the cross-fleet "All Agents" mode server-side (it aggregates
    // across every usage partition), so 'all' passes straight through instead of
    // falling back to a single 'main' partition that would emit a partial file.
    const exportAgent = agentId;
    const today = new Date().toISOString().slice(0, 10);
    setExporting(true);
    try {
      await downloadFile(
        `/usage/export?agentId=${encodeURIComponent(exportAgent)}&days=${days}`,
        `usage-${exportAgent}-${today}.csv`,
      );
      toast('Export ready', 'success');
    } catch (err) {
      toast(`Export failed. ${err instanceof Error ? err.message : 'unknown error'}`, 'error');
    } finally {
      setExporting(false);
    }
  }

  const t = data?.totals;
  const avgCostPerSession = t && t.calls > 0 ? t.costUsd / t.calls : 0;
  const projectedMonthly = t ? (t.costUsd / days) * 30 : 0;

  const cap = costCap?.dailyCapUsd ?? 0;
  const capPct = cap > 0 ? Math.min(100, Math.round((costToday / cap) * 100)) : 0;
  const overCap = cap > 0 && costToday >= cap;

  const stats = [
    { label: 'Total Spend', value: t ? `$${t.costUsd.toFixed(2)}` : '--' },
    { label: 'Input Tokens', value: t ? t.inputTokens.toLocaleString() : '--' },
    { label: 'Output Tokens', value: t ? t.outputTokens.toLocaleString() : '--' },
    { label: 'Avg Cost/Call', value: t ? `$${avgCostPerSession.toFixed(4)}` : '--' },
  ];

  return (
    <div>
      <TldrBar
        tab="Usage & Billing"
        ready={!loading && !!t}
        data={{
          days,
          agentId,
          totalSpendUsd: t?.costUsd,
          inputTokens: t?.inputTokens,
          outputTokens: t?.outputTokens,
          calls: t?.calls,
          projectedMonthlyUsd: projectedMonthly,
          todayUsd: costToday,
          dailyCapUsd: cap,
          capPctUsed: capPct,
        }}
      />
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 data-tour="usage-title" class="text-display-sm text-primary font-bold">Usage & Billing</h1>
          <p class="text-body-sm text-secondary mt-1">Token usage and cost tracking</p>
        </div>
        <div data-tour="usage-controls" class="flex gap-3">
          <Select
            value={agentId}
            onChange={setAgentId}
            options={[
              { value: 'all', label: 'All Agents' },
              ...agents.map((a) => ({ value: a.id, label: a.displayName })),
            ]}
          />
          <Select
            value={String(days)}
            onChange={(v) => setDays(Number(v))}
            options={[
              { value: '1', label: 'Today' },
              { value: '7', label: 'Last 7 days' },
              { value: '14', label: 'Last 14 days' },
              { value: '30', label: 'Last 30 days' },
            ]}
          />
          <Button variant="secondary" disabled={exporting} onClick={handleExport}>
            Download CSV
          </Button>
        </div>
      </div>

      {!loading && loadError ? (
        <ErrorState
          title="Could not load usage"
          message="The usage metrics failed to load. This is an error, not zero usage. Check your connection or permissions and try again."
          onRetry={() => loadUsage()}
          class="mb-8"
        />
      ) : (
        <div data-tour="usage-stats" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
          {loading
            ? Array.from({ length: 4 }).map((_, i) => (
                <div key={i} class="bg-surface border border-border rounded-xl p-5">
                  <Skeleton height="12px" width="60%" class="mb-3" />
                  <Skeleton height="28px" width="40%" />
                </div>
              ))
            : stats.map((s) => (
                <div key={s.label} class="bg-surface border border-border rounded-xl p-5">
                  <p class="text-caption text-muted uppercase tracking-wider mb-1">{s.label}</p>
                  <p class="text-heading-lg font-bold text-primary">{s.value}</p>
                </div>
              ))}
        </div>
      )}
      {!loading && !loadError && data?.truncated && (
        <p class="text-caption text-warning -mt-4 mb-8">
          These totals are a lower bound. The usage volume for this window exceeded the scan limit, so figures and the monthly projection may understate actual spend.
        </p>
      )}

      {costCap && (
        <div data-tour="usage-daily-cap" class="bg-surface border border-border rounded-xl p-5 mb-8">
          <div class="flex items-center justify-between mb-3">
            <h2 class="text-heading-sm font-semibold">Daily Cap</h2>
            <span class={`text-caption font-medium ${overCap ? 'text-danger' : 'text-muted'}`}>
              {overCap ? 'Cap reached' : `${capPct}% used`}
            </span>
          </div>
          <div class="flex items-center gap-4 mb-3">
            <span class="text-body-sm text-primary font-medium">${costToday.toFixed(2)} today</span>
            <span class="text-body-sm text-muted">
              of ${cap.toFixed(2)} {costCap.source === 'runtime-config' ? '(custom)' : '(default)'}
            </span>
          </div>
          <div class="w-full h-2 bg-bg-elevated rounded-full overflow-hidden">
            <div
              class={`h-full rounded-full transition-all ${capPct > 80 ? 'bg-danger' : capPct > 50 ? 'bg-warning' : 'bg-success'}`}
              style={{ width: `${capPct}%` }}
            />
          </div>
        </div>
      )}

      {t && (
        <div class="bg-primary/5 border border-primary/20 rounded-xl p-5 mb-8">
          <p class="text-body-sm text-secondary">
            <span class="font-semibold text-primary">Cost Projection:</span>{' '}
            At this rate, your monthly spend will be approximately{' '}
            <span class="font-bold text-primary">${projectedMonthly.toFixed(2)}</span>
          </p>
        </div>
      )}

      {dailyData.length > 1 && (
        <div class="bg-surface border border-border rounded-xl p-5 mb-8">
          <h2 class="text-heading-sm font-semibold mb-4">Daily Spend</h2>
          <BarChart
            data={dailyData.map((d) => ({ label: d.date, value: d.costUsd }))}
            formatValue={(v) => `$${v.toFixed(2)}`}
          />
        </div>
      )}

      {t && (
        <div class="bg-surface border border-border rounded-xl p-5 mb-8">
          <h2 class="text-heading-sm font-semibold mb-4">Token Breakdown</h2>
          <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <p class="text-caption text-muted">Cache Read</p>
              <p class="text-body font-mono text-primary">{t.cacheReadInputTokens.toLocaleString()}</p>
            </div>
            <div>
              <p class="text-caption text-muted">Cache Write</p>
              <p class="text-body font-mono text-primary">{t.cacheWriteInputTokens.toLocaleString()}</p>
            </div>
            <div>
              <p class="text-caption text-muted">API Calls</p>
              <p class="text-body font-mono text-primary">{t.calls.toLocaleString()}</p>
            </div>
            <div>
              <p class="text-caption text-muted">Total Tokens</p>
              <p class="text-body font-mono text-primary">{(t.inputTokens + t.outputTokens).toLocaleString()}</p>
            </div>
          </div>
        </div>
      )}

      {data && data.rows.length > 0 && (
        <div data-tour="usage-log" class="bg-surface border border-border rounded-xl overflow-hidden">
          <div class="px-5 py-4 border-b border-border">
            <h2 class="text-heading-sm font-semibold">Usage Log ({data.rows.length} entries)</h2>
          </div>
          <div class="overflow-x-auto">
            <table class="w-full text-left">
              <thead>
                <tr class="border-b border-border bg-surface-elevated">
                  <th class="px-4 py-3 text-overline text-muted uppercase tracking-wider font-semibold">Time</th>
                  <th class="px-4 py-3 text-overline text-muted uppercase tracking-wider font-semibold">Model</th>
                  <th class="px-4 py-3 text-overline text-muted uppercase tracking-wider font-semibold text-right">Input</th>
                  <th class="px-4 py-3 text-overline text-muted uppercase tracking-wider font-semibold text-right">Output</th>
                  <th class="px-4 py-3 text-overline text-muted uppercase tracking-wider font-semibold text-right">Cost</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-border">
                {data.rows.slice(page * pageSize, (page + 1) * pageSize).map((r, i) => (
                  <tr key={i} class="hover:bg-surface-hover transition-colors">
                    <td class="px-4 py-2.5 text-body-sm text-secondary font-mono">{String(r.SK ?? '').slice(0, 19)}</td>
                    <td class="px-4 py-2.5 text-body-sm text-secondary">{formatModelName(r.model)}</td>
                    <td class="px-4 py-2.5 text-body-sm text-secondary text-right font-mono">{(r.inputTokens ?? 0).toLocaleString()}</td>
                    <td class="px-4 py-2.5 text-body-sm text-secondary text-right font-mono">{(r.outputTokens ?? 0).toLocaleString()}</td>
                    <td class="px-4 py-2.5 text-body-sm text-primary text-right font-mono font-medium">${(r.costUsd ?? 0).toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={page} pageSize={pageSize} total={data.rows.length} onPageChange={setPage} onPageSizeChange={setPageSize} />
        </div>
      )}
    </div>
  );
}
