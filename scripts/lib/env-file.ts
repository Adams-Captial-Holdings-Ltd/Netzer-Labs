/**
 * Tiny .env file helpers shared by the lifecycle CLIs (doctor, and any
 * future script that needs the same parse rules as scripts/deploy.ts).
 *
 * The parser is a copy of the one in deploy.ts on purpose: same accepted
 * syntax (KEY=VALUE, # comments, blank lines), no interpolation, no
 * quoting rules. Keep them in sync if either ever changes.
 */

export function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

/**
 * --env=staging|prod|<name> picks which env file to load, mirroring
 * deploy.ts: prod (default) -> .env, anything else -> .env.<value>.
 */
export function resolveEnvFlag(argv: string[]): string {
  return argv.find((a) => a.startsWith('--env='))?.split('=')[1] ?? 'prod';
}

export function envFileNameFor(flag: string): string {
  return flag === 'prod' ? '.env' : `.env.${flag}`;
}
