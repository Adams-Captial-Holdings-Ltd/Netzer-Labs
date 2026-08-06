import { useState, useEffect, useRef } from 'preact/hooks';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { getToken, getDashboardUser } from '../lib/api';
import { Button } from './Button';
import { Select } from './Select';

// Mirrors PlaygroundModel from src/lib/bedrock/playground-catalog.ts.
interface Model { id: string; provider: string; name: string }
// One retrieved passage, mirrors the /vectors/answer hits shape.
interface Hit { score: number; text: string; docTitle: string | null; source: string | null; chunkIndex: number; page?: number | null }

interface CompareResult {
  status: 'loading' | 'done' | 'error';
  answer?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number | null;
  latencyMs?: number;
  error?: string;
}
interface ChatMsg {
  role: 'user' | 'assistant';
  text: string;
  hits?: Hit[];
  costUsd?: number | null;
  latencyMs?: number;
  error?: boolean;
}

// Per-provider accent — a single dot/edge color that organizes the model wall
// and tags each answer to its maker. Falls back to the brand indigo.
const PROVIDER_ACCENT: Record<string, string> = {
  Anthropic: '#d97757',
  OpenAI: '#10a37f',
  DeepSeek: '#4d6bfe',
  Qwen: '#7c3aed',
  Moonshot: '#ec4899',
  Meta: '#0866ff',
  Mistral: '#fa520f',
  Amazon: '#ff9900',
};
const accentOf = (provider: string) => PROVIDER_ACCENT[provider] ?? '#6366f1';

function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }));
}
function fmtCost(c: number | null | undefined): string {
  if (c === null || c === undefined) return '—';
  if (c === 0) return '$0';
  return c < 0.01 ? `$${c.toFixed(5)}` : `$${c.toFixed(4)}`;
}
function fmtNum(n: number | undefined): string {
  return (n ?? 0).toLocaleString();
}
function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' };
  const who = getDashboardUser();
  if (who) h['X-Dashboard-User'] = who;
  return h;
}
const DEFAULT_PICKS = ['openai.gpt-oss-120b-1:0'];

function BookIcon() {
  return (
    <svg class="w-3.5 h-3.5 shrink-0" fill="none" stroke="currentColor" stroke-width="1.75" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}

// Collapsible list of the passages an answer was grounded on.
function ContextDisclosure({ hits, label }: { hits: Hit[]; label?: string }) {
  const [open, setOpen] = useState(false);
  if (!hits || hits.length === 0) {
    return <span class="text-caption text-muted italic">Ungrounded — no passages retrieved.</span>;
  }
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        class="group inline-flex items-center gap-1.5 text-caption text-muted hover:text-primary transition-colors"
      >
        <BookIcon />
        <span>{label ?? `Grounded on ${hits.length} passage${hits.length === 1 ? '' : 's'}`}</span>
        <svg class={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" /></svg>
      </button>
      {open && (
        <div class="mt-2 space-y-1.5">
          {hits.map((h, i) => (
            <div key={i} class="bg-bg-sunken border border-border rounded-lg p-2.5">
              <div class="flex items-center justify-between gap-2 mb-1.5">
                <span class="text-caption text-secondary font-medium truncate">
                  <span class="text-muted">[{i + 1}]</span> {h.docTitle ?? h.source ?? 'passage'} · {h.page ? `p.${h.page} · ` : ''}chunk {h.chunkIndex}
                </span>
                <span class="text-caption text-muted font-mono shrink-0">{(h.score * 100).toFixed(0)}%</span>
              </div>
              <div class="h-1 rounded-full bg-border overflow-hidden mb-2">
                <div class="h-full rounded-full bg-gradient-to-r from-claw-500 to-purple-600" style={{ width: `${Math.max(3, Math.min(100, h.score * 100))}%` }} />
              </div>
              <p class="text-caption text-muted line-clamp-3 whitespace-pre-wrap">{h.text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function KnowledgeModelTest({ scope }: { scope: string }) {
  const [models, setModels] = useState<Model[]>([]);
  const [mode, setMode] = useState<'compare' | 'chat'>('compare');

  // Compare state
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Record<string, CompareResult>>({});
  const [sharedHits, setSharedHits] = useState<Hit[] | null>(null);

  // Chat state
  const [chatModel, setChatModel] = useState('');
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  const threadEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/playground/models', { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('failed'))))
      .then((d: { models: Model[] }) => {
        const list = d.models ?? [];
        setModels(list);
        const pick = new Set<string>();
        const firstClaude = list.find((m) => m.provider === 'Anthropic');
        if (firstClaude) pick.add(firstClaude.id);
        for (const id of DEFAULT_PICKS) if (list.some((m) => m.id === id)) pick.add(id);
        if (pick.size === 0 && list[0]) pick.add(list[0].id);
        setSelected(pick);
        setChatModel(firstClaude?.id ?? list[0]?.id ?? '');
      })
      .catch(() => {});
  }, []);

  // Switching scope invalidates any answers/thread grounded on the old corpus.
  useEffect(() => {
    setResults({});
    setSharedHits(null);
    setMessages([]);
  }, [scope]);

  useEffect(() => { threadEnd.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const providers: string[] = [];
  for (const m of models) if (!providers.includes(m.provider)) providers.push(m.provider);
  const selectedModels = models.filter((m) => selected.has(m.id));
  const scopeName = scope === 'default' ? 'Default scope' : scope;

  async function runCompareOne(modelId: string) {
    setResults((prev) => ({ ...prev, [modelId]: { status: 'loading' } }));
    try {
      const res = await fetch('/api/vectors/answer', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ query: query.trim(), scope, modelId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        setResults((prev) => ({ ...prev, [modelId]: { status: 'error', error: String(data?.reason || data?.error || `HTTP ${res.status}`) } }));
        return;
      }
      if (data.ok === false) {
        setResults((prev) => ({ ...prev, [modelId]: { status: 'error', error: `${data.error}: ${data.detail ?? ''}`.trim() } }));
        return;
      }
      if (Array.isArray(data.hits)) setSharedHits(data.hits);
      setResults((prev) => ({
        ...prev,
        [modelId]: { status: 'done', answer: data.answer ?? '', inputTokens: data.inputTokens, outputTokens: data.outputTokens, costUsd: data.costUsd, latencyMs: data.latencyMs },
      }));
    } catch {
      setResults((prev) => ({ ...prev, [modelId]: { status: 'error', error: 'Request failed' } }));
    }
  }

  async function runCompare() {
    const text = query.trim();
    if (!text || running || selected.size === 0) return;
    setRunning(true);
    setSharedHits(null);
    await Promise.all([...selected].map((id) => runCompareOne(id)));
    setRunning(false);
  }

  async function sendChat() {
    const text = chatInput.trim();
    if (!text || chatBusy || !chatModel) return;
    setChatInput('');
    const history = messages.map((m) => ({ role: m.role, text: m.text }));
    setMessages((prev) => [...prev, { role: 'user', text }]);
    setChatBusy(true);
    try {
      const res = await fetch('/api/vectors/answer', {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ query: text, scope, modelId: chatModel, history }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || data.ok === false) {
        const reason = data?.detail || data?.reason || data?.error || `HTTP ${res?.status}`;
        setMessages((prev) => [...prev, { role: 'assistant', text: `Error: ${reason}`, error: true }]);
      } else {
        setMessages((prev) => [...prev, { role: 'assistant', text: data.answer ?? '', hits: data.hits ?? [], costUsd: data.costUsd, latencyMs: data.latencyMs }]);
      }
    } catch {
      setMessages((prev) => [...prev, { role: 'assistant', text: 'Error: request failed', error: true }]);
    }
    setChatBusy(false);
  }

  const modelOptions = models.map((m) => ({ value: m.id, label: `${m.name} · ${m.provider}` }));

  const SegToggle = (
    <div class="inline-flex rounded-lg bg-bg-sunken p-0.5 border border-border text-caption">
      {(['compare', 'chat'] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => setMode(m)}
          class={`px-3.5 py-1 rounded-md transition-all capitalize ${mode === m ? 'bg-surface text-primary font-medium shadow-sm' : 'text-muted hover:text-secondary'}`}
        >{m}</button>
      ))}
    </div>
  );

  return (
    <div class="bg-surface border border-border rounded-xl shadow-sm overflow-hidden">
      {/* Gradient hairline tying the panel to the product's brand language */}
      <div class="h-0.5 bg-gradient-to-r from-claw-500 via-purple-500 to-claw-500 opacity-80" />
      <div class="p-5">
        <div class="flex items-start justify-between gap-3 mb-1 flex-wrap">
          <div>
            <h2 class="text-heading-sm font-semibold text-primary">Test with a model</h2>
            <p class="text-caption text-muted mt-0.5">
              See how models answer using the knowledge in <span class="text-secondary font-medium">{scopeName}</span> — grounded on the same passages your agents retrieve.
            </p>
          </div>
          {SegToggle}
        </div>

        {mode === 'compare' ? (
          <div class="space-y-4 mt-3">
            <textarea
              value={query}
              onInput={(e) => setQuery((e.target as HTMLTextAreaElement).value)}
              placeholder="Ask a question about your knowledge base…  e.g. 'When does the hackathon build start?'"
              rows={2}
              class="w-full bg-bg-sunken border border-border rounded-xl px-4 py-3 text-body-sm focus:ring-2 focus:ring-primary/40 focus:border-primary outline-none placeholder:text-muted resize-y transition-colors"
            />

            <div class="space-y-2">
              <div class="flex items-center justify-between">
                <span class="text-overline text-muted uppercase tracking-wider">Models · <span class="text-secondary">{selected.size} selected</span></span>
                <div class="flex gap-3">
                  <button type="button" class="text-caption text-muted hover:text-primary transition-colors" onClick={() => setSelected(new Set(models.map((m) => m.id)))}>Select all</button>
                  <button type="button" class="text-caption text-muted hover:text-primary transition-colors" onClick={() => setSelected(new Set())}>Clear</button>
                </div>
              </div>
              <div class="space-y-1.5">
                {providers.map((p) => (
                  <div key={p} class="flex items-start gap-2.5">
                    <span class="flex items-center gap-1.5 w-[88px] shrink-0 pt-1.5">
                      <span class="w-2 h-2 rounded-full shrink-0" style={{ background: accentOf(p) }} />
                      <span class="text-caption text-muted truncate">{p}</span>
                    </span>
                    <div class="flex flex-wrap gap-1.5">
                      {models.filter((m) => m.provider === p).map((m) => {
                        const on = selected.has(m.id);
                        return (
                          <button
                            key={m.id} type="button" onClick={() => toggle(m.id)}
                            class={`text-caption rounded-full px-2.5 py-1 border transition-all ${on ? 'bg-primary/15 border-primary/50 text-primary font-medium ring-1 ring-primary/20' : 'bg-bg-sunken border-border text-secondary hover:border-border-strong hover:text-primary'}`}
                          >{m.name}</button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div class="flex items-center gap-3">
              <Button onClick={runCompare} loading={running} disabled={!query.trim() || selected.size === 0}>
                {running ? 'Asking…' : `Ask ${selected.size} model${selected.size === 1 ? '' : 's'}`}
              </Button>
              {Object.keys(results).length === 0 && (
                <span class="text-caption text-muted">Each model answers the same question over the same retrieved passages.</span>
              )}
            </div>

            {Object.keys(results).length > 0 && (
              <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">
                {selectedModels.map((m) => {
                  const r = results[m.id];
                  if (!r) return null;
                  const accent = accentOf(m.provider);
                  return (
                    <div key={m.id} class="bg-bg-sunken border border-border rounded-xl flex flex-col overflow-hidden hover:border-border-strong transition-colors">
                      <div class="h-0.5" style={{ background: accent }} />
                      <div class="flex items-center justify-between px-3.5 py-2.5 border-b border-border">
                        <span class="flex items-center gap-2 min-w-0">
                          <span class="w-2 h-2 rounded-full shrink-0" style={{ background: accent }} />
                          <span class="text-body-sm font-semibold text-primary truncate">{m.name}</span>
                        </span>
                        <span class="text-overline text-muted uppercase tracking-wider shrink-0 ml-2">{m.provider}</span>
                      </div>
                      <div class="p-3.5 flex-1 min-h-[88px]">
                        {r.status === 'loading' && (
                          <div class="flex gap-1">
                            <span class="w-2 h-2 bg-muted rounded-full animate-bounce" style="animation-delay:0ms" />
                            <span class="w-2 h-2 bg-muted rounded-full animate-bounce" style="animation-delay:150ms" />
                            <span class="w-2 h-2 bg-muted rounded-full animate-bounce" style="animation-delay:300ms" />
                          </div>
                        )}
                        {r.status === 'error' && <p class="text-body-sm text-danger break-words">{r.error}</p>}
                        {r.status === 'done' && (
                          r.answer?.trim()
                            ? <div class="chat-md break-words text-primary text-body-sm" dangerouslySetInnerHTML={{ __html: renderMarkdown(r.answer) }} />
                            : <p class="text-body-sm text-muted italic">No answer returned.</p>
                        )}
                      </div>
                      {r.status === 'done' && (
                        <div class="px-3.5 py-2 border-t border-border flex items-center justify-between text-caption text-muted">
                          <span class="font-mono">{fmtNum(r.inputTokens)} in · {fmtNum(r.outputTokens)} out</span>
                          <span class="flex items-center gap-2.5">
                            {r.latencyMs != null && <span>{(r.latencyMs / 1000).toFixed(1)}s</span>}
                            <span class="font-mono text-secondary bg-surface border border-border rounded-md px-1.5 py-0.5">{fmtCost(r.costUsd)}</span>
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {sharedHits !== null && (
              <div class="rounded-xl border border-border bg-bg-sunken/50 p-3">
                <ContextDisclosure hits={sharedHits} label={`Retrieved context · ${sharedHits.length} passage${sharedHits.length === 1 ? '' : 's'} from ${scopeName}`} />
              </div>
            )}
          </div>
        ) : (
          <div class="space-y-3 mt-3">
            <div class="flex items-center gap-2">
              <span class="text-caption text-muted">Model</span>
              <Select value={chatModel} onChange={setChatModel} options={modelOptions} />
              {messages.length > 0 && (
                <button type="button" onClick={() => setMessages([])} class="ml-auto text-caption text-muted hover:text-primary transition-colors">Clear thread</button>
              )}
            </div>
            <div class="bg-bg-sunken border border-border rounded-xl p-3 min-h-[180px] max-h-[460px] overflow-y-auto space-y-3">
              {messages.length === 0 && (
                <div class="flex flex-col items-center justify-center text-center py-10 gap-2">
                  <span class="text-muted opacity-60"><BookIcon /></span>
                  <p class="text-body-sm text-muted">Ask a question and the model answers from <span class="text-secondary font-medium">{scopeName}</span>.</p>
                </div>
              )}
              {messages.map((m, i) => (
                <div key={i} class={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div class={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-body-sm ${m.role === 'user' ? 'bg-primary text-inverse rounded-br-md' : `bg-surface border border-border rounded-bl-md ${m.error ? 'text-danger' : 'text-primary'}`}`}>
                    {m.role === 'assistant' && !m.error
                      ? <div class="chat-md break-words" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }} />
                      : <pre class="whitespace-pre-wrap font-sans break-words">{m.text}</pre>}
                    {m.role === 'assistant' && !m.error && (
                      <div class="mt-2 pt-2 border-t border-border flex items-center justify-between gap-3">
                        <div class="min-w-0"><ContextDisclosure hits={m.hits ?? []} /></div>
                        <span class="text-caption text-muted font-mono shrink-0">{fmtCost(m.costUsd)}</span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
              {chatBusy && (
                <div class="flex justify-start">
                  <div class="rounded-2xl rounded-bl-md px-3.5 py-2.5 bg-surface border border-border">
                    <div class="flex gap-1">
                      <span class="w-2 h-2 bg-muted rounded-full animate-bounce" style="animation-delay:0ms" />
                      <span class="w-2 h-2 bg-muted rounded-full animate-bounce" style="animation-delay:150ms" />
                      <span class="w-2 h-2 bg-muted rounded-full animate-bounce" style="animation-delay:300ms" />
                    </div>
                  </div>
                </div>
              )}
              <div ref={threadEnd} />
            </div>
            <form onSubmit={(e) => { e.preventDefault(); sendChat(); }} class="flex gap-2">
              <input
                value={chatInput}
                onInput={(e) => setChatInput((e.target as HTMLInputElement).value)}
                placeholder="Ask the knowledge base…"
                disabled={chatBusy || !chatModel}
                class="flex-1 bg-bg-sunken border border-border rounded-xl px-4 py-2.5 text-body-sm focus:ring-2 focus:ring-primary/40 focus:border-primary outline-none placeholder:text-muted disabled:opacity-50 transition-colors"
              />
              <Button type="submit" loading={chatBusy} disabled={!chatInput.trim()}>Send</Button>
            </form>
          </div>
        )}
      </div>
    </div>
  );
}
