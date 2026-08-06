interface ErrorStateProps {
  title?: string;
  message?: string;
  onRetry?: () => void;
  class?: string;
}

function DangerIcon() {
  return (
    <svg class="w-12 h-12 text-danger" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  );
}

export function ErrorState({
  title = 'Could not load data',
  message = 'Something went wrong while loading this. This is an error, not an empty result.',
  onRetry,
  class: className = '',
}: ErrorStateProps) {
  return (
    <div class={`flex flex-col items-center justify-center py-16 px-8 text-center border border-danger/30 rounded-xl bg-danger/5 ${className}`}>
      <div class="mb-4"><DangerIcon /></div>
      <h3 class="text-heading-sm text-danger font-semibold mb-2">{title}</h3>
      {message && <p class="text-body-sm text-secondary max-w-sm mb-6">{message}</p>}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          class="inline-flex items-center justify-center font-medium rounded-lg transition-all duration-normal px-4 py-2 text-body-sm gap-2 bg-danger/10 text-danger hover:bg-danger/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger focus-visible:ring-offset-2"
        >
          Try again
        </button>
      )}
    </div>
  );
}
