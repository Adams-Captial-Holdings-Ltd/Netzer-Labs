import { useState, useEffect } from 'preact/hooks';
import { Fragment, type ComponentChildren } from 'preact';
import { useRoute, Link } from 'wouter-preact';
import { api } from '../lib/api';
import { Button } from '../components/Button';
import { Toggle } from '../components/Toggle';
import { Select } from '../components/Select';
import { Badge } from '../components/Badge';
import { StatusDot } from '../components/StatusDot';
import { Skeleton } from '../components/Skeleton';
import { EmptyState } from '../components/EmptyState';
import { EmptySessions, EmptyUsage, EmptyBrain } from '../components/Icons';
import { ConfirmDialog } from '../components/Modal';
import { toast } from '../components/Toast';
import { formatModelName } from '../lib/format';

interface AgentInfo {
  agentId: string;
  displayName: string;
  description: string;
  model: string;
  status: string;
  // Named vector corpus this agent searches by default (plus the always-shared
  // "shared" scope). Returned by /agents/:id/detail via redactAgent; unset on
  // built-in agents, where it falls back to "default".
  knowledgeScope?: string;
  telegramConnected: boolean;
  telegramBotUsername?: string;
  slackConnected: boolean;
  slackAppId?: string;
  slackBotUsername?: string;
  createdAt: string;
}

type TabKey = 'overview' | 'prompt' | 'sessions' | 'usage' | 'memories' | 'connections' | 'settings';

const TAB_KEYS: TabKey[] = ['overview', 'prompt', 'sessions', 'usage', 'memories', 'connections', 'settings'];

// Initial tab can be deep-linked via the URL hash (e.g. /agents/x#connections),
// so the post-create "Connect a channel" button lands a new user straight on
// the connection steps, and a refresh keeps the tab.
function tabFromHash(): TabKey {
  const h = (typeof window !== 'undefined' ? window.location.hash : '').replace(/^#/, '');
  return (TAB_KEYS as string[]).includes(h) ? (h as TabKey) : 'overview';
}

export function AgentDetail() {
  const [, params] = useRoute('/agents/:id');
  const agentId = params?.id ?? '';
  const [agent, setAgent] = useState<AgentInfo | null>(null);
  const [tab, setTabState] = useState<TabKey>(tabFromHash());
  // Keep the URL hash in sync so the active tab is deep-linkable and survives a
  // refresh. replaceState (not push) avoids polluting back-button history.
  const setTab = (t: TabKey) => {
    setTabState(t);
    if (window.location.hash.replace(/^#/, '') !== t) history.replaceState(null, '', `#${t}`);
  };
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  async function refresh() {
    try {
      const data = await api.get<{ agent: AgentInfo }>(`/agents/${agentId}/detail`);
      setAgent(data.agent);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load agent');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(); }, [agentId]);
  // Follow URL hash changes (deep links pasted into the bar, back/forward) to
  // the matching tab. setTab uses replaceState, which does not fire hashchange,
  // so a normal tab click never re-triggers this.
  useEffect(() => {
    const onHash = () => setTabState(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (loading) {
    return (
      <div>
        <Skeleton height="20px" width="100px" class="mb-4" />
        <Skeleton height="32px" width="200px" class="mb-6" />
        <div class="flex gap-2 mb-6">
          {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} height="36px" width="80px" />)}
        </div>
        <Skeleton height="200px" />
      </div>
    );
  }

  if (error) {
    return (
      <div>
        <Link href="/agents" class="text-caption text-primary hover:underline mb-4 inline-block">&larr; Back to agents</Link>
        <div class="bg-danger/10 text-danger px-4 py-3 rounded-lg text-body-sm border border-danger/20">{error}</div>
      </div>
    );
  }

  if (!agent) return null;

  const tabs: { key: TabKey; label: string; badge?: string }[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'prompt', label: 'System Prompt' },
    { key: 'sessions', label: 'Sessions' },
    { key: 'usage', label: 'Usage' },
    { key: 'memories', label: 'Memories' },
    { key: 'connections', label: 'Connections', badge: (agent.telegramConnected || agent.slackConnected) ? '✓' : '' },
    { key: 'settings', label: 'Settings' },
  ];

  return (
    <div>
      <Link href="/agents" class="text-caption text-primary hover:underline mb-4 inline-block">&larr; Back to agents</Link>
      <div class="flex items-center gap-3 mb-6" data-tour="agent-detail-title">
        <h1 class="text-display-sm font-bold text-primary">{agent.displayName}</h1>
        <StatusDot status={agent.status === 'active' ? 'active' : 'inactive'} label={agent.status} />
      </div>

      <div class="flex gap-1 mb-6 border-b border-border overflow-x-auto" role="tablist" data-tour="agent-detail-tabs">
        {tabs.map((t) => (
          <Fragment key={t.key}>
            {t.key === 'sessions' && (
              <Link
                href={`/chat/${encodeURIComponent(agentId)}`}
                class="px-4 py-2.5 text-body-sm font-medium border-b-2 transition-colors whitespace-nowrap border-transparent text-secondary hover:text-primary"
                role="tab"
                aria-selected={false}
              >
                Chat
              </Link>
            )}
            <button
              onClick={() => setTab(t.key)}
              class={`px-4 py-2.5 text-body-sm font-medium border-b-2 transition-colors whitespace-nowrap
                ${tab === t.key ? 'border-primary text-primary' : 'border-transparent text-secondary hover:text-primary'}`}
              role="tab"
              aria-selected={tab === t.key}
            >
              {t.label} {t.badge && <span class="ml-1 text-success">{t.badge}</span>}
            </button>
          </Fragment>
        ))}
      </div>

      <div class="page-enter" role="tabpanel" data-tour="agent-detail-panel">
        {tab === 'overview' && <OverviewTab agent={agent} onRefresh={refresh} onGoToConnections={() => setTab('connections')} />}
        {tab === 'prompt' && <SystemPromptTab agentId={agentId} />}
        {tab === 'sessions' && <SessionsTab agentId={agentId} />}
        {tab === 'usage' && <UsageTab agentId={agentId} />}
        {tab === 'memories' && <MemoriesTab agentId={agentId} />}
        {tab === 'connections' && <ConnectionsTab agent={agent} onRefresh={refresh} />}
        {tab === 'settings' && <SettingsTab agent={agent} onRefresh={refresh} />}
      </div>
    </div>
  );
}

function OverviewTab({ agent, onRefresh, onGoToConnections }: { agent: AgentInfo; onRefresh: () => void; onGoToConnections: () => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(agent.displayName);
  const [desc, setDesc] = useState(agent.description);
  const [model, setModel] = useState(agent.model);
  const notConnected = !agent.telegramConnected && !agent.slackConnected;
  const [modelOptions, setModelOptions] = useState<{ value: string; label: string }[]>([
    { value: 'us.anthropic.claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
    { value: 'us.anthropic.claude-opus-4-7', label: 'Claude Opus 4.7' },
    { value: 'us.anthropic.claude-haiku-4-5', label: 'Claude Haiku 4.5' },
  ]);
  // Use the same live model catalog the Chat tab + Playground use, so the
  // per-agent model picker offers every available model, not a stale hardcoded
  // three. Falls back to the defaults above if the catalog can't be read.
  useEffect(() => {
    api.get<{ models: { id: string; label: string }[] }>('/models')
      .then((r) => { if (r.models?.length) setModelOptions(r.models.map((m) => ({ value: m.id, label: m.label }))); })
      .catch(() => {});
  }, []);

  async function save() {
    try {
      await api.patch(`/agents/${agent.agentId}`, { displayName: name, description: desc, model });
      toast('Agent updated', 'success');
      setEditing(false);
      onRefresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
  }

  return (
    <div class="max-w-xl space-y-6">
      {notConnected && (
        <div class="bg-primary/5 border-2 border-primary/30 rounded-xl p-5" data-tour="agent-detail-connect-banner">
          <p class="text-body font-semibold text-primary mb-1">Connect this agent to start chatting</p>
          <p class="text-body-sm text-secondary mb-3">It is not on Telegram or Slack yet. Connecting takes about a minute, with step-by-step instructions.</p>
          <Button onClick={onGoToConnections}>Connect a channel →</Button>
        </div>
      )}
      <div class="bg-surface border border-border rounded-xl p-6">
      <div class="space-y-4">
        {[
          { label: 'Display Name', value: agent.displayName, editable: true, editValue: name, onEdit: setName, type: 'input' },
          { label: 'Description', value: agent.description || 'No description', editable: true, editValue: desc, onEdit: setDesc, type: 'textarea' },
          { label: 'Model', value: formatModelName(agent.model), editable: true, editValue: model || 'us.anthropic.claude-sonnet-4-6', onEdit: setModel, type: 'select' },
          { label: 'Created', value: agent.createdAt ? new Date(agent.createdAt).toLocaleString() : 'Built-in', editable: false },
        ].map((field) => (
          <div key={field.label}>
            <label class="block text-caption text-muted font-medium mb-1">{field.label}</label>
            {editing && field.editable ? (
              field.type === 'textarea' ? (
                <textarea value={field.editValue} onInput={(e) => field.onEdit!((e.target as HTMLTextAreaElement).value)} rows={2} class="w-full px-3 py-2 bg-bg-elevated border border-border rounded-lg text-body-sm resize-none outline-none focus:ring-2 focus:ring-primary/50" />
              ) : field.type === 'select' ? (
                <Select
                  value={field.editValue ?? ''}
                  onChange={(v) => field.onEdit!(v)}
                  options={modelOptions}
                  size="md"
                  class="w-full"
                />
              ) : (
                <input value={field.editValue} onInput={(e) => field.onEdit!((e.target as HTMLInputElement).value)} class="w-full px-3 py-2 bg-bg-elevated border border-border rounded-lg text-body-sm outline-none focus:ring-2 focus:ring-primary/50" />
              )
            ) : (
              <p class={`text-body-sm ${field.label === 'Model' ? 'font-mono' : ''} text-primary`}>{field.value}</p>
            )}
          </div>
        ))}
        <div class="pt-3 border-t border-border">
          {editing ? (
            <div class="flex gap-2">
              <Button onClick={save}>Save</Button>
              <Button variant="secondary" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
          ) : (
            <Button variant="ghost" onClick={() => setEditing(true)}>Edit</Button>
          )}
        </div>
      </div>
      </div>
    </div>
  );
}

function SystemPromptTab({ agentId }: { agentId: string }) {
  const [body, setBody] = useState('');
  const [original, setOriginal] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [revisions, setRevisions] = useState<{ revId: string; editedBy: string; createdAt: string; note?: string }[]>([]);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    Promise.all([
      api.get<{ body: string }>(`/agents/${agentId}/file?file=CLAUDE.md`, ac.signal),
      api.get<{ revisions: typeof revisions }>(`/agents/${agentId}/history?limit=10`, ac.signal),
    ]).then(([f, h]) => {
      setBody(f.body);
      setOriginal(f.body);
      setRevisions(h.revisions);
    }).catch(() => {}).finally(() => setLoading(false));
    return () => ac.abort();
  }, [agentId]);

  const dirty = body !== original;

  async function save() {
    setSaving(true);
    try {
      await api.put(`/agents/${agentId}/file`, { filename: 'CLAUDE.md', body });
      setOriginal(body);
      toast('Saved to S3', 'success');
      const h = await api.get<{ revisions: typeof revisions }>(`/agents/${agentId}/history?limit=10`);
      setRevisions(h.revisions);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Save failed', 'error');
    }
    setSaving(false);
  }

  if (loading) return <Skeleton height="400px" />;

  return (
    <div class="max-w-4xl">
      <div class="flex items-center justify-between mb-3">
        <div>
          <h3 class="text-heading-sm font-semibold text-primary">System Prompt</h3>
          <p class="text-caption text-muted mt-0.5">
            CLAUDE.md &middot; {body.length.toLocaleString()} chars
            {dirty && <span class="text-warning ml-1">(unsaved)</span>}
          </p>
        </div>
        <div class="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => setShowHistory(!showHistory)}>
            History ({revisions.length})
          </Button>
          <Button size="sm" onClick={save} loading={saving} disabled={!dirty}>
            Save & Deploy
          </Button>
        </div>
      </div>

      <div class="relative">
        <textarea
          value={body}
          onInput={(e) => setBody((e.target as HTMLTextAreaElement).value)}
          class="w-full min-h-[500px] px-4 py-3 bg-bg-elevated border border-border rounded-xl text-body-sm font-mono leading-relaxed focus:ring-2 focus:ring-primary/50 outline-none resize-y"
          spellcheck={false}
        />
        {dirty && (
          <button
            onClick={() => setBody(original)}
            class="absolute bottom-3 right-3 text-caption text-muted hover:text-secondary px-3 py-1 bg-surface border border-border rounded-lg shadow-sm"
          >
            Discard
          </button>
        )}
      </div>

      {showHistory && revisions.length > 0 && (
        <div class="mt-4 bg-bg-sunken border border-border rounded-xl p-4">
          <h4 class="text-body-sm font-medium text-primary mb-3">Edit History</h4>
          <div class="space-y-2">
            {revisions.map((r) => (
              <div key={r.revId} class="flex items-center justify-between text-caption text-muted py-1.5 border-b border-border last:border-0">
                <div>
                  <span class="font-mono text-muted">{r.revId.slice(0, 8)}</span>
                  <span class="mx-2">&middot;</span>
                  <span>{r.editedBy.replace('dashboard:', '')}</span>
                  {r.note && <span class="text-secondary ml-2">"{r.note}"</span>}
                </div>
                <span class="text-muted">{new Date(r.createdAt).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SessionsTab({ agentId }: { agentId: string }) {
  const [sessions, setSessions] = useState<{ chatId: string; updatedAt: number }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Filter server-side by agentId so a busy agent's sessions aren't lost behind
    // the cross-agent 50-row cap on the unfiltered /sessions read.
    api.get<{ sessions: { agentId: string; chatId: string; updatedAt: number }[] }>(`/sessions?agentId=${encodeURIComponent(agentId)}`)
      .then((d) => setSessions(d.sessions))
      .catch(() => {}).finally(() => setLoading(false));
  }, [agentId]);

  if (loading) return <div class="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} height="40px" />)}</div>;
  if (sessions.length === 0) return <EmptyState icon={<EmptySessions />} title="No sessions" description={`No conversations recorded for ${agentId}.`} />;

  return (
    <div class="bg-surface border border-border rounded-xl overflow-hidden">
      <table class="w-full text-left">
        <thead><tr class="border-b border-border bg-surface-elevated">
          <th class="px-4 py-3 text-overline text-muted uppercase font-semibold">Chat ID</th>
          <th class="px-4 py-3 text-overline text-muted uppercase font-semibold">Last Active</th>
        </tr></thead>
        <tbody class="divide-y divide-border">
          {sessions.map((s) => (
            <tr key={s.chatId} class="hover:bg-surface-hover transition-colors">
              <td class="px-4 py-3 text-body-sm font-mono text-primary">{s.chatId}</td>
              <td class="px-4 py-3 text-body-sm text-secondary">{s.updatedAt ? new Date(s.updatedAt * 1000).toLocaleString() : '--'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function UsageTab({ agentId }: { agentId: string }) {
  const [data, setData] = useState<{ totals: { inputTokens: number; outputTokens: number; costUsd: number; calls: number } } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get<typeof data>(`/usage?agentId=${agentId}&days=7`)
      .then(setData).catch(() => {}).finally(() => setLoading(false));
  }, [agentId]);

  if (loading) return <div class="grid grid-cols-4 gap-4">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} height="80px" />)}</div>;
  if (!data) return <EmptyState icon={<EmptyUsage />} title="No usage data" />;

  const t = data.totals;
  return (
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {[
        { label: 'Total Cost', value: `$${t.costUsd.toFixed(2)}` },
        { label: 'Input Tokens', value: t.inputTokens.toLocaleString() },
        { label: 'Output Tokens', value: t.outputTokens.toLocaleString() },
        { label: 'API Calls', value: t.calls.toLocaleString() },
      ].map((s) => (
        <div key={s.label} class="bg-surface border border-border rounded-xl p-5">
          <p class="text-caption text-muted uppercase tracking-wider mb-1">{s.label}</p>
          <p class="text-heading-lg font-bold text-primary">{s.value}</p>
        </div>
      ))}
    </div>
  );
}

interface AgentMemory {
  id: string;
  agentId: string;
  chatId: string;
  content: string;
  importance?: number;
  source?: string;
  createdAt?: string;
}

function MemoriesTab({ agentId }: { agentId: string }) {
  const [memories, setMemories] = useState<AgentMemory[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    // No chatId -> the backend returns this agent's memories across all chats.
    api.get<{ memories: AgentMemory[] }>(`/memories?agentId=${encodeURIComponent(agentId)}`)
      .then((d) => setMemories(d.memories ?? []))
      .catch(() => setMemories([]))
      .finally(() => setLoading(false));
  }, [agentId]);

  if (loading) {
    return <div class="space-y-3">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} height="64px" />)}</div>;
  }
  if (memories.length === 0) {
    return (
      <EmptyState
        icon={<EmptyBrain />}
        title="No memories yet"
        description={`No long-term memories have been saved for ${agentId}. Memories accumulate as the agent runs.`}
      />
    );
  }

  return (
    <div>
      <div class="flex items-center justify-between mb-4">
        <p class="text-body-sm text-secondary">
          Most recent memories saved for this agent across all conversations.
        </p>
        <Link href="/memories" class="text-caption text-primary hover:underline shrink-0 ml-3">
          Browse by conversation
        </Link>
      </div>
      <div class="space-y-3">
        {memories.map((m) => (
          <div key={m.id} class="bg-surface border border-border rounded-xl p-4">
            <div class="flex items-center gap-2 mb-2 flex-wrap">
              {m.importance != null && <Badge variant="warning">importance: {m.importance}</Badge>}
              {m.source && <Badge variant="default">{m.source}</Badge>}
              {m.createdAt && <span class="text-caption text-muted">{new Date(m.createdAt).toLocaleString()}</span>}
              <span class="text-overline text-muted font-mono">{m.chatId}</span>
            </div>
            <pre class="text-body-sm text-primary whitespace-pre-wrap font-sans break-words">{m.content}</pre>
          </div>
        ))}
      </div>
    </div>
  );
}

function ConnectionsTab({ agent, onRefresh }: { agent: AgentInfo; onRefresh: () => void }) {
  return (
    <div class="space-y-4">
      <p class="text-body-sm text-secondary">Connect this agent to Telegram, Slack, or both. You only need one to start talking to it.</p>
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <TelegramConnection agentId={agent.agentId} connected={agent.telegramConnected} botUsername={agent.telegramBotUsername} onRefresh={onRefresh} />
        <SlackConnection agentId={agent.agentId} connected={agent.slackConnected} appId={agent.slackAppId} botUsername={agent.slackBotUsername} onRefresh={onRefresh} />
      </div>
    </div>
  );
}

// A numbered setup step. Keeps the Telegram + Slack guides visually identical:
// a small pill with the step index, then the instruction text (which may carry
// links and inline <code> spans).
function SetupStep({ n, children }: { n: number; children: ComponentChildren }) {
  return (
    <li class="flex gap-3 items-start">
      <span class="flex-shrink-0 w-7 h-7 rounded-full bg-primary text-inverse text-body-sm font-bold flex items-center justify-center shadow-sm">{n}</span>
      <span class="leading-relaxed pt-0.5 text-primary text-body-sm">{children}</span>
    </li>
  );
}

// High-visibility container for the numbered setup steps. The accent panel +
// "Setup steps" label make the actual instructions the loudest thing on the
// card so nobody misses what to do.
function SetupSteps({ children }: { children: ComponentChildren }) {
  return (
    <div class="rounded-xl border-2 border-primary/30 bg-primary/5 p-4 space-y-3">
      <p class="text-overline font-bold text-primary tracking-wider uppercase">Setup steps</p>
      <ol class="space-y-3.5">{children}</ol>
    </div>
  );
}

// Inline code chip used inside setup steps (e.g. /newbot, xoxb-…).
function Code({ children }: { children: ComponentChildren }) {
  return <code class="px-1 py-0.5 rounded bg-bg-elevated border border-border font-mono text-[0.78em] text-primary">{children}</code>;
}

// Anchor styled as a full-width button, mirroring Button.tsx's variant classes.
// Used for the one external link in each flow so the primary action reads as a
// real call-to-action, not buried inline text.
function LinkButton({ href, variant = 'secondary', children }: { href: string; variant?: 'primary' | 'secondary'; children: ComponentChildren }) {
  const v = variant === 'primary'
    ? 'bg-primary text-inverse hover:bg-primary-hover shadow-sm'
    : 'bg-surface border border-border text-primary hover:bg-surface-hover';
  return (
    <a href={href} target="_blank" rel="noreferrer"
      class={`inline-flex items-center justify-center w-full font-medium rounded-lg transition-all duration-normal px-4 py-2 text-body-sm gap-2 ${v}`}>
      {children}
    </a>
  );
}

async function copyTextToClipboard(text: string, label: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); toast(label, 'success'); }
  catch { toast('Copy failed', 'error'); }
}

// Providers return terse machine errors ("Not Found", "invalid_auth") that mean
// nothing to a non-technical user. Translate the common ones into plain language
// that says what to do; fall back to the raw text for anything unrecognized.
function friendlyTelegramError(raw?: string): string {
  const e = (raw ?? '').toLowerCase();
  if (e.includes('not found') || e.includes('unauthorized') || e.includes('invalid') || e === '')
    return 'That token did not work. Copy the whole token @BotFather sent you (it looks like 123456789:AAExyz…) and paste all of it.';
  return raw ?? 'Could not validate the token.';
}
function friendlySlackError(raw?: string): string {
  const e = (raw ?? '').toLowerCase();
  if (e.includes('account_inactive') || e.includes('not_installed'))
    return 'That app is not installed yet. Open Install App → Install to Workspace in Slack first, then copy the token.';
  if (e.includes('invalid_auth') || e.includes('not_auth') || e.includes('invalid') || e === '')
    return 'Slack rejected that token. Use the Bot User OAuth Token that starts with xoxb-, from the Install App page after you install the app.';
  return raw ?? 'Could not validate the token.';
}

// Ready-to-paste instructions for a browser-driving assistant (e.g. Claude in
// Chrome) to create + wire a Slack app for THIS agent. The secret + OAuth steps
// are explicitly handed back to the human, matching what an assistant is allowed
// to do, so the prompt is safe to run as-is.
function buildSlackClaudePrompt(agentId: string, host: string, manifest: string): string {
  return [
    `Set up a Slack app and connect it to my Netzar OS agent "${agentId}". Work in my browser. Do NOT type my tokens into any field or click Slack's "Allow" yourself, hand those two steps to me.`,
    ``,
    `1. Go to https://api.slack.com/apps then Create New App, then From a manifest. Pick my workspace.`,
    `2. Paste this exact manifest and create the app:`,
    ``,
    manifest || '(open this agent’s Connections tab and copy the manifest first)',
    ``,
    `3. Open Event Subscriptions. If the Request URL shows "Your URL didn't respond", click Retry until it reads Verified.`,
    `4. Open Install App, then Install to Workspace. I will click Allow, then copy the Bot User OAuth Token (starts with xoxb-) and the Signing Secret (Basic Information, App Credentials).`,
    `5. Take me to https://${host}/dashboard/agents/${agentId} , Connections tab , Connect Slack App. I paste both values; you click Validate Token then Connect App.`,
  ].join('\n');
}

function buildTelegramClaudePrompt(agentId: string, host: string): string {
  return [
    `Connect a Telegram bot to my Netzar OS agent "${agentId}". Do NOT type my bot token into any field yourself, hand that step to me.`,
    ``,
    `1. Open https://t.me/BotFather. Send /newbot and pick a name plus a username ending in "bot".`,
    `2. I copy the token BotFather replies with (looks like 123456:ABC-DEF...).`,
    `3. Take me to https://${host}/dashboard/agents/${agentId} , Connections tab , Connect Telegram Bot. I paste the token; you click Validate Token then Connect Bot. The webhook registers automatically.`,
  ].join('\n');
}

// Subtle full-width button offering the "let Claude do it" path under each card's
// manual steps. Kept low-key so the manual flow stays primary.
function CopyClaudePromptButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick}
      class="w-full text-caption text-secondary hover:text-primary border border-border rounded-lg py-2 transition-colors">
      Or copy a prompt for Claude to do this in your browser
    </button>
  );
}

function TelegramConnection({ agentId, connected, botUsername, onRefresh }: { agentId: string; connected: boolean; botUsername?: string; onRefresh: () => void }) {
  const [token, setToken] = useState('');
  const [validating, setValidating] = useState(false);
  const [validated, setValidated] = useState<{ username: string } | null>(null);
  const [error, setError] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);

  async function validate() {
    setValidating(true); setError('');
    try {
      const r = await api.post<{ ok: boolean; username?: string; error?: string }>(`/agents/${agentId}/telegram/validate-token`, { token: token.trim() });
      if (r.ok && r.username) setValidated({ username: r.username });
      else setError(friendlyTelegramError(r.error));
    } catch { setError('Could not reach the server to check the token. Try again in a moment.'); }
    setValidating(false);
  }

  async function connect() {
    setConnecting(true);
    try {
      await api.post(`/agents/${agentId}/telegram/connect`, { token: token.trim(), webhookDomain: window.location.host });
      toast('Telegram bot connected', 'success');
      onRefresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Connect failed', 'error');
    }
    setConnecting(false);
  }

  async function disconnect() {
    try {
      await api.post(`/agents/${agentId}/telegram/disconnect`);
      onRefresh();
      setToken('');
      setValidated(null);
      toast('Telegram bot disconnected', 'success');
    } catch (err) {
      // Surface the failure instead of swallowing it: a silent catch here is
      // what hid the broken disconnect (creds stayed in the DB while the UI
      // looked clean).
      toast(err instanceof Error ? err.message : 'Disconnect failed', 'error');
    }
    setDisconnectOpen(false);
  }

  const TelegramIcon = (
    <svg class="w-5 h-5 text-blue-500" fill="currentColor" viewBox="0 0 24 24"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>
  );

  if (connected) {
    return (
      <div class="bg-surface border border-border rounded-xl p-6">
        <div class="flex items-center gap-3 mb-4">
          <div class="w-10 h-10 bg-blue-500/10 rounded-full flex items-center justify-center">{TelegramIcon}</div>
          <div>
            <p class="text-body-sm font-semibold text-success">Telegram Connected</p>
            {botUsername && <p class="text-caption text-muted">@{botUsername}</p>}
          </div>
        </div>
        {botUsername && (
          <a href={`https://t.me/${botUsername}`} target="_blank" rel="noreferrer"
            class="inline-flex items-center gap-1 text-caption text-primary hover:underline mb-4">
            Message @{botUsername} in Telegram →
          </a>
        )}
        <div><Button variant="danger" size="sm" onClick={() => setDisconnectOpen(true)}>Disconnect</Button></div>
        <ConfirmDialog open={disconnectOpen} onClose={() => setDisconnectOpen(false)} onConfirm={disconnect}
          title="Disconnect Telegram" message="Disconnect the Telegram bot? Messages will no longer be processed." confirmLabel="Disconnect" danger />
      </div>
    );
  }

  return (
    <div class="bg-surface border border-border rounded-xl p-6 space-y-4">
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 bg-blue-500/10 rounded-full flex items-center justify-center flex-shrink-0">{TelegramIcon}</div>
        <h3 class="text-heading-sm font-semibold">Connect Telegram Bot</h3>
      </div>
      <p class="text-body-sm text-secondary">Create a bot with BotFather, paste its token, done. The webhook wires itself on connect, no redeploy.</p>
      <LinkButton href="https://t.me/BotFather" variant="secondary">Open @BotFather in Telegram →</LinkButton>
      <SetupSteps>
        <SetupStep n={1}>In BotFather, send <Code>/newbot</Code> and pick a name plus a username ending in <Code>bot</Code>.</SetupStep>
        <SetupStep n={2}>Copy the token it replies with (like <Code>123456:ABC-DEF…</Code>).</SetupStep>
        <SetupStep n={3}>Paste it below and validate.</SetupStep>
      </SetupSteps>
      <CopyClaudePromptButton onClick={() => copyTextToClipboard(buildTelegramClaudePrompt(agentId, window.location.host), 'Claude prompt copied')} />
      <div>
        <label class="block text-caption text-muted font-medium mb-1">Bot token from @BotFather</label>
        <input value={token} onInput={(e) => { setToken((e.target as HTMLInputElement).value); setValidated(null); setError(''); }}
          placeholder="123456789:AAExyz…"
          class="w-full px-3 py-2 bg-bg-elevated border border-border rounded-lg text-body-sm font-mono outline-none focus:ring-2 focus:ring-primary/50 placeholder:text-muted" />
      </div>
      {error && <p class="text-caption text-danger">{error}</p>}
      {validated ? (
        <div class="space-y-3">
          <Badge variant="success">Found: @{validated.username}</Badge>
          <Button class="w-full" onClick={connect} loading={connecting}>Connect Bot</Button>
        </div>
      ) : (
        <Button variant="secondary" class="w-full" onClick={validate} loading={validating} disabled={!token.trim()}>Validate Token</Button>
      )}
    </div>
  );
}

function SlackConnection({ agentId, connected, appId, botUsername, onRefresh }: { agentId: string; connected: boolean; appId?: string; botUsername?: string; onRefresh: () => void }) {
  const [botToken, setBotToken] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [validating, setValidating] = useState(false);
  const [validated, setValidated] = useState<{ appId: string } | null>(null);
  const [error, setError] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  // The per-agent app manifest, generated server-side with this agent's event
  // URL already filled in. Pasting it into Slack's "From a manifest" flow sets
  // every scope + event subscription correctly, so the operator never hand-wires
  // the app. Fetched lazily and only while disconnected.
  const [manifest, setManifest] = useState('');
  const [manifestError, setManifestError] = useState(false);

  function loadManifest() {
    setManifestError(false);
    api.get<{ manifest: object }>(`/agents/${agentId}/slack/manifest?domain=${encodeURIComponent(window.location.host)}`)
      .then((r) => setManifest(JSON.stringify(r.manifest, null, 2)))
      .catch(() => setManifestError(true));
  }

  useEffect(() => {
    if (connected) return;
    setManifest('');
    loadManifest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, connected]);

  async function copyManifest() {
    try { await navigator.clipboard.writeText(manifest); toast('Manifest copied', 'success'); }
    catch { toast('Copy failed', 'error'); }
  }

  // One-click primary action: copy the manifest AND open Slack's create-app
  // dialog in a new tab, so the operator only has to paste once they land there.
  async function copyAndOpenSlack() {
    try { await navigator.clipboard.writeText(manifest); toast('Manifest copied, paste it in Slack', 'success'); }
    catch { toast('Copy failed', 'error'); }
    window.open('https://api.slack.com/apps?new_app=1', '_blank', 'noopener');
  }

  async function validate() {
    setValidating(true); setError('');
    try {
      const r = await api.post<{ ok: boolean; appId?: string; error?: string }>(`/agents/${agentId}/slack/validate-token`, { botToken: botToken.trim() });
      if (r.ok && r.appId) setValidated({ appId: r.appId });
      else setError(friendlySlackError(r.error));
    } catch { setError('Could not reach the server to check the token. Try again in a moment.'); }
    setValidating(false);
  }

  async function connect() {
    setConnecting(true);
    try {
      await api.post(`/agents/${agentId}/slack/connect`, { botToken: botToken.trim(), signingSecret: signingSecret.trim() });
      toast('Slack app connected', 'success');
      onRefresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Connect failed', 'error');
    }
    setConnecting(false);
  }

  async function disconnect() {
    try {
      await api.post(`/agents/${agentId}/slack/disconnect`);
      onRefresh();
      setBotToken('');
      setSigningSecret('');
      setValidated(null);
      toast('Slack app disconnected', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Disconnect failed', 'error');
    }
    setDisconnectOpen(false);
  }

  const SlackIcon = (
    <svg class="w-5 h-5" viewBox="0 0 24 24" fill="none"><path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z" fill="#E01E5A"/><path d="M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z" fill="#36C5F0"/><path d="M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312z" fill="#2EB67D"/><path d="M15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" fill="#ECB22E"/></svg>
  );

  if (connected) {
    return (
      <div class="bg-surface border border-border rounded-xl p-6">
        <div class="flex items-center gap-3 mb-4">
          <div class="w-10 h-10 bg-purple-500/10 rounded-full flex items-center justify-center">{SlackIcon}</div>
          <div>
            <p class="text-body-sm font-semibold text-success">Slack Connected</p>
            {botUsername && <p class="text-caption text-muted">{botUsername}</p>}
            {appId && <p class="text-overline text-muted">App: {appId}</p>}
          </div>
        </div>
        <Button variant="danger" size="sm" onClick={() => setDisconnectOpen(true)}>Disconnect</Button>
        <ConfirmDialog open={disconnectOpen} onClose={() => setDisconnectOpen(false)} onConfirm={disconnect}
          title="Disconnect Slack" message="Disconnect the Slack app? Messages will no longer be processed." confirmLabel="Disconnect" danger />
      </div>
    );
  }

  return (
    <div class="bg-surface border border-border rounded-xl p-6 space-y-4">
      <div class="flex items-center gap-3">
        <div class="w-9 h-9 bg-purple-500/10 rounded-full flex items-center justify-center flex-shrink-0">{SlackIcon}</div>
        <h3 class="text-heading-sm font-semibold">Connect Slack App</h3>
      </div>
      <p class="text-body-sm text-secondary">One click copies the manifest and opens Slack. Paste it to create the app, then bring back two values. The manifest already has this agent's event URL filled in.</p>
      <Button variant="primary" class="w-full" onClick={copyAndOpenSlack} disabled={!manifest}>Copy manifest &amp; open Slack →</Button>
      {manifestError && (
        <p class="text-caption text-danger">Could not load the manifest. <button type="button" onClick={loadManifest} class="text-primary hover:underline">Retry</button></p>
      )}
      <SetupSteps>
        <SetupStep n={1}>In Slack, choose <span class="font-semibold">From a manifest</span>, pick your workspace, paste, and create. If it says the URL "didn't respond", click <span class="font-semibold">Retry</span> once and it verifies.</SetupStep>
        <SetupStep n={2}>Open <span class="font-semibold">Install App</span> → <span class="font-semibold">Install to Workspace</span>.</SetupStep>
        <SetupStep n={3}>Copy the <span class="font-semibold">Bot User OAuth Token</span> (<Code>xoxb-…</Code>) and the <span class="font-semibold">Signing Secret</span> (Basic Information → App Credentials).</SetupStep>
        <SetupStep n={4}>Paste both below and validate.</SetupStep>
      </SetupSteps>
      <CopyClaudePromptButton onClick={() => copyTextToClipboard(buildSlackClaudePrompt(agentId, window.location.host, manifest), 'Claude prompt copied')} />
      <details class="rounded-lg border border-border bg-bg-elevated group">
        <summary class="flex items-center justify-between px-3 py-2 cursor-pointer select-none text-overline text-muted font-semibold">
          <span>View / re-copy manifest</span>
          <button type="button" onClick={(e) => { e.preventDefault(); copyManifest(); }} disabled={!manifest}
            class="text-caption text-primary hover:underline disabled:opacity-40 disabled:no-underline">Copy</button>
        </summary>
        <pre class="text-caption font-mono text-secondary px-3 pb-3 overflow-x-auto max-h-44 overflow-y-auto whitespace-pre">{manifest || (manifestError ? 'Could not load the manifest. Click Retry above.' : 'Loading manifest…')}</pre>
      </details>
      <p class="text-caption text-muted">Get these from your Slack app after installing it (steps 2 and 3 above):</p>
      <div>
        <label class="block text-caption text-muted font-medium mb-1">Bot User OAuth Token</label>
        <input value={botToken} onInput={(e) => { setBotToken((e.target as HTMLInputElement).value); setValidated(null); setError(''); }}
          placeholder="xoxb-…" class="w-full px-3 py-2 bg-bg-elevated border border-border rounded-lg text-body-sm font-mono outline-none focus:ring-2 focus:ring-primary/50 placeholder:text-muted" />
      </div>
      <div>
        <label class="block text-caption text-muted font-medium mb-1">Signing secret</label>
        <input value={signingSecret} onInput={(e) => setSigningSecret((e.target as HTMLInputElement).value)}
          placeholder="••••••••••••••••" type="password" class="w-full px-3 py-2 bg-bg-elevated border border-border rounded-lg text-body-sm font-mono outline-none focus:ring-2 focus:ring-primary/50 placeholder:text-muted" />
      </div>
      {error && <p class="text-caption text-danger">{error}</p>}
      {validated ? (
        <div class="space-y-3">
          <Badge variant="success">Found: {validated.appId}</Badge>
          {!signingSecret.trim() && <p class="text-caption text-muted">Also paste the Signing secret above to finish connecting.</p>}
          <Button class="w-full" onClick={connect} loading={connecting} disabled={!signingSecret.trim()}>Connect App</Button>
        </div>
      ) : (
        <Button variant="secondary" class="w-full" onClick={validate} loading={validating} disabled={!botToken.trim()}>Validate Token</Button>
      )}
    </div>
  );
}

function SettingsTab({ agent, onRefresh }: { agent: AgentInfo; onRefresh: () => void }) {
  const [deactivateOpen, setDeactivateOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // Knowledge scope: the named vector corpus this agent searches by default
  // (alongside the always-shared "shared" scope). Empty input means "default".
  const [editingScope, setEditingScope] = useState(false);
  const [scope, setScope] = useState(agent.knowledgeScope ?? '');
  const [savingScope, setSavingScope] = useState(false);
  const isBuiltin = ['main', 'ops', 'research'].includes(agent.agentId);
  const effectiveScope = agent.knowledgeScope || 'default';

  async function saveScope() {
    setSavingScope(true);
    try {
      const next = scope.trim() || 'default';
      await api.patch(`/agents/${agent.agentId}`, { knowledgeScope: next });
      toast('Knowledge scope updated', 'success');
      setEditingScope(false);
      onRefresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setSavingScope(false);
  }

  async function handleDeactivate() {
    try {
      if (agent.status === 'active') await api.post(`/agents/${agent.agentId}/deactivate`);
      else await api.post(`/agents/${agent.agentId}/activate`);
      onRefresh();
    } catch {}
    setDeactivateOpen(false);
  }

  async function handleDelete() {
    try {
      await api.del(`/agents/${agent.agentId}`);
      toast('Agent deleted', 'success');
      window.location.href = '/dashboard/agents';
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setDeleteOpen(false);
  }

  return (
    <div class="max-w-xl space-y-6">
      <div class="bg-surface border border-border rounded-xl p-6">
        <h3 class="text-heading-sm font-semibold mb-2">Status</h3>
        <p class="text-body-sm text-secondary mb-4">
          {agent.status === 'active' ? 'This agent is currently processing messages.' : 'This agent is deactivated and will not process messages.'}
        </p>
        <Toggle
          checked={agent.status === 'active'}
          ariaLabel={agent.status === 'active' ? 'Agent active, switch off to deactivate' : 'Agent deactivated, switch on to activate'}
          onChange={() => setDeactivateOpen(true)}
        >
          <span class={`text-body-sm font-medium ${agent.status === 'active' ? 'text-success' : 'text-muted'}`}>
            {agent.status === 'active' ? 'Active' : 'Deactivated'}
          </span>
        </Toggle>
      </div>

      <div class="bg-surface border border-border rounded-xl p-6">
        <h3 class="text-heading-sm font-semibold mb-4">Configuration</h3>
        <div class="space-y-4">
          <div>
            <label class="block text-caption text-muted font-medium mb-1">Model</label>
            <p class="text-body-sm text-primary font-mono">{agent.model ? formatModelName(agent.model) : 'Platform default'}</p>
          </div>
          <div>
            <label class="block text-caption text-muted font-medium mb-1">Connected Channels</label>
            <div class="flex gap-2">
              <span class={`text-body-sm ${agent.telegramConnected ? 'text-success' : 'text-muted'}`}>
                {agent.telegramConnected ? 'Telegram connected' : 'Telegram not connected'}
              </span>
              <span class={`text-body-sm ${agent.slackConnected ? 'text-success' : 'text-muted'}`}>
                {agent.slackConnected ? 'Slack connected' : 'Slack not connected'}
              </span>
            </div>
          </div>
          <div>
            <label class="block text-caption text-muted font-medium mb-1">Knowledge Scope</label>
            <p class="text-caption text-muted mb-2">
              The vector corpus this agent searches by default. It always also searches the shared "shared" scope. Leave blank for "default".
            </p>
            {editingScope ? (
              <div class="space-y-2">
                <input
                  value={scope}
                  onInput={(e) => setScope((e.target as HTMLInputElement).value)}
                  placeholder="default"
                  class="w-full px-3 py-2 bg-bg-elevated border border-border rounded-lg text-body-sm font-mono outline-none focus:ring-2 focus:ring-primary/50 placeholder:text-muted"
                />
                <div class="flex gap-2">
                  <Button size="sm" onClick={saveScope} loading={savingScope}>Save</Button>
                  <Button size="sm" variant="secondary" onClick={() => { setScope(agent.knowledgeScope ?? ''); setEditingScope(false); }}>Cancel</Button>
                </div>
              </div>
            ) : (
              <div class="flex items-center gap-3">
                <p class="text-body-sm text-primary font-mono">{effectiveScope}</p>
                <button onClick={() => setEditingScope(true)} class="text-caption text-primary hover:underline">Edit</button>
              </div>
            )}
          </div>
        </div>
      </div>

      {!isBuiltin && (
        <div class="bg-danger/5 border border-danger/20 rounded-xl p-6">
          <h3 class="text-heading-sm font-semibold text-danger mb-2">Danger Zone</h3>
          <p class="text-body-sm text-secondary mb-4">Permanently delete this agent and all its configuration. This cannot be undone.</p>
          <Button variant="danger" onClick={() => setDeleteOpen(true)}>Delete Agent</Button>
        </div>
      )}

      <ConfirmDialog open={deactivateOpen} onClose={() => setDeactivateOpen(false)} onConfirm={handleDeactivate}
        title={agent.status === 'active' ? 'Deactivate Agent' : 'Activate Agent'}
        message={agent.status === 'active' ? 'Deactivating will stop all message processing for this agent.' : 'Activating will resume message processing for this agent.'}
        confirmLabel={agent.status === 'active' ? 'Deactivate' : 'Activate'} />
      <ConfirmDialog open={deleteOpen} onClose={() => setDeleteOpen(false)} onConfirm={handleDelete}
        title="Delete Agent" message={`Permanently delete "${agent.displayName}"? This removes all configuration and cannot be undone.`}
        confirmLabel="Delete" danger />
    </div>
  );
}
