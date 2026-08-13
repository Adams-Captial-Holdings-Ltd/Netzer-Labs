/**
 * Jarvis — the immersive voice experience. A large arc-reactor orb owns the
 * page; click it to open the live session (WebSocket handshake) and talk. Your
 * voice and Jarvis's voice both drive the orb's audio-reactive HUD, with the
 * AI rendered more pronounced so it's obvious who's speaking. Typing still works
 * as a fallback. The orb shares ONE VoiceClient with the floating widget, so a
 * session started here continues seamlessly if Jarvis navigates you elsewhere.
 */

import { useEffect, useRef, useState } from 'preact/hooks';
import { useLocation } from 'wouter-preact';
import { Mic, MicOff, Loader2, Volume2 } from 'lucide-preact';
import {
  jarvisState,
  jarvisCaption,
  jarvisTurns,
  jarvisNavHistory,
  jarvisEnabled,
  jarvisVoiceEnabled,
  jarvisPushToTalk,
  jarvisMicPermission,
  jarvisManifest,
  jarvisTextModel,
  setJarvisTextModel,
  registerNavigate,
  loadJarvisManifest,
  setJarvisWidgetHidden,
  type JarvisSessionState,
} from '../lib/jarvis/tools';
import { Select } from '../components/Select';
import { getVoiceClient, type VoiceClient } from '../lib/jarvis/voiceClient';
import { runJarvisTextTurn, isNarrating, stopJarvisNarration } from '../lib/jarvis/textClient';
import {
  runDemoWalkthrough,
  stopDemoWalkthrough,
  isWalkthroughRunning,
  DEMO_WALKTHROUGH_ROUTINE_ID,
} from '../lib/jarvis/walkthrough';
import { OrbCanvas } from '../components/OrbCanvas';
import { JarvisSpotlight, JarvisCardLayer } from '../components/JarvisHud';
import { Toggle } from '../components/Toggle';
import { Navigation, Play, Pencil, Trash2 } from 'lucide-preact';
import {
  jarvisRoutines,
  loadJarvisRoutines,
  saveJarvisRoutine,
  deleteJarvisRoutine,
  routineIdFromName,
  type JarvisRoutine,
} from '../lib/jarvis/routines';
import { hasRole } from '../lib/auth';
import { toast } from '../components/Toast';
import { api } from '../lib/api';
import { Button } from '../components/Button';
import '../lib/jarvis/jarvis.css';

const STATUS: Record<JarvisSessionState, string> = {
  idle: 'Tap to talk',
  connecting: 'Connecting',
  listening: 'Listening',
  thinking: 'Thinking',
  speaking: 'Jarvis speaking',
  error: 'Connection lost',
  disabled: 'Disabled',
};

// Starter prompts so a first-time user knows what Jarvis can answer. Clicking one
// runs it through the SAME text path as the input box (runJarvisTextTurn), so a
// pill is just a pre-filled question, not a separate code path.
// Three starters keep the foot airy; everything else is one question away.
const EXAMPLE_PROMPTS = [
  'Give me a tour of the dashboard',
  "What's my spend today?",
  'Which agents are unhealthy?',
];

export function Jarvis() {
  const [, setLocation] = useLocation();
  const clientRef = useRef<VoiceClient | null>(null);
  const [input, setInput] = useState('');

  useEffect(() => {
    registerNavigate(setLocation);
    void loadJarvisManifest();
    void loadJarvisRoutines();
    clientRef.current = getVoiceClient();
    // Opening this tab is how a dismissed floating orb comes back — otherwise the
    // X would be a one-way door with no visible way to undo it.
    setJarvisWidgetHidden(false);
    const root = document.documentElement;
    if (!root.className.includes('jarvis-')) root.classList.add('jarvis-idle');
    // No disconnect on unmount: the shared client keeps the session alive so it
    // hands off to the floating widget if Jarvis navigates you off this page.
  }, []);

  const state = jarvisState.value;
  const caption = jarvisCaption.value;
  const enabled = jarvisEnabled.value;
  const voiceEnabled = jarvisVoiceEnabled.value !== false;
  const perm = jarvisMicPermission.value;
  const ptt = jarvisPushToTalk.value;

  const icon =
    state === 'connecting' || state === 'thinking' ? (
      <Loader2 class="animate-spin" />
    ) : state === 'speaking' ? (
      <Volume2 />
    ) : state === 'error' ? (
      <MicOff />
    ) : (
      <Mic />
    );

  function onOrb() {
    const c = clientRef.current;
    if (!c || !enabled) return;
    // A 'speaking' orb can mean the scripted walkthrough, text-path narration,
    // or a live voice session. Stop whichever is actually running; only barge in
    // on a real voice session, so the orb never pokes a closed socket.
    if (isWalkthroughRunning()) stopDemoWalkthrough();
    else if (state === 'speaking' && isNarrating()) stopJarvisNarration();
    else if (state === 'speaking') c.bargein();
    else if (state === 'idle' || state === 'error' || state === 'disabled') c.requestMic();
    else c.disconnect();
  }

  // Single send path for the input form, example pills, and routine chips so a
  // pill submits exactly like typing. Routine chips pass speak:true so the
  // guided tour is narrated aloud; typed/pill turns stay silent.
  async function sendPrompt(text: string, opts: { speak?: boolean } = {}) {
    const t = text.trim();
    if (!t || !enabled || state === 'thinking') return;
    setInput('');
    await runJarvisTextTurn(t, opts);
  }

  async function submitText(e: Event) {
    e.preventDefault();
    await sendPrompt(input);
  }

  const who = state === 'listening' ? 'YOU' : state === 'speaking' ? 'JARVIS' : '';
  // ONE quiet line when idle — it carries the read-only promise too, so the
  // header doesn't need a subtitle or a disclaimer pill stacked above the orb.
  const hint = !enabled
    ? 'Jarvis is disabled for your token. An administrator controls this from Kill Switches.'
    : state === 'idle'
      ? 'Tap the orb or type below. I can look around and move the dashboard — read-only, I never change anything.'
      : state === 'listening'
        ? 'Listening — go ahead.'
        : '';

  return (
    <>
    <div data-testid="jarvis-console" class="jarvis-stage">
      <div class="jarvis-hero">
        <header class="jarvis-hero-head">
          <h1 class="jarvis-hero-title" data-testid="jarvis-title" data-tour="jarvis-title">Jarvis</h1>
        </header>

        <button
          class="jarvis-hero-orb"
          data-testid="mic-button"
          data-tour="jarvis-orb"
          type="button"
          aria-label={`Jarvis (${state})`}
          onClick={ptt ? undefined : onOrb}
          onPointerDown={
            ptt
              ? (e) => {
                  (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                  clientRef.current?.requestMic();
                }
              : undefined
          }
          onPointerUp={ptt ? () => clientRef.current?.releaseMic() : undefined}
          onPointerCancel={ptt ? () => clientRef.current?.releaseMic() : undefined}
        >
          <OrbCanvas state={state} size={420} />
          <span class="jarvis-orb">{icon}</span>
        </button>

        <div class="jarvis-hero-status" data-testid="jarvis-state">
          <span class="dot" />
          {STATUS[state]}
          {who ? ` · ${who}` : ''}
        </div>

        <div class="jarvis-hero-caption" data-testid="jarvis-caption" aria-live="polite">
          {caption || <span class="jarvis-hero-hint">{hint}</span>}
        </div>

        {perm === 'denied' && <div class="jarvis-hero-hint">Microphone blocked. Allow it in your browser, or type below.</div>}
        {!voiceEnabled && <div class="jarvis-hero-hint">Voice is off right now. You can still type to Jarvis below.</div>}

        <Transcript />
      </div>

      <div class="jarvis-hero-foot">
        <div class="jarvis-hero-pills" data-testid="jarvis-pills" data-tour="jarvis-pills">
          {jarvisRoutines.value.map((r) => (
            <button
              key={`routine-${r.id}`}
              type="button"
              class="jarvis-hero-pill jarvis-routine-chip"
              title={r.prompt}
              disabled={!enabled || state === 'thinking'}
              onClick={() =>
                r.id === DEMO_WALKTHROUGH_ROUTINE_ID
                  ? void runDemoWalkthrough()
                  : void sendPrompt(r.prompt, { speak: true })
              }
            >
              <Play class="w-3 h-3" />
              {r.name}
            </button>
          ))}
          {EXAMPLE_PROMPTS.map((p) => (
            <button
              key={p}
              type="button"
              class="jarvis-hero-pill"
              disabled={!enabled || state === 'thinking'}
              onClick={() => void sendPrompt(p)}
            >
              {p}
            </button>
          ))}
        </div>
        <form onSubmit={submitText} class="flex gap-2 w-full max-w-md">
          <input
            data-testid="jarvis-input"
            data-tour="jarvis-input"
            value={input}
            onInput={(e) => setInput((e.target as HTMLInputElement).value)}
            placeholder="…or type to Jarvis"
            disabled={!enabled}
            class="flex-1 rounded-lg px-4 py-2 text-body-sm focus:outline-none focus:ring-2"
            style={{ background: 'rgba(5,20,33,0.6)', border: '1px solid rgba(43,210,255,0.25)', color: 'var(--jarvis-text)' }}
          />
          <button
            data-testid="jarvis-send"
            type="submit"
            disabled={!enabled || !input.trim() || state === 'thinking'}
            class="px-4 py-2 rounded-lg text-body-sm font-medium disabled:opacity-40"
            style={{ background: 'rgba(43,210,255,0.18)', border: '1px solid rgba(43,210,255,0.35)', color: 'var(--jarvis-text-mono)' }}
          >
            Send
          </button>
        </form>
        <ModelPicker />
        <Toggle
          size="sm"
          checked={ptt}
          ariaLabel="Push-to-talk"
          onChange={(on) => {
            jarvisPushToTalk.value = on;
            localStorage.setItem('cce_jarvis_ptm', String(on));
          }}
        >
          <span class="text-body-sm whitespace-nowrap" style={{ color: '#8fb6c8' }}>Push-to-talk</span>
        </Toggle>
      </div>

      {/* The floating widget hides on /jarvis, so this page mounts its own HUD
          layers — Jarvis can still spotlight and project cards here. */}
      <JarvisSpotlight />
      <JarvisCardLayer />
    </div>

    <NameCard />
    <RoutinesCard />
    </>
  );
}

/**
 * "Your name" — the single name Jarvis greets you with and uses when it refers
 * to you. Writes the SAME runtime-config variable (profile/first_name) as the
 * Settings field, so the two stay in sync and a change propagates to the spoken
 * greeting + system prompt fleet-wide within ~30s. Admin-gated like the backend
 * write; non-admins see the current value read-only.
 */
function NameCard(): preact.JSX.Element {
  const [firstName, setFirstName] = useState('');
  const [saving, setSaving] = useState(false);
  const isAdmin = hasRole('admin');
  useEffect(() => {
    let alive = true;
    api.config
      .get('profile', 'first_name')
      .then((c) => {
        if (alive) setFirstName(c.value ?? '');
      })
      .catch(() => {
        /* fail-quiet: leave the field blank if the read fails */
      });
    return () => {
      alive = false;
    };
  }, []);
  async function save() {
    const next = firstName.trim();
    setSaving(true);
    try {
      await api.config.set('profile', 'first_name', next);
      setFirstName(next); // reflect the trimmed value we persisted
      toast(next ? `Jarvis will call you ${next}` : 'Name cleared', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to save name', 'error');
    }
    setSaving(false);
  }
  return (
    <div class="bg-surface border border-border rounded-xl p-5 mt-6" data-testid="jarvis-name-card">
      <h2 class="text-h3 text-primary">Your name</h2>
      <p class="text-body-sm text-secondary mt-1 mb-4">
        The name Jarvis greets you with and uses when it refers to you. Leave blank for a neutral
        greeting. Applies everywhere within ~30 seconds.
      </p>
      {isAdmin ? (
        <div class="flex items-end gap-3">
          <div class="max-w-[240px]">
            <label class="block text-caption text-secondary font-medium mb-1">First name</label>
            <input
              value={firstName}
              onInput={(e) => setFirstName((e.target as HTMLInputElement).value)}
              placeholder="e.g. Emmanuel"
              maxLength={60}
              data-testid="jarvis-name-input"
              class="w-full bg-bg-elevated border border-border rounded-lg px-3 py-2 text-body-sm outline-none focus:ring-2 focus:ring-primary/50"
            />
          </div>
          <Button size="sm" loading={saving} onClick={save}>
            Save
          </Button>
        </div>
      ) : (
        <p class="text-body-sm text-muted" data-testid="jarvis-name-readonly">
          {firstName ? (
            <>
              Jarvis addresses you as <span class="font-medium text-secondary">{firstName}</span>.
            </>
          ) : (
            'No name set; Jarvis uses a neutral greeting.'
          )}
        </p>
      )}
    </div>
  );
}

// Seeded template so the first routine is one click, not a blank textarea.
const TEMPLATE_ROUTINE = {
  name: 'Morning brief',
  prompt:
    'Give me my morning brief. Start on the Overview tab and summarize system health and anything that needs my attention. Then go to the Cost tab and break down today’s spend versus the weekly average, calling out what is driving it. Finish by summarizing the recent agent conversations from Sessions.',
};

/**
 * Routines: named saved prompts that show as one-click chips on the orb's hover
 * popup and as pills above. Stored server-side (runtime-config) so they follow
 * the account across browsers; writes are admin-gated by the backend, so the
 * editor only renders for admins. A routine RUNS through the normal text-turn
 * path — same read-only tools, same audit trail as a typed question.
 */
function RoutinesCard(): preact.JSX.Element | null {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [prompt, setPrompt] = useState('');
  const [showOnHover, setShowOnHover] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!hasRole('admin')) return null;
  const routines = jarvisRoutines.value;

  function openForm(r?: JarvisRoutine) {
    setEditingId(r?.id ?? null);
    setName(r?.name ?? '');
    setPrompt(r?.prompt ?? '');
    setShowOnHover(r?.showOnHover ?? true);
    setFormOpen(true);
  }

  async function save(e: Event) {
    e.preventDefault();
    const id = editingId ?? routineIdFromName(name);
    if (!id) {
      toast('Give the routine a name first.', 'error');
      return;
    }
    setBusy(true);
    try {
      await saveJarvisRoutine(id, { name, prompt, showOnHover });
      setFormOpen(false);
      toast('Routine saved. It now shows on the orb’s hover popup.', 'success');
    } catch (err) {
      toast(`Could not save the routine: ${err instanceof Error ? err.message : String(err)}`, 'error');
    } finally {
      setBusy(false);
    }
  }

  async function remove(r: JarvisRoutine) {
    if (!confirm(`Delete the routine “${r.name}”?`)) return;
    try {
      await deleteJarvisRoutine(r.id);
      toast('Routine deleted.', 'success');
    } catch (err) {
      toast(`Could not delete the routine: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
  }

  const inputClass =
    'w-full bg-bg-elevated border border-border rounded-lg px-3 py-2 text-body-sm text-primary placeholder:text-muted outline-none focus:ring-1 focus:ring-accent';

  return (
    <div class="bg-surface border border-border rounded-xl p-5 mt-6" data-testid="jarvis-routines-card">
      <div class="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 class="text-h3 text-primary">Routines</h2>
          <p class="text-body-sm text-muted mt-1">
            Saved flows Jarvis runs in one click, from the orb&rsquo;s hover popup on any tab or the pills
            above. Read-only and audited, exactly like a typed question.
          </p>
        </div>
        <div class="flex gap-2">
          {routines.length === 0 && (
            <button
              type="button"
              class="px-3 py-1.5 rounded-lg text-body-sm border border-border text-secondary hover:text-primary hover:border-accent"
              onClick={() => {
                openForm();
                setName(TEMPLATE_ROUTINE.name);
                setPrompt(TEMPLATE_ROUTINE.prompt);
              }}
            >
              Start from template
            </button>
          )}
          <button
            type="button"
            data-testid="routine-new"
            class="px-3 py-1.5 rounded-lg text-body-sm font-medium bg-accent/15 border border-accent/40 text-primary hover:bg-accent/25"
            onClick={() => openForm()}
          >
            New routine
          </button>
        </div>
      </div>

      {routines.length > 0 && (
        <ul class="mt-4 divide-y divide-border">
          {routines.map((r) => (
            <li key={r.id} class="py-3 flex items-center gap-3" data-testid={`routine-row-${r.id}`}>
              <div class="min-w-0 flex-1">
                <div class="text-body-sm font-medium text-primary">{r.name}</div>
                <div class="text-caption text-muted truncate" title={r.prompt}>{r.prompt}</div>
              </div>
              <Toggle
                size="sm"
                checked={r.showOnHover}
                ariaLabel={`Show ${r.name} on orb hover`}
                onChange={(on) =>
                  void saveJarvisRoutine(r.id, { name: r.name, prompt: r.prompt, showOnHover: on }).catch(() =>
                    toast('Could not update the routine.', 'error'),
                  )
                }
              >
                <span class="text-caption text-muted whitespace-nowrap">On hover</span>
              </Toggle>
              <button
                type="button"
                class="p-1.5 rounded-lg text-muted hover:text-primary"
                aria-label={`Run ${r.name}`}
                title="Run now"
                onClick={() =>
                  r.id === DEMO_WALKTHROUGH_ROUTINE_ID
                    ? void runDemoWalkthrough()
                    : void runJarvisTextTurn(r.prompt, { speak: true })
                }
              >
                <Play class="w-4 h-4" />
              </button>
              <button
                type="button"
                class="p-1.5 rounded-lg text-muted hover:text-primary"
                aria-label={`Edit ${r.name}`}
                onClick={() => openForm(r)}
              >
                <Pencil class="w-4 h-4" />
              </button>
              <button
                type="button"
                class="p-1.5 rounded-lg text-muted hover:text-danger"
                aria-label={`Delete ${r.name}`}
                onClick={() => void remove(r)}
              >
                <Trash2 class="w-4 h-4" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {formOpen && (
        <form onSubmit={save} class="mt-4 grid gap-3 max-w-2xl" data-testid="routine-form">
          <input
            class={inputClass}
            value={name}
            maxLength={60}
            placeholder="Name (shows on the chip), e.g. Morning brief"
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
          />
          <textarea
            class={`${inputClass} min-h-28`}
            value={prompt}
            maxLength={2000}
            placeholder="What should Jarvis do? Plain English, multi-step is fine."
            onInput={(e) => setPrompt((e.target as HTMLTextAreaElement).value)}
          />
          <div class="flex items-center gap-4">
            <Toggle size="sm" checked={showOnHover} ariaLabel="Show on orb hover" onChange={setShowOnHover}>
              <span class="text-body-sm text-secondary">Show on orb hover</span>
            </Toggle>
            <div class="flex-1" />
            <button
              type="button"
              class="px-3 py-1.5 rounded-lg text-body-sm text-muted hover:text-primary"
              onClick={() => setFormOpen(false)}
            >
              Cancel
            </button>
            <button
              type="submit"
              data-testid="routine-save"
              disabled={busy || !name.trim() || !prompt.trim()}
              class="px-4 py-1.5 rounded-lg text-body-sm font-medium bg-accent/15 border border-accent/40 text-primary hover:bg-accent/25 disabled:opacity-40"
            >
              {editingId ? 'Save changes' : 'Create routine'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * Model picker for TYPED turns: the deploy's default Claude model plus the
 * selectable Anthropic family from the manifest. The server re-validates the
 * choice on every turn (an unknown id silently falls back to the default), and
 * voice always runs on Nova Sonic regardless — hence the tooltip.
 */
function ModelPicker(): preact.JSX.Element | null {
  const m = jarvisManifest.value;
  if (!m?.models || m.models.length < 2) return null;
  const defaultName = m.models.find((x) => x.id === m.model)?.name ?? 'Default';
  return (
    <div title="Model for typed Jarvis turns. Voice always uses Nova Sonic." data-testid="jarvis-model-picker" data-tour="jarvis-model-picker">
      <Select
        size="sm"
        value={jarvisTextModel.value}
        onChange={setJarvisTextModel}
        options={[
          { value: '', label: `Model: ${defaultName} (default)` },
          ...m.models.filter((x) => x.id !== m.model).map((x) => ({ value: x.id, label: `Model: ${x.name}` })),
        ]}
      />
    </div>
  );
}

/**
 * The session transcript: spoken/typed turns interleaved (by time) with the
 * navigation moves Jarvis made, so a tour reads back as a story — "You: give me
 * a tour" → [Overview] → "Jarvis: this is mission control…". Scrollable, pinned
 * to the newest entry.
 */
function Transcript(): preact.JSX.Element | null {
  const turns = jarvisTurns.value;
  const navs = jarvisNavHistory.value;
  const ref = useRef<HTMLDivElement | null>(null);
  const entries = [
    ...turns.map((t) => ({ ts: t.ts, key: t.id, kind: 'turn' as const, turn: t })),
    ...navs.map((n) => ({ ts: n.ts, key: `nav-${n.ts}`, kind: 'nav' as const, nav: n })),
  ].sort((a, b) => a.ts - b.ts);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [entries.length, turns[turns.length - 1]?.text]);
  if (entries.length === 0) return null;
  return (
    <div ref={ref} class="jarvis-transcript" role="log" aria-live="polite" data-testid="jarvis-transcript" data-tour="jarvis-transcript">
      {entries.map((e) =>
        e.kind === 'turn' ? (
          <div key={e.key} class={`jarvis-transcript-row ${e.turn.role === 'user' ? 'from-you' : 'from-jarvis'}`}>
            <span class={e.turn.role === 'user' ? 'who-you' : 'who-jarvis'}>
              {e.turn.role === 'user' ? 'You' : 'Jarvis'}
            </span>{' '}
            {e.turn.text}
          </div>
        ) : (
          <div key={e.key} class="jarvis-transcript-nav">
            <Navigation class="w-3 h-3" />
            {e.nav.label}
          </div>
        ),
      )}
    </div>
  );
}
