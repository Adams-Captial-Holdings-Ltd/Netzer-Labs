/*
 * `@librechat/client` — the donor's UI primitive package, mapped onto this app.
 *
 * Aliased as the bare specifier `@librechat/client` in BOTH web/vite.config.ts
 * (`resolve.alias`) and web/tsconfig.json (`paths`), so a donor file that
 * imports it needs no edit at all.
 *
 * ── Why this file is the enabler ───────────────────────────────────────────
 *
 * The donor's `client/src` tree was copied to the QA repo; its sibling
 * workspace package `@librechat/client` was not, and is not published in a form
 * this app could install. The remaining donor import sites need only the
 * primitives below. Everything in this file exists to make that import resolve.
 *
 * ── The rule this file follows ─────────────────────────────────────────────
 *
 * MAP, don't reimplement. Where this app already owns the primitive, the export
 * is a thin adapter over ours and carries no styling of its own:
 *
 *   Button        -> web/src/components/Button.tsx
 *   TooltipAnchor -> web/src/components/InfoTooltip.tsx  (see the note on it)
 *
 * Where we have no counterpart (Spinner, Label, Input, useMediaQuery, the two
 * clipboard glyphs) the implementation is minimal and honest rather than a
 * transcription of the donor's: a Label that is a <label>, an Input that is an
 * <input>, and a media-query hook that is `matchMedia` plus
 * `useSyncExternalStore`.
 *
 * ── The one API shape that has to be translated ────────────────────────────
 *
 * Donor components are React and write `className`; this app is Preact and
 * writes `class`. Preact accepts both on host elements, but OUR components
 * destructure `class` specifically, so every adapter here does the rename. That
 * is the whole of the impedance mismatch — the aliasing spike (2,284 donor
 * lines, 8 edited) already proved the rest of preact/compat holds.
 */
import type { ComponentChildren, JSX, VNode } from 'preact';
import { cloneElement, isValidElement } from 'preact';
import { useCallback } from 'preact/hooks';
// `useSyncExternalStore` is a preact/compat export, not a preact/hooks one, and
// its signature has two parameters where React's has three (there is no server
// renderer here to hand a different snapshot to).
import { useSyncExternalStore } from 'preact/compat';
import { Check, Copy } from 'lucide-preact';
import { Button as AppButton } from '../../components/Button';
import { InfoTooltip } from '../../components/InfoTooltip';

/* ── Button ────────────────────────────────────────────────────────────────
 *
 * The donor's variant/size vocabulary is shadcn's; this app's is four variants
 * and three sizes. The translation below is the whole adapter — it deliberately
 * does NOT introduce new appearances, because a donor `variant="outline"` that
 * rendered as something this product does not otherwise draw would be a fifth
 * button style arriving through a shim.
 *
 * `variant={null}` and `size={null}` are the donor's own way of saying "no
 * chrome at all" (Scrim.tsx uses exactly that for a full-bleed surface), so
 * they are honoured as "pass the class list through untouched".
 */
type DonorVariant = 'default' | 'outline' | 'ghost' | 'destructive' | 'submit' | null;
type DonorSize = 'default' | 'sm' | 'lg' | 'icon' | null;

const VARIANT_MAP: Record<Exclude<DonorVariant, null>, 'primary' | 'secondary' | 'ghost' | 'danger'> = {
  default: 'primary',
  submit: 'primary',
  outline: 'secondary',
  ghost: 'ghost',
  destructive: 'danger',
};

const SIZE_MAP: Record<Exclude<DonorSize, null>, 'sm' | 'md' | 'lg'> = {
  default: 'md',
  sm: 'sm',
  lg: 'lg',
  // The donor's square glyph button. Our `sm` padding plus the square sizing
  // the caller's className supplies; `size-*` in that className wins because it
  // is appended after the size classes.
  icon: 'sm',
};

type ButtonProps = Omit<
  JSX.HTMLAttributes<HTMLButtonElement>,
  'children' | 'class' | 'className' | 'size' | 'type' | 'onClick'
> & {
  children?: ComponentChildren;
  variant?: DonorVariant;
  size?: DonorSize;
  className?: string;
  disabled?: boolean;
  type?: 'button' | 'submit';
  onClick?: (e: Event) => void;
};

export function Button({ variant, size, className, children, ...rest }: ButtonProps) {
  // `null` is the donor's explicit "no chrome". Undefined means "the donor did
  // not say", which is its `default`.
  const appVariant = variant === null ? 'ghost' : VARIANT_MAP[variant ?? 'default'];
  const appSize = size === null ? 'sm' : SIZE_MAP[size ?? 'default'];
  return (
    <AppButton {...rest} variant={appVariant} size={appSize} class={className}>
      {children}
    </AppButton>
  );
}

/* ── TooltipAnchor ─────────────────────────────────────────────────────────
 *
 * The donor's is Ariakit's tooltip behind a render prop. The spike branch shims
 * it the same way and pulls in @ariakit/react to do it. This one does not, and
 * the reason is specific rather than budgetary: every donor call site that uses
 * the `render` form passes a control that ALREADY carries its own `aria-label`,
 * with `description` repeating that same string. A tooltip in that position
 * adds a visual echo of a name the control already announces — it is not the
 * thing making the control reachable — and the spike also measured Ariakit's
 * keyboard navigation as silently dead under Preact (useId collides across
 * portal roots). Importing a library whose keyboard path does not work, to
 * decorate a control that is already labelled, is the trade this file refuses.
 *
 * So:
 *   render form   -> the rendered element, with the browser's own `title`
 *                    carrying `description`. Keyboard users still get the
 *                    accessible name from the element's aria-label.
 *   children form -> our InfoTooltip, which is a real hover AND focus tooltip
 *                    with aria-describedby and Escape-to-dismiss.
 */
export function TooltipAnchor({
  description,
  render,
  children,
  className,
}: {
  description?: string;
  render?: VNode<Record<string, unknown>>;
  children?: ComponentChildren;
  className?: string;
}) {
  if (render && isValidElement(render)) {
    return cloneElement(render, { title: description });
  }
  return (
    <span class={className}>
      <InfoTooltip text={description}>{children}</InfoTooltip>
    </span>
  );
}

/* ── Spinner ───────────────────────────────────────────────────────────────
 * We have no exported spinner (Button.tsx keeps a private one), so this is a
 * minimal honest implementation. `currentColor` so it inherits the ink of
 * whatever row it lands in, and aria-hidden because a spinner beside text that
 * already says what is happening is decoration.
 */
export function Spinner({ className }: { className?: string }) {
  return (
    <svg
      class={`animate-spin ${className ?? 'h-4 w-4'}`}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
      <path
        class="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
      />
    </svg>
  );
}

/* ── Label / Input ─────────────────────────────────────────────────────────
 * No counterpart exists in this app — form controls here are written inline. A
 * <label> and an <input> with the app's own focus ring is the honest floor;
 * anything more would be inventing a design system component through a shim.
 */
export function Label({
  className,
  children,
  ...rest
}: JSX.HTMLAttributes<HTMLLabelElement> & { className?: string; children?: ComponentChildren }) {
  return (
    <label {...rest} class={`text-body-sm font-medium text-primary ${className ?? ''}`}>
      {children}
    </label>
  );
}

export function Input({
  className,
  ...rest
}: JSX.HTMLAttributes<HTMLInputElement> & { className?: string }) {
  return (
    <input
      {...rest}
      class={`w-full rounded-lg border border-border bg-surface px-3 py-2 text-body-sm text-primary
        outline-none focus-visible:ring-2 focus-visible:ring-primary ${className ?? ''}`}
    />
  );
}

/* ── useMediaQuery ─────────────────────────────────────────────────────────
 * `useSyncExternalStore` rather than `useState` + effect: the first paint has
 * to agree with the media state or a reduced-motion reader sees one frame of
 * the animation the query exists to suppress. `getSnapshot` guards `matchMedia`
 * itself and returns false where it is missing, which is the safe branch for
 * every query in the ported tree — React's third `getServerSnapshot` parameter
 * has no counterpart in preact/compat, and nothing here server-renders.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (typeof window === 'undefined' || !window.matchMedia) return () => undefined;
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onStoreChange);
      return () => mql.removeEventListener('change', onStoreChange);
    },
    [query],
  );
  const getSnapshot = useCallback(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  }, [query]);
  return useSyncExternalStore(subscribe, getSnapshot);
}

/* ── Glyphs ────────────────────────────────────────────────────────────────
 * The donor ships its own SVGs; this app already depends on lucide-preact and
 * uses it everywhere else, so the two clipboard glyphs are lucide's. Named as
 * the donor names them so its call sites are unchanged.
 */
export function Clipboard({ className }: { className?: string }) {
  return <Copy class={className} aria-hidden="true" />;
}

export function CheckMark({ className }: { className?: string }) {
  return <Check class={className} aria-hidden="true" />;
}
