/*
 * Copied from danny-avila/LibreChat (MIT), pinned at commit
 * 6d499ba3ce17f906a7762429c61018f230ecd64e -- donor path
 * `client/src/components/Chat/Messages/MinimalHoverButtons.tsx` (60 lines).
 *
 * ── Why this file, of everything in the harvest ───────────────────────────
 *
 * This app had NO hover action row on a message at all: no copy, no
 * regenerate, no feedback. Copy is the one every chat product has and the one
 * a reader reaches for constantly, and there was nothing to reach for. The
 * donor's minimal row is exactly that one button, which is why it is the one
 * taken rather than its full `HoverButtons`.
 *
 * REGENERATE AND FEEDBACK ARE DELIBERATELY ABSENT, and this is not an
 * oversight to fix later by adding buttons. This app's wire has no endpoint for
 * either -- `POST /api/test-turn/stream` takes a prompt and streams a reply;
 * there is no re-run of a settled turn and no rating sink. A button wired to
 * nothing, or rendered disabled with an apologetic title, is worse than no
 * button: it advertises a capability the product does not have. The donor's own
 * minimal variant ships copy alone for the same reason, so nothing was removed
 * from this file to reach that state.
 *
 * ── The edit list, in full: FOUR changes, all of them the missing package ──
 *
 *   1. donor line 3, `import type { TMessage, SearchResultData } from
 *      'librechat-data-provider'` -> this app's `Message` type. That package is
 *      not on disk.
 *   2. `searchResults` is dropped from the props and from both hook calls. It
 *      feeds the citation renumberer in `useCopyToClipboard`, which is not
 *      copied (see that file's header) because this app's wire carries no
 *      search results to renumber.
 *   3. `message.content` is dropped from both hook calls: this app's `Message`
 *      has `.text` and no content-part array, so there is no second source for
 *      the clipboard to serialize.
 *   4. `localize('com_ui_copy_to_clipboard')` etc. resolve through the ported
 *      key table (~/hooks/useLocalize.ts) rather than through react-i18next.
 *      The call sites are unchanged; only what backs them is.
 *
 * Everything else -- the `visible mt-1 flex justify-center gap-1 self-end`
 * row, the glyph swap on copy, `disabled={!canCopy}`, the tooltip that names
 * the state rather than the control, and `revealOnRowHoverClasses` -- is
 * byte-for-byte.
 */
import { useState, useMemo } from 'react';
import { Button, Clipboard, CheckMark, TooltipAnchor } from '@librechat/client';
import type { Message } from '../../../../../../lib/chat/types';
import { useLocalize, useCopyToClipboard, hasCopyableText } from '~/hooks';
import { revealOnRowHoverClasses } from './styles';
import { cn } from '~/utils';

type THoverButtons = {
  message: Message;
};

export default function MinimalHoverButtons({ message }: THoverButtons) {
  const localize = useLocalize();
  const [isCopied, setIsCopied] = useState(false);
  const copyToClipboard = useCopyToClipboard({
    text: message.text,
  });
  const canCopy = useMemo(() => hasCopyableText({ text: message.text }), [message.text]);

  return (
    <div className="visible mt-1 flex justify-center gap-1 self-end text-text-tertiary lg:justify-start">
      <TooltipAnchor
        description={
          isCopied ? localize('com_ui_copied_to_clipboard') : localize('com_ui_copy_to_clipboard')
        }
        render={
          <Button
            variant="ghost"
            size="icon"
            aria-label={
              isCopied
                ? localize('com_ui_copied_to_clipboard')
                : localize('com_ui_copy_to_clipboard')
            }
            className={cn(
              'ml-0 flex size-auto items-center gap-1.5 rounded-lg p-1.5 text-xs text-text-secondary-alt',
              'hover:bg-surface-hover hover:text-text-primary',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-primary',
              revealOnRowHoverClasses,
            )}
            disabled={!canCopy}
            onClick={() => copyToClipboard(setIsCopied)}
          >
            {isCopied ? (
              <CheckMark className="h-[19px] w-[19px]" />
            ) : (
              <Clipboard className="h-[19px] w-[19px]" />
            )}
          </Button>
        }
      />
    </div>
  );
}
