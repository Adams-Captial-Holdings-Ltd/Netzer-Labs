import { ComponentChildren, JSX } from 'preact';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

/**
 * Anything a native <button> accepts, minus the names this component gives its
 * own meaning to. Added so callers can pass `aria-label`, `title`, `id`,
 * `tabIndex`, `style` and `data-*` — none of which had a route through here
 * before, which is why an icon-only Button could not be given an accessible
 * name at all. Nothing about the existing props changes.
 */
type PassThrough = Omit<
  JSX.HTMLAttributes<HTMLButtonElement>,
  'children' | 'class' | 'className' | 'size' | 'icon' | 'loading' | 'type' | 'disabled' | 'onClick'
>;

interface ButtonProps extends PassThrough {
  children?: ComponentChildren;
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  disabled?: boolean;
  icon?: ComponentChildren;
  class?: string;
  type?: 'button' | 'submit';
  onClick?: (e: Event) => void;
}

const variantStyles: Record<Variant, string> = {
  primary: 'bg-primary text-inverse hover:bg-primary-hover shadow-sm',
  secondary: 'bg-surface border border-border text-primary hover:bg-surface-hover',
  ghost: 'text-secondary hover:bg-surface-hover hover:text-primary',
  danger: 'bg-danger text-white hover:opacity-90 shadow-sm',
};

const sizeStyles: Record<Size, string> = {
  sm: 'px-3 py-1.5 text-caption gap-1.5',
  md: 'px-4 py-2 text-body-sm gap-2',
  lg: 'px-6 py-2.5 text-body gap-2',
};

export function Button({
  children,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  icon,
  class: className = '',
  type = 'button',
  onClick,
  ...rest
}: ButtonProps) {
  return (
    <button
      // Spread FIRST so the explicit props below always win a name collision;
      // a caller cannot accidentally re-enable a disabled button.
      {...rest}
      type={type}
      disabled={disabled || loading}
      onClick={onClick}
      class={`inline-flex items-center justify-center font-medium rounded-lg transition-all duration-normal
        ${variantStyles[variant]} ${sizeStyles[size]}
        disabled:opacity-50 disabled:cursor-not-allowed
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2
        ${className}`}
    >
      {loading ? <Spinner /> : icon}
      {children}
    </button>
  );
}

function Spinner() {
  return (
    <svg class="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
