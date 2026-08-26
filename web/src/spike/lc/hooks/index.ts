/* SPIKE SHIM — donor `~/hooks` barrel. Only `useLocalize` is reachable from
 * the spiked components; it returns the phrase key so nothing renders blank. */
export const useLocalize =
  () =>
  (key: string, _opts?: unknown): string =>
    key;
export { default as useIsActiveItem } from '../components/Chat/Menus/Endpoints/useActiveItem';
export { default as useFavorites } from './useFavorites';
