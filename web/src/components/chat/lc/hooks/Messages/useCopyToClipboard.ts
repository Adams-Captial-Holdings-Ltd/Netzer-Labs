/*
 * Copied from danny-avila/LibreChat (MIT), pinned at commit
 * 6d499ba3ce17f906a7762429c61018f230ecd64e -- donor path
 * `client/src/hooks/Messages/useCopyToClipboard.ts`, lines 42-59
 * (`serializeMessageForClipboard`), 84-86 (`hasCopyableText`) and 88-126
 * (the hook itself).
 *
 * ── What is NOT copied, and why ───────────────────────────────────────────
 *
 * Lines 128-362 are `processCitations`: a 235-line citation renumberer that
 * rewrites inline `\ue203`-delimited web-search markers into `[1]`, `[2]`
 * footnotes with a source list appended. It is driven entirely by a
 * `searchResults` map, and this app's wire carries no such field -- so on every
 * call it would take the `Object.keys(searchResults).length === 0` early return
 * on line 64. Copying 235 lines to reach a branch that is unreachable here is
 * not a harvest.
 *
 * ── The edit list, in full ────────────────────────────────────────────────
 *
 *   1. `searchResults` is dropped from `ClipboardSource` and from every call
 *      site, along with `buildClipboardText`'s citation branch -- see above.
 *      What remains of `buildClipboardText` is the two regex scrubs, which are
 *      also citation cleanup and are likewise dropped rather than carried with
 *      no citations to clean; the serializer is called directly.
 *   2. `copy-to-clipboard` (the donor's npm dependency) ->
 *      `navigator.clipboard.writeText`. The package exists to support browsers
 *      without the async Clipboard API; this app already requires a browser
 *      with `matchMedia().addEventListener` and `inert`, both younger. The
 *      donor's synchronous `boolean` return becomes a fire-and-report, because
 *      the platform call is a promise.
 *   3. `TMessage`/`TMessageContentParts` (from the missing workspace package)
 *      -> this app's `Message`, which has `.text` and no content-part array.
 *      `serializeMessageForClipboard`'s array branch therefore has nothing to
 *      walk and is dropped with it.
 *   4. `NodeJS.Timeout` -> `ReturnType<typeof setTimeout>`. There are no node
 *      types in this program, and the browser's setTimeout returns a number.
 *
 * What survives verbatim is the part worth having: the 3-second copied-state
 * window, the timeout cleared on unmount AND on a re-copy so a second click
 * cannot be reverted by the first click's timer, and the refusal to report
 * success for empty text.
 */
import { useCallback, useEffect, useRef } from 'react';
import type { Message } from '../../../../../lib/chat/types';
import { writeClipboard } from '../../../../../lib/chat/code-block';

type ClipboardSource = Partial<Pick<Message, 'text'>>;

export function serializeMessageForClipboard({ text }: ClipboardSource): string {
  return text ?? '';
}

export function hasCopyableText(source: ClipboardSource): boolean {
  return serializeMessageForClipboard(source).trim().length > 0;
}

export default function useCopyToClipboard({ text }: ClipboardSource) {
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  const copyToClipboard = useCallback(
    (setIsCopied: (next: boolean) => void): boolean => {
      const clipboardText = serializeMessageForClipboard({ text });

      if (clipboardText.trim().length === 0) {
        return false;
      }

      // The donor guards on its copy call — `if (!copy(...)) { return false; }`.
      // An earlier pass here dropped that branch and fired
      // `navigator.clipboard?.writeText(...)` followed by an UNCONDITIONAL
      // `setIsCopied(true)`. On any non-secure origin `navigator.clipboard` is
      // undefined, the optional chain swallows it, and the button reports
      // "Copied" over an empty clipboard — which is how this very app is served
      // in local development and on plenty of enterprise intranets.
      //
      // writeClipboard() is this app's own helper and already does what the
      // donor's `copy-to-clipboard` package was there for: it tries the async
      // Clipboard API, then falls back to the selection trick when the origin
      // is insecure or permission is refused. It resolves to whether the text
      // actually landed, so the confirmation is driven by that and never by the
      // attempt.
      void writeClipboard(clipboardText).then((copied) => {
        if (!copied) {
          return;
        }
        if (copyTimeoutRef.current) {
          clearTimeout(copyTimeoutRef.current);
        }
        setIsCopied(true);
        copyTimeoutRef.current = setTimeout(() => {
          setIsCopied(false);
        }, 3000);
      });

      // Reports that there was something to copy, not that the write finished —
      // the write is asynchronous and its outcome reaches the caller through
      // setIsCopied above.
      return true;
    },
    [text],
  );

  return copyToClipboard;
}
