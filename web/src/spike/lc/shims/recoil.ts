/* SPIKE SHIM — module alias for `recoil`. The spiked components only ever call
 * useRecoilValue(store.X); the store shim holds plain values, so this is the
 * identity function. Proves the coupling is shallow, not that recoil works. */
export const useRecoilValue = <T,>(value: T): T => value;
export const useRecoilState = <T,>(value: T): [T, (next: T) => void] => [value, () => undefined];
