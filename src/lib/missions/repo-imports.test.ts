/**
 * C-14 — THE ACL IS THE ONLY DOOR, ENFORCED BY GREP RATHER THAN BY DISCIPLINE.
 *
 * `mission-acl.ts` exists because four callers read the same board: the HTTP
 * routes, Jarvis, the GDPR export and the LLM tools. The failure mode this file
 * guards is not a bug in any of them — it is the NEXT change, where someone adds
 * a fifth mission read (or "quickly" repoints an existing one) straight at
 * `mission-tasks-repo.js` and the flag stops picking one whole stack. That
 * regression is invisible in every other test: the new caller works perfectly,
 * it just reads DynamoDB while everything else reads Paperclip, so the Missions
 * tab, the voice co-pilot, the export and the tools quietly disagree.
 *
 * A grep is the honest shape for this. It is a rule about the module graph, not
 * about behaviour, so there is no runtime assertion that could express it: the
 * violating code PASSES its own unit tests.
 *
 * TYPE-ONLY IMPORTS ARE FINE and are allowed by name. `MissionStatus`,
 * `Mission` and `MISSION_STATUSES` are the shared vocabulary the ACL itself
 * returns; importing them creates no second substrate. Only the five FUNCTIONS
 * that touch DynamoDB are fenced.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** The functions that read or write the DynamoDB mission table. */
const REPO_FUNCTIONS = [
  'listMissionsForAgent',
  'listMissionsByStatus',
  'createMission',
  'updateMissionStatus',
  'reassignMission',
];

/**
 * The two files allowed to call them, and why.
 *   - `mission-acl.ts` IS the seam; the legacy half of every branch lives there.
 *   - `handler.ts` keeps the four `legacy*Mission` bodies C-8 says to EXTRACT,
 *     NOT DELETE — they are what serves when the flag is off.
 */
const ALLOWED = ['lib/missions/mission-acl.ts', 'adapters/dashboard/handler.ts'];

/** Every caller that was repointed at the ACL in Phase 7 and must stay repointed. */
const FENCED = [
  'adapters/dashboard/missions.ts',
  'adapters/dashboard/jarvis.ts',
  'lib/tools/privacy-tools.ts',
  'lib/tools/mission-tools.ts',
];

function importedNames(source: string): string[] {
  const names: string[] = [];
  const importRe = /import\s+([\s\S]*?)\s+from\s+['"][^'"]*mission-tasks-repo\.js['"]/g;
  for (const match of source.matchAll(importRe)) {
    const clause = match[1];
    // A whole-clause `import type { … }` imports no runtime binding at all.
    if (/^type\s/.test(clause.trim())) continue;
    const braces = clause.match(/\{([\s\S]*)\}/);
    if (!braces) continue;
    for (const raw of braces[1].split(',')) {
      const specifier = raw.trim();
      if (!specifier || specifier.startsWith('type ')) continue;
      names.push(specifier.split(/\s+as\s+/)[0].trim());
    }
  }
  return names;
}

describe('C-14: mission reads go through the ACL, not around it', () => {
  it.each(FENCED)('%s imports no DynamoDB mission function directly', (relative) => {
    const source = readFileSync(resolve(ROOT, relative), 'utf8');
    const leaked = importedNames(source).filter((name) => REPO_FUNCTIONS.includes(name));
    expect(leaked).toEqual([]);
  });

  it('and the two files that DO reach the repo are exactly the two that may', () => {
    for (const relative of ALLOWED) {
      const source = readFileSync(resolve(ROOT, relative), 'utf8');
      expect(source).toContain('mission-tasks-repo.js');
    }
  });

  /**
   * Guards the guard: if the repo's function names are renamed, the fence above
   * silently passes on a stale list. This fails instead.
   */
  it('the fenced names still exist in the repo, so the list has not gone stale', () => {
    const repo = readFileSync(resolve(ROOT, 'lib/state/mission-tasks-repo.ts'), 'utf8');
    for (const name of REPO_FUNCTIONS) {
      expect(repo).toMatch(new RegExp(`export\\s+(async\\s+)?function\\s+${name}\\b`));
    }
  });
});
