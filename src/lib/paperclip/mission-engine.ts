/**
 * `MissionEngine` — the interface every Mission caller depends on, and the
 * reason this file imports nothing from `client.ts`.
 *
 * A2-19: Linear's `LinearRequest` is a bare exported TYPE, not a client
 * dependency, and that is what makes its models swappable and mockable with no
 * network and no DI container. The same rule here: the dashboard handler, the
 * Missions tools and Jarvis depend on THIS file; only
 * `paperclip-mission-engine.ts` — the sole implementation — knows the transport
 * exists. Nothing here imports `client.ts`, `error.ts` or `config.ts`.
 *
 * A3-2 asks that the doc comment on a cross-surface contract be normative
 * enough to implement a fourth surface from. The contract in full:
 *
 *  IDENTITY. `missionId` is a Paperclip issue uuid. This engine never resolves
 *  an 8-character prefix and never resolves a human identifier such as `NZR-42`
 *  — no probe has ever passed an identifier to `GET /api/issues/{id}` and the
 *  legacy prefix contract belongs to the repo it is being replaced by (C-16).
 *
 *  AGENTS. Every `ownerAgent` is a Netzar SLUG. The slug ↔ uuid join is
 *  `metadata.netzarAgentId` and lives in `agent-map.ts`; an unknown slug is an
 *  `UnknownAgentError` from `mission-projection.ts`, never a fabricated id.
 *
 *  PROJECTION. Every returned `ProjectedMission` comes from
 *  `mission-projection.ts`'s `issueToMission`, imported and never re-derived.
 *  Phase 9 makes priority and the six shared statuses exact. The remaining
 *  intentional status narrowing is Paperclip `backlog` and `todo` both reading
 *  as Mission `open`; assignment still distinguishes those states.
 *
 *  ERRORS. Everything below rejects with a `PaperclipError` subclass. The kill
 *  switch surfaces as `PaperclipDisabledError` from inside the transport, so an
 *  implementation neither checks nor re-checks it.
 *
 *  OPTIONS. `actor` names the agent slug whose key signs the request (C-9
 *  settled `actor`, never `as`). `runId` is a run the CALLER already holds; it
 *  is never synthesized, and an absent one is omitted rather than sent empty.
 *
 *  NO `disabled-mission-engine.ts`. C-8: the kill switch lives inside the
 *  transport so every method already throws when it is set, and the rollout
 *  flag is a ROUTER-LEVEL switch picking one whole stack or the other. A
 *  per-request fallback between engines is forbidden.
 */
import type { Mission, MissionStatus } from '../state/mission-tasks-repo.js';
import type { ProjectedMission } from './mission-projection.js';
import type { PaperclipFetch } from './types.js';

export interface MissionEngineOptions {
  /** The agent slug whose key signs the request. Unset = the configured default. */
  actor?: string;
  /** A run id the caller already holds. Never synthesized. */
  runId?: string;
}

export interface ListMissionsOptions extends MissionEngineOptions {
  /** A Netzar agent slug, mapped to the proven `assigneeAgentId` filter. */
  ownerAgent?: string;
  /**
   * A strict `>` watermark on native `updatedSince`. A caller MUST
   * subtract an overlap rather than pass its last-seen stamp: API stamps are
   * millisecond-truncated, and the overlap protects ties and two-clock skew.
   * Callers dedupe rows seen more than once.
   */
  updatedSince?: string;
  limit?: number;
  /**
   * Hard cap on pages walked. There is no totals endpoint on this artifact, so
   * paging to a short page is the only way to size a board.
   */
  maxPages?: number;
}

/**
 * DELIBERATELY ABSENT: a `status` filter. The domain `open` fans out to three
 * Paperclip statuses (`backlog`, `todo`, `blocked`), the list filter is proven
 * only for a SINGLE value, which is why `PaperclipIssueListQuery.status` types
 * a single value and no array form exists to offer —
 * with the added hazard that an unrecognized status is a silent `200 []` rather
 * than a 400. Offering the filter would mean silently losing rows. Add it when
 * a probe pins the multi-value form.
 */
export interface MissionEngine {
  listMissions(opts?: ListMissionsOptions): PaperclipFetch<ProjectedMission[]>;
  getMission(missionId: string, opts?: MissionEngineOptions): PaperclipFetch<ProjectedMission>;
  createMission(mission: Mission, opts?: MissionEngineOptions): PaperclipFetch<ProjectedMission>;
  createSubtask(
    parentMissionId: string,
    mission: Mission,
    opts?: MissionEngineOptions,
  ): PaperclipFetch<ProjectedMission>;
  setStatus(
    missionId: string,
    status: MissionStatus,
    opts?: MissionEngineOptions,
  ): PaperclipFetch<ProjectedMission>;
  completeMission(missionId: string, comment: string, opts?: MissionEngineOptions): PaperclipFetch<void>;
  reassign(
    missionId: string,
    ownerAgent: string,
    opts?: MissionEngineOptions,
  ): PaperclipFetch<ProjectedMission>;
  comment(missionId: string, body: string, opts?: MissionEngineOptions): PaperclipFetch<void>;
}
