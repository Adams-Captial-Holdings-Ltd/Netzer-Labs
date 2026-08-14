import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { capture, resolveLocalBin } from './shell.js';

/**
 * Regression cover for the Windows `spawn npx ENOENT` that aborted the
 * `cdk deploy` phase mid-deploy. `npx` is a `.cmd` shim and Node refuses to
 * spawn batch files without a shell (CVE-2024-27980); a shell would then
 * split arguments on spaces, and this repository's checkout path contains
 * one. The resolver sidesteps both by running the shim's real JS entry with
 * the current Node binary.
 *
 * These assertions are platform-aware on purpose: the resolver is a no-op
 * off Windows, and pinning that is the point — macOS and Linux CI must keep
 * spawning exactly what they always did.
 */

const isWindows = process.platform === 'win32';
const repoRoot = join(import.meta.dirname, '..', '..');

describe('resolveLocalBin', () => {
  it('is a no-op off Windows so CI behaviour is unchanged', () => {
    if (isWindows) return;
    expect(resolveLocalBin('cdk', repoRoot)).toBeNull();
  });

  it('resolves the cdk shim to an entry Node can execute', () => {
    if (!isWindows) return;
    const entry = resolveLocalBin('cdk', repoRoot);
    expect(entry).not.toBeNull();
    expect(existsSync(entry!)).toBe(true);
    // aws-cdk ships bin/cdk with NO extension; a resolver that assumed .js
    // would return null here and silently fall back to the broken spawn.
    expect(entry!.replace(/\\/g, '/')).toContain('aws-cdk/bin/cdk');
  });

  it('returns null for a bin that does not exist', () => {
    expect(resolveLocalBin('definitely-not-a-real-bin', repoRoot)).toBeNull();
  });

  it('returns null when the directory has no node_modules', () => {
    expect(resolveLocalBin('cdk', join(repoRoot, 'does', 'not', 'exist'))).toBeNull();
  });
});

describe('capture via npx', () => {
  it('runs `npx cdk --version` without a shell, on every platform', async () => {
    const result = await capture('npx', ['cdk', '--version'], { cwd: repoRoot });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^\d+\.\d+\.\d+/);
  }, 60_000);
});
