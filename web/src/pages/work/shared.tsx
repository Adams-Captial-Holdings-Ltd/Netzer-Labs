import type { ComponentProps, ComponentChildren } from 'preact';
import { Link } from 'wouter-preact';
import { useEffect, useState } from 'preact/hooks';
import { api } from '../../lib/api';
import { Badge, type BadgeVariant } from '../../components/Badge';
import { ErrorState } from '../../components/ErrorState';
import { Skeleton } from '../../components/Skeleton';
import { StatusDot } from '../../components/StatusDot';
import { canRetry, copy, workMessage } from './messages';

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
    .replace(/(?:_|-)+/g, ' ')
    .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

const MINUTE = 60000;
const HOUR = 3600000;
const DAY = 86400000;
/** "3 days", "" for under a minute, null for a date that cannot be read. */
function elapsedWords(iso: string): string | null {
  const parsed = new Date(iso).getTime();
  if (!Number.isFinite(parsed)) return null;
  const delta = Math.max(0, Date.now() - parsed);
  if (delta < MINUTE) return '';
  const n = delta < HOUR ? Math.floor(delta / MINUTE) : delta < DAY ? Math.floor(delta / HOUR) : Math.floor(delta / DAY);
  const unit = delta < HOUR ? 'minute' : delta < DAY ? 'hour' : 'day';
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}
export function time(iso: string): string {
  const span = elapsedWords(iso);
  return span === null ? 'unknown time' : span === '' ? 'just now' : `${span} ago`;
}
/** How long something has waited, for example "3 days". */
export function waitedFor(iso: string): string {
  const span = elapsedWords(iso);
  return span === null ? 'unknown time' : span === '' ? 'less than a minute' : span;
}
export function RelativeTime({ value }: { value: string }) {
  const valid = Number.isFinite(new Date(value).getTime());
  return valid ? (
    <time class="tabular-nums" dateTime={value} title={new Date(value).toLocaleString()}>{time(value)}</time>
  ) : <span>unknown time</span>;
}

type Status = { name: string; dot: ComponentProps<typeof StatusDot>['status']; badge: BadgeVariant };
const statuses = new Map<string, Status>([
  ['pending', { name: copy.status.pending, dot: 'warning', badge: 'warning-dim' }],
  ['revision_requested', { name: copy.status.revision_requested, dot: 'warning', badge: 'warning-dim' }],
  ['approved', { name: copy.status.approved, dot: 'success', badge: 'success-dim' }],
  ['done', { name: copy.status.done, dot: 'success', badge: 'success-dim' }],
  ['rejected', { name: copy.status.rejected, dot: 'error', badge: 'danger-dim' }],
  ['blocked', { name: copy.status.blocked, dot: 'error', badge: 'danger-dim' }],
  ['active', { name: copy.status.active, dot: 'inactive', badge: 'default' }],
  ['cancelled', { name: copy.status.cancelled, dot: 'inactive', badge: 'default' }],
]);
function statusOf(status: string): Status {
  return statuses.get(status) ?? { name: words(status), dot: 'inactive', badge: 'default' };
}
/** A list row's status: a dot and a word, one text colour for every status. */
export function ListStatus({ status, label }: { status: string; label?: string }) {
  const s = statusOf(status);
  return <span class="whitespace-nowrap"><StatusDot status={s.dot} label={label ?? s.name} /></span>;
}
/** A detail header's status: one Badge. */
export function HeaderStatus({ status }: { status: string }) {
  const s = statusOf(status);
  return <Badge variant={s.badge}>{s.name}</Badge>;
}

/** The one link style on the Work screens: ink and underlined (the stock indigo fails 4.5:1 as text). */
export const linkClass =
  'inline-flex items-center min-h-11 md:min-h-6 text-body-sm text-primary underline underline-offset-2 hover:no-underline';

export function PageTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div class="mb-6">
      <h1 class="text-display-sm text-primary font-bold break-words">{title}</h1>
      {subtitle && <p class="text-body-sm text-secondary mt-1">{subtitle}</p>}
    </div>
  );
}

const LOADING_ROWS = 10;
export function WorkLoading({ detail = false }: { detail?: boolean }) {
  return (
    <div role="status">
      <span class="sr-only">{copy.loading}</span>
      {detail ? (
        <div aria-hidden="true" class="space-y-6">
          <Skeleton height="22px" width="40%" />
          <Skeleton height="160px" />
          <Skeleton height="96px" />
        </div>
      ) : (
        <ul aria-hidden="true" class="divide-y divide-border rounded-xl border border-border bg-surface overflow-hidden">
          {Array.from({ length: LOADING_ROWS }, (_, i) => (
            <li key={i} class="flex h-11 items-center gap-4 px-4">
              <Skeleton height="14px" width="45%" />
              <Skeleton height="12px" width="20%" />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
export function WorkError({
  error,
  retry,
  notFound,
}: {
  error: unknown;
  retry: () => void;
  notFound?: { title: string; href: string; label: string };
}) {
  const code = error instanceof Error ? error.message : String(error);
  if (code === 'not_found' && notFound)
    return (
      <div>
        <ErrorState title={notFound.title} message={workMessage(error)} />
        <p class="mt-4">
          <Link class={linkClass} href={notFound.href}>
            {notFound.label}
          </Link>
        </p>
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
export function WorkList({ children }: { children: ComponentChildren }) {
  return <ul class="divide-y divide-border rounded-xl border border-border bg-surface overflow-hidden">{children}</ul>;
}

// A row is one link. Below lg it is two lines: the title (two lines at most), then one metadata line
// that truncates, with the status at its end. At lg the cells sit in fixed tracks (tailwind.config.ts)
// so columns line up from row to row. `stacked` keeps the two-line form at every width, for a list in
// a narrow column. The keyboard position is the focus-bar rail, not a ring.
const rowClass = [
  'relative block min-w-0 min-h-11 px-4 py-1.5 hover:bg-row-hover',
  'focus-visible:outline-none focus-visible:bg-row-hover',
  'before:absolute before:inset-y-1 before:left-0 before:w-1 before:rounded-full before:bg-transparent',
  'focus-visible:before:bg-focus-bar',
].join(' ');
const gridClass = 'lg:grid lg:items-center lg:gap-x-4';
function RowTitle({ text, stacked }: { text: string; stacked: boolean }) {
  return (
    <span
      data-work="title"
      title={text}
      class={`block break-words line-clamp-2 text-body-sm font-medium text-primary
        ${stacked ? '' : 'lg:line-clamp-none lg:truncate'}`}
    >
      {text}
    </span>
  );
}
type Cell = [string, ComponentChildren, string?];
function RowMeta({ cells, status, stacked }: { cells: Cell[]; status?: ComponentChildren; stacked: boolean }) {
  return (
    <span class={`mt-0.5 flex min-w-0 items-center gap-3 ${stacked ? '' : 'lg:mt-0 lg:contents'}`}>
      <span
        data-work="meta"
        class={`min-w-0 flex-1 truncate text-caption text-secondary ${stacked ? '' : 'lg:contents'}`}
      >
        {cells.map(([key, content, title], i) => (
          <span
            key={key}
            title={title}
            class={`${key === 'key' ? 'font-mono' : ''} ${stacked ? '' : 'lg:block lg:min-w-0 lg:truncate'}`}
          >
            {i > 0 && <span aria-hidden="true" class={stacked ? '' : 'lg:hidden'}> · </span>}
            {content}
          </span>
        ))}
      </span>
      {status ? <span class={`shrink-0 ${stacked ? '' : 'lg:min-w-0'}`}>{status}</span> : null}
    </span>
  );
}

export function CaseRow({ item, inboxBlocked = false }: { item: CaseSummary; inboxBlocked?: boolean }) {
  const owner = item.owner.name ?? copy.row.unassigned;
  const stage = inboxBlocked ? copy.row.blockedAt(item.stage.name) : item.stage.name;
  const columns = inboxBlocked ? 'lg:grid-cols-work-case-row-quiet' : 'lg:grid-cols-work-case-row';
  return (
    <li>
      <Link href={`/work/cases/${encodeURIComponent(item.id)}`} class={`${rowClass} ${gridClass} ${columns}`}>
        <RowTitle text={item.title} stacked={false} />
        <RowMeta
          stacked={false}
          cells={[
            ['key', item.caseKey, item.caseKey],
            ['stage', stage, stage],
            ['owner', owner, owner],
            ['time', <RelativeTime value={item.updatedAt} />],
          ]}
          status={inboxBlocked ? undefined : <ListStatus status={item.status} />}
        />
      </Link>
    </li>
  );
}
export function ApprovalRow({
  item,
  inInbox = false,
  stacked = false,
}: {
  item: ApprovalSummary;
  inInbox?: boolean;
  stacked?: boolean;
}) {
  const title = `${item.decisionLabel} for ${item.caseTitle ?? item.caseKey}`;
  const stage = item.stageName ?? item.stage;
  // The list data cannot say why a person cannot decide, so this is the one honest word for it.
  const viewOnly = item.status === 'pending' && !item.canDecide;
  const columns = inInbox ? 'lg:grid-cols-work-approval-row-quiet' : 'lg:grid-cols-work-approval-row';
  return (
    <li>
      <Link
        href={`/work/approvals/${encodeURIComponent(item.id)}`}
        class={`${rowClass} ${stacked ? '' : `${gridClass} ${columns}`}`}
      >
        <RowTitle text={title} stacked={stacked} />
        <RowMeta
          stacked={stacked}
          cells={[
            ['key', item.caseKey, item.caseKey],
            ['stage', stage, stage],
            [
              'time',
              inInbox ? copy.row.waitingFor(waitedFor(item.requestedAt))
                : <>{copy.requested}{' '}<RelativeTime value={item.requestedAt} /></>,
            ],
          ]}
          status={inInbox ? undefined : (
            <ListStatus status={item.status} label={viewOnly ? copy.row.waitingOnOthers : undefined} />
          )}
        />
      </Link>
    </li>
  );
}
