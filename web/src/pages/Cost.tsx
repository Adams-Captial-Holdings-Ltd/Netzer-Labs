import { useState, useEffect, useRef } from 'preact/hooks';
import {
  api,
  type CostSummary,
  type CostRisksResult,
  type CostRisk,
  type CostCap,
  type CostReport,
  type CostDriver,
  type CostOptimization,
  type CostNecessity,
  type HiddenCost,
  type RemediationAction,
  type RemediationResult,
} from '../lib/api';
import { Skeleton } from '../components/Skeleton';
import { BarChart } from '../components/BarChart';
import { TldrBar } from '../components/TldrBar';
import { Toggle } from '../components/Toggle';
import { Badge } from '../components/Badge';
import { hasCapability } from '../lib/auth';
import { toast } from '../components/Toast';
import { InfoTooltip } from '../components/InfoTooltip';

const usd = (n: number) =>
  '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usd0 = (n: number) =>
  '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

const SEV_STYLE: Record<CostRisk['severity'], { dot: string; chip: string; label: string }> = {
  high: { dot: 'bg-danger', chip: 'text-danger bg-danger/10', label: 'High' },
  medium: { dot: 'bg-warning', chip: 'text-warning bg-warning/10', label: 'Medium' },
  low: { dot: 'bg-muted', chip: 'text-muted bg-muted/10', label: 'Low' },
};

// ── Remediation: map a scanned risk to its real AWS action ────────────
function actionForRiskId(id: string): RemediationAction | null {
  if (id.startsWith('nat-')) return 'delete-nat-gateway';
  if (id.startsWith('vpce-')) return 'delete-vpc-endpoint';
  if (id.startsWith('eip-')) return 'release-eip';
  if (id.startsWith('ebs-')) return 'delete-ebs-volume';
  if (id.startsWith('lb-')) return 'delete-load-balancer';
  if (id.startsWith('logs-')) return 'set-log-retention';
  return null;
}
const ACTION_VERB: Record<RemediationAction, string> = {
  'release-eip': 'Release',
  'delete-ebs-volume': 'Delete volume',
  'delete-nat-gateway': 'Delete NAT gateway',
  'delete-vpc-endpoint': 'Delete endpoint',
  'delete-load-balancer': 'Delete load balancer',
  'set-log-retention': 'Set 30-day retention',
};
// Only EBS volume deletion is true data loss; the rest are recreatable, and
// setting log retention is non-destructive + reversible. Drives the strength of
// the confirm copy so we never soft-pedal an irreversible one.
const ACTION_IRREVERSIBLE: Record<RemediationAction, boolean> = {
  'release-eip': false,
  'delete-ebs-volume': true,
  'delete-nat-gateway': false,
  'delete-vpc-endpoint': false,
  'delete-load-balancer': false,
  'set-log-retention': false,
};
// Default retention applied by the set-log-retention action.
const DEFAULT_LOG_RETENTION_DAYS = 30;

type RowState =
  | { kind: 'idle' }
  | { kind: 'confirm' }
  | { kind: 'applying' }
  | { kind: 'done'; result: RemediationResult };

// One row per real AWS resource: a two-step inline confirm (no JS dialog), the
// live apply, and the TRUE result straight from the backend's post-verify. On a
// verified apply it calls onApplied so the parent re-scans and the numbers move.
function ResourceRemediationRow({
  action,
  region,
  resourceId,
  onApplied,
}: {
  action: RemediationAction;
  region: string;
  resourceId: string;
  onApplied: () => void;
}) {
  const [state, setState] = useState<RowState>({ kind: 'idle' });
  const verb = ACTION_VERB[action];

  async function apply() {
    setState({ kind: 'applying' });
    try {
      const result = await api.cost.remediate({
        action,
        region,
        resourceId,
        ...(action === 'set-log-retention' ? { retentionDays: DEFAULT_LOG_RETENTION_DAYS } : {}),
      });
      setState({ kind: 'done', result });
      if (result.status === 'applied' && result.verified) onApplied();
    } catch (e) {
      setState({
        kind: 'done',
        result: {
          action,
          region,
          resourceId,
          status: 'failed',
          verified: false,
          message: e instanceof Error ? e.message : 'Request failed',
        },
      });
    }
  }

  const tone =
    state.kind === 'done'
      ? state.result.status === 'applied' && state.result.verified
        ? { dot: 'bg-success', text: 'text-success', mark: '✓' }
        : state.result.status === 'refused'
          ? { dot: 'bg-warning', text: 'text-warning', mark: '⚠' }
          : { dot: 'bg-danger', text: 'text-danger', mark: '✕' }
      : null;

  return (
    <div class="flex items-start gap-3 py-1.5">
      <code class="text-caption text-muted font-mono break-all flex-1 min-w-0">{resourceId}</code>
      <div class="shrink-0">
        {state.kind === 'idle' && (
          <button
            onClick={() => setState({ kind: 'confirm' })}
            class="text-caption font-medium px-2.5 py-1 rounded-md border border-border text-secondary hover:text-danger hover:border-danger/40 transition-colors"
          >
            {verb}
          </button>
        )}
        {state.kind === 'confirm' && (
          <div class="flex items-center gap-2">
            <span class="text-caption text-muted">
              {ACTION_IRREVERSIBLE[action] ? 'Irreversible. Sure?' : 'Confirm?'}
            </span>
            <button
              onClick={apply}
              class="text-caption font-medium px-2.5 py-1 rounded-md bg-danger text-white hover:opacity-90 transition-opacity"
            >
              Yes, {verb.toLowerCase()}
            </button>
            <button
              onClick={() => setState({ kind: 'idle' })}
              class="text-caption px-2 py-1 rounded-md border border-border text-secondary hover:bg-surface-hover transition-colors"
            >
              Cancel
            </button>
          </div>
        )}
        {state.kind === 'applying' && <span class="text-caption text-muted">Applying to AWS…</span>}
      </div>
      {state.kind === 'done' && tone && (
        <div class="w-full basis-full flex items-start gap-1.5 mt-0.5">
          <span class={`mt-1 w-1.5 h-1.5 rounded-full shrink-0 ${tone.dot}`} />
          <span class={`text-caption ${tone.text}`}>
            {tone.mark} {state.result.message}
          </span>
        </div>
      )}
    </div>
  );
}

// ── AI cost report: presentation maps ─────────────────────────────────
// Necessity: essential = you need it (neutral), review = worth a look (amber),
// likely-waste = a strong cut candidate (red). Priority/effort are plain chips.
const NECESSITY: Record<CostNecessity, { variant: 'muted' | 'warning' | 'danger'; label: string }> = {
  essential: { variant: 'muted', label: 'Essential' },
  review: { variant: 'warning', label: 'Review' },
  'likely-waste': { variant: 'danger', label: 'Likely waste' },
};
const PRIORITY: Record<CostOptimization['priority'], { variant: 'danger' | 'warning' | 'muted'; label: string }> = {
  high: { variant: 'danger', label: 'High priority' },
  medium: { variant: 'warning', label: 'Medium priority' },
  low: { variant: 'muted', label: 'Low priority' },
};

type ReportState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; data: CostReport }
  | { kind: 'error'; message: string };

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to legacy path */
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// ── AI cost report: rendered sections ─────────────────────────────────
function DriverRow({ d }: { d: CostDriver }) {
  const nec = NECESSITY[d.necessity];
  return (
    <div class="py-3 border-b border-border last:border-0">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-body font-semibold text-primary truncate" title={d.service}>{d.service}</span>
            <Badge variant={nec.variant}>{nec.label}</Badge>
          </div>
          <p class="text-body-sm text-secondary mt-1">{d.whatItIs}</p>
          {d.assessment && <p class="text-body-sm text-secondary mt-1.5"><span class="text-muted">Do you need it? </span>{d.assessment}</p>}
          {d.cheaperAlternative && (
            <p class="text-body-sm text-success mt-1.5">
              <span class="text-muted">Cheaper option: </span>{d.cheaperAlternative}
            </p>
          )}
        </div>
        <div class="text-right shrink-0">
          <p class="text-body font-mono font-semibold text-primary">{usd(d.monthToDateUsd)}</p>
          <p class="text-caption text-muted">{d.sharePct.toFixed(0)}% of bill</p>
        </div>
      </div>
    </div>
  );
}

function HiddenCostRow({ h }: { h: HiddenCost }) {
  return (
    <div class="py-3 border-b border-border last:border-0">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <p class="text-body font-semibold text-primary">{h.title}</p>
          <p class="text-body-sm text-secondary mt-1">{h.detail}</p>
        </div>
        {h.estMonthlyUsd > 0 && (
          <div class="text-right shrink-0">
            <p class="text-body font-mono font-semibold text-warning">~{usd(h.estMonthlyUsd)}<span class="text-caption text-muted font-normal">/mo</span></p>
            <p class="text-caption text-muted">est. drain</p>
          </div>
        )}
      </div>
    </div>
  );
}

function OptimizationRow({ o }: { o: CostOptimization }) {
  const pri = PRIORITY[o.priority];
  return (
    <div class="py-3 border-b border-border last:border-0">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-body font-semibold text-primary">{o.title}</span>
            <Badge variant={pri.variant}>{pri.label}</Badge>
            <span class="text-caption text-muted">{o.effort} effort</span>
          </div>
          <p class="text-body-sm text-secondary mt-1">{o.rationale}</p>
          {o.alternative && (
            <p class="text-body-sm text-secondary mt-1.5">
              <span class="text-muted">Switch to: </span>
              <span class="text-primary font-medium">{o.alternative}</span>
              {o.estNewMonthlyUsd > 0 && <span class="text-muted"> (~{usd(o.estNewMonthlyUsd)}/mo after)</span>}
            </p>
          )}
        </div>
        {o.estMonthlySavingsUsd > 0 && (
          <div class="text-right shrink-0">
            <p class="text-body font-bold text-success">{usd(o.estMonthlySavingsUsd)}<span class="text-caption text-muted font-normal">/mo</span></p>
            <p class="text-caption text-muted">est. saving</p>
          </div>
        )}
      </div>
    </div>
  );
}

function ClaudeCodePlan({ plan }: { plan: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    const ok = await copyToClipboard(plan);
    if (ok) {
      setCopied(true);
      toast('Plan copied. Paste it into Claude Code.', 'success');
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast('Could not copy automatically; select the text and copy manually', 'error');
    }
  }
  return (
    <div class="rounded-xl border border-primary/30 bg-primary/5 overflow-hidden">
      <div class="flex items-center justify-between gap-3 px-4 py-3 border-b border-primary/20">
        <div class="flex items-center gap-2 min-w-0">
          <Badge variant="info">Claude Code plan</Badge>
          <span class="text-caption text-muted truncate">Read-only checks first, then confirm each deletion</span>
        </div>
        <button onClick={copy} class="text-caption font-medium px-3 py-1.5 rounded-lg bg-primary text-white hover:opacity-90 transition-opacity shrink-0">
          {copied ? 'Copied ✓' : 'Copy'}
        </button>
      </div>
      <div class="p-4">
        <textarea
          readOnly
          class="w-full h-72 resize-y rounded-lg border border-border bg-surface p-3 text-caption font-mono text-secondary leading-relaxed"
          value={plan}
          onClick={(e) => (e.target as HTMLTextAreaElement).select()}
        />
      </div>
    </div>
  );
}

function CostReportPanel({ data }: { data: CostReport }) {
  const verdict =
    data.verdict === 'over-budget'
      ? { variant: 'danger' as const, label: 'Over budget' }
      : data.verdict === 'on-track'
        ? { variant: 'success' as const, label: 'On track' }
        : { variant: 'muted' as const, label: 'No budget set' };
  // Authoritative pre-optimization projection, straight from the backend (never
  // reconstructed from after+savings, which would over-state it when the floor clamps).
  const projectedNow = data.projectedMonthlyNowUsd;
  return (
    <div class="mt-4 space-y-6">
      {/* Headline */}
      <div class="rounded-xl border border-border bg-bg-elevated p-5">
        <div class="flex items-center gap-2 mb-2">
          <Badge variant={verdict.variant}>{verdict.label}</Badge>
          {data.totalEstSavingsUsd > 0 && (
            <span class="text-caption text-success font-medium">~{usd0(data.totalEstSavingsUsd)}/mo recoverable</span>
          )}
        </div>
        <p class="text-body text-primary leading-relaxed">{data.headline}</p>
        {data.totalEstSavingsUsd > 0 && (
          <div class="mt-4 pt-4 border-t border-border flex items-center gap-4 flex-wrap">
            <div>
              <p class="text-caption text-muted uppercase tracking-wider">Projected now</p>
              <p class="text-heading-sm font-bold text-primary">{usd0(projectedNow)}<span class="text-caption text-muted font-normal">/mo</span></p>
            </div>
            <span class="text-muted text-body" aria-hidden="true">→</span>
            <div>
              <p class="text-caption text-muted uppercase tracking-wider">If you apply the below</p>
              <p class="text-heading-sm font-bold text-success">{usd0(data.projectedMonthlyAfterUsd)}<span class="text-caption text-muted font-normal">/mo</span></p>
            </div>
            <span class="text-caption text-success ml-auto">saving ~{usd0(data.totalEstSavingsUsd)}/mo</span>
          </div>
        )}
      </div>

      {/* What you're paying for */}
      {data.drivers.length > 0 && (
        <div>
          <h3 class="text-heading-sm font-semibold mb-1">What you're paying for</h3>
          <p class="text-body-sm text-secondary mb-3">Each service in plain English, and whether this account needs it.</p>
          <div class="bg-surface border border-border rounded-xl px-5 py-1">
            {data.drivers.map((d, i) => <DriverRow key={i} d={d} />)}
          </div>
        </div>
      )}

      {/* Hidden costs — the skeletons in the closet the waste scan can't catch */}
      {data.hiddenCosts.length > 0 && (
        <div>
          <h3 class="text-heading-sm font-semibold mb-1">Skeletons in the closet</h3>
          <p class="text-body-sm text-secondary mb-3">Quiet, long-running drains that are easy to miss and don't show up as obvious waste.</p>
          <div class="bg-surface border border-border rounded-xl px-5 py-1">
            {data.hiddenCosts.map((h, i) => <HiddenCostRow key={i} h={h} />)}
          </div>
        </div>
      )}

      {/* Optimizations */}
      {data.optimizations.length > 0 && (
        <div>
          <h3 class="text-heading-sm font-semibold mb-1">Optimizations, ranked</h3>
          <p class="text-body-sm text-secondary mb-3">Biggest, safest savings first.</p>
          <div class="bg-surface border border-border rounded-xl px-5 py-1">
            {data.optimizations.map((o, i) => <OptimizationRow key={i} o={o} />)}
          </div>
        </div>
      )}

      {/* Claude Code plan */}
      {data.claudeCodePlan && (
        <div>
          <h3 class="text-heading-sm font-semibold mb-1">Hand it to Claude Code</h3>
          <p class="text-body-sm text-secondary mb-3">A paste-ready plan that uses the AWS CLI to verify, then fix, the waste above.</p>
          <ClaudeCodePlan plan={data.claudeCodePlan} />
        </div>
      )}

      {data.note && (
        <p class="text-caption text-warning">{data.note}</p>
      )}
      <p class="text-caption text-muted">
        Generated {new Date(data.generatedAt).toLocaleString()} by {data.modelId} · this report cost{' '}
        {usd(data.generationCostUsd)} to produce. Decision support, not a guarantee — estimates use public list prices,
        so verify before deleting anything.
      </p>
    </div>
  );
}

export function Cost() {
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [risks, setRisks] = useState<CostRisksResult | null>(null);
  const [cap, setCap] = useState<CostCap | null>(null);
  const [loading, setLoading] = useState(true);
  const [risksLoading, setRisksLoading] = useState(true);
  // Capability gates (Wave 4c): the old admin-only UI is replaced by the
  // taxonomy capabilities the backend authorizes against. cost:write covers
  // cost-cap edits + AWS budget sync; config:write covers runtime-config writes
  // (the daily cost-watch flag). owner holds both. The backend re-checks every
  // write, so this only decides which controls the UI renders.
  const canEditCap = hasCapability('cost:write');
  const canManageWatch = hasCapability('config:write');
  const [watchEnabled, setWatchEnabled] = useState<boolean | null>(null);
  const [watchBusy, setWatchBusy] = useState(false);
  const [capInput, setCapInput] = useState('');
  const [capBusy, setCapBusy] = useState(false);
  // On-demand AI cost report (POST /api/cost/report). Kept separate from the
  // page's summary/risks loads so generating it never blocks the dashboard.
  const [report, setReport] = useState<ReportState>({ kind: 'idle' });
  const reportAbortRef = useRef<AbortController | null>(null);
  // Whether one-click Apply (real AWS remediation) is armed server-side. Null
  // until the status check resolves; the buttons only render when true.
  const [remediationEnabled, setRemediationEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    api.costCap.get(ac.signal).then(setCap).catch(() => {});
    api.cost.summary(ac.signal).then(setSummary).catch(() => setSummary(null)).finally(() => setLoading(false));
    // Risks runs a multi-region scan; load it independently so a slow scan
    // never blocks the headline spend numbers.
    api.cost.risks(ac.signal).then(setRisks).catch(() => setRisks(null)).finally(() => setRisksLoading(false));
    // Only principals who can manage the watch flag (config:write) read its
    // current state — the toggle is hidden for everyone else anyway.
    if (canManageWatch) {
      api.config.get('cost', 'watch_enabled', ac.signal)
        .then((r) => setWatchEnabled(r.value === 'true'))
        .catch(() => {});
    }
    // Only operators who could actually apply (cost:write) need the arm status.
    if (canEditCap) {
      api.cost.remediationStatus(ac.signal)
        .then((r) => setRemediationEnabled(r.enabled))
        .catch(() => setRemediationEnabled(false));
    }
    return () => {
      ac.abort();
      reportAbortRef.current?.abort();
    };
  }, []);

  // Seed the cap input from the effective cap once it loads.
  useEffect(() => {
    if (cap && capInput === '') setCapInput(String(cap.dailyCapUsd));
  }, [cap]);

  async function saveCap() {
    const n = Number(capInput);
    // Mirrors the server contract (POST /api/cost-cap rejects <= 0): a cap of 0
    // would never be enforced — getEffectiveCostCap() ignores non-positive
    // values — so blocking it here keeps the toast and the API in agreement.
    // Intentional full stops go through the bedrock_global kill switch.
    if (!Number.isFinite(n) || n <= 0) {
      toast('Enter a positive dollar amount', 'error');
      return;
    }
    setCapBusy(true);
    try {
      const r = await api.post<{ dailyCapUsd: number; awsBudgetMonthlyUsd: number | null }>(
        '/cost-cap',
        { dailyCapUsd: n },
      );
      setCap({ dailyCapUsd: r.dailyCapUsd, source: 'runtime-config' });
      // The report's verdict (over/under budget) is computed against the cap, so
      // a prior report is now stale — drop it so it's regenerated against the new budget.
      if (report.kind === 'done') setReport({ kind: 'idle' });
      toast(
        r.awsBudgetMonthlyUsd != null
          ? `Cap set to $${r.dailyCapUsd}/day · AWS budget synced to $${r.awsBudgetMonthlyUsd}/mo`
          : `Cap set to $${r.dailyCapUsd}/day (AWS budget sync skipped)`,
        'success',
      );
    } catch (e) {
      toast(`Could not set cap: ${e instanceof Error ? e.message : 'error'}`, 'error');
    } finally {
      setCapBusy(false);
    }
  }

  async function toggleWatch() {
    const next = !(watchEnabled ?? false);
    setWatchBusy(true);
    try {
      await api.config.set('cost', 'watch_enabled', String(next));
      setWatchEnabled(next);
      toast(`Daily cost watch ${next ? 'enabled' : 'disabled'}`, 'success');
    } catch (e) {
      toast(`Could not update: ${e instanceof Error ? e.message : 'error'}`, 'error');
    } finally {
      setWatchBusy(false);
    }
  }

  async function runCheckNow() {
    setWatchBusy(true);
    try {
      const r = await api.post<{ ran: boolean; alerted: boolean; alerts?: string[] }>('/cost/evaluate');
      toast(
        r.alerted ? `Alert sent: ${(r.alerts ?? []).join(' ')}`.slice(0, 140) : 'Checked — nothing over threshold',
        r.alerted ? 'info' : 'success',
      );
    } catch (e) {
      toast(`Check failed: ${e instanceof Error ? e.message : 'error'}`, 'error');
    } finally {
      setWatchBusy(false);
    }
  }

  async function generateReport() {
    // Cancel any in-flight generation so a double-click can't race two reports.
    reportAbortRef.current?.abort();
    const ctrl = new AbortController();
    reportAbortRef.current = ctrl;
    setReport({ kind: 'loading' });
    try {
      // Async mode (Settings toggle) generates in the background and polls, so it
      // is not bound by the 60s edge timeout and returns the fuller report.
      const mode = await api.cost.reportMode(ctrl.signal).catch(() => ({ async: false }));
      if (ctrl.signal.aborted) return;

      if (mode.async) {
        await api.cost.reportStart(ctrl.signal);
        const deadline = Date.now() + 5 * 60 * 1000; // generous; the job has its own staleness guard
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 3000));
          if (ctrl.signal.aborted) return;
          const res = await api.cost.reportResult(ctrl.signal);
          if (ctrl.signal.aborted) return;
          if (res.status === 'done' && res.report) {
            if (!res.report.available) {
              setReport({ kind: 'error', message: res.report.note ?? 'Cost data is unavailable.' });
              return;
            }
            setReport({ kind: 'done', data: res.report });
            return;
          }
          if (res.status === 'error') {
            setReport({ kind: 'error', message: res.error ?? 'Report generation failed.' });
            return;
          }
          // idle | pending → keep polling
        }
        setReport({ kind: 'error', message: 'Report is taking longer than expected. Try again.' });
        return;
      }

      // Sync mode (default): one request, trimmed to fit the edge timeout.
      const data = await api.cost.report(ctrl.signal);
      if (ctrl.signal.aborted) return;
      if (!data.available) {
        setReport({
          kind: 'error',
          message: data.note ?? 'Cost data is unavailable, so no report could be generated.',
        });
        return;
      }
      setReport({ kind: 'done', data });
    } catch (e) {
      if (ctrl.signal.aborted) return;
      setReport({ kind: 'error', message: e instanceof Error ? e.message : 'Could not generate report' });
    }
  }

  // After a verified remediation, re-pull the waste scan so the recoverable
  // number and the risk list reflect TRUE AWS state, not the pre-deletion view.
  // The backend bust its cache on a verified apply, so this returns fresh data.
  function refreshRisks() {
    setRisksLoading(true);
    api.cost
      .risks()
      .then(setRisks)
      .catch(() => {})
      .finally(() => setRisksLoading(false));
  }

  const s = summary;
  const monthBudget = cap ? cap.dailyCapUsd * (s?.daysInMonth ?? 30) : 0;
  const projected = s?.projectedMonthUsd ?? 0;
  const overBudget = monthBudget > 0 && projected > monthBudget;
  const mom = s && s.lastMonthUsd > 0 ? ((s.projectedMonthUsd - s.lastMonthUsd) / s.lastMonthUsd) * 100 : 0;
  const maxService = s && s.byService.length ? Math.max(...s.byService.map((x) => x.amountUsd)) : 0;

  const stats = [
    { label: 'Month to date', value: s ? usd(s.monthToDateUsd) : '--', sub: s ? `day ${s.daysElapsed} of ${s.daysInMonth}` : '' },
    {
      label: 'Projected month-end',
      value: s ? usd(s.projectedMonthUsd) : '--',
      sub: s && s.lastMonthUsd > 0 ? `${mom >= 0 ? '+' : ''}${mom.toFixed(0)}% vs last month` : '',
      danger: overBudget,
    },
    { label: 'Last month', value: s ? usd(s.lastMonthUsd) : '--', sub: '' },
    {
      label: 'Recoverable / mo',
      value: risks ? usd(risks.totalMonthlySavingsUsd) : '--',
      sub: risks ? `${risks.risks.length} issue${risks.risks.length === 1 ? '' : 's'} found` : '',
      good: !!risks && risks.totalMonthlySavingsUsd > 0,
    },
  ];

  // Jarvis screen-awareness (H2): expose a compact summary of the actual numbers
  // currently rendered so read_view returns the live on-screen content rather than
  // a blanket DOM scrape. Updates as the data resolves. Settings/token routes are
  // excluded server-side; dollar figures here are non-sensitive spend totals.
  useEffect(() => {
    const w = window as unknown as { getJarvisSummary?: () => string };
    w.getJarvisSummary = () => {
      const parts: string[] = ['Page: Cost & Spend.'];
      if (!s) return parts.concat('Spend data is still loading.').join(' ');
      if (!s.available) {
        parts.push(`Cost data unavailable: ${s.note ?? 'Cost Explorer could not be read.'}`);
        return parts.join(' ');
      }
      parts.push(
        `Month to date ${usd(s.monthToDateUsd)} (day ${s.daysElapsed} of ${s.daysInMonth}).`,
        `Projected month-end ${usd(s.projectedMonthUsd)}${s.lastMonthUsd > 0 ? ` (${mom >= 0 ? '+' : ''}${mom.toFixed(0)}% vs last month ${usd(s.lastMonthUsd)})` : ''}.`,
      );
      if (cap && monthBudget > 0) {
        parts.push(
          `${overBudget ? 'Over budget' : 'On track'}: ${usd(projected)} projected against a ${usd(monthBudget)} budget (daily cap ${usd(cap.dailyCapUsd)}).`,
        );
      }
      const top = s.byService.slice(0, 5).map((x) => `${x.service} ${usd(x.amountUsd)}`);
      if (top.length) parts.push(`Top services: ${top.join(', ')}.`);
      if (risks) {
        parts.push(
          risks.totalMonthlySavingsUsd > 0
            ? `Cost risks: ${risks.risks.length} issue${risks.risks.length === 1 ? '' : 's'}, about ${usd0(risks.totalMonthlySavingsUsd)} per month recoverable.`
            : 'Cost risks: no obvious waste detected.',
        );
      }
      return parts.join(' ');
    };
    return () => {
      const ww = window as unknown as { getJarvisSummary?: () => string };
      if (ww.getJarvisSummary) delete ww.getJarvisSummary;
    };
  }, [s, risks, cap, monthBudget, projected, overBudget, mom]);

  return (
    <div>
      <TldrBar
        tab="Cost & Spend"
        ready={!loading && !!s}
        data={{
          monthToDateUsd: s?.monthToDateUsd,
          projectedMonthUsd: s?.projectedMonthUsd,
          lastMonthUsd: s?.lastMonthUsd,
          topServices: s?.byService?.slice(0, 5),
          recoverableWasteUsdPerMo: risks?.totalMonthlySavingsUsd,
          riskCount: risks?.risks?.length,
          dailyCapUsd: cap?.dailyCapUsd,
          overBudget,
        }}
      />
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 data-tour="cost-title" class="text-display-sm text-primary font-bold">Cost &amp; Spend</h1>
          <p class="text-body-sm text-secondary mt-1">
            Live AWS spend, month-end projection, and automated waste detection
          </p>
        </div>
        {s?.generatedAt && (
          <span class="text-caption text-muted">
            updated {new Date(s.generatedAt).toLocaleString()}
          </span>
        )}
      </div>

      {/* Permission / availability banner */}
      {s && !s.available && (
        <div class="bg-warning/10 border border-warning/30 rounded-xl p-4 mb-6">
          <p class="text-body-sm text-primary font-medium mb-1">Cost data unavailable</p>
          <p class="text-body-sm text-secondary">{s.note ?? 'Cost Explorer could not be read.'}</p>
        </div>
      )}

      {/* Headline stats */}
      <div data-tour="cost-stats" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {loading
          ? Array.from({ length: 4 }).map((_, i) => (
              <div key={i} class="bg-surface border border-border rounded-xl p-5">
                <Skeleton height="12px" width="60%" class="mb-3" />
                <Skeleton height="28px" width="40%" />
              </div>
            ))
          : stats.map((st) => (
              <div key={st.label} class="bg-surface border border-border rounded-xl p-5">
                <p class="text-caption text-muted uppercase tracking-wider mb-1">{st.label}</p>
                <p
                  class={`text-heading-lg font-bold ${st.danger ? 'text-danger' : st.good ? 'text-success' : 'text-primary'}`}
                >
                  {st.value}
                </p>
                {st.sub && <p class="text-caption text-muted mt-1">{st.sub}</p>}
              </div>
            ))}
      </div>

      {/* Budget callout: projection vs (daily cap x days in month) */}
      {cap && s?.available && monthBudget > 0 && (
        <div
          class={`rounded-xl p-5 mb-8 border ${overBudget ? 'bg-danger/5 border-danger/30' : 'bg-primary/5 border-primary/20'}`}
        >
          <p class="text-body-sm text-secondary">
            <span class={`font-semibold ${overBudget ? 'text-danger' : 'text-primary'}`}>
              {overBudget ? 'Over budget:' : 'On track:'}
            </span>{' '}
            Projected {usd(projected)} this month against a budget of {usd(monthBudget)} (daily cap{' '}
            {usd(cap.dailyCapUsd)} × {s.daysInMonth} days
            {cap.source === 'runtime-config' ? ', custom' : ', default'}).
            {overBudget
              ? ` That is ${usd(projected - monthBudget)} over. Generate the AI cost report below to see what to cut.`
              : ''}
          </p>
        </div>
      )}

      {/* On-demand AI cost report. Spun up like the Compliance brief: read the
          live spend + waste, explain it in plain English, and emit a paste-ready
          AWS CLI plan for Claude Code. Emphasized (red) when over budget, which
          is exactly when a high projected number warrants a closer look. */}
      {s?.available && (
        <div data-tour="cost-report" class={`rounded-xl p-5 mb-8 border ${overBudget ? 'bg-danger/5 border-danger/30' : 'bg-surface border-border'}`}>
          <div class="flex items-start justify-between gap-4 flex-wrap">
            <div class="min-w-0">
              <h2 class="text-heading-sm font-semibold inline-flex items-center gap-2">
                AI cost report
                <Badge variant="info">on demand</Badge>
              </h2>
              <p class="text-body-sm text-secondary mt-1 max-w-2xl">
                {overBudget
                  ? `You're projected ${usd(projected - monthBudget)} over budget. Generate a plain-English breakdown of what's driving the bill, what each service does and whether you need it, where to cut, and a ready-to-paste plan for Claude Code to fix it via the AWS CLI.`
                  : `Break down the bill in plain English — what each service does, whether you need it, where to cut — plus a ready-to-paste plan for Claude Code to fix it via the AWS CLI.`}
              </p>
            </div>
            <button
              onClick={generateReport}
              disabled={loading || !s || report.kind === 'loading'}
              class={`px-4 py-2 text-body-sm rounded-lg font-medium shrink-0 transition-colors disabled:opacity-50 ${overBudget ? 'bg-danger text-white hover:opacity-90' : 'bg-primary/10 text-primary hover:bg-primary/20'}`}
            >
              {report.kind === 'loading'
                ? 'Analyzing…'
                : report.kind === 'done'
                  ? 'Regenerate report'
                  : 'Generate report'}
            </button>
          </div>

          {report.kind === 'loading' && (
            <p class="text-body-sm text-muted mt-4">
              Reading your spend, the by-service breakdown, and the waste scan, then writing the full analysis and a Claude Code plan… this usually takes under a minute.
            </p>
          )}
          {report.kind === 'error' && <p class="text-body-sm text-danger mt-4">{report.message}</p>}
          {report.kind === 'done' && <CostReportPanel data={report.data} />}
        </div>
      )}

      {/* Spending cap — requires cost:write (cost-cap edits + AWS budget sync). */}
      {canEditCap && (
        <div data-tour="cost-cap" class="bg-surface border border-border rounded-xl p-5 mb-8">
          <div class="flex items-start justify-between gap-4 flex-wrap">
            <div class="min-w-0">
              <h2 class="text-heading-sm font-semibold inline-flex items-center gap-1.5">
                Spending cap
                <InfoTooltip term="cap" />
              </h2>
              <p class="text-body-sm text-secondary mt-1">
                The daily cap hard-stops AI (Bedrock) spend in-app. Saving it also syncs your AWS
                monthly Budget (cap × ~30.4) so AWS alerts at 80%, 100%, and forecast.
                {cap ? ` Current: $${cap.dailyCapUsd}/day (${cap.source === 'runtime-config' ? 'custom' : 'default'}).` : ''}
              </p>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <div class="flex items-center gap-1 px-2 py-1.5 rounded-lg border border-border">
                <span class="text-body-sm text-muted">$</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={capInput}
                  onInput={(e) => setCapInput((e.target as HTMLInputElement).value)}
                  class="w-24 bg-transparent text-body-sm text-primary outline-none"
                  placeholder="daily"
                />
                <span class="text-caption text-muted">/day</span>
              </div>
              <button
                onClick={saveCap}
                disabled={capBusy}
                class="px-3 py-2 text-body-sm rounded-lg font-medium bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-50 transition-colors"
              >
                {capBusy ? 'Saving...' : 'Save cap'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Proactive alerts — the daily cost-watch flag is a runtime-config write,
          so it requires config:write. */}
      {canManageWatch && (
        <div class="bg-surface border border-border rounded-xl p-5 mb-8">
          <div class="flex items-start justify-between gap-4 flex-wrap">
            <div class="min-w-0">
              <h2 class="text-heading-sm font-semibold">Proactive alerts</h2>
              <p class="text-body-sm text-secondary mt-1">
                AWS Budget and Cost Anomaly Detection email you daily. The in-app daily watch also
                alerts when recoverable waste jumps (new costly resources) or projection exceeds budget.
              </p>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <button
                onClick={runCheckNow}
                disabled={watchBusy}
                class="px-3 py-2 text-body-sm rounded-lg border border-border text-secondary hover:bg-surface-hover disabled:opacity-50 transition-colors"
              >
                Run check now
              </button>
              <Toggle
                checked={!!watchEnabled}
                busy={watchBusy}
                disabled={watchEnabled === null}
                ariaLabel={watchEnabled ? 'Daily cost watch on' : 'Daily cost watch off'}
                onChange={() => toggleWatch()}
              >
                <span class="text-body-sm font-medium text-secondary whitespace-nowrap">
                  {watchEnabled === null ? 'Daily watch …' : watchEnabled ? 'Daily watch on' : 'Daily watch off'}
                </span>
              </Toggle>
            </div>
          </div>
        </div>
      )}

      {/* Daily spend trend */}
      {s?.available && s.daily.length > 1 && (
        <div class="bg-surface border border-border rounded-xl p-5 mb-8">
          <h2 class="text-heading-sm font-semibold mb-4">Daily spend (last 30 days)</h2>
          <BarChart
            data={s.daily.map((d) => ({ label: d.date, value: d.amountUsd }))}
            formatValue={(v) => usd(v)}
          />
        </div>
      )}

      {/* By-service breakdown */}
      {s?.available && s.byService.length > 0 && (
        <div data-tour="cost-services" class="bg-surface border border-border rounded-xl p-5 mb-8">
          <h2 class="text-heading-sm font-semibold mb-4">Where the money goes (month to date)</h2>
          <div class="space-y-2.5">
            {s.byService.slice(0, 14).map((svc) => {
              const pct = maxService > 0 ? (svc.amountUsd / maxService) * 100 : 0;
              const share = s.monthToDateUsd > 0 ? (svc.amountUsd / s.monthToDateUsd) * 100 : 0;
              return (
                <div key={svc.service} class="flex items-center gap-3">
                  <div class="w-44 shrink-0 text-body-sm text-secondary truncate" title={svc.service}>
                    {svc.service}
                  </div>
                  <div class="flex-1 h-5 bg-bg-elevated rounded overflow-hidden">
                    <div
                      class="h-full bg-primary/70 rounded transition-all"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <div class="w-28 shrink-0 text-right text-body-sm font-mono text-primary">
                    {usd(svc.amountUsd)}
                  </div>
                  <div class="w-12 shrink-0 text-right text-caption text-muted">{share.toFixed(0)}%</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Cost risks / waste detection */}
      <div data-tour="cost-risks" class="bg-surface border border-border rounded-xl overflow-hidden">
        <div class="px-5 py-4 border-b border-border flex items-center justify-between">
          <h2 class="text-heading-sm font-semibold">Cost risks</h2>
          {risks && (
            <span class="text-caption text-muted">
              {risks.totalMonthlySavingsUsd > 0
                ? `~${usd0(risks.totalMonthlySavingsUsd)}/mo recoverable`
                : 'no obvious waste'}
              {risks.regionsScanned.length > 0 ? ` · ${risks.regionsScanned.join(', ')}` : ''}
            </span>
          )}
        </div>
        <div class="divide-y divide-border">
          {risksLoading ? (
            <div class="p-5 space-y-3">
              <Skeleton height="16px" width="40%" />
              <Skeleton height="16px" width="70%" />
            </div>
          ) : !risks || risks.risks.length === 0 ? (
            <div class="p-8 text-center text-body-sm text-muted">
              No wasteful resources detected in the scanned regions.
            </div>
          ) : (
            risks.risks.map((r) => {
              const sev = SEV_STYLE[r.severity];
              const act = actionForRiskId(r.id);
              const canRemediate = canEditCap && remediationEnabled === true && act !== null;
              return (
                <div key={r.id} class="p-5">
                  <div class="flex items-start justify-between gap-4">
                    <div class="flex items-start gap-3 min-w-0">
                      <span class={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${sev.dot}`} />
                      <div class="min-w-0">
                        <div class="flex items-center gap-2 flex-wrap">
                          <span class="text-body font-semibold text-primary">{r.title}</span>
                          <span class={`text-overline uppercase tracking-wider px-1.5 py-0.5 rounded ${sev.chip}`}>
                            {sev.label}
                          </span>
                          <span class="text-caption text-muted">{r.region}</span>
                        </div>
                        <p class="text-body-sm text-secondary mt-1">{r.detail}</p>
                        {/* Armed + we know the action: real per-resource Apply
                            controls. The backend re-checks idleness before each
                            mutation and verifies it landed, so nothing here is
                            cosmetic — a row only flips to ✓ when AWS confirms. */}
                        {canRemediate && act && r.resourceIds.length > 0 ? (
                          <div class="mt-2.5 rounded-lg border border-border bg-bg-elevated px-3 py-2">
                            <p class="text-overline text-muted uppercase tracking-wider mb-1">
                              Apply fix · verified against AWS
                            </p>
                            {r.resourceIds.slice(0, 8).map((rid) => (
                              <ResourceRemediationRow
                                key={rid}
                                action={act}
                                region={r.region}
                                resourceId={rid}
                                onApplied={refreshRisks}
                              />
                            ))}
                            {r.resourceIds.length > 8 && (
                              <p class="text-caption text-muted mt-1">
                                +{r.resourceIds.length - 8} more — use the Claude Code plan for the rest.
                              </p>
                            )}
                          </div>
                        ) : (
                          r.resourceIds.length > 0 && (
                            <p class="text-caption text-muted font-mono mt-2 break-all">
                              {r.resourceIds.slice(0, 6).join('  ')}
                              {r.resourceIds.length > 6 ? `  +${r.resourceIds.length - 6} more` : ''}
                            </p>
                          )
                        )}
                      </div>
                    </div>
                    <div class="text-right shrink-0">
                      <p class="text-body font-bold text-success">{usd(r.estMonthlySavingsUsd)}<span class="text-caption text-muted font-normal">/mo</span></p>
                      <p class="text-caption text-muted">of {usd(r.estMonthlyUsd)} now</p>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <p class="text-caption text-muted mt-4">
        Spend figures are live from AWS Cost Explorer. Risk dollar amounts use public list prices and
        are approximate, meant to rank waste rather than reconcile the invoice exactly.
        {canEditCap && remediationEnabled === true
          ? ' Apply runs a real AWS delete/release, re-checks the resource is idle first, and only marks done when AWS confirms — so the bill actually drops.'
          : canEditCap && remediationEnabled === false
            ? ' One-click Apply is off; use the Claude Code plan above to remediate via the AWS CLI until it is armed.'
            : ''}
      </p>
    </div>
  );
}
