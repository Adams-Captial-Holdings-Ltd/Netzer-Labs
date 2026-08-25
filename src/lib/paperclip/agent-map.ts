/**
 * The slug ↔ uuid join, and nothing else.
 *
 * `mission-projection.ts` declares `AgentIdMap` and every projection function
 * takes one. It is imported here, never re-derived (Phase 2 acceptance). This
 * file's whole job is to build one from what `GET /api/companies/{companyId}/agents`
 * actually returns.
 *
 * THE JOIN KEY IS `metadata.netzarAgentId`. That is the only stable
 * cross-system identity on the row: a Paperclip agent's `name` and `role` are
 * operator-editable, its `id` is a uuid Paperclip minted, and the Netzar side
 * knows agents by slug. `tests/fixtures/paperclip-bootstrap.ts` refuses to
 * finish unless every provisioned agent carries it — that is a bootstrap hook,
 * not one of the 21 named probes, and it is cited as such.
 *
 * A1-3 / ADR hard constraint 2: this file mints no identifier of any kind. The
 * map is built from ids Paperclip already assigned, and an unknown slug is an
 * `UnknownAgentError` rather than a fabricated id.
 */
import type { AgentIdMap } from './mission-projection.js';
import type { PaperclipAgent } from './types.js';

/**
 * Builds the map. Later rows win on a duplicate slug, which matches
 * `Array.prototype.reduce` order over the list the server returned; a duplicate
 * is a provisioning bug on the Paperclip side, and this is not the layer that
 * discovers it.
 */
export function buildAgentIdMap(agents: readonly PaperclipAgent[]): AgentIdMap {
  const slugToId = new Map<string, string>();
  const idToSlug = new Map<string, string>();
  for (const agent of agents) {
    const slug = agent.metadata?.netzarAgentId;
    if (typeof slug !== 'string' || slug.length === 0) continue;
    slugToId.set(slug, agent.id);
    idToSlug.set(agent.id, slug);
  }
  // Sorted once, at construction, so `UnknownAgentError`'s `knownSlugs` reads
  // the same way in every log line.
  const slugs = Object.freeze([...slugToId.keys()].sort());
  return {
    toUuid: (slug) => slugToId.get(slug),
    toSlug: (id) => idToSlug.get(id),
    knownSlugs: () => slugs,
  };
}

/**
 * The map every projection call needs, kept for a while rather than refetched
 * per call. The TTL matches the 30 s used by `runtime-config-repo.ts` and
 * `kill-switches-repo.ts`, so all three config-ish caches in this process
 * expire on the same clock.
 */
export const AGENT_MAP_TTL_MS = 30_000;

/** One method, one implementation: the closure IS the cache. */
export type AgentIdMapCache = () => Promise<AgentIdMap>;

/**
 * `load` is injected rather than imported so this file never depends on
 * `client.ts` (A2-19), and so a test builds the cache from a literal list with
 * no network and no mocking library.
 */
export function createAgentIdMapCache(
  load: () => Promise<readonly PaperclipAgent[]>,
  options: { ttlMs?: number; now?: () => number } = {},
): AgentIdMapCache {
  const ttlMs = options.ttlMs ?? AGENT_MAP_TTL_MS;
  const now = options.now ?? Date.now;
  let cached: { map: AgentIdMap; expiresAt: number } | undefined;
  // In-flight promise, so N concurrent projections cause ONE agent-list read.
  // This matters more here than it looks: the issue-list coalescer proves
  // Paperclip refuses DISTINCT concurrent reads per actor, so a fan-out that
  // each independently fetches the agent list is spending exactly the budget
  // the sweep needs.
  let inFlight: Promise<AgentIdMap> | undefined;

  return async () => {
    if (cached && cached.expiresAt > now()) return cached.map;
    if (inFlight) return inFlight;
    inFlight = load()
      .then((agents) => {
        const map = buildAgentIdMap(agents);
        cached = { map, expiresAt: now() + ttlMs };
        return map;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
}
