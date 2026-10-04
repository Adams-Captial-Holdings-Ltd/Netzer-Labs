import type { ComponentChildren } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { Button } from './Button';

type ConfirmDialogProps = {
  /** Controls visibility. When false the dialog renders nothing. */
  open: boolean;
  /** Heading shown at the top of the dialog. */
  title: string;
  /** Body copy explaining the consequence of confirming. */
  message: ComponentChildren;

  /** Label for the confirm button. Defaults to "Confirm". */
  confirmLabel?: string;
  /** Style the confirm action as destructive (red). */
  danger?: boolean;
  /** Called when the user confirms. */
  onConfirm: () => void;
  /** Called on Cancel, Escape, or overlay click. */
  onCancel: () => void;
} & ({ confirmPhrase: string; simple?: never } | { simple: true; confirmPhrase?: never });

/**
 * A modal with an optional type-to-confirm gate for high-impact actions.
 *
 * Behavior:
 *  - With a phrase, Confirm stays disabled until the typed value matches.
 *  - Escape or clicking the overlay calls `onCancel`.
 *  - Enter in the phrase input submits only when the phrase matches.
 *  - On open, focus goes to the input with a phrase, otherwise to Cancel.
 *  - Never calls native window.confirm / alert.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmPhrase,
  simple,
  confirmLabel = 'Confirm',
  danger = false,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState('');
  const inputId = useId();
  const descId = useId();

  const matches = confirmPhrase === undefined || typed.trim() === confirmPhrase.trim();

  // Escape to cancel + lock body scroll while open. Mirrors Modal.tsx.
  useEffect(() => {
    if (!open) return;
    // Focus that leaves the dialog (a click outside, a script) is pulled back in.
    const pullBack = (e: FocusEvent) => {
      const overlay = overlayRef.current;
      if (!overlay || (e.target instanceof Node && overlay.contains(e.target))) return;
      overlay.querySelector<HTMLElement>('input, button:not(:disabled)')?.focus();
    };
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Tab' && overlayRef.current) {
        const controls = [...overlayRef.current.querySelectorAll<HTMLElement>('input, button:not(:disabled)')];
        const first = controls[0];
        const last = controls[controls.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', handler);
    document.addEventListener('focusin', pullBack);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handler);
      document.removeEventListener('focusin', pullBack);
      document.body.style.overflow = '';
    };
  }, [open, onCancel]);

  // Reset the phrase on open and return focus to the opener on close.
  useEffect(() => {
    if (open) {
      const opener = document.activeElement;
      setTyped('');
      const t = setTimeout(
        () =>
          (confirmPhrase === undefined
            ? overlayRef.current?.querySelector<HTMLElement>('[data-initial-focus]')
            : inputRef.current
          )?.focus(),
        0,
      );
      return () => {
        clearTimeout(t);
        if (opener instanceof HTMLElement) opener.focus();
      };
    }
  }, [open, confirmPhrase]);

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      class={`fixed inset-0 z-50 flex items-center justify-center p-4
        ${simple ? 'overflow-y-auto bg-scrim' : 'bg-black/50 backdrop-blur-sm'}`}
      onClick={(e) => {
        if (e.target === overlayRef.current) onCancel();
      }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      aria-describedby={descId}
    >
      {/* Simple form: my-auto centres the panel and lets the overlay scroll when the screen is shorter than
          the panel (400% zoom), so both buttons stay reachable. It is opaque from the first frame. */}
      <div
        class={`bg-surface border border-border rounded-xl shadow-xl w-full max-w-md ${simple ? 'my-auto' : 'page-enter'}`}
      >
        <div class={`px-6 py-4 border-b ${danger ? 'border-danger/30' : 'border-border'}`}>
          <h2 class={`text-heading-sm font-semibold break-words ${danger ? 'text-danger' : 'text-primary'}`}>{title}</h2>
        </div>

        <div class="px-6 py-4">
          <p id={descId} class="text-body-sm text-secondary mb-4 break-words">{message}</p>

          {confirmPhrase !== undefined && (
            <>
              <label for={inputId} class="block text-caption text-secondary font-medium mb-1">
                Type <span class="font-mono font-semibold text-primary">{confirmPhrase}</span> to confirm
              </label>
              <input
                id={inputId}
                ref={inputRef}
                type="text"
                value={typed}
                autocomplete="off"
                spellcheck={false}
                onInput={(e) => setTyped((e.target as HTMLInputElement).value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && matches) {
                    e.preventDefault();
                    onConfirm();
                  }
                }}
                placeholder={confirmPhrase}
                class="w-full px-3 py-2 bg-surface border border-border rounded-lg text-body-sm text-primary
                  font-mono placeholder:text-muted placeholder:font-sans
                  focus:outline-none focus:ring-2 focus:ring-primary"
              />
            </>
          )}
        </div>

        {simple ? (
          // Reading order is Cancel then Approve (Cancel holds the first focus).
          // Below sm the column is reversed so Approve sits on top, full width.
          <div class="flex flex-col-reverse gap-6 px-6 py-4 border-t border-border sm:flex-row sm:justify-end">
            <Button size="lg" variant="secondary" data-initial-focus="true" onClick={onCancel} class="w-full sm:w-auto">
              Cancel
            </Button>
            <Button size="lg" onClick={onConfirm} class="w-full sm:w-auto">
              {confirmLabel}
            </Button>
          </div>
        ) : (
          <div class="flex gap-3 justify-end px-6 py-4 border-t border-border">
            <button
              type="button"
              onClick={onCancel}
              class="px-4 py-2 text-body-sm font-medium border border-border rounded-lg hover:bg-surface-hover transition-colors
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={!matches}
              aria-disabled={!matches}
              class={`px-4 py-2 text-body-sm font-medium rounded-lg transition-colors
                disabled:opacity-50 disabled:cursor-not-allowed
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2
                ${danger
                  ? 'bg-danger text-white hover:bg-red-600 focus-visible:ring-danger'
                  : 'bg-primary text-inverse hover:bg-primary-hover focus-visible:ring-primary'}`}
            >
              {confirmLabel}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
