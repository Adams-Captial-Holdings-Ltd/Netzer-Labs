/**
 * Power switch card (Overview). Shows the live pause/wake state of the whole
 * stack and links out to the ALWAYS-UP external power panel (an isolated
 * Lambda page that keeps working while this dashboard is dark).
 *
 * Pause is available here (security:write, double-confirmed). Wake is not, on
 * purpose: when the stack is paused this app is not running, so the only wake
 * surface is the external panel. That is why the panel link is the most
 * prominent element — it is the one to bookmark.
 *
 * Fails soft: hides itself when the backend says the power switch is not
 * configured, or when the profile lacks access.
 */
import { useState, useEffect, useCallback } from 'preact/hooks';
import { api } from '../lib/api';
import { Badge } from './Badge';
import { Button } from './Button';
import { ConfirmDialog } from './ConfirmDialog';
import { Skeleton } from './Skeleton';
import { hasCapability } from '../lib/auth';

interface PowerStatus {
  configured: boolean;
  ok?: boolean;
  phase?: 'paused' | 'pausing' | 'waking' | 'restored' | 'partial' | 'drifted';
  running?: number;
  desired?: number;
  wakeTarget?: number;
  health?: { ok: boolean; status: number } | null;
  keepAwakeUntil?: number;
  autoPause?: string | null;
  costNote?: string | null;
  panelUrl?: string;
  since?: string | null;
  error?: string;
}

const PHASE_BADGE: Record<string, { variant: 'success' | 'warning' | 'danger' | 'info'; label: string }> = {
  restored: { variant: 'success', label: 'Awake' },
  waking: { variant: 'info', label: 'Waking' },
  pausing: { variant: 'info', label: 'Pausing' },
  paused: { variant: 'warning', label: 'Paused' },
  partial: { variant: 'danger', label: 'Needs attention' },
  drifted: { variant: 'danger', label: 'Drifted' },
};

export function PowerCard() {
  const [status, setStatus] = useState<PowerStatus | null>(null);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback((signal?: AbortSignal) => {
    api
      .get<PowerStatus>('/power/status', signal)
      .then((s) => {
        if (!s.configured) setHidden(true);
        else setStatus(s);
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg === 'forbidden' || msg === 'unauthorized') setHidden(true);
        // Any other failure: keep the card with whatever we had; the panel
        // link is still the escape hatch.
      });
  }, []);

  useEffect(() => {
    const ac = new AbortController();
    load(ac.signal);
    return () => ac.abort();
  }, [load]);

  if (hidden) return null;

  // Hold the card's slot with a skeleton while the first status loads, so the
  // card doesn't pop in beneath content that already rendered (layout shift).
  if (!status) {
    return (
      <div class="bg-surface border border-border rounded-xl mb-8" data-tour="overview-power">
        <div class="px-5 py-4 border-b border-border flex items-center gap-2.5">
          <h2 class="text-heading-sm font-semibold">Power</h2>
          <Skeleton height="18px" width="64px" />
        </div>
        <div class="px-5 py-4 space-y-2">
          <Skeleton height="14px" width="55%" />
          <Skeleton height="10px" width="80%" />
        </div>
      </div>
    );
  }

  const phase = status.phase ?? 'restored';
  const badge = PHASE_BADGE[phase] ?? PHASE_BADGE.restored;
  const paused = phase === 'paused' || phase === 'pausing';
  const target = status.wakeTarget ?? status.desired ?? 0;

  const doPause = async () => {
    setConfirming(false);
    setBusy(true);
    setMessage(null);
    try {
      await api.post('/power/pause', { confirm: true });
      setMessage('Pause requested. This dashboard will go dark shortly; wake it from the power panel.');
      load();
    } catch (e) {
      setMessage(`Pause failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="bg-surface border border-border rounded-xl mb-8" data-tour="overview-power">
      <div class="px-5 py-4 border-b border-border flex items-center justify-between">
        <div class="flex items-center gap-2.5">
          <h2 class="text-heading-sm font-semibold">Power</h2>
          <Badge variant={badge.variant}>{badge.label}</Badge>
        </div>
        {status.panelUrl && (
          <a href={status.panelUrl} target="_blank" rel="noopener" class="text-caption text-primary hover:underline">
            Open power panel ↗
          </a>
        )}
      </div>
      <div class="px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-4">
        <div class="flex-1 min-w-0">
          <p class="text-body-sm text-secondary">
            {paused
              ? 'The stack is paused. Compute is at zero and all paid AI calls are hard-stopped.'
              : phase === 'waking'
                ? `Tasks are rolling (${status.running ?? 0} of ${target}); not everything answers yet.`
                : phase === 'restored'
                  ? `All ${status.running ?? 0} tasks running and the app answers end to end.`
                  : 'The last power operation did not finish cleanly. Open the panel to reconcile.'}
          </p>
          <p class="text-caption text-muted mt-1">
            {status.costNote ? `${status.costNote} · ` : ''}
            {status.autoPause ? `Auto-pause ${status.autoPause}.` : ''}
            {' '}Wake is only possible from the power panel, which stays up while everything else is dark. Bookmark it.
          </p>
          {message && <p class="text-caption text-warning mt-2">{message}</p>}
        </div>
        <div class="flex gap-2 flex-none">
          {status.panelUrl && paused && (
            <a href={status.panelUrl} target="_blank" rel="noopener">
              <Button variant="primary" size="sm">Wake from panel</Button>
            </a>
          )}
          {!paused && hasCapability('security:write') && (
            <Button variant="danger" size="sm" onClick={() => setConfirming(true)} loading={busy}>
              Pause stack
            </Button>
          )}
        </div>
      </div>
      <ConfirmDialog
        open={confirming}
        title="Pause the whole stack"
        message="Compute goes to zero and all paid AI calls hard-stop. The dashboard, Telegram, and Slack are offline until you wake it from the power panel. Your data is kept, and nothing outside ClaudeClaw is touched."
        confirmPhrase="pause"
        confirmLabel="Pause stack"
        danger
        onConfirm={doPause}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
