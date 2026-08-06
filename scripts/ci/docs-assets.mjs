#!/usr/bin/env node
/**
 * Docs asset size budget (IaC readiness items 32 / 37 / 38a).
 * Dependency-free; hermetic.
 *
 *   node scripts/ci/docs-assets.mjs [rootDir]
 *
 * Budgets (also stated in docs/assets/README.md, the asset contract):
 *   - no single file under docs/ may exceed 2 MB (GitHub renders heavy pages
 *     slowly or truncates them; reviewers can't diff binaries anyway);
 *   - docs/assets/ in total may not exceed 15 MB (clone weight — every
 *     screenshot lives in history forever).
 *
 * No videos in-repo (link out instead); GIFs need a static PNG fallback per
 * the asset contract.
 */

import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_ASSETS_TOTAL_BYTES = 15 * 1024 * 1024;
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm', '.avi', '.mkv'];

/**
 * Legacy exemptions — files that predate the budget. The list may only
 * SHRINK; every entry is a launch-checklist item to slim or relocate
 * (docs/launch-checklist.md). Anything new over 2 MB fails, full stop.
 */
export const LEGACY_EXEMPT = new Set([
  // 2.3 MB Excalidraw editor source with embedded images; slated for slimming
  // (export the embedded rasters, keep the vector source) before launch.
  'docs/diagrams/system-flow.excalidraw',
]);

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue;
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else out.push({ path: p, size: st.size });
  }
  return out;
}

export function checkAssets(rootDir) {
  const docsDir = join(rootDir, 'docs');
  const failures = [];
  if (!existsSync(docsDir)) return { failures, totalAssets: 0 };

  const files = walk(docsDir);
  for (const f of files) {
    const rel = relative(rootDir, f.path);
    if (f.size > MAX_FILE_BYTES && !LEGACY_EXEMPT.has(rel)) {
      failures.push(`${rel} is ${(f.size / 1024 / 1024).toFixed(1)} MB (budget: ${MAX_FILE_BYTES / 1024 / 1024} MB per file)`);
    }
    if (VIDEO_EXTENSIONS.some((ext) => f.path.toLowerCase().endsWith(ext))) {
      failures.push(`${rel} is a video — no videos in-repo, link out instead (asset contract)`);
    }
  }

  const assetsDir = join(docsDir, 'assets');
  let totalAssets = 0;
  if (existsSync(assetsDir)) {
    totalAssets = walk(assetsDir).reduce((sum, f) => sum + f.size, 0);
    if (totalAssets > MAX_ASSETS_TOTAL_BYTES) {
      failures.push(
        `docs/assets totals ${(totalAssets / 1024 / 1024).toFixed(1)} MB (budget: ${MAX_ASSETS_TOTAL_BYTES / 1024 / 1024} MB)`,
      );
    }
  }
  return { failures, totalAssets };
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const rootDir = resolve(process.argv[2] ?? process.cwd());
  const { failures, totalAssets } = checkAssets(rootDir);
  console.log(`docs-assets: docs/assets total ${(totalAssets / 1024 / 1024).toFixed(2)} MB`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`  FAIL ${f}`);
    process.exit(1);
  }
  console.log('docs-assets: OK');
}
