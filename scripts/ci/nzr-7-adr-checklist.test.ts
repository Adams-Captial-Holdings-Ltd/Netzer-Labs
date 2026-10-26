// NZR-7: runs the frozen ADR checklist (tests/e2e/nzr-7/run.mjs) so vitest (and the G2 gate) sees each check.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const CHECKLIST = join(__dirname, '../../tests/e2e/nzr-7/run.mjs');

const CHECKS = [
  'ADR-PARTS 0022 has all eight markers in order',
  'ADR-PARTS 0023 has all eight markers in order',
  'ADR-PARTS 0024 has all eight markers in order',
  'ADR-PARTS flags an ADR with ## Decision removed',
  'FORWARD-LINKS 0012 links 0022',
  'FORWARD-LINKS 0012 line 3 starts **Status:** Superseded',
  'FORWARD-LINKS 0017 links 0023',
  'FORWARD-LINKS decision-log row 21 links 0023',
  'FORWARD-LINKS do-not-build links 0024',
  'NO-HISTORY-EDIT 0012 annotated with deletions <= 1',
  'NO-HISTORY-EDIT 0017 annotated with deletions <= 1',
  'no duplicate ADR numbers',
  'ADR index has rows 0022, 0023, 0024',
  'netzar-studio README decisions: lists the three ADRs',
  'Docs CI docs-links.mjs exits 0',
  'Docs CI feature-knowledge.mjs exits 0',
  'Docs CI runnable-blocks.mjs exits 0',
];

describe('NZR-7 ADR supersede checklist', () => {
  let lines: string[] = [];
  beforeAll(() => {
    lines = spawnSync('node', [CHECKLIST], { encoding: 'utf8', timeout: 170_000 }).stdout.split('\n');
  }, 180_000);

  it.each(CHECKS)('%s', (name) => {
    expect(lines.some((l) => l === `PASS ${name}` || l.startsWith(`PASS ${name} (`))).toBe(true);
  });

  it('checklist reports every check passed', () => {
    expect(lines).toContain(`SUMMARY: ${CHECKS.length}/${CHECKS.length} passed`);
  });
});
