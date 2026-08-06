import { ComponentChildren } from 'preact';

interface EmptyStateProps {
  icon?: ComponentChildren;
  title: string;
  description?: string;
  action?: ComponentChildren;
  class?: string;
}

function DefaultIcon() {
  return (
    <svg class="w-12 h-12 text-muted" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24" stroke-linecap="round" stroke-linejoin="round">
      <rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

export function EmptyState({ icon, title, description, action, class: className = '' }: EmptyStateProps) {
  return (
    <div class={`flex flex-col items-center justify-center py-16 px-8 text-center ${className}`}>
      <div class="mb-4">{icon ?? <DefaultIcon />}</div>
      <h3 class="text-heading-sm text-primary font-semibold mb-2">{title}</h3>
      {description && <p class="text-body-sm text-secondary max-w-sm mb-6">{description}</p>}
      {action}
    </div>
  );
}
