/**
 * tsx entry for build-release.mjs. Separate from build-release.ts so test
 * imports of assembleRelease never risk firing a CLI, and the launcher has
 * an unambiguous always-runs entry.
 */

import { buildReleaseMain } from './build-release.js';

process.exitCode = await buildReleaseMain(process.argv.slice(2));
