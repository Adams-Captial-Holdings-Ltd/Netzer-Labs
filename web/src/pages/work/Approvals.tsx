import { Link, useSearchParams } from 'wouter-preact';
import { ApprovalRow, WorkError, WorkList, WorkLoading, type ApprovalSummary, useWork } from './shared';
export function Approvals() {
  const [params] = useSearchParams();
  const status = params.get('status') === 'all' ? 'all' : 'pending';
  const { data, error, loading, reload } = useWork<{ approvals: ApprovalSummary[]; truncated: boolean }>(
    `/approvals?status=${status}`,
  );
  return (
    <div class="min-w-0">
      <h1 class="text-heading-lg text-primary mb-6">Approvals</h1>
      <nav aria-label="Approval tabs" class="flex gap-6 border-b border-border mb-4">
        {[
          ['pending', 'Waiting'],
          ['all', 'All'],
        ].map(([key, label]) => (
          <Link
            key={key}
            href={`/work/approvals?status=${key}`}
            aria-current={status === key ? 'page' : undefined}
            class={`text-body-sm py-2 focus-visible:ring-2 focus-visible:ring-primary
              ${status === key ? 'text-primary border-b-2 border-primary' : 'text-secondary'}`}
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
              {data.approvals.map((a) => (
                <ApprovalRow key={a.id} item={a} />
              ))}
            </WorkList>
          ) : (
            <p class="text-body-sm text-secondary">No approvals here.</p>
          )}
          {data.truncated && (
            <p class="text-caption text-secondary mt-3">
              Showing the first 200. Narrow the filters to find others.
            </p>
          )}
        </>
      )}
    </div>
  );
}
