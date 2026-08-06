import { useState, useEffect } from 'preact/hooks';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { getToken, getDashboardUser } from '../lib/api';
import { Button } from '../components/Button';

// Mirrors PlaygroundModel from src/lib/bedrock/playground-catalog.ts.
interface Model {
  id: string;
  provider: string;
  name: string;
  inputPricePer1M?: number;
  outputPricePer1M?: number;
}

// Per-model result column. One prompt fans out to many models; each resolves
// (or fails) on its own, so every model carries its own status.
interface RunResult {
  status: 'loading' | 'done' | 'error';
  text?: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number | null;
  latencyMs?: number;
  error?: string;
}

// Render assistant markdown to sanitized HTML (same approach as Chat.tsx).
function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false, gfm: true, breaks: true });
  return DOMPurify.sanitize(html);
}

function fmtCost(c: number | null | undefined): string {
  if (c === null || c === undefined) return '—';
  if (c === 0) return '$0';
  return c < 0.01 ? `$${c.toFixed(5)}` : `$${c.toFixed(4)}`;
}

// Models we tick by default — a fast Claude plus two non-Anthropic contrasts —
// so the page is useful the moment it loads. Falls back gracefully when a id
// isn't in this deploy's catalog.
const DEFAULT_PICKS = ['openai.gpt-oss-120b-1:0', 'deepseek.v3.2'];

export function Playground() {
  const [models, setModels] = useState<Model[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [prompt, setPrompt] = useState('');
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<Record<string, RunResult>>({});
  // null = loading, '' = loaded fine, anything else = catalog fetch failed and
  // the picker would otherwise render blank with no explanation.
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [catalogReload, setCatalogReload] = useState(0);

  useEffect(() => {
    setCatalogError(null);
    fetch('/api/playground/models', { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((d: { models: Model[] }) => {
        const list = d.models ?? [];
        setModels(list);
        setCatalogError('');
        // Pre-select the first Claude (the default model) + the contrast picks.
        const pick = new Set<string>();
        const firstClaude = list.find((m) => m.provider === 'Anthropic');
        if (firstClaude) pick.add(firstClaude.id);
        for (const id of DEFAULT_PICKS) {
          if (list.some((m) => m.id === id)) pick.add(id);
        }
        if (pick.size === 0 && list[0]) pick.add(list[0].id);
        setSelected(pick);
      })
      .catch((e: Error) => {
        setCatalogError(e?.message || 'failed');
      });
  }, [catalogReload]);

  function authHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${getToken()}`,
      'Content-Type': 'application/json',
    };
    const who = getDashboardUser();
    if (who) h['X-Dashboard-User'] = who;
    return h;
  }

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selectedModels = models.filter((m) => selected.has(m.id));

  async function runOne(modelId: string) {
    setResults((prev) => ({ ...prev, [modelId]: { status: 'loading' } }));
    try {
      const res = await fetch('/api/playground/run', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ prompt: prompt.trim(), modelId }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data) {
        const reason = data?.reason || data?.error || `HTTP ${res.status}`;
        setResults((prev) => ({ ...prev, [modelId]: { status: 'error', error: String(reason) } }));
        return;
      }
      if (data.ok === false) {
        setResults((prev) => ({
          ...prev,
          [modelId]: { status: 'error', error: `${data.error}: ${data.detail ?? ''}`.trim() },
        }));
        return;
      }
      setResults((prev) => ({
        ...prev,
        [modelId]: {
          status: 'done',
          text: data.text ?? '',
          inputTokens: data.inputTokens,
          outputTokens: data.outputTokens,
          costUsd: data.costUsd,
          latencyMs: data.latencyMs,
        },
      }));
    } catch {
      setResults((prev) => ({ ...prev, [modelId]: { status: 'error', error: 'Request failed' } }));
    }
  }

  async function run() {
    const text = prompt.trim();
    if (!text || running || selected.size === 0) return;
    setRunning(true);
    // Kick every selected model off at once; each column updates as it returns.
    await Promise.all([...selected].map((id) => runOne(id)));
    setRunning(false);
  }

  // Providers in first-seen order, for grouping the picker.
  const providers: string[] = [];
  for (const m of models) if (!providers.includes(m.provider)) providers.push(m.provider);

  return (
    <div class="space-y-5">
      <div data-tour="playground-title">
        <h1 class="text-display-sm text-primary font-bold">Model Playground</h1>
        <p class="text-body-sm text-muted mt-1">
          Send one prompt to several Bedrock models at once and compare the answers side by side.
          Raw model calls — no agent tools, memory, or knowledge. Token counts show for every model;
          cost shows where we have a verified price.
        </p>
      </div>

      <textarea
        data-tour="playground-prompt"
        value={prompt}
        onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)}
        placeholder="Ask all selected models the same thing… e.g. 'Explain a Bloom filter in three sentences.'"
        rows={4}
        class="w-full bg-surface border border-border rounded-xl px-4 py-3 text-body-sm
          focus:ring-2 focus:ring-primary/50 focus:border-primary outline-none
          placeholder:text-muted transition-colors resize-y"
      />

      <div class="bg-bg-sunken border border-border rounded-xl p-4" data-tour="playground-model-picker">
        <div class="flex items-center justify-between mb-3">
          <span class="text-caption text-muted uppercase tracking-wider">
            Models · {selected.size} selected
          </span>
          <div class="flex gap-3">
            <button
              type="button"
              class="text-caption text-muted hover:text-primary transition-colors"
              onClick={() => setSelected(new Set(models.map((m) => m.id)))}
            >
              Select all
            </button>
            <button
              type="button"
              class="text-caption text-muted hover:text-primary transition-colors"
              onClick={() => setSelected(new Set())}
            >
              Clear
            </button>
          </div>
        </div>
        {catalogError === null && models.length === 0 && (
          <p class="text-body-sm text-muted py-2">Loading the model list…</p>
        )}
        {!!catalogError && models.length === 0 && (
          <div class="py-2">
            <p class="text-body-sm text-danger">
              Couldn't load the model list ({catalogError}). Check your connection, then retry.
            </p>
            <button
              type="button"
              class="text-caption text-primary hover:underline mt-1"
              onClick={() => setCatalogReload((n) => n + 1)}
            >
              Retry
            </button>
          </div>
        )}
        <div class="space-y-3">
          {providers.map((p) => (
            <div key={p} class="flex flex-wrap items-center gap-2">
              <span class="text-caption text-muted w-20 shrink-0">{p}</span>
              {models.filter((m) => m.provider === p).map((m) => {
                const on = selected.has(m.id);
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => toggle(m.id)}
                    class={`text-caption rounded-full px-3 py-1 border transition-colors
                      ${on
                        ? 'bg-primary/15 border-primary/40 text-primary font-medium'
                        : 'bg-surface border-border text-secondary hover:border-border-strong hover:text-primary'}`}
                  >
                    {m.name}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <div class="flex items-center gap-3" data-tour="playground-run-button">
        <Button onClick={run} loading={running} disabled={!prompt.trim() || selected.size === 0}>
          {running ? 'Running…' : `Run on ${selected.size} model${selected.size === 1 ? '' : 's'}`}
        </Button>
        <span class="text-caption text-muted">Each model answers independently and bills separately.</span>
      </div>

      {selectedModels.length > 0 && Object.keys(results).length > 0 && (
        <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4" data-tour="playground-results">
          {selectedModels.map((m) => {
            const r = results[m.id];
            if (!r) return null;
            return (
              <div key={m.id} class="bg-surface border border-border rounded-xl flex flex-col overflow-hidden">
                <div class="flex items-center justify-between px-4 py-2.5 border-b border-border">
                  <span class="text-body-sm font-medium text-primary truncate">{m.name}</span>
                  <span class="text-overline text-muted uppercase tracking-wider shrink-0 ml-2">{m.provider}</span>
                </div>
                <div class="p-4 flex-1 min-h-[120px]">
                  {r.status === 'loading' && (
                    <div class="flex gap-1 items-center text-muted">
                      <span class="w-2 h-2 bg-muted rounded-full animate-bounce" style="animation-delay: 0ms" />
                      <span class="w-2 h-2 bg-muted rounded-full animate-bounce" style="animation-delay: 150ms" />
                      <span class="w-2 h-2 bg-muted rounded-full animate-bounce" style="animation-delay: 300ms" />
                    </div>
                  )}
                  {r.status === 'error' && (
                    <p class="text-body-sm text-danger break-words">{r.error}</p>
                  )}
                  {r.status === 'done' && (
                    r.text?.trim()
                      ? <div
                          class="chat-md break-words text-primary text-body-sm"
                          dangerouslySetInnerHTML={{ __html: renderMarkdown(r.text) }}
                        />
                      : <p class="text-body-sm text-muted italic">
                          No text returned — a reasoning model may have used its token budget before answering.
                        </p>
                  )}
                </div>
                {r.status === 'done' && (
                  <div class="px-4 py-2 border-t border-border flex items-center justify-between text-caption text-muted">
                    <span>{r.inputTokens} in · {r.outputTokens} out</span>
                    <span class="flex items-center gap-3">
                      <span>{r.latencyMs != null ? `${(r.latencyMs / 1000).toFixed(1)}s` : ''}</span>
                      <span class="font-mono text-secondary">{fmtCost(r.costUsd)}</span>
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
