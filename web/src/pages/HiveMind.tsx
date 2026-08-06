import { useState, useEffect } from 'preact/hooks';
import { api } from '../lib/api';
import { hasRole } from '../lib/auth';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { EmptyNetwork } from '../components/Icons';
import { Skeleton } from '../components/Skeleton';
import { Badge } from '../components/Badge';
import { DataMeta } from '../components/DataMeta';
import { toast } from '../components/Toast';

// GET /hive caps at this limit and returns only count === notes.length (the
// capped array length, NOT a true total), so the page can only honestly say
// "first N". Keep in sync with the limit on the /hive request below.
const HIVE_CAP = 50;

interface HiveNote {
  PK?: string;
  SK?: string;
  content?: string;
  authorAgentId?: string;
  authorChatId?: string;
  topic?: string;
  ts?: string;
  createdAt?: string;
  [k: string]: unknown;
}

// Auto-promote cadence lives in runtime-config category 'memory'. Reads are
// operator-visible; writes are admin-gated server-side (every non-cost /config
// write requires admin), so the editor only renders for admins. A read-only
// principal sees the current values but no inputs.
function CadenceConfig() {
  const canWrite = hasRole('admin');
  const [loading, setLoading] = useState(true);
  const [cadence, setCadence] = useState('');
  const [minConf, setMinConf] = useState('');
  const [saving, setSaving] = useState(false);

  function load(signal?: AbortSignal) {
    setLoading(true);
    Promise.all([
      api.config.get('memory', 'ingest_every_n_turns', signal).catch(() => ({ value: null })),
      api.config.get('memory', 'hive_promote_min_confidence', signal).catch(() => ({ value: null })),
    ])
      .then(([a, b]) => {
        setCadence(a.value ?? '');
        setMinConf(b.value ?? '');
      })
      .finally(() => {
        if (!signal?.aborted) setLoading(false);
      });
  }

  useEffect(() => {
    const ac = new AbortController();
    load(ac.signal);
    return () => ac.abort();
  }, []);

  async function save() {
    const cadenceNum = Number(cadence);
    if (!Number.isInteger(cadenceNum) || cadenceNum < 1) {
      toast('Cadence must be a positive whole number of turns', 'error');
      return;
    }
    const confNum = Number(minConf);
    if (!Number.isFinite(confNum) || confNum < 0 || confNum > 1) {
      toast('Min confidence must be between 0 and 1', 'error');
      return;
    }
    setSaving(true);
    try {
      await api.config.set('memory', 'ingest_every_n_turns', String(cadenceNum));
      await api.config.set('memory', 'hive_promote_min_confidence', String(confNum));
      toast('Auto-promote cadence saved', 'success');
      load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to save cadence', 'error');
    }
    setSaving(false);
  }

  return (
    <div data-tour="hive-cadence" class="bg-surface border border-border rounded-xl p-5 mb-6 max-w-2xl">
      <h2 class="text-heading-sm font-semibold text-secondary mb-1 uppercase tracking-wider">
        Auto-promote cadence
      </h2>
      <p class="text-caption text-muted mb-4">
        How often memory ingest scans for fleet-wide facts to promote into the hive, and the minimum
        confidence a fact needs to be promoted. {canWrite ? 'Edits are admin-only.' : 'Editing requires an admin token.'}
      </p>
      {loading ? (
        <Skeleton height="44px" width="100%" />
      ) : (
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label class="block text-caption text-secondary font-medium mb-1">Ingest every N turns</label>
            <input
              type="number"
              min={1}
              step={1}
              value={cadence}
              disabled={!canWrite}
              onInput={(e) => setCadence((e.target as HTMLInputElement).value)}
              placeholder="default: 8"
              class="w-full bg-bg-elevated border border-border rounded-lg px-3 py-2 text-body-sm font-mono text-primary placeholder:text-muted outline-none focus:ring-1 focus:ring-accent disabled:opacity-60 disabled:cursor-not-allowed"
            />
            <p class="text-overline text-muted mt-1">Whole number of turns, 2–20. Blank = default (8)</p>
          </div>
          <div>
            <label class="block text-caption text-secondary font-medium mb-1">Min confidence to promote</label>
            <input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={minConf}
              disabled={!canWrite}
              onInput={(e) => setMinConf((e.target as HTMLInputElement).value)}
              placeholder="default: 0.6"
              class="w-full bg-bg-elevated border border-border rounded-lg px-3 py-2 text-body-sm font-mono text-primary placeholder:text-muted outline-none focus:ring-1 focus:ring-accent disabled:opacity-60 disabled:cursor-not-allowed"
            />
            <p class="text-overline text-muted mt-1">Between 0 and 1. Blank = default (0.6)</p>
          </div>
        </div>
      )}
      {canWrite && !loading && (
        <div class="mt-4 flex justify-end">
          <Button loading={saving} onClick={save}>Save cadence</Button>
        </div>
      )}
    </div>
  );
}

export function HiveMind() {
  const [notes, setNotes] = useState<HiveNote[]>([]);
  const [loading, setLoading] = useState(true);
  // Distinct error state for the /hive fetch so a 403/500/network failure shows
  // ErrorState instead of the "No hive entries yet" empty state. Cleared on load.
  const [loadError, setLoadError] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  function load(signal?: AbortSignal) {
    setLoading(true);
    setLoadError(false);
    api.get<{ notes: HiveNote[] }>(`/hive?limit=${HIVE_CAP}`, signal)
      .then((d) => { setNotes(d.notes); setUpdatedAt(Date.now()); })
      .catch((err) => {
        if ((err as Error)?.name === 'AbortError') return;
        setLoadError(true);
      })
      .finally(() => {
        if (!signal?.aborted) setLoading(false);
      });
  }

  useEffect(() => {
    const ac = new AbortController();
    load(ac.signal);
    return () => ac.abort();
  }, []);

  return (
    <div>
      <div class="mb-6">
        <h1 data-tour="hive-title" class="text-display-sm text-primary font-bold">Hive Mind</h1>
        <p class="text-body-sm text-secondary mt-1">Cross-agent knowledge sharing</p>
        {!loading && !loadError && notes.length > 0 && (
          <div class="mt-1">
            <DataMeta
              updatedAt={updatedAt ?? undefined}
              // No true total from the backend; capped at HIVE_CAP, so "first N"
              // only once the cap is hit.
              note={notes.length >= HIVE_CAP ? `Showing first ${HIVE_CAP}` : undefined}
              onRefresh={() => load()}
            />
          </div>
        )}
      </div>

      <CadenceConfig />

      {loading ? (
        <div class="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} class="bg-surface border border-border rounded-xl p-5">
              <Skeleton height="14px" width="40%" class="mb-2" />
              <Skeleton height="40px" />
            </div>
          ))}
        </div>
      ) : loadError ? (
        <ErrorState
          title="Could not load hive entries"
          message="The hive mind failed to load. This is an error, not an empty hive. Check your connection or permissions and try again."
          onRetry={() => load()}
        />
      ) : notes.length === 0 ? (
        <div data-tour="hive-feed" class="bg-surface border border-border rounded-xl p-8">
          <EmptyState icon={<EmptyNetwork />} title="No hive entries yet" description="When agents discover information relevant to other agents, they share it here. Knowledge entries are tagged with source, confidence, and topic so any agent can search the collective memory." />
          <div class="flex items-center justify-center gap-4 mt-6 text-caption text-muted">
            <span class="px-3 py-1 border border-border rounded-lg">Agent A</span>
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.75" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg>
            <span class="px-3 py-1 border border-accent/30 rounded-lg text-accent">Hive Mind</span>
            <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.75" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg>
            <span class="px-3 py-1 border border-border rounded-lg">Agent B</span>
          </div>
        </div>
      ) : (
        <div data-tour="hive-feed" class="space-y-3">
          {notes.map((n, i) => (
            <div key={i} class="bg-surface border border-border rounded-xl p-5">
              <div class="flex items-center gap-2 mb-2 flex-wrap">
                {n.authorAgentId && <Badge variant="info">agent: {n.authorAgentId}</Badge>}
                {n.authorChatId && <Badge variant="success">chat: {n.authorChatId}</Badge>}
                {n.topic && <Badge variant="default">{n.topic}</Badge>}
                {(n.ts ?? n.createdAt) && <span class="text-caption text-muted ml-auto">{new Date(n.ts ?? n.createdAt as string).toLocaleString()}</span>}
              </div>
              <pre class="text-body-sm text-primary whitespace-pre-wrap font-sans break-words">{n.content ?? JSON.stringify(n, null, 2)}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
