import { useState, useEffect, useCallback } from 'preact/hooks';
import { api, type AlertSubscription, type AlertAlarm } from '../lib/api';
import { Button } from '../components/Button';
import { Badge } from '../components/Badge';
import { Skeleton } from '../components/Skeleton';
import { toast } from '../components/Toast';
import { InfoTooltip } from '../components/InfoTooltip';

// Plain-language explanation of why a recipient is not yet receiving alerts.
// Surfaced next to the status badge for Pending confirmation / Unknown rows.
const PENDING_HELP =
  'AWS emailed this address a confirmation link on subscribe. Until the recipient clicks it, ' +
  'the subscription stays pending and no alerts are sent. Use Refresh after they confirm to ' +
  'pull the latest status from SNS.';

const UNKNOWN_HELP =
  'SNS did not report a confirmed/pending state for this recipient (it may be a locally added ' +
  'record SNS has not surfaced yet). Use Refresh to re-check, or remove and re-add the recipient.';

// Map an SNS subscription state to a badge variant + label. A pending
// subscription is amber because it does nothing until the recipient clicks
// the AWS confirmation email.
const SUB_BADGE: Record<AlertSubscription['status'], { variant: 'success' | 'warning' | 'muted'; label: string }> = {
  Confirmed: { variant: 'success', label: 'Confirmed' },
  PendingConfirmation: { variant: 'warning', label: 'Pending confirmation' },
  Unknown: { variant: 'muted', label: 'Unknown' },
};

// Map a CloudWatch alarm state to a dot color + badge variant.
const ALARM_DOT: Record<AlertAlarm['status'], string> = {
  ok: 'bg-success',
  alarm: 'bg-danger',
  insufficient: 'bg-warning',
  unknown: 'bg-gray-300 dark:bg-gray-600',
};

const ALARM_BADGE: Record<AlertAlarm['status'], { variant: 'success' | 'danger' | 'warning' | 'muted'; label: string }> = {
  ok: { variant: 'success', label: 'OK' },
  alarm: { variant: 'danger', label: 'In alarm' },
  insufficient: { variant: 'warning', label: 'No data' },
  unknown: { variant: 'muted', label: 'Unknown' },
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function Alerting() {
  const [subs, setSubs] = useState<AlertSubscription[]>([]);
  const [alarms, setAlarms] = useState<AlertAlarm[]>([]);
  const [topicArn, setTopicArn] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [subscribing, setSubscribing] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);

  // Re-fetch the full alert config. `list()` returns live SNS subscription
  // statuses, so this also doubles as the "did they confirm yet?" check.
  const load = useCallback(() => {
    setError(null);
    return api.alerts.list()
      .then((d) => {
        setSubs(d.subscriptions ?? []);
        setAlarms(d.alarms ?? []);
        setTopicArn(d.topicArn ?? null);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load alert config'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { void load(); }, [load]);

  // Per-row status refresh. There is no per-recipient status endpoint, so we
  // re-pull the whole list (which carries live SNS state) and show a spinner on
  // the row that asked for it. Surfaces the new status of every recipient.
  async function refreshStatus(addr: string) {
    setRefreshing(addr);
    try {
      await load();
    } finally {
      setRefreshing(null);
    }
  }

  async function subscribe() {
    const trimmed = email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      toast('Enter a valid email address', 'error');
      return;
    }
    setSubscribing(true);
    try {
      await api.alerts.subscribe(trimmed);
      toast(`Confirmation email sent to ${trimmed}. They must click the AWS link to start receiving alerts.`, 'success');
      setEmail('');
      load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to subscribe', 'error');
    }
    setSubscribing(false);
  }

  async function remove(addr: string) {
    setRemoving(addr);
    try {
      await api.alerts.remove(addr);
      toast(`Removed ${addr}`, 'success');
      load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to remove recipient', 'error');
    }
    setRemoving(null);
  }

  const pendingCount = subs.filter((s) => s.status === 'PendingConfirmation').length;

  return (
    <div>
      <div class="mb-6">
        <h1 data-tour="alerting-title" class="text-display-sm text-primary font-bold">Alerting</h1>
        <p class="text-body-sm text-secondary mt-1">
          Route ops alarms to email. Recipients subscribe to the shared SNS ops-alerts topic that
          backs every CloudWatch alarm below.
          {!loading && pendingCount > 0 && ` ${pendingCount} recipient${pendingCount > 1 ? 's' : ''} awaiting confirmation.`}
        </p>
      </div>

      <section class="mb-8">
        <h2 class="text-heading-sm font-semibold text-secondary mb-4 uppercase tracking-wider">Email recipients</h2>
        <div data-tour="alerting-subscribe" class="bg-surface border border-border rounded-xl p-5">
          <div class="flex flex-col sm:flex-row sm:items-end gap-3">
            <div class="flex-1">
              <label class="block text-caption text-secondary font-medium mb-1">Add a recipient</label>
              <input
                type="email"
                value={email}
                onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => { if (e.key === 'Enter') subscribe(); }}
                placeholder="oncall@example.com"
                class="w-full bg-bg-elevated border border-border rounded-lg px-3 py-2 text-body-sm text-primary placeholder:text-muted outline-none focus:ring-1 focus:ring-accent"
              />
            </div>
            <Button
              loading={subscribing}
              disabled={!EMAIL_RE.test(email.trim())}
              onClick={subscribe}
            >
              Subscribe
            </Button>
          </div>
          <p class="text-caption text-muted mt-3">
            AWS sends a confirmation email on subscribe. The recipient must click the link before any
            alert reaches them; until then they show as Pending confirmation. No alerts are sent to
            unconfirmed addresses.
          </p>
        </div>

        <div data-tour="alerting-recipients" class="mt-4">
          {loading ? (
            <div class="space-y-2">
              {Array.from({ length: 2 }).map((_, i) => (
                <Skeleton key={i} height="48px" width="100%" />
              ))}
            </div>
          ) : error ? (
            <div class="bg-surface border border-border rounded-xl p-5">
              <div class="flex items-center gap-2 mb-1">
                <span class="h-2.5 w-2.5 rounded-full bg-danger" aria-hidden="true" />
                <span class="text-body-sm text-primary font-medium">Could not load recipients</span>
              </div>
              <p class="text-caption text-muted">{error}</p>
            </div>
          ) : subs.length === 0 ? (
            <div class="bg-surface border border-border rounded-xl p-5 text-body-sm text-muted">
              No recipients yet. Add an email above to start receiving ops alerts.
            </div>
          ) : (
            <div class="bg-surface border border-border rounded-xl overflow-hidden">
              <table class="w-full text-body-sm">
                <thead>
                  <tr class="border-b border-border text-left text-caption text-muted uppercase tracking-wider">
                    <th class="px-4 py-2 font-medium">Email</th>
                    <th class="px-4 py-2 font-medium">Status</th>
                    <th class="px-4 py-2 font-medium w-px"></th>
                  </tr>
                </thead>
                <tbody>
                  {subs.map((s) => {
                    const badge = SUB_BADGE[s.status] ?? SUB_BADGE.Unknown;
                    const pending = s.status === 'PendingConfirmation';
                    const unconfirmed = pending || s.status === 'Unknown';
                    return (
                      <tr key={s.email} class="border-b border-border last:border-0">
                        <td class="px-4 py-2.5 text-primary font-medium break-all">{s.email}</td>
                        <td class="px-4 py-2.5">
                          <span class="inline-flex items-center gap-1.5">
                            <Badge variant={badge.variant}>{badge.label}</Badge>
                            {unconfirmed && (
                              <InfoTooltip text={pending ? PENDING_HELP : UNKNOWN_HELP} />
                            )}
                          </span>
                        </td>
                        <td class="px-4 py-2.5 text-right">
                          <div class="inline-flex items-center justify-end gap-1">
                            {unconfirmed && (
                              <>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  loading={refreshing === s.email}
                                  disabled={removing === s.email}
                                  onClick={() => refreshStatus(s.email)}
                                >
                                  Refresh
                                </Button>
                              </>
                            )}
                            <Button
                              size="sm"
                              variant="ghost"
                              loading={removing === s.email}
                              disabled={refreshing === s.email}
                              onClick={() => remove(s.email)}
                            >
                              Remove
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <section data-tour="alerting-alarms">
        <h2 class="text-heading-sm font-semibold text-secondary mb-4 uppercase tracking-wider">Configured alarms</h2>
        {loading ? (
          <div class="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} height="72px" width="100%" />
            ))}
          </div>
        ) : alarms.length === 0 ? (
          <div class="bg-surface border border-border rounded-xl p-5 text-body-sm text-muted">
            No alarms reported. CloudWatch may be unreadable from this task.
          </div>
        ) : (
          <div class="space-y-3">
            {alarms.map((a) => {
              const badge = ALARM_BADGE[a.status] ?? ALARM_BADGE.unknown;
              return (
                <div key={a.id} class="bg-surface border border-border rounded-xl p-4 flex items-start gap-3">
                  <span class={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${ALARM_DOT[a.status] ?? ALARM_DOT.unknown}`} aria-hidden="true" />
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2 flex-wrap">
                      <span class="text-body-sm text-primary font-medium">{a.label}</span>
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                      {a.threshold && (
                        <span class="text-caption font-mono text-secondary">{a.threshold}</span>
                      )}
                    </div>
                    <p class="text-caption text-muted mt-1">{a.description}</p>
                    {a.metric && (
                      <p class="text-overline text-muted font-mono mt-0.5">{a.metric}</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {!loading && topicArn && (
          <p class="text-overline text-muted font-mono mt-4 break-all">Topic: {topicArn}</p>
        )}
      </section>
    </div>
  );
}
