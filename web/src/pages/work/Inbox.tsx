import { Inbox as InboxIcon } from 'lucide-preact';
import { EmptyState } from '../../components/EmptyState';
import {
  ApprovalRow,
  CaseRow,
  PageTitle,
  WorkError,
  WorkList,
  WorkLoading,
  type ApprovalSummary,
  type CaseSummary,
  useWork,
} from './shared';
import { copy } from './messages';

export function Inbox() {
  const { data, error, loading, reload } = useWork<{
    approverSetUp: boolean;
    approvals: ApprovalSummary[];
    blocked: CaseSummary[];
    mine: CaseSummary[];
  }>('/inbox');
  const title = <PageTitle title={copy.inbox.title} subtitle={copy.inbox.subtitle} />;
  if (loading)
    return (
      <div class="min-w-0">
        {title}
        <WorkLoading />
      </div>
    );
  if (error || !data)
    return (
      <div class="min-w-0">
        {title}
        <WorkError error={error} retry={reload} />
      </div>
    );
  const none = !data.approvals.length && !data.blocked.length && !data.mine.length;
  if (none)
    return (
      <div class="min-w-0">
        {title}
        <EmptyState
          icon={<InboxIcon size={48} strokeWidth={1.5} class="text-muted" aria-hidden="true" />}
          title={data.approverSetUp ? copy.inbox.nothing : copy.inbox.notSetUp}
          description={data.approverSetUp ? copy.inbox.nothingHint : undefined}
        />
      </div>
    );
  return (
    <div class="space-y-8 min-w-0">
      {title}
      <section>
        <h2 class="text-heading-sm text-primary mb-3">{copy.inbox.waiting}</h2>
        {!data.approverSetUp ? (
          <p class="text-body-sm text-secondary">{copy.inbox.notSetUp}</p>
        ) : data.approvals.length ? (
          <WorkList>
            {data.approvals.map((a) => (
              <ApprovalRow key={a.id} item={a} inInbox />
            ))}
          </WorkList>
        ) : (
          <p class="text-body-sm text-secondary">{copy.inbox.noneWaiting}</p>
        )}
      </section>
      <section>
        <h2 class="text-heading-sm text-primary mb-3">{copy.inbox.blocked}</h2>
        {data.blocked.length ? (
          <WorkList>
            {data.blocked.map((c) => (
              <CaseRow key={c.id} item={c} inboxBlocked />
            ))}
          </WorkList>
        ) : (
          <p class="text-body-sm text-secondary">{copy.inbox.noneBlocked}</p>
        )}
      </section>
      <section>
        <h2 class="text-heading-sm text-primary mb-3">{copy.inbox.mine}</h2>
        {data.mine.length ? (
          <WorkList>
            {data.mine.map((c) => (
              <CaseRow key={c.id} item={c} />
            ))}
          </WorkList>
        ) : (
          <p class="text-body-sm text-secondary">{copy.inbox.noneMine}</p>
        )}
      </section>
    </div>
  );
}
