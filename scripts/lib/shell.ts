/**
 * Thin wrappers around child_process for the deploy CLI.
 *
 * `run` streams stdout/stderr to the terminal and returns the exit code.
 * `capture` collects stdout into a string. `pipe` chains commands without
 * a shell.
 */

import { spawn, type SpawnOptions } from 'node:child_process';

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(
  command: string,
  args: string[] = [],
  opts: SpawnOptions = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: 'inherit', ...opts });
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
    const proc = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
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
