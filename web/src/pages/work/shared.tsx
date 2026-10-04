import { Link } from 'wouter-preact';
import { useEffect, useState } from 'preact/hooks';
import { api } from '../../lib/api';
import { ErrorState } from '../../components/ErrorState';
import { Skeleton } from '../../components/Skeleton';
import { canRetry, workMessage } from './messages';

export type CaseSummary = {
  id: string;
  caseKey: string;
  title: string;
  pipeline: { id: string; name: string };
  stage: { id: string; key: string; name: string; kind: string };
  status: 'active' | 'blocked' | 'done' | 'cancelled';
  owner: { kind: 'agent' | 'person' | 'none'; name: string | null };
  updatedAt: string;
};
export type ApprovalSummary = {
  id: string;
  status: 'pending' | 'revision_requested' | 'approved' | 'rejected' | 'cancelled';
  decisionClass: string;
  decisionLabel: string;
  caseId: string | null;
  caseKey: string;
  caseTitle: string | null;
  stage: string;
  stageName: string | null;
  step: string;
  stageEntryNo: number;
  requestedAt: string;
  decidedAt: string | null;
  canDecide: boolean;
};
export type ApprovalDetail = ApprovalSummary & {
  payloadSha256: string;
  payload: { state: 'verified'; value: unknown } | { state: 'unavailable' | 'mismatch' };
  cannotDecideReason: string | null;
  decidedBy: string | null;
  decisionComment: string | null;
};
export type CaseDetail = CaseSummary & {
  summary: string | null;
  fields: { name: string; value: string }[];
  blockers: { id: string; title: string }[];
  timeline: { at: string; kind: 'event' | 'comment'; actor: string | null; text: string }[];
  approvals: ApprovalSummary[];
};
export type PipelineSummary = {
  id: string;
  name: string;
  stages: { id: string; key: string; name: string; kind: string }[];
};

export function words(s: string): string {
  return s
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}
export function time(iso: string): string {
  const parsed = new Date(iso).getTime();
  if (!Number.isFinite(parsed)) return 'unknown time';
  const delta = Math.max(0, Date.now() - parsed);
  if (delta < 60000) return 'just now';
  const n =
    delta < 3600000
      ? Math.floor(delta / 60000)
      : delta < 86400000
        ? Math.floor(delta / 3600000)
        : Math.floor(delta / 86400000);
  const unit = delta < 3600000 ? 'minute' : delta < 86400000 ? 'hour' : 'day';
  return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
}
export function RelativeTime({ value }: { value: string }) {
  const valid = Number.isFinite(new Date(value).getTime());
  return valid ? (
    <time dateTime={value} title={new Date(value).toLocaleString()}>{time(value)}</time>
  ) : <span>unknown time</span>;
}
const statusNames: Record<string, string> = {
  pending: 'Waiting',
  revision_requested: 'Changes requested',
  approved: 'Approved',
  rejected: 'Rejected',
  blocked: 'Blocked',
  done: 'Done',
  active: 'Active',
  cancelled: 'Cancelled',
};
export function WorkStatus({ status }: { status: string }) {
  const color = ['pending', 'revision_requested'].includes(status)
    ? 'warning'
    : ['approved', 'done'].includes(status)
      ? 'success'
      : ['rejected', 'blocked'].includes(status)
        ? 'danger'
        : 'neutral';
  const classes = {
    warning: 'bg-[var(--color-warning-dim)] text-primary',
    success: 'bg-[var(--color-success-dim)] text-primary',
    danger: 'bg-[var(--color-danger-dim)] text-danger-text',
    neutral: 'bg-surface text-secondary',
  };
  const dots = {
    warning: 'bg-warning',
    success: 'bg-success',
    danger: 'bg-danger',
    neutral: 'bg-[var(--color-text-muted)]',
  };
  return (
    <span class={`inline-flex items-center gap-2 rounded-md px-2 py-1 text-caption ${classes[color]}`}>
      <span class={`h-2 w-2 rounded-full ${dots[color]}`} />
      {statusNames[status] ?? words(status)}
    </span>
  );
}
export function WorkLoading({ detail = false }: { detail?: boolean }) {
  return (
    <div role="status" class="space-y-3">
      <span class="sr-only">Loading</span>
      <Skeleton class="h-7 w-1/3" />
      {Array.from({ length: detail ? 3 : 10 }, (_, i) => (
        <Skeleton key={i} class="h-12 w-full" />
      ))}
    </div>
  );
}
export function WorkError({ error, retry, back }: { error: unknown; retry: () => void; back?: string }) {
  const code = error instanceof Error ? error.message : String(error);
  if (code === 'not_found' && back)
    return (
      <div>
        <p class="text-body-sm text-danger-text">{workMessage(error)}</p>
        <Link class="inline-flex min-h-6 items-center text-primary underline focus-visible:ring-2 focus-visible:ring-primary" href={back}>
          Back to list
        </Link>
      </div>
    );
  return <ErrorState message={workMessage(error)} onRetry={canRetry(error) ? retry : undefined} />;
}
export function useWork<T>(path: string) {
  const [result, setResult] = useState<{ path: string; value: T } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const ac = new AbortController();
    setLoading(true);
    setError(null);
    api
      .get<T>(`/work${path}${path.includes('?') ? '&' : '?'}_=${Date.now()}-${version}`, ac.signal)
      .then((value) => setResult({ path, value }))
      .catch((e) => {
        if (!ac.signal.aborted) setError(e);
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [path, version]);
  return {
    data: result?.path === path ? result.value : null,
    error,
    loading: loading || (result?.path !== path && !error),
    replace: (value: T) => setResult({ path, value }),
    reload: () => setVersion((v) => v + 1),
  };
}
export function WorkList({ children }: { children: preact.ComponentChildren }) {
  return <ul class="divide-y divide-border rounded-lg border border-border bg-surface">{children}</ul>;
}
export const rowClass = [
  'grid grid-cols-[minmax(0,1fr)_auto] md:flex md:items-center gap-x-4 min-h-11 px-4 py-1.5',
  'hover:bg-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
  'focus-visible:bg-row-active min-w-0',
].join(' ');
export function CaseRow({ item }: { item: CaseSummary }) {
  return (
    <li>
      <Link href={`/work/cases/${encodeURIComponent(item.id)}`} class={rowClass}>
        <span class="text-body-sm font-medium text-primary break-words min-w-0 md:flex-1 md:truncate">
          {item.title}
        </span>
        <p class="col-span-2 text-caption text-secondary break-words md:col-auto md:min-w-0 md:truncate">
          <span class="font-mono">{item.caseKey}</span> · {item.pipeline.name} · {item.stage.name} ·{' '}
          {item.owner.name ?? 'Unassigned'} · <RelativeTime value={item.updatedAt} />
        </p>
        <span class="row-start-1 col-start-2 md:row-auto md:col-auto">
          <WorkStatus status={item.status} />
        </span>
      </Link>
    </li>
  );
}
export function ApprovalRow({ item }: { item: ApprovalSummary }) {
  return (
    <li>
      <Link href={`/work/approvals/${encodeURIComponent(item.id)}`} class={rowClass}>
        <span class="text-body-sm font-medium text-primary break-words min-w-0 md:flex-1 md:truncate">
          {item.decisionLabel} for {item.caseTitle ?? <span class="font-mono">{item.caseKey}</span>}
        </span>
        <p class="col-span-2 text-caption text-secondary md:col-auto md:min-w-0 md:truncate">
          {item.stageName ?? item.stage} · <RelativeTime value={item.requestedAt} />
          {!item.canDecide && item.status === 'pending' ? ' · View only' : ''}
        </p>
        <span class="row-start-1 col-start-2 md:row-auto md:col-auto">
          <WorkStatus status={item.status} />
        </span>
      </Link>
    </li>
  );
}
