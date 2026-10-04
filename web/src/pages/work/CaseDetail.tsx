import { Link, useRoute } from 'wouter-preact';
import {
  ApprovalRow,
  RelativeTime,
  WorkError,
  WorkList,
  WorkLoading,
  WorkStatus,
  words,
  type CaseDetail as CaseData,
  useWork,
} from './shared';
export function CaseDetail() {
  const [, params] = useRoute('/work/cases/:caseId');
  const { data, error, loading, reload } = useWork<{ case: CaseData }>(
    `/cases/${encodeURIComponent(params?.caseId ?? '')}`,
  );
  if (loading) return <WorkLoading detail />;
  if (error || !data) return <WorkError error={error} retry={reload} back="/work/cases" />;
  const c = data.case;
  return (
    <div class="min-w-0">
      <Link
        href="/work/cases"
        class="inline-flex min-h-6 items-center text-body-sm text-primary underline focus-visible:ring-2 focus-visible:ring-primary"
      >
        Back to Cases
      </Link>
      <header class="mt-4 mb-8">
        <h1 class="text-heading-lg text-primary break-words">{c.title}</h1>
        <div class="flex flex-wrap items-center gap-3 mt-2">
          <WorkStatus status={c.status} />
          <span class="text-body-sm text-secondary">{c.stage.name}</span>
        </div>
      </header>
      <div class="grid lg:grid-cols-[minmax(0,1fr)_minmax(0,280px)] gap-8">
        <div class="min-w-0 lg:order-1 order-2 space-y-8">
          {c.summary && (
            <p class="text-body text-primary max-w-prose whitespace-pre-wrap break-words">{c.summary}</p>
          )}
          {!!c.blockers.length && (
            <section>
              <h2 class="text-heading-sm text-primary mb-3">Blockers</h2>
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
            <h2 class="text-heading-sm text-primary mb-3">Approvals</h2>
            {c.approvals.length ? (
              <WorkList>
                {c.approvals.map((a) => (
                  <ApprovalRow key={a.id} item={a} />
                ))}
              </WorkList>
            ) : (
              <p class="text-body-sm text-secondary">No approvals for this case.</p>
            )}
          </section>
          <section>
            <h2 class="text-heading-sm text-primary mb-3">Timeline</h2>
            {c.timeline.length ? (
              <ol class="divide-y divide-border border-y border-border">
                {c.timeline.map((e, i) => (
                  <li key={`${e.at}-${i}`} class="py-3">
                    <p class="text-body-sm text-primary whitespace-pre-wrap break-words">{e.text}</p>
                    <p class="text-caption text-secondary">
                      {e.actor ?? 'System'} · <RelativeTime value={e.at} />
                    </p>
                  </li>
                ))}
              </ol>
            ) : (
              <p class="text-body-sm text-secondary">No timeline entries yet.</p>
            )}
          </section>
        </div>
        <aside class="min-w-0 lg:order-2 order-1">
          <h2 class="text-heading-sm text-primary mb-3">Facts</h2>
          <dl class="grid sm:grid-cols-2 lg:grid-cols-1 gap-3 text-body-sm">
            {[
              ['Pipeline', c.pipeline.name],
              ['Stage', c.stage.name],
              ['Owner', c.owner.name ?? 'Unassigned'],
              ['Case key', c.caseKey],
              ...c.fields.map((f) => [words(f.name), f.value]),
            ].map(([name, value], i) => (
              <div key={i} class="min-w-0">
                <dt class="text-caption text-secondary">{name}</dt>
                <dd
                  class={`${name === 'Case key' ? 'font-mono' : ''} text-primary break-words whitespace-pre-wrap`}
                >
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
