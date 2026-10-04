import { useSearchParams } from 'wouter-preact';
import {
  CaseRow,
  WorkError,
  WorkList,
  WorkLoading,
  type CaseSummary,
  type PipelineSummary,
  useWork,
} from './shared';
export function Cases() {
  const [params, setParams] = useSearchParams();
  const pipeline = params.get('pipeline') ?? '',
    stage = params.get('stage') ?? '',
    status = params.get('status') ?? 'active';
  const query = new URLSearchParams();
  if (pipeline) query.set('pipeline', pipeline);
  if (stage) query.set('stage', stage);
  query.set('status', status);
  const { data, error, loading, reload } = useWork<{
    cases: CaseSummary[];
    pipelines: PipelineSummary[];
    truncated: boolean;
  }>(`/cases?${query}`);
  const change = (key: string, value: string) => {
    const next = new URLSearchParams(query);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key === 'pipeline') next.delete('stage');
    setParams(next);
  };
  return (
    <div class="min-w-0">
      <h1 class="text-heading-lg text-primary mb-6">Cases</h1>
      <div class="flex flex-wrap gap-3 mb-4">
        <label class="text-caption text-secondary">
          Pipeline{' '}
          <select
            aria-label="Pipeline"
            class="block rounded-md border border-border bg-surface text-primary p-2
              focus-visible:ring-2 focus-visible:ring-primary"
            value={pipeline}
            onChange={(e) => change('pipeline', e.currentTarget.value)}
          >
            <option value="">All pipelines</option>
            {data?.pipelines.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label class="text-caption text-secondary">
          Stage{' '}
          <select
            aria-label="Stage"
            class="block rounded-md border border-border bg-surface text-primary p-2
              focus-visible:ring-2 focus-visible:ring-primary"
            value={stage}
            onChange={(e) => change('stage', e.currentTarget.value)}
          >
            <option value="">All stages</option>
            {data?.pipelines
              .find((p) => p.id === pipeline)
              ?.stages.map((s) => (
                <option key={s.id} value={s.key}>
                  {s.name}
                </option>
              ))}
          </select>
        </label>
        <label class="text-caption text-secondary">
          Status{' '}
          <select
            aria-label="Status"
            class="block rounded-md border border-border bg-surface text-primary p-2
              focus-visible:ring-2 focus-visible:ring-primary"
            value={status}
            onChange={(e) => change('status', e.currentTarget.value)}
          >
            {['active', 'blocked', 'done', 'all'].map((s) => (
              <option key={s} value={s}>
                {s[0].toUpperCase() + s.slice(1)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {loading ? (
        <WorkLoading />
      ) : error || !data ? (
        <WorkError error={error} retry={reload} />
      ) : (
        <>
          {data.cases.length ? (
            <WorkList>
              {data.cases.map((c) => (
                <CaseRow key={c.id} item={c} />
              ))}
            </WorkList>
          ) : (
            <p class="text-body-sm text-secondary">No cases match these filters.</p>
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
