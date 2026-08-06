import { useState, useEffect, useRef } from 'preact/hooks';
import { api } from '../lib/api';

/**
 * Slim "at a glance" toolbar shown at the top of a tab. Lazy-loads a one-line
 * AI summary of the tab's current data from /api/tldr (Bedrock, cached
 * server-side). Pass `ready=false` while the page's data is still loading so
 * the summary reflects loaded data, not an empty state. Renders nothing until
 * a summary arrives, and hides itself silently on any error.
 *
 * The last summary per tab is kept in module state so a revisit paints it
 * INSTANTLY and regenerates silently in the background. Without this, every
 * tab switch showed a 1-2s pulsing placeholder while the Bedrock call ran,
 * which read as "the page is still loading" even though the data was up.
 */
const lastSummaryByTab = new Map<string, string>();

export function TldrBar({ tab, data, ready = true }: { tab: string; data: unknown; ready?: boolean }) {
  const [summary, setSummary] = useState(lastSummaryByTab.get(tab) ?? '');
  const [loading, setLoading] = useState(false);
  const lastKey = useRef('');

  const dataKey = JSON.stringify(data ?? {});
  useEffect(() => {
    if (!ready) return;
    if (dataKey === lastKey.current) return; // data unchanged → keep summary
    lastKey.current = dataKey;
    let cancelled = false;
    setLoading(true);
    api
      .post<{ summary: string }>('/tldr', { tab, data })
      .then((r) => {
        const s = r.summary || '';
        // Only remember real summaries — keep the previous one on an empty
        // (fail-soft) response so a transient Bedrock error doesn't blank the bar.
        if (s) lastSummaryByTab.set(tab, s);
        if (!cancelled) setSummary(s || lastSummaryByTab.get(tab) || '');
      })
      .catch(() => { if (!cancelled) setSummary(lastSummaryByTab.get(tab) ?? ''); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [ready, dataKey]);

  if (!ready) return null;

  const Spark = (
    <svg class="w-4 h-4 shrink-0 text-primary" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M12 2l1.6 5.2L19 9l-5.4 1.8L12 16l-1.6-5.2L5 9l5.4-1.8L12 2z" />
    </svg>
  );

  if (loading && !summary) {
    return (
      <div class="flex items-center gap-2 bg-primary/5 border border-primary/15 rounded-lg px-3 py-2 mb-5">
        {Spark}
        <div class="h-3 rounded bg-bg-elevated w-2/3 animate-pulse" />
      </div>
    );
  }
  if (!summary) return null;
  return (
    <div class="flex items-start gap-2 bg-primary/5 border border-primary/15 rounded-lg px-3 py-2 mb-5">
      <span class="mt-0.5">{Spark}</span>
      <p class="text-body-sm text-secondary">
        <span class="text-caption text-muted uppercase tracking-wider mr-2">TLDR</span>
        {summary}
      </p>
    </div>
  );
}
