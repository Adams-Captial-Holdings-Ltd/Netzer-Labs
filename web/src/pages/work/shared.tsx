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

/** Shows `text` with the case key kept whole: the key never breaks at its hyphen, the rest wraps as usual. */
export function KeepKey({ text, caseKey }: { text: string; caseKey: string }) {
  const at = caseKey ? text.indexOf(caseKey) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <span class="whitespace-nowrap">{caseKey}</span>
      {text.slice(at + caseKey.length)}
    </>
  );
}

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
function time(iso: string): string {
  const span = elapsedWords(iso);
  return span === null ? 'unknown time' : span === '' ? 'just now' : `${span} ago`;
}
/** How long something has waited, for example "3 days". */
function waitedFor(iso: string): string {
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
  ['active', { name: copy.status.active, dot: 'inactive', badge: 'neutral-dim' }],
  ['cancelled', { name: copy.status.cancelled, dot: 'inactive', badge: 'neutral-dim' }],
]);
function statusOf(status: string): Status {
  return statuses.get(status) ?? { name: words(status), dot: 'inactive', badge: 'neutral-dim' };
}
/** A list row's status: a dot and a word, one text colour for every status. */
function ListStatus({ status, label }: { status: string; label?: string }) {
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

/** A back link: the arrow is decoration, the name is the words. */
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link href={href} class={linkClass}>
      <span aria-hidden="true">&larr;&nbsp;</span>
      {label}
    </Link>
  );
}

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
          <BackLink href={notFound.href} label={notFound.label} />
        </p>
      </div>
    );
  return (
    <ErrorState
      title={code === 'forbidden' ? copy.error.noAccess : undefined}
      message={code === 'forbidden' ? copy.error.askAdmin : workMessage(error)}
      onRetry={canRetry(error) ? retry : undefined}
    />
  );
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
// that the status never truncates: the status takes its own trailing line in every row, so its place and
// the row heights stay alike within a list. At lg the cells sit in the shared
// grid (tailwind.config.ts) whose only flexible track is the title, so columns line up from row to row
// and the title takes all spare width. `stacked` keeps the two-line form at every width, for a list in
// a narrow column. The keyboard position is the focus-bar rail, not a ring.
const rowClass = [
  'relative block min-w-0 min-h-11 px-4 py-1.5 hover:bg-row-hover',
  'focus-visible:outline-none focus-visible:bg-row-hover',
  'before:absolute before:inset-y-1 before:left-0 before:w-1 before:rounded-full before:bg-transparent',
  'focus-visible:before:bg-focus-bar',
].join(' ');
const gridClass = 'lg:grid lg:items-center lg:gap-x-3';
const gridColumns = (showKey: boolean) => (showKey ? 'lg:grid-cols-work-row-key' : 'lg:grid-cols-work-row');
function RowTitle({ text, stacked, muted = false }: { text: string; stacked: boolean; muted?: boolean }) {
  return (
    <span
      data-work="title"
      title={text}
      class={`block break-words line-clamp-2 text-body-sm font-medium ${muted ? 'text-secondary' : 'text-primary'}
        ${stacked ? '' : 'lg:line-clamp-none lg:truncate'}`}
    >
      {text}
    </span>
  );
}
/** One metadata cell. `wide` takes two grid tracks at lg. */
type Cell = { key: string; content: ComponentChildren; title?: string; wide?: boolean };
function RowMeta({ cells, status, stacked }: { cells: Cell[]; status?: ComponentChildren; stacked: boolean }) {
  return (
    <span class={`mt-0.5 flex min-w-0 flex-wrap items-center gap-x-3 ${stacked ? '' : 'lg:mt-0 lg:contents'}`}>
      <span
        data-work="meta"
        class={`min-w-0 max-w-full text-caption text-secondary ${stacked ? 'lg:truncate' : 'lg:contents'}`}
      >
        {cells.map(({ key, content, title, wide }, i) => (
          <span
            key={key}
            title={title}
            class={`${key === 'key' ? 'font-mono' : ''}
              ${stacked ? '' : `lg:block lg:min-w-0 lg:truncate ${wide ? 'lg:col-span-2' : ''}`}`}
          >
            {i > 0 && (
              <span class={stacked ? '' : 'lg:hidden'}>
                <span aria-hidden="true"> · </span>
                <span class="sr-only">, </span>
              </span>
            )}
            {content}
          </span>
        ))}
      </span>
      {status ? <span class={`shrink-0 text-caption max-lg:basis-full ${stacked ? '' : 'lg:min-w-0'}`}>{status}</span> : null}
    </span>
  );
}
/** The case key as its own cell, only when the title does not already hold it. */
const keyCell = (title: string, caseKey: string): Cell[] =>
  title.includes(caseKey) ? [] : [{ key: 'key', content: caseKey, title: caseKey }];

export function CaseRow({ item, inboxBlocked = false }: { item: CaseSummary; inboxBlocked?: boolean }) {
  const owner = item.owner.name ?? copy.row.unassigned;
  const key = keyCell(item.title, item.caseKey);
  const stage = copy.row.blockedAt(item.stage.name);
  const updated: Cell = { key: 'time', content: <RelativeTime value={item.updatedAt} /> };
  // The Inbox payload carries no blocker reason, so a blocked row ends by saying where to find it (the
  // status slot, which drops to its own line when it does not fit). It has no room for the owner at lg.
  const cells: Cell[] = inboxBlocked
    ? [...key, { key: 'stage', content: stage, title: stage, wide: true }, updated]
    : [...key, { key: 'stage', content: item.stage.name, title: item.stage.name },
      { key: 'owner', content: owner, title: owner }, updated];
  return (
    <li>
      <Link href={`/work/cases/${encodeURIComponent(item.id)}`} class={`${rowClass} ${gridClass} ${gridColumns(!!key.length)}`}>
        <RowTitle text={item.title} stacked={false} />
        <RowMeta
          stacked={false}
          cells={cells}
          status={inboxBlocked
            ? <span class="text-caption text-secondary whitespace-nowrap">{copy.row.openToSee}</span>
            : <ListStatus status={item.status} />}
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
  const key = keyCell(title, item.caseKey);
  // The list data cannot say why a person cannot decide, so this is the one honest word for it.
  const viewOnly = item.status === 'pending' && !item.canDecide;
  return (
    <li>
      <Link
        href={`/work/approvals/${encodeURIComponent(item.id)}`}
        class={`${rowClass} ${stacked ? '' : `${gridClass} ${gridColumns(!!key.length)}`}`}
      >
        <RowTitle text={title} stacked={stacked} muted={viewOnly} />
        <RowMeta
          stacked={stacked}
          cells={[
            ...key,
            { key: 'stage', content: stage, title: stage },
            {
              key: 'time',
              content: inInbox ? copy.row.waitingFor(waitedFor(item.requestedAt))
                : <>{copy.requested}{' '}<RelativeTime value={item.requestedAt} /></>,
              wide: true,
            },
          ]}
          status={inInbox ? undefined : (
            <ListStatus status={item.status} label={viewOnly ? copy.row.waitingViewOnly : undefined} />
          )}
        />
      </Link>
    </li>
  );
}
