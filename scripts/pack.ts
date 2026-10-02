import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { validatePack } from './lib/pack/validate.js';

export function runPackCli(argv: string[], out: (line: string) => void): number {
  if (argv[0] !== 'validate' || !argv[1] || argv.length > 4
    || (argv.length > 2 && (argv.length !== 4 || argv[2] !== '--denylist' || !argv[3]))) {
    out('Usage: pack validate <dir> [--denylist <file>]');
    return 2;
  }
  let denylist: string[] = [];
  if (argv[3]) {
    try {
      denylist = readFileSync(argv[3], 'utf8').split(/\r?\n/).map((x) => x.trim()).filter((x) => x && !x.startsWith('#'));
    } catch {
      out('Cannot read denylist file');
      return 2;
    }
  }
  const findings = validatePack(argv[1], { denylist });
  if (!findings.length) { out('Pack is valid'); return 0; }
  for (const f of findings) out(`${f.code} ${f.file}${f.pointer ? `:${f.pointer}` : ''} ${f.message}`);
  return 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runPackCli(process.argv.slice(2), console.log);
}
