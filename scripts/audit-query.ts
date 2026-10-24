/**
 * Audit query CLI. Runs saved Athena queries by name.
 *
 * Usage:
 *   tsx scripts/audit-query.ts list
 *   tsx scripts/audit-query.ts run <query-name> [--limit=100]
 */

import { bold, dim, green, red, section } from './lib/ansi.js';

const SAVED_QUERIES: Record<string, string> = {
  'daily-cost': 'SELECT day, SUM(costUsd) as total FROM audit_log GROUP BY day ORDER BY day DESC LIMIT 30',
  'top-agents': 'SELECT agentId, COUNT(*) as turns, SUM(costUsd) as cost FROM audit_log WHERE action=\'agent_turn\' GROUP BY agentId ORDER BY cost DESC LIMIT 20',
  'kill-switch-events': 'SELECT ts, action, detail FROM audit_log WHERE action LIKE \'kill_switch%\' ORDER BY ts DESC LIMIT 50',
  'exfil-blocked': 'SELECT ts, agentId, detail FROM audit_log WHERE action=\'exfil_blocked\' ORDER BY ts DESC LIMIT 50',
  'panic-events': 'SELECT ts, action, detail, userId FROM audit_log WHERE action LIKE \'panic%\' ORDER BY ts DESC LIMIT 20',
  // NZR-43: writes to secret categories, whose old values the pre-fix audit row carried in plain text.
  // Reads of /api/config were never audited before NZR-43, so no query can say who read them.
  'config-exposure': 'SELECT ts, userId, operatorLabel, detail FROM audit_log WHERE action=\'config_updated\' AND (detail LIKE \'%"category":"oauth"%\' OR detail LIKE \'%"category":"mcp"%\' OR detail LIKE \'%"category":"oauth_state"%\') ORDER BY ts',
};

const [, , command, ...rest] = process.argv;

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq > 0) flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      else flags[arg.slice(2)] = 'true';
    } else {
      flags._positional = arg;
    }
  }
  return flags;
}

async function listQueries(): Promise<void> {
  section('Saved Audit Queries');
  for (const [name, sql] of Object.entries(SAVED_QUERIES)) {
    console.log(`  ${bold(name)}`);
    console.log(`    ${dim(sql.slice(0, 100))}`);
  }
}

async function runQuery(name: string, limit: number): Promise<void> {
  const sql = SAVED_QUERIES[name];
  if (!sql) {
    console.error(red(`Unknown query: ${name}`));
    console.log(`Available: ${Object.keys(SAVED_QUERIES).join(', ')}`);
    process.exit(1);
  }
  section(`Running: ${name}`);
  console.log(dim(sql));
  console.log(dim(`(limit: ${limit})`));
  console.log(green('Query submitted. Results would appear here when connected to Athena.'));
}

async function main(): Promise<void> {
  const flags = parseFlags(rest);
  switch (command) {
    case 'list':
      await listQueries();
      break;
    case 'run':
      if (!flags._positional) { console.error(red('Usage: audit-query.ts run <name>')); process.exit(1); }
      await runQuery(flags._positional, Number(flags.limit ?? '100'));
      break;
    default:
      console.log(bold('Audit Query CLI'));
      console.log('  list                  List saved queries');
      console.log('  run <name> [--limit]  Run a saved query');
      break;
  }
}

main().catch((err) => {
  console.error(red(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
