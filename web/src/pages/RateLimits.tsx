import { useState, useEffect } from 'preact/hooks';
import { api, type RateLimitPolicy, type RateLimitUsage } from '../lib/api';
import { Button } from '../components/Button';
import { Badge } from '../components/Badge';
import { Select } from '../components/Select';
import { Skeleton } from '../components/Skeleton';
import { toast } from '../components/Toast';

// Broad policy scopes the dashboard edits directly. 'scheduler' is special:
// its `limit` is the minimum recurrence interval in seconds, not a request
// count, so the window field is hidden for it.
const SCOPE_OPTIONS = [
  { value: 'user', label: 'Per-user (default)' },
  { value: 'agent', label: 'Per-agent (default)' },
  { value: 'scheduler', label: 'Scheduler (min interval, seconds)' },
];

// Per-identity override suffix. The backend key regex accepts user#<id> /
// agent#<id> (id: alphanum then up to 63 of alphanum/_/-), so we mirror that
// client-side to give a clear validation error before the request.
const OVERRIDE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function RateLimits() {
  const [scope, setScope] = useState<'user' | 'agent' | 'scheduler'>('user');
  const [policy, setPolicy] = useState<RateLimitPolicy | null>(null);
  const [loading, setLoading] = useState(true);

  // Optional per-identity override id. When set (for user/agent scopes), the
  // policy is read/written against the scoped key user#<id> / agent#<id> instead
  // of the broad default. Empty = edit the broad default.
  const [overrideId, setOverrideId] = useState('');

  const [limit, setLimit] = useState('');
  const [windowSeconds, setWindowSeconds] = useState('');
  const [saving, setSaving] = useState(false);

  // Live usage readout, keyed by a specific identity (user#<id> / agent#<id>).
  const [identity, setIdentity] = useState('');
  const [usage, setUsage] = useState<RateLimitUsage | null>(null);
  const [checking, setChecking] = useState(false);
  const [resetting, setResetting] = useState(false);

  const isScheduler = scope === 'scheduler';
  const trimmedOverride = overrideId.trim();
  // The effective rate-limit key: the broad scope, or scope#<id> when a valid
  // per-identity override is entered (scheduler has no per-identity form).
  const effectiveKey =
    !isScheduler && trimmedOverride && OVERRIDE_ID_RE.test(trimmedOverride)
      ? `${scope}#${trimmedOverride}`
      : scope;

  function loadPolicy(key: string) {
    setLoading(true);
    api.rateLimits.getPolicy(key)
      .then((p) => {
        setPolicy(p);
        setLimit(String(p.limit));
        setWindowSeconds(String(p.windowSeconds));
      })
      .catch((err) => toast(err instanceof Error ? err.message : 'Failed to load policy', 'error'))
      .finally(() => setLoading(false));
  }

  // Reload whenever the effective key changes (scope switch or a newly valid
  // override id). An invalid/partial override id leaves effectiveKey on the
  // broad scope, so we never fire a request the backend would 400.
  useEffect(() => { loadPolicy(effectiveKey); }, [effectiveKey]);

  async function savePolicy() {
    const limitNum = Number(limit);
    const windowNum = isScheduler ? 60 : Number(windowSeconds);
    if (!Number.isFinite(limitNum) || limitNum < 0) {
      toast('Limit must be a non-negative number', 'error');
      return;
    }
    if (!isScheduler && (!Number.isFinite(windowNum) || windowNum < 1)) {
      toast('Window must be >= 1 second', 'error');
      return;
    }
    // A non-empty but malformed override id would silently fall back to editing
    // the broad default, which is surprising, so reject it instead.
    if (!isScheduler && trimmedOverride && !OVERRIDE_ID_RE.test(trimmedOverride)) {
      toast('Identity id must be alphanumeric (with - or _), up to 64 chars', 'error');
      return;
    }
    setSaving(true);
    try {
      await api.rateLimits.setPolicy(effectiveKey, { limit: limitNum, windowSeconds: windowNum });
      toast(
        trimmedOverride && !isScheduler
          ? `Override saved for ${effectiveKey}. Propagates to all workers within about 30 seconds.`
          : 'Policy saved. Propagates to all workers within about 30 seconds.',
        'success',
      );
      loadPolicy(effectiveKey);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to save policy', 'error');
    }
    setSaving(false);
  }

  async function checkUsage() {
    if (!identity.trim()) return;
    setChecking(true);
    setUsage(null);
    try {
      const u = await api.rateLimits.getUsage(identity.trim());
      setUsage(u);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to read usage', 'error');
    }
    setChecking(false);
  }

  async function resetCounter() {
    if (!identity.trim()) return;
    setResetting(true);
    try {
      await api.rateLimits.reset(identity.trim());
      toast(`Counter reset for ${identity.trim()}`, 'success');
      checkUsage();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to reset counter', 'error');
    }
    setResetting(false);
  }

  return (
    <div>
      <div class="mb-6">
        <h1 data-tour="rate-limits-title" class="text-display-sm text-primary font-bold">Rate Limits</h1>
        <p class="text-body-sm text-secondary mt-1">
          Per-user and per-agent request quotas, plus the scheduler minimum interval. Set a specific
          identity to override the default for one user or agent. Reads are operator; edits are admin.
        </p>
      </div>

      <section data-tour="rate-limits-policy" class="mb-8">
        <h2 class="text-heading-sm font-semibold text-secondary mb-4 uppercase tracking-wider">Policy</h2>
        <div class="bg-surface border border-border rounded-xl p-5 max-w-2xl">
          <div class="flex flex-col sm:flex-row sm:items-start gap-4 mb-4">
            <div data-tour="rate-limits-scope" class="w-full max-w-xs">
              <label class="block text-caption text-secondary font-medium mb-1">Scope</label>
              <Select
                value={scope}
                onChange={(v) => {
                  const next = v as 'user' | 'agent' | 'scheduler';
                  setScope(next);
                  // Scheduler has no per-identity form, so clear any override id.
                  if (next === 'scheduler') setOverrideId('');
                }}
                options={SCOPE_OPTIONS}
              />
            </div>
            {!isScheduler && (
              <div class="w-full max-w-xs">
                <label class="block text-caption text-secondary font-medium mb-1">
                  Specific identity (optional)
                </label>
                <input
                  value={overrideId}
                  onInput={(e) => setOverrideId((e.target as HTMLInputElement).value)}
                  placeholder={scope === 'agent' ? 'e.g. main' : 'e.g. abc123'}
                  class="w-full bg-bg-elevated border border-border rounded-lg px-3 py-2 text-body-sm font-mono text-primary placeholder:text-muted placeholder:font-sans outline-none focus:ring-1 focus:ring-accent"
                />
                <p class="text-overline text-muted mt-1">
                  Leave blank to edit the {scope} default. Set an id to override one{' '}
                  <span class="font-mono">{scope}#{trimmedOverride || 'id'}</span>.
                </p>
              </div>
            )}
          </div>

          {loading ? (
            <Skeleton height="44px" width="100%" />
          ) : (
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label class="block text-caption text-secondary font-medium mb-1">
                  {isScheduler ? 'Minimum interval (seconds)' : 'Max requests per window'}
                </label>
                <input
                  type="number"
                  min={0}
                  value={limit}
                  onInput={(e) => setLimit((e.target as HTMLInputElement).value)}
                  placeholder="60"
                  class="w-full bg-bg-elevated border border-border rounded-lg px-3 py-2 text-body-sm font-mono text-primary placeholder:text-muted outline-none focus:ring-1 focus:ring-accent"
                />
                {!isScheduler && <p class="text-overline text-muted mt-1">0 disables the quota (unlimited)</p>}
              </div>
              {!isScheduler && (
                <div>
                  <label class="block text-caption text-secondary font-medium mb-1">Window (seconds)</label>
                  <input
                    type="number"
                    min={1}
                    value={windowSeconds}
                    onInput={(e) => setWindowSeconds((e.target as HTMLInputElement).value)}
                    placeholder="60"
                    class="w-full bg-bg-elevated border border-border rounded-lg px-3 py-2 text-body-sm font-mono text-primary placeholder:text-muted outline-none focus:ring-1 focus:ring-accent"
                  />
                </div>
              )}
            </div>
          )}

          <div data-tour="rate-limits-save" class="mt-4 flex items-center justify-between gap-4">
            <div class="text-caption text-muted">
              {policy && (
                <span>
                  <span class="font-mono text-secondary">{effectiveKey}</span> ·{' '}
                  Current: <span class="font-mono text-secondary">{policy.limit}</span>
                  {isScheduler ? (
                    <> seconds minimum</>
                  ) : (
                    <> per <span class="font-mono text-secondary">{policy.windowSeconds}s</span></>
                  )}
                </span>
              )}
            </div>
            <Button loading={saving} onClick={savePolicy}>Save policy</Button>
          </div>

          <p class="text-caption text-muted mt-3">
            Policy changes propagate to all workers within about 30 seconds (in-process cache TTL),
            not instantly. Enforcement fails open: a DDB blip lets traffic through rather than blocking it.
          </p>
        </div>
      </section>

      <section data-tour="rate-limits-usage">
        <h2 class="text-heading-sm font-semibold text-secondary mb-4 uppercase tracking-wider">Live usage</h2>
        <div class="bg-surface border border-border rounded-xl p-5 max-w-2xl">
          <label class="block text-caption text-secondary font-medium mb-1">Identity</label>
          <div class="flex items-center gap-3">
            <input
              value={identity}
              onInput={(e) => setIdentity((e.target as HTMLInputElement).value)}
              placeholder="user#abc123 or agent#main"
              class="flex-1 bg-bg-elevated border border-border rounded-lg px-3 py-2 text-body-sm font-mono text-primary placeholder:text-muted outline-none focus:ring-1 focus:ring-accent"
            />
            <Button size="sm" loading={checking} disabled={!identity.trim()} onClick={checkUsage}>Check</Button>
            <Button
              size="sm"
              variant="ghost"
              loading={resetting}
              disabled={!identity.trim()}
              onClick={resetCounter}
            >
              Reset
            </Button>
          </div>

          {usage && (
            <div class="mt-4 pt-4 border-t border-border flex items-center gap-3 text-caption">
              <Badge variant={usage.remaining === 0 && usage.limit > 0 ? 'danger' : 'success'}>
                {usage.used} / {usage.limit > 0 ? usage.limit : '∞'}
              </Badge>
              {usage.limit > 0 && (
                <span class="text-muted">{usage.remaining} remaining</span>
              )}
              {usage.resetAt && (
                <span class="text-muted">
                  window resets {new Date(usage.resetAt).toLocaleTimeString()}
                </span>
              )}
              <span class="font-mono text-muted">{usage.key}</span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
