/**
 * Agent display-name resolver.
 *
 * Many tabs render an agent by its raw `agentId` (for example "main", or a
 * uuid), which reads like debug output to a non-technical leader. This hook
 * fetches the agent list once (GET /agents, which the api client already
 * 15s-caches) and hands back a `nameFor(agentId)` function that maps an id to
 * its friendly display name.
 *
 * Resolution is graceful:
 *   - Before names load, `nameFor(id)` returns the id unchanged, so the UI
 *     never shows an empty cell or a flash of "unknown".
 *   - For an id with no matching agent (deleted agent, stale row), it falls
 *     back to the raw id too.
 *
 * The raw id is intentionally NOT hidden anywhere this is used: callers keep it
 * reachable via a `title` attribute so support and power users can still read
 * the underlying identifier on hover.
 */

import { useState, useEffect } from 'preact/hooks';
import { api } from './api';

/** One agent as returned by GET /agents (the fields this resolver needs). */
interface AgentNameRow {
  id: string;
  displayName: string;
}

export interface AgentNamesResult {
  /**
   * Resolve an agent id to its display name. Returns the raw id while names are
   * still loading or when the id is unknown, so it is always safe to render.
   */
  nameFor: (agentId: string | null | undefined) => string;
  /** True until the first /agents response settles (success or failure). */
  loading: boolean;
}

/**
 * Fetch the agent list once and expose a stable id -> display-name resolver.
 *
 * A failed fetch is swallowed (the resolver simply keeps returning raw ids), so
 * a profile that cannot read /agents still sees a working page with plain ids
 * rather than a broken one.
 */
export function useAgentNames(): AgentNamesResult {
  const [names, setNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ac = new AbortController();
    api
      .get<{ agents: AgentNameRow[] }>('/agents', ac.signal)
      .then((d) => {
        const map: Record<string, string> = {};
        for (const a of d.agents ?? []) {
          // Only override the id when there is a real, non-empty display name.
          if (a?.id && a.displayName) map[a.id] = a.displayName;
        }
        setNames(map);
      })
      .catch(() => {
        // Leave the map empty; nameFor() falls back to the raw id.
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, []);

  const nameFor = (agentId: string | null | undefined): string => {
    if (!agentId) return '';
    return names[agentId] ?? agentId;
  };

  return { nameFor, loading };
}
