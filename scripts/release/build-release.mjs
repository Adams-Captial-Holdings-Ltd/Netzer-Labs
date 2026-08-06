#!/usr/bin/env node
/**
 * Release assembly launcher (IaC readiness plan, items 41 + 44).
 *
 * Release CI calls this at tag time:
 *
 *   node scripts/release/build-release.mjs --tag v1.0.0 \
 *     --key  <ed25519-private.pem>  \
 *     --pub  <ed25519-public.pem>   \
 *     --images <images.json>        \
 *     [--provenance <builder-id>] [--out dist-release]
 *
 * Emits dist-release/<tag>/{metadata.json, artifact-manifest.json,
 * signature.json, promotion-attestation.skeleton.json} and SELF-VALIDATES
 * them through the updater shim's verify path before declaring success.
 *
 * This file is deliberately a thin plain-node launcher: the logic lives in
 * build-release.ts so it shares the metadata/signing modules with the shim
 * (one verification implementation, never two). tsx comes from this repo's
 * own devDependencies, which release CI has installed anyway.
 */

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

const result = spawnSync(
  'npx',
  ['tsx', join(here, 'build-release-entry.ts'), ...process.argv.slice(2)],
  { stdio: 'inherit', cwd: repoRoot },
);
process.exit(result.status ?? 1);
