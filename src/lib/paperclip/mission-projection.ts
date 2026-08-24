import type { Mission, MissionStatus } from '../state/mission-tasks-repo.js';
import { MISSION_STATUSES } from '../state/mission-tasks-repo.js';

export type PaperclipIssueStatus =
  | 'backlog'
  | 'todo'
  | 'in_progress'
  | 'in_review'
  | 'blocked'
  | 'done'
  | 'cancelled';

export type PriorityBand = 'critical' | 'high' | 'medium' | 'low';

export interface PaperclipIssueView {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  status: PaperclipIssueStatus;
  priority: PriorityBand;
  assigneeAgentId: string | null;
  createdByAgentId: string | null;
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
export interface ProjectedMission extends Mission {
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

export function toPriorityBand(score: number): PriorityBand {
  const clamped = Math.max(0, Math.min(100, score));
  if (clamped >= 90) return 'critical';
  if (clamped >= 70) return 'high';
  if (clamped >= 40) return 'medium';
  return 'low';
}

/**
 * Total: the `default` is not dead code, it is the A2-17 guarantee. `priority`
 * is typed `PriorityBand`, but it arrives off a wire row, and without this rung
 * a band outside the four returns `undefined` from a function declared
 * `number` — which then flows into a `Mission.priority` and silently breaks
 * every comparison downstream. 50 is `medium`, the same value the missions repo
 * defaults to.
 */
export function toPriorityScore(priority: PriorityBand): number {
  switch (priority) {
    case 'critical': return 95;
    case 'high': return 80;
    case 'medium': return 50;
    case 'low': return 20;
    default: return 50;
  }
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
    priority: toPriorityBand(mission.priority),
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
    priority: toPriorityScore(issue.priority),
    status: toMissionStatus(issue.status),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    bodyTruncated: body.length >= 1200,
  };
}

/** Escapes Paperclip-owned text immediately before it is interpolated in a prompt. */
export function neutralizeForPrompt(text: string): string {
  return text.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}
