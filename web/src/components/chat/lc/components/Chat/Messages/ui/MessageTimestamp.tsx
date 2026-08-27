/*
 * Copied from danny-avila/LibreChat (MIT), pinned at commit
 * 6d499ba3ce17f906a7762429c61018f230ecd64e -- donor path
 * `client/src/components/Chat/Messages/ui/MessageTimestamp.tsx` (99 lines).
 *
 * ── The edit list, in full: THREE lines ───────────────────────────────────
 *
 *   1. donor line 1, `import { useTranslation } from 'react-i18next'` ->
 *      `import { systemLocale } from '~/utils'`. There is no i18n layer here.
 *   2. donor line 76, `const { i18n } = useTranslation();` ->
 *      `const language = systemLocale();`
 *   3. donor lines 78 and 88, `i18n.language` -> `language` (one expression
 *      each, on lines that are otherwise unchanged).
 *
 * `systemLocale()` is a strictly better source for this than `i18n.language`
 * would have been, and the donor's own `utils/clock.ts` says so in its comment:
 * `i18n.language` is normalized down to a translation bundle, so `en-GB` and
 * `en-AU` both arrive as `en` and the region the date convention depends on is
 * already gone. Everything else below is byte-for-byte.
 *
 * ── Why this is worth taking ──────────────────────────────────────────────
 *
 * The author line used to render `d.toLocaleTimeString(...)` into a bare
 * `<span>`. Three things change:
 *
 *   - it is a real `<time dateTime={iso}>`, so the machine-readable instant is
 *     in the markup rather than only the rendered string;
 *   - a recent turn reads "5 minutes ago" and carries the absolute date in its
 *     `title`, an older one reads the absolute date directly;
 *   - only the RECENT rows subscribe to the shared minute ticker
 *     (`useTimeTick`), so leaving a transcript open re-renders a handful of
 *     rows a minute instead of every message in it.
 */
import { systemLocale } from '~/utils';
import useClockFormat from '~/hooks/useClockFormat';
import { cn, getMessageTimestamp } from '~/utils';
import useTimeTick from '~/hooks/useTimeTick';

type Timestamp = NonNullable<ReturnType<typeof getMessageTimestamp>>;

function TimestampText({
  timestamp,
  className,
  revealOnHover = true,
}: {
  timestamp: Timestamp;
  className?: string;
  revealOnHover?: boolean;
}) {
  return (
    <time
      dateTime={timestamp.iso}
      title={timestamp.isRecent ? timestamp.absolute : undefined}
      className={cn(
        'message-timestamp text-xs font-normal text-text-secondary',
        revealOnHover &&
          'ml-2 transition-opacity duration-theme-normal ease-out motion-reduce:transition-none',
        className,
      )}
    >
      {timestamp.isRecent ? timestamp.relative : timestamp.absolute}
    </time>
  );
}

/** Only recent timestamps subscribe to the shared minute ticker, so the
 * per-minute sweep re-renders a handful of rows instead of every message. */
function RecentTimestamp({
  value,
  language,
  hour12,
  className,
  revealOnHover,
}: {
  value?: string | null;
  language: string;
  hour12: boolean;
  className?: string;
  revealOnHover?: boolean;
}) {
  useTimeTick();
  const timestamp = getMessageTimestamp(value, language, hour12);

  if (!timestamp) {
    return null;
  }

  return (
    <TimestampText timestamp={timestamp} className={className} revealOnHover={revealOnHover} />
  );
}

/**
 * Inline message timestamp shown next to the author name in the message header.
 * On hover-capable pointers it reveals on row hover/focus; on touch and other
 * non-hover devices it stays visible. Recent messages show the relative form
 * ("10 minutes ago") with the absolute date on hover; older messages show the
 * absolute date directly.
 */
export default function MessageTimestamp({
  value,
  className,
  revealOnHover,
}: {
  value?: string | null;
  className?: string;
  revealOnHover?: boolean;
}) {
  const language = systemLocale() ?? '';
  const hour12 = useClockFormat();
  const timestamp = getMessageTimestamp(value, language, hour12);

  if (!timestamp) {
    return null;
  }

  if (timestamp.isRecent) {
    return (
      <RecentTimestamp
        value={value}
        language={language}
        hour12={hour12}
        className={className}
        revealOnHover={revealOnHover}
      />
    );
  }

  return (
    <TimestampText timestamp={timestamp} className={className} revealOnHover={revealOnHover} />
  );
}
