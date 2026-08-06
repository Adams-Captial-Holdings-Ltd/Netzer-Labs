/**
 * Shared preflight renderer. scripts/doctor.ts and scripts/deploy.ts print
 * the same check results the same way; this module is the single source of
 * that formatting (extracted from doctor's inline renderer).
 */

import { bold, dim, fail, gray, ok, warn } from '../ansi.js';
import type { CheckResult, PreflightSummary } from './checks.js';

export function statusLine(result: CheckResult): string {
  const label = `${result.id} ${dim('·')} ${result.title}`;
  switch (result.status) {
    case 'pass':
      return ok(label);
    case 'warn':
      return warn(label);
    case 'fail':
      return fail(label);
    case 'skip':
      return `${gray('—')}  ${gray(label)}`;
  }
}

function printIndented(log: (msg: string) => void, text: string, prefix = '     '): void {
  for (const line of text.split('\n')) {
    log(dim(`${prefix}${line}`));
  }
}

/** Per-check line + indented detail + indented remediation, doctor-style. */
export function renderCheckResults(
  results: CheckResult[],
  log: (msg: string) => void,
): void {
  for (const result of results) {
    log(statusLine(result));
    if (result.detail) printIndented(log, result.detail);
    if (result.remediation) printIndented(log, result.remediation, '     ↳ ');
  }
}

/** The Summary header + counts block doctor prints after the checks. */
export function renderSummary(summary: PreflightSummary, log: (msg: string) => void): void {
  log('\n' + bold('Summary'));
  log(gray('─'.repeat(40)));
  log(
    `  ${summary.pass} pass · ${summary.warn} warn · ${summary.fail} fail · ${summary.skip} skip`,
  );
}
