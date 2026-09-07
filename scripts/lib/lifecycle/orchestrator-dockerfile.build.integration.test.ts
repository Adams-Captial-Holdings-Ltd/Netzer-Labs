/**
 * WI-1 / P0-0b: does the orchestrator `build` stage actually build?
 *
 * `orchestrator-dockerfile.test.ts` asserts the Dockerfile TEXT, and says so in
 * its own header (M54): nine `readFileSync` + `String.includes` checks that
 * "cannot prove any image builds". All nine are green right now against a build
 * stage that cannot work, which is exactly the hole this file closes.
 *
 * The defect the text tests cannot see: Dockerfile:61-63 installs typescript,
 * @types/pdfkit and @types/ws under `--omit=dev`, and all three already carry a
 * dev edge in package-lock.json. npm's arborist infers that dev edge for any
 * name already listed in devDependencies (`--no-save` only suppresses the
 * manifest write), and a node marked dev under `--omit=dev` is "treated as
 * undefined for the purposes of diffing" - so it is never reified. The install
 * therefore succeeds having added nothing, and Dockerfile:68 `RUN npx tsc` runs
 * with no local compiler.
 *
 * So this file does the one thing text cannot: it builds the stage and looks
 * INSIDE it. A build that merely exits 0 is not enough - a `tsc` fetched from
 * the registry at build time would also exit 0 while reintroducing the very
 * download the fix exists to remove - so the assertions are positive facts
 * about the produced filesystem, not just the exit code.
 *
 * Lane: linux/amd64. npm's tree resolution is architecture-independent, so this
 * lane settles whether the three packages install, and it runs native on an
 * amd64 host instead of ~9 min under QEMU. It does NOT settle the arm64
 * ETIMEDOUT; only CI's `Build + Push (linux/arm64)` (deploy.yml:310-324) can.
 *
 * Gated on ORCHESTRATOR_IMAGE_BUILD_TEST because it needs a Docker daemon -
 * same shape as client.paperclip.integration.test.ts:71 gating on
 * PAPERCLIP_TEST_AUTH_SECRET. `.integration.test.ts` is excluded by
 * vitest.config.ts:11 and included by vitest.integration.config.ts:26-29, so it
 * never slows `npm test`. Run it alone - the rest of that lane needs LocalStack:
 *
 *   ORCHESTRATOR_IMAGE_BUILD_TEST=1 npx vitest run \
 *     --config vitest.integration.config.ts \
 *     scripts/lib/lifecycle/orchestrator-dockerfile.build.integration.test.ts
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const LOCKFILE = JSON.parse(readFileSync(join(REPO_ROOT, 'package-lock.json'), 'utf8')) as {
  packages: Record<string, { version?: string } | undefined>;
};

/** The version package-lock.json pins for `name`, so a lockfile bump fails here. */
function lockedVersion(name: string): string {
  const version = LOCKFILE.packages[`node_modules/${name}`]?.version;
  if (typeof version !== 'string' || version === '') {
    throw new Error(`package-lock.json pins no version for ${name}`);
  }
  return version;
}

/** Local-only tag; removed in afterAll. The BuildKit layer cache is left alone. */
const IMAGE_TAG = 'netzar-orchestrator-build-stage:p0-0b-gate';

/** Vitest's config-level testTimeout is 30 s, which a real image build blows past. */
const BUILD_TIMEOUT_MS = 30 * 60_000;
/** Kill the child before vitest gives up on it, so the failure is the build's. */
const CHILD_TIMEOUT_MS = 25 * 60_000;
/** `--progress=plain` over four stages far exceeds execFileSync's 1 MB default. */
const MAX_BUFFER = 64 * 1024 * 1024;

interface Ran {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/**
 * execFileSync, but non-zero exit is a value rather than a throw: the build's
 * own stderr is the evidence this file exists to report, and losing it inside a
 * thrown stack is how a broken image gets diagnosed as a broken harness.
 */
function run(file: string, args: string[], cwd = REPO_ROOT): Ran {
  try {
    const stdout = execFileSync(file, args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CHILD_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    return { ok: true, stdout, stderr: '' };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; message?: string };
    return {
      ok: false,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? e.message ?? String(error),
    };
  }
}

/** The last `lines` of the build log - enough to name the failing instruction. */
function tail(text: string, lines = 30): string {
  return text.split('\n').slice(-lines).join('\n');
}

describe.skipIf(!process.env.ORCHESTRATOR_IMAGE_BUILD_TEST)(
  'orchestrator image build stage (linux/amd64)',
  () => {
    let build: Ran;

    beforeAll(() => {
      // A dead daemon must announce itself. If it were left to surface as a
      // build failure it would read as the defect under test, which is the one
      // misreading this file cannot afford.
      const daemon = run('docker', ['version', '--format', '{{.Server.Version}}']);
      if (!daemon.ok) {
        throw new Error(
          `ORCHESTRATOR_IMAGE_BUILD_TEST is set but no Docker daemon answered:\n${tail(daemon.stderr, 5)}`,
        );
      }

      // Mirrors deploy.yml:316-324 except for --platform (amd64 lane, see the
      // header), --target/--load (this gate stops at the compile rather than
      // pushing a runtime image) and the inert --build-arg DEPLOY_TIER, which
      // the Dockerfile declares no ARG for.
      build = run('docker', [
        'buildx',
        'build',
        '--platform',
        'linux/amd64',
        '--target',
        'build',
        '--load',
        '--provenance=false',
        '--progress=plain',
        '-t',
        IMAGE_TAG,
        '-f',
        'Dockerfile',
        '.',
      ]);
    }, BUILD_TIMEOUT_MS);

    afterAll(() => {
      run('docker', ['image', 'rm', '-f', IMAGE_TAG]);
    });

    /** The two assertions below need an image; without one they report noise. */
    function requireImage(): void {
      if (!build.ok) {
        throw new Error('the build stage did not build; see the first assertion for its stderr');
      }
    }

    it('completes: `docker buildx build --target build` exits 0', () => {
      expect(build.ok, `docker buildx build failed:\n${tail(build.stderr)}`).toBe(true);
    });

    it('resolves the lockfile TypeScript inside the stage, not one fetched at build time', () => {
      requireImage();
      // Resolved from /app, so this passes only if the compiler is actually in
      // the stage's node_modules. `npx tsc` reaching the registry for the
      // unrelated package named `tsc` would leave this unresolvable.
      const ran = run('docker', [
        'run',
        '--rm',
        '--entrypoint',
        'node',
        IMAGE_TAG,
        '-p',
        'require("typescript/package.json").version',
      ]);
      expect(ran.ok, `could not resolve typescript in the image:\n${tail(ran.stderr, 10)}`).toBe(
        true,
      );
      expect(ran.stdout.trim()).toBe(lockedVersion('typescript'));
    });

    it('emits the compiled entrypoint the runtime stage copies out', () => {
      requireImage();
      // Dockerfile:94 does `COPY --from=build /app/dist ./dist` and the image's
      // CMD is `node dist/index.js`, so an empty or missing dist is a runtime
      // image that cannot start.
      const ran = run('docker', [
        'run',
        '--rm',
        '--entrypoint',
        'sh',
        IMAGE_TAG,
        '-c',
        'test -f dist/index.js && echo PRESENT',
      ]);
      expect(ran.ok, `dist/index.js is absent from the build stage:\n${tail(ran.stderr, 10)}`).toBe(
        true,
      );
      expect(ran.stdout.trim()).toBe('PRESENT');
    });
  },
);
