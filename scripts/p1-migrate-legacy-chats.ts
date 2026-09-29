/**
 * P1 WI-1.4 — move dashboard conversations written before WI-1.1 onto the owner
 * model. What that means is src/lib/state/legacy-chat-migration.ts.
 *
 *   npx tsx scripts/p1-migrate-legacy-chats.ts
 *       a DRY RUN: counts only, nothing written.
 *   npx tsx scripts/p1-migrate-legacy-chats.ts --apply --tables=<sessions>,<dashboard-tokens>
 *       re-owns and DELETES. The two table names must be typed out and must be
 *       the ones this process resolved (TABLE_SESSIONS / TABLE_DASHBOARD_TOKENS),
 *       so a wrong environment cannot be written to by accident.
 *
 * Real data only at S1 (owner decision 18). Link the master token FIRST
 * (POST /api/tokens/<hashPrefix>/link, owner decision 46): until it is linked,
 * its conversations are unprovable and --apply deletes them.
 */

import { pathToFileURL } from 'node:url';

export function migrationMode(
  argv: readonly string[],
  tables: { sessions: string; tokens: string },
): { apply: boolean } | { error: string } {
  if (!argv.includes('--apply')) return { apply: false };
  const expected = `${tables.sessions},${tables.tokens}`;
  const typed = argv.find((a) => a.startsWith('--tables='))?.slice('--tables='.length);
  if (typed !== expected) {
    return { error: `--apply re-owns and deletes. Confirm the tables with --tables=${expected}` };
  }
  return { apply: true };
}

async function main(): Promise<void> {
  const tables = {
    sessions: process.env.TABLE_SESSIONS ?? 'claudeclaw-sessions',
    tokens: process.env.TABLE_DASHBOARD_TOKENS ?? 'claudeclaw-dashboard-tokens',
  };
  const mode = migrationMode(process.argv.slice(2), tables);
  if ('error' in mode) {
    console.error(mode.error);
    process.exit(2);
  }
  console.log(
    `${mode.apply ? 'APPLYING' : 'DRY RUN'} on ${tables.sessions} + ${tables.tokens}` +
      ` via ${process.env.AWS_ENDPOINT_URL ?? 'real AWS'}`,
  );
  // Imported only now: the repositories resolve their table names at import.
  const { migrateLegacyConversations } = await import('../src/lib/state/legacy-chat-migration.js');
  const report = await migrateLegacyConversations(mode);
  console.log(JSON.stringify(report, null, 2));
  if (report.failures.length > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
