import { useState, useEffect, useRef } from 'preact/hooks';
import { api } from '../lib/api';
import { Skeleton } from '../components/Skeleton';
import { Modal } from '../components/Modal';
import { Button } from '../components/Button';
import { Toggle } from '../components/Toggle';
import { toast } from '../components/Toast';
import { InfoTooltip } from '../components/InfoTooltip';
import { hasDefinition, getDefinition } from '../lib/glossary';

interface KillSwitch {
  name: string;
  active: boolean;
  reason?: string;
  description?: string;
  category?: string;
  setBy?: string;
}

type ToggleState = 'idle' | 'pending' | 'propagating';

const EMERGENCY_SWITCHES = ['bedrock_global', 'cost_cap_per_day'];

// Most switches are kill switches: active=true means the guarded behavior is
// BLOCKED. So the on/green toggle (the "everything is running normally" state)
// maps to active=false. A few switches are named as positive capabilities,
// where active=true IS the healthy/normal state; for those the mapping inverts.
// Keep this list tiny and explicit rather than guessing from the name.
const INVERTED_SWITCHES = new Set(['pii_redaction_enabled']);

// Green/on = "running normally". For a normal kill switch that is active=false;
// for an inverted (capability) switch it is active=true.
function isOn(s: KillSwitch): boolean {
  return INVERTED_SWITCHES.has(s.name) ? s.active : !s.active;
}
// The `active` value to persist for a desired on/off toggle position.
function activeFor(name: string, on: boolean): boolean {
  return INVERTED_SWITCHES.has(name) ? on : !on;
}

export function KillSwitches() {
  const [switches, setSwitches] = useState<KillSwitch[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [toggleStates, setToggleStates] = useState<Record<string, ToggleState>>({});
  const [countdowns, setCountdowns] = useState<Record<string, number>>({});
  // The switch the user is about to move into its non-normal (blocked) state.
  // This is the dangerous direction, so it routes through a reason + type-the-
  // name confirm before anything is persisted. The safe direction (restoring
  // normal operation) applies straight away.
  const [killConfirm, setKillConfirm] = useState<KillSwitch | null>(null);
  const [killReason, setKillReason] = useState('');
  const [killTyped, setKillTyped] = useState('');
  const timersRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});

  function load() {
    api.get<{ switches: KillSwitch[] }>('/kill-switches')
      .then((d) => setSwitches(d.switches))
      .catch(() => {})
      .finally(() => setLoading(false));
  }

  useEffect(() => { load(); return () => { Object.values(timersRef.current).forEach(clearInterval); }; }, []);

  // Jarvis screen-awareness (H2): expose a curated summary of the switches and
  // their meaning so read_view returns the live on-screen state rather than the
  // generic main-content scrape, and questions like "what does bedrock_global
  // mean?" answer well. We prefer the glossary definition (authoritative, plain
  // language) and fall back to the switch's API description. Switch names/states
  // are operational metadata, not credentials, so this is safe to surface.
  useEffect(() => {
    const w = window as unknown as { getJarvisSummary?: () => string };
    w.getJarvisSummary = () => {
      const parts: string[] = ['Page: Kill Switches (circuit breakers for emergency control).'];
      if (loading) return parts.concat('Switches are still loading.').join(' ');
      if (switches.length === 0) return parts.concat('No kill switches are configured.').join(' ');
      const blocked = switches.filter((s) => !isOn(s));
      parts.push(
        `${switches.length} switch${switches.length === 1 ? '' : 'es'} total, ${blocked.length} off (behavior blocked)${
          blocked.length ? `: ${blocked.map((s) => s.name).join(', ')}` : ''
        }.`,
      );
      // Per-switch line: name, current state, and what it does. The on-tripped
      // reason is included so Jarvis can explain why something is engaged.
      for (const s of switches) {
        const meaning = getDefinition(s.name) ?? s.description ?? 'Controls a system behavior.';
        const state = isOn(s) ? 'ON (running)' : 'OFF (blocked)';
        const why = !isOn(s) && s.reason ? ` Reason: ${s.reason}.` : '';
        parts.push(`${s.name} — ${state}. ${meaning}${why}`);
      }
      return parts.join(' ');
    };
    return () => {
      const ww = window as unknown as { getJarvisSummary?: () => string };
      if (ww.getJarvisSummary) delete ww.getJarvisSummary;
    };
  }, [switches, loading]);

  // Persist a switch change. `on` is the desired toggle position; we translate
  // it to the stored `active` boolean per the switch's polarity.
  async function apply(s: KillSwitch, on: boolean, reason?: string) {
    const nextActive = activeFor(s.name, on);
    setToggleStates((prev) => ({ ...prev, [s.name]: 'pending' }));
    try {
      await api.post('/kill-switches', { name: s.name, active: nextActive, reason: reason || undefined });
      setToggleStates((prev) => ({ ...prev, [s.name]: 'propagating' }));
      setCountdowns((prev) => ({ ...prev, [s.name]: 30 }));

      const timer = setInterval(() => {
        setCountdowns((prev) => {
          const next = (prev[s.name] ?? 0) - 1;
          if (next <= 0) {
            clearInterval(timer);
            delete timersRef.current[s.name];
            setToggleStates((ts) => ({ ...ts, [s.name]: 'idle' }));
            load();
            return { ...prev, [s.name]: 0 };
          }
          return { ...prev, [s.name]: next };
        });
      }, 1000);
      timersRef.current[s.name] = timer;

      toast(`${s.name.replace(/_/g, ' ')} turned ${on ? 'on' : 'off'}`, on ? 'success' : 'warning');
      load();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
      setToggleStates((prev) => ({ ...prev, [s.name]: 'idle' }));
    }
  }

  // Toggle handler. Restoring normal operation (on) is safe and applies
  // immediately. Moving a switch into its blocked state (off) is the dangerous
  // direction and routes through the confirm gate.
  function onFlip(s: KillSwitch, next: boolean) {
    if (next) {
      apply(s, true);
    } else {
      setKillReason('');
      setKillTyped('');
      setKillConfirm(s);
    }
  }

  const filtered = switches.filter((s) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return s.name.toLowerCase().includes(q) || (s.description ?? '').toLowerCase().includes(q);
  });

  const categories = ['Cost Controls', 'Safety & Guardrails', 'Agent Behavior', 'Integrations', 'System'];
  const grouped = categories.map((cat) => ({
    category: cat,
    items: filtered.filter((s) => (s.category ?? 'System') === cat),
  })).filter((g) => g.items.length > 0);

  const blockedCount = switches.filter((s) => !isOn(s)).length;
  const killName = killConfirm ? killConfirm.name : '';
  const killMatches = killTyped.trim() === killName;

  return (
    <div>
      <div class="flex items-center justify-between mb-6">
        <div>
          <h1 data-tour="kill-switches-title" class="text-display-sm text-primary font-bold inline-flex items-center gap-1.5">
            Kill Switches
            <InfoTooltip term="kill switch" />
          </h1>
          <p class="text-body-sm text-secondary mt-1">
            Circuit breakers for emergency control. Green means running normally; switch off to block a behavior.
            {blockedCount > 0 && <span class="text-danger font-medium"> {blockedCount} currently off.</span>}
          </p>
        </div>
      </div>

      <input
        data-tour="kill-switches-search"
        type="text"
        value={search}
        onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
        placeholder="Search switches by name or description..."
        class="w-full mb-6 px-3 py-2 bg-surface border border-border rounded-lg text-body-sm text-primary placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-accent"
      />

      {loading
        ? <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} class="bg-surface border border-border rounded-xl p-5">
                <Skeleton height="16px" width="60%" class="mb-3" />
                <Skeleton height="12px" width="80%" class="mb-4" />
                <Skeleton height="24px" width="44px" />
              </div>
            ))}
          </div>
        : grouped.map((g) => (
            <div key={g.category} data-tour="kill-switches-group" class="mb-8">
              <h2 class="text-heading-sm font-semibold text-secondary mb-4 uppercase tracking-wider">{g.category}</h2>
              <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {g.items.map((s) => {
                  const state = toggleStates[s.name] ?? 'idle';
                  const countdown = countdowns[s.name] ?? 0;
                  const isEmergency = EMERGENCY_SWITCHES.includes(s.name);
                  const busy = state !== 'idle';
                  const on = isOn(s);
                  return (
                    <div
                      key={s.name}
                      class={`bg-surface border rounded-xl p-5 transition-colors
                        ${on ? 'border-border' : 'border-danger/40 bg-danger/5'}`}
                    >
                      <div class="flex items-start justify-between gap-3 mb-2">
                        <h3 class="text-body font-semibold text-primary inline-flex items-center gap-1.5">
                          <span>{s.name.replace(/_/g, ' ')}</span>
                          {hasDefinition(s.name) && <InfoTooltip term={s.name} />}
                        </h3>
                        <Toggle
                          checked={on}
                          busy={busy}
                          ariaLabel={`${s.name} ${on ? 'on, running' : 'off, blocked'}`}
                          onChange={(next) => onFlip(s, next)}
                        />
                      </div>

                      {/* Explicit state chip so the card reads unambiguously even
                          for someone who reads the toggle the other way around. */}
                      <div class="mb-3 inline-flex items-center gap-1.5">
                        <span
                          class={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-caption font-medium
                            ${on
                              ? 'bg-success/10 text-success border border-success/30'
                              : 'bg-danger/10 text-danger border border-danger/30'}`}
                        >
                          <span class={`w-1.5 h-1.5 rounded-full ${on ? 'bg-success' : 'bg-danger'}`} />
                          {on ? 'On — running' : 'Off — blocked'}
                        </span>
                        {hasDefinition('trip') && <InfoTooltip term="trip" />}
                      </div>

                      <p class="text-caption text-secondary mb-3">
                        {s.description || 'Controls a system behavior.'}
                      </p>
                      {!on && s.reason && (
                        <p class="text-caption text-danger mb-3 italic">Reason: {s.reason}</p>
                      )}
                      {s.setBy && (
                        <p class="text-caption text-muted mb-1">Set by {s.setBy}</p>
                      )}
                      {state === 'propagating' && (
                        <div class={`text-caption font-medium ${isEmergency ? 'text-warning' : 'text-muted'}`}>
                          {isEmergency
                            ? `Propagating to all workers... ${countdown}s`
                            : `Saved, propagating (~${countdown}s)`}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))
      }

      {/* Dangerous direction only: capture a reason and require the user to type
          the switch name before the behavior is blocked across the fleet. */}
      <Modal
        open={!!killConfirm}
        onClose={() => setKillConfirm(null)}
        title={killConfirm ? `Switch off: ${killConfirm.name.replace(/_/g, ' ')}` : 'Switch off'}
        danger
      >
        {killConfirm && (
          <div data-tour="kill-switches-confirm" class="space-y-4">
            <p class="text-body-sm text-secondary">
              {INVERTED_SWITCHES.has(killConfirm.name)
                ? `This disables "${killConfirm.name}". ${killConfirm.description || ''}`
                : `This blocks the behavior controlled by "${killConfirm.name}" across every worker. All affected operations will be stopped.`}
            </p>
            <p class="text-caption text-muted">
              Changes propagate to all workers within ~30 seconds.
            </p>
            <div>
              <label class="block text-caption text-secondary font-medium mb-1">Reason (optional)</label>
              <input
                value={killReason}
                onInput={(e) => setKillReason((e.target as HTMLInputElement).value)}
                placeholder="Why are you switching this off?"
                class="w-full bg-bg-elevated border border-border rounded-lg px-3 py-2 text-body-sm outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>
            <div>
              <label class="block text-caption text-secondary font-medium mb-1">
                Type <span class="font-mono font-semibold text-primary">{killConfirm.name}</span> to confirm
              </label>
              <input
                value={killTyped}
                autocomplete="off"
                spellcheck={false}
                onInput={(e) => setKillTyped((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && killMatches) { e.preventDefault(); const s = killConfirm; setKillConfirm(null); apply(s, false, killReason); } }}
                placeholder={killConfirm.name}
                class="w-full bg-bg-elevated border border-border rounded-lg px-3 py-2 text-body-sm font-mono text-primary placeholder:font-sans placeholder:text-muted outline-none focus:ring-2 focus:ring-danger/50"
                autoFocus
              />
            </div>
            <div class="flex gap-3 justify-end">
              <Button variant="secondary" onClick={() => setKillConfirm(null)}>Cancel</Button>
              <Button
                variant="danger"
                disabled={!killMatches}
                onClick={() => { const s = killConfirm; setKillConfirm(null); apply(s, false, killReason); }}
              >
                Switch off
              </Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
