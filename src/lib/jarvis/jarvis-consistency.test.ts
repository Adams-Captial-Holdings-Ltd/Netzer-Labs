/**
 * Doc/code consistency check (JARVIS-PLAN.md §1b H12 / 05-delivery).
 *
 * Scans the Jarvis IMPLEMENTATION for banned *usage* (not prose) so the
 * hardened design stays the only implementation path. Each matcher requires
 * real code context (quotes, `querySelector`, `.catch(`, `.close(`, `type:`),
 * so a comment that merely NAMES a banned variant is exempt. This test file
 * and other *.test.ts files are excluded (they carry the patterns as data).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..'); // src/lib/jarvis → repo root

const SCAN_DIRS = [
  join(REPO, 'src', 'lib', 'jarvis'),
  join(REPO, 'src', 'lib', 'voice'),
  join(REPO, 'web', 'src', 'lib', 'jarvis'),
];
const SCAN_FILES = [
  join(REPO, 'src', 'adapters', 'dashboard', 'jarvis.ts'),
  join(REPO, 'web', 'src', 'components', 'JarvisWidget.tsx'),
  join(REPO, 'web', 'src', 'components', 'JarvisHud.tsx'),
  join(REPO, 'web', 'src', 'routes', 'Jarvis.tsx'),
];

interface Banned {
  name: string;
  re: RegExp;
}

const BANNED: Banned[] = [
  { name: "quoted 'audio_input'/'audio_output' literal (use audio_in/audio_out)", re: /['"]audio_(input|output)['"]/ },
  { name: "audio frame keyed `data` (use b64)", re: /['"]audio_(in|out)['"][^}]*\bdata\s*:/ },
  { name: "read_view scraping #main-content (use the allow-list)", re: /(querySelector|getElementById)\s*\(\s*['"]#?main-content/ },
  { name: "fail-OPEN gate `.catch(() => ({ active: false }))`", re: /\.catch\(\s*\(\s*\)\s*=>\s*\(\s*\{\s*active:\s*false\s*\}\s*\)\s*\)/ },
  { name: "client `type:'session_end'` / takeover message", re: /type:\s*['"]session_end['"]/ },
  { name: 'the phrase "session replaced"', re: /session replaced/i },
  { name: 'non-canonical close code 4401', re: /\.close\(\s*4401|code:\s*4401/ },
  { name: 'non-canonical close code 4409', re: /\.close\(\s*4409|code:\s*4409/ },
];

function collectFiles(): string[] {
  const out: string[] = [...SCAN_FILES.filter((f) => existsSync(f))];
  for (const dir of SCAN_DIRS) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) continue;
      if (!/\.(ts|tsx|js)$/.test(entry)) continue;
      if (/\.test\.(ts|tsx)$/.test(entry)) continue; // tests carry the patterns as data
      out.push(full);
    }
  }
  return out;
}

describe('jarvis doc/code consistency check (H12)', () => {
  const files = collectFiles();

  it('scans the expected implementation surface', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(files.some((f) => f.endsWith('jarvis.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('ws-schema.ts'))).toBe(true);
  });

  it('contains NO banned usage in any Jarvis implementation file', () => {
    const violations: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const b of BANNED) {
        if (b.re.test(src)) violations.push(`${file}: ${b.name}`);
      }
    }
    expect(violations).toEqual([]);
  });

  // Positive control: a silently-broken regex (e.g. over-escaped) could pass the
  // scan above while catching nothing. Assert each pattern matches a known-bad
  // fixture so the matchers themselves stay live.
  it('each banned pattern actually matches a known-bad fixture', () => {
    const SAMPLES = [
      "const t = 'audio_input';",
      "{ type: 'audio_in', data: bytes }",
      "document.querySelector('#main-content')",
      'isKillSwitchActive(x).catch(() => ({ active: false }))',
      "send({ type: 'session_end' })",
      '// the session replaced the incumbent',
      'ws.close(4401)',
      'ws.close(4409)',
    ];
    expect(SAMPLES).toHaveLength(BANNED.length);
    BANNED.forEach((b, i) => {
      expect(b.re.test(SAMPLES[i]), `${b.name} should match its fixture`).toBe(true);
    });
  });
});
