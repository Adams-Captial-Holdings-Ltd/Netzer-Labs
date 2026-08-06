import { useState, useEffect, useRef } from 'preact/hooks';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { getToken, api } from '../lib/api';
import { hasCapability } from '../lib/auth';
import { Button } from '../components/Button';
import { EmptyState } from '../components/EmptyState';
import { EmptyWarRoom } from '../components/Icons';
import { toast } from '../components/Toast';

// Render agent markdown the same way the rest of the dashboard does
// (Chat/Playground/AgentDetail): marked for GFM, DOMPurify to strip anything
// unsafe. The `.chat-md` class styles the output (see index.css). Agents reply
// in markdown (bold, lists, headers), so without this the room showed raw
// `**text**` and `- bullets`.
function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false, gfm: true, breaks: true });
  return DOMPurify.sanitize(html);
}

// Client-side mirror of the server's parseMentions (orchestrator.ts) so the
// composer can show "<agent> is typing…" for exactly the agents that will
// answer. Best-effort: if it's slightly off, the indicator clears when the real
// replies land or after the timeout. Capped at MAX_PARTICIPANTS_PER_TURN (5).
function expectedResponders(text: string, participants: string[]): string[] {
  if (!participants.length) return [];
  let targeted: string[];
  if (/(?:^|[^\w])@(?:all|everyone|room)\b/i.test(text)) {
    targeted = [...participants];
  } else {
    targeted = participants.filter((p) => {
      const esc = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?:^|[^\\w])@${esc}\\b`, 'i').test(text);
    });
  }
  return (targeted.length ? targeted : participants).slice(0, 5);
}

// Numeric seq of a committed turn id (`s<seq>`), or -1 for optimistic/live ids.
function seqOfId(id: string): number {
  return id.startsWith('s') ? Number(id.slice(1)) : -1;
}

// Pull a human-readable error out of a non-2xx fetch Response. Prefers the
// JSON { error } body the war room routes return, falls back to the status line.
async function responseError(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.clone().json();
    if (data && typeof data.error === 'string' && data.error) return data.error;
  } catch { /* not JSON */ }
  return res.statusText ? `${fallback} (${res.status} ${res.statusText})` : `${fallback} (${res.status})`;
}

interface Room {
  id: string;
  topic?: string;
  agents: string[];
  status: 'live' | 'ended';
  createdAt?: string;
  lastActivityAt?: string;
  preview?: string;
}

// Wire shape of GET /warroom -> { meetings }. Mirrors Meeting in
// src/lib/warroom/meetings-repo.ts: the id is `meetingId`, the topic is
// `title`, participants are the agents, and status is 'active' | 'ended'.
interface Meeting {
  meetingId: string;
  title?: string;
  participants?: string[];
  status?: 'active' | 'ended';
  createdAt?: string;
  lastActivityAt?: string;
  preview?: string;
}

function meetingToRoom(m: Meeting): Room {
  return {
    id: m.meetingId,
    topic: m.title,
    agents: m.participants ?? [],
    status: m.status === 'ended' ? 'ended' : 'live',
    createdAt: m.createdAt,
    lastActivityAt: m.lastActivityAt,
    preview: m.preview,
  };
}

interface WRMessage {
  id: string;
  from: string;
  type: 'user' | 'agent' | 'system';
  text: string;
  ts: number;
  /** True while an agent reply is still streaming in. */
  streaming?: boolean;
}

// Wire shape of one /history turn.
interface HistoryTurn {
  seq: number;
  speaker: string;
  type: 'user' | 'agent' | 'system';
  content: string;
  ts?: string;
  agentId?: string;
}

// A committed (persisted) turn keys as `s<seq>`, so the same turn arriving from
// the SSE stream AND from /history polling collapses to one bubble.
function turnToMessage(t: HistoryTurn): WRMessage {
  return {
    id: `s${t.seq}`,
    from: t.type === 'agent' ? (t.agentId || t.speaker) : t.speaker,
    type: t.type,
    text: t.content,
    ts: Date.parse(t.ts ?? '') || Date.now(),
  };
}

/**
 * Merge committed (persisted) turns into the current message list. This is the
 * single reconcile path for the SSE echo, the agent_done finaliser, the initial
 * history load, AND the /history poll, so every source agrees:
 *  - committed turns dedupe by their `s<seq>` id (never doubled),
 *  - a just-sent optimistic user bubble (`local:`) is dropped once its committed
 *    twin (same text) lands, so the message never flickers or duplicates,
 *  - a streaming `live:<agent>` bubble is dropped once that agent's committed
 *    reply lands, so a stalled SSE stream can't leave a stuck "typing…".
 */
function reconcileMessages(prev: WRMessage[], incoming: WRMessage[]): WRMessage[] {
  const byId = new Map(prev.map((m) => [m.id, m]));
  const finishedAgents = new Set<string>();
  const localsToDrop = new Set<string>();

  for (const m of incoming) {
    if (byId.has(m.id)) continue;
    byId.set(m.id, m);
    if (m.type === 'agent') finishedAgents.add(m.from);
    if (m.type === 'user') {
      // Retire exactly one matching optimistic bubble (one-to-one, so sending
      // the same text twice still shows two messages).
      for (const c of byId.values()) {
        if (c.id.startsWith('local:') && !localsToDrop.has(c.id) && c.text.trim() === m.text.trim()) {
          localsToDrop.add(c.id);
          break;
        }
      }
    }
  }

  const out: WRMessage[] = [];
  for (const m of byId.values()) {
    if (localsToDrop.has(m.id)) continue;
    if (m.id.startsWith('live:') && finishedAgents.has(m.from)) continue;
    out.push(m);
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

// Compact relative time for the room list ("just now", "5m ago", date).
function timeAgo(iso?: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(t).toLocaleDateString();
}

// What to title a room row: the first message (most useful), else a meaningful
// custom topic, else a neutral placeholder — never a wall of identical defaults.
function roomTitle(r: Room): string {
  const preview = r.preview?.trim();
  if (preview) return preview;
  const topic = r.topic?.trim();
  if (topic && topic.toLowerCase() !== 'war room') return topic;
  return 'Untitled room';
}

export function WarRoom() {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [selectedRoom, setSelectedRoom] = useState<string | null>(null);
  const [messages, setMessages] = useState<WRMessage[]>([]);
  const [input, setInput] = useState('');
  const [topic, setTopic] = useState('');
  const [selectedAgents, setSelectedAgents] = useState<string[]>(['main', 'ops']);
  const [availableAgents, setAvailableAgents] = useState<{ id: string; displayName: string }[]>([]);
  const [creating, setCreating] = useState(false);
  const [ending, setEnding] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // Which agents we're waiting on for the current turn, so we can show a
  // per-agent "typing…" placeholder until each replies (or is blocked, or the
  // timeout fires). sinceSeq pins this to the current round.
  const [pending, setPending] = useState<{ agents: string[]; sinceSeq: number; startedAt: number } | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  // The room whose transcript is currently on screen. Async work started for
  // an earlier room (history fetch, straggler SSE events) checks this before
  // touching `messages`, so switching rooms quickly can't merge Room A's
  // transcript into Room B's view.
  const activeRoomRef = useRef<string | null>(null);
  const localSeq = useRef(0);

  // War Room mutations (create/turn/end/delete) require agents:write server-side,
  // so the write controls (End Session, Delete) are hidden for principals who
  // lack it (re-checked on the backend regardless).
  const canWrite = hasCapability('agents:write');

  const selectedRoomObj = rooms.find((r) => r.id === selectedRoom);
  const selectedStatus = selectedRoomObj?.status;

  // Agents still composing a reply for the current turn → one typing bubble
  // each. Derived (not stored): an agent drops out once it has a committed reply
  // newer than pending.sinceSeq, a block note names it, or it already has a live
  // streaming bubble (so SSE chunks and the placeholder never double up).
  const typingAgents = (() => {
    if (!pending) return [] as string[];
    const replied = new Set(
      messages.filter((m) => m.type === 'agent' && seqOfId(m.id) > pending.sinceSeq).map((m) => m.from),
    );
    const blocked = new Set(
      messages
        .filter((m) => m.type === 'system' && seqOfId(m.id) > pending.sinceSeq)
        .map((m) => /^(\S+)'s reply was blocked/.exec(m.text)?.[1])
        .filter((x): x is string => !!x),
    );
    const live = new Set(messages.filter((m) => m.id.startsWith('live:')).map((m) => m.from));
    return pending.agents.filter((a) => !replied.has(a) && !blocked.has(a) && !live.has(a));
  })();

  useEffect(() => {
    loadRooms();
    api.get<{ agents: { id: string; displayName: string }[] }>('/agents')
      .then((d) => setAvailableAgents(d.agents))
      .catch(() => {});
    return () => { eventSourceRef.current?.close(); };
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Clear the typing indicator once every expected agent has answered (or been
  // blocked), or after a hard timeout so it can never get stuck. Polling
  // re-renders messages every tick, so the timeout still fires if no reply ever
  // lands.
  useEffect(() => {
    if (!pending) return;
    if (typingAgents.length === 0 || Date.now() - pending.startedAt > 90_000) setPending(null);
  }, [messages, pending]);

  // History polling — the RELIABLE transport. The SSE stream is a latency
  // nicety, but `text/event-stream` is buffered by the edge/proxy in front of
  // the API, so it often never reaches the browser. Polling /history (plain
  // JSON, always delivered) as the source of truth is what makes the room show
  // the user's message and the agents' replies regardless of whether SSE works.
  // Only poll live rooms (ended rooms gain no turns; the initial load covers
  // them). We skip the fetch while the tab is hidden to save work, but the
  // browser also throttles background timers — so on its own that would leave a
  // backgrounded room stale (the replies, even a stuck "typing…") until the next
  // un-throttled tick. The visibilitychange handler fixes that: the moment the
  // tab comes back to the foreground we fetch immediately, so returning to a
  // room is always instantly up to date.
  useEffect(() => {
    if (!selectedRoom || selectedStatus === 'ended') return;
    const roomId = selectedRoom;
    let cancelled = false;
    const tick = async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      try {
        const res = await fetch(`/api/warroom/${roomId}/history`, {
          headers: { Authorization: `Bearer ${getToken()}` },
        });
        if (!res.ok || cancelled) return;
        const data = await res.json();
        const turns: HistoryTurn[] = data.turns ?? [];
        if (cancelled) return;
        setMessages((prev) => reconcileMessages(prev, turns.map(turnToMessage)));
      } catch { /* transient — the next tick retries */ }
    };
    const id = setInterval(tick, 2500);
    const onVisible = () => { if (!document.hidden) void tick(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [selectedRoom, selectedStatus]);

  async function loadRooms() {
    try {
      const token = getToken();
      // Router is mounted at /api/warroom; GET / lists meetings.
      const res = await fetch('/api/warroom', {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        const meetings: Meeting[] = data.meetings ?? [];
        setRooms(meetings.map(meetingToRoom));
      } else if (res.status !== 404) {
        // 404 = endpoint genuinely absent (stay quiet); anything else is a real
        // failure the operator should see rather than an empty room list.
        toast('Could not load war rooms', 'error');
      }
    } catch { toast('Could not load war rooms', 'error'); }
  }

  async function openRoom(roomId: string) {
    eventSourceRef.current?.close();
    activeRoomRef.current = roomId;
    setSelectedRoom(roomId);
    setMessages([]);
    setConfirmDelete(null);
    setPending(null);
    const token = getToken();

    // SSE is opened as a best-effort streaming layer. Everything it delivers is
    // reconciled by message id, so if it never delivers (edge buffering) the
    // /history poll above still drives the room. We attach it first so any
    // events between the history snapshot and now are captured.
    const es = new EventSource(`/api/warroom/${roomId}/stream?token=${token}`);
    es.onmessage = (e) => {
      // A superseded stream (user already clicked another room) must not
      // write into the room that is now on screen.
      if (eventSourceRef.current !== es || activeRoomRef.current !== roomId) return;
      try {
        const event = JSON.parse(e.data);
        switch (event.type) {
          // The human turn echoed back — reconcile so the optimistic bubble we
          // already showed collapses into the committed one.
          case 'turn_start': {
            const speaker = String(event.speaker ?? 'user');
            setMessages((prev) => reconcileMessages(prev, [{
              id: `s${event.turnId}`,
              from: speaker,
              type: speaker === 'system' ? 'system' : 'user',
              text: String(event.content ?? ''),
              ts: Date.parse(event.ts ?? '') || Date.now(),
            }]));
            break;
          }
          // An agent started composing — show a typing bubble.
          case 'agent_typing': {
            const agentId = String(event.agentId);
            setMessages((prev) =>
              prev.some((m) => m.id === `live:${agentId}`)
                ? prev
                : [...prev, { id: `live:${agentId}`, from: agentId, type: 'agent', text: '', ts: Date.now(), streaming: true }],
            );
            break;
          }
          // Streamed delta — append to that agent's live bubble.
          case 'agent_chunk': {
            const agentId = String(event.agentId);
            const delta = String(event.delta ?? '');
            setMessages((prev) => {
              const id = `live:${agentId}`;
              if (!prev.some((m) => m.id === id)) {
                return [...prev, { id, from: agentId, type: 'agent', text: delta, ts: Date.now(), streaming: true }];
              }
              return prev.map((m) => (m.id === id ? { ...m, text: m.text + delta } : m));
            });
            break;
          }
          // Reply finished — reconcile drops the live bubble and commits `s<seq>`.
          case 'agent_done': {
            const agentId = String(event.agentId);
            setMessages((prev) => reconcileMessages(prev, [{
              id: `s${Number(event.seq)}`,
              from: agentId,
              type: 'agent',
              text: String(event.text ?? ''),
              ts: Date.now(),
            }]));
            break;
          }
          case 'system_note': {
            // Keyed by seq when the note was persisted, so it dedupes against the
            // same note arriving via /history; transient notes fall back to a
            // unique id.
            const seq = Number(event.seq);
            const id = Number.isFinite(seq) && seq > 0 ? `s${seq}` : `sys-${Date.now()}-${Math.round(performance.now())}`;
            setMessages((prev) => reconcileMessages(prev, [{
              id, from: 'system', type: 'system', text: String(event.text ?? ''), ts: Date.now(),
            }]));
            break;
          }
          // Round finished — drop any leftover streaming bubble. A normal reply
          // was already swapped for its committed `s<seq>` by agent_done; anything
          // still in a `live:` state didn't finish normally (blocked or errored)
          // and its outcome arrives as a system note, so clear the stale bubble.
          case 'turn_complete': {
            setMessages((prev) => prev.filter((m) => !m.id.startsWith('live:')));
            break;
          }
          case 'meeting_ended': {
            setMessages((prev) => [...prev, { id: `ended-${Date.now()}`, from: 'system', type: 'system', text: 'Meeting ended.', ts: Date.now() }]);
            break;
          }
        }
      } catch { /* skip malformed event */ }
    };
    es.onerror = () => { /* EventSource auto-reconnects; polling covers the gap */ };
    eventSourceRef.current = es;

    // Load the past transcript and merge it under whatever the stream/poll have
    // delivered (by message id, so nothing is dropped or duplicated).
    try {
      const res = await fetch(`/api/warroom/${roomId}/history`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      // If the user already switched rooms, this response belongs to a room
      // that is no longer displayed; merging it would corrupt the new room's
      // transcript.
      if (activeRoomRef.current !== roomId) return;
      if (res.ok) {
        const data = await res.json();
        const turns: HistoryTurn[] = data.turns ?? [];
        if (activeRoomRef.current !== roomId) return;
        setMessages((prev) => reconcileMessages(prev, turns.map(turnToMessage)));
      } else if (res.status !== 404) {
        toast('Could not load the room transcript', 'error');
      }
    } catch { toast('Could not load the room transcript', 'error'); }
  }

  async function createRoom() {
    setCreating(true);
    try {
      const token = getToken();
      // POST / creates a meeting; body is { title, participants }. The created
      // Meeting (with meetingId) is returned directly.
      const res = await fetch('/api/warroom', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: topic, participants: selectedAgents }),
      });
      if (res.ok) {
        const meeting: Meeting = await res.json();
        setTopic('');
        await loadRooms();
        if (meeting.meetingId) openRoom(meeting.meetingId);
      } else {
        const msg = await res.json().then((b) => b?.detail || b?.error || `HTTP ${res.status}`).catch(() => `HTTP ${res.status}`);
        toast(`Could not create room. ${msg}`, 'error');
      }
    } catch { toast('Could not create room. Network error', 'error'); }
    setCreating(false);
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || !selectedRoom) return;
    const token = getToken();
    const roomId = selectedRoom;

    // Optimistic render: show the message instantly so the room never feels
    // dead while the POST + agent round-trip runs. The SSE echo or the next
    // /history poll supersedes this bubble (same text => reconciled away).
    const localId = `local:${++localSeq.current}`;
    setMessages((prev) => [...prev, { id: localId, from: 'dashboard', type: 'user', text, ts: Date.now() }]);
    setInput('');
    setSending(true);

    // Show "<agent> is typing…" for the agents that will answer. sinceSeq is the
    // latest committed turn BEFORE this send, so a prior round's replies can't
    // clear this round's indicator.
    const agents = rooms.find((r) => r.id === roomId)?.agents ?? [];
    const expecting = expectedResponders(text, agents);
    const baselineSeq = messages.reduce((mx, m) => {
      const n = seqOfId(m.id);
      return n > mx ? n : mx;
    }, 0);
    if (expecting.length) setPending({ agents: expecting, sinceSeq: baselineSeq, startedAt: Date.now() });

    try {
      const res = await fetch(`/api/warroom/${roomId}/turn`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ speaker: 'dashboard', content: text }),
      });
      if (!res.ok) {
        const msg = await res.json().then((b) => b?.detail || b?.error || `HTTP ${res.status}`).catch(() => `HTTP ${res.status}`);
        toast(`Message not sent. ${msg}`, 'error');
        // Roll back the optimistic bubble + typing indicator and restore the
        // text so the user can retry.
        setMessages((prev) => prev.filter((m) => m.id !== localId));
        setInput(text);
        setPending(null);
        setSending(false);
        return;
      }
      // Refresh the list so the row's preview/timestamp reflect this message.
      void loadRooms();
    } catch {
      toast('Message not sent. Network error', 'error');
      setMessages((prev) => prev.filter((m) => m.id !== localId));
      setInput(text);
      setPending(null);
    }
    setSending(false);
  }

  // End the open room. POST /:id/end is gated agents:write server-side. On
  // success we refresh the list (so its badge flips to "ended") and re-open the
  // same room so the now-disabled composer reflects the new state.
  async function endRoom() {
    if (!selectedRoom) return;
    setEnding(true);
    try {
      const res = await fetch(`/api/warroom/${selectedRoom}/end`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
      });
      if (res.ok) {
        toast('Session ended', 'success');
        const ended = selectedRoom;
        await loadRooms();
        openRoom(ended);
      } else {
        const msg = await responseError(res, 'Could not end session');
        toast(msg, 'error');
      }
    } catch {
      toast('Could not end session. Network error', 'error');
    }
    setEnding(false);
  }

  // Permanently delete a room. DELETE /:id is gated agents:write server-side and
  // is idempotent, so we drop the row optimistically on success.
  async function deleteRoom(roomId: string) {
    setDeletingId(roomId);
    try {
      const res = await fetch(`/api/warroom/${roomId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (res.ok) {
        toast('Room deleted', 'success');
        if (selectedRoom === roomId) {
          eventSourceRef.current?.close();
          activeRoomRef.current = null;
          setSelectedRoom(null);
          setMessages([]);
        }
        setRooms((prev) => prev.filter((r) => r.id !== roomId));
      } else {
        const msg = await responseError(res, 'Could not delete room');
        toast(msg, 'error');
      }
    } catch {
      toast('Could not delete room. Network error', 'error');
    }
    setDeletingId(null);
    setConfirmDelete(null);
  }

  return (
    <div class="flex flex-col h-[calc(100vh-var(--header-height)-3rem)]">
      <div class="mb-4">
        <h1 data-tour="warroom-title" class="text-display-sm text-primary font-bold">War Room</h1>
        <p class="text-body-sm text-secondary mt-1">Multi-agent collaborative sessions</p>
      </div>

      <div class="flex-1 flex gap-4 min-h-0">
        <div class="w-72 bg-surface border border-border rounded-xl flex flex-col shrink-0">
          <div data-tour="warroom-new-room" class="p-4 border-b border-border">
            <h3 class="text-heading-sm font-semibold mb-3">Rooms</h3>
            <div class="space-y-2">
              <input
                value={topic}
                onInput={(e) => setTopic((e.target as HTMLInputElement).value)}
                placeholder="Room topic (optional)..."
                class="w-full bg-bg-elevated border border-border rounded-lg px-3 py-1.5 text-body-sm outline-none focus:ring-2 focus:ring-primary/50 placeholder:text-muted"
              />
              <div class="flex flex-wrap gap-1.5 mb-1">
                {availableAgents.map((a) => {
                  const sel = selectedAgents.includes(a.id);
                  return (
                    <button
                      key={a.id}
                      onClick={() => setSelectedAgents(sel ? selectedAgents.filter((x) => x !== a.id) : [...selectedAgents, a.id])}
                      class={`px-2 py-0.5 rounded-full text-caption font-medium transition-colors ${sel ? 'bg-primary text-inverse' : 'bg-bg-elevated text-secondary border border-border hover:border-primary'}`}
                    >
                      {a.displayName}
                    </button>
                  );
                })}
              </div>
              <Button variant="primary" size="sm" class="w-full" loading={creating} disabled={selectedAgents.length === 0} onClick={createRoom}>
                Create Room
              </Button>
            </div>
          </div>
          <div data-tour="warroom-rooms" class="flex-1 overflow-y-auto p-2 space-y-1">
            {rooms.map((r) => {
              const isSel = selectedRoom === r.id;
              const confirming = confirmDelete === r.id;
              return (
                <div key={r.id} class="group relative">
                  <button
                    onClick={() => openRoom(r.id)}
                    class={`w-full text-left px-3 py-2.5 pr-9 rounded-lg transition-colors
                      ${isSel ? 'bg-primary/10' : 'hover:bg-surface-hover'}`}
                  >
                    <div class="flex items-center gap-2">
                      {r.status === 'live'
                        ? <span class="w-1.5 h-1.5 rounded-full bg-success shrink-0" title="Active" />
                        : <span class="text-overline text-muted uppercase tracking-wide shrink-0">ended</span>}
                      <span class={`truncate text-body-sm font-medium ${isSel ? 'text-primary' : 'text-primary'}`}>
                        {roomTitle(r)}
                      </span>
                    </div>
                    <p class="text-caption text-muted mt-0.5 truncate">
                      {timeAgo(r.lastActivityAt ?? r.createdAt)}
                      {r.agents?.length ? ` · ${r.agents.join(', ')}` : ''}
                    </p>
                  </button>

                  {canWrite && !confirming && (
                    <button
                      type="button"
                      title="Delete room"
                      aria-label="Delete room"
                      onClick={(e) => { e.stopPropagation(); setConfirmDelete(r.id); }}
                      class="absolute top-2 right-1.5 p-1 rounded-md text-muted opacity-0 group-hover:opacity-100 hover:text-danger hover:bg-danger/10 transition-all"
                    >
                      <svg class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6" />
                      </svg>
                    </button>
                  )}

                  {confirming && (
                    <div class="absolute inset-0 flex items-center gap-2 px-3 bg-surface/95 backdrop-blur-sm rounded-lg border border-danger/30">
                      <span class="text-caption text-secondary mr-auto truncate">Delete this room?</span>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setConfirmDelete(null); }}
                        class="text-caption text-muted hover:text-primary px-1.5 py-0.5"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); deleteRoom(r.id); }}
                        disabled={deletingId === r.id}
                        class="text-caption font-medium text-danger hover:bg-danger/10 rounded px-1.5 py-0.5 disabled:opacity-50"
                      >
                        {deletingId === r.id ? 'Deleting…' : 'Delete'}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            {rooms.length === 0 && (
              <p class="text-caption text-muted text-center py-4">No rooms yet</p>
            )}
          </div>
        </div>

        <div data-tour="warroom-chat" class="flex-1 flex flex-col bg-surface border border-border rounded-xl min-w-0">
          {selectedRoom ? (
            <>
              <div class="px-4 py-3 border-b border-border flex items-center gap-2">
                <span class={`w-2 h-2 rounded-full ${selectedStatus === 'live' ? 'bg-success' : 'bg-muted'}`} />
                <span class="text-body-sm font-medium text-primary truncate">
                  {selectedRoomObj ? roomTitle(selectedRoomObj) : 'War Room'}
                </span>
                {selectedRoomObj?.agents?.length
                  ? <span class="text-caption text-muted truncate">· {selectedRoomObj.agents.join(', ')}</span>
                  : null}
                {selectedStatus === 'ended' && (
                  <span class="text-overline text-muted uppercase tracking-wide">ended</span>
                )}
                {canWrite && selectedStatus === 'live' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    class="ml-auto"
                    loading={ending}
                    onClick={endRoom}
                  >
                    End Session
                  </Button>
                )}
              </div>

              <div class="flex-1 overflow-y-auto p-4 space-y-3">
                {messages.length === 0 && (
                  <div class="h-full flex items-center justify-center">
                    <p class="text-caption text-muted text-center">
                      No messages yet. Say hello, or @tag an agent to start.
                    </p>
                  </div>
                )}
                {messages.map((m) => (
                  <div key={m.id ?? m.ts} class={`flex ${m.type === 'user' ? 'justify-end' : 'justify-start'}`}>
                    <div class={`max-w-[75%] rounded-xl px-4 py-3 text-body-sm
                      ${m.type === 'user'
                        ? 'bg-primary text-inverse rounded-br-sm'
                        : m.type === 'system'
                        ? 'bg-warning/10 text-warning border border-warning/20 rounded-bl-sm'
                        : 'bg-bg-sunken border border-border rounded-bl-sm'}`}>
                      {m.type !== 'user' && <p class="text-caption font-semibold mb-1">{m.from}</p>}
                      {m.streaming && !m.text
                        ? <span class="text-caption text-muted animate-pulse">typing…</span>
                        : m.type === 'agent'
                        ? <div class="chat-md break-words" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }} />
                        : <pre class="whitespace-pre-wrap font-sans break-words">{m.text}</pre>}
                    </div>
                  </div>
                ))}
                {typingAgents.map((a) => (
                  <div key={`typing-${a}`} class="flex justify-start">
                    <div class="max-w-[75%] rounded-xl px-4 py-3 bg-bg-sunken border border-border rounded-bl-sm">
                      <p class="text-caption font-semibold mb-1">{a}</p>
                      <span class="text-caption text-muted">is typing<span class="animate-pulse">…</span></span>
                    </div>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </div>

              {/* Composer: tag helper + input in one bordered block with clean
                  spacing (the old negative margin made the chips overlap the
                  input). The whole block is disabled once the room has ended. */}
              <div data-tour="warroom-composer" class="border-t border-border p-4 space-y-2">
                {selectedStatus === 'live' && selectedRoomObj?.agents?.length ? (
                  <div class="flex flex-wrap items-center gap-1.5">
                    <span class="text-caption text-muted mr-1">Tag an agent to direct your question:</span>
                    {selectedRoomObj.agents.map((a) => (
                      <button
                        key={a}
                        type="button"
                        onClick={() => setInput((v) => `${v.replace(/\s*$/, '')} @${a} `.replace(/^\s+/, ''))}
                        class="px-2 py-0.5 rounded-full text-caption font-medium bg-bg-elevated text-secondary border border-border hover:border-primary hover:text-primary transition-colors"
                      >
                        @{a}
                      </button>
                    ))}
                  </div>
                ) : null}
                <form
                  onSubmit={(e) => { e.preventDefault(); sendMessage(); }}
                  class="flex gap-3"
                >
                  <input
                    value={input}
                    onInput={(e) => setInput((e.target as HTMLInputElement).value)}
                    placeholder={selectedStatus === 'ended' ? 'This session has ended' : 'Message the room, or @tag an agent...'}
                    disabled={selectedStatus === 'ended'}
                    class="flex-1 bg-bg-elevated border border-border rounded-lg px-3 py-2 text-body-sm outline-none focus:ring-2 focus:ring-primary/50 placeholder:text-muted disabled:opacity-50 disabled:cursor-not-allowed"
                  />
                  <Button type="submit" loading={sending} disabled={!input.trim() || selectedStatus === 'ended'}>Send</Button>
                </form>
              </div>
            </>
          ) : (
            <div class="flex-1 flex items-center justify-center">
              <EmptyState
                icon={<EmptyWarRoom />}
                title="Select or create a room"
                description="War rooms enable real-time multi-agent collaboration."
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
