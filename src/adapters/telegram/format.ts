/**
 * Markdown -> Telegram HTML.
 *
 * Telegram renders only a tiny HTML subset (<b>, <i>, <code>, <pre>, <a>) and
 * has NO table support, so the model's Markdown — tables, `**bold**`, `---` —
 * otherwise lands on a phone as raw `|` pipes and literal asterisks (ugly on
 * mobile). This converts a reply into that subset before it's sent, with one
 * deliberate win: a Markdown pipe table becomes a stack of compact cards
 * (bold title + "· "-joined details), which reads cleanly on a narrow screen.
 *
 * Everything here is defensive for streaming: we only emit a tag when we match
 * a closing delimiter, so a half-typed `**` mid-stream stays literal instead of
 * producing invalid HTML. We keep inline rules conservative (bold/code/links
 * only — no single `*`/`_` italics) so identifiers like `Close_Date` and
 * `salesforce___soql_query` or wildcards aren't mangled. Callers should still
 * fall back to plain text if Telegram rejects the HTML (see send.ts).
 */

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Inline Markdown -> HTML. Input MUST already be HTML-escaped. */
function inline(s: string): string {
  // links: [text](http…)  ->  <a href>
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, text, url) => `<a href="${String(url).replace(/"/g, '%22')}">${text}</a>`,
  );
  // bold: **text**  (single * / _ left alone on purpose — see header note)
  s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  // inline code: `code`
  s = s.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  return s;
}

function isSeparatorRow(line: string): boolean {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.includes('-') && /^[\s:\-|]+$/.test(inner);
}

function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|')) t = t.slice(0, -1);
  return t.split('|').map((c) => c.trim());
}

/** Convert a reply's Markdown into the HTML subset Telegram renders. */
export function toTelegramHtml(input: string): string {
  if (!input) return input;
  const lines = input.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inFence = false;
  let fence: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // fenced code blocks ``` … ```
    if (/^\s*```/.test(line)) {
      if (!inFence) {
        inFence = true;
        fence = [];
      } else {
        inFence = false;
        out.push(`<pre>${escapeHtml(fence.join('\n'))}</pre>`);
      }
      continue;
    }
    if (inFence) {
      fence.push(line);
      continue;
    }

    // table: a `|` header row immediately followed by a `|---|` separator row.
    // Render each body row as a card: bold first cell, rest joined with " · ".
    if (
      line.trim().startsWith('|') &&
      i + 1 < lines.length &&
      isSeparatorRow(lines[i + 1])
    ) {
      i += 1; // consume the separator
      const cards: string[] = [];
      while (
        i + 1 < lines.length &&
        lines[i + 1].trim().startsWith('|') &&
        !isSeparatorRow(lines[i + 1])
      ) {
        i += 1;
        const cells = splitRow(lines[i]).filter((c) => c.length > 0);
        if (cells.length === 0) continue;
        const title = inline(escapeHtml(cells[0]));
        const rest = cells.slice(1).map((c) => inline(escapeHtml(c)));
        cards.push(rest.length ? `<b>${title}</b>\n${rest.join(' · ')}` : `<b>${title}</b>`);
      }
      if (cards.length) out.push(cards.join('\n\n'));
      continue;
    }

    // horizontal rule (---, ***, ___) -> drop; the blank lines around it remain
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) continue;

    // headings (#, ##, …) -> bold line
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.*)$/);
    if (heading) {
      out.push(`<b>${inline(escapeHtml(heading[1].trim()))}</b>`);
      continue;
    }

    // bullets (-, *, +) -> • , preserving indentation
    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
      out.push(`${bullet[1]}• ${inline(escapeHtml(bullet[2]))}`);
      continue;
    }

    out.push(inline(escapeHtml(line)));
  }

  if (inFence) out.push(`<pre>${escapeHtml(fence.join('\n'))}</pre>`);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
