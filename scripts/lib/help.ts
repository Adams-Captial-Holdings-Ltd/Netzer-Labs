/**
 * Uniform `--help` / `-h` for the lifecycle CLIs.
 *
 * Only `up` used to answer --help; every other command ignored the flag and
 * RAN. The worst case was `npm run deploy -- --help` creating the state
 * bucket, lock table, and ECR repo before its first gate: asking for help
 * must never mutate anything. Each CLI calls maybePrintHelp() before its
 * first side effect and exits cleanly when it printed.
 *
 * Every help block states the command's mutation/cost contract on its own
 * line, because "what will this do to my account" is the question a
 * help-asker is actually asking.
 */

import { bold, dim, gray } from './ansi.js';

export interface HelpSpec {
  /** How the human invokes it, e.g. 'npm run deploy'. */
  command: string;
  /** What it does, one line. */
  oneLiner: string;
  /** Flag and description pairs, rendered aligned. */
  flags: [string, string][];
  /** The mutation/cost contract, one plain sentence. */
  contract: string;
  /** Optional docs pointer. */
  docs?: string;
}

/** Pure renderer (exported for tests). */
export function formatHelp(spec: HelpSpec): string {
  const width = Math.max(...spec.flags.map(([f]) => f.length), 0) + 3;
  return [
    '',
    bold(`${spec.command} · ${spec.oneLiner}`),
    gray('─'.repeat(48)),
    ...spec.flags.map(([f, d]) => `  ${f.padEnd(width)}${d}`),
    '',
    `  ${spec.contract}`,
    ...(spec.docs ? [dim(`  Docs: ${spec.docs}`)] : []),
    '',
  ].join('\n');
}

/** True when argv asks for help; prints the block as the only side effect. */
export function maybePrintHelp(argv: string[], spec: HelpSpec): boolean {
  if (!argv.includes('--help') && !argv.includes('-h')) return false;
  // eslint-disable-next-line no-console
  console.log(formatHelp(spec));
  return true;
}
