/**
 * The only `MissionEngine` implementation (C-9: two files, never three —
 * `disabled-mission-engine.ts` does not exist because the kill switch lives
 * inside the transport and the rollout flag lives at the router).
 *
 * THIS FILE PROJECTS, IT DOES NOT RE-DERIVE. Every status, priority and agent
 * translation is a call into `mission-projection.ts`. There is no second
 * mapping table here, which is a Phase 2 acceptance criterion and also the only
 * way the lossiness stays testable in one place.
 *
 * WHY SO MANY READS. Two proven facts shape the write paths below:
 *
 *   1. The ONLY responses whose ten projection fields are asserted on a live
 *      body are the issue DETAIL row and a list row (probe "route reachability:
 *      every documented integration point responds and the projection fields
 *      are present") and the release row (probe "A1-11"). The create response
 *      is asserted only for `id`, `updatedAt`, `assigneeAgentId` and
 *      `deduplicated`; the PATCH response is asserted for NOTHING at all.
 *   2. So a write returns a projection built from a subsequent detail read,
 *      never from the write's own response. That costs a round trip and buys
 *      the difference between a proven row and a guessed one.
 *
 * Delete the extra read the day a probe asserts the write bodies.
 */
import { logger } from '../../observability/logger.js';
import type { Mission, MissionStatus } from '../state/mission-tasks-repo.js';
import { createAgentIdMapCache, type AgentIdMapCache } from './agent-map.js';
import type { PaperclipClient } from './client.js';
import { PaperclipError } from './error.js';
import type { ListMissionsOptions, MissionEngine, MissionEngineOptions } from './mission-engine.js';
import {
  issueToMission,
  missionToIssueCreate,
  toIssueStatus,
  UnknownAgentError,
  type AgentIdMap,
  type ProjectedMission,
} from './mission-projection.js';
import type { PaperclipFetch, PaperclipIssueView } from './types.js';

export interface PaperclipMissionEngineDeps {
  client: PaperclipClient;
  /**
   * Injected so a test builds the map from a literal agent list. Defaults to a
   * cache that reads `GET /api/companies/{companyId}/agents` through the same
   * client, which means it rides the same kill switch and the same breaker.
   */
  agents?: AgentIdMapCache;
}

export function createPaperclipMissionEngine(deps: PaperclipMissionEngineDeps): MissionEngine {
  const client = deps.client;
  const agentCache = deps.agents ?? createAgentIdMapCache(() => client.listAgents());

  /**
   * ONE UNPROJECTABLE ROW MUST NOT BLANK A BOARD, so on a LIST every projection
   * failure is a row to skip and log. On a single-issue read it propagates,
   * because the caller asked for that issue.
   *
   * The catch is deliberately unnarrowed, and that width is the point.
   * `issueToMission` has three named failure modes today (`UnassignedIssueError`,
   * `UnknownAgentError`, and `toMissionStatus`'s throw on a status outside the
   * seven-member union) but the third is a plain `Error`, and the set grows on
   * an artifact bump: `PaperclipIssueStatus` is hand-transcribed from the
   * committed OpenAPI snapshot, so the day Paperclip adds an eighth status a
   * narrow catch turns ONE new row into a rejected `listMissions()` for the
   * WHOLE board. Named exception, same rule: a `PaperclipError` is transport,
   * not projection, and still propagates — losing the board silently because
   * the network died is the failure this skip must not manufacture.
   */
  function projectOrSkip(issue: PaperclipIssueView, agents: AgentIdMap): ProjectedMission | undefined {
    try {
      return issueToMission(issue, agents);
    } catch (err) {
      if (err instanceof PaperclipError) throw err;
      logger.warn(
        { issueId: issue.id, err: err instanceof Error ? err.message : String(err) },
        'paperclip issue has no Mission projection',
      );
      return undefined;
    }
  }

  async function project(missionId: string, opts: MissionEngineOptions): Promise<ProjectedMission> {
    const [issue, agents] = await Promise.all([client.getIssue(missionId, opts), agentCache()]);
    return issueToMission(issue, agents);
  }

  async function create(
    mission: Mission,
    opts: MissionEngineOptions,
    parentId?: string,
  ): Promise<ProjectedMission> {
    const agents = await agentCache();
    const body = {
      ...missionToIssueCreate(mission, agents, () => mission.id),
      ...(parentId ? { parentId } : {}),
      allowDuplicate: true,
    };
    const created = await client.createIssue(body, opts);
    return project(created.id, opts);
  }

  return {
    async listMissions(opts: ListMissionsOptions = {}): PaperclipFetch<ProjectedMission[]> {
      const agents = await agentCache();
      const assigneeAgentId = opts.ownerAgent === undefined ? undefined : toUuidOrThrow(opts.ownerAgent, agents);
      const page = await client.listIssues(
        {
          assigneeAgentId,
          updatedSince: opts.updatedSince,
          limit: opts.limit,
          // The one accepted value; anything else is a 400, proven by the probe
          // "A1-7: sortField accepts only `updated`, limit over the max is
          // clamped, limit<=0 is a 400".
          //
          // `sortDir` is NOT sent, and this sweep claims no ordering.
          // UNVERIFIED: no probe asserts the order of two returned rows in
          // either direction — A1-7 only proves `sortDir=asc` answers 200, and
          // A1-8 is this document's own warning that a 200 on a parameter
          // proves nothing about it being acted on. Sending a direction and
          // narrating "oldest change first" would be a claim with no probe
          // behind it; the caller dedupes on `(id, updatedAt)` regardless.
          sortField: 'updated',
        },
        { actor: opts.actor, runId: opts.runId },
      );
      // `maxPages: 1` IS THE ONE-PAGE READ, and it is a real mode rather than a
      // degenerate one. `paginateAll`'s loop is
      // `for (let seen = 1; page.hasMore; seen += 1) { if (seen >= maxPages) throw }`,
      // so passing 1 to it can only ever THROW on a non-empty board — it can
      // never return the page it just fetched. That made 1 an unusable value and
      // is why no caller passed it, so reading it here as "this page, then stop"
      // takes nothing away from anybody and adds the primitive the ACL's
      // single-Query legacy needs: ONE read, bounded by `limit`, no walk.
      //
      // Every other value keeps `paginateAll`'s all-or-throw contract exactly:
      // a caller that wants the WHOLE board must still get the whole board or an
      // error, never a short array that looks complete (A1-8).
      const issues = opts.maxPages === 1 ? [...page.nodes] : await page.paginateAll(opts.maxPages);
      return issues
        .map((issue) => projectOrSkip(issue, agents))
        .filter((mission): mission is ProjectedMission => mission !== undefined);
    },

    getMission(missionId, opts = {}) {
      return project(missionId, opts);
    },

    async createMission(mission: Mission, opts: MissionEngineOptions = {}): PaperclipFetch<ProjectedMission> {
      // A1-3 / ADR hard constraint 2: the id generator is INJECTED and returns
      // the Mission's own id. Nothing here mints one, and using the Mission id
      // makes the idempotency key deterministic - never random - which is what
      // A1-13 requires against the server's 7-day key retention.
      //
      // `allowDuplicate: true` is A1-13's mandatory flag AND the reason the
      // dedup citation is honest. The probe "A1-13: replaying an idempotencyKey
      // yields one issue and deduplicated: true" observed the 200 +
      // `deduplicated: true` replay for a body carrying BOTH `idempotencyKey`
      // and `allowDuplicate: true`, and varied neither - so it proves that pair,
      // not `idempotencyKey` alone. This write is auto-retried by
      // `client.ts`'s retry policy (idempotency-keyed writes are retryable), so
      // sending anything other than the shape the replay was proven on would be
      // betting an extra issue on an untested body.
      return create(mission, opts);
    },

    createSubtask(parentMissionId, mission, opts = {}) {
      return create(mission, opts, parentMissionId);
    },

    async setStatus(missionId, status: MissionStatus, opts = {}) {
      // The current assignee decides whether `open` projects to `todo` or
      // `backlog`, and whether `in_progress` is representable at all.
      const current = await client.getIssue(missionId, opts);
      await client.patchIssue(
        missionId,
        { status: toIssueStatus(status, Boolean(current.assigneeAgentId)) },
        opts,
      );
      return project(missionId, opts);
    },

    async reassign(missionId, ownerAgent, opts = {}) {
      const agents = await agentCache();
      await client.patchIssue(missionId, { assigneeAgentId: toUuidOrThrow(ownerAgent, agents) }, opts);
      return project(missionId, opts);
    },

    async comment(missionId, body, opts = {}) {
      await client.addComment(missionId, { body }, opts);
    },
  };
}

function toUuidOrThrow(slug: string, agents: AgentIdMap): string {
  const id = agents.toUuid(slug);
  if (!id) throw new UnknownAgentError({ slug }, agents.knownSlugs());
  return id;
}
