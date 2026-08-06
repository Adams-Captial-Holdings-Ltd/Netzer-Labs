import { ComponentChildren } from 'preact';
import { useId, useState } from 'preact/hooks';
import { getDefinition } from '../lib/glossary';

interface InfoTooltipProps {
  /**
   * Explicit tooltip text. If omitted, `term` is looked up in the glossary.
   * If both are given, `text` wins.
   */
  text?: string;
  /**
   * Glossary key to resolve the definition from. Used when `text` is not
   * provided. If the term is unknown and no `text` is set, the tooltip renders
   * nothing (the trigger still renders so layout is stable).
   */
  term?: string;
  /**
   * Optional custom trigger. Defaults to a small question-mark affordance.
   * Whatever you pass becomes the hover/focus target.
   */
  children?: ComponentChildren;
}

/**
 * A small help affordance that reveals a tooltip on hover AND keyboard focus.
 *
 * Accessibility:
 *  - The trigger is a real <button> so it is keyboard focusable and announced.
 *  - The tooltip is wired with aria-describedby -> the tooltip's id.
 *  - Shows on mouseenter/focus, hides on mouseleave/blur and on Escape.
 *
 * Resolution order for the tooltip body: `text` prop, else glossary[`term`].
 */
export function InfoTooltip({ text, term, children }: InfoTooltipProps) {
  const [open, setOpen] = useState(false);
  const tooltipId = useId();

  const body = text ?? (term ? getDefinition(term) : undefined);

  // Nothing to say: render the trigger only when caller supplied custom children
  // (so wrapping markup is preserved); otherwise render nothing at all.
  if (!body) return children ? <>{children}</> : null;

  const show = () => setOpen(true);
  const hide = () => setOpen(false);

  return (
    <span class="relative inline-flex items-center align-middle">
      <button
        type="button"
        aria-label="More information"
        aria-describedby={open ? tooltipId : undefined}
        class="inline-flex items-center justify-center text-muted hover:text-secondary transition-colors
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-full"
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onKeyDown={(e) => { if (e.key === 'Escape') hide(); }}
        onClick={(e) => { e.preventDefault(); setOpen((v) => !v); }}
      >
        {children ?? (
          <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <path stroke-linecap="round" stroke-linejoin="round" d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7" />
            <line x1="12" y1="17" x2="12.01" y2="17" stroke-linecap="round" />
          </svg>
        )}
      </button>
      {open && (
        <span
          id={tooltipId}
          role="tooltip"
          class="absolute left-1/2 bottom-full z-50 mb-2 -translate-x-1/2 w-max max-w-xs
            px-3 py-2 rounded-lg bg-surface-elevated border border-border shadow-lg
            text-caption text-secondary leading-snug pointer-events-none page-enter"
        >
          {body}
        </span>
      )}
    </span>
  );
}
