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
    case 'done': return 'done';
    case 'cancelled': return 'cancelled';
  }
}

export function toMissionStatus(status: PaperclipIssueStatus): MissionStatus {
  switch (status) {
    case 'backlog':
    case 'todo':
    case 'blocked': return 'open';
    case 'in_progress':
    case 'in_review': return 'in_progress';
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

export function toPriorityScore(priority: PriorityBand): number {
  switch (priority) {
    case 'critical': return 95;
    case 'high': return 80;
    case 'medium': return 50;
    case 'low': return 20;
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
  return {
    title: mission.title,
    description: mission.body,
    assigneeAgentId: uuidForSlug(mission.ownerAgent, agents),
    priority: toPriorityBand(mission.priority),
    status: toIssueStatus(mission.status, true),
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
