import { useRoute } from 'wouter-preact';
import {
  ApprovalRow,
  BackLink,
  HeaderStatus,
  KeepKey,
  PageTitle,
  RelativeTime,
  WorkError,
  WorkList,
  WorkLoading,
  words,
  type CaseDetail as CaseData,
  useWork,
} from './shared';
import { copy } from './messages';

export function CaseDetail() {
  const [, params] = useRoute('/work/cases/:caseId');
  const { data, error, loading, reload } = useWork<{ case: CaseData }>(
    `/cases/${encodeURIComponent(params?.caseId ?? '')}`,
  );
  if (loading || error || !data)
    return (
      <div class="min-w-0">
        <PageTitle title={copy.detail.caseTitle} />
        {loading ? (
          <WorkLoading detail />
        ) : (
          <WorkError
            error={error}
            retry={reload}
            notFound={{ title: copy.detail.caseNotFound, href: '/work/cases', label: copy.detail.backCases }}
          />
        )}
      </div>
    );
  const c = data.case;
  const facts = [
    ['Pipeline', c.pipeline.name],
    ['Stage', c.stage.name],
    ['Owner', c.owner.name ?? copy.row.unassigned],
    ['Case key', c.caseKey],
    ...c.fields.map((f) => [words(f.name), f.value]),
  ];
  return (
    <div class="min-w-0">
      <BackLink href="/work/cases" label={copy.detail.backCases} />
      <header class="mt-4 mb-8">
        <h1 class="text-display-sm text-primary font-bold break-words">
          <KeepKey text={c.title} caseKey={c.caseKey} />
        </h1>
        <div class="flex flex-wrap items-center gap-3 mt-2">
          <HeaderStatus status={c.status} />
          <span class="text-body-sm text-secondary">{c.stage.name}</span>
        </div>
      </header>
      {/* DOM order is reading order: summary, blockers, approvals, timeline, then facts.
          At lg the facts sit in the right column by grid placement only. */}
      <div class="grid gap-8 lg:grid-cols-work-detail">
        <div class="min-w-0 max-w-work-main space-y-8 lg:col-start-1 lg:row-start-1">
          {c.summary && (
            <p class="text-body text-primary max-w-measure whitespace-pre-wrap break-words">{c.summary}</p>
          )}
          {!!c.blockers.length && (
            <section>
              <h2 class="text-heading-sm text-primary mb-3">{copy.detail.blockers}</h2>
              <ul class="space-y-2">
                {c.blockers.map((b) => (
                  <li key={b.id} class="text-body-sm text-danger-text break-words">
                    {b.title}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section>
            <h2 class="text-heading-sm text-primary mb-3">{copy.detail.approvalsHeading}</h2>
            {c.approvals.length ? (
              <WorkList>
                {c.approvals.map((a) => (
                  <ApprovalRow key={a.id} item={a} stacked />
                ))}
              </WorkList>
            ) : (
              <p class="text-body-sm text-secondary">{copy.detail.noApprovals}</p>
            )}
          </section>
          <section>
            <h2 class="text-heading-sm text-primary mb-3">{copy.detail.timeline}</h2>
            {c.timeline.length ? (
              <ol class="divide-y divide-border border-y border-border">
                {c.timeline.map((e, i) => (
                  <li key={`${e.at}-${i}`} class="py-3">
                    <p class="text-body-sm text-primary whitespace-pre-wrap break-words">{e.text}</p>
                    <p class="text-caption text-secondary">
                      {e.actor ?? copy.detail.system} · <RelativeTime value={e.at} />
                    </p>
                  </li>
                ))}
              </ol>
            ) : (
              <p class="text-body-sm text-secondary">{copy.detail.noTimeline}</p>
            )}
          </section>
        </div>
        <aside class="min-w-0 lg:col-start-2 lg:row-start-1">
          <h2 class="text-heading-sm text-primary mb-3">{copy.detail.facts}</h2>
          <dl class="grid grid-cols-2 lg:grid-cols-1 gap-3 text-body-sm">
            {facts.map(([name, value], i) => (
              <div key={i} class="min-w-0">
                <dt class="text-caption text-secondary">{name}</dt>
                <dd class={`${name === 'Case key' ? 'font-mono' : ''} text-primary break-words whitespace-pre-wrap`}>
                  {value}
                </dd>
              </div>
            ))}
            <div>
              <dt class="text-caption text-secondary">Updated</dt>
              <dd class="text-primary">
                <RelativeTime value={c.updatedAt} />
              </dd>
            </div>
          </dl>
        </aside>
      </div>
    </div>
  );
}
