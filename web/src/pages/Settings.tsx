import { useState, useEffect } from 'preact/hooks';
import { api, downloadFile, type CostCap } from '../lib/api';
import { savedTourProgress, startTour, visibleTourTabs } from '../lib/tour/engine';
import { Button } from '../components/Button';
import { Badge } from '../components/Badge';
import { Skeleton } from '../components/Skeleton';
import { Modal } from '../components/Modal';
import { Select } from '../components/Select';
import { Toggle } from '../components/Toggle';
import { InfoTooltip } from '../components/InfoTooltip';
import { toast } from '../components/Toast';
import {
  setTheme,
  themePreference,
  DEFAULT_PRIMARY,
  DEFAULT_ACCENT,
  // Named-theme engine (theme.ts owns state, persistence, and live re-skin).
  themesLibrary,
  activeThemeId,
  createTheme,
  updateTheme,
  deleteTheme,
  selectTheme,
  reconcileThemes,
  DEFAULT_THEME_ID,
  type NamedTheme,
  type ThemeInput,
} from '../lib/theme';

type Role = 'viewer' | 'operator' | 'admin';

interface TierInfo {
  tier: number;
  label: string;
  dailyCostCapUsd: number;
}

interface TokenInfo {
  hashPrefix: string;
  label: string;
  createdAt: string;
  lastUsedAt: string;
  active: boolean;
  role: Role;
  expiresAt: string | null;
}

const ROLE_OPTIONS: { value: Role; label: string }[] = [
  { value: 'viewer', label: 'Viewer — read-only' },
  { value: 'operator', label: 'Operator — day-to-day mutations' },
  { value: 'admin', label: 'Admin — full control' },
];

const EXPIRY_OPTIONS: { value: string; label: string }[] = [
  { value: '0', label: 'Never expires' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
];

const ROLE_BADGE: Record<Role, 'success' | 'info' | 'default'> = {
  admin: 'success',
  operator: 'info',
  viewer: 'default',
};

function formatExpiry(expiresAt: string | null): { text: string; expired: boolean } {
  if (!expiresAt) return { text: 'Never', expired: false };
  const ts = Date.parse(expiresAt);
  if (!Number.isFinite(ts)) return { text: 'Never', expired: false };
  if (ts <= Date.now()) return { text: 'Expired', expired: true };
  return { text: new Date(ts).toLocaleDateString(), expired: false };
}

export function Settings() {
  const [tier, setTierInfo] = useState<TierInfo | null>(null);
  const [costToday, setCostToday] = useState<number>(0);
  const [tokens, setTokens] = useState<TokenInfo[]>([]);
  const [myRole, setMyRole] = useState<Role>('viewer');
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [newRole, setNewRole] = useState<Role>('operator');
  const [newExpiry, setNewExpiry] = useState('0');
  const [newToken, setNewToken] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [currentTheme, setCurrentTheme] = useState(themePreference.value);
  const [costCap, setCostCap] = useState<CostCap | null>(null);
  const [capInput, setCapInput] = useState('');
  const [savingCap, setSavingCap] = useState(false);
  // Async cost-report mode (runtime-config cost/report_async_enabled).
  const [asyncReport, setAsyncReport] = useState<boolean | null>(null);
  const [asyncBusy, setAsyncBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  // Jarvis reads profile/first_name from runtime-config to address the user by
  // name; this field is the single writer for it.
  const [firstName, setFirstName] = useState('');
  const [savingName, setSavingName] = useState(false);

  // Jarvis voice canary allowlist (admin-only). The backend is keyed by token
  // hash with no list route, so this is add/remove by token hash only.
  const [canaryHash, setCanaryHash] = useState('');
  const [canaryLabel, setCanaryLabel] = useState('');
  const [canaryAdding, setCanaryAdding] = useState(false);
  const [canaryRemoving, setCanaryRemoving] = useState(false);

  // Named-theme library + active id come straight from the engine signals
  // (theme.ts), which are hydrated from the localStorage cache at module load so
  // the list renders without a flash. load() reconciles them from runtime-config.
  const themes = themesLibrary.value;
  const activeId = activeThemeId.value;
  const [themeModalOpen, setThemeModalOpen] = useState(false);
  // null = creating a new theme; otherwise the id of the theme being edited.
  const [editingThemeId, setEditingThemeId] = useState<string | null>(null);
  const [tName, setTName] = useState('');
  const [tTagline, setTTagline] = useState('');
  const [tLogo, setTLogo] = useState('');
  const [tIcon, setTIcon] = useState('');
  const [tPrimary, setTPrimary] = useState(DEFAULT_PRIMARY);
  const [tAccent, setTAccent] = useState(DEFAULT_ACCENT);
  const [savingTheme, setSavingTheme] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [uploadingIcon, setUploadingIcon] = useState(false);
  const [activatingId, setActivatingId] = useState<string | null>(null);
  const [deleteThemeId, setDeleteThemeId] = useState<string | null>(null);
  const [deletingTheme, setDeletingTheme] = useState(false);

  const isAdmin = myRole === 'admin';

  function load() {
    // Each call is independent so an admin-only 403 on /tokens (for a
    // viewer/operator) doesn't blank the rest of the page.
    Promise.allSettled([
      api.get<TierInfo>('/tier'),
      api.get<{ costUsd: number }>('/cost-today'),
      api.get<{ role: Role }>('/whoami'),
      api.get<{ tokens: TokenInfo[] }>('/tokens'),
      api.costCap.get(),
      api.config.get('profile', 'first_name'),
      // Reconcile the theme library + active id with the authoritative backend
      // config. The engine already applied the cached active theme at boot, so
      // this only refreshes (and re-skins if the server differs).
      reconcileThemes(),
      // Async cost-report flag (admin-readable; a non-admin 403 is swallowed).
      api.config.get('cost', 'report_async_enabled'),
    ]).then(([t, c, who, tk, cap, name, th, asyncCfg]) => {
      if (t.status === 'fulfilled') setTierInfo(t.value);
      if (c.status === 'fulfilled') setCostToday(c.value.costUsd);
      if (who.status === 'fulfilled') setMyRole(who.value.role);
      if (tk.status === 'fulfilled') setTokens(tk.value.tokens);
      if (cap.status === 'fulfilled') {
        setCostCap(cap.value);
        setCapInput(String(cap.value.dailyCapUsd));
      }
      if (name.status === 'fulfilled' && name.value.value != null) {
        setFirstName(name.value.value);
      }
      if (asyncCfg.status === 'fulfilled') setAsyncReport(asyncCfg.value.value === 'true');
      if (th.status === 'rejected') {
        // The cached/boot theme stays live; just surface why the refresh failed.
        toast(th.reason instanceof Error ? th.reason.message : 'Failed to load themes', 'error');
      }
    }).finally(() => setLoading(false));
  }

  async function toggleAsyncReport() {
    const next = !(asyncReport ?? false);
    setAsyncBusy(true);
    try {
      await api.config.set('cost', 'report_async_enabled', String(next));
      setAsyncReport(next);
      toast(`Async cost report ${next ? 'enabled' : 'disabled'}`, 'success');
    } catch (e) {
      toast(`Could not update: ${e instanceof Error ? e.message : 'error'}`, 'error');
    } finally {
      setAsyncBusy(false);
    }
  }

  async function activateTheme(id: string) {
    if (id === activeId) return;
    setActivatingId(id);
    try {
      const theme = await selectTheme(id);
      toast(`Activated ${theme.name}`, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to activate theme', 'error');
    }
    setActivatingId(null);
  }

  function openCreateTheme() {
    setEditingThemeId(null);
    setTName('');
    setTTagline('');
    setTLogo('');
    setTIcon('');
    setTPrimary(DEFAULT_PRIMARY);
    setTAccent(DEFAULT_ACCENT);
    setThemeModalOpen(true);
  }

  function openEditTheme(theme: NamedTheme) {
    setEditingThemeId(theme.id);
    setTName(theme.name);
    setTTagline(theme.tagline ?? '');
    setTLogo(theme.logoUrl ?? '');
    setTIcon(theme.iconUrl ?? '');
    setTPrimary(theme.primaryColor || DEFAULT_PRIMARY);
    setTAccent(theme.accentColor || DEFAULT_ACCENT);
    setThemeModalOpen(true);
  }

  // Upload a logo/favicon file: PUT it to the CORS-enabled staging bucket via a
  // presigned URL (bypasses the 8KB WAF body cap), then commit it to the
  // persistent curated bucket and store the returned /api/branding/asset/<id> URL
  // in the field. Mirrors the Knowledge upload's presign-then-PUT flow.
  async function uploadBrandingAsset(
    file: File,
    setUrl: (u: string) => void,
    setBusy: (b: boolean) => void,
  ) {
    const ext = file.name.toLowerCase().split('.').pop() ?? '';
    const ACCEPTED = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico'];
    if (!ACCEPTED.includes(ext)) {
      toast('Use a PNG, JPG, GIF, WebP, SVG, or ICO image', 'error');
      return;
    }
    const MAX = 2 * 1024 * 1024; // 2MB is ample for a header logo / favicon.
    if (file.size > MAX) {
      toast(`Image is ${(file.size / 1024 / 1024).toFixed(1)}MB, over the 2MB limit`, 'error');
      return;
    }
    setBusy(true);
    try {
      const { url, assetId, stagingKey } = await api.post<{
        url: string;
        assetId: string;
        stagingKey: string;
      }>('/branding/upload-url', { filename: file.name });
      const put = await fetch(url, { method: 'PUT', body: file });
      if (!put.ok) throw new Error(`Upload failed (${put.status})`);
      const { assetUrl } = await api.post<{ assetUrl: string }>('/branding/commit', {
        assetId,
        stagingKey,
      });
      setUrl(assetUrl);
      toast('Image uploaded', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Upload failed', 'error');
    }
    setBusy(false);
  }

  async function saveTheme() {
    // The engine validates name/colors/URLs in buildTheme and throws precise
    // messages; we just collect the input and surface any error as a toast.
    const input: ThemeInput = {
      name: tName,
      tagline: tTagline.trim() || null,
      primaryColor: tPrimary,
      accentColor: tAccent,
      logoUrl: tLogo.trim() || null,
      iconUrl: tIcon.trim() || null,
    };
    setSavingTheme(true);
    try {
      if (editingThemeId) {
        // updateTheme re-applies live if the edited theme is the active one.
        await updateTheme(editingThemeId, input);
        toast('Theme updated', 'success');
      } else {
        // createTheme saves but does not auto-activate.
        await createTheme(input);
        toast('Theme created', 'success');
      }
      setThemeModalOpen(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to save theme', 'error');
    }
    setSavingTheme(false);
  }

  async function confirmDeleteTheme() {
    const id = deleteThemeId;
    if (!id || id === DEFAULT_THEME_ID) {
      setDeleteThemeId(null);
      return;
    }
    setDeletingTheme(true);
    try {
      // deleteTheme falls back to the default (and re-skins) if the deleted
      // theme was active.
      await deleteTheme(id);
      toast('Theme deleted', 'success');
      setDeleteThemeId(null);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to delete theme', 'error');
    }
    setDeletingTheme(false);
  }

  async function saveCostCap() {
    const next = Number(capInput);
    if (!Number.isFinite(next) || next <= 0) {
      toast('Enter a cost cap greater than zero', 'error');
      return;
    }
    setSavingCap(true);
    try {
      const updated = await api.costCap.set(next);
      setCostCap(updated);
      setCapInput(String(updated.dailyCapUsd));
      toast('Daily cost cap updated', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setSavingCap(false);
  }

  async function saveFirstName() {
    const next = firstName.trim();
    setSavingName(true);
    try {
      await api.config.set('profile', 'first_name', next);
      // Reflect the trimmed value we actually persisted (so a trailing space the
      // user typed doesn't linger in the field).
      setFirstName(next);
      toast(next ? 'Name saved' : 'Name cleared', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setSavingName(false);
  }

  // Jarvis canary: add the entered token hash to the voice allowlist. Admin-only
  // and re-checked server-side. The label is an optional human note stored with
  // the entry.
  async function addCanary() {
    const hash = canaryHash.trim();
    if (!hash) {
      toast('Enter a token hash', 'error');
      return;
    }
    setCanaryAdding(true);
    try {
      await api.jarvisCanary.add(hash, canaryLabel.trim() || undefined);
      toast('Added to the Jarvis voice canary allowlist', 'success');
      setCanaryHash('');
      setCanaryLabel('');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to add to allowlist', 'error');
    }
    setCanaryAdding(false);
  }

  // Jarvis canary: remove the entered token hash from the allowlist.
  async function removeCanary() {
    const hash = canaryHash.trim();
    if (!hash) {
      toast('Enter a token hash to remove', 'error');
      return;
    }
    setCanaryRemoving(true);
    try {
      await api.jarvisCanary.remove(hash);
      toast('Removed from the Jarvis voice canary allowlist', 'success');
      setCanaryHash('');
      setCanaryLabel('');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to remove from allowlist', 'error');
    }
    setCanaryRemoving(false);
  }

  useEffect(() => { load(); }, []);

  async function createToken() {
    if (!newLabel.trim()) return;
    setCreating(true);
    try {
      const expiresInDays = Number(newExpiry);
      const res = await api.post<{ token: string; hashPrefix: string }>('/tokens', {
        label: newLabel.trim(),
        role: newRole,
        ...(expiresInDays > 0 ? { expiresInDays } : {}),
      });
      setNewToken(res.token);
      load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setCreating(false);
  }

  async function revokeToken(prefix: string) {
    try {
      await api.del(`/tokens/${prefix}`);
      toast('Token revoked', 'success');
      load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
  }

  async function handleExport(endpoint: string, filename: string) {
    // Routed through downloadFile: bearer from getToken() (sessionStorage-first,
    // so it works on the default login), res.ok checked before saving so an
    // error body is never written to disk as a .csv, and no spurious window.open
    // tab. `endpoint` may already carry a query string (e.g. "audit/export?days=7"),
    // so append format=csv with the right separator.
    const sep = endpoint.includes('?') ? '&' : '?';
    setExporting(true);
    try {
      await downloadFile(`/${endpoint}${sep}format=csv`, filename);
      toast('Export ready', 'success');
    } catch (err) {
      toast(`Export failed. ${err instanceof Error ? err.message : 'unknown error'}`, 'error');
    } finally {
      setExporting(false);
    }
  }

  // Prefer the effective cap from the runtime-config backed /cost-cap endpoint;
  // fall back to the tier default if it has not resolved yet.
  const effectiveCap = costCap?.dailyCapUsd ?? tier?.dailyCostCapUsd ?? 50;
  const capPct = effectiveCap > 0 ? Math.min(100, Math.round((costToday / effectiveCap) * 100)) : 0;

  return (
    <div>
      <div class="mb-8">
        <h1 data-tour="settings-title" class="text-display-sm text-primary font-bold">Settings</h1>
        <p class="text-body-sm text-secondary mt-1">Account configuration and data export</p>
      </div>

      {loading ? (
        <div class="space-y-6 max-w-2xl">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} class="bg-surface border border-border rounded-xl p-6">
              <Skeleton height="16px" width="30%" class="mb-3" />
              <Skeleton height="32px" width="60%" />
            </div>
          ))}
        </div>
      ) : (
        <div class="space-y-6 max-w-2xl">
          <div data-tour="settings-account" class="bg-surface border border-border rounded-xl p-6">
            <h2 class="text-heading-sm font-semibold mb-4">Account</h2>
            <div class="grid grid-cols-3 gap-4">
              <div>
                <p class="text-caption text-muted">Tier</p>
                <p class="text-body font-medium text-primary">{tier?.label ?? 'Standard'}</p>
              </div>
              <div>
                <p class="text-caption text-muted">Region</p>
                <p class="text-body font-medium text-primary">us-east-1</p>
              </div>
              <div>
                <p class="text-caption text-muted">Your access</p>
                <Badge variant={ROLE_BADGE[myRole]} class="mt-0.5">{myRole}</Badge>
              </div>
            </div>
          </div>

          <div data-tour="settings-name" class="bg-surface border border-border rounded-xl p-6">
            <h2 class="text-heading-sm font-semibold mb-4">Your name</h2>
            <p class="text-body-sm text-secondary mb-4">First name Jarvis uses to address you. Leave blank for a neutral greeting. Applies fleet-wide within ~30 seconds.</p>
            {isAdmin ? (
              <div class="flex items-end gap-3">
                <div class="max-w-[240px]">
                  <label class="block text-caption text-secondary font-medium mb-1">First name</label>
                  <input
                    value={firstName}
                    onInput={(e) => setFirstName((e.target as HTMLInputElement).value)}
                    placeholder="e.g. Emmanuel"
                    maxLength={60}
                    class="w-full bg-bg-elevated border border-border rounded-lg px-3 py-2 text-body-sm outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>
                <Button size="sm" loading={savingName} onClick={saveFirstName}>Save</Button>
              </div>
            ) : (
              <p class="text-body-sm text-muted">
                {firstName
                  ? <>Jarvis addresses you as <span class="font-medium text-secondary">{firstName}</span>.</>
                  : 'No name set; Jarvis uses a neutral greeting.'}
                {' '}Setting it requires an admin token (your access is <span class="font-medium text-secondary">{myRole}</span>).
              </p>
            )}
          </div>

          {isAdmin && (
            <div class="bg-surface border border-border rounded-xl p-6">
              <h2 class="text-heading-sm font-semibold mb-1">Jarvis voice canary</h2>
              <p class="text-body-sm text-secondary mb-4">
                When Jarvis canary mode is active, only allowlisted principals get voice. Add or
                remove a principal by their token hash. Admin-only and exempt from the Jarvis kill
                switch so the list can be bootstrapped. There is no list view; the backend is keyed
                by token hash only.
              </p>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3">
                <div>
                  <label class="block text-caption text-secondary font-medium mb-1">Token hash</label>
                  <input
                    value={canaryHash}
                    onInput={(e) => setCanaryHash((e.target as HTMLInputElement).value)}
                    placeholder="sha256 token hash"
                    autocomplete="off"
                    class="w-full bg-bg-elevated border border-border rounded-lg px-3 py-2 text-body-sm font-mono text-primary placeholder:text-muted placeholder:font-sans outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>
                <div>
                  <label class="block text-caption text-secondary font-medium mb-1">Label (optional)</label>
                  <input
                    value={canaryLabel}
                    onInput={(e) => setCanaryLabel((e.target as HTMLInputElement).value)}
                    placeholder="e.g. on-call laptop"
                    autocomplete="off"
                    class="w-full bg-bg-elevated border border-border rounded-lg px-3 py-2 text-body-sm text-primary placeholder:text-muted outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>
              </div>
              <div class="flex items-center gap-3">
                <Button size="sm" loading={canaryAdding} disabled={!canaryHash.trim() || canaryRemoving} onClick={addCanary}>
                  Add to allowlist
                </Button>
                <Button size="sm" variant="ghost" loading={canaryRemoving} disabled={!canaryHash.trim() || canaryAdding} onClick={removeCanary}>
                  Remove
                </Button>
              </div>
            </div>
          )}

          <div data-tour="settings-cost-cap" class="bg-surface border border-border rounded-xl p-6">
            <div class="flex items-center justify-between mb-4">
              <h2 class="text-heading-sm font-semibold">Daily Cost Cap</h2>
              {costCap && (
                <Badge variant={costCap.source === 'runtime-config' ? 'info' : 'default'}>
                  {costCap.source === 'runtime-config' ? 'Custom override' : 'Default'}
                </Badge>
              )}
            </div>
            <div class="flex items-center gap-4 mb-3">
              <span class="text-body-sm text-primary font-medium">${costToday.toFixed(2)}</span>
              <span class="text-body-sm text-muted">of ${effectiveCap.toFixed(2)}</span>
            </div>
            <div class="w-full h-2 bg-bg-elevated rounded-full overflow-hidden">
              <div
                class={`h-full rounded-full transition-all ${capPct > 80 ? 'bg-danger' : capPct > 50 ? 'bg-warning' : 'bg-success'}`}
                style={{ width: `${capPct}%` }}
              />
            </div>
            <p class="text-caption text-muted mt-1">{capPct}% used</p>
            {isAdmin && (
              <div class="mt-4 pt-4 border-t border-border">
                <label class="block text-caption text-secondary font-medium mb-1">Effective cap (USD / day)</label>
                <div class="flex items-end gap-3">
                  <div class="relative flex-1 max-w-[200px]">
                    <span class="absolute left-3 top-1/2 -translate-y-1/2 text-body-sm text-muted">$</span>
                    <input
                      type="number"
                      min="1"
                      step="0.01"
                      value={capInput}
                      onInput={(e) => setCapInput((e.target as HTMLInputElement).value)}
                      class="w-full bg-bg-elevated border border-border rounded-lg pl-7 pr-3 py-2 text-body-sm outline-none focus:ring-2 focus:ring-primary/50"
                    />
                  </div>
                  <Button size="sm" loading={savingCap} onClick={saveCostCap}>Save</Button>
                </div>
                <p class="text-caption text-muted mt-2">Applies fleet-wide within ~30 seconds. Tier default is ${tier?.dailyCostCapUsd?.toFixed(2) ?? '50.00'}.</p>
              </div>
            )}
          </div>

          {/* Async cost report — admin-only runtime-config toggle. */}
          {isAdmin && (
            <div class="bg-surface border border-border rounded-xl p-6">
              <div class="flex items-start justify-between gap-4 flex-wrap">
                <div class="min-w-0">
                  <h2 class="text-heading-sm font-semibold inline-flex items-center gap-1.5">
                    Async cost report
                    <InfoTooltip text="OFF (default): the Cost tab generates the AI report in one request that must finish within the 60-second CDN timeout, so it is trimmed (fewer drivers/optimizations and the Claude Code plan can be cut short) but appears inline in about 45 seconds. ON: the report runs in the background and the page polls for it, so there is no 60-second ceiling. You get the fuller, untrimmed report with more services, more optimizations, and a complete plan, at the cost of a slightly longer wait (about a minute or two) with a 'generating' state. Same per-report model cost either way; runs once even if several people request it at the same time." />
                  </h2>
                  <p class="text-body-sm text-secondary mt-1 max-w-xl">
                    Generate the AI cost report in the background instead of inline. Removes the 60-second
                    timeout limit so the report is fuller and the Claude Code plan is never trimmed.
                    {asyncReport != null ? ` Currently ${asyncReport ? 'on' : 'off'}.` : ''}
                  </p>
                </div>
                <Toggle
                  checked={!!asyncReport}
                  busy={asyncBusy}
                  disabled={asyncReport === null}
                  ariaLabel={asyncReport ? 'Async cost report on' : 'Async cost report off'}
                  onChange={() => toggleAsyncReport()}
                >
                  <span class="text-body-sm font-medium text-secondary whitespace-nowrap">
                    {asyncReport === null ? 'Async …' : asyncReport ? 'Async on' : 'Async off'}
                  </span>
                </Toggle>
              </div>
            </div>
          )}

          {/* Session Idle Timeout control removed: it wrote session/idle_minutes
              to runtime-config, but NO backend code reads that key, so the save
              confirmed "updated" with zero effect (a facade). Real idle-timeout
              enforcement requires last-activity tracking on the dashboard auth
              path (src/lib/auth/dashboard-auth.ts) and is tracked as a backlog
              feature; do not re-add this control until that exists. */}

          <div data-tour="settings-api-access" class="bg-surface border border-border rounded-xl p-6">
            <div class="flex items-center justify-between mb-4">
              <h2 class="text-heading-sm font-semibold">API Access</h2>
              {isAdmin && (
                <Button variant="primary" size="sm" onClick={() => { setCreateOpen(true); setNewLabel(''); setNewRole('operator'); setNewExpiry('0'); setNewToken(null); }}>
                  Create Token
                </Button>
              )}
            </div>
            {!isAdmin ? (
              <p class="text-body-sm text-muted">Token management requires an admin token. Your current access is <span class="font-medium text-secondary">{myRole}</span>.</p>
            ) : tokens.length === 0 ? (
              <p class="text-body-sm text-muted">No tokens configured. Create one to enable API access.</p>
            ) : (
              <table class="w-full text-left">
                <thead>
                  <tr class="border-b border-border">
                    <th class="py-2 text-caption text-muted font-medium">Label</th>
                    <th class="py-2 text-caption text-muted font-medium">Role</th>
                    <th class="py-2 text-caption text-muted font-medium">Created</th>
                    <th class="py-2 text-caption text-muted font-medium">Last Used</th>
                    <th class="py-2 text-caption text-muted font-medium">Expires</th>
                    <th class="py-2 text-caption text-muted font-medium">Status</th>
                    <th class="py-2"></th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-border">
                  {tokens.map((t) => {
                    const exp = formatExpiry(t.expiresAt);
                    return (
                      <tr key={t.hashPrefix}>
                        <td class="py-2 text-body-sm text-primary">{t.label}</td>
                        <td class="py-2"><Badge variant={ROLE_BADGE[t.role]}>{t.role}</Badge></td>
                        <td class="py-2 text-body-sm text-secondary">{new Date(t.createdAt).toLocaleDateString()}</td>
                        <td class="py-2 text-body-sm text-secondary">{new Date(t.lastUsedAt).toLocaleDateString()}</td>
                        <td class={`py-2 text-body-sm ${exp.expired ? 'text-danger' : 'text-secondary'}`}>{exp.text}</td>
                        <td class="py-2"><Badge variant={t.active ? 'success' : 'danger'}>{t.active ? 'Active' : 'Revoked'}</Badge></td>
                        <td class="py-2">
                          {t.active && (
                            <button onClick={() => revokeToken(t.hashPrefix)} class="text-caption text-danger hover:underline">Revoke</button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          <div data-tour="settings-theme-mode" class="bg-surface border border-border rounded-xl p-6">
            <h2 class="text-heading-sm font-semibold mb-4">Theme</h2>
            <div class="flex gap-2">
              {(['dark', 'light', 'system'] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => { setTheme(t); setCurrentTheme(t); }}
                  class={`px-4 py-2 rounded-lg text-body-sm font-medium transition-colors ${currentTheme === t ? 'bg-primary text-inverse' : 'bg-bg-elevated text-secondary hover:bg-surface-hover'}`}
                >
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>
          </div>

          <div data-tour="settings-themes" class="bg-surface border border-border rounded-xl p-6">
            <div class="flex items-center justify-between mb-1">
              <h2 class="text-heading-sm font-semibold">Themes</h2>
              {isAdmin && (
                <Button variant="primary" size="sm" onClick={openCreateTheme}>Create theme</Button>
              )}
            </div>
            <p class="text-body-sm text-secondary mb-4">
              White-label the dashboard. Each theme bundles a company name, tagline, logo, favicon, and brand colors. Upload an image or paste a URL. Selecting one re-skins the whole UI live. Light and dark mode stay an independent toggle above.
            </p>
            <div class="space-y-2">
              {themes.map((t) => {
                const active = t.id === activeId;
                const isDefault = t.id === DEFAULT_THEME_ID;
                return (
                  <div
                    key={t.id}
                    class={`flex items-center gap-3 rounded-lg border p-3 transition-colors ${active ? 'border-primary bg-primary/5' : 'border-border bg-bg-elevated'}`}
                  >
                    {/* Color swatch: primary over accent so a theme is recognizable at a glance. */}
                    <div class="flex shrink-0 overflow-hidden rounded-md border border-border" aria-hidden="true">
                      <span class="block h-9 w-5" style={{ backgroundColor: t.primaryColor }} />
                      <span class="block h-9 w-5" style={{ backgroundColor: t.accentColor }} />
                    </div>
                    {t.logoUrl && (
                      <img
                        src={t.logoUrl}
                        alt=""
                        class="h-6 w-auto max-w-[80px] object-contain rounded-sm shrink-0"
                      />
                    )}
                    <div class="min-w-0 flex-1">
                      <div class="flex items-center gap-2">
                        <span class="text-body-sm font-medium text-primary truncate">{t.name}</span>
                        {active && <Badge variant="success">Active</Badge>}
                        {isDefault && <Badge variant="default">Default</Badge>}
                      </div>
                      <p class="text-caption text-muted font-mono truncate">{t.primaryColor} · {t.accentColor}</p>
                    </div>
                    <div class="flex items-center gap-2 shrink-0">
                      {!active && (
                        <Button
                          size="sm"
                          variant="secondary"
                          loading={activatingId === t.id}
                          onClick={() => activateTheme(t.id)}
                        >
                          Activate
                        </Button>
                      )}
                      {isAdmin && !isDefault && (
                        <>
                          <button
                            onClick={() => openEditTheme(t)}
                            class="text-caption text-secondary hover:text-primary transition-colors"
                          >
                            Edit
                          </button>
                          <button
                            onClick={() => setDeleteThemeId(t.id)}
                            class="text-caption text-danger hover:underline"
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            {!isAdmin && (
              <p class="text-caption text-muted mt-3">
                You can activate an existing theme. Creating, editing, and deleting themes requires an admin token (your access is <span class="font-medium text-secondary">{myRole}</span>).
              </p>
            )}
          </div>

          <div data-tour="settings-export" class="bg-surface border border-border rounded-xl p-6">
            <h2 class="text-heading-sm font-semibold mb-4">Data Export</h2>
            <div class="flex gap-3">
              <Button variant="secondary" size="sm" disabled={exporting} onClick={() => handleExport('audit/export?days=7', `audit-${new Date().toISOString().slice(0, 10)}.csv`)}>
                Export Audit Log
              </Button>
              <Button variant="secondary" size="sm" disabled={exporting} onClick={() => handleExport('usage/export?days=7', `usage-${new Date().toISOString().slice(0, 10)}.csv`)}>
                Export Usage
              </Button>
              <Button variant="secondary" size="sm" disabled={exporting} onClick={() => handleExport('sessions/export', `sessions-${new Date().toISOString().slice(0, 10)}.csv`)}>
                Export Sessions
              </Button>
            </div>
          </div>

          <GuidedTourCard />
        </div>
      )}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Create API Token">
        <div class="space-y-4">
          {newToken ? (
            <>
              <p class="text-body-sm text-secondary">Copy this token now. It will not be shown again.</p>
              <div class="bg-bg-elevated border border-border rounded-lg p-3">
                <code class="text-body-sm text-primary break-all font-mono">{newToken}</code>
              </div>
              <Button
                onClick={() => { navigator.clipboard.writeText(newToken); toast('Copied', 'success'); }}
              >
                Copy to clipboard
              </Button>
            </>
          ) : (
            <>
              <div>
                <label class="block text-caption text-secondary font-medium mb-1">Token label</label>
                <input
                  value={newLabel}
                  onInput={(e) => setNewLabel((e.target as HTMLInputElement).value)}
                  placeholder="e.g. Emmanuel's token"
                  class="w-full bg-bg-elevated border border-border rounded-lg px-3 py-2 text-body-sm outline-none focus:ring-2 focus:ring-primary/50"
                  autoFocus
                />
              </div>
              <div class="grid grid-cols-2 gap-3">
                <div>
                  <label class="block text-caption text-secondary font-medium mb-1">Role</label>
                  <Select value={newRole} onChange={(v) => setNewRole(v as Role)} options={ROLE_OPTIONS} class="w-full" />
                </div>
                <div>
                  <label class="block text-caption text-secondary font-medium mb-1">Expiry</label>
                  <Select value={newExpiry} onChange={setNewExpiry} options={EXPIRY_OPTIONS} class="w-full" />
                </div>
              </div>
              <p class="text-caption text-muted">
                {newRole === 'viewer' && 'Read-only access to all dashboard data.'}
                {newRole === 'operator' && 'Can run day-to-day mutations, but not flip kill switches or manage tokens.'}
                {newRole === 'admin' && 'Full control, including kill switches, panic, and token management.'}
              </p>
              <div class="flex gap-3 justify-end">
                <Button variant="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
                <Button loading={creating} onClick={createToken}>Create</Button>
              </div>
            </>
          )}
        </div>
      </Modal>

      <Modal
        open={themeModalOpen}
        onClose={() => setThemeModalOpen(false)}
        title={editingThemeId ? 'Edit theme' : 'Create theme'}
        size="md"
      >
        <div class="space-y-4">
          <div>
            <label class="block text-caption text-secondary font-medium mb-1">Company name</label>
            <input
              value={tName}
              onInput={(e) => setTName((e.target as HTMLInputElement).value)}
              placeholder="e.g. Acme Enterprise"
              class="w-full bg-bg-elevated border border-border rounded-lg px-3 py-2 text-body-sm outline-none focus:ring-2 focus:ring-primary/50"
              autoFocus
            />
            <p class="text-caption text-muted mt-1">Shows in the header and the browser tab title.</p>
          </div>
          <div>
            <label class="block text-caption text-secondary font-medium mb-1">Tagline / subtitle</label>
            <input
              value={tTagline}
              onInput={(e) => setTTagline((e.target as HTMLInputElement).value)}
              placeholder="Enterprise"
              maxLength={40}
              class="w-full bg-bg-elevated border border-border rounded-lg px-3 py-2 text-body-sm outline-none focus:ring-2 focus:ring-primary/50"
            />
            <p class="text-caption text-muted mt-1">Small line under the company name in the sidebar. Blank shows “Enterprise”.</p>
          </div>
          <div>
            <label class="block text-caption text-secondary font-medium mb-1">Logo</label>
            <div class="flex items-center gap-2">
              <input
                value={tLogo}
                onInput={(e) => setTLogo((e.target as HTMLInputElement).value)}
                placeholder="https://example.com/logo.svg or upload →"
                class="flex-1 min-w-0 bg-bg-elevated border border-border rounded-lg px-3 py-2 text-body-sm outline-none focus:ring-2 focus:ring-primary/50"
              />
              <label
                class={`shrink-0 cursor-pointer px-3 py-2 rounded-lg text-body-sm font-medium bg-bg-elevated border border-border text-secondary hover:bg-surface-hover transition-colors ${uploadingLogo ? 'opacity-60 pointer-events-none' : ''}`}
              >
                {uploadingLogo ? 'Uploading…' : 'Upload'}
                <input
                  type="file"
                  accept=".png,.jpg,.jpeg,.gif,.webp,.svg,.ico"
                  class="hidden"
                  disabled={uploadingLogo}
                  onChange={(e) => {
                    const f = (e.target as HTMLInputElement).files?.[0];
                    (e.target as HTMLInputElement).value = '';
                    if (f) void uploadBrandingAsset(f, setTLogo, setUploadingLogo);
                  }}
                />
              </label>
            </div>
            {tLogo && (
              <div class="mt-2 flex items-center gap-2">
                <img
                  src={tLogo}
                  alt=""
                  class="h-8 w-auto max-w-[120px] object-contain rounded bg-bg-elevated border border-border p-1"
                />
                <button
                  type="button"
                  onClick={() => setTLogo('')}
                  class="text-caption text-muted hover:text-danger transition-colors"
                >
                  Remove
                </button>
              </div>
            )}
            <p class="text-caption text-muted mt-1">Paste an image URL or upload a file (PNG, JPG, GIF, WebP, SVG, ICO; max 2MB).</p>
          </div>
          <div>
            <label class="block text-caption text-secondary font-medium mb-1">Icon / favicon</label>
            <div class="flex items-center gap-2">
              <input
                value={tIcon}
                onInput={(e) => setTIcon((e.target as HTMLInputElement).value)}
                placeholder="https://example.com/favicon.png or upload →"
                class="flex-1 min-w-0 bg-bg-elevated border border-border rounded-lg px-3 py-2 text-body-sm outline-none focus:ring-2 focus:ring-primary/50"
              />
              <label
                class={`shrink-0 cursor-pointer px-3 py-2 rounded-lg text-body-sm font-medium bg-bg-elevated border border-border text-secondary hover:bg-surface-hover transition-colors ${uploadingIcon ? 'opacity-60 pointer-events-none' : ''}`}
              >
                {uploadingIcon ? 'Uploading…' : 'Upload'}
                <input
                  type="file"
                  accept=".png,.jpg,.jpeg,.gif,.webp,.svg,.ico"
                  class="hidden"
                  disabled={uploadingIcon}
                  onChange={(e) => {
                    const f = (e.target as HTMLInputElement).files?.[0];
                    (e.target as HTMLInputElement).value = '';
                    if (f) void uploadBrandingAsset(f, setTIcon, setUploadingIcon);
                  }}
                />
              </label>
            </div>
            <p class="text-caption text-muted mt-1">Falls back to the logo, then the default, when blank.</p>
          </div>
          <div class="grid grid-cols-2 gap-4">
            <div>
              <label class="block text-caption text-secondary font-medium mb-1">Primary color</label>
              <div class="flex items-center gap-2">
                <input
                  type="color"
                  value={/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(tPrimary) ? tPrimary : DEFAULT_PRIMARY}
                  onInput={(e) => setTPrimary((e.target as HTMLInputElement).value)}
                  aria-label="Primary color"
                  class="h-9 w-10 rounded-lg border border-border bg-bg-elevated cursor-pointer p-0.5"
                />
                <input
                  value={tPrimary}
                  onInput={(e) => setTPrimary((e.target as HTMLInputElement).value)}
                  placeholder={DEFAULT_PRIMARY}
                  class="flex-1 min-w-0 bg-bg-elevated border border-border rounded-lg px-3 py-2 text-body-sm font-mono outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>
            </div>
            <div>
              <label class="block text-caption text-secondary font-medium mb-1">Accent color</label>
              <div class="flex items-center gap-2">
                <input
                  type="color"
                  value={/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(tAccent) ? tAccent : DEFAULT_ACCENT}
                  onInput={(e) => setTAccent((e.target as HTMLInputElement).value)}
                  aria-label="Accent color"
                  class="h-9 w-10 rounded-lg border border-border bg-bg-elevated cursor-pointer p-0.5"
                />
                <input
                  value={tAccent}
                  onInput={(e) => setTAccent((e.target as HTMLInputElement).value)}
                  placeholder={DEFAULT_ACCENT}
                  class="flex-1 min-w-0 bg-bg-elevated border border-border rounded-lg px-3 py-2 text-body-sm font-mono outline-none focus:ring-2 focus:ring-primary/50"
                />
              </div>
            </div>
          </div>
          <div class="flex gap-3 justify-end pt-1">
            <Button variant="secondary" onClick={() => setThemeModalOpen(false)}>Cancel</Button>
            <Button loading={savingTheme} onClick={saveTheme}>
              {editingThemeId ? 'Save changes' : 'Create theme'}
            </Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={deleteThemeId !== null}
        onClose={() => setDeleteThemeId(null)}
        title="Delete theme"
        size="sm"
        danger
      >
        <div class="space-y-4">
          <p class="text-body-sm text-secondary">
            Delete{' '}
            <span class="font-medium text-primary">
              {themes.find((t) => t.id === deleteThemeId)?.name ?? 'this theme'}
            </span>
            ? This cannot be undone. If it is the active theme, the dashboard reverts to the default.
          </p>
          <div class="flex gap-3 justify-end">
            <Button variant="secondary" onClick={() => setDeleteThemeId(null)}>Cancel</Button>
            <Button variant="danger" loading={deletingTheme} onClick={confirmDeleteTheme}>Delete</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

/**
 * The on-demand guided tour launcher. Self-contained (own state) so the main
 * Settings component stays unchanged. Offers the full tab-by-tab walkthrough,
 * resuming an interrupted one, touring a single page, and re-showing the
 * first-run welcome screens.
 */
function GuidedTourCard() {
  const [pick, setPick] = useState('');
  const resume = savedTourProgress();
  const tabs = visibleTourTabs();
  return (
    <div data-tour="settings-tour" class="bg-surface border border-border rounded-xl p-6">
      <h2 class="text-heading-sm font-semibold mb-1">Guided tour</h2>
      <p class="text-body-sm text-muted mb-4">
        A step-by-step walkthrough of every page, in plain language. Take the full tour,
        or get a refresher on a single page. You can leave at any point and resume later.
      </p>
      <div class="flex flex-wrap items-center gap-3">
        <Button variant="primary" size="sm" onClick={() => startTour()}>
          Start the full tour
        </Button>
        {resume && (
          <Button variant="secondary" size="sm" onClick={() => startTour({ resume: true })}>
            Resume from {resume.label}
          </Button>
        )}
        <div class="flex items-center gap-2">
          <Select
            size="sm"
            value={pick}
            placeholder="Tour a single page…"
            options={tabs.map((t) => ({ value: t.route, label: t.label }))}
            onChange={(route) => {
              setPick(route);
              startTour({ route, single: true });
              // Reset so re-picking the same page later still fires onChange.
              setTimeout(() => setPick(''), 300);
            }}
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { localStorage.removeItem('cce_onboarded'); window.location.reload(); }}
        >
          Show the welcome screens again
        </Button>
      </div>
    </div>
  );
}
