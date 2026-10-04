import {
  ApprovalRow,
  CaseRow,
  WorkError,
  WorkList,
  WorkLoading,
  type ApprovalSummary,
  type CaseSummary,
  useWork,
} from './shared';
export function Inbox() {
  const { data, error, loading, reload } = useWork<{
    approverSetUp: boolean;
    approvals: ApprovalSummary[];
    blocked: CaseSummary[];
    mine: CaseSummary[];
  }>('/inbox');
  if (loading) return <WorkLoading />;
  if (error || !data) return <WorkError error={error} retry={reload} />;
  const none = !data.approvals.length && !data.blocked.length && !data.mine.length;
  return (
    <div class="space-y-8 min-w-0">
      <h1 class="text-heading-lg text-primary">Work Inbox</h1>
      {none && <p class="text-body-sm text-secondary">Nothing needs you</p>}
      <section>
        <h2 class="text-heading-sm text-primary mb-3">Waiting for your decision</h2>
        {!data.approverSetUp ? (
          <p class="text-body-sm text-secondary">You are not set up to approve. Ask an admin.</p>
        ) : data.approvals.length ? (
          <WorkList>
            {data.approvals.map((a) => (
              <ApprovalRow key={a.id} item={a} />
            ))}
          </WorkList>
        ) : (
          <p class="text-body-sm text-secondary">Nothing waiting for your decision.</p>
        )}
      </section>
      <section>
        <h2 class="text-heading-sm text-primary mb-3">Blocked</h2>
        {data.blocked.length ? (
          <WorkList>
            {data.blocked.map((c) => (
              <CaseRow key={c.id} item={c} />
            ))}
          </WorkList>
        ) : (
          <p class="text-body-sm text-secondary">No blocked cases.</p>
        )}
      </section>
      <section>
        <h2 class="text-heading-sm text-primary mb-3">Yours</h2>
        {data.mine.length ? (
          <WorkList>
            {data.mine.map((c) => (
              <CaseRow key={c.id} item={c} />
            ))}
          </WorkList>
        ) : (
          <p class="text-body-sm text-secondary">No cases assigned to you.</p>
        )}
      </section>
    </div>
  );
}
