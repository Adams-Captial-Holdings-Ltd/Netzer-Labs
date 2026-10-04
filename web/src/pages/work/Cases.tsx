import { useEffect, useState } from 'preact/hooks';
import { useSearchParams } from 'wouter-preact';
import { EmptyState } from '../../components/EmptyState';
import { Select } from '../../components/Select';
import {
  CaseRow,
  PageTitle,
  WorkError,
  WorkList,
  WorkLoading,
  type CaseSummary,
  type PipelineSummary,
  useWork,
} from './shared';
import { copy } from './messages';

const statusOptions = [
  { value: 'active', label: copy.cases.open },
  { value: 'blocked', label: copy.cases.blocked },
  { value: 'done', label: copy.cases.done },
  { value: 'all', label: copy.cases.all },
];
const STATUS_VALUES = statusOptions.map((o) => o.value);
// 44 px tall and 16 px text below md (the touch size), the app's own size from md up.
const touchSelect = 'min-h-11 max-md:text-base md:min-h-0';

function Filter({ id, label, children }: { id: string; label: string; children: preact.ComponentChildren }) {
  return (
    <div>
      <label for={id} class="block text-caption text-secondary mb-1">
        {label}
      </label>
      {children}
    </div>
  );
}

export function Cases() {
  const [params, setParams] = useSearchParams();
  const pipeline = params.get('pipeline') ?? '',
    stage = params.get('stage') ?? '',
    requestedStatus = params.get('status') ?? 'active';
  const status = STATUS_VALUES.includes(requestedStatus) ? requestedStatus : 'active';
  const query = new URLSearchParams();
  if (pipeline) query.set('pipeline', pipeline);
  if (stage) query.set('stage', stage);
  query.set('status', status);
  const { data, error, loading, reload } = useWork<{
    cases: CaseSummary[];
    pipelines: PipelineSummary[];
    truncated: boolean;
  }>(`/cases?${query}`);
  const [lastPipelines, setLastPipelines] = useState<PipelineSummary[]>([]);
  useEffect(() => {
    if (data?.pipelines) setLastPipelines(data.pipelines);
  }, [data?.pipelines]);
  const pipelines = data?.pipelines ?? lastPipelines;
  const stages = pipelines.find((p) => p.id === pipeline)?.stages ?? [];
  const change = (key: string, value: string) => {
    const next = new URLSearchParams(query);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key === 'pipeline') next.delete('stage');
    setParams(next);
  };
  return (
    <div class="min-w-0">
      <PageTitle title={copy.cases.title} subtitle={copy.cases.subtitle} />
      <div class="flex flex-wrap gap-3 mb-4">
        <Filter id="work-pipeline" label={copy.cases.pipeline}>
          <Select
            id="work-pipeline"
            triggerClass={touchSelect}
            value={pipeline}
            onChange={(value) => change('pipeline', value)}
            options={[
              { value: '', label: copy.cases.allPipelines },
              ...pipelines.map((p) => ({ value: p.id, label: p.name })),
            ]}
          />
        </Filter>
        <Filter id="work-stage" label={copy.cases.stage}>
          <Select
            id="work-stage"
            triggerClass={touchSelect}
            disabled={!pipeline}
            value={stage}
            onChange={(value) => change('stage', value)}
            options={
              pipeline
                ? [{ value: '', label: copy.cases.allStages }, ...stages.map((s) => ({ value: s.key, label: s.name }))]
                : [{ value: '', label: copy.cases.stageFirst }]
            }
          />
        </Filter>
        <Filter id="work-status" label={copy.cases.status}>
          <Select
            id="work-status"
            triggerClass={touchSelect}
            value={status}
            onChange={(value) => change('status', value)}
            options={statusOptions}
          />
        </Filter>
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
            <EmptyState title={copy.cases.empty} />
          )}
          {data.truncated && <p class="text-caption text-secondary mt-3">{copy.cases.truncated}</p>}
        </>
      )}
    </div>
  );
}
