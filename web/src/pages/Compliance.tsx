import { useState, useEffect, useRef } from 'preact/hooks';
import {
  api,
  clearApiCache,
  type ComplianceSummary,
  type FrameworkResult,
  type EvaluatedControl,
  type ControlEvidence,
  type ControlStatus,
  type ControlAnalysis,
  type ComplianceFrameworkId,
  type ScanArea,
  type RemediationBrief,
} from '../lib/api';
import { Badge } from '../components/Badge';
import { EmptyState } from '../components/EmptyState';
import { toast } from '../components/Toast';

// ── Status → presentation ────────────────────────────────────────────
// met=green, partial=amber, gap=red, unknown=grey, manual=blue (needs
// human attestation; deliberately not counted as a pass or a fail).
const STATUS_BADGE: Record<ControlStatus, 'success' | 'warning' | 'danger' | 'muted' | 'info'> = {
  met: 'success',
  partial: 'warning',
  gap: 'danger',
  unknown: 'muted',
  manual: 'info',
};
const STATUS_LABEL: Record<ControlStatus, string> = {
  met: 'Met',
  partial: 'Partial',
  gap: 'Gap',
  unknown: 'Unknown',
  manual: 'Manual',
};
const STATUS_BAR: Record<ControlStatus, string> = {
  met: 'bg-success',
  partial: 'bg-warning',
  gap: 'bg-danger',
  unknown: 'bg-gray-300 dark:bg-gray-600',
  manual: 'bg-primary',
};

const EVIDENCE_DOT: Record<ControlEvidence['status'], string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  crit: 'bg-danger',
  unknown: 'bg-gray-300 dark:bg-gray-600',
};

const COUNT_ORDER: ControlStatus[] = ['gap', 'partial', 'met', 'unknown', 'manual'];

// The full set of evidence domains the backend can scan, kept in sync with the
// backend AREA_META (src/lib/compliance/control-catalog.ts) so the overlay can
// show every expected domain even before the scan resolves. This is only the
// pending-state scaffold: once the summary loads, the real domain list is taken
// from summary.scan.areas so a domain whose reader failed (and was dropped from
// scan.areas) is visibly marked missing rather than silently shown as done.
const EXPECTED_DOMAINS: { id: string; label: string }[] = [
  { id: 'encryption', label: 'Encryption & keys' },
  { id: 'secrets', label: 'Secrets management' },
  { id: 'iam', label: 'IAM least-privilege' },
  { id: 'network', label: 'Network & WAF' },
  { id: 'backup', label: 'Backups & recovery' },
  { id: 'observability', label: 'Monitoring & tracing' },
  { id: 'audit', label: 'Audit trail' },
  { id: 'security', label: 'Security baseline' },
];
// NOTE on the loading visual: the backend returns the whole scan in one
// response, so there is no real per-domain progress to report. While the request
// is in flight every row shows the same indeterminate loading state (a generic
// shimmer, not a per-domain ticker); the real per-domain tally is filled in once
// the summary arrives.

type AnalysisState =
  | { kind: 'loading' }
  | { kind: 'done'; data: ControlAnalysis }
  | { kind: 'error'; message: string };

type BriefState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'done'; data: RemediationBrief }
  | { kind: 'error'; message: string };

function scoreColor(score: number): string {
  if (score >= 80) return 'text-success';
  if (score >= 50) return 'text-warning';
  return 'text-danger';
}

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

// ── Scan overlay ─────────────────────────────────────────────────────
function AreaCounts({ area }: { area: ScanArea | undefined }) {
  if (!area) return <span class="text-caption text-muted">no signals read</span>;
  const bits: { n: number; cls: string; label: string }[] = [
    { n: area.ok, cls: 'bg-success', label: 'ok' },
    { n: area.warn, cls: 'bg-warning', label: 'warn' },
    { n: area.crit, cls: 'bg-danger', label: 'crit' },
    { n: area.unknown, cls: 'bg-gray-400', label: 'unknown' },
  ].filter((b) => b.n > 0);
  return (
    <span class="inline-flex items-center gap-2">
      {bits.map((b) => (
        <span key={b.label} class="inline-flex items-center gap-1 text-caption text-secondary">
          <span class={`h-1.5 w-1.5 rounded-full ${b.cls}`} />
          {b.n} {b.label}
        </span>
      ))}
    </span>
  );
}

function ScanOverlay({
  summary,
  error,
  onClose,
  onRetry,
}: {
  summary: ComplianceSummary | null;
  error: string | null;
  onClose: () => void;
  onRetry: () => void;
}) {
  const complete = !error && summary !== null;

  // Drive the row list from the real scan once it lands. Each expected domain is
  // reconciled against summary.scan.areas: a domain the backend dropped (its
  // reader failed and returned no signals) is shown as "no signals read"
  // explicitly, so a missing domain is visible instead of silently vanishing.
  // Any area the backend returned that we did not list as expected is appended,
  // so the displayed domain count always matches scan.areas.
  const rows = (() => {
    if (!complete || !summary) {
      return EXPECTED_DOMAINS.map((d) => ({ id: d.id, label: d.label, area: undefined, missing: false }));
    }
    const seen = new Set<string>();
    const out: { id: string; label: string; area: ScanArea | undefined; missing: boolean }[] = [];
    for (const d of EXPECTED_DOMAINS) {
      const area = summary.scan.areas.find((a) => a.id === d.id);
      seen.add(d.id);
      out.push({ id: d.id, label: d.label, area, missing: !area });
    }
    for (const a of summary.scan.areas) {
      if (!seen.has(a.id)) out.push({ id: a.id, label: a.label, area: a, missing: false });
    }
    return out;
  })();

  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div class="absolute inset-0 bg-black/50 backdrop-blur-sm" />
      <div class="relative w-full max-w-lg bg-surface border border-border rounded-2xl shadow-xl p-6 page-enter">
        <div class="flex items-center gap-3 mb-4">
          <span
            class={`relative flex h-9 w-9 items-center justify-center rounded-full ${
              error ? 'bg-danger/10' : complete ? 'bg-success/10' : 'bg-primary/10'
            }`}
          >
            {error ? (
              <span class="text-danger text-lg">!</span>
            ) : complete ? (
              <svg class="w-5 h-5 text-success" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
            ) : (
              <>
                <span class="absolute inline-flex h-full w-full rounded-full bg-primary/30 animate-ping" />
                <svg class="w-5 h-5 text-primary" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
              </>
            )}
          </span>
          <div>
            <h2 class="text-heading-sm text-primary font-bold">
              {error ? 'Scan failed' : complete ? 'Scan complete' : 'Scanning your setup…'}
            </h2>
            <p class="text-caption text-muted">
              {error
                ? error
                : complete
                  ? `${summary?.evidenceCount ?? 0} live signals across ${summary?.scan.areas.length ?? 0} domains`
                  : 'Reading live AWS posture'}
            </p>
          </div>
        </div>

        {!error && (
          <div class="mb-4 h-1.5 w-full overflow-hidden rounded-full bg-surface-elevated">
            {complete ? (
              <div class="h-full bg-primary transition-all duration-300" style={{ width: '100%' }} />
            ) : (
              // Indeterminate shimmer: the backend returns the whole scan at once,
              // so there is no real fractional progress to report.
              <div class="h-full w-1/3 bg-primary animate-pulse rounded-full" />
            )}
          </div>
        )}

        <div class="space-y-1.5 max-h-[40vh] overflow-y-auto">
          {rows.map((r) => (
            <div key={r.id} class="flex items-center justify-between gap-3 rounded-lg px-2 py-1.5">
              <div class="flex items-center gap-2.5 min-w-0">
                {!complete && !error ? (
                  <span class="h-3.5 w-3.5 shrink-0 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                ) : r.missing ? (
                  <svg class="w-4 h-4 text-warning shrink-0" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="8" x2="12" y2="13" /><line x1="12" y1="16.5" x2="12" y2="16.5" /><circle cx="12" cy="12" r="9" /></svg>
                ) : (
                  <svg class="w-4 h-4 text-success shrink-0" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
                )}
                <span class={`text-body-sm truncate ${!complete ? 'text-secondary' : r.missing ? 'text-warning' : 'text-primary'}`}>{r.label}</span>
              </div>
              {complete && (r.missing ? <span class="text-caption text-warning">reader failed</span> : <AreaCounts area={r.area} />)}
            </div>
          ))}
        </div>

        {complete && summary && (
          <div class="mt-5 flex items-end justify-between gap-4 border-t border-border pt-4">
            <div class="flex gap-6">
              {summary.frameworks.map((fw) => (
                <div key={fw.id}>
                  <div class={`text-display-sm font-bold leading-none ${scoreColor(fw.score)}`}>{fw.score}%</div>
                  <p class="text-caption text-muted mt-1">{fw.label}</p>
                </div>
              ))}
            </div>
            <button onClick={onClose} class="text-body-sm font-medium px-4 py-2 rounded-lg bg-primary text-white hover:opacity-90 transition-opacity">
              View gaps →
            </button>
          </div>
        )}

        {error && (
          <div class="mt-5 flex justify-end gap-2 border-t border-border pt-4">
            <button onClick={onClose} class="text-body-sm font-medium px-4 py-2 rounded-lg border border-border text-secondary hover:text-primary hover:bg-surface-hover transition-colors">Close</button>
            <button onClick={onRetry} class="text-body-sm font-medium px-4 py-2 rounded-lg bg-primary text-white hover:opacity-90 transition-opacity">Retry scan</button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Remediation brief panel ──────────────────────────────────────────
function BriefPanel({ state, onClose }: { state: BriefState; onClose: () => void }) {
  const [copied, setCopied] = useState(false);

  async function copy(markdown: string) {
    const ok = await copyToClipboard(markdown);
    if (ok) {
      setCopied(true);
      toast('Brief copied. Paste it into Claude Code.', 'success');
      setTimeout(() => setCopied(false), 2000);
    } else {
      toast('Could not copy automatically; select the text and copy manually', 'error');
    }
  }

  return (
    <div class="mb-6 rounded-xl border border-primary/30 bg-primary/5 overflow-hidden">
      <div class="flex items-center justify-between gap-3 px-4 py-3 border-b border-primary/20">
        <div class="flex items-center gap-2 min-w-0">
          <Badge variant="info">Remediation brief</Badge>
          <span class="text-caption text-muted truncate">Paste into Claude Code, fix a batch, then re-scan</span>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          {state.kind === 'done' && (
            <button onClick={() => copy(state.data.markdown)} class="text-caption font-medium px-3 py-1.5 rounded-lg bg-primary text-white hover:opacity-90 transition-opacity">
              {copied ? 'Copied ✓' : 'Copy'}
            </button>
          )}
          <button onClick={onClose} class="text-caption font-medium px-2.5 py-1.5 rounded-lg border border-border text-secondary hover:text-primary hover:bg-surface-hover transition-colors" aria-label="Close brief">✕</button>
        </div>
      </div>
      <div class="p-4">
        {state.kind === 'loading' && <p class="text-body-sm text-muted">Assembling a plan from your current gaps…</p>}
        {state.kind === 'error' && <p class="text-body-sm text-danger">{state.message}</p>}
        {state.kind === 'done' && (
          <>
            <div class="flex flex-wrap gap-3 mb-3">
              <span class="text-caption text-secondary">SOC 2 <b class="font-mono">{state.data.stats.soc2Score}%</b></span>
              <span class="text-caption text-secondary">HIPAA <b class="font-mono">{state.data.stats.hipaaScore}%</b></span>
              <span class="text-caption text-danger">{state.data.stats.gap} gap</span>
              <span class="text-caption text-warning">{state.data.stats.partial} partial</span>
              <span class="text-caption text-muted">{state.data.stats.unknown} unverifiable</span>
              <span class="text-caption text-primary">{state.data.stats.manual} need a human</span>
            </div>
            <textarea
              readOnly
              class="w-full h-72 resize-y rounded-lg border border-border bg-surface p-3 text-caption font-mono text-secondary leading-relaxed"
              value={state.data.markdown}
              onClick={(e) => (e.target as HTMLTextAreaElement).select()}
            />
          </>
        )}
      </div>
    </div>
  );
}

// ── Framework results (unchanged shape) ──────────────────────────────
function ScoreHeader({ fw }: { fw: FrameworkResult }) {
  const total = COUNT_ORDER.reduce((s, k) => s + fw.counts[k], 0);
  return (
    <div data-tour="compliance-score" class="bg-surface border border-border rounded-xl p-5 mb-6">
      <div class="flex items-start gap-6 flex-wrap">
        <div class="shrink-0">
          <div class={`text-display-md font-bold leading-none ${scoreColor(fw.score)}`}>{fw.score}%</div>
          <p class="text-caption text-muted mt-1">{fw.gradedCount} verifiable control{fw.gradedCount === 1 ? '' : 's'} scored</p>
        </div>
        <div class="min-w-0 flex-1">
          <p class="text-body-sm text-secondary mb-3">{fw.description}</p>
          <div class="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-elevated" aria-hidden="true">
            {COUNT_ORDER.map((k) =>
              fw.counts[k] > 0 ? (
                <div key={k} class={STATUS_BAR[k]} style={{ width: `${(fw.counts[k] / Math.max(total, 1)) * 100}%` }} title={`${STATUS_LABEL[k]}: ${fw.counts[k]}`} />
              ) : null,
            )}
          </div>
          <div class="flex gap-3 flex-wrap mt-3">
            {COUNT_ORDER.map((k) => (
              <span key={k} class="inline-flex items-center gap-1.5 text-caption text-secondary">
                <span class={`h-2 w-2 rounded-full ${STATUS_BAR[k]}`} />
                {STATUS_LABEL[k]} <span class="font-mono text-muted">{fw.counts[k]}</span>
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function EvidenceChips({ evidence }: { evidence: ControlEvidence[] }) {
  if (evidence.length === 0) return null;
  return (
    <div class="flex flex-wrap gap-1.5 mt-2">
      {evidence.map((e) => (
        <span key={e.id} class="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-elevated px-2 py-0.5 text-caption text-secondary" title={e.detail}>
          <span class={`h-1.5 w-1.5 rounded-full ${EVIDENCE_DOT[e.status]}`} />
          {e.label}
        </span>
      ))}
    </div>
  );
}

function AnalysisPanel({ data }: { data: ControlAnalysis }) {
  const Section = ({ title, items }: { title: string; items: string[] }) =>
    items.length === 0 ? null : (
      <div class="mt-3">
        <p class="text-overline text-muted uppercase tracking-wider mb-1">{title}</p>
        <ul class="list-disc pl-5 space-y-1">
          {items.map((it, i) => (<li key={i} class="text-body-sm text-secondary">{it}</li>))}
        </ul>
      </div>
    );
  return (
    <div class="mt-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
      <div class="flex items-center gap-2 mb-2">
        <Badge variant="info">AI analysis</Badge>
        {data.edition && <span class="text-caption text-muted">{data.edition}</span>}
      </div>
      {data.requirement && (
        <div class="mb-2">
          <p class="text-overline text-muted uppercase tracking-wider mb-1">What the standard requires</p>
          <p class="text-body-sm text-secondary">{data.requirement}</p>
        </div>
      )}
      {data.currentState && (
        <div class="mb-1">
          <p class="text-overline text-muted uppercase tracking-wider mb-1">Your current state</p>
          <p class="text-body-sm text-secondary">{data.currentState}</p>
        </div>
      )}
      <Section title="Gaps" items={data.gaps} />
      <Section title="Remediation" items={data.remediation} />
      <Section title="References" items={data.references} />
      <p class="text-caption text-muted mt-3">Generated by {data.modelId}. Decision support, not a certification or legal advice.</p>
    </div>
  );
}

function ControlRow({ control, analysis, onAnalyze }: { control: EvaluatedControl; analysis: AnalysisState | undefined; onAnalyze: (id: string) => void }) {
  return (
    <div class="bg-surface border border-border rounded-xl p-4">
      <div class="flex items-start gap-3">
        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-2 flex-wrap">
            <Badge variant={STATUS_BADGE[control.status]}>{STATUS_LABEL[control.status]}</Badge>
            <span class="text-caption font-mono text-muted">{control.ref}</span>
            <span class="text-body-sm text-primary font-medium">{control.title}</span>
          </div>
          <p class="text-caption text-muted mt-1">{control.intent}</p>
          <EvidenceChips evidence={control.evidence} />
          {control.status !== 'met' && (
            <p class="text-caption text-secondary mt-2"><span class="text-muted">Fix:</span> {control.quickFix}</p>
          )}
        </div>
        <button onClick={() => onAnalyze(control.id)} disabled={analysis?.kind === 'loading'} class="shrink-0 text-caption font-medium px-3 py-1.5 rounded-lg border border-border text-secondary hover:text-primary hover:bg-surface-hover transition-colors disabled:opacity-50" title="Pull the latest SOC 2 / HIPAA guidance for this control and assess your setup">
          {analysis?.kind === 'loading' ? 'Analyzing…' : 'Latest guidance'}
        </button>
      </div>
      {analysis?.kind === 'done' && <AnalysisPanel data={analysis.data} />}
      {analysis?.kind === 'error' && <p class="text-caption text-danger mt-2">{analysis.message}</p>}
    </div>
  );
}

function FrameworkPanel({ fw, analyses, onAnalyze }: { fw: FrameworkResult; analyses: Record<string, AnalysisState>; onAnalyze: (id: string) => void }) {
  const groups: { category: string; controls: EvaluatedControl[] }[] = [];
  for (const ctl of fw.controls) {
    let g = groups.find((x) => x.category === ctl.category);
    if (!g) { g = { category: ctl.category, controls: [] }; groups.push(g); }
    g.controls.push(ctl);
  }
  return (
    <div>
      <ScoreHeader fw={fw} />
      <div class="space-y-6">
        {groups.map((g) => (
          <div key={g.category}>
            <p class="text-overline text-muted uppercase tracking-wider mb-2">{g.category}</p>
            <div class="space-y-3">
              {g.controls.map((ctl) => (<ControlRow key={ctl.id} control={ctl} analysis={analyses[ctl.id]} onAnalyze={onAnalyze} />))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Page ─────────────────────────────────────────────────────────────
export function Compliance() {
  const [summary, setSummary] = useState<ComplianceSummary | null>(null);
  const [active, setActive] = useState<ComplianceFrameworkId>('soc2');
  const [analyses, setAnalyses] = useState<Record<string, AnalysisState>>({});

  // Scan state.
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanResult, setScanResult] = useState<ComplianceSummary | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const dismissRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Brief state.
  const [brief, setBrief] = useState<BriefState | null>(null);
  const briefAbortRef = useRef<AbortController | null>(null);

  function runScan() {
    abortRef.current?.abort();
    if (dismissRef.current) { clearTimeout(dismissRef.current); dismissRef.current = null; }
    // Drop the read-through GET cache so a re-scan always hits the backend fresh
    // (compliance summary + brief are GETs; without this a re-scan within the
    // cache TTL could serve stale posture, breaking the scan->fix->re-scan loop).
    clearApiCache();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setScanError(null);
    setScanResult(null);
    setScanning(true);
    api.compliance
      .summary(ctrl.signal)
      .then((d) => {
        if (ctrl.signal.aborted) return;
        setScanResult(d);
        setSummary(d);
        // Auto-dismiss the overlay once the summary lands. We hold the
        // "Scan complete" panel briefly so the result is legible, then reveal
        // the page automatically — no click required. (On error we keep the
        // overlay up so Retry/Close stay reachable.)
        dismissRef.current = setTimeout(() => {
          setScanning(false);
          dismissRef.current = null;
        }, 900);
      })
      .catch((err) => { if (!ctrl.signal.aborted) setScanError(err instanceof Error ? err.message : 'Scan failed'); });
  }

  // Run a scan when the tab first opens.
  useEffect(() => {
    runScan();
    return () => {
      abortRef.current?.abort();
      if (dismissRef.current) clearTimeout(dismissRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function onAnalyze(controlId: string) {
    setAnalyses((prev) => ({ ...prev, [controlId]: { kind: 'loading' } }));
    try {
      const data = await api.compliance.analyze(controlId);
      setAnalyses((prev) => ({ ...prev, [controlId]: { kind: 'done', data } }));
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Analysis failed';
      setAnalyses((prev) => ({ ...prev, [controlId]: { kind: 'error', message } }));
      toast(`Analysis failed: ${message}`, 'error');
    }
  }

  async function generateBrief() {
    briefAbortRef.current?.abort();
    const ctrl = new AbortController();
    briefAbortRef.current = ctrl;
    setBrief({ kind: 'loading' });
    try {
      const data = await api.compliance.brief(ctrl.signal);
      if (ctrl.signal.aborted) return;
      setBrief({ kind: 'done', data });
    } catch (e) {
      if (ctrl.signal.aborted) return;
      const message = e instanceof Error ? e.message : 'Could not generate brief';
      setBrief({ kind: 'error', message });
      toast(message, 'error');
    }
  }

  const activeFw = summary?.frameworks.find((f) => f.id === active) ?? summary?.frameworks[0];

  return (
    <div>
      {scanning && (
        <ScanOverlay
          summary={scanResult}
          error={scanError}
          onClose={() => {
            if (dismissRef.current) { clearTimeout(dismissRef.current); dismissRef.current = null; }
            setScanning(false);
          }}
          onRetry={runScan}
        />
      )}

      <div class="mb-6 flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 data-tour="compliance-title" class="text-display-sm text-primary font-bold">Compliance</h1>
          <p class="text-body-sm text-secondary mt-1 max-w-2xl">
            SOC 2 and HIPAA coverage scored against your live AWS posture. Re-scan any time, generate a
            remediation brief to paste into Claude Code, fix a batch, then scan again. Repeat until only
            human/legal items remain.
          </p>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <button data-tour="compliance-brief" onClick={() => generateBrief()} disabled={!summary} class="text-caption font-medium px-3 py-1.5 rounded-lg border border-primary/40 text-primary hover:bg-primary/5 transition-colors disabled:opacity-50">
            Remediation brief
          </button>
          <button data-tour="compliance-rescan" onClick={runScan} disabled={scanning} class="text-caption font-medium px-3 py-1.5 rounded-lg bg-primary text-white hover:opacity-90 transition-opacity disabled:opacity-50">
            {scanning ? 'Scanning…' : 'Re-scan'}
          </button>
        </div>
      </div>

      {brief && <BriefPanel state={brief} onClose={() => { briefAbortRef.current?.abort(); setBrief(null); }} />}

      {summary?.disclaimer && (
        <div class="mb-6 rounded-lg border border-border bg-surface-elevated px-4 py-2.5">
          <p class="text-caption text-muted">{summary.disclaimer}</p>
        </div>
      )}

      <div data-tour="compliance-tabs" class="border-b border-border mb-6" role="tablist" aria-label="Compliance frameworks">
        <div class="flex gap-1 -mb-px overflow-x-auto">
          {(summary?.frameworks ?? []).map((fw) => {
            const isActive = fw.id === active;
            return (
              <button key={fw.id} role="tab" aria-selected={isActive} onClick={() => setActive(fw.id)}
                class={`px-4 py-2.5 text-body-sm font-medium border-b-2 transition-colors duration-fast whitespace-nowrap ${isActive ? 'border-primary text-primary' : 'border-transparent text-secondary hover:text-primary'}`}>
                {fw.label} <span class="text-caption font-mono text-muted">{fw.score}%</span>
              </button>
            );
          })}
        </div>
      </div>

      {!summary && !scanError ? (
        <div class="text-body-sm text-muted py-16 text-center">Preparing your first scan…</div>
      ) : activeFw ? (
        <FrameworkPanel fw={activeFw} analyses={analyses} onAnalyze={onAnalyze} />
      ) : (
        <EmptyState title="No compliance data" description="The scan returned no frameworks. Try re-scanning." />
      )}
    </div>
  );
}
