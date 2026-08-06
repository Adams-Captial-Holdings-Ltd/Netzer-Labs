import { useState, useEffect } from 'preact/hooks';
import { Link } from 'wouter-preact';
import { ExternalLink, Store, Plug, Trash2 } from 'lucide-preact';
import {
  api,
  type IntegrationEntry,
  type SecretPosture,
  type SurfaceHealth,
  type McpServerEntry,
  type McpProbeResult,
} from '../lib/api';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Skeleton } from '../components/Skeleton';
import {
  GATEWAY_TOOLS,
  QUICK_SUITE_SAMPLE_LOGOS,
  QUICK_SUITE_EXTRA_COUNT,
  QUICK_SUITE_URL,
  MARKETPLACE_MCP_URL,
  type CatalogTool,
} from '../lib/integrationCatalog';

// AWS Secrets Manager console. A secret with no rotation schedule deep-links
// here so an operator can configure rotation. Metadata-only (no value is read
// or shown), so the deep link is just the console list filtered by name.
const SECRETS_CONSOLE_BASE = 'https://console.aws.amazon.com/secretsmanager/';

// Surface-health pill colors. SurfaceHealth status enum is ok|warn|unknown.
const HEALTH_DOT: Record<SurfaceHealth['status'], string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  unknown: 'bg-gray-300 dark:bg-gray-600',
};

const HEALTH_BADGE: Record<SurfaceHealth['status'], { variant: 'success' | 'warning' | 'muted'; label: string }> = {
  ok: { variant: 'success', label: 'Healthy' },
  warn: { variant: 'warning', label: 'Warning' },
  unknown: { variant: 'muted', label: 'Unknown' },
};

// Secrets-posture status enum is ok|warn|crit|unknown.
const POSTURE_DOT: Record<SecretPosture['status'], string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  crit: 'bg-danger',
  unknown: 'bg-gray-300 dark:bg-gray-600',
};

const POSTURE_BADGE: Record<SecretPosture['status'], { variant: 'success' | 'warning' | 'danger' | 'muted'; label: string }> = {
  ok: { variant: 'success', label: 'OK' },
  warn: { variant: 'warning', label: 'Warn' },
  crit: { variant: 'danger', label: 'Critical' },
  unknown: { variant: 'muted', label: 'Unknown' },
};

// ── OAuth Connect cards (Slack MCP bridge + Salesforce) ─────────────────────
// One-click connections: the backend mints a state row + authorize URL, the
// browser top-level-redirects to the provider, and /api/oauth/callback lands
// the token. Reads here are fully redacted (booleans only).

interface OAuthStatus {
  redirectUri: string | null;
  providers: {
    slack: { mcpConnected: boolean; mcpClientConfigured: boolean; appsConfigured: string[] };
    salesforce: { connected: boolean; instanceUrl: string | null; clientConfigured: boolean };
  };
}

function OAuthConnectionsSection() {
  const [status, setStatus] = useState<OAuthStatus | null>(null);
  const [busy, setBusy] = useState('');
  const [credsFor, setCredsFor] = useState(''); // 'slack' | 'salesforce'
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [loginUrl, setLoginUrl] = useState('');
  const [notice, setNotice] = useState('');

  function loadStatus() {
    api.get<OAuthStatus>('/oauth/status').then(setStatus).catch(() => {});
  }

  useEffect(() => {
    loadStatus();
    // Returning from a provider redirect: surface the outcome once.
    const params = new URLSearchParams(window.location.search);
    const oauth = params.get('oauth');
    if (oauth) {
      const ok = params.get('status') === 'ok';
      setNotice(ok ? `${oauth} connected.` : `${oauth} connect failed (${params.get('reason') ?? 'unknown'}). Try again.`);
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  async function connect(provider: string, mode: string) {
    setBusy(`${provider}:${mode}`);
    try {
      const r = await api.post<{ authorizeUrl?: string; error?: string; missing?: string[] }>(
        `/oauth/${provider}/start`,
        { mode },
      );
      if (r.authorizeUrl) {
        window.location.assign(r.authorizeUrl);
        return;
      }
      setNotice('Connect failed.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Connect failed';
      if (msg.includes('credentials_needed') || msg.includes('409')) {
        setCredsFor(provider);
        setNotice('Enter the app credentials first (one time).');
      } else {
        setNotice(msg);
      }
    }
    setBusy('');
  }

  async function saveCreds(provider: string) {
    setBusy(`${provider}:creds`);
    try {
      await api.put(`/oauth/${provider}/credentials`, {
        clientId,
        clientSecret,
        ...(provider === 'salesforce' && loginUrl ? { loginUrl } : {}),
      });
      setCredsFor('');
      setClientId('');
      setClientSecret('');
      setNotice('Credentials saved. Click Connect to finish.');
      loadStatus();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Save failed');
    }
    setBusy('');
  }

  const slack = status?.providers.slack;
  const sf = status?.providers.salesforce;

  return (
    <section class="mb-8">
      <div class="flex items-center gap-2 mb-1">
        <h2 class="text-heading-sm font-semibold text-secondary uppercase tracking-wider">Connections</h2>
        <Badge variant="info">One-click OAuth</Badge>
      </div>
      <p class="text-body-sm text-secondary mb-3">
        Connect provider accounts so agents can use them from any chat surface. Tokens are stored encrypted and never displayed.
      </p>
      {notice && (
        <div class="text-body-sm text-secondary bg-bg-sunken border border-border rounded-lg px-3 py-2 mb-3">{notice}</div>
      )}
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div class="bg-surface border border-border rounded-xl p-4">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-body-sm font-semibold text-primary">Slack (agent tools)</p>
              <p class="text-caption text-muted mt-0.5">Search and post in your workspace via the vendor Slack MCP server.</p>
            </div>
            {slack?.mcpConnected ? (
              <Badge variant="success">Connected</Badge>
            ) : (
              <Button size="sm" loading={busy === 'slack:mcp'} onClick={() => connect('slack', 'mcp')}>
                Connect
              </Button>
            )}
          </div>
          {!slack?.mcpClientConfigured && (
            <button class="text-caption text-primary hover:underline mt-2" onClick={() => setCredsFor('slack')}>
              Enter Slack app credentials (one time)
            </button>
          )}
        </div>
        <div class="bg-surface border border-border rounded-xl p-4">
          <div class="flex items-center justify-between">
            <div>
              <p class="text-body-sm font-semibold text-primary">Salesforce</p>
              <p class="text-caption text-muted mt-0.5">
                {sf?.connected
                  ? `SOQL + records via ${sf.instanceUrl ?? 'your org'}`
                  : 'Query and update records from chat (salesforce_query, salesforce_record).'}
              </p>
            </div>
            {sf?.connected ? (
              <Badge variant="success">Connected</Badge>
            ) : (
              <Button size="sm" loading={busy === 'salesforce:api'} onClick={() => connect('salesforce', 'api')}>
                Connect
              </Button>
            )}
          </div>
          {!sf?.clientConfigured && (
            <button class="text-caption text-primary hover:underline mt-2" onClick={() => setCredsFor('salesforce')}>
              Enter Connected App credentials (one time)
            </button>
          )}
        </div>
      </div>
      {credsFor && (
        <div class="mt-3 bg-surface border border-border rounded-xl p-4 space-y-2">
          <p class="text-body-sm font-medium text-primary">
            {credsFor === 'slack' ? 'Slack app credentials' : 'Salesforce Connected App credentials'}
          </p>
          <p class="text-caption text-muted">
            {status?.redirectUri
              ? `Add this redirect URL to the app first: ${status.redirectUri}`
              : 'Set CCE_DASHBOARD_URL on the backend to enable connect flows.'}
          </p>
          <input
            value={clientId}
            onInput={(e) => setClientId((e.target as HTMLInputElement).value)}
            placeholder={credsFor === 'slack' ? 'Client ID' : 'Consumer Key'}
            class="w-full bg-bg-sunken border border-border rounded-lg px-3 py-2 text-body-sm font-mono"
          />
          <input
            value={clientSecret}
            onInput={(e) => setClientSecret((e.target as HTMLInputElement).value)}
            placeholder={credsFor === 'slack' ? 'Client Secret' : 'Consumer Secret'}
            type="password"
            class="w-full bg-bg-sunken border border-border rounded-lg px-3 py-2 text-body-sm font-mono"
          />
          {credsFor === 'salesforce' && (
            <input
              value={loginUrl}
              onInput={(e) => setLoginUrl((e.target as HTMLInputElement).value)}
              placeholder="Login URL (optional, default login.salesforce.com)"
              class="w-full bg-bg-sunken border border-border rounded-lg px-3 py-2 text-body-sm font-mono"
            />
          )}
          <div class="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setCredsFor('')}>Cancel</Button>
            <Button
              size="sm"
              loading={busy === `${credsFor}:creds`}
              disabled={!clientId || !clientSecret}
              onClick={() => saveCreds(credsFor)}
            >
              Save credentials
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

// Brand marks sit on a light chip so dark logos (Notion, Zendesk, Confluence)
// stay visible in dark mode.
function ToolTile({ tool }: { tool: CatalogTool }) {
  return (
    <a
      href={tool.href}
      target="_blank"
      rel="noopener noreferrer"
      class="group bg-surface border border-border rounded-xl p-4 flex flex-col gap-3 hover:border-border-strong hover:bg-surface-hover transition-colors"
    >
      <div class="flex items-start justify-between">
        <span class="h-10 w-10 shrink-0 rounded-lg bg-white ring-1 ring-black/10 flex items-center justify-center">
          {tool.logo ? (
            <img src={tool.logo} alt={`${tool.name} logo`} class="h-6 w-6 object-contain" loading="lazy" />
          ) : (
            <span class="text-body-sm font-bold text-gray-700" aria-hidden="true">{tool.name[0]}</span>
          )}
        </span>
        <ExternalLink class="h-3.5 w-3.5 text-muted opacity-0 group-hover:opacity-100 transition-opacity" aria-hidden="true" />
      </div>
      <div class="min-w-0">
        <div class="text-body-sm font-medium text-primary">{tool.name}</div>
        <p class="text-caption text-muted mt-0.5">{tool.description}</p>
      </div>
    </a>
  );
}

const AUTH_LABEL: Record<McpServerEntry['auth'], string> = {
  iam: 'AWS IAM',
  bearer: 'Bearer token',
  none: 'No auth',
};

const INPUT_CLASS =
  'w-full bg-bg-elevated border border-border rounded-lg px-3 py-2 text-body-sm outline-none focus:ring-2 focus:ring-primary/50';

const EMPTY_DRAFT = { id: '', name: '', url: '', auth: 'iam' as McpServerEntry['auth'], bearerToken: '', agents: '' };

// Live MCP servers wired into agent turns. List/probe are operator reads;
// save is admin (the backend enforces; a 403 here surfaces as the save error).
function McpServersSection() {
  const [servers, setServers] = useState<McpServerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<string, McpProbeResult | 'loading'>>({});
  const [showForm, setShowForm] = useState(false);
  const [draft, setDraft] = useState(EMPTY_DRAFT);

  useEffect(() => {
    const ac = new AbortController();
    api.integrations.mcpList(ac.signal)
      .then((d) => setServers(d?.servers ?? []))
      .catch((err) => {
        if (!ac.signal.aborted) setError(err instanceof Error ? err.message : 'Failed to load MCP servers');
      })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });
    return () => ac.abort();
  }, []);

  const save = async (next: McpServerEntry[]) => {
    setSaving(true);
    setError(null);
    try {
      const d = await api.integrations.mcpSave(next);
      setServers(d?.servers ?? next);
      setShowForm(false);
      setDraft(EMPTY_DRAFT);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const addDraft = () => {
    const agents = draft.agents.split(',').map((a) => a.trim()).filter(Boolean);
    const entry: McpServerEntry = {
      id: draft.id.trim().toLowerCase(),
      name: draft.name.trim() || draft.id.trim(),
      url: draft.url.trim(),
      auth: draft.auth,
      ...(draft.auth === 'bearer' && draft.bearerToken ? { bearerToken: draft.bearerToken } : {}),
      enabled: true,
      agents,
    };
    void save([...servers.filter((s) => s.id !== entry.id), entry]);
  };

  const probe = async (id: string) => {
    setProbes((p) => ({ ...p, [id]: 'loading' }));
    try {
      const result = await api.integrations.mcpProbe(id);
      setProbes((p) => ({ ...p, [id]: result }));
    } catch (err) {
      setProbes((p) => ({
        ...p,
        [id]: { ok: false, tools: [], error: err instanceof Error ? err.message : 'probe failed' },
      }));
    }
  };

  return (
    <section data-tour="integrations-mcp" class="mb-8">
      <div class="flex items-center justify-between mb-1">
        <div class="flex items-center gap-2">
          <h2 class="text-heading-sm font-semibold text-secondary uppercase tracking-wider">Agent tool servers</h2>
          <Badge variant="info">MCP</Badge>
        </div>
        <Button size="sm" variant="secondary" onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Cancel' : 'Add server'}
        </Button>
      </div>
      <p class="text-caption text-muted mb-4">
        Tools on these servers are offered to agents live, on every turn, from any surface (Telegram,
        Slack, dashboard chat). AgentCore gateways authenticate with the task's IAM role; no stored secrets.
      </p>

      {error && <p class="text-caption text-danger mb-3">{error}</p>}

      {showForm && (
        <div class="bg-surface border border-border rounded-xl p-4 mb-4 grid gap-3 sm:grid-cols-2">
          <input class={INPUT_CLASS} placeholder="id (e.g. aws-gateway)" value={draft.id}
            onInput={(e) => setDraft({ ...draft, id: (e.target as HTMLInputElement).value })} />
          <input class={INPUT_CLASS} placeholder="Display name" value={draft.name}
            onInput={(e) => setDraft({ ...draft, name: (e.target as HTMLInputElement).value })} />
          <input class={`${INPUT_CLASS} sm:col-span-2 font-mono`} placeholder="https://...gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp" value={draft.url}
            onInput={(e) => setDraft({ ...draft, url: (e.target as HTMLInputElement).value })} />
          <select class={INPUT_CLASS} value={draft.auth}
            onChange={(e) => setDraft({ ...draft, auth: (e.target as HTMLSelectElement).value as McpServerEntry['auth'] })}>
            <option value="iam">AWS IAM (AgentCore Gateway)</option>
            <option value="bearer">Bearer token</option>
            <option value="none">No auth</option>
          </select>
          <input class={INPUT_CLASS} placeholder="Agent ids, comma-separated (empty = all agents)" value={draft.agents}
            onInput={(e) => setDraft({ ...draft, agents: (e.target as HTMLInputElement).value })} />
          {draft.auth === 'bearer' && (
            <input class={`${INPUT_CLASS} sm:col-span-2`} type="password" placeholder="Bearer token (stored server-side, never shown again)" value={draft.bearerToken}
              onInput={(e) => setDraft({ ...draft, bearerToken: (e.target as HTMLInputElement).value })} />
          )}
          <div class="sm:col-span-2">
            <Button size="sm" loading={saving} disabled={!draft.id.trim() || !draft.url.trim()} onClick={addDraft}>
              Save server
            </Button>
          </div>
        </div>
      )}

      {loading ? (
        <Skeleton height="72px" width="100%" />
      ) : servers.length === 0 ? (
        <div class="bg-surface border border-dashed border-border rounded-xl p-5 text-body-sm text-muted">
          No MCP servers connected yet. Add your AgentCore gateway URL and its tools become live for agents
          within seconds, no redeploy.
        </div>
      ) : (
        <div class="space-y-3">
          {servers.map((s) => {
            const probeState = probes[s.id];
            return (
              <div key={s.id} class="bg-surface border border-border rounded-xl p-4">
                <div class="flex items-start gap-3 flex-wrap">
                  <span class="h-10 w-10 shrink-0 rounded-lg bg-primary/10 flex items-center justify-center">
                    <Plug class="h-5 w-5 text-primary" aria-hidden="true" />
                  </span>
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2 flex-wrap">
                      <span class="text-body-sm font-medium text-primary">{s.name}</span>
                      <Badge variant={s.enabled ? 'success' : 'muted'}>{s.enabled ? 'Enabled' : 'Disabled'}</Badge>
                      <Badge variant="info">{AUTH_LABEL[s.auth]}</Badge>
                      <Badge variant="default">
                        {s.agents.length === 0 ? 'all agents' : s.agents.join(', ')}
                      </Badge>
                    </div>
                    <p class="text-caption text-muted font-mono mt-1 truncate">{s.url}</p>
                  </div>
                  <div class="flex items-center gap-2 shrink-0">
                    <Button size="sm" variant="secondary" loading={probeState === 'loading'} onClick={() => void probe(s.id)}>
                      Test tools
                    </Button>
                    <Button size="sm" variant="secondary"
                      onClick={() => void save(servers.map((x) => x.id === s.id ? { ...x, enabled: !x.enabled } : x))}>
                      {s.enabled ? 'Disable' : 'Enable'}
                    </Button>
                    <Button size="sm" variant="ghost" icon={<Trash2 class="h-3.5 w-3.5" />}
                      onClick={() => void save(servers.filter((x) => x.id !== s.id))}>
                      Remove
                    </Button>
                  </div>
                </div>
                {probeState && probeState !== 'loading' && (
                  <div class="mt-3 pl-12">
                    {probeState.ok ? (
                      <div class="flex items-center gap-2 flex-wrap">
                        <Badge variant="success">{probeState.tools.length} tool{probeState.tools.length === 1 ? '' : 's'} live</Badge>
                        {probeState.tools.map((t) => (
                          <span key={t.name} class="text-caption text-secondary font-mono" title={t.description ?? ''}>
                            {t.name}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p class="text-caption text-danger">{probeState.error}</p>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function HealthPill({ health }: { health?: SurfaceHealth }) {
  const status = health?.status ?? 'unknown';
  const badge = HEALTH_BADGE[status] ?? HEALTH_BADGE.unknown;
  return (
    <span class="inline-flex items-center gap-1.5" title={health?.detail ?? ''}>
      <span class={`h-2 w-2 rounded-full ${HEALTH_DOT[status] ?? HEALTH_DOT.unknown}`} aria-hidden="true" />
      <Badge variant={badge.variant}>{badge.label}</Badge>
    </span>
  );
}

export function Integrations() {
  const [entries, setEntries] = useState<IntegrationEntry[]>([]);
  const [secrets, setSecrets] = useState<SecretPosture[]>([]);
  const [loading, setLoading] = useState(true);
  const [secretsLoading, setSecretsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    api.integrations.list(ac.signal)
      .then((d) => setEntries(d?.entries ?? []))
      .catch((err) => {
        if (ac.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Failed to load integrations');
      })
      .finally(() => { if (!ac.signal.aborted) setLoading(false); });

    api.integrations.secretsPosture(ac.signal)
      .then((d) => setSecrets(d?.secrets ?? []))
      .catch(() => { /* secrets posture fails soft on the backend */ })
      .finally(() => { if (!ac.signal.aborted) setSecretsLoading(false); });

    return () => ac.abort();
  }, []);

  const riskyCount = entries.filter((i) => i?.softBypassRisk).length;

  return (
    <div>
      <div class="mb-6">
        <h1 data-tour="integrations-title" class="text-display-sm text-primary font-bold">Integrations</h1>
        <p class="text-body-sm text-secondary mt-1">
          Connect tools to your agents, and monitor inbound surfaces, webhook verification posture, and live surface health.
          {!loading && riskyCount > 0 && ` ${riskyCount} surface${riskyCount > 1 ? 's' : ''} would accept unverified inbound (soft bypass).`}
        </p>
      </div>

      <OAuthConnectionsSection />

      <section data-tour="integrations-catalog" class="mb-8">
        <div class="flex items-center gap-2 mb-1">
          <h2 class="text-heading-sm font-semibold text-secondary uppercase tracking-wider">Tool catalog</h2>
          <Badge variant="info">Amazon Bedrock AgentCore Gateway</Badge>
        </div>
        <p class="text-caption text-muted mb-4">
          Every tile opens the AgentCore gateway wizard in the AWS console (new tab, AWS sign-in required).
          Pick the provider in step 3 "Add targets", attach its OAuth client, and the tool becomes callable by agents.
          Connections and OAuth tokens live in AWS, never in this product.
        </p>

        <div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3 mb-5">
          {GATEWAY_TOOLS.map((tool) => <ToolTile key={tool.id} tool={tool} />)}
          <a
            href={MARKETPLACE_MCP_URL}
            target="_blank"
            rel="noopener noreferrer"
            class="group bg-surface border border-dashed border-border rounded-xl p-4 flex flex-col gap-3 hover:border-border-strong hover:bg-surface-hover transition-colors"
          >
            <div class="flex items-start justify-between">
              <span class="h-10 w-10 shrink-0 rounded-lg bg-primary/10 flex items-center justify-center">
                <Store class="h-5 w-5 text-primary" aria-hidden="true" />
              </span>
              <ExternalLink class="h-3.5 w-3.5 text-muted opacity-0 group-hover:opacity-100 transition-opacity" aria-hidden="true" />
            </div>
            <div class="min-w-0">
              <div class="text-body-sm font-medium text-primary">Browse more</div>
              <p class="text-caption text-muted mt-0.5">MCP servers on AWS Marketplace.</p>
            </div>
          </a>
        </div>

        <a
          href={QUICK_SUITE_URL}
          target="_blank"
          rel="noopener noreferrer"
          class="group bg-surface border border-border rounded-xl p-4 flex items-center gap-4 hover:border-border-strong hover:bg-surface-hover transition-colors"
        >
          <div class="flex -space-x-2 shrink-0">
            {QUICK_SUITE_SAMPLE_LOGOS.map(({ name, logo }) => (
              <span key={name} class="h-8 w-8 rounded-lg bg-white ring-1 ring-black/10 flex items-center justify-center">
                <img src={logo} alt={`${name} logo`} class="h-4 w-4 object-contain" loading="lazy" />
              </span>
            ))}
            <span class="h-8 w-8 rounded-lg bg-surface-elevated ring-1 ring-black/10 flex items-center justify-center text-caption text-muted font-medium">
              +{QUICK_SUITE_EXTRA_COUNT}
            </span>
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="text-body-sm font-medium text-primary">Amazon Quick Suite connectors</span>
              <Badge variant="muted">separate product</Badge>
            </div>
            <p class="text-caption text-muted mt-0.5">
              Notion, Linear, HubSpot, Zapier and more connect inside Amazon Quick Suite, AWS's workspace product
              with its own sign-up. They are not configurable from this dashboard.
            </p>
          </div>
          <ExternalLink class="h-3.5 w-3.5 shrink-0 text-muted opacity-0 group-hover:opacity-100 transition-opacity" aria-hidden="true" />
        </a>
      </section>

      <McpServersSection />

      <section data-tour="integrations-table" class="mb-8">
        <h2 class="text-heading-sm font-semibold text-secondary mb-4 uppercase tracking-wider">Agent integrations</h2>
        {loading ? (
          <div class="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} height="48px" width="100%" />
            ))}
          </div>
        ) : error ? (
          <div class="bg-surface border border-border rounded-xl p-5">
            <div class="flex items-center gap-2 mb-1">
              <span class="h-2.5 w-2.5 rounded-full bg-danger" aria-hidden="true" />
              <span class="text-body-sm text-primary font-medium">Could not load integrations</span>
            </div>
            <p class="text-caption text-muted">{error}</p>
          </div>
        ) : entries.length === 0 ? (
          <div class="bg-surface border border-border rounded-xl p-5 text-body-sm text-muted">
            No agent integrations reported.
          </div>
        ) : (
          <div class="bg-surface border border-border rounded-xl overflow-hidden">
            <div class="overflow-x-auto"><table class="w-full text-body-sm">
              <thead>
                <tr class="border-b border-border text-left text-caption text-muted uppercase tracking-wider">
                  <th class="px-4 py-2 font-medium">Agent</th>
                  <th class="px-4 py-2 font-medium">Surface</th>
                  <th class="px-4 py-2 font-medium">Verification</th>
                  <th class="px-4 py-2 font-medium">Health</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((row) => (
                  <tr key={`${row?.agentId}-${row?.surface}`} class="border-b border-border last:border-0">
                    <td class="px-4 py-2.5">
                      <div class="text-primary font-medium font-mono">{row?.agentId ?? 'unknown'}</div>
                    </td>
                    <td class="px-4 py-2.5">
                      <Badge variant="info">{row?.surface ?? 'unknown'}</Badge>
                    </td>
                    <td class="px-4 py-2.5">
                      <div class="flex items-center gap-2 flex-wrap">
                        <Badge variant={row?.verificationMode ? 'success' : 'warning'}>
                          {row?.verificationMode ? 'Verified' : 'Unverified'}
                        </Badge>
                        {row?.softBypassRisk && (
                          <Badge variant="danger">soft bypass risk</Badge>
                        )}
                        {row?.softBypassRisk && row?.agentId && (
                          <Link
                            href={`/agents/${row.agentId}#connections`}
                            class="text-caption text-primary hover:underline"
                          >
                            Go to Connections
                          </Link>
                        )}
                      </div>
                    </td>
                    <td class="px-4 py-2.5">
                      <HealthPill health={row?.health} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table></div>
          </div>
        )}
        {!loading && riskyCount > 0 && (
          <p class="text-caption text-warning mt-3">
            A soft bypass means inbound signature verification fails open. Treat those surfaces as
            unauthenticated until a signing secret is configured.
          </p>
        )}
      </section>

      <section data-tour="integrations-secrets">
        <h2 class="text-heading-sm font-semibold text-secondary mb-4 uppercase tracking-wider">Secrets posture</h2>
        <p class="text-caption text-muted mb-4">
          Metadata only: secret name, last-rotated date, and rotation schedule. Secret values are never read or shown.
        </p>
        {secretsLoading ? (
          <div class="space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} height="64px" width="100%" />
            ))}
          </div>
        ) : secrets.length === 0 ? (
          <div class="bg-surface border border-border rounded-xl p-5 text-body-sm text-muted">
            No secrets posture reported. The describe calls may be unavailable from this task.
          </div>
        ) : (
          <div class="space-y-3">
            {secrets.map((secret) => {
              const badge = POSTURE_BADGE[secret?.status] ?? POSTURE_BADGE.unknown;
              return (
                <div key={secret?.id} class="bg-surface border border-border rounded-xl p-4 flex items-start gap-3">
                  <span class={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${POSTURE_DOT[secret?.status] ?? POSTURE_DOT.unknown}`} aria-hidden="true" />
                  <div class="min-w-0 flex-1">
                    <div class="flex items-center gap-2 flex-wrap">
                      <span class="text-body-sm text-primary font-medium">{secret?.name ?? 'unknown'}</span>
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                      <Badge variant={secret?.hasRotationSchedule ? 'success' : 'muted'}>
                        {secret?.hasRotationSchedule ? 'Auto-rotate on' : 'No rotation schedule'}
                      </Badge>
                      {!secret?.hasRotationSchedule && (
                        <a
                          href={`${SECRETS_CONSOLE_BASE}home#!/listSecrets?search=${encodeURIComponent(secret?.name ?? '')}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          class="text-caption text-primary hover:underline"
                        >
                          View in AWS
                        </a>
                      )}
                      <span class="text-caption text-muted">
                        Last rotated: {secret?.lastRotated ?? 'unknown'}
                      </span>
                    </div>
                    <p class="text-caption text-muted mt-1">{secret?.detail}</p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
