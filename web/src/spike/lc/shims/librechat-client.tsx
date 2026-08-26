/* SPIKE SHIM — module alias for the donor's `@librechat/client` workspace
 * package (its own React component library). Only the three exports the
 * spiked components import are provided. */
import { forwardRef } from 'react';
import ReactTextareaAutosize from 'react-textarea-autosize';
import type { TextareaAutosizeProps } from 'react-textarea-autosize';
import * as Ariakit from '@ariakit/react';

export const useToastContext = () => ({ showToast: (_o: unknown) => undefined });

/** Donor TooltipAnchor wraps Ariakit's tooltip; the render prop is what the
 *  spiked ModelSelector relies on, so it is preserved. */
export function TooltipAnchor({
  description,
  render,
  ...props
}: {
  description?: string;
  render?: Ariakit.TooltipAnchorProps['render'];
  'aria-label'?: string;
}) {
  return (
    <Ariakit.TooltipProvider showTimeout={150}>
      <Ariakit.TooltipAnchor {...props} render={render} />
      <Ariakit.Tooltip className="z-50 rounded-md border border-border-light bg-presentation px-2 py-1 text-xs text-text-primary shadow">
        {description}
      </Ariakit.Tooltip>
    </Ariakit.TooltipProvider>
  );
}

/** Donor TextareaAutosize, minus its jotai chat-direction atom. */
export const TextareaAutosize = forwardRef<HTMLTextAreaElement, TextareaAutosizeProps>(
  (props, ref) => <ReactTextareaAutosize {...props} ref={ref} />,
);
