/**
 * Split a long reply into surface-sized pieces.
 *
 * Chat surfaces reject oversized sends instead of truncating (Telegram caps
 * messages at 4096 chars, Slack at 40k), and the failure used to be silent:
 * the placeholder froze on its last partial chunk while the turn was
 * persisted as delivered. Splitting lets the adapter fall back to several
 * real messages so the user always sees the whole answer.
 *
 * Cuts prefer the last paragraph break inside the window, then the last line
 * break, then a hard cut, so pieces stay readable. Callers pass a max well
 * under the surface's hard cap to leave room for markup expansion (HTML tags
 * on Telegram, mrkdwn on Slack).
 */
export function splitLongText(text: string, max: number): string[] {
  if (text.length <= max) return text ? [text] : [];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    let cut = window.lastIndexOf('\n\n');
    if (cut < max * 0.5) cut = window.lastIndexOf('\n');
    if (cut < max * 0.5) cut = max;
    const piece = rest.slice(0, cut).trim();
    if (piece) out.push(piece);
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}
