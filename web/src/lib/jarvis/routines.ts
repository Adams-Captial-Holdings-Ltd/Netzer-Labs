/**
 * Jarvis routines client state. A routine is a named saved prompt; clicking its
 * chip submits the prompt through runJarvisTextTurn exactly like typing it, so
 * there is no separate execution path on the client either.
 */

import { signal } from '@preact/signals';
import { api } from '../api';

export interface JarvisRoutine {
  id: string;
  name: string;
  prompt: string;
  showOnHover: boolean;
  updatedAt: string;
  updatedBy: string;
}

export const jarvisRoutines = signal<JarvisRoutine[]>([]);

/** Load routines (fail-quiet: chips just don't render if the read fails). */
export async function loadJarvisRoutines(): Promise<void> {
  try {
    const res = await api.get<{ routines: JarvisRoutine[] }>('/jarvis/routines');
    jarvisRoutines.value = res.routines;
  } catch {
    // Leave the last known list; an empty list on first load means no chips.
  }
}

/** Admin: create or update a routine, then refresh the shared list. */
export async function saveJarvisRoutine(
  id: string,
  input: { name: string; prompt: string; showOnHover: boolean },
): Promise<void> {
  await api.put(`/jarvis/routines/${encodeURIComponent(id)}`, input);
  await loadJarvisRoutines();
}

/** Admin: delete a routine, then refresh the shared list. */
export async function deleteJarvisRoutine(id: string): Promise<void> {
  await api.del(`/jarvis/routines/${encodeURIComponent(id)}`);
  await loadJarvisRoutines();
}

/** Slugify a display name into a routine id ("Morning brief" → "morning-brief"). */
export function routineIdFromName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}
