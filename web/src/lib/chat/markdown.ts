// Markdown rendering, moved verbatim from web/src/pages/Chat.tsx (Phase 0 of
// the chat UI port — zero behavior change). Not imported by any test under
// src/ — it needs marked/DOMPurify and stays out of the root tsc program.
//
// Phase 1 (CHATUI-001) adds fenced-code chrome + highlight.js. The table
// wrapper keeps wide replies inside their scrollport. Sanitation stays last.

import { Marked, type Tokens } from 'marked';
import DOMPurify from 'dompurify';
import { codeBlockHtml } from './code-block';

// A PRIVATE marked instance, not the shared `marked` singleton. WarRoom,
// Playground, AgentDetail and KnowledgeModelTest each call `marked.parse`
// directly; a global `marked.use()` here would re-render their code blocks too.
// The options are exactly the ones the old per-call parse passed, so every
// non-code construct renders byte-identically to before.
const md = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    // Only the fenced-code renderer is overridden: it emits the language bar +
    // copy button around a highlighted <pre>. Everything else is stock marked.
    code(token: Tokens.Code) {
      return codeBlockHtml(token.text, token.lang);
    },
  },
});

// Render assistant markdown to sanitized HTML. marked emits <strong>, <em>,
// <pre><code> (monospaced via prose styling below); DOMPurify strips anything
// unsafe so dangerouslySetInnerHTML can't inject script. Synchronous parse
// (async:false) keeps the return type a plain string.
//
// DOMPurify stays STRICTLY LAST — after every markdown transform, the
// code-block chrome included — because this string goes straight into
// dangerouslySetInnerHTML. It is also why the injected copy button carries no
// inline handler: it is wired by delegation instead (installChatCodeCopy).
export function renderMarkdown(text: string): string {
  const html = md.parse(text, { async: false }).replace(/<table>[\s\S]*?<\/table>/g,
    (table) => `<div class="chat-table-scroll">${table}</div>`);
  return DOMPurify.sanitize(html);
}
