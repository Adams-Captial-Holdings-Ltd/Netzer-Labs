/* SPIKE (spike/preact-compat) — the `react` alias target.
 *
 * WHY THIS EXISTS INSTEAD OF ALIASING STRAIGHT TO `preact/compat`:
 *
 * Ariakit's `useEvent` (packages/ariakit-react-utils/src/hooks.ts) installs a
 * component's real event callback into a ref inside `useInsertionEffect`, and
 * seeds that ref with a function that throws
 * "Cannot call an event handler while rendering."
 *
 *   const useEventUpdate = useReactInsertionEffect ?? ((cb) => cb());
 *
 * React runs `useInsertionEffect` BEFORE it attaches DOM refs. Preact aliases
 * it to `useLayoutEffect` (preact/compat/src/hooks.js:67), which runs AFTER ref
 * attachment. Ariakit merges refs (`useMergeRefs` -> `setRef`) and one of the
 * merged refs is itself a `useEvent` callback, so on mount that callback fires
 * while `ref.current` is still the seeded thrower. The throw escapes Preact's
 * `applyRef`, which aborts the rest of the commit — so the layout-effect flush
 * that would have installed the real callbacks never runs, and from then on
 * EVERY Ariakit event handler throws. The menu never opens.
 *
 * Ariakit already has a correct path for runtimes without
 * `useInsertionEffect`: it calls the updater synchronously during render, which
 * installs the callback before any ref runs. Withholding the hook from the
 * `react` namespace selects that path.
 *
 * COST: this is a lie about the runtime. Any donor dependency that genuinely
 * needs insertion-phase semantics (CSS-in-JS style injection: styled-components,
 * emotion, goober) silently loses them. It is a per-library gamble, not a
 * general fix.
 */
export {
  Children,
  Component,
  Fragment,
  PureComponent,
  StrictMode,
  Suspense,
  SuspenseList,
  cloneElement,
  createContext,
  createElement,
  createFactory,
  createPortal,
  createRef,
  findDOMNode,
  flushSync,
  forwardRef,
  hydrate,
  isFragment,
  isMemo,
  isValidElement,
  lazy,
  memo,
  render,
  startTransition,
  unmountComponentAtNode,
  unstable_batchedUpdates,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  version,
} from 'preact/compat';
/* NOTE: `useInsertionEffect` is deliberately NOT re-exported. */

export { default } from 'preact/compat';
