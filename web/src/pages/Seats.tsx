/**
 * Seat administration (org-admin / owner): policies, seats, and org-wide
 * per-seat usage attribution. Absorbed from PR #42's admin view, minus the
 * EC2 workspace fleet. The backend (/api/seats) re-checks every capability;
 * hasCapability() here only hides controls the principal can't use.
 */
import { useEffect, useState } from 'preact/hooks';
import {
  api,
  type Seat,
  type SeatPolicy,
  type SeatStatus,
  type SeatUsageRow,
} from '../lib/api';
import { Button } from '../components/Button';
import { Badge } from '../components/Badge';
import { Skeleton } from '../components/Skeleton';
import { toast } from '../components/Toast';
import { hasCapability } from '../lib/auth';

const STATUS_TONE: Record<SeatStatus, 'success' | 'warning' | 'danger' | 'muted'> = {
  active: 'success',
  invited: 'muted',
  suspended: 'warning',
  retired: 'danger',
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function csv(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function Seats() {
  const canWriteSeats = hasCapability('seats:write');
  const canWritePolicies = hasCapability('seat-policies:write');

  const [loading, setLoading] = useState(true);
  const [seats, setSeats] = useState<Seat[]>([]);
  const [policies, setPolicies] = useState<SeatPolicy[]>([]);

  // Create-policy form.
  const [polLabel, setPolLabel] = useState('');
  const [polModels, setPolModels] = useState('');
  const [polTools, setPolTools] = useState('');
  const [polLimit, setPolLimit] = useState('');
  const [creatingPolicy, setCreatingPolicy] = useState(false);

  // Create-seat form.
  const [seatUserId, setSeatUserId] = useState('');
  const [seatPolicyId, setSeatPolicyId] = useState('');
  const [creatingSeat, setCreatingSeat] = useState(false);

  // Usage.
  const [usageDate, setUsageDate] = useState(today());
  const [usage, setUsage] = useState<SeatUsageRow[]>([]);
  const [usageLoading, setUsageLoading] = useState(false);

  async function reload() {
    try {
      const [seatPage, policyPage] = await Promise.all([api.seats.list(), api.seats.policies()]);
      setSeats(seatPage.items);
      setPolicies(policyPage.items);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to load seats', 'error');
    } finally {
      setLoading(false);
    }
  }

  async function loadUsage(date: string) {
    setUsageLoading(true);
    try {
      const page = await api.seats.usage(date);
      setUsage(page.items);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to load usage', 'error');
    } finally {
      setUsageLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    void loadUsage(usageDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function createPolicy() {
    if (!polLabel.trim()) {
      toast('Policy label is required', 'error');
      return;
    }
    setCreatingPolicy(true);
    try {
      const limit = Number(polLimit);
      await api.seats.createPolicy({
        label: polLabel.trim(),
        allowedModels: csv(polModels),
        allowedTools: csv(polTools),
        ...(polLimit.trim() !== '' && Number.isFinite(limit) && limit >= 0
          ? { monthlySpendLimitUsd: limit }
          : {}),
      });
      toast('Policy created', 'success');
      setPolLabel('');
      setPolModels('');
      setPolTools('');
      setPolLimit('');
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Policy create failed', 'error');
    } finally {
      setCreatingPolicy(false);
    }
  }

  async function createSeat() {
    if (!seatUserId.trim() || !seatPolicyId) {
      toast('userId and policy are required', 'error');
      return;
    }
    setCreatingSeat(true);
    try {
      await api.seats.create(seatUserId.trim(), seatPolicyId);
      toast('Seat created', 'success');
      setSeatUserId('');
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Seat create failed', 'error');
    } finally {
      setCreatingSeat(false);
    }
  }

  async function setStatus(seat: Seat, status: SeatStatus) {
    try {
      await api.seats.update(seat.seatId, { status });
      toast(`Seat ${status}`, 'success');
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Update failed', 'error');
    }
  }

  const policyLabel = (id: string) => policies.find((p) => p.policyId === id)?.label ?? id;

  if (loading) {
    return (
      <div class="space-y-4">
        <Skeleton class="h-24" />
        <Skeleton class="h-48" />
      </div>
    );
  }

  return (
    <div class="space-y-8">
      <section>
        <h1 class="text-heading-lg text-primary font-bold">Seats</h1>
        <p class="mt-1 text-body-sm text-secondary max-w-3xl">
          A seat binds a member to a policy (allowed models, tools, monthly spend). Usage rows
          below are written by the spend ledger with per-seat attribution.
        </p>
      </section>

      {/* ── Policies ─────────────────────────────────────────────── */}
      <section class="bg-surface border border-border rounded-lg p-5 space-y-4">
        <h2 class="text-heading-sm text-primary font-semibold">Seat policies</h2>
        {policies.length === 0 ? (
          <p class="text-body-sm text-muted">No policies yet. Create the first one below.</p>
        ) : (
          <div class="overflow-x-auto">
            <table class="w-full text-body-sm">
              <thead>
                <tr class="text-left text-caption text-muted uppercase tracking-wide">
                  <th class="py-2 pr-4">Label</th>
                  <th class="py-2 pr-4">Models</th>
                  <th class="py-2 pr-4">Tools</th>
                  <th class="py-2 pr-4">Monthly limit</th>
                </tr>
              </thead>
              <tbody>
                {policies.map((p) => (
                  <tr key={p.policyId} class="border-t border-border">
                    <td class="py-2 pr-4 font-medium text-primary">{p.label}</td>
                    <td class="py-2 pr-4 text-secondary">
                      {p.allowedModels.length > 0 ? p.allowedModels.join(', ') : 'none (denies all models)'}
                    </td>
                    <td class="py-2 pr-4 text-secondary">
                      {p.allowedTools.length > 0 ? p.allowedTools.join(', ') : 'no restriction'}
                    </td>
                    <td class="py-2 pr-4 text-secondary">
                      {p.monthlySpendLimitUsd !== undefined ? `$${p.monthlySpendLimitUsd}` : 'none'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {canWritePolicies && (
          <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-5 items-end border-t border-border pt-4">
            <label class="block">
              <span class="text-caption text-muted">Label</span>
              <input
                value={polLabel}
                onInput={(e) => setPolLabel((e.target as HTMLInputElement).value)}
                class="mt-1 w-full rounded-lg border border-border bg-page px-3 py-2 text-body-sm"
                placeholder="Team default"
              />
            </label>
            <label class="block">
              <span class="text-caption text-muted">Allowed models (CSV)</span>
              <input
                value={polModels}
                onInput={(e) => setPolModels((e.target as HTMLInputElement).value)}
                class="mt-1 w-full rounded-lg border border-border bg-page px-3 py-2 text-body-sm"
                placeholder="us.anthropic.claude-sonnet-4-6"
              />
            </label>
            <label class="block">
              <span class="text-caption text-muted">Allowed tools (CSV)</span>
              <input
                value={polTools}
                onInput={(e) => setPolTools((e.target as HTMLInputElement).value)}
                class="mt-1 w-full rounded-lg border border-border bg-page px-3 py-2 text-body-sm"
                placeholder="empty = no restriction"
              />
            </label>
            <label class="block">
              <span class="text-caption text-muted">Monthly limit USD</span>
              <input
                value={polLimit}
                onInput={(e) => setPolLimit((e.target as HTMLInputElement).value)}
                class="mt-1 w-full rounded-lg border border-border bg-page px-3 py-2 text-body-sm"
                placeholder="25"
              />
            </label>
            <Button variant="primary" onClick={createPolicy} disabled={creatingPolicy}>
              {creatingPolicy ? 'Creating…' : 'Create policy'}
            </Button>
          </div>
        )}
      </section>

      {/* ── Seats ────────────────────────────────────────────────── */}
      <section class="bg-surface border border-border rounded-lg p-5 space-y-4">
        <h2 class="text-heading-sm text-primary font-semibold">Seats</h2>
        {seats.length === 0 ? (
          <p class="text-body-sm text-muted">
            No seats yet. Find a member's userId on the Members page, then bind it to a policy.
          </p>
        ) : (
          <div class="overflow-x-auto">
            <table class="w-full text-body-sm">
              <thead>
                <tr class="text-left text-caption text-muted uppercase tracking-wide">
                  <th class="py-2 pr-4">User</th>
                  <th class="py-2 pr-4">Status</th>
                  <th class="py-2 pr-4">Policy</th>
                  <th class="py-2 pr-4">Updated</th>
                  {canWriteSeats && <th class="py-2 pr-4">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {seats.map((s) => (
                  <tr key={s.seatId} class="border-t border-border">
                    <td class="py-2 pr-4 font-mono text-caption text-primary">{s.userId}</td>
                    <td class="py-2 pr-4">
                      <Badge variant={STATUS_TONE[s.status]}>{s.status}</Badge>
                    </td>
                    <td class="py-2 pr-4 text-secondary">{policyLabel(s.policyId)}</td>
                    <td class="py-2 pr-4 text-muted">{s.updatedAt.slice(0, 10)}</td>
                    {canWriteSeats && (
                      <td class="py-2 pr-4">
                        <div class="flex gap-2">
                          {s.status !== 'active' && (
                            <Button size="sm" variant="secondary" onClick={() => setStatus(s, 'active')}>
                              Activate
                            </Button>
                          )}
                          {s.status === 'active' && (
                            <Button size="sm" variant="secondary" onClick={() => setStatus(s, 'suspended')}>
                              Suspend
                            </Button>
                          )}
                          {s.status !== 'retired' && (
                            <Button size="sm" variant="danger" onClick={() => setStatus(s, 'retired')}>
                              Retire
                            </Button>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {canWriteSeats && (
          <div class="grid gap-2 sm:grid-cols-3 items-end border-t border-border pt-4">
            <label class="block">
              <span class="text-caption text-muted">Member userId</span>
              <input
                value={seatUserId}
                onInput={(e) => setSeatUserId((e.target as HTMLInputElement).value)}
                class="mt-1 w-full rounded-lg border border-border bg-page px-3 py-2 text-body-sm font-mono"
                placeholder="from the Members page"
              />
            </label>
            <label class="block">
              <span class="text-caption text-muted">Policy</span>
              <select
                value={seatPolicyId}
                onChange={(e) => setSeatPolicyId((e.target as HTMLSelectElement).value)}
                class="mt-1 w-full rounded-lg border border-border bg-page px-3 py-2 text-body-sm"
              >
                <option value="">Select a policy…</option>
                {policies.map((p) => (
                  <option key={p.policyId} value={p.policyId}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <Button variant="primary" onClick={createSeat} disabled={creatingSeat}>
              {creatingSeat ? 'Creating…' : 'Create seat'}
            </Button>
          </div>
        )}
      </section>

      {/* ── Usage attribution ───────────────────────────────────── */}
      <section class="bg-surface border border-border rounded-lg p-5 space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 class="text-heading-sm text-primary font-semibold">Usage by seat</h2>
          <div class="flex items-center gap-2">
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
        </div>
        {usageLoading ? (
          <Skeleton class="h-24" />
        ) : usage.length === 0 ? (
          <p class="text-body-sm text-muted">
            No attributed usage on {usageDate}. Rows appear when a seated member runs a dashboard
            chat turn.
          </p>
        ) : (
          <div class="overflow-x-auto">
            <table class="w-full text-body-sm">
              <thead>
                <tr class="text-left text-caption text-muted uppercase tracking-wide">
                  <th class="py-2 pr-4">Time</th>
                  <th class="py-2 pr-4">User</th>
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
                    <td class="py-2 pr-4 font-mono text-caption text-primary">{u.userId}</td>
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
