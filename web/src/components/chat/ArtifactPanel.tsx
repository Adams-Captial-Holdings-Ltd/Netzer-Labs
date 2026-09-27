import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import DOMPurify from 'dompurify';
import { Copy, Download, X } from 'lucide-preact';
import { api, getBytes } from '../../lib/api';
import { buildMermaidDocument, buildSandboxDocument, parseCsv, previewKind } from '../../lib/chat/artifacts';
import type { PreviewKind } from '../../lib/chat/artifacts';
import { renderMarkdown } from '../../lib/chat/markdown';
import type { ArtifactRef } from '../../lib/chat/types';
import { toast } from '../Toast';
import { downloadArtifact } from './ArtifactCard';

interface ArtifactPanelProps {
  agentId: string;
  chatId: string;
  artifact: ArtifactRef;
  onClose: () => void;
}

interface Preview {
  kind: PreviewKind;
  text?: string;
  url?: string;
  slides?: Array<{ index: number; text: string }>;
}

const FALLBACK = 'No preview available — download the file to open it.';

function base64(bytes: Uint8Array): string {
  let raw = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(raw);
}

export function ArtifactPanel({ agentId, chatId, artifact, onClose }: ArtifactPanelProps) {
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 1023px)').matches);
  const [versions, setVersions] = useState<ArtifactRef[]>([artifact]);
  const [version, setVersion] = useState(artifact.version);
  const [preview, setPreview] = useState<Preview | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const frameLoads = useRef(0);
  const sectionRef = useRef<HTMLElement>(null);
  const selected = versions.find((item) => item.version === version) ?? { ...artifact, version };
  const declaredKind = previewKind(selected.contentType);
  const textKind = ['svg', 'html', 'markdown', 'code', 'csv', 'mermaid'].includes(declaredKind);
  const query = `agentId=${encodeURIComponent(agentId)}&chatId=${encodeURIComponent(chatId)}` +
    `&artifactId=${encodeURIComponent(artifact.artifactId)}`;
  const derived = useMemo(() => {
    if (!preview) return { markdownHtml: undefined, csv: undefined, srcdoc: undefined };
    const markdownHtml = preview.kind === 'markdown' ? DOMPurify.sanitize(renderMarkdown(preview.text ?? ''), {
      USE_PROFILES: { html: true },
      FORBID_TAGS: ['img', 'video', 'audio', 'source', 'picture', 'track', 'iframe', 'object', 'embed', 'link', 'style',
        'form', 'input', 'button', 'textarea', 'select', 'option', 'optgroup', 'fieldset', 'legend', 'label', 'datalist', 'output'],
      FORBID_ATTR: ['srcset', 'poster', 'background', 'style', 'popover', 'popovertarget', 'popovertargetaction'],
    }) : undefined;
    const csv = preview.kind === 'csv' ? parseCsv(preview.text ?? '', 500) : undefined;
    const srcdoc = preview.kind === 'html' || preview.kind === 'mermaid'
      ? buildSandboxDocument(preview.kind === 'mermaid' ? buildMermaidDocument(preview.text ?? '') : preview.text ?? '')
      : undefined;
    return { markdownHtml, csv, srcdoc };
  }, [preview]);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 1023px)');
    const update = () => setMobile(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);

  // A layout effect: the listener exists as soon as the panel does, so an Escape pressed before paint is not lost.
  useLayoutEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.isComposing && event.keyCode !== 229) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  useLayoutEffect(() => { closeRef.current?.focus(); }, [artifact.artifactId, artifact.version]);

  useEffect(() => {
    let active = true;
    void api.get<{ versions: ArtifactRef[] }>(`/artifacts/versions?${query}`)
      .then((result) => { if (active) setVersions([...result.versions].sort((a, b) => a.version - b.version)); })
      .catch(() => { /* The opened version remains usable if the list fails. */ });
    return () => { active = false; };
  }, [agentId, chatId, artifact.artifactId, artifact.version]);

  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    frameLoads.current = 0;
    setPreview(null);
    const path = `/artifacts/content?${query}&version=${version}`;
    if (declaredKind === 'fallback') {
      setPreview({ kind: 'fallback' });
    } else if (declaredKind === 'outline') {
      void api.get<{ slides: Array<{ index: number; text: string }> }>(`${path}&view=outline`)
        .then((result) => { if (active) setPreview({ kind: 'outline', slides: result.slides }); })
        .catch(() => { if (active) setPreview({ kind: 'fallback' }); });
    } else {
      void getBytes(path).then((buffer) => {
        if (!active) return;
        const bytes = new Uint8Array(buffer);
        const kind = previewKind(selected.contentType, bytes);
        if (kind === 'image' || kind === 'pdf') {
          objectUrl = URL.createObjectURL(new Blob([bytes], {
            type: kind === 'pdf' ? 'application/pdf' : selected.contentType,
          }));
          setPreview({ kind, url: objectUrl });
        } else if (kind === 'svg') {
          setPreview({ kind, url: `data:image/svg+xml;base64,${base64(bytes)}`, text: new TextDecoder().decode(bytes) });
        } else {
          setPreview({ kind, text: new TextDecoder().decode(bytes) });
        }
      }).catch(() => { if (active) setPreview({ kind: 'fallback' }); });
    }
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [agentId, chatId, artifact.artifactId, version, selected.contentType]);

  async function copySource() {
    if (preview?.text === undefined) return;
    try {
      await navigator.clipboard.writeText(preview.text);
      toast('Copied', 'success');
    } catch {
      toast('Could not copy that file. Please try again.', 'error');
    }
  }

  function onFrameLoad() {
    frameLoads.current++;
    if (frameLoads.current > 1) setPreview({ kind: 'fallback' });
  }

  function focusPanelEdge(edge: 'first' | 'last') {
    const selector = 'a[href], button:not([disabled]), select, textarea, input, iframe, [tabindex]:not([tabindex="-1"])';
    const elements = [...(sectionRef.current?.querySelectorAll<HTMLElement>(selector) ?? [])]
      .filter((element) => !element.hasAttribute('data-artifact-focus-sentinel'));
    (edge === 'first' ? elements[0] : elements[elements.length - 1])?.focus();
  }

  return (
    <section ref={sectionRef} data-artifact-panel aria-label={`Artifact: ${artifact.fileName}`}
      role={mobile ? 'dialog' : undefined} aria-modal={mobile ? 'true' : undefined}
      class="fixed inset-0 z-50 flex min-h-0 flex-col bg-bg lg:static lg:z-auto lg:w-[min(560px,45vw)] lg:shrink-0 lg:border-l lg:border-border">
      {mobile && <span tabIndex={0} aria-hidden="true" data-artifact-focus-sentinel class="sr-only"
        onFocus={() => focusPanelEdge('last')} />}
      <div class="flex flex-nowrap items-center gap-2 border-b border-border bg-surface px-4 py-3">
        <h2 class="min-w-0 flex-1 truncate text-body font-semibold text-primary">{artifact.fileName}</h2>
        {versions.length > 1 && <select aria-label="Version" value={version}
          onChange={(event) => setVersion(Number(event.currentTarget.value))}
          class="rounded-lg border border-border bg-surface px-2 py-1 text-caption text-primary">
          {versions.map((item) => <option key={item.version} value={item.version}>Version {item.version}</option>)}
        </select>}
        {textKind && (
          <button type="button" aria-label="Copy source" title="Copy source" onClick={() => { void copySource(); }}
            class="flex size-9 shrink-0 items-center justify-center rounded-lg text-secondary hover:bg-surface-hover hover:text-primary">
            <Copy aria-hidden="true" class="size-4" />
          </button>
        )}
        <button type="button" aria-label={`Download ${artifact.fileName}`} title={`Download ${artifact.fileName}`}
          onClick={() => { void downloadArtifact(selected, agentId, chatId); }}
          class="flex size-9 shrink-0 items-center justify-center rounded-lg text-secondary hover:bg-surface-hover hover:text-primary">
          <Download aria-hidden="true" class="size-4" />
        </button>
        <button ref={closeRef} type="button" aria-label="Close artifact" title="Close artifact" onClick={onClose}
          class="flex size-9 shrink-0 items-center justify-center rounded-lg text-secondary hover:bg-surface-hover hover:text-primary">
          <X aria-hidden="true" class="size-4" />
        </button>
      </div>
      <div data-artifact-preview data-kind={preview?.kind}
        class="min-h-0 flex-1 overflow-auto p-4 text-body-sm text-primary">
        {!preview ? <p>Loading preview…</p> :
          preview.kind === 'fallback' ? <p>{FALLBACK}</p> :
          preview.kind === 'outline' ? <ol class="list-decimal space-y-2 pl-5">{preview.slides?.map((slide) =>
            <li key={slide.index}>{slide.text}</li>)}</ol> :
          preview.kind === 'html' || preview.kind === 'mermaid' ? (
            <iframe title="Artifact preview" sandbox="allow-scripts" referrerPolicy="no-referrer"
              srcdoc={derived.srcdoc}
              onLoad={onFrameLoad} class="h-full min-h-64 w-full border-0 bg-white" />
          ) : preview.kind === 'svg' || preview.kind === 'image' ? (
            <img alt={artifact.fileName} src={preview.url} class="max-h-full max-w-full" />
          ) : preview.kind === 'pdf' ? (
            <iframe title="PDF preview" src={preview.url} class="h-full w-full border-0 bg-white" />
          ) : preview.kind === 'markdown' ? (
            <div class="chat-md" dangerouslySetInnerHTML={{ __html: derived.markdownHtml ?? '' }} />
          ) : preview.kind === 'code' ? (
            <pre class="whitespace-pre-wrap break-words"><code>{preview.text}</code></pre>
          ) : preview.kind === 'csv' ? (() => {
            const csv = derived.csv ?? { rows: [], truncated: false };
            return <><table class="w-full border-collapse text-left">
              <thead><tr>{csv.rows[0]?.map((cell, i) => <th key={i} class="border-b border-border p-2">{cell}</th>)}</tr></thead>
              <tbody>{csv.rows.slice(1).map((row, i) => <tr key={i}>{row.map((cell, j) =>
                <td key={j} class="border-b border-border p-2">{cell}</td>)}</tr>)}</tbody>
            </table>{csv.truncated && <p class="mt-2 text-caption text-secondary">Showing part of this file — download it to see all of it.</p>}</>;
          })() : null}
      </div>
      {mobile && <span tabIndex={0} aria-hidden="true" data-artifact-focus-sentinel class="sr-only"
        onFocus={() => focusPanelEdge('first')} />}
    </section>
  );
}
