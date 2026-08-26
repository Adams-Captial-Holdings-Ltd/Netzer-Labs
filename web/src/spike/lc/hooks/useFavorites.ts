/* SPIKE SHIM — donor useFavorites persists pinned specs through react-query +
 * the user settings API. Local state is enough to exercise the pin button. */
import { useCallback, useState } from 'react';

export default function useFavorites() {
  const [pinned, setPinned] = useState<string[]>([]);
  const isFavoriteSpec = useCallback((name: string) => pinned.includes(name), [pinned]);
  const toggleFavoriteSpec = useCallback(
    (name: string) =>
      setPinned((prev) => (prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name])),
    [],
  );
  return { isFavoriteSpec, toggleFavoriteSpec };
}
