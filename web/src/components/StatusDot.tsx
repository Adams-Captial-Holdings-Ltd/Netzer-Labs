interface StatusDotProps {
  status: 'active' | 'inactive' | 'error' | 'warning' | 'healthy' | 'idle' | 'degraded' | 'success';
  size?: 'sm' | 'md';
  label?: string;
}

const colors: Record<string, string> = {
  active: 'bg-success',
  healthy: 'bg-success',
  success: 'bg-success',
  inactive: 'bg-gray-300 dark:bg-gray-600',
  idle: 'bg-gray-300 dark:bg-gray-600',
  error: 'bg-danger',
  warning: 'bg-warning',
  degraded: 'bg-warning',
};

export function StatusDot({ status, size = 'sm', label }: StatusDotProps) {
  const dim = size === 'sm' ? 'h-2 w-2' : 'h-2.5 w-2.5';
  return (
    <span class="inline-flex items-center gap-1.5">
      <span class={`relative flex ${dim}`}>
        {(status === 'active' || status === 'healthy') && (
          <span class={`animate-ping absolute inline-flex h-full w-full rounded-full ${colors[status] ?? colors.inactive} opacity-75`} />
        )}
        <span class={`relative inline-flex rounded-full ${dim} ${colors[status] ?? colors.inactive}`} />
      </span>
      {label && <span class="text-caption text-secondary">{label}</span>}
    </span>
  );
}
