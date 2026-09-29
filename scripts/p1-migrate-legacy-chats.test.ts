import { describe, it, expect } from 'vitest';
import { migrationMode } from './p1-migrate-legacy-chats.js';

/**
 * The migration deletes conversations it cannot prove an owner for, so the only
 * way to make it write is to name, by hand, the exact tables it resolved. A
 * mistyped or wrong-environment table name must stop it before anything runs.
 */
const TABLES = { sessions: 'claudeclaw-staging-sessions', tokens: 'claudeclaw-staging-dashboard-tokens' };

describe('migrationMode', () => {
  it('is a dry run without --apply', () => {
    expect(migrationMode([], TABLES)).toEqual({ apply: false });
  });

  it('refuses --apply when the tables are not typed out', () => {
    expect(migrationMode(['--apply'], TABLES)).toHaveProperty('error');
  });

  it('refuses --apply when the typed tables are not the ones it would write', () => {
    // Production names typed while the process resolved staging's.
    const out = migrationMode(['--apply', '--tables=claudeclaw-sessions,claudeclaw-dashboard-tokens'], TABLES);
    expect(out).toHaveProperty('error');
  });

  it('applies when the typed tables match exactly', () => {
    expect(
      migrationMode(['--apply', '--tables=claudeclaw-staging-sessions,claudeclaw-staging-dashboard-tokens'], TABLES),
    ).toEqual({ apply: true });
  });
});
