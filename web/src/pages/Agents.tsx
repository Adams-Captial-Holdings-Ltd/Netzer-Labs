import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { ComponentChildren } from 'preact';
import { Link } from 'wouter-preact';
import { api } from '../lib/api';
import { StatusDot } from '../components/StatusDot';
import { Select } from '../components/Select';
import { SkeletonCard } from '../components/Skeleton';
import { EmptyState } from '../components/EmptyState';
import { EmptySearch, EmptyBot, SuccessCheck } from '../components/Icons';
import { Button } from '../components/Button';
import { Toggle } from '../components/Toggle';
import { TldrBar } from '../components/TldrBar';
import { Badge } from '../components/Badge';
import { ConfirmDialog } from '../components/Modal';
import { toast } from '../components/Toast';
import { formatModelName } from '../lib/format';

interface AgentSummary {
  id: string;
  displayName: string;
  description: string;
  model: string | null;
  status: string;
  telegramConnected: boolean;
  slackConnected: boolean;
  createdAt: string | null;
}

interface Template {
  id: string;
  displayName: string;
  description: string;
  tagline?: string;
  icon?: string;
  category?: string;
  suggestedModel?: string | null;
  suggestedKnowledgeScope?: string | null;
  suggestedFirstMessage?: string | null;
}

const TEMPLATE_CATEGORY_LABELS: Record<string, string> = {
  general: 'General',
  finance: 'Investment teams',
  nonprofit: 'Nonprofits',
  business: 'Business',
};

export function Agents() {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive'>('all');

  const refresh = useCallback(async () => {
    try {
      const data = await api.get<{ agents: AgentSummary[] }>('/agents');
      setAgents(data.agents);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to load agents', 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30000);
    return () => clearInterval(t);
  }, [refresh]);

  const filtered = agents.filter((a) => {
    if (search && !a.displayName.toLowerCase().includes(search.toLowerCase()) && !a.id.toLowerCase().includes(search.toLowerCase())) return false;
    if (statusFilter === 'active' && a.status !== 'active') return false;
    if (statusFilter === 'inactive' && a.status === 'active') return false;
    return true;
  });

  const activeCount = agents.filter((a) => a.status === 'active').length;

  return (
    <div>
      <TldrBar
        tab="Agents"
        ready={!loading}
        data={{
          total: agents.length,
          active: activeCount,
          agents: agents.slice(0, 30).map((a) => ({ id: a.id, name: a.displayName, status: a.status })),
        }}
      />
      <div class="flex items-center justify-between mb-6">
        <div data-tour="agents-title">
          <h1 class="text-display-sm text-primary font-bold">Agents</h1>
          <p class="text-body-sm text-secondary mt-1">
            {agents.length} configured
            {activeCount > 0 && <span class="text-success ml-1">({activeCount} active)</span>}
          </p>
        </div>
        <span data-tour="agents-new-button">
          <Button onClick={() => setWizardOpen(true)}>
            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
            New Agent
          </Button>
        </span>
      </div>

      <div class="flex gap-3 mb-6" data-tour="agents-filters">
        <input
          value={search}
          onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
          placeholder="Search agents..."
          class="flex-1 max-w-sm bg-surface border border-border rounded-lg px-3 py-2 text-body-sm
            focus:ring-2 focus:ring-primary/50 outline-none placeholder:text-muted transition-colors"
        />
        <Select
          value={statusFilter}
          onChange={(v) => setStatusFilter(v as typeof statusFilter)}
          options={[
            { value: 'all', label: 'All status' },
            { value: 'active', label: 'Active' },
            { value: 'inactive', label: 'Inactive' },
          ]}
          size="md"
        />
      </div>

      {loading ? (
        <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
          {Array.from({ length: 6 }).map((_, i) => <SkeletonCard key={i} />)}
        </div>
      ) : filtered.length === 0 ? (
        search || statusFilter !== 'all' ? (
          <EmptyState icon={<EmptySearch />} title="No matching agents" description="Try adjusting your search or filters." />
        ) : (
          <EmptyState
            icon={<EmptyBot />}
            title="Create your first agent"
            description="Agents handle conversations across Telegram, Slack, and the dashboard."
            action={<Button onClick={() => setWizardOpen(true)}>Create Agent</Button>}
          />
        )
      ) : (
        <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5" data-tour="agents-grid">
          {filtered.map((a) => (
            <AgentCard key={a.id} agent={a} onRefresh={refresh} />
          ))}
        </div>
      )}

      {wizardOpen && <CreateAgentWizard onClose={() => { setWizardOpen(false); refresh(); }} />}
    </div>
  );
}

const AGENT_ICONS: Record<string, ComponentChildren> = {
  main: <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" /></svg>,
  ops: <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" /></svg>,
  research: <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" /><line x1="11" y1="8" x2="11" y2="14" /><line x1="8" y1="11" x2="14" y2="11" /></svg>,
};
const DEFAULT_ICON = <svg class="w-5 h-5 text-white" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8V4H8" /><rect x="4" y="8" width="16" height="12" rx="2" /><path d="M2 14h2" /><path d="M20 14h2" /><path d="M15 13v2" /><path d="M9 13v2" /></svg>;

const AGENT_GRADIENTS: Record<string, string> = {
  main: 'from-indigo-500 to-purple-600',
  ops: 'from-amber-500 to-orange-600',
  research: 'from-emerald-500 to-teal-600',
};
const DEFAULT_GRADIENT = 'from-gray-500 to-gray-600';

function AgentCard({ agent, onRefresh }: { agent: AgentSummary; onRefresh: () => void }) {
  const [busy, setBusy] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [health, setHealth] = useState<{ status: string; lastMessageAt?: string } | null>(null);

  useEffect(() => {
    if (agent.status === 'active') {
      api.get<{ status: string; lastMessageAt?: string }>(`/agents/${agent.id}/health`)
        .then(setHealth)
        .catch(() => {});
    }
  }, [agent.id, agent.status]);
  const gradient = AGENT_GRADIENTS[agent.id] ?? DEFAULT_GRADIENT;
  const icon = AGENT_ICONS[agent.id] ?? DEFAULT_ICON;

  async function toggleStatus() {
    setBusy(true);
    try {
      if (agent.status === 'active') await api.post(`/agents/${agent.id}/deactivate`);
      else await api.post(`/agents/${agent.id}/activate`);
      onRefresh();
      toast(`Agent ${agent.status === 'active' ? 'deactivated' : 'activated'}`, 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setBusy(false);
  }

  async function handleDelete() {
    setBusy(true);
    try {
      await api.del(`/agents/${agent.id}`);
      toast('Agent deleted', 'success');
      onRefresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setBusy(false);
    setDeleteOpen(false);
  }

  return (
    <>
      <Link href={`/agents/${agent.id}`} class="block group">
        <div class="bg-surface border border-border rounded-xl overflow-hidden hover:shadow-md hover:border-border-strong transition-all duration-normal hover:-translate-y-0.5">
          <div class={`h-1.5 bg-gradient-to-r ${gradient}`} />
          <div class="p-5">
            <div class="flex items-start gap-3 mb-3">
              <div class={`w-10 h-10 rounded-lg bg-gradient-to-br ${gradient} flex items-center justify-center shadow-sm`}>
                {icon}
              </div>
              <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                  <h3 class="font-semibold text-primary group-hover:text-claw-500 transition-colors truncate">
                    {agent.displayName}
                  </h3>
                  <StatusDot
                    status={agent.status !== 'active' ? 'inactive' : (health?.status as 'healthy' | 'idle' | 'degraded' | 'error') ?? 'active'}
                    label={health?.status === 'idle' ? 'No recent activity' : undefined}
                  />
                </div>
                <p class="text-overline text-muted font-mono">{agent.id}</p>
              </div>
            </div>

            <p class="text-body-sm text-secondary mb-4 line-clamp-2 leading-relaxed min-h-[2.5rem]">
              {agent.description || 'No description configured'}
            </p>

            <div class="flex items-center gap-2 flex-wrap mb-4">
              {agent.model && (
                <Badge>{formatModelName(agent.model)}</Badge>
              )}
              {agent.telegramConnected && <Badge variant="info">Telegram</Badge>}
              {agent.slackConnected && <Badge variant="info">Slack</Badge>}
            </div>

            <div class="flex gap-2 pt-3 border-t border-border" onClick={(e) => e.preventDefault()}>
              <Toggle
                size="sm"
                checked={agent.status === 'active'}
                busy={busy}
                ariaLabel={agent.status === 'active' ? 'Active, switch off to deactivate' : 'Deactivated, switch on to activate'}
                onChange={() => toggleStatus()}
              >
                <span class="text-caption font-medium text-secondary">
                  {agent.status === 'active' ? 'Active' : 'Off'}
                </span>
              </Toggle>
              {!['main', 'ops', 'research'].includes(agent.id) && (
                <button
                  onClick={() => setDeleteOpen(true)}
                  disabled={busy}
                  class="text-caption text-danger hover:text-red-600 disabled:opacity-50 font-medium ml-auto transition-colors"
                >
                  Delete
                </button>
              )}
            </div>
          </div>
        </div>
      </Link>
      <ConfirmDialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onConfirm={handleDelete}
        title="Delete Agent"
        message={`Delete "${agent.displayName}"? This removes all configuration and cannot be undone.`}
        confirmLabel="Delete"
        danger
        loading={busy}
      />
    </>
  );
}

function CreateAgentWizard({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(1);
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [model, setModel] = useState('us.anthropic.claude-sonnet-4-6');
  const [template, setTemplate] = useState('blank');
  const [templates, setTemplates] = useState<Template[]>([]);
  const [idError, setIdError] = useState('');
  const [idValid, setIdValid] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createdId, setCreatedId] = useState('');
  const [createError, setCreateError] = useState('');
  // Template prompt preview modal
  const [previewId, setPreviewId] = useState('');
  const [previewPrompt, setPreviewPrompt] = useState('');

  useEffect(() => {
    api.get<{ templates: Template[] }>('/agents/templates').then((d) => setTemplates(d.templates)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!previewId) return;
    setPreviewPrompt('Loading…');
    api.get<{ claudeMd: string }>(`/agents/templates/${previewId}`)
      .then((d) => setPreviewPrompt(d.claudeMd))
      .catch(() => setPreviewPrompt('Failed to load the template prompt.'));
  }, [previewId]);

  // Picking a template prefills the model when the template suggests one.
  function selectTemplate(t: Template) {
    setTemplate(t.id);
    if (t.suggestedModel) setModel(t.suggestedModel);
  }

  // Debounce + stale-response guard for id validation. The old version
  // returned a cleanup closure from a plain event handler, which nothing ever
  // called, so every keystroke fired its own request and a slow early
  // response could overwrite the verdict for the id actually typed.
  const idCheckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idCheckLatest = useRef('');

  function handleIdChange(val: string) {
    setId(val);
    if (!name || name === deriveName(id)) {
      setName(deriveName(val));
    }
    if (idCheckTimer.current) clearTimeout(idCheckTimer.current);
    idCheckLatest.current = val;
    if (val.length >= 2) {
      // Not validated until the in-flight check answers for THIS value.
      setIdValid(false);
      idCheckTimer.current = setTimeout(async () => {
        try {
          const r = await api.post<{ ok: boolean; error?: string }>('/agents/validate-id', { id: val });
          if (idCheckLatest.current !== val) return;
          setIdValid(r.ok);
          setIdError(r.ok ? '' : (r.error ?? 'Invalid'));
        } catch (err) {
          if (idCheckLatest.current !== val) return;
          setIdError(err instanceof Error ? err.message : 'Validation failed');
          setIdValid(false);
        }
      }, 350);
    } else {
      setIdValid(false);
      setIdError(val ? 'ID must be at least 2 characters' : '');
    }
  }

  async function handleCreate() {
    setCreating(true);
    setCreateError('');
    try {
      const picked = templates.find((t) => t.id === template);
      await api.post('/agents/create', {
        id,
        name,
        description,
        model,
        template,
        // Template-suggested vector corpus (e.g. 'deals', 'grants') so the
        // new agent's knowledge starts in the right partition.
        ...(picked?.suggestedKnowledgeScope ? { knowledgeScope: picked.suggestedKnowledgeScope } : {}),
      });
      setCreatedId(id);
      setStep(3);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Creation failed');
    }
    setCreating(false);
  }

  return (
    <div class="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div class="bg-surface border border-border rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto page-enter">
        <div class="p-6 border-b border-border">
          <div class="flex items-center justify-between">
            <h2 class="text-heading-lg font-bold text-primary">New Agent</h2>
            <button onClick={onClose} class="text-muted hover:text-primary text-xl p-1">&times;</button>
          </div>
          <div class="flex gap-2 mt-3">
            {[1, 2, 3].map((s) => (
              <div key={s} class={`h-1 flex-1 rounded-full ${s <= step ? 'bg-primary' : 'bg-border'}`} />
            ))}
          </div>
        </div>

        <div class="p-6">
          {step === 1 && (
            <div class="space-y-4">
              <div>
                <label class="block text-caption text-secondary font-medium mb-1">Agent ID</label>
                <input
                  value={id}
                  onInput={(e) => handleIdChange((e.target as HTMLInputElement).value)}
                  placeholder="my-agent"
                  class={`w-full px-3 py-2 bg-bg-elevated border rounded-lg text-body-sm focus:ring-2 focus:ring-primary/50 outline-none ${
                    idError ? 'border-danger' : idValid ? 'border-success' : 'border-border'
                  }`}
                />
                {idError && <p class="text-caption text-danger mt-1">{idError}</p>}
              </div>
              <div>
                <label class="block text-caption text-secondary font-medium mb-1">Display Name</label>
                <input
                  value={name}
                  onInput={(e) => setName((e.target as HTMLInputElement).value)}
                  placeholder="My Agent"
                  class="w-full px-3 py-2 bg-bg-elevated border border-border rounded-lg text-body-sm focus:ring-2 focus:ring-primary/50 outline-none"
                />
              </div>
              <div>
                <label class="block text-caption text-secondary font-medium mb-1">Description</label>
                <textarea
                  value={description}
                  onInput={(e) => setDescription((e.target as HTMLTextAreaElement).value)}
                  placeholder="What this agent does..."
                  rows={2}
                  class="w-full px-3 py-2 bg-bg-elevated border border-border rounded-lg text-body-sm focus:ring-2 focus:ring-primary/50 outline-none resize-none"
                />
              </div>
              {templates.length > 0 && (
                <div>
                  <label class="block text-caption text-secondary font-medium mb-1">Template</label>
                  {['general', 'finance', 'nonprofit', 'business']
                    .filter((cat) => templates.some((t) => (t.category ?? 'general') === cat))
                    .map((cat) => (
                      <div key={cat} class="mb-2">
                        <p class="text-overline text-muted uppercase tracking-wider mb-1">
                          {TEMPLATE_CATEGORY_LABELS[cat] ?? cat}
                        </p>
                        <div class="grid grid-cols-2 gap-2">
                          {templates
                            .filter((t) => (t.category ?? 'general') === cat)
                            .map((t) => (
                              <button
                                key={t.id}
                                onClick={() => selectTemplate(t)}
                                class={`text-left p-3 rounded-lg border text-body-sm transition-colors ${
                                  template === t.id
                                    ? 'border-primary bg-primary/5 text-primary'
                                    : 'border-border hover:border-border-strong'
                                }`}
                              >
                                <div class="font-medium">{t.icon ? `${t.icon} ` : ''}{t.displayName}</div>
                                <div class="text-caption text-muted mt-0.5">{t.tagline ?? t.description}</div>
                              </button>
                            ))}
                        </div>
                      </div>
                    ))}
                  <button
                    type="button"
                    class="text-caption text-primary hover:underline mt-1"
                    onClick={() => setPreviewId(template)}
                  >
                    Preview this template's system prompt
                  </button>
                </div>
              )}
              <div>
                <label class="block text-caption text-secondary font-medium mb-1">Model</label>
                <Select
                  value={model}
                  onChange={setModel}
                  options={[
                    { value: 'us.anthropic.claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
                    { value: 'us.anthropic.claude-opus-4-7', label: 'Claude Opus 4.7' },
                    { value: 'us.anthropic.claude-haiku-4-5', label: 'Claude Haiku 4.5' },
                  ]}
                  size="md"
                  class="w-full"
                />
              </div>
              <Button class="w-full" onClick={() => setStep(2)} disabled={!idValid || !name}>
                Next
              </Button>
            </div>
          )}

          {step === 2 && (
            <div class="space-y-4">
              <div class="bg-bg-sunken rounded-lg p-4 space-y-2">
                <div class="flex justify-between text-body-sm"><span class="text-secondary">ID</span><span class="font-mono text-primary">{id}</span></div>
                <div class="flex justify-between text-body-sm"><span class="text-secondary">Name</span><span class="text-primary">{name}</span></div>
                <div class="flex justify-between text-body-sm"><span class="text-secondary">Template</span><span class="text-primary">{template}</span></div>
                <div class="flex justify-between text-body-sm"><span class="text-secondary">Model</span><span class="text-primary">{model.split('.').pop()}</span></div>
                {description && <div class="text-body-sm text-secondary pt-2 border-t border-border">{description}</div>}
              </div>
              {createError && <div class="bg-danger/10 text-danger px-4 py-3 rounded-lg text-body-sm border border-danger/20">{createError}</div>}
              <div class="flex gap-3">
                <Button variant="secondary" class="flex-1" onClick={() => setStep(1)}>Back</Button>
                <Button class="flex-1" onClick={handleCreate} loading={creating}>Create Agent</Button>
              </div>
            </div>
          )}

          {previewId && (
            <div
              class="fixed inset-0 bg-black/60 flex items-center justify-center z-[60] p-6"
              onClick={(e) => { if (e.target === e.currentTarget) setPreviewId(''); }}
            >
              <div class="bg-surface border border-border rounded-xl shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col">
                <div class="flex items-center justify-between p-4 border-b border-border">
                  <h3 class="text-heading-sm font-bold text-primary">
                    {templates.find((t) => t.id === previewId)?.displayName ?? previewId} — system prompt
                  </h3>
                  <button onClick={() => setPreviewId('')} class="text-muted hover:text-primary text-xl p-1">&times;</button>
                </div>
                <pre class="p-4 overflow-y-auto text-caption font-mono whitespace-pre-wrap text-secondary">
                  {previewPrompt}
                </pre>
              </div>
            </div>
          )}

          {step === 3 && (
            <div class="text-center space-y-4">
              <SuccessCheck />
              <h3 class="text-heading-lg font-bold text-primary">Agent Created</h3>
              <p class="text-body-sm text-secondary">
                Connect a Telegram bot or Slack app to start receiving messages.
              </p>
              <div class="flex gap-3">
                <Link
                  href={`/agents/${createdId}#connections`}
                  class="flex-1"
                  onClick={onClose}
                >
                  <Button class="w-full">Connect a channel</Button>
                </Link>
                <Button variant="secondary" class="flex-1" onClick={onClose}>Done</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function deriveName(id: string): string {
  return id
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}
