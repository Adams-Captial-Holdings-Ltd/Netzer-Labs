import { ComponentChildren } from 'preact';

type BadgeVariant = 'default' | 'success' | 'danger' | 'warning' | 'info' | 'muted';

const styles: Record<BadgeVariant, string> = {
  default: 'bg-surface-elevated text-secondary border border-border',
  success: 'bg-success/10 text-success',
  danger: 'bg-danger/10 text-danger',
  warning: 'bg-warning/10 text-warning',
  info: 'bg-primary/10 text-primary',
  muted: 'bg-surface-elevated text-muted',
};

interface BadgeProps {
  children: ComponentChildren;
  variant?: BadgeVariant;
  class?: string;
}

export function Badge({ children, variant = 'default', class: className = '' }: BadgeProps) {
  return (
    <span class={`inline-flex items-center gap-1 text-overline px-2 py-0.5 rounded-full font-medium ${styles[variant]} ${className}`}>
      {children}
    </span>
  );
}
