// Code-block chrome for rendered chat markdown: a header strip carrying the
// language label, copy and download buttons, wrapped around the highlighted <pre>.
//
// Structure ported from danny-avila/LibreChat (MIT), pinned at commit
// 6d499ba3ce17f906a7762429c61018f230ecd64e —
//   client/src/components/Messages/Content/CodeBlock.tsx (rounded, hairline
//   bordered container; bar; scrolling body)
//   client/src/components/Messages/Content/CodeBar.tsx (lang label left,
//   actions right)
// Colours are this app's own tokens (see `.chat-md .chat-code*` in
// web/src/index.css); no donor palette is used and no donor runtime code is
// copied.
//
// NOTE: this module touches the DOM and pulls highlight.js, so it must never be
// imported by a test under src/ (that would drag it into the ROOT tsc program —
// see the note atop stream.ts). Only web/src/lib/chat/markdown.ts imports it,
// and only web/src/pages/Chat.tsx imports that, so highlight.js stays inside
// the lazy chat chunk.

import hljs from 'highlight.js/lib/common';
import { codeFileName } from './export';

/** Escape text destined for an HTML text node / attribute value. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Fence info strings can carry more than a language ("ts title=x"); highlight.js
// only knows the first word. An unknown or absent language degrades to plain
// escaped text — never a thrown error mid-render.
function resolveLanguage(lang: string | undefined): { id: string; label: string } {
  const first = (lang ?? '').trim().split(/\s+/)[0] ?? '';
  if (!first) return { id: '', label: 'code' };
  const known = hljs.getLanguage(first);
  // Cap the label so a pathological fence info string can't stretch the bar.
  const label = first.slice(0, 24);
  return { id: known ? first : '', label };
}

/**
 * Render one fenced code block as the full chrome + highlighted body.
 *
 * Returns raw HTML. The caller (renderMarkdown) runs DOMPurify over the whole
 * document afterwards — this string is NEVER injected on its own.
 */
export function codeBlockHtml(code: string, lang?: string): string {
  const { id, label } = resolveLanguage(lang);
  // hljs escapes its own output; the plain path escapes here. Either way the
  // code text can never re-enter the parser as markup.
  const body = id
    ? hljs.highlight(code, { language: id, ignoreIllegals: true }).value
    : escapeHtml(code);
  const codeClass = id ? `hljs language-${escapeHtml(id)}` : 'hljs';
  return (
    '<div class="chat-code">' +
    '<div class="chat-code__bar">' +
    `<span class="chat-code__lang">${escapeHtml(label)}</span>` +
    '<button type="button" class="chat-code__copy" aria-label="Copy code">' +
    '<svg class="chat-code__copy-icon" viewBox="0 0 24 24" width="13" height="13" ' +
    'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="9" y="9" width="12" height="12" rx="2"></rect>' +
    '<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>' +
    '</svg>' +
    '<span class="chat-code__copy-label" aria-live="polite">Copy</span>' +
    '</button>' +
    '<button type="button" class="chat-code__download" aria-label="Download code">Download</button>' +
    '</div>' +
    `<pre><code class="${codeClass}">${body}</code></pre>` +
    '</div>'
  );
}

const COPY_LABEL = 'Copy';
const COPIED_LABEL = 'Copied';
const COPY_FAILED_LABEL = 'Copy failed';
const FLASH_MS = 1600;

// Clipboard API needs a secure context; fall back to the selection trick so a
// plain-http preview still copies rather than silently doing nothing.
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path (permission denied, insecure origin).
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

function flash(button: HTMLElement, ok: boolean) {
  const label = button.querySelector<HTMLElement>('.chat-code__copy-label');
  if (label) label.textContent = ok ? COPIED_LABEL : COPY_FAILED_LABEL;
  button.dataset.copied = ok ? 'true' : 'false';
  window.setTimeout(() => {
    if (label) label.textContent = COPY_LABEL;
    delete button.dataset.copied;
  }, FLASH_MS);
}

let installed = false;

/**
 * Install the single delegated click handler for code block actions.
 *
 * The blocks are injected via dangerouslySetInnerHTML, so they cannot carry a
 * Preact handler and (correctly) lose inline `onclick` to DOMPurify. One
 * document-level listener covers every block, live and historical, for the life
 * of the page. Idempotent: safe to call from every mount.
 */
export function installChatCodeCopy(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('click', (ev) => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    const button = target.closest<HTMLElement>('.chat-md .chat-code__copy, .chat-md .chat-code__download');
    if (!button) return;
    const code = button.closest('.chat-code')?.querySelector('pre code');
    if (!code) return;
    if (button.classList.contains('chat-code__download')) {
      const language = button.closest('.chat-code')?.querySelector('.chat-code__lang')?.textContent ?? '';
      const url = URL.createObjectURL(new Blob([code.textContent ?? ''], { type: 'text/plain' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = codeFileName(language);
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } else void writeClipboard(code.textContent ?? '').then((ok) => flash(button, ok));
  });
}
