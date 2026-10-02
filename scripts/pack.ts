import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { validatePack } from './lib/pack/validate.js';
import { parseDenylist } from './ci/secret-scan.mjs';

export function runPackCli(argv: string[], out: (line: string) => void): number {
  if (argv[0] !== 'validate' || !argv[1] || argv.length > 4
    || (argv.length > 2 && (argv.length !== 4 || argv[2] !== '--denylist' || !argv[3]))) {
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
  process.exitCode = runPackCli(process.argv.slice(2), console.log);
}
