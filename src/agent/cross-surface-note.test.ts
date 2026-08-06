import { describe, it, expect } from 'vitest';
import { buildCrossSurfaceNote } from './agent-loop.js';
import type { Turn } from '../lib/state/sessions-repo.js';

const NOW = 1_800_000_000;

function turn(surface: Turn['surface'], agoSec: number, role: Turn['role'] = 'user'): Turn {
  return { role, text: 'x', ts: NOW - agoSec, surface };
}

describe('buildCrossSurfaceNote', () => {
  it('returns undefined when history is single-surface', () => {
    const history = [turn('telegram', 100), turn('telegram', 50, 'assistant')];
    expect(buildCrossSurfaceNote(history, 'telegram', NOW)).toBeUndefined();
  });

  it('returns undefined when no current surface is known', () => {
    expect(buildCrossSurfaceNote([turn('slack', 10)], undefined, NOW)).toBeUndefined();
  });

  it('returns undefined for legacy turns without surface tags', () => {
    const history: Turn[] = [{ role: 'user', text: 'x', ts: NOW - 10 }];
    expect(buildCrossSurfaceNote(history, 'telegram', NOW)).toBeUndefined();
  });

  it('ignores system turns (scheduled tasks are not "another surface")', () => {
    const history = [turn('telegram', 100), turn('system', 50)];
    expect(buildCrossSurfaceNote(history, 'telegram', NOW)).toBeUndefined();
  });

  it('emits the note when surfaces mix, with recency', () => {
    const history = [
      turn('slack', 2 * 3600),
      turn('slack', 2 * 3600, 'assistant'),
      turn('telegram', 300),
    ];
    const note = buildCrossSurfaceNote(history, 'telegram', NOW);
    expect(note).toBeDefined();
    expect(note).toContain('<other_surfaces>');
    expect(note).toContain('last slack message 2h ago');
    expect(note).toContain('continue naturally here on telegram');
    expect(note).not.toContain('telegram message'); // current surface not listed
  });

  it('uses the MOST RECENT other-surface timestamp', () => {
    const history = [turn('slack', 7200), turn('slack', 120)];
    const note = buildCrossSurfaceNote(history, 'telegram', NOW);
    expect(note).toContain('last slack message 2m ago');
  });

  it('stays small (well under the token budget)', () => {
    const history = [turn('slack', 60), turn('dashboard', 120), turn('telegram', 10)];
    const note = buildCrossSurfaceNote(history, 'telegram', NOW) ?? '';
    expect(note.length).toBeLessThan(600);
  });
});
