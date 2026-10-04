import { ComponentChildren, JSX } from 'preact';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-outline';
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

// Hover styles are skipped while aria-disabled, so an inactive button does not look like it answers.
// The classes are written out in full: Tailwind cannot see a class built from parts.
const variantStyles: Record<Variant, string> = {
  primary: 'bg-primary text-inverse [&:not([aria-disabled=true]):hover]:bg-primary-hover shadow-sm',
  secondary: 'bg-surface border border-border text-primary [&:not([aria-disabled=true]):hover]:bg-surface-hover',
  ghost: `text-secondary [&:not([aria-disabled=true]):hover]:bg-surface-hover
    [&:not([aria-disabled=true]):hover]:text-primary`,
  danger: 'bg-danger text-white [&:not([aria-disabled=true]):hover]:opacity-90 shadow-sm',
  'danger-outline': 'border border-danger text-danger-text [&:not([aria-disabled=true]):hover]:bg-danger-dim',
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
  // aria-disabled keeps the button in the Tab order so its reason can be read. It dims like a
  // native disabled button. Unlike native disabled it still delivers the click, so the caller
  // decides what an inactive press does (a hint, a focus move) and must not act on it.
  const ariaDisabled = rest['aria-disabled'] === true || rest['aria-disabled'] === 'true';
  return (
    <button
      // Spread FIRST so the explicit props below always win a name collision. A caller that passes
      // aria-disabled gets that form (still focusable) instead of native disabled.
      {...rest}
      type={type}
      disabled={(disabled || loading) && !ariaDisabled}
      onClick={onClick}
      class={`${size === 'lg' ? 'relative ' : ''}inline-flex items-center justify-center font-medium rounded-lg transition-colors duration-normal
        ${variantStyles[variant]} ${sizeStyles[size]}
        disabled:opacity-50 disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:cursor-not-allowed
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2
        focus-visible:ring-offset-bg
        ${className}`}
    >
      {loading ? <Spinner overlay={size === 'lg'} /> : icon}
      {children}
    </button>
  );
}

// At lg the spinner sits in the button's left padding (4px in, 4px clear of the label), so showing it
// never changes the button's width.
function Spinner({ overlay }: { overlay: boolean }) {
  return (
    <svg class={`animate-spin h-4 w-4 ${overlay ? 'absolute left-1 top-1/2 -mt-2' : ''}`} viewBox="0 0 24 24" fill="none">
      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
      <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
    </svg>
  );
}
