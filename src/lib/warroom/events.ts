/**
 * Per-meeting event channel for the text War Room.
 *
 * Monotonic seq, bounded ring buffer, per-meeting subscription.
 * SSE clients resume from sinceSeq; gap recovery via /history.
 * Ported from claudeclaw-os warroom-text-events.ts.
 */

import { EventEmitter } from 'node:events';

export type WarRoomEvent =
  | { type: 'turn_start'; turnId: string; speaker: string; content: string; ts: string }
  | { type: 'agent_typing'; agentId: string }
  | { type: 'agent_chunk'; agentId: string; delta: string }
  | { type: 'agent_done'; agentId: string; text: string; seq: number }
  | { type: 'turn_complete'; turnId: string }
  // seq is the persisted turn seq when the note was also written to history, so
  // the client can key it as `s<seq>` and dedupe it against the same note
  // arriving via /history polling. Omitted for purely transient notes.
  | { type: 'system_note'; text: string; seq?: number }
  | { type: 'meeting_ended'; meetingId: string }
  | { type: 'ping' };

export interface ChannelEntry {
  seq: number;
  ts: number;
  event: WarRoomEvent;
}

const MAX_BUFFER = 500;
const IDLE_EVICT_MS = 60 * 60 * 1000;

export class MeetingChannel {
  private seq = 0;
  private buffer: ChannelEntry[] = [];
  private readonly emitter = new EventEmitter();
  public lastActivityAt = Date.now();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  emit(event: WarRoomEvent): number {
    this.lastActivityAt = Date.now();
    const entry: ChannelEntry = { seq: ++this.seq, ts: Date.now(), event };
    this.buffer.push(entry);
    if (this.buffer.length > MAX_BUFFER) {
      this.buffer = this.buffer.slice(-MAX_BUFFER);
    }
    this.emitter.emit('event', entry);
    return entry.seq;
  }

  since(sinceSeq: number): ChannelEntry[] {
    return this.buffer.filter((e) => e.seq > sinceSeq);
  }

  subscribe(cb: (entry: ChannelEntry) => void): () => void {
    this.lastActivityAt = Date.now();
    this.emitter.on('event', cb);
    return () => this.emitter.off('event', cb);
  }

  get latestSeq(): number {
    return this.seq;
  }

  get listenerCount(): number {
    return this.emitter.listenerCount('event');
  }
}

const channels = new Map<string, MeetingChannel>();

export function getChannel(meetingId: string): MeetingChannel {
  let ch = channels.get(meetingId);
  if (!ch) {
    ch = new MeetingChannel();
    channels.set(meetingId, ch);
  }
  return ch;
}

export function removeChannel(meetingId: string): void {
  channels.delete(meetingId);
}

// Idle sweeper: evict channels with no listeners and no activity for 1h
setInterval(() => {
  const now = Date.now();
  for (const [id, ch] of channels) {
    if (ch.listenerCount === 0 && now - ch.lastActivityAt > IDLE_EVICT_MS) {
      channels.delete(id);
    }
  }
}, 5 * 60 * 1000).unref();
