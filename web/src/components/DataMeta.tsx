import { formatLocalTime } from '../lib/format';

interface DataMetaProps {
  /**
   * When the data was last fetched. A Date or an epoch in MILLISECONDS
   * (Date.now()). Renders an "updated <local time>" stamp so a reader can tell
   * how fresh the numbers are. Omit to hide the stamp.
   */
  updatedAt?: Date | number;
  /**
   * The TRUE total available on the backend, when one is known. The "Showing X
   * of Y" segment renders only when total is given AND total > shown (a real
   * truncation). Do NOT pass a fabricated total; when the backend returns only a
   * capped array with no true total, use `note` for an honest "first N" instead.
   */
  total?: number;
  /** How many rows are actually on screen. Pairs with `total`. */
  shown?: number;
  /** A re-run of the page's fetch. When given, a small refresh button renders. */
  onRefresh?: () => void;
  /**
   * Honest free-text truncation note, e.g. "Showing first 50". Use this when the
   * backend does NOT return a true total. Rendered in place of "Showing X of Y".
   */
  note?: string;
}

/**
 * A subtle muted caption line surfacing data freshness and truncation, so a
 * non-technical reader can tell whether numbers are live and whether a list is
 * capped. Renders nothing when it would have nothing to say.
 *
 * Examples:
 *   "Showing 50 of 312  ·  updated 3:41:07 PM"   (true total via `total`)
 *   "Showing first 50  ·  updated 3:41:07 PM"    (honest `note`, no true total)
 *   "updated 3:41:07 PM"                          (freshness only)
 */
export function DataMeta({ updatedAt, total, shown, onRefresh, note }: DataMetaProps) {
  // Only a real truncation (a known total larger than what is shown) earns the
  // auto "Showing X of Y" line. Otherwise fall back to the honest `note`.
  const truncated = total != null && shown != null && total > shown;
  const showingText = truncated
    ? `Showing ${shown!.toLocaleString()} of ${total!.toLocaleString()}`
    : note;

  if (!showingText && updatedAt == null && !onRefresh) return null;

  return (
    <div class="flex items-center gap-2 text-caption text-muted">
      {showingText && <span>{showingText}</span>}
      {showingText && updatedAt != null && <span aria-hidden="true">·</span>}
      {updatedAt != null && <span>updated {formatLocalTime(updatedAt)}</span>}
      {onRefresh && (
        <button
          type="button"
          onClick={onRefresh}
          aria-label="Refresh"
          title="Refresh"
          class="inline-flex items-center justify-center text-muted hover:text-secondary transition-colors
            focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-full"
        >
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M23 4v6h-6" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>
      )}
    </div>
  );
}
