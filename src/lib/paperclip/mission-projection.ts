import type { Mission, MissionPriority, MissionStatus } from '../state/mission-tasks-repo.js';
import { MISSION_STATUSES } from '../state/mission-tasks-repo.js';

export type PaperclipIssueStatus =
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'blocked'
  | 'done'
  | 'cancelled';

export type PriorityBand = MissionPriority;

/**
 * `blockerAttention` AS IT ARRIVES ON A LIST ROW — eight keys, measured.
 *
 * Source: the P1-1 live characterization, staging Paperclip v2026.722.0,
 * 2026-09-06. It read `blockerAttention` on the full list row, on the
 * `view=compact` list row and on the detail, and recorded the object as
 * `{state, reason, unresolvedBlockerCount, coveredBlockerCount,
 * stalledBlockerCount, attentionBlockerCount, sampleBlockerIdentifier,
 * sampleStalledBlockerIdentifier}` with `state` in `none|needs_attention` and
 * `reason` in `null|attention_required`.
 *
 * DECLARED IS NOT READ. Only `state` and `reason` cross into a Mission (see
 * `MissionBlockerAttention`); the six others are typed here so this file
 * records the shape that was actually observed, and are optional because the
 * projection never requires one. The two SAMPLE keys carry Paperclip issue
 * IDENTIFIERS, which is the reason the wire crossing drops them rather than
 * merely ignoring them.
 */
export interface PaperclipBlockerAttention {
  state: string;
  reason: string | null;
  unresolvedBlockerCount?: number;
  coveredBlockerCount?: number;
  stalledBlockerCount?: number;
  attentionBlockerCount?: number;
  sampleBlockerIdentifier?: string | null;
  sampleStalledBlockerIdentifier?: string | null;
}

/** The two keys of `blockerAttention` a Mission carries. Identifier-free. */
export interface MissionBlockerAttention {
  state: string;
  reason: string | null;
}

/**
 * The additive hierarchy / blocking fields, declared ONCE and shared by the
 * projection and the wire crossing so the two cannot drift.
 *
 * EVERY FIELD IS OPTIONAL AND EVERY FIELD IS ADDITIVE. A row that carries
 * none of them serialises exactly as it did before P1-2, which is the
 * envelope-equality constraint Phase 7 acceptance 3 pins.
 *
 * WHAT IS DELIBERATELY ABSENT, and the deviation from the P1-2 plan text:
 * the plan asked for `blockedBy: [id]` on a list row. The 2026-09-06 P1-1 run
 * measured the 56-key list row and `blockedBy` IS NOT ON IT — it appears only
 * on `GET /api/issues/{id}` (70 keys), as an array of objects, not ids. A
 * list-row `blockedBy` would therefore have to be invented or fetched
 * per-row, so it is not shipped here; the list-row signal for dependency
 * state is `blockerAttention`. `children` and `childCount` were REFUTED on
 * every route that run read, which is why `childCount` below is DERIVED by
 * the ACL rather than read off the wire.
 */
export interface MissionHierarchyFields {
  /** The measured list row carries a uuid or an explicit `null` (a root row). */
  parentId?: string | null;
  /**
   * Paperclip's RAW status, alongside the narrowed domain `status`.
   *
   * These are two different facts on this artifact: the P1-1 run measured
   * Paperclip rewriting `status` to `blocked` after a run failed
   * (`errorCode: adapter_failed`), NOT from the dependency graph — an issue
   * with an unresolved `blockedByIssueIds` edge stayed `todo`. Anything that
   * reads `blocked` as "dependency-blocked" is wrong on this artifact; the
   * dependency signal is `blockerAttention`.
   */
  paperclipStatus?: string;
  blockerAttention?: MissionBlockerAttention;
}

export interface PaperclipIssueView {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  status: PaperclipIssueStatus;
  priority: PriorityBand;
  assigneeAgentId: string | null;
  createdByAgentId: string | null;
  /**
   * Measured on the live list row (full AND `view=compact`) and on the detail,
   * 2026-09-06: a uuid, or `null` for a root issue. The list filter
   * `?parentId=<uuid>` returns that row's children — and a MALFORMED value is
   * a 500, not a 4xx, so a caller must validate a uuid before sending one.
   */
  parentId?: string | null;
  /** Measured on the list row; see `PaperclipBlockerAttention`. */
  blockerAttention?: PaperclipBlockerAttention;
  createdAt: string;
  updatedAt: string;
}

export interface AgentIdMap {
  toUuid(slug: string): string | undefined;
  toSlug(uuid: string): string | undefined;
  knownSlugs(): readonly string[];
}

export interface CreateIssueBody {
  title: string;
  description?: string;
  assigneeAgentId?: string;
  /** Parent issue id; proven on the company issue-create route by the contract suite. */
  parentId?: string;
  priority?: PriorityBand;
  status?: PaperclipIssueStatus;
  idempotencyKey?: string;
}

/** A Mission view augmented with the identifiers Paperclip supplies. */
export interface ProjectedMission extends Mission, MissionHierarchyFields {
  identifier: string;
  /** The list projection may be capped; the detail path must refetch it. */
  bodyTruncated: boolean;
}

export class InvalidMissionStatusError extends Error {
  constructor(public readonly status: string) {
    super(`Invalid Mission status: ${status}`);
    this.name = 'InvalidMissionStatusError';
  }
}

export class InProgressMissionNeedsAssigneeError extends Error {
  constructor() {
    super('An in_progress Mission requires an assignee');
    this.name = 'InProgressMissionNeedsAssigneeError';
  }
}

export class UnknownAgentError extends Error {
  public readonly slug?: string;
  public readonly uuid?: string;

  constructor(agent: { slug: string } | { uuid: string }, public readonly knownSlugs: readonly string[]) {
    const isSlug = 'slug' in agent;
    const kind = isSlug ? 'slug' : 'uuid';
    const value = isSlug ? agent.slug : agent.uuid;
    super(`Unknown agent ${kind}: ${value}`);
    this.name = 'UnknownAgentError';
    if (kind === 'slug') this.slug = value;
    else this.uuid = value;
  }
}

export class UnassignedIssueError extends Error {
  constructor() {
    super('Paperclip issue has no assignee');
    this.name = 'UnassignedIssueError';
  }
}

function isMissionStatus(status: string): status is MissionStatus {
  return (MISSION_STATUSES as readonly string[]).includes(status);
}

export function toIssueStatus(status: MissionStatus | string, hasAssignee: boolean): PaperclipIssueStatus {
  if (!isMissionStatus(status)) throw new InvalidMissionStatusError(status);

  switch (status) {
    case 'open': return hasAssignee ? 'todo' : 'backlog';
    case 'in_progress':
      if (!hasAssignee) throw new InProgressMissionNeedsAssigneeError();
      return 'in_progress';
    // Phase 9. These two used to be UNREACHABLE from Netzar — the domain had
    // no such words, so a mission could be moved INTO in_review only by
    // Paperclip itself and never back. They pass straight through: the
    // engine's `assertTransition` validates the destination, and there is no
    // second Netzar spelling for either.
    //
    // NO ASSIGNEE CHECK ON EITHER, and that is not an oversight. The one on
    // `in_progress` exists because `backlog`/`todo` already encode "unowned",
    // so an unassigned in_progress row is a state Paperclip has no way to
    // express. `blocked` and `in_review` have no such unowned twin, so
    // refusing them without an assignee would refuse a state the engine can
    // hold — and in practice both arrive from `issueToMission`, which throws
    // `UnassignedIssueError` before a Mission exists at all.
    case 'blocked': return 'blocked';
    case 'in_review': return 'in_review';
    case 'done': return 'done';
    case 'cancelled': return 'cancelled';
  }
}

export function toMissionStatus(status: PaperclipIssueStatus): MissionStatus {
  switch (status) {
    // `backlog` and `todo` still BOTH fold to `open`: that collapse is real
    // and stays, because the split they encode is "has an assignee", which
    // `Mission.ownerAgent` already carries — `toIssueStatus` reconstructs it.
    case 'backlog':
    case 'todo': return 'open';
    case 'blocked': return 'blocked';
    case 'in_progress': return 'in_progress';
    case 'in_review': return 'in_review';
    case 'done': return 'done';
    case 'cancelled': return 'cancelled';
  }
  throw new Error(`Unsupported Paperclip issue status: ${String(status)}`);
}

function uuidForSlug(slug: string, agents: AgentIdMap): string {
  const uuid = agents.toUuid(slug);
  if (!uuid) throw new UnknownAgentError({ slug }, agents.knownSlugs());
  return uuid;
}

function slugForUuid(uuid: string, agents: AgentIdMap): string {
  const slug = agents.toSlug(uuid);
  if (!slug) throw new UnknownAgentError({ uuid }, agents.knownSlugs());
  return slug;
}

export function missionToIssueCreate(
  mission: Mission,
  agents: AgentIdMap,
  idGenerator: () => string,
): CreateIssueBody {
  // A1-13: `status` is DELIBERATELY OMITTED so the server default applies.
  //
  // WHAT IS OBSERVED. The probe "A1-17 (CHARACTERIZATION): boardMutationGuard
  // across all five write shapes with an agent key" posts a create body with no
  // `status` and records `boardMutationGuard["POST /api/companies/{companyId}
  // /issues"] = 201`; the unassigned row that same probe creates is then
  // checked out with `expectedStatuses: ['todo','backlog']` and recorded 200.
  // So omitting `status` is accepted, and an unassigned, status-omitted create
  // lands in ONE OF todo or backlog.
  //
  // WHAT IS UNVERIFIED. WHICH of the two, and what an ASSIGNED create defaults
  // to - the only branch this function ever takes, since `assigneeAgentId` is
  // mandatory below. No probe reads `.status` off a created row, and `backlog`
  // appears zero times in tests/contract/artifact-characterization.json. The
  // bar's "todo with an assignee, backlog without" is transcription, not
  // measurement; do not repeat it as fact. Producing it needs one probe that
  // asserts `createdIssue(...).status` and `createdUnassignedIssue(...).status`.
  //
  // Omitting is still the right call either way: no probe has ever SENT
  // `status` on a create, and the `listFilterValidation` characterization shows
  // an unrecognized status is a silent 200 rather than a 400 - so a wrong value
  // would not announce itself, and `project(created.id)` would report the
  // silently wrong state back as truth.
  return {
    title: mission.title,
    description: mission.body,
    assigneeAgentId: uuidForSlug(mission.ownerAgent, agents),
    priority: mission.priority,
    idempotencyKey: `netzar-mission:${idGenerator()}`,
  };
}

export function issueToMission(issue: PaperclipIssueView, agents: AgentIdMap): ProjectedMission {
  if (!issue.assigneeAgentId) throw new UnassignedIssueError();
  const body = issue.description ?? '';

  return {
    id: issue.id,
    identifier: issue.identifier,
    ownerAgent: slugForUuid(issue.assigneeAgentId, agents),
    // Paperclip permits an absent creator. Keep the legacy required field
    // populated with the stable integration source in that one lossy case.
    createdByAgent: issue.createdByAgentId ? slugForUuid(issue.createdByAgentId, agents) : 'paperclip',
    createdByChat: 'paperclip',
    title: issue.title,
    body,
    priority: issue.priority,
    status: toMissionStatus(issue.status),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    bodyTruncated: body.length >= 1200,
    // ── P1-2, additive and conditional ──────────────────────────────────
    // Spread rather than assigned, so a row WITHOUT the key produces a
    // projection without the key: `{parentId: undefined}` would serialise as
    // an absent key but is a PRESENT key to `in` and to `Object.keys`, and the
    // wire crossing keys off presence.
    ...(issue.parentId === undefined ? {} : { parentId: issue.parentId }),
    // Always present on a Paperclip row: `status` is required on the wire.
    paperclipStatus: issue.status,
    // EXPLICIT PICK, NEVER A SPREAD. The measured object has six more keys and
    // two of them (`sampleBlockerIdentifier`, `sampleStalledBlockerIdentifier`)
    // are Paperclip issue identifiers, which `toWireMission` drops for the same
    // reason it drops `identifier`.
    ...(issue.blockerAttention
      ? {
          blockerAttention: {
            state: issue.blockerAttention.state,
            reason: issue.blockerAttention.reason ?? null,
          },
        }
      : {}),
  };
}

/** Escapes Paperclip-owned text immediately before it is interpolated in a prompt. */
export function neutralizeForPrompt(text: string): string {
  return text.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
