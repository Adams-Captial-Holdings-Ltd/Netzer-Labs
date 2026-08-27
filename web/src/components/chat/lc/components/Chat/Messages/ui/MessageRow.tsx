/*
 * Copied from danny-avila/LibreChat (MIT), pinned at commit
 * 6d499ba3ce17f906a7762429c61018f230ecd64e -- donor path
 * `client/src/components/Chat/Messages/ui/MessageRow.tsx` (118 lines).
 *
 * This replaces the hand-written frame that used to live at
 * ../../../../../MessageRow.tsx lines 55-91. That file's long comment about
 * WHY the two turn types are shaped this way is preserved there, above the
 * re-export; what follows here is the donor's own implementation of it.
 *
 * ── The edit list, in full: THREE changes, measured ───────────────────────
 *
 * 95 of the donor's 118 lines are byte-for-byte. The 23 that are not all belong
 * to one of the three changes below; a line-by-line diff against the donor file
 * is the check.
 *
 *   1. `getMessageRowWidthClass` (donor lines 23-33) is DELETED, and four
 *      things fall with it because they exist only to serve it:
 *        - the `fullWidth` prop, which fed nothing else;
 *        - the `widthClass` local and its slot in the outer `cn(...)`;
 *        - `mx-auto` and `flex-1` on the outer div -- centring and growing
 *          inside a column that is already centred and already sized;
 *        - `transition-[max-width] duration-theme-normal
 *          motion-reduce:transition-none`, which animates the max-width that
 *          is no longer declared here.
 *      The reason is that it re-declares a measure this app already owns:
 *      ChatCanvas.tsx IS the single shared content column, and a second
 *      `md:max-w-3xl xl:max-w-4xl` here is exactly the drift that file was
 *      written to delete. The assistant column's `flex-1` (donor line 76)
 *      gains `w-full` in the same move, because the outer flex-1 that used to
 *      size it is gone.
 *
 *   2. The user pill keeps this product's hairline border. The donor draws it
 *      as a borderless fill (`bg-surface-tertiary` alone); this app's pill has
 *      carried `border border-border` since the frame was first written,
 *      because the hairline is this product's language (the README style bar)
 *      and the fill alone is a 4% step that disappears on a projector. That is
 *      a recorded product decision, so it is kept rather than silently
 *      reversed by a copy. Everything else about the pill is the donor's,
 *      including the `rounded-br-*` corner that points the shape back at the
 *      composer.
 *
 *   3. `SubRow` (donor `../SubRow.tsx`, copied verbatim beside this file) now
 *      wraps the footer, replacing the donor's bare `<div className={cn(...)}>`
 *      on its line 113. `empty:hidden` is why: the footer slot must take no
 *      height when a turn has no footer, and the donor's own SubRow does that
 *      in CSS rather than making every caller remember a `{footer && ...}`
 *      guard. The donor ships both and uses the div here; this takes the
 *      cheaper of its own two answers.
 *
 *      The user turn's override is written `!justify-end`, not `justify-end`.
 *      SubRow's own class list opens with `justify-start`, and this app's `cn`
 *      is a join, not `tailwind-merge` -- so both classes reach the element and
 *      SOURCE ORDER would decide. Tailwind happens to emit `justify-end` after
 *      `justify-start`, so it would in fact win, but a right-aligned footer
 *      resting on the order Tailwind writes its stylesheet in is a bug waiting
 *      for a version bump. The bang makes it a fact instead. This is the one
 *      place in the ported tree where the missing `twMerge` is load-bearing;
 *      see the note on ~/utils/cn.ts.
 *
 * Everything else -- the `justify-end` / `items-start` split, the `user-turn` /
 * `agent-turn` marks, the `ml-auto w-fit max-w-[90%] sm:max-w-[85%]` ladder,
 * the sr-only heading for user turns, the visible author line for assistant
 * turns and its `mb-1` -- is byte-for-byte.
 */
import type { ReactNode } from 'react';
import MessageTimestamp from './MessageTimestamp';
import HeaderLabel from './HeaderLabel';
import SubRow from '../SubRow';
import { cn } from '~/utils';

type MessageRowProps = {
  id?: string;
  label: string;
  hoverLabel?: string | null;
  icon: ReactNode;
  children: ReactNode;
  footer: ReactNode;
  timestamp?: string | null;
  ariaLabel?: string;
  headerPrefix?: string;
  isCreatedByUser: boolean;
  hasParallelContent?: boolean;
  isEditing?: boolean;
  className?: string;
};

export default function MessageRow({
  id,
  icon,
  label,
  hoverLabel,
  footer,
  children,
  timestamp,
  ariaLabel,
  className,
  headerPrefix,
  isCreatedByUser,
  hasParallelContent = false,
  isEditing = false,
}: MessageRowProps) {
  return (
    <div
      id={id}
      role="group"
      aria-label={ariaLabel}
      className={cn(
        'message-render group flex min-w-0 font-theme-ui',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text-primary',
        isCreatedByUser ? 'justify-end' : 'items-start',
        className,
      )}
    >
      <div
        className={cn(
          'relative flex min-w-0 flex-col',
          isCreatedByUser ? 'user-turn' : 'agent-turn',
          (hasParallelContent || isEditing) && 'w-full',
          !hasParallelContent &&
            isCreatedByUser &&
            cn('ml-auto items-end', !isEditing && 'w-fit max-w-[90%] sm:max-w-[85%]'),
          !hasParallelContent && !isCreatedByUser && !isEditing && 'w-full flex-1',
        )}
      >
        {!hasParallelContent &&
          (isCreatedByUser ? (
            <h2 className="sr-only">
              {headerPrefix}
              {label}
              <MessageTimestamp value={timestamp} />
            </h2>
          ) : (
            /** `mb-1` keeps the name off its own first line of body text. */
            <h2 className="mb-1 flex min-h-7 w-full select-none items-center gap-2 text-sm font-semibold text-text-primary">
              <span
                aria-hidden="true"
                className="flex size-6 flex-shrink-0 items-center justify-center overflow-hidden rounded-full"
              >
                {icon}
              </span>
              <span className="sr-only">{headerPrefix}</span>
              <HeaderLabel label={label} hoverLabel={hoverLabel} />
              <MessageTimestamp value={timestamp} className="ml-auto shrink-0 font-normal" />
            </h2>
          ))}

        <div className={cn('flex w-full flex-col gap-1', isCreatedByUser && 'items-end')}>
          <div
            className={cn(
              'flex min-h-[20px] max-w-full flex-grow flex-col gap-0',
              isCreatedByUser && !isEditing
                ? 'w-fit rounded-theme-surface rounded-br-theme-control border border-border bg-surface-tertiary px-theme-normal py-2.5'
                : 'w-full',
            )}
            data-testid="message-body"
          >
            {children}
          </div>
          <SubRow classes={cn('w-full', isCreatedByUser && '!justify-end')}>{footer}</SubRow>
        </div>
      </div>
    </div>
  );
}
