export interface Meeting {
  meetingId: string;
  createdBy: string;
  title: string;
  status: 'active' | 'ended';
  participants: string[];
  membershipVersion: number;
  toolPolicyOverride?: Record<string, boolean>;
  importMemoriesFrom?: string[];
  createdAt: string;
  endedAt?: string;
  // Denormalized list-view fields (set lazily on each turn, see
  // touchMeetingActivity): the first user message, so the room list can show
  // what a room is about instead of a repeated default title, and the last-turn
  // timestamp so rooms sort/label by recency rather than creation time.
  preview?: string;
  lastActivityAt?: string;
}

export interface WarroomTurn {
  meetingId: string;
  seq: number;
  speaker: string;
  type: 'user' | 'agent' | 'system';
  content: string;
  ts: string;
  agentId?: string;
}

export interface WarroomConnection {
  connectionId: string;
  meetingId: string;
  userId: string;
  connectedAt: string;
}

export interface WarroomEvent {
  type: 'turn' | 'participant_joined' | 'participant_left' | 'meeting_ended' | 'turn_aborted';
  meetingId: string;
  data: unknown;
  membershipVersion: number;
  seq: number;
}
