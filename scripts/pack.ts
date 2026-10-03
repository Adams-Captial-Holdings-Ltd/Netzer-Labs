import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { validatePack } from './lib/pack/validate.js';
import { parseDenylist } from './ci/secret-scan.mjs';
import type { createExecutor } from '../src/lib/work/executor.js';

const effectUsage = 'Usage: pack effect list | pack effect resolve <caseKey> <stage> <step> <stageEntryNo> (--applied | --not-applied) --by <userId>';
type EffectExecutor = Pick<ReturnType<typeof createExecutor>, 'listUnknown' | 'resolve'>;

export function runPackCli(argv: ['effect', ...string[]], out: (line: string) => void): number | Promise<number>;
export function runPackCli(argv: string[], out: (line: string) => void): number;
export function runPackCli(argv: string[], out: (line: string) => void, deps: { executor?: EffectExecutor }): number | Promise<number>;
export function runPackCli(
  argv: string[], out: (line: string) => void, deps?: { executor?: EffectExecutor },
): number | Promise<number> {
  if (argv[0] === 'effect') {
    if (argv[1] === 'list' && argv.length === 2) {
      return (async () => {
        const executor = deps?.executor ?? (await import('../src/lib/work/executor.js')).defaultExecutor();
        const rows = await executor.listUnknown();
        if (!rows.length) out('No unknown effects');
        for (const row of rows) {
          out(`${row.key.caseKey} ${row.key.stage} ${row.key.step} ${row.key.stageEntryNo} ${new Date(row.updatedAt).toISOString()}${row.issueId ? ` ${row.issueId}` : ''}`);
        }
        return 0;
      })();
    }
    if (argv[1] === 'resolve') {
      const flags = argv.slice(6);
      const applied = flags.filter((arg) => arg === '--applied').length;
      const notApplied = flags.filter((arg) => arg === '--not-applied').length;
      const by = flags.indexOf('--by');
      const entry = argv[5];
      if (argv.length !== 9 || !argv[2] || !argv[3] || !argv[4]
        || !entry || !/^[1-9]\d*$/.test(entry) || !Number.isSafeInteger(Number(entry))
        || applied + notApplied !== 1 || by < 0 || by + 1 >= flags.length
        || !flags[by + 1] || flags[by + 1].startsWith('--')
        || flags.some((arg, i) => i !== by && i !== by + 1 && arg !== '--applied' && arg !== '--not-applied')) {
        out(effectUsage);
        return 2;
      }
      return (async () => {
        try {
          const executor = deps?.executor ?? (await import('../src/lib/work/executor.js')).defaultExecutor();
          await executor.resolve({ caseKey: argv[2], stage: argv[3], step: argv[4], stageEntryNo: Number(entry) },
            applied ? 'applied' : 'not_applied', flags[by + 1]);
          out('Effect resolved');
          return 0;
        } catch (error) {
          const name = (error as { name?: unknown } | null)?.name;
          out(typeof name === 'string' && name ? name : 'Error');
          return 1;
        }
      })();
    }
    out(effectUsage);
    return 2;
  }
  if (argv[0] !== 'validate' || !argv[1]) {
    out('Usage: pack validate <dir> [--denylist <file>]');
    return 2;
  }
  if (argv.length > 2 && (argv.length !== 4 || argv[2] !== '--denylist' || !argv[3])) {
    out('Usage: pack validate <dir> [--denylist <file>]');
    return 2;
  }
  let denylist: string[] = [];
  if (argv[3]) {
    try {
      denylist = parseDenylist(readFileSync(argv[3], 'utf8'));
      if (!denylist.length) { out('Denylist file has no entries'); return 2; }
    } catch {
      out('Cannot read denylist file');
      return 2;
    }
  }
  if (!argv[3]) out('No denylist applied');
  const findings = validatePack(argv[1], { denylist });
  if (!findings.length) { out('Pack is valid'); return 0; }
  for (const f of findings) out(`${f.code} ${f.file}${f.pointer ? `:${f.pointer}` : ''} ${f.message}`);
  return 1;
}

const entry = process.argv[1] && resolve(process.argv[1]);
const invoked = entry && (existsSync(entry) ? realpathSync(entry)
  : existsSync(`${entry}.ts`) ? realpathSync(`${entry}.ts`) : undefined);
if (invoked && invoked === realpathSync(fileURLToPath(import.meta.url))) {
  void Promise.resolve(runPackCli(process.argv.slice(2), console.log)).then((code) => { process.exitCode = code; });
}
