import { signal } from '@preact/signals';
import { useEffect } from 'preact/hooks';

type ToastVariant = 'success' | 'error' | 'warning' | 'info';

interface Toast {
  id: number;
  message: string;
  variant: ToastVariant;
  duration: number;
}

let nextId = 0;
const MAX_TOASTS = 5;
export const toasts = signal<Toast[]>([]);

export function toast(message: string, variant: ToastVariant = 'info', duration = 4000) {
  const id = nextId++;
  const current = toasts.value;
  toasts.value = [...current.slice(-(MAX_TOASTS - 1)), { id, message, variant, duration }];
}

function dismiss(id: number) {
  toasts.value = toasts.value.filter((t) => t.id !== id);
}

const variantStyles: Record<ToastVariant, { bg: string; icon: string }> = {
  success: { bg: 'bg-success/10 border-success/30 text-success', icon: '✓' },
  error: { bg: 'bg-danger/10 border-danger/30 text-danger', icon: '✕' },
  warning: { bg: 'bg-warning/10 border-warning/30 text-warning', icon: '⚠' },
  info: { bg: 'bg-primary/10 border-primary/30 text-primary', icon: 'ℹ' },
};

function ToastItem({ t }: { t: Toast }) {
  useEffect(() => {
    const timer = setTimeout(() => dismiss(t.id), t.duration);
    return () => clearTimeout(timer);
  }, [t.id, t.duration]);

  const style = variantStyles[t.variant];
  return (
    <div class={`flex items-center gap-3 px-4 py-3 rounded-lg border shadow-md ${style.bg} page-enter`}>
      <span class="font-bold text-sm">{style.icon}</span>
      <p class="text-body-sm font-medium flex-1">{t.message}</p>
      <button onClick={() => dismiss(t.id)} class="opacity-60 hover:opacity-100 text-sm">
        ✕
      </button>
    </div>
  );
}

export function ToastContainer() {
  const items = toasts.value;
  if (items.length === 0) return null;
  return (
    <div
      class="fixed bottom-4 left-4 right-4 sm:left-auto z-[60] flex flex-col gap-2 max-w-sm sm:w-full pointer-events-auto"
      aria-live="polite"
    >
      {items.map((t) => <ToastItem key={t.id} t={t} />)}
    </div>
  );
}
