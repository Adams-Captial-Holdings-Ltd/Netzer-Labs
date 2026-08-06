/**
 * Seat self-service (usage:self:read): the caller's own seat, policy limits,
 * and personal usage ledger. Absorbed from PR #42's MyWorkspace, minus the
 * workspace connection/lifecycle surface. Identity comes from the session
 * principal on the backend; nothing here can read another seat's rows.
 */
import { useEffect, useState } from 'preact/hooks';
import { api, type Seat, type SeatPolicy, type SeatUsageRow } from '../lib/api';
import { Badge } from '../components/Badge';
import { EmptyState } from '../components/EmptyState';
import { Skeleton } from '../components/Skeleton';
import { toast } from '../components/Toast';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function MySeat() {
  const [loading, setLoading] = useState(true);
  const [noSeat, setNoSeat] = useState(false);
  const [seat, setSeat] = useState<Seat | null>(null);
  const [policy, setPolicy] = useState<SeatPolicy | null>(null);
  const [usageDate, setUsageDate] = useState(today());
  const [usage, setUsage] = useState<SeatUsageRow[]>([]);
  const [usageLoading, setUsageLoading] = useState(false);

  async function loadUsage(date: string) {
    setUsageLoading(true);
    try {
      const page = await api.seats.myUsage(date);
      setUsage(page.items);
    } catch {
      // A 404 here means no seat; the seat load below owns that state.
      setUsage([]);
    } finally {
      setUsageLoading(false);
    }
  }

  useEffect(() => {
    (async () => {
      try {
        const me = await api.seats.me();
        setSeat(me.seat);
        setPolicy(me.policy);
        await loadUsage(usageDate);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/no seat|404|not found/i.test(msg)) {
          setNoSeat(true);
        } else {
          toast(msg, 'error');
        }
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return (
      <div class="space-y-4">
        <Skeleton class="h-24" />
        <Skeleton class="h-40" />
      </div>
    );
  }

  if (noSeat || !seat) {
    return (
      <EmptyState
        title="No seat assigned yet"
        description="An org admin assigns seats from the Seats page. Once yours exists, your policy limits and personal usage ledger appear here."
      />
    );
  }

  return (
    <div class="space-y-6">
      <section>
        <h1 class="text-heading-lg text-primary font-bold">My Seat</h1>
        <p class="mt-1 text-body-sm text-secondary">
          Your policy limits and your own usage ledger. Only your seat's rows are visible here.
        </p>
      </section>

      <section class="grid gap-4 sm:grid-cols-3">
        <div class="bg-surface border border-border rounded-lg p-4">
          <p class="text-overline text-muted uppercase tracking-wider">Status</p>
          <div class="mt-2">
            <Badge variant={seat.status === 'active' ? 'success' : 'warning'}>{seat.status}</Badge>
          </div>
        </div>
        <div class="bg-surface border border-border rounded-lg p-4">
          <p class="text-overline text-muted uppercase tracking-wider">Policy</p>
          <p class="mt-2 text-body font-semibold text-primary">{policy?.label ?? seat.policyId}</p>
          <p class="mt-1 text-caption text-muted">
            {policy?.monthlySpendLimitUsd !== undefined
              ? `Monthly limit $${policy.monthlySpendLimitUsd}`
              : 'No monthly limit set'}
          </p>
        </div>
        <div class="bg-surface border border-border rounded-lg p-4">
          <p class="text-overline text-muted uppercase tracking-wider">Allowed models</p>
          <p class="mt-2 text-body-sm text-secondary leading-relaxed">
            {policy && policy.allowedModels.length > 0
              ? policy.allowedModels.join(', ')
              : 'None listed (the policy denies all models)'}
          </p>
        </div>
      </section>

      <section class="bg-surface border border-border rounded-lg p-5 space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 class="text-heading-sm text-primary font-semibold">My usage</h2>
          <input
            type="date"
            value={usageDate}
            onChange={(e) => {
              const d = (e.target as HTMLInputElement).value;
              setUsageDate(d);
              void loadUsage(d);
            }}
            class="rounded-lg border border-border bg-page px-3 py-1.5 text-body-sm"
          />
        </div>
        {usageLoading ? (
          <Skeleton class="h-24" />
        ) : usage.length === 0 ? (
          <p class="text-body-sm text-muted">No usage recorded on {usageDate}.</p>
        ) : (
          <div class="overflow-x-auto">
            <table class="w-full text-body-sm">
              <thead>
                <tr class="text-left text-caption text-muted uppercase tracking-wide">
                  <th class="py-2 pr-4">Time</th>
                  <th class="py-2 pr-4">Model</th>
                  <th class="py-2 pr-4">Tokens in/out</th>
                  <th class="py-2 pr-4">Cost</th>
                  <th class="py-2 pr-4">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {usage.map((u) => (
                  <tr key={u.usageId} class="border-t border-border">
                    <td class="py-2 pr-4 text-muted">{u.createdAt.slice(11, 19)}</td>
                    <td class="py-2 pr-4 text-secondary">{u.model}</td>
                    <td class="py-2 pr-4 text-secondary">
                      {u.inputTokens} / {u.outputTokens}
                    </td>
                    <td class="py-2 pr-4 text-secondary">${u.estimatedCostUsd.toFixed(4)}</td>
                    <td class="py-2 pr-4">
                      <Badge variant={u.policyOutcome === 'allowed' ? 'success' : 'danger'}>
                        {u.policyOutcome}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
