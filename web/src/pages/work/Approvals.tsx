import { Link, useSearch } from 'wouter-preact';
import { EmptyState } from '../../components/EmptyState';
import { ApprovalRow, PageTitle, WorkError, WorkList, WorkLoading, type ApprovalSummary, useWork } from './shared';
import { copy } from './messages';

// The tab classes AgentDetail uses. The first tab sits on the content edge.
const tabClass = 'px-4 first:pl-0 py-2.5 text-body-sm font-medium border-b-2 transition-colors whitespace-nowrap';

// On the Waiting tab the rows the person can decide come first. The sort is stable, so each group keeps the API order.
const decidableFirst = (rows: ApprovalSummary[]) => rows.slice().sort((a, b) => Number(b.canDecide) - Number(a.canDecide));

export function Approvals() {
  const params = new URLSearchParams(useSearch());
  const status = params.get('status') === 'all' ? 'all' : 'pending';
  const { data, error, loading, reload } = useWork<{ approvals: ApprovalSummary[]; truncated: boolean }>(
    `/approvals?status=${status}`,
  );
  return (
    <div class="min-w-0">
      <PageTitle title={copy.approvals.title} subtitle={copy.approvals.subtitle} />
      <nav aria-label={copy.approvals.tabs} class="flex gap-1 mb-6 border-b border-border overflow-x-auto">
        {[
          ['pending', copy.approvals.waiting],
          ['all', copy.approvals.all],
        ].map(([key, label]) => (
          <Link
            key={key}
            href={`/work/approvals?status=${key}`}
            aria-current={status === key ? 'page' : undefined}
            class={`${tabClass} ${
              status === key ? 'border-primary text-primary' : 'border-transparent text-secondary hover:text-primary'
            }`}
          >
            {label}
          </Link>
        ))}
      </nav>
      {loading ? (
        <WorkLoading />
      ) : error || !data ? (
        <WorkError error={error} retry={reload} />
      ) : (
        <>
          {data.approvals.length ? (
            <WorkList>
              {(status === 'pending' ? decidableFirst(data.approvals) : data.approvals).map((a) => (
                <ApprovalRow key={a.id} item={a} />
              ))}
            </WorkList>
          ) : (
            <EmptyState title={copy.approvals.empty} />
          )}
          {data.truncated && <p class="text-caption text-secondary mt-3">{copy.approvals.truncated}</p>}
        </>
      )}
    </div>
  );
}
