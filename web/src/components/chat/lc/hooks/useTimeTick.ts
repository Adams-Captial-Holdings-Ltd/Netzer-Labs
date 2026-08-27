/*
 * VERBATIM COPY from danny-avila/LibreChat (MIT), pinned at commit
 * 6d499ba3ce17f906a7762429c61018f230ecd64e -- donor path
 * `client/src/hooks/useTimeTick.ts`.
 *
 * 33 lines, `useSyncExternalStore` its only import. ONE EDIT, on the last line
 * of the file:
 *
 *   `useSyncExternalStore(subscribe, getSnapshot, getSnapshot)`
 *   -> `useSyncExternalStore(subscribe, getSnapshot)`
 *
 * The third argument is React's `getServerSnapshot`, and preact/compat's
 * signature has only two -- there is no server renderer here to hand a
 * different snapshot to, so the parameter does not exist rather than being
 * ignored. The donor passes `getSnapshot` for both, so dropping it changes no
 * behaviour: the value returned is identical either way. Everything above that
 * line is byte-for-byte.
 *
 * WIRED: MessageTimestamp subscribes recent rows to it, so a transcript left
 * open keeps its relative times current. The ref-counted single interval is
 * the point -- a per-row timer in a long conversation is a timer per row.
 */
import { useSyncExternalStore } from 'react';

const listeners = new Set<() => void>();
let tick = 0;
let intervalId: ReturnType<typeof setInterval> | null = null;

const subscribe = (onStoreChange: () => void): (() => void) => {
  listeners.add(onStoreChange);
  if (intervalId === null) {
    intervalId = setInterval(() => {
      tick += 1;
      listeners.forEach((listener) => listener());
    }, 60_000);
  }
  return () => {
    listeners.delete(onStoreChange);
    if (listeners.size === 0 && intervalId !== null) {
      clearInterval(intervalId);
      intervalId = null;
    }
  };
};

const getSnapshot = (): number => tick;

/**
 * Subscribes to a shared, ref-counted ticker that fires once a minute, so components
 * displaying relative time stay current while a view is left open. A single interval
 * is shared across all subscribers and is cleared when the last one unsubscribes.
 */
export default function useTimeTick(): number {
  return useSyncExternalStore(subscribe, getSnapshot);
}
