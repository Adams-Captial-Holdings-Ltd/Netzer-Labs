import { useState, useEffect, useRef } from 'preact/hooks';
import { api } from '../lib/api';
import { currentLabel, hasCapability } from '../lib/auth';
import { Button } from '../components/Button';
import { Toggle } from '../components/Toggle';
import { Badge } from '../components/Badge';
import { Skeleton } from '../components/Skeleton';
import { Modal } from '../components/Modal';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { InfoTooltip } from '../components/InfoTooltip';
import { toast } from '../components/Toast';

interface PanicState {
  active: boolean;
  generation: number;
  triggeredAt?: string;
  triggeredBy?: string;
  reason?: string;
  snapshot?: Record<string, boolean>;
  releasedAt?: string;
  releasedBy?: string;
  forceReleased?: boolean;
}

type Action = 'engage' | 'restore' | 'force';

// Type-to-confirm phrase guarding the destructive panic actions.
const CONFIRM_PHRASE = 'PANIC';
// Kill-switch changes propagate to all workers via a ~30s in-process cache TTL.
const PROPAGATION_SECONDS = 30;

function fmt(ts?: string): string {
  if (!ts) return 'n/a';
  const t = Date.parse(ts);
  return Number.isFinite(t) ? new Date(t).toLocaleString() : ts;
}

export function Panic() {
  // The /panic route already requires security:write to render this page; this
  // is defense-in-depth on the destructive controls themselves so they fail
  // closed (read-only state view) even if the page is ever reached another way.
  // Old gate was admin-tier; security:write is admin/owner-only — equivalent,
  // never wider. The backend re-checks every engage/restore/force POST.
  const canControl = hasCapability('security:write');
  const [state, setState] = useState<PanicState | null>(null);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<Action | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  // Countdown shown after a panic action while the change fans out to all
  // workers. 0 means nothing is propagating. While > 0 we also warn on unload.
  const [propagating, setPropagating] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function load() {
    api.get<PanicState>('/panic')
      .then(setState)
      .catch((err) => toast(err instanceof Error ? err.message : 'Failed to load panic state', 'error'))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    load();
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, []);

  // Warn before the tab is closed or reloaded while a panic change is still
  // propagating, so the operator does not walk away mid-fanout. The handler is
  // only attached while the countdown is running.
  useEffect(() => {
    if (propagating <= 0) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Legacy browsers require returnValue to be set to trigger the prompt.
      e.returnValue = '';
      return '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [propagating]);

  function operator(): string {
    return currentLabel.value || 'dashboard';
  }

  function finish() {
    setBusy(false);
    setAction(null);
    setReason('');
  }

  // Begin the post-action propagation countdown. Mirrors the kill-switch page's
  // 30s in-process cache TTL window and refreshes panic state when it expires.
  function startPropagation() {
    if (timerRef.current) clearInterval(timerRef.current);
    setPropagating(PROPAGATION_SECONDS);
    timerRef.current = setInterval(() => {
      setPropagating((prev) => {
        const next = prev - 1;
        if (next <= 0) {
          if (timerRef.current) clearInterval(timerRef.current);
          timerRef.current = null;
          load();
          return 0;
        }
        return next;
      });
    }, 1000);
  }

  async function engage() {
    setBusy(true);
    try {
      const s = await api.post<PanicState>('/panic', { reason: reason || 'manual trigger', triggeredBy: operator() });
      setState(s);
      startPropagation();
      toast('Panic engaged. All kill switches tripped.', 'warning');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    finish();
  }

  async function restore() {
    if (!state) return;
    setBusy(true);
    try {
      const s = await api.post<PanicState>('/panic/restore', { generation: state.generation, releasedBy: operator() });
      setState(s);
      startPropagation();
      toast('Panic released. Kill switches restored from snapshot.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    finish();
  }

  async function force() {
    setBusy(true);
    try {
      const s = await api.post<PanicState>('/panic/force-release', { releasedBy: operator() });
      setState(s);
      startPropagation();
      toast('Force release complete. All kill switches cleared.', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    finish();
  }

  const snapshotCount = state?.snapshot ? Object.keys(state.snapshot).length : 0;

  return (
    <div>
      <div class="mb-6">
        <h1 data-tour="panic-title" class="text-display-sm text-primary font-bold inline-flex items-center gap-2">
          Panic
          <InfoTooltip term="panic" />
        </h1>
        <p class="text-body-sm text-secondary mt-1">
          Emergency all-stop. Engaging panic snapshots the current kill-switch state, then trips every switch at once.
        </p>
      </div>

      {propagating > 0 && (
        <div class="mb-4 flex items-center gap-3 bg-warning/5 border border-warning/40 rounded-lg px-4 py-3">
          <span class="w-2.5 h-2.5 rounded-full bg-warning animate-pulse" />
          <p class="text-body-sm text-secondary">
            Propagating to all workers... {propagating}s. Keep this tab open until it finishes.
          </p>
        </div>
      )}

      {loading ? (
        <Skeleton height="200px" width="100%" />
      ) : state?.active ? (
        <div data-tour="panic-status" class="bg-danger/5 border border-danger/40 rounded-xl p-6">
          <div class="flex items-center gap-3 mb-4">
            <span class="w-3 h-3 rounded-full bg-danger animate-pulse" />
            <h2 class="text-heading-sm text-danger font-bold">Panic active</h2>
            <Badge variant="danger">generation {state.generation}</Badge>
            <InfoTooltip term="generation" />
          </div>
          <dl class="grid grid-cols-2 gap-x-6 gap-y-2 text-body-sm mb-6 max-w-lg">
            <dt class="text-muted">Triggered by</dt><dd class="text-primary">{state.triggeredBy || 'n/a'}</dd>
            <dt class="text-muted">Triggered at</dt><dd class="text-primary">{fmt(state.triggeredAt)}</dd>
            <dt class="text-muted">Reason</dt><dd class="text-primary">{state.reason || 'n/a'}</dd>
            <dt class="text-muted inline-flex items-center gap-1">
              Switches snapshotted
              <InfoTooltip term="snapshot" />
            </dt>
            <dd class="text-primary">{snapshotCount}</dd>
          </dl>
          {canControl && (
            <div data-tour="panic-restore" class="flex gap-4 items-center flex-wrap">
              <Toggle
                checked
                tone="danger"
                busy={busy || propagating > 0}
                ariaLabel="Panic active, switch off to restore from snapshot"
                onChange={() => setAction('restore')}
              >
                <span class="text-body-sm font-medium text-danger inline-flex items-center gap-1">
                  Panic active — switch off to restore
                  <InfoTooltip term="restore" />
                </span>
              </Toggle>
              <Button variant="danger" onClick={() => setAction('force')}>Force release</Button>
              <InfoTooltip term="force release" />
            </div>
          )}
        </div>
      ) : (
        <div data-tour="panic-status" class="bg-surface border border-border rounded-xl p-6">
          <div class="flex items-center gap-3 mb-4">
            <span class="w-3 h-3 rounded-full bg-success" />
            <h2 class="text-heading-sm text-primary font-bold">No panic active</h2>
            {state && <Badge variant="muted">generation {state.generation}</Badge>}
          </div>
          <p class="text-body-sm text-secondary mb-4 max-w-lg">
            Engaging panic immediately trips every{' '}
            <span class="inline-flex items-center gap-1">
              kill switch
              <InfoTooltip term="kill switch" />
            </span>{' '}
            and blocks all agent activity. Use it only for an active incident. The current switch state is{' '}
            <span class="inline-flex items-center gap-1">
              snapshotted
              <InfoTooltip term="snapshot" />
            </span>{' '}
            so it can be restored afterward.
          </p>
          {(state?.releasedBy || state?.releasedAt) && (
            <dl class="grid grid-cols-2 gap-x-6 gap-y-2 text-body-sm mb-6 max-w-lg">
              <dt class="text-muted">{state?.forceReleased ? 'Force released by' : 'Released by'}</dt>
              <dd class="text-primary">{state?.releasedBy || 'n/a'}</dd>
              <dt class="text-muted">Released at</dt><dd class="text-primary">{fmt(state?.releasedAt)}</dd>
            </dl>
          )}
          {canControl && (
            <>
              <div data-tour="panic-engage" class="max-w-lg mb-4">
                <label class="block text-caption text-secondary font-medium mb-1">Reason (optional)</label>
                <input
                  value={reason}
                  onInput={(e) => setReason((e.target as HTMLInputElement).value)}
                  placeholder="Incident description"
                  class="w-full bg-bg-elevated border border-border rounded-lg px-3 py-2 text-body-sm outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>
              <Toggle
                checked={false}
                tone="danger"
                busy={busy || propagating > 0}
                ariaLabel="Panic disengaged, switch on to engage panic"
                onChange={() => setAction('engage')}
              >
                <span class="text-body-sm font-medium text-secondary">Panic disengaged — switch on to engage</span>
              </Toggle>
            </>
          )}
        </div>
      )}

      <ConfirmDialog
        open={action === 'engage'}
        title="Engage panic"
        message={`This trips every kill switch at once and halts all agents. A snapshot of the current state is saved so it can be restored. ${
          reason ? `Reason: "${reason}".` : 'No reason was entered.'
        }`}
        confirmPhrase={CONFIRM_PHRASE}
        confirmLabel={busy ? 'Engaging...' : 'Engage panic'}
        danger
        onConfirm={engage}
        onCancel={() => setAction(null)}
      />

      <Modal open={action === 'restore'} onClose={() => setAction(null)} title="Restore from snapshot">
        <div class="space-y-4">
          <p class="text-body-sm text-secondary">
            This releases the panic and restores every kill switch to the state captured when panic was engaged
            (generation {state?.generation}).
          </p>
          <div class="flex gap-3 justify-end">
            <Button variant="secondary" onClick={() => setAction(null)}>Cancel</Button>
            <Button variant="primary" loading={busy} onClick={restore}>Restore</Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={action === 'force'}
        title="Force release"
        message="Force release clears every kill switch to off and ignores the snapshot. Use this only if the snapshot is known bad. Any switch that should stay tripped will need to be re-armed manually."
        confirmPhrase={CONFIRM_PHRASE}
        confirmLabel={busy ? 'Releasing...' : 'Force release'}
        danger
        onConfirm={force}
        onCancel={() => setAction(null)}
      />
    </div>
  );
}
