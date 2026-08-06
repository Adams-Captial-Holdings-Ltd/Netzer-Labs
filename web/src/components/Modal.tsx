import { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ComponentChildren;
  size?: 'sm' | 'md' | 'lg' | 'xl';
  danger?: boolean;
}

const sizes = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
};

export function Modal({ open, onClose, title, children, size = 'md', danger = false }: ModalProps) {
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', handler);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={backdropRef}
      class="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      onClick={(e) => { if (e.target === backdropRef.current) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div class={`bg-surface border border-border rounded-xl shadow-xl w-full ${sizes[size]} page-enter`}>
        {title && (
          <div class={`flex items-center justify-between px-6 py-4 border-b ${danger ? 'border-danger/30' : 'border-border'}`}>
            <h2 class={`text-heading-sm font-semibold ${danger ? 'text-danger' : 'text-primary'}`}>{title}</h2>
            <button
              onClick={onClose}
              class="text-muted hover:text-primary p-1 rounded-md hover:bg-surface-hover transition-colors"
              aria-label="Close"
            >
              <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}
        <div class="px-6 py-4">{children}</div>
      </div>
    </div>
  );
}

interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  loading?: boolean;
}

export function ConfirmDialog({ open, onClose, onConfirm, title, message, confirmLabel = 'Confirm', danger = false, loading = false }: ConfirmDialogProps) {
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm" danger={danger}>
      <p class="text-body-sm text-secondary mb-6">{message}</p>
      <div class="flex gap-3 justify-end">
        <button
          onClick={onClose}
          class="px-4 py-2 text-body-sm font-medium border border-border rounded-lg hover:bg-surface-hover transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={onConfirm}
          disabled={loading}
          class={`px-4 py-2 text-body-sm font-medium rounded-lg transition-colors text-white disabled:opacity-50
            ${danger ? 'bg-danger hover:bg-red-600' : 'bg-primary hover:bg-primary-hover'}`}
        >
          {loading ? 'Processing...' : confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
