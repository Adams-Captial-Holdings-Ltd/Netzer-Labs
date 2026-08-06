import { describe, it, expect } from 'vitest';
import { buildComplianceSummary } from './control-catalog.js';
import { buildRemediationBrief } from './brief.js';
import type { EvidenceCard } from './evidence.js';

function card(id: string, status: EvidenceCard['status'], area: string, tags: string[]): EvidenceCard {
  return { id, label: id, status, detail: `${id} detail`, area, tags };
}

describe('buildRemediationBrief', () => {
  it('produces a structured, paste-ready brief grounded in the scan', () => {
    const evidence: EvidenceCard[] = [
      card('gd', 'crit', 'network', ['threat-detection']), // -> gap controls
      card('iam', 'warn', 'iam', ['access-control-iam']), // -> partial controls
      card('kms', 'ok', 'encryption', ['encryption-at-rest', 'key-rotation']), // -> met controls
    ];
    const summary = buildComplianceSummary(evidence, '2026-06-06T00:00:00.000Z');
    const brief = buildRemediationBrief(summary);

    // Headline + the loop instructions an agent needs.
    expect(brief.markdown).toContain('# ClaudeClaw Compliance Remediation Brief');
    expect(brief.markdown).toContain('## Objective');
    expect(brief.markdown).toContain('## Current standing');
    expect(brief.markdown).toContain('## How to work this loop');
    expect(brief.markdown).toMatch(/refresh the Compliance tab/i);

    // A crit signal yields a Priority 1 section; a warn yields Priority 2.
    expect(brief.markdown).toContain('Priority 1');
    expect(brief.markdown).toContain('Priority 2');

    // Manual controls are split out as human/specialist work, never "fix in code".
    expect(brief.markdown).toContain('Needs human / specialist intervention');
    expect(brief.markdown).toMatch(/Business Associate Agreements/);

    // Stats reflect the graded outcome.
    expect(brief.stats.gap).toBeGreaterThanOrEqual(1);
    expect(brief.stats.partial).toBeGreaterThanOrEqual(1);
    expect(brief.stats.manual).toBeGreaterThan(0);
    expect(brief.generatedAt).toBe('2026-06-06T00:00:00.000Z');
  });

  it('still produces a valid brief when there are no automated gaps (evidence-less scan)', () => {
    const summary = buildComplianceSummary([], '2026-06-06T00:00:00.000Z');
    const brief = buildRemediationBrief(summary);
    expect(brief.markdown).toContain('# ClaudeClaw Compliance Remediation Brief');
    // No evidence ⇒ every automated control is unverifiable, so Priority 3 leads.
    expect(brief.markdown).toContain('Priority 3');
    expect(brief.stats.gap).toBe(0);
    expect(brief.stats.unknown).toBeGreaterThan(0);
  });
});
