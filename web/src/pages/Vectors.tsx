import { useState, useEffect, useRef } from 'preact/hooks';
import { api, clearApiCache, getToken } from '../lib/api';
import { hasCapability } from '../lib/auth';
import { Button } from '../components/Button';
import { Select } from '../components/Select';
import { SkeletonTableRow } from '../components/Skeleton';
import { EmptyState } from '../components/EmptyState';
import { EmptyBook } from '../components/Icons';
import { ConfirmDialog } from '../components/Modal';
import { toast } from '../components/Toast';
import { KnowledgeModelTest } from '../components/KnowledgeModelTest';
import { InfoTooltip } from '../components/InfoTooltip';

// Mirrors the GET /vectors `docs[]` shape (Doc in src/lib/vectors/store.ts).
interface Doc { docId: string; title?: string; source?: string; chunkCount?: number; createdAt?: string }
interface AgentScope { id: string; displayName: string }
interface Hit { score: number; text: string; docId: string; docTitle: string | null; source: string | null; chunkIndex: number; page?: number | null }

type UploadFormat = 'pdf' | 'docx' | 'pptx' | 'audio' | 'markdown' | 'html' | 'text';

// Audio extensions Amazon Transcribe can handle (kept in sync with the
// backend's detectFormat / transcriber FORMAT_MAP).
const AUDIO_EXTS = ['.mp3', '.m4a', '.wav', '.ogg', '.oga', '.flac', '.webm', '.mp4'];
// Everything the pipeline can ingest. Used for both the <input accept> and the
// client-side guard so an unsupported drop fails loudly instead of silently
// being treated as plain text (which produced garbage chunks).
const ACCEPTED_EXTS = ['.pdf', '.docx', '.pptx', '.txt', '.md', '.markdown', '.html', '.htm', ...AUDIO_EXTS];
// Max upload size. Binary docs are base64'd into the task's memory, so cap well
// under the Fargate task memory; mirrors MAX_DOC_BYTES in the ingest handler.
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

function formatForFile(name: string): UploadFormat {
  const lower = name.toLowerCase();
  if (lower.endsWith('.pdf')) return 'pdf';
  if (lower.endsWith('.docx')) return 'docx';
  if (lower.endsWith('.pptx')) return 'pptx';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html';
  if (AUDIO_EXTS.some((ext) => lower.endsWith(ext))) return 'audio';
  return 'text';
}

function isAcceptedFile(name: string): boolean {
  const lower = name.toLowerCase();
  return ACCEPTED_EXTS.some((ext) => lower.endsWith(ext));
}

// ── The transparent ingest pipeline ─────────────────────────────────
type Stage = 'read' | 'upload' | 'transcribe' | 'extract' | 'chunk' | 'embed' | 'index' | 'done' | 'error';
interface Job {
  id: string;
  name: string;
  stage: Stage;
  chunks?: number;
  /** Chunks that failed to embed and were NOT indexed (partial ingest). */
  failed?: number;
  embedDone?: number;
  embedTotal?: number;
  error?: string;
  /** Kept so a failed upload can be retried without re-picking the file. */
  file?: File;
}

// Visible steps in the stepper (upload folds into "Read").
const STEPS: { label: string; icon: string }[] = [
  { label: 'Upload', icon: '📤' },
  { label: 'Extract', icon: '🔍' },
  { label: 'Chunk', icon: '✂️' },
  { label: 'Embed', icon: '🧠' },
  { label: 'Index', icon: '🗂️' },
  { label: 'Done', icon: '✨' },
];
function visibleIndex(stage: Stage): number {
  switch (stage) {
    case 'read': case 'upload': return 0;
    // Transcription is the audio equivalent of text extraction — same column.
    case 'transcribe': case 'extract': return 1;
    case 'chunk': return 2;
    case 'embed': return 3;
    case 'index': return 4;
    case 'done': return 5;
    default: return 0;
  }
}
function progressPct(j: Job): number {
  switch (j.stage) {
    case 'read': return 6;
    case 'upload': return 14;
    case 'transcribe': return 20;
    case 'extract': return 26;
    case 'chunk': return 40;
    case 'embed': return j.embedTotal ? 40 + Math.round(52 * (j.embedDone ?? 0) / j.embedTotal) : 46;
    case 'index': return 96;
    case 'done': return 100;
    case 'error': return 100;
    default: return 0;
  }
}
function caption(j: Job): string {
  switch (j.stage) {
    case 'read': return 'Reading file…';
    case 'upload': return 'Uploading…';
    case 'transcribe': return 'Transcribing audio…';
    case 'extract': return 'Extracting text…';
    case 'chunk': return `Split into ${j.chunks ?? 0} chunks`;
    case 'embed': return `Embedding ${j.embedDone ?? 0}/${j.embedTotal ?? '…'} chunks…`;
    case 'index': return 'Indexing vectors…';
    case 'done':
      return j.failed
        ? `Indexed ${j.chunks ?? 0} chunks · ${j.failed} failed (not searchable)`
        : `Indexed ${j.chunks ?? 0} chunks`;
    case 'error': return j.error ?? 'Failed';
    default: return '';
  }
}

function PipelineCard({ job, onDismiss, onRetry }: { job: Job; onDismiss: () => void; onRetry: () => void }) {
  const cvi = visibleIndex(job.stage);
  const isError = job.stage === 'error';
  const isDone = job.stage === 'done';
  // A done ingest with dropped chunks is a partial success — warn, don't claim
  // a clean green finish.
  const isPartial = isDone && (job.failed ?? 0) > 0;
  return (
    <div class={`rounded-xl border p-4 transition-colors page-enter
      ${isError ? 'border-danger/40 bg-danger/5' : isPartial ? 'border-warning/40 bg-warning/5' : isDone ? 'border-success/40 bg-success/5' : 'border-border bg-surface'}`}>
      <div class="flex items-center justify-between gap-3 mb-3">
        <span class="text-body-sm font-medium text-primary truncate">{job.name}</span>
        <div class="flex items-center gap-2 shrink-0">
          <span class={`text-caption font-medium ${isError ? 'text-danger' : isPartial ? 'text-warning' : isDone ? 'text-success' : 'text-secondary'}`}>{caption(job)}</span>
          {isError && job.file && (
            <button onClick={onRetry} class="text-caption font-medium text-primary hover:underline" aria-label="Retry upload">Retry</button>
          )}
          {(isDone || isError) && (
            <button onClick={onDismiss} class="text-muted hover:text-primary text-caption" aria-label="Dismiss">✕</button>
          )}
        </div>
      </div>

      {/* Stage stepper */}
      <div class="flex items-center gap-1.5 mb-3">
        {STEPS.map((s, i) => {
          const state = isError ? (i === cvi ? 'error' : i < cvi ? 'done' : 'pending')
            : isDone ? 'done'
            : i < cvi ? 'done' : i === cvi ? 'active' : 'pending';
          return (
            <div key={s.label} class="flex items-center gap-1.5 flex-1 last:flex-none">
              <div
                class={`flex items-center gap-1 px-2 py-1 rounded-lg text-caption font-medium whitespace-nowrap transition-colors
                  ${state === 'done' ? 'bg-success/10 text-success'
                    : state === 'active' ? 'bg-primary/10 text-primary animate-pulse'
                    : state === 'error' ? 'bg-danger/10 text-danger'
                    : 'bg-bg-elevated text-muted'}`}
              >
                <span aria-hidden="true">{state === 'done' ? '✓' : s.icon}</span>
                <span class="hidden sm:inline">{s.label}</span>
              </div>
              {i < STEPS.length - 1 && (
                <div class={`h-px flex-1 ${i < cvi || isDone ? 'bg-success/40' : 'bg-border'}`} />
              )}
            </div>
          );
        })}
      </div>

      {/* Progress bar */}
      <div class="h-2 rounded-full bg-bg-elevated overflow-hidden">
        <div
          class={`h-full rounded-full transition-all duration-normal
            ${isError ? 'bg-danger' : isDone ? 'bg-success' : 'bg-gradient-to-r from-claw-500 to-purple-600'}`}
          style={{ width: `${progressPct(job)}%` }}
        />
      </div>
    </div>
  );
}

export function Vectors() {
  const [docs, setDocs] = useState<Doc[]>([]);
  const [scope, setScope] = useState('default');
  const [agents, setAgents] = useState<AgentScope[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<Doc | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [filter, setFilter] = useState('');
  // Retrieval test
  const [query, setQuery] = useState('');
  const [testing, setTesting] = useState(false);
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function load() {
    setLoading(true);
    setLoadError(null);
    api.get<{ docs: Doc[] }>(`/vectors?scope=${encodeURIComponent(scope)}`)
      .then((d) => setDocs(d.docs ?? []))
      // Distinguish a failed load of an existing knowledge base from a genuinely
      // empty scope, so a 403/500 does not look like "brand-new, drop files here".
      .catch((e) => setLoadError(e instanceof Error ? e.message : 'Failed to load documents'))
      .finally(() => setLoading(false));
  }
  useEffect(() => { load(); }, [scope]);
  useEffect(() => {
    api.get<{ agents: AgentScope[] }>('/agents').then((d) => setAgents(d.agents ?? [])).catch(() => {});
  }, []);

  const scopeOptions = [
    { value: 'default', label: 'Default scope' },
    { value: 'shared', label: 'Shared (all agents)' },
    // Agent scopes are admin tier (NZR-5); the server refuses them to everyone else.
    ...(hasCapability('knowledge:private:read')
      ? agents.map((a) => ({ value: a.id, label: `${a.displayName} (${a.id})` }))
      : []),
  ];
  const scopeLabel = scopeOptions.find((o) => o.value === scope)?.label ?? scope;

  function patchJob(id: string, patch: Partial<Job>) {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...patch } : j)));
  }
  function dismissJob(id: string) {
    setJobs((prev) => prev.filter((j) => j.id !== id));
  }
  function retryJob(id: string) {
    const job = jobs.find((j) => j.id === id);
    if (!job?.file) return;
    dismissJob(id);
    void uploadOne(job.file);
  }

  async function uploadOne(file: File) {
    const id = `${file.name}-${Date.now()}-${Math.round(performance.now())}`;
    setJobs((prev) => [...prev, { id, name: file.name, stage: 'upload', file }]);
    // Guard up front so an unsupported type or oversized file fails with a clear
    // reason instead of silently becoming garbage chunks or erroring deep in S3.
    if (!isAcceptedFile(file.name)) {
      patchJob(id, { stage: 'error', error: `Unsupported file type. Accepted: ${ACCEPTED_EXTS.join(', ')}` });
      return;
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      patchJob(id, { stage: 'error', error: `File is ${(file.size / 1024 / 1024).toFixed(1)}MB, over the ${(MAX_UPLOAD_BYTES / 1024 / 1024).toFixed(0)}MB limit` });
      return;
    }
    try {
      const format = formatForFile(file.name);
      // 1) Get a presigned URL and PUT the file straight to S3, bypassing the
      //    CloudFront WAF's 8KB request-body cap (which blocks PDFs as base64).
      const { url, key } = await api.post<{ url: string; key: string }>('/vectors/upload-url', { filename: file.name });
      const put = await fetch(url, { method: 'PUT', body: file });
      if (!put.ok) throw new Error(`S3 upload failed (${put.status})`);

      // 2) Ask the backend to ingest from the uploaded key; stream the pipeline.
      const res = await fetch('/api/ingest/stream', {
        method: 'POST',
        headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ s3Key: key, docTitle: file.name, source: 'dashboard-upload', scope, format }),
      });
      if (!res.ok || !res.body) throw new Error(`Ingest failed (${res.status})`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;
      // How many chunks the terminal `done` event reported as failed (not
      // indexed). > 0 keeps the partial-ingest card pinned instead of auto-clearing.
      let finishedFailed = 0;
      while (!finished) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const dataLine = part.split('\n').find((l) => l.startsWith('data:'));
          if (!dataLine) continue;
          let ev: { stage: Stage; chunks?: number; failed?: number; done?: number; total?: number; detail?: string };
          try { ev = JSON.parse(dataLine.slice(5).trim()); } catch { continue; }
          if (ev.stage === 'embed') patchJob(id, { stage: 'embed', embedDone: ev.done, embedTotal: ev.total });
          else if (ev.stage === 'chunk') patchJob(id, { stage: 'chunk', chunks: ev.chunks });
          else if (ev.stage === 'index') patchJob(id, { stage: 'index', chunks: ev.chunks });
          else if (ev.stage === 'done') { patchJob(id, { stage: 'done', chunks: ev.chunks, failed: ev.failed }); finishedFailed = ev.failed ?? 0; finished = true; }
          else if (ev.stage === 'error') { patchJob(id, { stage: 'error', error: ev.detail }); finished = true; }
          else patchJob(id, { stage: ev.stage });
        }
      }
      // Refresh the doc list (the stream POST bypasses the api cache, so bust it).
      clearApiCache();
      load();
      // Auto-clear a clean success card after a beat. A PARTIAL ingest (some
      // chunks failed to embed and were not indexed) stays pinned so the user
      // notices and can re-run; it is not silently dismissed.
      if (finishedFailed === 0) setTimeout(() => dismissJob(id), 4500);
    } catch (err) {
      patchJob(id, { stage: 'error', error: err instanceof Error ? err.message : 'Upload failed' });
    }
  }

  function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    Array.from(files).forEach((f) => void uploadOne(f));
  }

  async function runTest() {
    if (!query.trim()) return;
    setTesting(true);
    setHits(null);
    try {
      const r = await api.post<{ hits: Hit[] }>('/vectors/search', { query: query.trim(), scope, topK: 5 });
      setHits(r.hits ?? []);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Search failed', 'error');
    }
    setTesting(false);
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await api.del(`/vectors/${scope}/${deleteTarget.docId}`);
      toast('Document removed', 'success');
      load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Delete failed', 'error');
    }
    setDeleting(false);
    setDeleteTarget(null);
  }

  const totalChunks = docs.reduce((sum, d) => sum + (d.chunkCount ?? 0), 0);
  const filtered = docs.filter((d) => {
    if (!filter) return true;
    const q = filter.toLowerCase();
    return (d.title ?? d.docId).toLowerCase().includes(q) || (d.source ?? '').toLowerCase().includes(q);
  });

  return (
    <div>
      <div class="flex items-start justify-between gap-4 mb-6 flex-wrap">
        <div>
          <h1 data-tour="knowledge-title" class="text-display-sm text-primary font-bold inline-flex items-center gap-1.5">
            Knowledge Base
            <InfoTooltip term="rag" />
          </h1>
          <p class="text-body-sm text-secondary mt-1 inline-flex items-center gap-1">
            <span>
              {loading ? 'Documents for RAG retrieval'
                : `${docs.length} document${docs.length === 1 ? '' : 's'} · ${totalChunks} chunk${totalChunks === 1 ? '' : 's'} in ${scopeLabel}`}
            </span>
            {!loading && <InfoTooltip term="chunks" />}
          </p>
        </div>
        <div class="flex items-end gap-3">
          <div data-tour="knowledge-scope" class="flex flex-col">
            <label class="text-overline text-muted uppercase tracking-wider font-semibold mb-1 inline-flex items-center gap-1">
              Knowledge scope
              <InfoTooltip term="scope" />
            </label>
            <Select value={scope} onChange={setScope} options={scopeOptions} />
          </div>
        </div>
      </div>

      {/* Drag-and-drop upload zone */}
      <div
        data-tour="knowledge-upload"
        onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
        onDragEnter={(e) => { e.preventDefault(); setDragActive(true); }}
        onDragLeave={(e) => { e.preventDefault(); setDragActive(false); }}
        onDrop={(e) => { e.preventDefault(); setDragActive(false); handleFiles((e as DragEvent).dataTransfer?.files ?? null); }}
        class={`rounded-xl border-2 border-dashed p-6 mb-3 text-center transition-colors
          ${dragActive ? 'border-primary bg-primary/5' : 'border-border bg-surface'}`}
      >
        <p class="text-body-sm text-secondary">
          Drag &amp; drop files here, or{' '}
          <button class="text-primary font-medium hover:underline" onClick={() => fileInputRef.current?.click()}>browse</button>
          {' '}then uploading to <span class="font-medium text-primary">{scopeLabel}</span>
        </p>
        <p class="text-caption text-muted mt-1">.pdf, .docx, .pptx, .txt, .md, .html, audio (.mp3/.m4a/.wav…) · up to 50MB · agents search their own scope plus Shared</p>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          class="hidden"
          accept={ACCEPTED_EXTS.join(',')}
          onChange={(e) => { handleFiles((e.target as HTMLInputElement).files); (e.target as HTMLInputElement).value = ''; }}
        />
      </div>

      {/* Live pipeline cards */}
      {jobs.length > 0 && (
        <div class="space-y-2 mb-6">
          {jobs.map((j) => <PipelineCard key={j.id} job={j} onDismiss={() => dismissJob(j.id)} onRetry={() => retryJob(j.id)} />)}
        </div>
      )}

      {/* Retrieval test panel */}
      <div data-tour="knowledge-test" class="bg-surface border border-border rounded-xl p-5 mb-6">
        <h2 class="text-heading-sm font-semibold text-primary mb-1 inline-flex items-center gap-1.5">
          Test retrieval
          <InfoTooltip term="cosine" />
        </h2>
        <p class="text-caption text-muted mb-3">Ask a question to see exactly what your agents would pull from <span class="font-medium">{scopeLabel}</span>. Each match shows a similarity score.</p>
        <form class="flex gap-2" onSubmit={(e) => { e.preventDefault(); runTest(); }}>
          <input
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            placeholder="e.g. what is our refund policy?"
            class="flex-1 bg-bg-elevated border border-border rounded-lg px-3 py-2 text-body-sm text-primary placeholder:text-muted outline-none focus:ring-2 focus:ring-primary/50"
          />
          <Button type="submit" loading={testing} disabled={!query.trim()}>Test</Button>
        </form>
        {hits !== null && (
          <div class="mt-4 space-y-2">
            {hits.length === 0 ? (
              <p class="text-body-sm text-muted">No matches in this scope. Try uploading a relevant document or switching scope.</p>
            ) : hits.map((h, i) => (
              <div key={i} class="border border-border rounded-lg p-3 bg-bg-elevated">
                <div class="flex items-center justify-between gap-2 mb-1.5">
                  <span class="text-caption font-medium text-primary truncate">{h.docTitle ?? h.docId} · {h.page ? `p.${h.page} · ` : ''}chunk {h.chunkIndex}</span>
                  <span class="text-caption font-mono text-secondary shrink-0">{(h.score * 100).toFixed(1)}%</span>
                </div>
                <div class="h-1.5 rounded-full bg-border overflow-hidden mb-2">
                  <div class="h-full rounded-full bg-gradient-to-r from-claw-500 to-purple-600" style={{ width: `${Math.max(2, Math.min(100, h.score * 100))}%` }} />
                </div>
                <p class="text-caption text-secondary line-clamp-3">{h.text}</p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Grounded model test — chat / compare models using this scope's knowledge */}
      <div data-tour="knowledge-model-test" class="mb-6">
        <KnowledgeModelTest scope={scope} />
      </div>

      {/* Document list */}
      {!loading && loadError ? (
        <div data-tour="knowledge-docs" class="bg-surface border border-border rounded-xl p-8">
          <EmptyState icon={<EmptyBook />} title="Couldn't load documents" description={loadError} action={<Button variant="secondary" size="sm" onClick={load}>Retry</Button>} />
        </div>
      ) : !loading && docs.length === 0 ? (
        <div data-tour="knowledge-docs" class="bg-surface border border-border rounded-xl p-8 border-dashed">
          <EmptyState icon={<EmptyBook />} title="No documents" description="Drop .pdf, .docx, .pptx, .txt, .md, .html, or audio files above to build this scope's knowledge base." />
        </div>
      ) : (
        <div data-tour="knowledge-docs" class="bg-surface border border-border rounded-xl overflow-hidden">
          <div class="px-4 py-3 border-b border-border">
            <input
              value={filter}
              onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
              placeholder="Filter documents…"
              class="w-full bg-bg-elevated border border-border rounded-lg px-3 py-1.5 text-body-sm text-primary placeholder:text-muted outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
          <div class="overflow-x-auto"><table class="w-full text-left">
            <thead>
              <tr class="border-b border-border bg-surface-elevated">
                <th class="px-4 py-3 text-overline text-muted uppercase tracking-wider font-semibold">Title</th>
                <th class="px-4 py-3 text-overline text-muted uppercase tracking-wider font-semibold">Source</th>
                <th class="px-4 py-3 text-overline text-muted uppercase tracking-wider font-semibold">Chunks</th>
                <th class="px-4 py-3 text-overline text-muted uppercase tracking-wider font-semibold">Created</th>
                <th class="px-4 py-3 text-overline text-muted uppercase tracking-wider font-semibold"></th>
              </tr>
            </thead>
            <tbody class="divide-y divide-border">
              {loading
                ? Array.from({ length: 3 }).map((_, i) => <SkeletonTableRow key={i} cols={5} />)
                : filtered.map((d) => (
                    <tr key={d.docId} class="hover:bg-surface-hover transition-colors">
                      <td class="px-4 py-3 text-body-sm font-medium text-primary">{d.title ?? d.docId}</td>
                      <td class="px-4 py-3 text-body-sm text-secondary">{d.source ?? '--'}</td>
                      <td class="px-4 py-3 text-body-sm text-secondary font-mono">{d.chunkCount ?? '--'}</td>
                      <td class="px-4 py-3 text-body-sm text-secondary">{d.createdAt ? new Date(d.createdAt).toLocaleDateString() : '--'}</td>
                      <td class="px-4 py-3">
                        <button onClick={() => setDeleteTarget(d)} class="text-caption text-danger hover:underline">Delete</button>
                      </td>
                    </tr>
                  ))}
              {!loading && filtered.length === 0 && (
                <tr><td colSpan={5} class="px-4 py-6 text-center text-body-sm text-muted">No documents match "{filter}".</td></tr>
              )}
            </tbody>
          </table></div>
        </div>
      )}

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete Document"
        message={`Remove "${deleteTarget?.title ?? deleteTarget?.docId}"? This will delete all chunks and embeddings.`}
        confirmLabel="Delete"
        danger
        loading={deleting}
      />
    </div>
  );
}
