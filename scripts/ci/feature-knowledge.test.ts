import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
// @ts-expect-error -- dependency-free .mjs CI helper intentionally has no declarations
import { relativeLink, snapshotRepository, validateFeatureKnowledge } from './feature-knowledge.mjs';

function frontmatter(feature: string, role: string, status: string, relationships = ''): string {
  return `---
feature: ${feature}
document_role: ${role}
status: ${status}
observed_at: 2026-08-11
as_of_commit: d767a368bca3cbb32e0abfc50a42cd3a001c64fa
${relationships}---`;
}

/** The nine `##` sections docs/features/HANDOFF-TEMPLATE.md requires. */
const SESSION_SECTIONS = [
  'Session Metadata',
  'Current State Summary',
  'Codebase Understanding',
  'Work Completed',
  'Errors, Mistakes & Learnings',
  'Pending Work',
  'Context for Resuming Agent',
  'Environment State',
  'Related Resources',
];

function sessionHandoff(feature: string, slug = 'mission-container'): string {
  return `---
feature: ${feature}
document_role: session-handoff
status: current
observed_at: 2026-08-12
as_of_commit: d767a368bca3cbb32e0abfc50a42cd3a001c64fa
session_slug: ${slug}
supersedes: none
---

# Handoff: ${slug}

${SESSION_SECTIONS.map((section) => `## ${section}\n`).join('\n')}`;
}

const SESSION_PATH = 'docs/features/missions/handoffs/2026-08-12-mission-container.md';

/**
 * Two unrelated features prove the contract is generic: `missions` exercises
 * every relationship key plus a session log, `warp-private-access` is the
 * minimum conforming folder (two files, no declared authorities).
 */
function fixture() {
  const files: Record<string, string> = {
    'docs/features/README.md': '# Feature knowledge framework\n',
    'docs/features/missions/README.md': `${frontmatter('missions', 'index', 'current', `implemented_by:
  - src/missions.ts
tested_by:
  - src/missions.test.ts
decisions:
  - docs/adr/0009-mission-container-model.md
approved_work:
  - docs/missions-v2-backlog.md
evidence:
  - docs/missions-v2-audit.md
`)}\n# Missions\n\nSee the [framework](../README.md).\n`,
    'docs/features/missions/HANDOFF.md': `${frontmatter('missions', 'handoff', 'current')}\n# Missions handoff\n`,
    [SESSION_PATH]: sessionHandoff('missions'),
    'docs/features/warp-private-access/README.md': `${frontmatter('warp-private-access', 'index', 'current')}\n# WARP\n\nSee the [framework](../README.md).\n`,
    'docs/features/warp-private-access/HANDOFF.md': `${frontmatter('warp-private-access', 'handoff', 'current')}\n# WARP handoff\n`,
    'handoff.md': `${frontmatter('missions', 'compatibility', 'compatibility')}\n\nMissions operational state is maintained in [the canonical Missions HANDOFF](docs/features/missions/HANDOFF.md).\n`,
    'AGENTS.md': '[Feature knowledge framework](docs/features/README.md)\n',
    'docs/README.md': '[Feature knowledge framework](./features/README.md)\n',
    'development.md': 'Feature state belongs in `docs/features/<slug>/HANDOFF.md`; the format is the [framework](docs/features/README.md).\n',
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
    'docs/missions-v2-audit.md': '# Audit\nThis is **historical** evidence. See the [current Missions README](features/missions/README.md).\n',
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

describe('relativeLink', () => {
  it.each([
    ['AGENTS.md', 'docs/features/README.md', 'docs/features/README.md'],
    ['docs/README.md', 'docs/features/README.md', 'features/README.md'],
    ['docs/features/missions/README.md', 'docs/features/README.md', '../README.md'],
    ['docs/missions-v2-audit.md', 'docs/features/missions/README.md', 'features/missions/README.md'],
  ])('resolves %s -> %s as %s', (from, to, expected) => {
    expect(relativeLink(from, to)).toBe(expected);
  });
});

describe('validateFeatureKnowledge', () => {
  it('accepts a two-feature fixture', () => {
    expect(failuresFor()).toEqual([]);
  });

  it('requires the framework spec and at least one feature folder', () => {
    expect(failuresFor(({ files }) => delete files['docs/features/README.md']).join('\n'))
      .toMatch(/missing feature knowledge framework/);
    expect(validateFeatureKnowledge({ files: {}, trackedFiles: new Set(), existingFiles: new Set() }).join('\n'))
      .toMatch(/no feature folder found/);
  });

  it('requires both canonical files in every feature folder, not just the first', () => {
    expect(failuresFor(({ files }) => delete files['docs/features/missions/README.md']).join('\n'))
      .toMatch(/missing canonical missions README/);
    expect(failuresFor(({ files }) => delete files['docs/features/warp-private-access/HANDOFF.md']).join('\n'))
      .toMatch(/missing canonical warp-private-access HANDOFF/);
  });

  it('requires frontmatter feature to match the folder name', () => {
    expect(failuresFor(({ files }) => {
      files['docs/features/warp-private-access/README.md'] = files['docs/features/warp-private-access/README.md'].replace('feature: warp-private-access', 'feature: missions');
    }).join('\n')).toMatch(/warp-private-access\/README\.md: feature must be warp-private-access/);
  });

  it('rejects a slug that is not lowercase kebab-case', () => {
    expect(failuresFor(({ trackedFiles }) => trackedFiles.add('docs/features/Warp_Access/README.md')).join('\n'))
      .toMatch(/Warp_Access: slug must be lowercase kebab-case/);
  });

  it('rejects missing required metadata and invalid role/status enums', () => {
    expect(failuresFor(({ files }) => {
      files['docs/features/missions/README.md'] = files['docs/features/missions/README.md'].replace('observed_at: 2026-08-11\n', '');
    }).join('\n')).toMatch(/observed_at/);
    expect(failuresFor(({ files }) => {
      files['docs/features/missions/HANDOFF.md'] = files['docs/features/missions/HANDOFF.md'].replace('document_role: handoff', 'document_role: diary').replace('status: current', 'status: draft');
    }).join('\n')).toMatch(/document_role.*diary[\s\S]*status.*draft/);
  });

  // ── Session logs: docs/features/<slug>/handoffs/*.md ──────────────────────
  // The template is enforced structurally (file name, frontmatter, the nine
  // headings). What is written UNDER each heading stays a review concern.

  it('requires session logs to be named YYYY-MM-DD-<kebab-slug>.md', () => {
    expect(failuresFor(({ files }) => {
      files['docs/features/missions/handoffs/notes.md'] = files[SESSION_PATH];
      delete files[SESSION_PATH];
    }).join('\n')).toMatch(/handoffs\/notes\.md: session handoff must be named YYYY-MM-DD-<kebab-slug>\.md/);
  });

  it('requires the session-handoff role, both extra keys, and a valid status', () => {
    expect(failuresFor(({ files }) => {
      files[SESSION_PATH] = files[SESSION_PATH].replace('document_role: session-handoff', 'document_role: handoff');
    }).join('\n')).toMatch(/document_role must be session-handoff/);

    expect(failuresFor(({ files }) => {
      files[SESSION_PATH] = files[SESSION_PATH].replace('session_slug: mission-container\n', '');
    }).join('\n')).toMatch(/missing session_slug/);

    expect(failuresFor(({ files }) => {
      files[SESSION_PATH] = files[SESSION_PATH].replace('supersedes: none\n', '');
    }).join('\n')).toMatch(/missing supersedes/);

    expect(failuresFor(({ files }) => {
      files[SESSION_PATH] = files[SESSION_PATH].replace('status: current', 'status: draft');
    }).join('\n')).toMatch(/invalid status draft/);
  });

  it('accepts a session log kept as historical, not only current', () => {
    expect(failuresFor(({ files }) => {
      files[SESSION_PATH] = files[SESSION_PATH].replace('status: current', 'status: historical');
    })).toEqual([]);
  });

  it('requires the session log to declare its own feature folder', () => {
    expect(failuresFor(({ files }) => {
      files[SESSION_PATH] = files[SESSION_PATH].replace('feature: missions', 'feature: warp-private-access');
    }).join('\n')).toMatch(/handoffs\/2026-08-12-mission-container\.md: feature must be missions/);
  });

  it.each(SESSION_SECTIONS)('requires the "%s" section', (section) => {
    expect(failuresFor(({ files }) => {
      files[SESSION_PATH] = files[SESSION_PATH].replace(`## ${section}\n`, '');
    }).join('\n')).toContain(`missing required section "## ${section}"`);
  });

  it('tolerates a UTF-8 BOM, which PowerShell writes by default', () => {
    expect(failuresFor(({ files }) => {
      files[SESSION_PATH] = `\uFEFF${files[SESSION_PATH]}`;
    })).toEqual([]);
  });

  it('requires every feature README to link the framework', () => {
    expect(failuresFor(({ files }) => {
      files['docs/features/warp-private-access/README.md'] = files['docs/features/warp-private-access/README.md'].replace('See the [framework](../README.md).', 'No pointer.');
    }).join('\n')).toMatch(/warp-private-access\/README\.md: must link the feature knowledge framework/);
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

  it('accepts a root handoff pointing at any feature, not only missions', () => {
    expect(failuresFor(({ files }) => {
      files['handoff.md'] = `${frontmatter('warp-private-access', 'compatibility', 'compatibility')}\n\nWARP state is maintained in [the canonical WARP HANDOFF](docs/features/warp-private-access/HANDOFF.md).\n`;
    })).toEqual([]);
    expect(failuresFor(({ files }) => {
      files['handoff.md'] = files['handoff.md'].replace('feature: missions', 'feature: nonexistent');
    }).join('\n')).toMatch(/root handoff\.md: feature nonexistent is not a known feature folder/);
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

  it('requires approved_work and evidence targets to be Markdown', () => {
    expect(failuresFor(({ files, trackedFiles, existingFiles }) => {
      files['docs/features/missions/README.md'] = files['docs/features/missions/README.md'].replace('docs/missions-v2-backlog.md', 'src/backlog.json');
      trackedFiles.add('src/backlog.json');
      existingFiles.add('src/backlog.json');
    }).join('\n')).toMatch(/approved_work target src\/backlog\.json must be a Markdown document/);
  });

  it('requires AGENTS, the docs index, and development.md to reach the framework', () => {
    expect(failuresFor(({ files }) => { files['AGENTS.md'] = '# Agents\n'; }).join('\n')).toMatch(/AGENTS\.md must link the feature knowledge framework/);
    expect(failuresFor(({ files }) => { files['docs/README.md'] = '# Docs\n'; }).join('\n')).toMatch(/docs\/README\.md must link the feature knowledge framework/);
    expect(failuresFor(({ files }) => { files['development.md'] = 'Feature state belongs in `docs/features/<slug>/HANDOFF.md`.\n'; }).join('\n')).toMatch(/development\.md must link the feature knowledge framework/);
  });

  it('requires per-feature handoffs and rejects a writable global operational handoff', () => {
    expect(failuresFor(({ files }) => { files['development.md'] = 'Keep notes in the [framework](docs/features/README.md).\n'; }).join('\n')).toMatch(/docs\/features\/<slug>\/HANDOFF\.md/);
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

  it('forbids duplicate or reused task IDs', () => {
    expect(failuresFor(({ files }) => {
      files['docs/missions-v2-backlog.md'] += `
## MISSION-013 — reused
\`\`\`yaml
work_state: approved
\`\`\`
`;
    }).join('\n')).toMatch(/MISSION-013.*duplicate|duplicate.*MISSION-013/i);
  });

  it('reads task IDs from any feature prefix, not only MISSION', () => {
    expect(failuresFor(({ files, trackedFiles, existingFiles }) => {
      files['docs/features/warp-private-access/README.md'] = `${frontmatter('warp-private-access', 'index', 'current', 'approved_work:\n  - docs/warp-backlog.md\n')}\n# WARP\n\nSee the [framework](../README.md).\n`;
      files['docs/warp-backlog.md'] = '# WARP backlog\n## WARP-001\n```yaml\nwork_state: nonsense\n```\n';
      trackedFiles.add('docs/warp-backlog.md');
      existingFiles.add('docs/warp-backlog.md');
    }).join('\n')).toMatch(/WARP-001: invalid work_state nonsense/);
  });

  it('requires declared evidence to be historical and to link its own feature README', () => {
    expect(failuresFor(({ files }) => {
      files['docs/missions-v2-audit.md'] = '# Audit\nCurrent specification.\n';
    }).join('\n')).toMatch(/evidence must be labeled historical[\s\S]*evidence must link the current feature README/);
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
    expect(validateFeatureKnowledge(snapshotRepository(root))).toEqual([]);
  });
});
