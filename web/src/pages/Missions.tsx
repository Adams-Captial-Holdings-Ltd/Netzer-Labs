import { useState, useEffect } from 'preact/hooks';
import { api } from '../lib/api';
import { Skeleton } from '../components/Skeleton';
import { ErrorState } from '../components/ErrorState';
import { Select } from '../components/Select';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Modal } from '../components/Modal';
import { toast } from '../components/Toast';
import { statusLabel } from '../lib/glossary';
import { useAgentNames } from '../lib/useAgentNames';

// Mirrors the Mission row the missions repo returns (see
// src/lib/state/mission-tasks-repo.ts -> toMission). The owner agent is
// `ownerAgent` and the long-form text is `body`; assignmentReason/dueAt are
// optional and only present when the repo (Haiku auto-assign / due date) set
// them. Older callers referenced `owner`/`description` which never matched the
// wire shape, so the status route was building a path with `undefined` — kept
// the real field names here and derive the owner for the status route from
// `ownerAgent`.
interface Mission {
  id: string;
  ownerAgent: string;
  createdByAgent?: string;
  createdByChat?: string;
  title?: string;
  body?: string;
  priority?: number;
  status: string;
  assignmentReason?: string;
  dueAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

type Column = 'open' | 'in_progress' | 'blocked' | 'in_review' | 'done' | 'cancelled';
// These six labels — and the `P<priority>` badge below — are the user's
// vocabulary for a mission, and the chat surfaces now speak it too. The
// server-side copy lives in `src/lib/missions/format.ts` (MISSION_STATUS_LABEL,
// which cites this `COLUMNS` array by name rather than by line, so neither
// pointer goes stale when the other file moves); keep the two in step when
// changing either, the way `humanize.ts` and `Chat.tsx` point at each other for
// the turn footer.
//
// THERE IS A THIRD COPY AND IT IS ON THIS PAGE: `statusLabel()` in
// `web/src/lib/glossary.ts` renders the card badge and the detail drawer below,
// so a disagreement between it and this array puts two spellings of one status
// on one screen — which is exactly what happened ("In progress" there, "In
// Progress" here). Change one, change all three.
//
// THE LANE ORDER IS THE REPOSITORY OWNER'S DECISION and it is the same order
// as MISSION_STATUSES. `Blocked` and `In Review` are Paperclip statuses the
// board used to have no lane for, so the projection folded them into `open`
// and `in_progress` and a stalled mission was indistinguishable from an
// un-started one.
//
// Read left to right it is the STORY OF A TASK: you start it (Open), you work
// it (In Progress), you get stuck (Blocked), you unstick it and send it out
// (In Review), it lands (Done). It also leaves the four original lanes — Open,
// In Progress, Done, Cancelled — in their existing RELATIVE positions, so
// nobody has to relearn a board they already know.
//
// Nothing in web/ type-checks this array against the server's MissionStatus.
// The source scan in `src/lib/missions/format.test.ts` does, and it asserts
// this array's ORDER as well as its labels — an earlier six-lane pass put
// `Blocked` second here while every chat surface spoke it third, and a
// membership-only scan stayed green through it.
const COLUMNS: { key: Column; label: string; color: string }[] = [
  { key: 'open', label: 'Open', color: 'border-primary' },
  { key: 'in_progress', label: 'In Progress', color: 'border-warning' },
  { key: 'blocked', label: 'Blocked', color: 'border-danger' },
  { key: 'in_review', label: 'In Review', color: 'border-primary-light' },
  { key: 'done', label: 'Done', color: 'border-success' },
  { key: 'cancelled', label: 'Cancelled', color: 'border-muted' },
];

interface AgentSummary { id: string; displayName: string }

function fmtDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

// Sentinel owner value for the cross-fleet "All agents" view. The board is
// scoped to one owner server-side (GET /missions?owner=... -> listMissionsForAgent),
// so auto-assigned missions on other agents are otherwise invisible. There is no
// cross-agent list route, so this view aggregates each known agent's board
// client-side. Bounded by the agent count (and 100 rows/agent server-side).
const ALL_OWNERS = '__all__';

export function Missions() {
  const [missions, setMissions] = useState<Mission[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [owner, setOwner] = useState('main');
  const [loading, setLoading] = useState(true);
  // Distinct error state for the missions board fetch so a 403/500/network
  // failure shows ErrorState instead of an empty board. Cleared on each load.
  const [loadError, setLoadError] = useState(false);

  // Create-mission modal state.
  const [createOpen, setCreateOpen] = useState(false);
  const [createPrompt, setCreatePrompt] = useState('');
  const [createTitle, setCreateTitle] = useState('');
  const [createAgentId, setCreateAgentId] = useState('');
  const [creating, setCreating] = useState(false);

  // Detail / reassign modal state.
  const [detail, setDetail] = useState<Mission | null>(null);
  const [reassignTo, setReassignTo] = useState('');
  const [reassigning, setReassigning] = useState(false);

  const { nameFor } = useAgentNames();

  useEffect(() => {
    api.get<{ agents: AgentSummary[] }>('/agents').then((d) => setAgents(d.agents)).catch(() => {});
  }, []);

  function load() {
    setLoading(true);
    setLoadError(false);
    if (owner === ALL_OWNERS) {
      // No cross-agent list route exists, so aggregate each known agent's
      // per-owner board client-side into one merged board. Bounded by the agent
      // count; each per-owner call is itself capped at 100 rows server-side.
      // We need the agent list first; the separate /agents effect populates it,
      // and this load re-runs when `agents` arrives (see the effect deps).
      if (agents.length === 0) return; // wait for the agent list, keep spinner up
      Promise.all(
        agents.map((a) =>
          api
            .get<{ missions: Mission[] }>(`/missions?owner=${a.id}`)
            .then((d) => d.missions)
            .catch(() => [] as Mission[]),
        ),
      )
        .then((lists) => setMissions(lists.flat()))
        .catch(() => setLoadError(true))
        .finally(() => setLoading(false));
      return;
    }
    api.get<{ missions: Mission[] }>(`/missions?owner=${owner}`)
      .then((d) => setMissions(d.missions))
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, [owner, agents]);

  async function setStatus(m: Mission, status: string) {
    try {
      await api.post(`/missions/${m.ownerAgent}/${m.id}/status`, { status });
      toast(`Mission moved to ${status}`, 'success');
      load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
  }

  async function createMission() {
    const prompt = createPrompt.trim();
    if (!prompt) {
      toast('A prompt is required', 'error');
      return;
    }
    setCreating(true);
    try {
      // POST /api/missions per the MISSIONS contract: { prompt, agentId?, title? }.
      // Omit agentId entirely when blank so the backend runs Haiku auto-assign.
      // The handler wraps the created row as { mission } (201), so unwrap it.
      const body: { prompt: string; agentId?: string; title?: string } = { prompt };
      if (createAgentId) body.agentId = createAgentId;
      if (createTitle.trim()) body.title = createTitle.trim();
      const { mission: created } = await api.post<{ mission: Mission }>('/missions', body);
      toast(
        created?.ownerAgent
          ? `Mission created and assigned to ${created.ownerAgent}`
          : 'Mission created',
        'success',
      );
      setCreateOpen(false);
      setCreatePrompt('');
      setCreateTitle('');
      setCreateAgentId('');
      // If the new mission landed on the agent we're viewing, it shows on
      // reload; otherwise switch the board to its owner so the user sees it.
      if (created?.ownerAgent && created.ownerAgent !== owner) {
        setOwner(created.ownerAgent);
      } else {
        load();
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to create mission', 'error');
    } finally {
      setCreating(false);
    }
  }

  function openDetail(m: Mission) {
    setDetail(m);
    setReassignTo('');
  }

  async function reassignMission() {
    if (!detail || !reassignTo || reassignTo === detail.ownerAgent) return;
    setReassigning(true);
    try {
      // Reassign route is owner-scoped like the status route.
      await api.post(`/missions/${detail.ownerAgent}/${detail.id}/reassign`, { ownerAgent: reassignTo });
      toast(`Mission reassigned to ${reassignTo}`, 'success');
      setDetail(null);
      if (reassignTo !== owner) setOwner(reassignTo);
      else load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to reassign', 'error');
    } finally {
      setReassigning(false);
    }
  }

  // Which lane a mission is drawn in. NOT a bare `m.status === col`: that
  // filtered by EXACT EQUALITY with no fallback, so any status without a
  // column vanished from the board entirely — no lane, no count, no error.
  // That is how `blocked` would have disappeared had the projection started
  // emitting it before this array grew, and it is still live for an EIGHTH
  // Paperclip status arriving on an artifact bump. Every mission now lands in
  // exactly one lane because `laneFor` is total; an unrecognized status falls
  // to the first lane, where its badge still prints the raw word (statusLabel
  // humanizes anything, and the `title` attribute carries the exact value).
  const laneFor = (status: string): Column =>
    COLUMNS.find((c) => c.key === status)?.key ?? COLUMNS[0].key;

  function getMissionsForColumn(col: Column): Mission[] {
    return missions.filter((m) => laneFor(m.status) === col);
  }

  const statusBadgeVariant = (s: string) => {
    if (s === 'done') return 'success' as const;
    if (s === 'in_progress' || s === 'in_review') return 'warning' as const;
    if (s === 'blocked') return 'danger' as const;
    if (s === 'cancelled') return 'muted' as const;
    return 'info' as const;
  };

  const agentOptions = agents.map((a) => ({ value: a.id, label: a.displayName }));

  return (
    <div>
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 data-tour="missions-title" class="text-display-sm text-primary font-bold">Missions</h1>
          <p class="text-body-sm text-secondary mt-1">Task tracking across agents</p>
        </div>
        <div data-tour="missions-controls" class="flex items-center gap-3">
          <Select
            value={owner}
            onChange={setOwner}
            options={[{ value: ALL_OWNERS, label: 'All agents' }, ...agentOptions]}
          />
          <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
            Create Mission
          </Button>
        </div>
      </div>

      {loading ? (
        <div data-tour="missions-board" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
          {COLUMNS.map((c) => (
            <div key={c.key} class="bg-surface border border-border rounded-xl p-4 space-y-3">
              <Skeleton height="16px" width="40%" />
              <Skeleton height="80px" />
              <Skeleton height="80px" />
            </div>
          ))}
        </div>
      ) : loadError ? (
        <ErrorState
          title="Could not load missions"
          message="The mission board failed to load. This is an error, not an empty board. Check your connection or permissions and try again."
          onRetry={load}
        />
      ) : (
        <div data-tour="missions-board" class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
          {COLUMNS.map((col) => {
            const items = getMissionsForColumn(col.key);
            return (
              <div key={col.key} class="space-y-3">
                <div class={`flex items-center gap-2 pb-2 border-b-2 ${col.color}`}>
                  <h3 class="text-heading-sm font-semibold">{col.label}</h3>
                  <Badge variant="muted">{items.length}</Badge>
                </div>
                {items.map((m) => (
                  <div
                    key={m.id}
                    class="bg-surface border border-border rounded-lg p-4 space-y-2 cursor-pointer hover:border-border-strong transition-colors"
                    onClick={() => openDetail(m)}
                  >
                    <p class="text-body-sm font-medium text-primary">{m.title ?? m.id}</p>
                    {m.body && <p class="text-caption text-secondary line-clamp-2">{m.body}</p>}
                    {m.assignmentReason && (
                      <p class="text-caption text-muted italic line-clamp-2">{m.assignmentReason}</p>
                    )}
                    <div class="flex items-center gap-2 flex-wrap">
                      <span title={m.status}>
                        <Badge variant={statusBadgeVariant(m.status)}>{statusLabel(m.status)}</Badge>
                      </span>
                      {m.priority != null && <Badge variant="warning">P{m.priority}</Badge>}
                      {m.dueAt && <Badge variant="info">Due {fmtDate(m.dueAt)}</Badge>}
                    </div>
                    <div class="flex gap-2 pt-2 border-t border-border" onClick={(e) => e.stopPropagation()}>
                      {(col.key === 'open' || col.key === 'blocked') && (
                        <Button size="sm" variant="ghost" onClick={() => setStatus(m, 'in_progress')}>Start</Button>
                      )}
                      {(col.key === 'in_progress' || col.key === 'in_review') && (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => setStatus(m, 'done')}>Complete</Button>
                          <Button size="sm" variant="ghost" onClick={() => setStatus(m, 'cancelled')}>Cancel</Button>
                        </>
                      )}
                      {(col.key === 'done' || col.key === 'cancelled') && (
                        <Button size="sm" variant="ghost" onClick={() => setStatus(m, 'open')}>Reopen</Button>
                      )}
                    </div>
                  </div>
                ))}
                {items.length === 0 && (
                  <div class="border border-dashed border-border rounded-lg p-4 text-center">
                    <p class="text-caption text-muted">
                      {missions.length === 0 ? 'Agents break complex tasks into trackable missions with priorities and status.' : 'No missions'}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="Create Mission" size="lg">
        <div class="space-y-4">
          <div>
            <label class="block text-caption text-secondary font-medium mb-1">Prompt</label>
            <textarea
              value={createPrompt}
              onInput={(e) => setCreatePrompt((e.target as HTMLTextAreaElement).value)}
              placeholder="Describe the work. The agent breaks this into a tracked mission."
              rows={4}
              class="w-full px-3 py-2 bg-bg-elevated border border-border rounded-lg text-body-sm focus:ring-2 focus:ring-primary/50 outline-none resize-none"
            />
          </div>
          <div>
            <label class="block text-caption text-secondary font-medium mb-1">Title <span class="text-muted">(optional)</span></label>
            <input
              value={createTitle}
              onInput={(e) => setCreateTitle((e.target as HTMLInputElement).value)}
              placeholder="Short headline (auto-derived if blank)"
              class="w-full px-3 py-2 bg-bg-elevated border border-border rounded-lg text-body-sm focus:ring-2 focus:ring-primary/50 outline-none"
            />
          </div>
          <div>
            <label class="block text-caption text-secondary font-medium mb-1">Assign to <span class="text-muted">(optional — auto-assigns if blank)</span></label>
            <Select
              value={createAgentId}
              onChange={setCreateAgentId}
              options={[{ value: '', label: 'Auto-assign (Haiku)' }, ...agentOptions]}
              placeholder="Auto-assign (Haiku)"
              size="md"
              class="w-full"
            />
          </div>
          <div class="flex gap-3 justify-end pt-2">
            <Button variant="secondary" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button variant="primary" loading={creating} disabled={!createPrompt.trim()} onClick={createMission}>
              Create Mission
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={detail !== null} onClose={() => setDetail(null)} title={detail?.title ?? 'Mission'} size="lg">
        {detail && (
          <div class="space-y-4">
            <div class="flex items-center gap-2 flex-wrap">
              <span title={detail.status}>
                <Badge variant={statusBadgeVariant(detail.status)}>{statusLabel(detail.status)}</Badge>
              </span>
              {detail.priority != null && <Badge variant="warning">P{detail.priority}</Badge>}
              {detail.dueAt && <Badge variant="info">Due {fmtDate(detail.dueAt)}</Badge>}
            </div>

            {detail.body && (
              <div>
                <p class="text-caption text-secondary font-medium mb-1">Description</p>
                <p class="text-body-sm text-primary whitespace-pre-wrap">{detail.body}</p>
              </div>
            )}

            <div class="grid grid-cols-2 gap-4">
              <div>
                <p class="text-caption text-secondary font-medium mb-1">Owner</p>
                <p class="text-body-sm text-primary" title={detail.ownerAgent}>{nameFor(detail.ownerAgent)}</p>
              </div>
              {detail.createdByAgent && (
                <div>
                  <p class="text-caption text-secondary font-medium mb-1">Created by</p>
                  <p class="text-body-sm text-primary" title={detail.createdByAgent}>{nameFor(detail.createdByAgent)}</p>
                </div>
              )}
              {detail.createdAt && (
                <div>
                  <p class="text-caption text-secondary font-medium mb-1">Created</p>
                  <p class="text-body-sm text-primary">{fmtDate(detail.createdAt)}</p>
                </div>
              )}
              {detail.dueAt && (
                <div>
                  <p class="text-caption text-secondary font-medium mb-1">Due</p>
                  <p class="text-body-sm text-primary">{fmtDate(detail.dueAt)}</p>
                </div>
              )}
            </div>

            {detail.assignmentReason && (
              <div>
                <p class="text-caption text-secondary font-medium mb-1">Assignment reason</p>
                <p class="text-body-sm text-primary italic">{detail.assignmentReason}</p>
              </div>
            )}

            <div class="pt-2 border-t border-border">
              <p class="text-caption text-secondary font-medium mb-1">Reassign</p>
              <div class="flex items-center gap-3">
                <Select
                  value={reassignTo}
                  onChange={setReassignTo}
                  options={agentOptions.filter((o) => o.value !== detail.ownerAgent)}
                  placeholder="Pick an agent"
                  size="md"
                  class="flex-1"
                />
                <Button
                  variant="secondary"
                  loading={reassigning}
                  disabled={!reassignTo || reassignTo === detail.ownerAgent}
                  onClick={reassignMission}
                >
                  Reassign
                </Button>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
