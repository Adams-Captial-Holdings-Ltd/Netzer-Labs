/**
 * Pure derivation of the mission hierarchy the Missions board already holds.
 *
 * WHY CLIENT-SIDE. The board fans out one `GET /missions?owner=` per agent and
 * flattens every board into one array (`Missions.tsx`, the ALL_OWNERS branch),
 * so the SPA already holds every loaded mission of every loaded agent. A
 * mission's children are the loaded rows whose `parentId` is its id; its parent
 * is the loaded row whose id is its `parentId`. No route is added and no fetch
 * is issued: there is no cross-agent list route to call, and the per-parent
 * children route the server could use (`?parentId=`) is exactly the read
 * amplification `listBoardMissions` was built to avoid.
 *
 * THE FOUR FIELDS ARE OPTIONAL AND ADDITIVE. They come from P1-2's
 * `WireMission` (`src/lib/missions/mission-acl.ts`, shape declared in
 * `src/lib/paperclip/mission-projection.ts` -> `MissionHierarchyFields`).
 * A legacy DynamoDB-substrate row carries none of them, so every function here
 * answers `undefined` / `[]` / `false` for one.
 */

/**
 * The structural subset these helpers read. Deliberately NOT the page's
 * `Mission` interface: the helpers need five fields, and depending on the page
 * type would make `Missions.tsx` and this module import each other.
 * Kept in step with `WireMission` in `src/lib/missions/mission-acl.ts`.
 */
export interface HierarchyMission {
  id: string;
  /** A uuid, or an explicit `null` on a root row. Absent on a legacy row. */
  parentId?: string | null;
  /** Paperclip's raw status, alongside the narrowed public `status`. */
  paperclipStatus?: string;
  blockerAttention?: { state: string; reason: string | null };
  /** Children the SERVER's one board read saw. Absent means it saw none. */
  childCount?: number;
}

/**
 * The loaded parent, or `undefined` when there is none to show.
 *
 * `undefined` covers three different situations the caller must render
 * differently from one another only if it wants to: no `parentId` at all (a
 * legacy row), an explicit `null` (a root row), and a `parentId` whose row is
 * not loaded — on a board that failed to load, owned by an agent not in the
 * current scope, or past the server's 100-row limit.
 */
export function parentOf<T extends HierarchyMission>(
  rows: readonly T[],
  mission: HierarchyMission,
): T | undefined {
  const parentId = mission.parentId;
  if (!parentId) return undefined;
  return rows.find((row) => row.id === parentId);
}

/**
 * The loaded children, in `rows` order.
 *
 * Order is the caller's: `filter` preserves it, so the list renders in the same
 * order the board flattened the fetched pages in. This can return MORE rows
 * than the server's `childCount`, which counts only the children in the same
 * single owner-scoped read (see `childCountsByParent` in mission-acl.ts); the
 * flattened cross-agent board can hold children that read never saw.
 */
export function childrenOf<T extends HierarchyMission>(
  rows: readonly T[],
  mission: HierarchyMission,
): T[] {
  return rows.filter((row) => row.parentId === mission.id);
}

/**
 * The one state value the 2026-09-06 P1-1 live run observed as "nothing to
 * see". The only other value that run observed was `needs_attention`.
 */
const BLOCKER_STATE_CLEAR = 'none';

/**
 * Whether this mission's blockers want attention.
 *
 * THIS, NOT `status === 'blocked'`, IS THE DEPENDENCY SIGNAL. The 2026-09-06
 * P1-1 run measured an issue with an unresolved `blockedByIssueIds` edge
 * sitting at `todo`, and measured Paperclip rewriting `status` to `blocked`
 * after a RUN FAILED (`errorCode: adapter_failed`) on issues with no blockers
 * at all. On this artifact `blocked` means "runs are failing".
 *
 * Any non-empty state other than the measured clear value counts as attention,
 * so a state this artifact has not shown us yet surfaces instead of being
 * silently swallowed; the raw state and reason are rendered beside it.
 */
export function isBlocked(mission: HierarchyMission): boolean {
  const state = mission.blockerAttention?.state;
  if (typeof state !== 'string') return false;
  const trimmed = state.trim();
  return trimmed !== '' && trimmed !== BLOCKER_STATE_CLEAR;
}

/**
 * Paperclip's raw status, verbatim, or `undefined` when there is none to show.
 *
 * Verbatim on purpose: its whole value is being the UNMAPPED word, next to the
 * humanised public status. A blank string answers `undefined` so the caller
 * renders no empty block.
 */
export function rawStatusLabel(mission: HierarchyMission): string | undefined {
  const raw = mission.paperclipStatus;
  if (typeof raw !== 'string' || raw.trim() === '') return undefined;
  return raw;
}
