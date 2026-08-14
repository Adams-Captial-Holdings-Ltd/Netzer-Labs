/**
 * Thin wrappers around child_process for the deploy CLI.
 *
 * `run` streams stdout/stderr to the terminal and returns the exit code.
 * `capture` collects stdout into a string. `pipe` chains commands without
 * a shell.
 *
 * WINDOWS: `npx` (and every `node_modules/.bin` entry) is a `.cmd` shim, and
 * since CVE-2024-27980 Node refuses to spawn batch files without a shell —
 * `spawn('npx', ...)` fails with ENOENT/EINVAL, which took the whole `cdk
 * deploy` phase down. `shell: true` is NOT the fix: with a shell Node joins
 * argv with spaces and performs no quoting, so any argument holding a space
 * silently splits, and this repository's own checkout path contains one
 * ("Netzar OS"). Instead we read the shim, recover the JS entry it would have
 * executed, and run THAT with the current Node binary — no shell, no quoting,
 * no argument mangling.
 *
 * Non-Windows behaviour is byte-identical to before: every helper below
 * returns early, so macOS and Linux CI spawn exactly what they always did.
 */

import { spawn, type SpawnOptions } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const isWindows = process.platform === 'win32';

/**
 * Resolve `node_modules/.bin/<name>.cmd` to the script it actually executes.
 *
 * npm writes the shim's final line as:
 *
 *   "%_prog%"  "%dp0%\..\<pkg>\<entry>" %*
 *
 * `<entry>` is frequently EXTENSIONLESS — `aws-cdk` ships `bin/cdk`, not
 * `bin/cdk.js` — so this deliberately does not assume a `.js` suffix. Node
 * executes an extensionless CommonJS file fine (verified: `node
 * node_modules/aws-cdk/bin/cdk --version`).
 *
 * Returns null on any doubt (not Windows, no shim, unrecognised shape,
 * missing target) so the caller falls back to the original command.
 */
export function resolveLocalBin(name: string, cwd: string): string | null {
  if (!isWindows) return null;
  let text: string;
  try {
    text = readFileSync(join(cwd, 'node_modules', '.bin', `${name}.cmd`), 'utf-8');
  } catch {
    return null;
  }
  const match = /%dp0%[\\/]*\.\.[\\/]([^"]+)"/.exec(text);
  const rel = match?.[1];
  if (!rel) return null;
  const target = join(cwd, 'node_modules', rel);
  return existsSync(target) ? target : null;
}

/**
 * Rewrite a command that Windows cannot spawn into `node <entry> …`.
 * Handles both `npx <bin> …` and a bare local bin name.
 */
function spawnable(
  command: string,
  args: string[],
  opts: SpawnOptions,
): [string, string[]] {
  if (!isWindows) return [command, args];
  const roots = [typeof opts.cwd === 'string' ? opts.cwd : '', process.cwd()].filter(Boolean);
  for (const root of roots) {
    if ((command === 'npx' || command === 'npx.cmd') && args.length > 0) {
      const entry = resolveLocalBin(args[0]!, root);
      if (entry) return [process.execPath, [entry, ...args.slice(1)]];
    }
    const direct = resolveLocalBin(command, root);
    if (direct) return [process.execPath, [direct, ...args]];
  }
  return [command, args];
}

export function run(
  command: string,
  args: string[] = [],
  opts: SpawnOptions = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const [cmd, argv] = spawnable(command, args, opts);
    const proc = spawn(cmd, argv, { stdio: 'inherit', ...opts });
    proc.on('error', reject);
    proc.on('close', (code) => resolve(code ?? 0));
  });
}

export function capture(
  command: string,
  args: string[] = [],
  opts: SpawnOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const [cmd, argv] = spawnable(command, args, opts);
    const proc = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    proc.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

/**
 * Pipe stdout of one command into stdin of another, both inheriting
 * the parent's stderr. Used for `aws ecr get-login-password | docker login`.
 */
export function pipe(
  producer: { cmd: string; args: string[] },
  consumer: { cmd: string; args: string[] },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const p = spawn(producer.cmd, producer.args, { stdio: ['ignore', 'pipe', 'inherit'] });
    const c = spawn(consumer.cmd, consumer.args, { stdio: ['pipe', 'inherit', 'inherit'] });
    p.stdout.pipe(c.stdin);
    p.on('error', reject);
    c.on('error', reject);
    p.on('close', (pc) => {
      if (pc !== 0) {
        c.kill();
        resolve(pc ?? 1);
      }
    });
    c.on('close', (cc) => resolve(cc ?? 0));
  });
}
