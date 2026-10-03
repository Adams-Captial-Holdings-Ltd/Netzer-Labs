let draining = false;
let inFlight = 0;
let generation = 0;
const waiters = new Set<() => void>();

export function beginDispatchDrain(): void { draining = true; }
export function isDispatchDraining(): boolean { return draining; }
export function trackDispatch(): () => void {
  inFlight++;
  const heldGeneration = generation;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (heldGeneration !== generation) return;
    if (--inFlight === 0) { for (const wake of waiters) wake(); waiters.clear(); }
  };
}
export function dispatchesInFlight(): number { return inFlight; }
export function dispatchesIdle(): Promise<void> {
  return inFlight === 0 ? Promise.resolve() : new Promise((resolve) => { waiters.add(resolve); });
}
export function __resetDispatchDrainForTest(): void {
  draining = false;
  generation++;
  inFlight = 0;
  for (const wake of waiters) wake();
  waiters.clear();
}
