// Markdown rendering, moved verbatim from web/src/pages/Chat.tsx (Phase 0 of
// the chat UI port — zero behavior change; syntax highlighting is a later
// phase). Not imported by any test under src/ — it needs marked/DOMPurify and
// stays out of the root tsc program.

import { marked } from 'marked';
import DOMPurify from 'dompurify';

// Render assistant markdown to sanitized HTML. marked emits <strong>, <em>,
// <pre><code> (monospaced via prose styling below); DOMPurify strips anything
// unsafe so dangerouslySetInnerHTML can't inject script. Synchronous parse
// (async:false) keeps the return type a plain string.
export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false, gfm: true, breaks: true });
  return DOMPurify.sanitize(html);
}
