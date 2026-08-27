/*
 * Copied from danny-avila/LibreChat (MIT), pinned at commit
 * 6d499ba3ce17f906a7762429c61018f230ecd64e -- donor path
 * `client/src/components/Chat/Messages/Content/CancelledIcon.tsx`.
 *
 * 9 lines. ONE EDIT, on line 1: `lucide-react` -> `lucide-preact`. Same icon
 * set, this app's build of it; `lucide-react` is not a dependency here and
 * pulling it in to draw an X would be a second copy of the same glyph library.
 * Lines 3-9 are byte-for-byte.
 *
 * WIRED: the stopped-turn footer in AssistantMessage.tsx, which previously
 * marked a cancelled turn with a grey dot -- a mark it shared with nothing and
 * that said nothing. An X is the donor's own answer and reads as "this was
 * stopped" without a legend.
 */
import { X } from 'lucide-preact';

export default function CancelledIcon() {
  return (
    <div className="flex h-full w-full items-center justify-center rounded-full bg-transparent text-text-secondary">
      <X className="size-4" aria-hidden="true" />
    </div>
  );
}
