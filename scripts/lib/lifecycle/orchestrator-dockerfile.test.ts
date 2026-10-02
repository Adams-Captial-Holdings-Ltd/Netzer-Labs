/**
 * Orchestrator image build: what the `build` stage is allowed to install.
 *
 * The build stage's `npm install` is the longest network step in the image and
 * the one that has failed: run 34045747255 attempt 1 died in it with
 * `npm error code ETIMEDOUT` at 268.6 s (the install's own range across runs is
 * 182-274 s, and the ledger records two more deaths). `ENV
 * npm_config_fetch_timeout=600000` was already in the stage for that run and
 * did NOT prevent it: the kernel socket timeout fires first, and npm already
 * retries ETIMEDOUT (make-fetch-happen RETRY_ERRORS, fetch-retries 2). So the
 * durable fix is to stop installing the dev tree the compile never reads.
 *
 * tsconfig.build.json compiles src only (it excludes infra, scripts, web and
 * tests), and nothing under src imports aws-cdk-lib (117 MB, 7,847 files),
 * constructs, vitest, tsx or pino-pretty. Beyond the runtime tree the `deps`
 * stage already installs, the compile needs only typescript, @types/pdfkit and
 * @types/ws - @types/node is not a dev dependency and is already present. So
 * the build stage starts `FROM deps` and adds exactly those three.
 *
 * This file asserts the Dockerfile TEXT: it proves which instructions the
 * build stage contains and which it no longer contains. It cannot prove any
 * image builds or that the timeout is gone; only a real
 * `docker buildx build --target build` and the next staging run's
 * `Build + Push (linux/arm64)` step can (M54).
 *
 * The three versions are read from package-lock.json at assert time, so a
 * lockfile bump fails this test - which points at the Dockerfile - instead of
 * the image silently installing a version the lockfile no longer describes.
 * Everything else is asserted as a LITERAL so a rename or a re-tuned flag has
 * to come here and be re-justified rather than passing silently (A20).
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DOCKERFILE = readFileSync(join(REPO_ROOT, 'Dockerfile'), 'utf8').replace(/\r\n/g, '\n');

const LOCKFILE = JSON.parse(readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8')) as {
  packages: Record<string, { version?: string; dev?: boolean } | undefined>;
};

/** `<name>@<version>`, using the version package-lock.json pins for `name`. */
function lockedSpec(name: string): string {
  const version = LOCKFILE.packages[`node_modules/${name}`]?.version;
  if (typeof version !== 'string' || version === '') {
    throw new Error(`package-lock.json pins no version for ${name}`);
  }
  return `${name}@${version}`;
}

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

/**
 * The `name@version` specs an npm install instruction names. Tokens are package
 * specs only: flags carry `=` not `@version`, and a path like
 * `/opt/compiler/node_modules/@types/pdfkit` has no trailing `@<digit>`.
 */
function installedSpecs(instruction: string): string[] {
  return instruction
    .split(/\s+/)
    .filter((token) => /^(?:@[^@/\s]+\/)?[^@/\s][^@\s]*@\d[^\s]*$/.test(token));
}

const STAGES = stages(DOCKERFILE);
const BUILD_STAGE = STAGES.get('build') ?? [];
const BUILD_INSTALLS = BUILD_STAGE.filter((i) => /^RUN\b/.test(i) && i.includes('npm install'));

describe('orchestrator Dockerfile', () => {
  // Guard: if the parser ever stops finding stages, the "other stages are
  // clean" assertions below would pass vacuously.
  it('parses into the four named stages', () => {
    expect([...STAGES.keys()]).toEqual(['deps', 'web', 'build', 'runtime']);
    expect(BUILD_STAGE.length).toBeGreaterThan(0);
  });

  it('starts the build stage from the deps stage, not a second base image', () => {
    expect(DOCKERFILE).toContain('FROM deps AS build');
  });

  it('does not re-copy the manifests into the build stage', () => {
    // /app/package.json and /app/package-lock.json are inherited from `deps`
    // (Dockerfile:12), so a COPY here would only re-bust this stage's cache.
    expect(BUILD_STAGE.filter((i) => i.startsWith('COPY package.json'))).toEqual([]);
  });

  it('runs exactly one npm install in the build stage', () => {
    expect(BUILD_INSTALLS).toHaveLength(1);
  });

  it('installs EXACTLY the three compile-time packages, at the locked versions', () => {
    // Set equality, not `toContain`. The previous version of this test was named
    // "only" but asserted containment, so a fourth package would have passed all
    // nine tests unnoticed.
    const install = BUILD_INSTALLS[0] ?? '';
    expect(installedSpecs(install).sort()).toEqual(
      [lockedSpec('typescript'), lockedSpec('@types/pdfkit'), lockedSpec('@types/ws')].sort(),
    );
    for (const flag of [
      '--mount=type=cache,target=/root/.npm',
      '--no-save',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
    ]) {
      expect(install).toContain(flag);
    }
  });

  it('installs them in an isolated directory, which is what makes them install at all', () => {
    // RE-SPECIFIED, deliberately. This test used to assert `--omit=dev` on every
    // build-stage install, on the theory that the flag is "what keeps the dev
    // tree out". That theory was wrong, and the flag was the defect: all three
    // packages are devDependencies, npm infers a dev edge for any name already
    // in devDependencies, and a node marked dev under `--omit=dev` is treated as
    // undefined for diffing. Measured in the image: the install reported
    // `up to date in 3s` having added NONE of the three, and the compile then
    // died. With the install isolated in /opt/compiler there is no manifest to
    // infer a dev edge from, and the same command reports `added 5 packages`.
    //
    // The dev tree is kept out by naming only three packages, not by a flag.
    const install = BUILD_INSTALLS[0] ?? '';
    expect(install).toContain('/opt/compiler');
    expect(install).not.toContain('--omit=dev');
  });

  it('compiles through node, never through npx, so the stage cannot fetch a compiler', () => {
    // `npx` resolves a missing binary by fetching one from the registry. With no
    // local compiler it installed the unrelated package `tsc@2.0.4`, whose bin
    // prints "This is not the tsc command you are looking for" and exits 1.
    const compile = BUILD_STAGE.filter(
      (i) => /^RUN\b/.test(i) && i.includes('tsconfig.build.json'),
    );
    expect(compile).toHaveLength(1);
    expect(compile[0]).toContain('node node_modules/typescript/bin/tsc');
    expect(compile[0]).not.toContain('npx');
  });

  it('keeps @types/node out of devDependencies, since the build stage never installs it', () => {
    // @types/node is NOT named in the build-stage install, so the compile can
    // only see it because the runtime tree already carries it — and it does so
    // only transitively (aws-xray-sdk-core -> @types/cls-hooked). Nothing else
    // guards that. If it ever becomes dev-only the compile loses node's types
    // with no other test failing.
    expect(LOCKFILE.packages['node_modules/@types/node']?.dev).not.toBe(true);
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
