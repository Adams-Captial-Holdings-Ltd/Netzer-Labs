import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error -- dependency-free .mjs CI helper intentionally has no declarations
import { validateFeatureKnowledge } from './feature-knowledge.mjs';

const requiredFiles = [
  'docs/features/missions/README.md',
  'docs/features/missions/HANDOFF.md',
  'handoff.md',
  'AGENTS.md',
  'docs/README.md',
  'development.md',
  'docs/missions-v2-backlog.md',
  'docs/missions-v2-audit.md',
];

function frontmatter(role: string, status: string, relationships = ''): string {
  return `---
feature: missions
document_role: ${role}
status: ${status}
observed_at: 2026-08-11
as_of_commit: d767a368bca3cbb32e0abfc50a42cd3a001c64fa
${relationships}---`;
}

function fixture() {
  const files: Record<string, string> = {
    'docs/features/missions/README.md': `${frontmatter('index', 'current', `implemented_by:
  - src/missions.ts
tested_by:
  - src/missions.test.ts
decisions:
  - docs/adr/0009-mission-container-model.md
approved_work:
  - docs/missions-v2-backlog.md
evidence:
  - docs/missions-v2-audit.md
`)}\n# Missions\n`,
    'docs/features/missions/HANDOFF.md': `${frontmatter('handoff', 'current')}\n# Missions handoff\n`,
    'handoff.md': `${frontmatter('compatibility', 'compatibility')}\n\nMissions operational state is maintained in [the canonical Missions HANDOFF](docs/features/missions/HANDOFF.md).\n`,
    'AGENTS.md': '[Missions README](docs/features/missions/README.md)\n',
    'docs/README.md': '[Missions](./features/missions/README.md)\n',
    'development.md': 'Feature state belongs in `docs/features/<slug>/HANDOFF.md`.\n',
    'docs/missions-v2-backlog.md': `# Backlog
## MISSION-010
\`\`\`yaml
outcome: landed
reachable_commit: abc123
present_in_current_source: true
deployment: not_deployed
verification: code_verified
\`\`\`
## MISSION-011
\`\`\`yaml
work_state: approved
\`\`\`
## Retired IDs (not active work)
### MISSION-013
\`\`\`yaml
outcome: rejected
reachable_commit: none
present_in_current_source: false
deployment: not_deployed
verification: not_run
\`\`\`
`,
    'docs/missions-v2-audit.md': '# Audit\nThis is **historical** evidence. See the [current Missions README](features/missions/README.md) and [ADR](adr/0009-mission-container-model.md).\n',
    'src/missions.ts': '',
    'src/missions.test.ts': '',
    'docs/adr/0009-mission-container-model.md': '',
  };
  return { files, trackedFiles: new Set(Object.keys(files)), existingFiles: new Set(Object.keys(files)) };
}

function failuresFor(change?: (repo: ReturnType<typeof fixture>) => void): string[] {
  const repo = fixture();
  change?.(repo);
  return validateFeatureKnowledge(repo);
}

describe('validateFeatureKnowledge', () => {
  it('accepts the complete feature-knowledge fixture', () => {
    expect(failuresFor()).toEqual([]);
  });

  it('requires both canonical Missions files', () => {
    expect(failuresFor(({ files }) => delete files['docs/features/missions/README.md']).join('\n'))
      .toMatch(/missing canonical.*README/i);
    expect(failuresFor(({ files }) => delete files['docs/features/missions/HANDOFF.md']).join('\n'))
      .toMatch(/missing canonical.*HANDOFF/i);
  });

  it('rejects missing required metadata and invalid role/status enums', () => {
    expect(failuresFor(({ files }) => {
      files['docs/features/missions/README.md'] = files['docs/features/missions/README.md'].replace('observed_at: 2026-08-11\n', '');
    }).join('\n')).toMatch(/observed_at/);
    expect(failuresFor(({ files }) => {
      files['docs/features/missions/HANDOFF.md'] = files['docs/features/missions/HANDOFF.md'].replace('document_role: handoff', 'document_role: diary').replace('status: current', 'status: draft');
    }).join('\n')).toMatch(/document_role.*diary[\s\S]*status.*draft/);
  });

  it('allows the root handoff only as the exact short compatibility pointer', () => {
    expect(failuresFor(({ files }) => {
      files['handoff.md'] = files['handoff.md'].replace('observed_at: 2026-08-11\n', '');
    }).join('\n')).toMatch(/root handoff\.md: missing observed_at/);
    expect(failuresFor(({ files }) => {
      files['handoff.md'] += '\n## Active work\nDo something.\n';
    }).join('\n')).toMatch(/root handoff.*pointer/i);
    expect(failuresFor(({ files }) => {
      files['handoff.md'] = files['handoff.md'].replace('docs/features/missions/HANDOFF.md', 'docs/missions-v2-audit.md');
    }).join('\n')).toMatch(/exactly one Markdown link/i);
    expect(failuresFor(({ files }) => {
      files['handoff.md'] = files['handoff.md'].replace('.\n', ' and [the README](docs/features/missions/README.md).\n');
    }).join('\n')).toMatch(/exactly one Markdown link/i);
  });

  it('treats the lowercase root handoff path as casing-sensitive', () => {
    expect(failuresFor(({ files }) => {
      files['HANDOFF.md'] = files['handoff.md'];
      delete files['handoff.md'];
    }).join('\n')).toMatch(/missing root handoff\.md/);
  });

  it.each(['implemented_by', 'tested_by', 'decisions', 'approved_work', 'evidence'])(
    'rejects scalar and malformed %s relationships',
    (key) => {
      expect(failuresFor(({ files }) => {
        files['docs/features/missions/README.md'] = files['docs/features/missions/README.md'].replace(`${key}:\n`, `${key}: src/missions.ts\n`);
      }).join('\n')).toMatch(new RegExp(`relationship ${key} must be a YAML list`));
      expect(failuresFor(({ files }) => {
        files['docs/features/missions/README.md'] = files['docs/features/missions/README.md'].replace(`${key}:\n  -`, `${key}:\n -`);
      }).join('\n')).toMatch(new RegExp(`relationship ${key} must be a non-empty YAML list`));
    },
  );

  it('requires AGENTS and the docs index to discover the canonical README', () => {
    expect(failuresFor(({ files }) => { files['AGENTS.md'] = '# Agents\n'; }).join('\n')).toMatch(/AGENTS.*Missions README/);
    expect(failuresFor(({ files }) => { files['docs/README.md'] = '# Docs\n'; }).join('\n')).toMatch(/docs\/README.*Missions README/);
  });

  it('requires per-feature handoffs and rejects a writable global operational handoff', () => {
    expect(failuresFor(({ files }) => { files['development.md'] = 'Keep notes nearby.\n'; }).join('\n')).toMatch(/docs\/features\/<slug>\/HANDOFF\.md/);
    expect(failuresFor(({ files }) => { files['development.md'] += 'Every feature author must update the root handoff.md with operational state.\n'; }).join('\n')).toMatch(/global operational handoff/i);
  });

  it('rejects invalid active work states and incomplete closed evidence', () => {
    expect(failuresFor(({ files }) => {
      files['docs/missions-v2-backlog.md'] = files['docs/missions-v2-backlog.md'].replace('work_state: approved', 'work_state: rejected');
    }).join('\n')).toMatch(/MISSION-011.*work_state.*rejected/);
    expect(failuresFor(({ files }) => {
      files['docs/missions-v2-backlog.md'] = files['docs/missions-v2-backlog.md'].replace('deployment: not_deployed\n', '');
    }).join('\n')).toMatch(/MISSION-010.*deployment/);
  });

  it('forbids rejected or retired IDs in dependency sequencing', () => {
    expect(failuresFor(({ files }) => {
      files['docs/missions-v2-backlog.md'] = files['docs/missions-v2-backlog.md'].replace('work_state: approved\n```', 'work_state: approved\n```\n\n**Dependencies.** MISSION-013.');
    }).join('\n')).toMatch(/MISSION-013.*dependency sequencing/);
  });

  it('requires the audit to be historical and link the current README and ADR', () => {
    expect(failuresFor(({ files }) => {
      files['docs/missions-v2-audit.md'] = '# Audit\nCurrent specification.\n';
    }).join('\n')).toMatch(/historical[\s\S]*Missions README[\s\S]*ADR/);
  });

  it('requires frontmatter relationships to resolve to Git-tracked files', () => {
    expect(failuresFor(({ trackedFiles }) => trackedFiles.delete('src/missions.ts')).join('\n')).toMatch(/src\/missions\.ts.*Git-tracked/);
    expect(failuresFor(({ files, trackedFiles }) => {
      files['docs/features/missions/README.md'] = files['docs/features/missions/README.md'].replace('src/missions.ts', 'src/missing.ts');
      trackedFiles.add('src/missing.ts');
    }).join('\n')).toMatch(/src\/missing\.ts.*resolve/);
  });

  it('accepts the current repository', () => {
    const root = resolve(import.meta.dirname, '../..');
    const files = Object.fromEntries(requiredFiles.map((path) => [path, readFileSync(resolve(root, path), 'utf8')]));
    const trackedFiles = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean).map((path) => path.replaceAll('\\', '/')));
    const existingFiles = new Set([...trackedFiles].filter((path) => existsSync(resolve(root, path))));
    expect(validateFeatureKnowledge({ files, trackedFiles, existingFiles })).toEqual([]);
  });
});
