import { ComponentChildren } from 'preact';

type Size = 'sm' | 'md';
// What the "on" state means. `positive` (default) is green: on = the healthy /
// normal state. `danger`/`warning` color the on state red/amber for switches
// where being on is the elevated, risky state (e.g. arming a destructive
// capability, panic engaged) so the color never implies "on = good".
type Tone = 'positive' | 'warning' | 'danger';

interface ToggleProps {
  /** Whether the toggle reads as on or off (gray). */
  checked: boolean;
  /**
   * Called with the requested next value when the user flips it. The parent
   * owns the state, so a parent that needs to confirm a dangerous flip can
   * intercept here and choose not to apply it yet.
   */
  onChange: (next: boolean) => void;
  /** Hard-disable: not interactive, dimmed. */
  disabled?: boolean;
  /**
   * In-flight: shows a pulse and blocks interaction, but does not dim the way
   * `disabled` does. Use while a change is propagating.
   */
  busy?: boolean;
  size?: Size;
  /** Color of the on state. Defaults to `positive` (green). */
  tone?: Tone;
  /** Accessible label, required when there is no visible adjacent label. */
  ariaLabel?: string;
  /** Associates the switch with an external <label for>. */
  id?: string;
  /** Optional content rendered to the right of the switch. */
  children?: ComponentChildren;
  class?: string;
}

const dims: Record<Size, { track: string; knob: string; travel: string }> = {
  // track w/h, knob w/h, and how far the knob slides when on.
  sm: { track: 'w-9 h-5', knob: 'w-4 h-4', travel: 'translate-x-4' },
  md: { track: 'w-11 h-6', knob: 'w-5 h-5', travel: 'translate-x-5' },
};

/**
 * iOS-style on/off switch. On is green (`bg-success`), off is a neutral track
 * (`bg-border-strong`); the white knob slides. This is a pure, controlled
 * presentational component with no app semantics: the caller decides what
 * on/off mean and whether a flip needs a confirmation gate.
 *
 * Accessibility: renders as role="switch" with aria-checked, is keyboard
 * operable (Space/Enter), and exposes a focus ring. Pair it with a visible
 * label or pass `ariaLabel`.
 */
export function Toggle({
  checked,
  onChange,
  disabled = false,
  busy = false,
  size = 'md',
  tone = 'positive',
  ariaLabel,
  id,
  children,
  class: className = '',
}: ToggleProps) {
  const d = dims[size];
  const locked = disabled || busy;
  const onTrack = tone === 'danger' ? 'bg-danger' : tone === 'warning' ? 'bg-warning' : 'bg-success';

  function flip() {
    if (locked) return;
    onChange(!checked);
  }

  const sw = (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      aria-busy={busy}
      disabled={disabled}
      onClick={flip}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); flip(); }
      }}
      class={`relative inline-flex shrink-0 items-center rounded-full
        transition-colors duration-normal
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2
        ${d.track}
        ${checked ? onTrack : 'bg-border-strong'}
        ${disabled ? 'opacity-50 cursor-not-allowed' : busy ? 'cursor-wait' : 'cursor-pointer'}`}
    >
      <span
        class={`pointer-events-none inline-block rounded-full bg-white shadow-sm transform
          transition-transform duration-normal
          ${d.knob}
          ${checked ? d.travel : 'translate-x-0.5'}
          ${busy ? 'animate-pulse' : ''}`}
      />
    </button>
  );

  if (!children) return sw;
  return (
    <span class={`inline-flex items-center gap-2 ${className}`}>
      {sw}
      {children}
    </span>
  );
}
