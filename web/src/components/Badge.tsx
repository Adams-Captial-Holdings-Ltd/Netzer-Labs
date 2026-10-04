import { ComponentChildren } from 'preact';

export type BadgeVariant = 'default' | 'success' | 'danger' | 'warning' | 'info' | 'muted'
  | 'success-dim' | 'danger-dim' | 'warning-dim' | 'neutral-dim';

const styles: Record<BadgeVariant, string> = {
  default: 'text-overline bg-surface-elevated text-secondary border border-border',
  success: 'text-overline bg-success/10 text-success',
  danger: 'text-overline bg-danger/10 text-danger',
  warning: 'text-overline bg-warning/10 text-warning',
  info: 'text-overline bg-primary/10 text-primary',
  muted: 'text-overline bg-surface-elevated text-muted',
  // Status badges for detail headers (design.md sections 5 and 8): a *-dim ground and readable text.
  'success-dim': 'text-caption bg-success-dim text-primary',
  'danger-dim': 'text-caption bg-danger-dim text-danger-text',
  'warning-dim': 'text-caption bg-warning-dim text-primary',
  'neutral-dim': 'text-caption bg-surface-elevated text-secondary border border-border',
};

interface BadgeProps {
  children: ComponentChildren;
  variant?: BadgeVariant;
  class?: string;
}

export function Badge({ children, variant = 'default', class: className = '' }: BadgeProps) {
  return (
    <span class={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full font-medium ${styles[variant]} ${className}`}>
      {children}
    </span>
  );
}
