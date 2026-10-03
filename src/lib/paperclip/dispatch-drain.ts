let draining = false;

export function beginDispatchDrain(): void { draining = true; }
export function isDispatchDraining(): boolean { return draining; }
export function __resetDispatchDrainForTest(): void { draining = false; }
