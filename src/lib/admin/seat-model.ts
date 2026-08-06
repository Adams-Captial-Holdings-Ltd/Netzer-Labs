/**
 * Seat administration domain model.
 *
 * Absorbed from PR #42 (jayleaton's seat/workspace design), trimmed to the
 * pieces that fit the self-host direction: seats, seat policies, and per-seat
 * Bedrock usage attribution. The EC2-workspace entities (Workspace,
 * WorkspaceImage, per-workspace connection details) were deliberately NOT
 * ported — see the PR #42 close-out note; the WorkspaceRuntime concept is
 * parked, not rejected.
 *
 * A Seat binds a dashboard user (users-table userId) to a SeatPolicy. The
 * policy names what the seat may consume (models, tools, monthly spend); the
 * SeatUsage rows are the attribution trail the spend-ledger wiring (issue #15)
 * writes into. Nothing in this module talks to storage — see seat-repo.
 */

export type SeatStatus = 'invited' | 'active' | 'suspended' | 'retired';
export type PolicyOutcome = 'allowed' | 'denied';

export const SEAT_STATUSES: readonly SeatStatus[] = [
  'invited',
  'active',
  'suspended',
  'retired',
];

export function isSeatStatus(v: unknown): v is SeatStatus {
  return typeof v === 'string' && (SEAT_STATUSES as readonly string[]).includes(v);
}

/** One page of a cursor-paginated list. */
export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

export interface Seat {
  seatId: string;
  /** users-table userId this seat belongs to (one seat per user). */
  userId: string;
  status: SeatStatus;
  policyId: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

export interface SeatPolicy {
  policyId: string;
  label: string;
  /** Bedrock model ids this seat may invoke. Empty = policy denies all models. */
  allowedModels: string[];
  /** Monthly spend ceiling for the seat; enforced by the spend-ledger wiring. */
  monthlySpendLimitUsd?: number;
  /** Tool names this seat may use. Empty = no per-seat tool restriction yet. */
  allowedTools: string[];
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  updatedBy: string;
}

/**
 * One attributed Bedrock spend event. Written by the metering hook (spend
 * ledger, issue #15); the dashboard reads these per-day / per-seat. The
 * outcome is recorded for DENIED calls too, so a policy that blocks a model
 * leaves an audit trail rather than a silent gap.
 */
export interface SeatUsage {
  usageId: string;
  seatId: string;
  userId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  policyId: string;
  policyOutcome: PolicyOutcome;
  denialReason?: string;
  /** Originating session/turn identity when known (surface session id). */
  sessionId?: string;
  createdAt: string;
}
