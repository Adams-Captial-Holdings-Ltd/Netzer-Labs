/**
 * Orchestrator image build: npm fetch timeout in the `build` stage.
 *
 * The `build` stage's `npm install` is the longest network step in the image
 * and the one that has failed: it ran 259 s in the green bar run 33783021194,
 * and two attempts in the 2026-09-03 staging session died in this stage with
 * `read ETIMEDOUT` at ~266-274 s. npm's default fetch-timeout is 300000 ms.
 *
 * This file asserts the Dockerfile TEXT - it proves the ENV line is present,
 * in the right stage, ahead of the install it configures, and confined to that
 * stage. It cannot prove the build gets faster or stops timing out; only the
 * next staging run's `Build + Push (linux/arm64)` step can (M54).
 *
 * Values are asserted as LITERALS so a rename or a re-tuned timeout has to
 * come here and be re-justified rather than passing silently (A20).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DOCKERFILE = readFileSync(join(REPO_ROOT, 'Dockerfile'), 'utf8').replace(/\r\n/g, '\n');

/**
 * Dockerfile text -> logical instructions: comments and blank lines dropped,
 * backslash continuations joined, so a `RUN --mount=...` that continues onto
 * the next line with `npm install ...` is a single instruction. That makes an
 * ENV's position relative to it well defined.
 */
function logicalInstructions(text: string): string[] {
  const out: string[] = [];
  let pending = '';
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (pending === '' && (line === '' || line.startsWith('#'))) continue;
    if (line.endsWith('\\')) {
      pending += `${line.slice(0, -1).trim()} `;
      continue;
    }
    out.push(`${pending}${line}`.trim());
    pending = '';
  }
  if (pending !== '') out.push(pending.trim());
  return out;
}

/** Logical instructions grouped by the `FROM ... AS <name>` that opens them. */
function stages(text: string): Map<string, string[]> {
  const byStage = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const instruction of logicalInstructions(text)) {
    const from = /^FROM\s+\S+\s+AS\s+(\S+)$/i.exec(instruction);
    if (from) {
      current = [];
      byStage.set(from[1], current);
      continue;
    }
    current?.push(instruction);
  }
  return byStage;
}

const STAGES = stages(DOCKERFILE);
const BUILD_STAGE = STAGES.get('build') ?? [];

describe('orchestrator Dockerfile', () => {
  // Guard: if the parser ever stops finding stages, the "other stages are
  // clean" assertions below would pass vacuously.
  it('parses into the four named stages', () => {
    expect([...STAGES.keys()]).toEqual(['deps', 'web', 'build', 'runtime']);
    expect(BUILD_STAGE.length).toBeGreaterThan(0);
  });

  it('sets npm_config_fetch_timeout in the build stage', () => {
    expect(BUILD_STAGE).toContain('ENV npm_config_fetch_timeout=600000');
  });

  it('sets it before the build stage npm install it configures', () => {
    const env = BUILD_STAGE.findIndex((i) => i === 'ENV npm_config_fetch_timeout=600000');
    const install = BUILD_STAGE.findIndex((i) => /^RUN\b/.test(i) && i.includes('npm install'));
    expect(install).toBeGreaterThanOrEqual(0);
    expect(env).toBeGreaterThanOrEqual(0);
    expect(env).toBeLessThan(install);
  });

  it('leaves the deps, web and runtime stages untouched', () => {
    for (const name of ['deps', 'web', 'runtime']) {
      const instructions = STAGES.get(name) ?? [];
      expect(instructions.length).toBeGreaterThan(0);
      expect(instructions.join('\n')).not.toContain('npm_config_fetch_timeout');
    }
  });
});
