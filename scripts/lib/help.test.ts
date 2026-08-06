/**
 * Tests for the shared lifecycle --help helper (scripts/lib/help.ts).
 *
 * The behavioral contract under test: asking for help NEVER runs the
 * command. maybePrintHelp must return true (so callers exit) for --help
 * and -h anywhere in argv, and false otherwise; formatHelp must carry the
 * mutation/cost contract line, because "what will this do to my account"
 * is the question a help-asker is asking.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { formatHelp, maybePrintHelp, type HelpSpec } from './help.js';

const spec: HelpSpec = {
  command: 'npm run example',
  oneLiner: 'does the example thing',
  flags: [
    ['--env=<name>', 'target .env.<name>'],
    ['--json', 'machine-readable output'],
  ],
  contract: 'Read-only; creates nothing.',
  docs: 'AGENTS.md',
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('maybePrintHelp', () => {
  it('returns true and prints for --help and -h, anywhere in argv', () => {
    for (const argv of [['--help'], ['-h'], ['--env=staging', '--help'], ['--json', '-h']]) {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      expect(maybePrintHelp(argv, spec)).toBe(true);
      expect(log).toHaveBeenCalledTimes(1);
      vi.restoreAllMocks();
    }
  });

  it('returns false and prints nothing otherwise', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const argv of [[], ['--env=staging'], ['--json'], ['--helpme']]) {
      expect(maybePrintHelp(argv, spec)).toBe(false);
    }
    expect(log).not.toHaveBeenCalled();
  });
});

describe('formatHelp', () => {
  it('carries the command, every flag, the contract, and the docs pointer', () => {
    const out = formatHelp(spec);
    expect(out).toContain('npm run example');
    expect(out).toContain('does the example thing');
    expect(out).toContain('--env=<name>');
    expect(out).toContain('--json');
    expect(out).toContain('Read-only; creates nothing.');
    expect(out).toContain('AGENTS.md');
  });

  it('omits the docs line when no pointer is given', () => {
    const { docs: _docs, ...rest } = spec;
    expect(formatHelp(rest)).not.toContain('Docs:');
  });
});
