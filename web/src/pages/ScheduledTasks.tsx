import { useState, useEffect } from 'preact/hooks';
import { api } from '../lib/api';
import { EmptyState } from '../components/EmptyState';
import { EmptyCalendar } from '../components/Icons';
import { Select } from '../components/Select';
import { SkeletonTableRow } from '../components/Skeleton';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { ConfirmDialog, Modal } from '../components/Modal';
import { toast } from '../components/Toast';

// Mirrors the GET /scheduled `tasks[]` shape (ScheduledTask in
// src/lib/state/scheduled-tasks-repo.ts): the row id is `id`, the body is
// `promptText`, the cadence is `intervalSec` (seconds, omitted for one-shots),
// and `nextRunAt` is a Unix epoch in SECONDS (not an ISO string).
interface ScheduledTask {
  id: string;
  agentId: string;
  promptText?: string;
  intervalSec?: number;
  nextRunAt?: number;
  status?: string;
  createdAt?: string;
  description?: string;
  timezone?: string;
  sourceRoutineId?: string;
  deliveryTarget?: { surface: 'telegram' | 'slack'; chatId: string };
}

interface AgentSummary { id: string; displayName: string }
interface SessionRow { agentId: string; chatId: string; surface: string | null; firstMessage: string | null }
interface JarvisRoutine { id: string; name: string; prompt: string }

// Turn an intervalSec into a human-readable cadence. No interval (one-shot)
// reads "One-time". Round intervals map to friendly words; everything else
// falls back to the largest matching unit.
function formatSchedule(intervalSec?: number): string {
  if (!intervalSec || intervalSec <= 0) return 'One-time';
  if (intervalSec % 86400 === 0) {
    const days = intervalSec / 86400;
    return days === 1 ? 'Daily' : `Every ${days} days`;
  }
  if (intervalSec % 3600 === 0) {
    const hours = intervalSec / 3600;
    return hours === 1 ? 'Hourly' : `Every ${hours} hours`;
  }
  if (intervalSec % 60 === 0) {
    const mins = intervalSec / 60;
    return mins === 1 ? 'Every minute' : `Every ${mins} minutes`;
  }
  return `Every ${intervalSec} seconds`;
}

const CADENCE_OPTIONS = [
  { value: 'once', label: 'One-time' },
  { value: 'daily', label: 'Daily at a time' },
  { value: 'hourly', label: 'Hourly' },
  { value: 'custom', label: 'Every N minutes' },
];

interface TaskFormState {
  agentId: string;
  source: 'prompt' | 'routine';
  promptText: string;
  routineId: string;
  cadence: string; // once | daily | hourly | custom
  startAtLocal: string; // datetime-local value (once)
  atLocalTime: string; // HH:mm (daily)
  customMinutes: string;
  deliverySessionKey: string; // "<surface>|<chatId>" or 'custom' or ''
  customDeliveryChatId: string;
  customDeliverySurface: 'telegram' | 'slack';
  description: string;
}

function emptyForm(agentId: string): TaskFormState {
  return {
    agentId,
    source: 'prompt',
    promptText: '',
    routineId: '',
    cadence: 'daily',
    startAtLocal: '',
    atLocalTime: '08:00',
    customMinutes: '30',
    deliverySessionKey: '',
    customDeliveryChatId: '',
    customDeliverySurface: 'telegram',
    description: '',
  };
}

export function ScheduledTasks() {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [agentId, setAgentId] = useState('main');
  const [loading, setLoading] = useState(true);
  const [cancelTarget, setCancelTarget] = useState<ScheduledTask | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Create/edit modal state
  const [formOpen, setFormOpen] = useState(false);
  const [editTask, setEditTask] = useState<ScheduledTask | null>(null);
  const [form, setForm] = useState<TaskFormState>(emptyForm('main'));
  const [saving, setSaving] = useState(false);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [routines, setRoutines] = useState<JarvisRoutine[]>([]);

  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  useEffect(() => {
    api.get<{ agents: AgentSummary[] }>('/agents').then((d) => setAgents(d.agents)).catch(() => {});
    api.get<{ sessions: SessionRow[] }>('/sessions')
      .then((d) => setSessions((d.sessions ?? []).filter((s) => s.surface === 'telegram' || s.surface === 'slack')))
      .catch(() => {});
    api.get<{ routines: JarvisRoutine[] }>('/jarvis/routines')
      .then((d) => setRoutines(d.routines ?? []))
      .catch(() => {});
    // ?routineId=<id> deep link (the Jarvis routine chip "schedule" affordance)
    const params = new URLSearchParams(window.location.search);
    const routineId = params.get('routineId');
    if (routineId) {
      setForm({ ...emptyForm('main'), source: 'routine', routineId });
      setFormOpen(true);
    }
  }, []);

  function load() {
    setLoading(true);
    setLoadError(null);
    api.get<{ tasks: ScheduledTask[] }>(`/scheduled?agentId=${agentId}`)
      .then((d) => setTasks(d.tasks ?? []))
      .catch((e) => setLoadError(e instanceof Error ? e.message : 'Failed to load scheduled tasks'))
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); }, [agentId]);

  async function handleCancel() {
    if (!cancelTarget) return;
    setCancelling(true);
    try {
      await api.del(`/scheduled/${cancelTarget.agentId}/${cancelTarget.id}`);
      toast('Task cancelled', 'success');
      load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setCancelling(false);
    setCancelTarget(null);
  }

  function openCreate() {
    setEditTask(null);
    setForm(emptyForm(agentId));
    setFormOpen(true);
  }

  function openEdit(t: ScheduledTask) {
    setEditTask(t);
    setForm({
      ...emptyForm(t.agentId),
      promptText: t.promptText ?? '',
      cadence: t.intervalSec === 86400 ? 'daily' : t.intervalSec === 3600 ? 'hourly' : t.intervalSec ? 'custom' : 'once',
      customMinutes: t.intervalSec ? String(Math.max(1, Math.round(t.intervalSec / 60))) : '30',
      atLocalTime: '08:00',
      deliverySessionKey: t.deliveryTarget ? 'custom' : '',
      customDeliveryChatId: t.deliveryTarget?.chatId ?? '',
      customDeliverySurface: t.deliveryTarget?.surface ?? 'telegram',
      description: t.description ?? '',
    });
    setFormOpen(true);
  }

  function resolveDelivery(): { surface: string; chatId: string } | undefined {
    if (form.deliverySessionKey === 'custom') {
      if (!form.customDeliveryChatId.trim()) return undefined;
      return { surface: form.customDeliverySurface, chatId: form.customDeliveryChatId.trim() };
    }
    if (form.deliverySessionKey) {
      const [surface, ...rest] = form.deliverySessionKey.split('|');
      return { surface, chatId: rest.join('|') };
    }
    return undefined;
  }

  async function save() {
    setSaving(true);
    try {
      const intervalSec =
        form.cadence === 'daily' ? 86400
        : form.cadence === 'hourly' ? 3600
        : form.cadence === 'custom' ? Math.max(1, Number(form.customMinutes)) * 60
        : undefined;
      const timeSpec =
        form.cadence === 'daily' || form.cadence === 'hourly'
          ? { atLocalTime: form.atLocalTime, timezone: localTz }
          : form.startAtLocal
            ? { startAtIso: new Date(form.startAtLocal).toISOString() }
            : { atLocalTime: form.atLocalTime, timezone: localTz };
      const delivery = resolveDelivery();
      if (editTask) {
        await api.put(`/scheduled/${editTask.agentId}/${editTask.id}`, {
          promptText: form.promptText || undefined,
          ...timeSpec,
          intervalSec: intervalSec ?? null,
          description: form.description || undefined,
          ...(delivery ? { deliveryTarget: delivery } : {}),
        });
        toast('Task updated', 'success');
      } else {
        await api.post('/scheduled', {
          agentId: form.agentId,
          ...(form.source === 'routine'
            ? { routineId: form.routineId }
            : { promptText: form.promptText }),
          ...timeSpec,
          ...(intervalSec ? { intervalSec } : {}),
          ...(delivery ? { deliveryTarget: delivery } : {}),
          description: form.description || undefined,
        });
        toast('Task scheduled', 'success');
      }
      setFormOpen(false);
      load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to save', 'error');
    }
    setSaving(false);
  }

  const canSave =
    (form.source === 'routine' ? !!form.routineId : !!form.promptText.trim()) &&
    (form.cadence !== 'once' || !!form.startAtLocal);

  return (
    <div>
      <div data-tour="scheduled-agent-select" class="flex items-center justify-between mb-6">
        <div>
          <h1 data-tour="scheduled-title" class="text-display-sm text-primary font-bold">Scheduled Tasks</h1>
          <p class="text-body-sm text-secondary mt-1">Recurring and one-time scheduled operations</p>
        </div>
        <div class="flex items-center gap-3">
          <Select
            value={agentId}
            onChange={setAgentId}
            options={agents.map((a) => ({ value: a.id, label: a.displayName }))}
          />
          <Button onClick={openCreate}>New task</Button>
        </div>
      </div>

      <div data-tour="scheduled-table" class="bg-surface border border-border rounded-xl overflow-hidden">
        <div class="overflow-x-auto"><table class="w-full text-left">
          <thead>
            <tr class="border-b border-border bg-surface-elevated">
              <th class="px-4 py-3 text-overline text-muted uppercase tracking-wider font-semibold">Task</th>
              <th class="px-4 py-3 text-overline text-muted uppercase tracking-wider font-semibold">Schedule</th>
              <th class="px-4 py-3 text-overline text-muted uppercase tracking-wider font-semibold">Delivers to</th>
              <th class="px-4 py-3 text-overline text-muted uppercase tracking-wider font-semibold">Status</th>
              <th class="px-4 py-3 text-overline text-muted uppercase tracking-wider font-semibold">Next Run</th>
              <th class="px-4 py-3 text-overline text-muted uppercase tracking-wider font-semibold"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-border">
            {loading
              ? Array.from({ length: 3 }).map((_, i) => <SkeletonTableRow key={i} cols={6} />)
              : tasks.map((t) => (
                  <tr key={t.id} class="hover:bg-surface-hover transition-colors">
                    <td class="px-4 py-3">
                      {/* Prefer the human-readable prompt as the row label; fall
                          back to the raw id only when there is no prompt text. */}
                      <p class="text-body-sm font-medium text-primary truncate max-w-[260px]">{t.description || t.promptText || t.id}</p>
                      {(t.description || t.promptText) && <p class="text-caption text-muted font-mono truncate max-w-[200px]">{t.id}</p>}
                    </td>
                    <td class="px-4 py-3 text-body-sm text-secondary font-mono">{formatSchedule(t.intervalSec)}</td>
                    <td class="px-4 py-3 text-body-sm text-secondary">
                      {t.deliveryTarget ? (
                        <span class="font-mono text-caption">{t.deliveryTarget.surface}: {t.deliveryTarget.chatId}</span>
                      ) : (
                        <span class="text-muted text-caption">origin chat</span>
                      )}
                    </td>
                    <td class="px-4 py-3">
                      <Badge variant={t.status === 'active' ? 'success' : t.status === 'cancelled' ? 'danger' : 'default'}>
                        {t.status ?? 'unknown'}
                      </Badge>
                    </td>
                    <td class="px-4 py-3 text-body-sm text-secondary">
                      {t.nextRunAt ? new Date(t.nextRunAt * 1000).toLocaleString() : t.status === 'done' ? 'Completed' : t.status === 'cancelled' ? 'Cancelled' : '--'}
                    </td>
                    <td class="px-4 py-3 whitespace-nowrap">
                      {t.status === 'active' && (
                        <>
                          <button onClick={() => openEdit(t)} class="text-caption text-primary hover:underline mr-3">
                            Edit
                          </button>
                          <button onClick={() => setCancelTarget(t)} class="text-caption text-danger hover:underline">
                            Cancel
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
          </tbody>
        </table></div>
        {!loading && loadError && (
          <EmptyState icon={<EmptyCalendar />} title="Couldn't load scheduled tasks" description={loadError} />
        )}
        {!loading && !loadError && tasks.length === 0 && (
          <EmptyState icon={<EmptyCalendar />} title="No scheduled tasks" description="Create one with New task, or ask an agent in chat ('brief me every morning at 8')." />
        )}
      </div>

      <ConfirmDialog
        open={!!cancelTarget}
        onClose={() => setCancelTarget(null)}
        onConfirm={handleCancel}
        title="Cancel Scheduled Task"
        message={`Cancel task "${cancelTarget?.id}"? This cannot be undone.`}
        confirmLabel="Cancel Task"
        danger
        loading={cancelling}
      />

      <Modal open={formOpen} onClose={() => setFormOpen(false)} title={editTask ? 'Edit scheduled task' : 'New scheduled task'} size="lg">
        <div class="space-y-4">
          {!editTask && (
            <div>
              <label class="text-body-sm font-medium text-primary block mb-1">Agent</label>
              <Select
                value={form.agentId}
                onChange={(v) => setForm({ ...form, agentId: v })}
                options={agents.map((a) => ({ value: a.id, label: a.displayName }))}
              />
            </div>
          )}

          {!editTask && (
            <div>
              <label class="text-body-sm font-medium text-primary block mb-1">What should run</label>
              <div class="flex gap-2 mb-2">
                <Button size="sm" variant={form.source === 'prompt' ? 'primary' : 'secondary'} onClick={() => setForm({ ...form, source: 'prompt' })}>Prompt</Button>
                <Button size="sm" variant={form.source === 'routine' ? 'primary' : 'secondary'} onClick={() => setForm({ ...form, source: 'routine' })} disabled={routines.length === 0}>Jarvis routine</Button>
              </div>
              {form.source === 'routine' ? (
                <Select
                  value={form.routineId}
                  onChange={(v) => setForm({ ...form, routineId: v })}
                  options={[{ value: '', label: 'Pick a routine…' }, ...routines.map((r) => ({ value: r.id, label: r.name }))]}
                />
              ) : null}
            </div>
          )}

          {(editTask || form.source === 'prompt') && (
            <div>
              <label class="text-body-sm font-medium text-primary block mb-1">Prompt</label>
              <textarea
                value={form.promptText}
                onInput={(e) => setForm({ ...form, promptText: (e.target as HTMLTextAreaElement).value })}
                rows={3}
                maxLength={4000}
                placeholder="e.g. Summarize yesterday's sessions, today's cost so far, and anything that needs my attention."
                class="w-full bg-bg-sunken border border-border rounded-lg px-3 py-2 text-body-sm focus:ring-2 focus:ring-primary/50 outline-none"
              />
            </div>
          )}

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="text-body-sm font-medium text-primary block mb-1">Cadence</label>
              <Select
                value={form.cadence}
                onChange={(v) => setForm({ ...form, cadence: v })}
                options={CADENCE_OPTIONS}
              />
            </div>
            <div>
              {form.cadence === 'once' ? (
                <>
                  <label class="text-body-sm font-medium text-primary block mb-1">Run at</label>
                  <input
                    type="datetime-local"
                    value={form.startAtLocal}
                    onInput={(e) => setForm({ ...form, startAtLocal: (e.target as HTMLInputElement).value })}
                    class="w-full bg-bg-sunken border border-border rounded-lg px-3 py-2 text-body-sm"
                  />
                </>
              ) : form.cadence === 'custom' ? (
                <>
                  <label class="text-body-sm font-medium text-primary block mb-1">Every N minutes</label>
                  <input
                    type="number"
                    min={1}
                    value={form.customMinutes}
                    onInput={(e) => setForm({ ...form, customMinutes: (e.target as HTMLInputElement).value })}
                    class="w-full bg-bg-sunken border border-border rounded-lg px-3 py-2 text-body-sm"
                  />
                </>
              ) : (
                <>
                  <label class="text-body-sm font-medium text-primary block mb-1">
                    First run at ({localTz})
                  </label>
                  <input
                    type="time"
                    value={form.atLocalTime}
                    onInput={(e) => setForm({ ...form, atLocalTime: (e.target as HTMLInputElement).value })}
                    class="w-full bg-bg-sunken border border-border rounded-lg px-3 py-2 text-body-sm"
                  />
                </>
              )}
            </div>
          </div>

          <div>
            <label class="text-body-sm font-medium text-primary block mb-1">Deliver the reply to</label>
            <Select
              value={form.deliverySessionKey}
              onChange={(v) => setForm({ ...form, deliverySessionKey: v })}
              options={[
                { value: '', label: 'Nowhere (log only)' },
                ...sessions.slice(0, 20).map((s) => ({
                  value: `${s.surface}|${s.chatId}`,
                  label: `${s.surface}: ${(s.firstMessage ?? s.chatId).slice(0, 48)}`,
                })),
                { value: 'custom', label: 'Custom chat id…' },
              ]}
            />
            {form.deliverySessionKey === 'custom' && (
              <div class="flex gap-2 mt-2">
                <Select
                  value={form.customDeliverySurface}
                  onChange={(v) => setForm({ ...form, customDeliverySurface: v as 'telegram' | 'slack' })}
                  options={[
                    { value: 'telegram', label: 'Telegram' },
                    { value: 'slack', label: 'Slack' },
                  ]}
                />
                <input
                  value={form.customDeliveryChatId}
                  onInput={(e) => setForm({ ...form, customDeliveryChatId: (e.target as HTMLInputElement).value })}
                  placeholder={form.customDeliverySurface === 'telegram' ? 'Telegram chat id (e.g. 123456789)' : 'slack:C0123ABC'}
                  class="flex-1 bg-bg-sunken border border-border rounded-lg px-3 py-2 text-body-sm font-mono"
                />
              </div>
            )}
          </div>

          <div>
            <label class="text-body-sm font-medium text-primary block mb-1">Label (optional)</label>
            <input
              value={form.description}
              onInput={(e) => setForm({ ...form, description: (e.target as HTMLInputElement).value })}
              maxLength={200}
              placeholder="Morning brief"
              class="w-full bg-bg-sunken border border-border rounded-lg px-3 py-2 text-body-sm"
            />
          </div>

          <div class="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setFormOpen(false)}>Close</Button>
            <Button onClick={save} loading={saving} disabled={!canSave}>
              {editTask ? 'Save changes' : 'Schedule'}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
