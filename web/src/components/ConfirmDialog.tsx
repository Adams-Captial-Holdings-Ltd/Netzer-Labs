import { useEffect, useId, useRef, useState } from 'preact/hooks';

interface ConfirmDialogProps {
  /** Controls visibility. When false the dialog renders nothing. */
  open: boolean;
  /** Heading shown at the top of the dialog. */
  title: string;
  /** Body copy explaining the consequence of confirming. */
  message: string;
  /**
   * The exact phrase the user must type to unlock the confirm button. Matching
   * is exact (trimmed). Required: this dialog is for irreversible / high-impact
   * actions, so the type-to-confirm gate is always present.
   */
  confirmPhrase: string;
  /** Label for the confirm button. Defaults to "Confirm". */
  confirmLabel?: string;
  /** Style the confirm action as destructive (red). */
  danger?: boolean;
  /** Called when the user confirms (only reachable once the phrase matches). */
  onConfirm: () => void;
  /** Called on Cancel, Escape, or overlay click. */
  onCancel: () => void;
}

/**
 * A modal that requires the user to TYPE an exact confirmation phrase before
 * the confirm button becomes enabled. For irreversible or high-blast-radius
 * actions (panic, delete, force-release) where a single misclick is too cheap.
 *
 * Behavior:
 *  - Confirm stays disabled until the typed value equals `confirmPhrase`.
 *  - Escape or clicking the overlay calls `onCancel`.
 *  - Enter submits only when the phrase already matches.
 *  - The input is cleared and refocused each time the dialog opens.
 *  - Never calls native window.confirm / alert.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmPhrase,
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

  const matches = typed.trim() === confirmPhrase.trim();

  // Escape to cancel + lock body scroll while open. Mirrors Modal.tsx.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    document.addEventListener('keydown', handler);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handler);
      document.body.style.overflow = '';
    };
  }, [open, onCancel]);

  // Reset the typed phrase and focus the input each time we open, so a stale
  // value can never leave the confirm button pre-enabled.
  useEffect(() => {
    if (open) {
      setTyped('');
      // Defer focus to after the node mounts.
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  if (!open) return null;

  return (
    <div
      ref={overlayRef}
      class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      onClick={(e) => { if (e.target === overlayRef.current) onCancel(); }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      aria-describedby={descId}
    >
      <div class="bg-surface border border-border rounded-xl shadow-xl w-full max-w-md page-enter">
        <div class={`px-6 py-4 border-b ${danger ? 'border-danger/30' : 'border-border'}`}>
          <h2 class={`text-heading-sm font-semibold ${danger ? 'text-danger' : 'text-primary'}`}>{title}</h2>
        </div>

        <div class="px-6 py-4">
          <p id={descId} class="text-body-sm text-secondary mb-4">{message}</p>

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
              if (e.key === 'Enter' && matches) { e.preventDefault(); onConfirm(); }
            }}
            placeholder={confirmPhrase}
            class="w-full px-3 py-2 bg-surface border border-border rounded-lg text-body-sm text-primary
              font-mono placeholder:text-muted placeholder:font-sans
              focus:outline-none focus:ring-2 focus:ring-primary"
          />
        </div>

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
            class={`px-4 py-2 text-body-sm font-medium rounded-lg transition-colors text-white
              disabled:opacity-50 disabled:cursor-not-allowed
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2
              ${danger
                ? 'bg-danger hover:bg-red-600 focus-visible:ring-danger'
                : 'bg-primary hover:bg-primary-hover focus-visible:ring-primary'}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
