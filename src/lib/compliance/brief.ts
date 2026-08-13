/**
 * Remediation brief generator — the "meta-prompt".
 *
 * Turns a live compliance scan into a single, paste-ready brief the user hands
 * to Claude Code (or any coding agent) to close the gaps. It is deterministic
 * (no model call) so it is instant, free, and always available — every scan
 * regenerates it from the current state, which is what makes the loop work:
 * scan → paste brief into Claude Code → it fixes a batch → re-scan → a smaller
 * brief → repeat, until only manual/specialist items remain.
 *
 * The brief is grounded entirely in the catalog + live evidence: each gap names
 * the controlling clause, the failing signal, what the standard requires, and a
 * concrete fix. Manual controls are split out as "needs human/specialist
 * intervention" so the agent never pretends to fix a BAA or a risk analysis.
 */

import type {
  ComplianceSummary,
  EvaluatedControl,
  ControlStatus,
} from './control-catalog.js';

export interface RemediationBrief {
  generatedAt: string;
  /** The full markdown prompt to paste into Claude Code. */
  markdown: string;
  stats: {
    soc2Score: number;
    hipaaScore: number;
    met: number;
    partial: number;
    gap: number;
    unknown: number;
    manual: number;
  };
}

interface Tagged extends EvaluatedControl {
  fw: string; // 'SOC 2' | 'HIPAA'
}

function fwLabel(id: string): string {
  return id === 'soc2' ? 'SOC 2' : 'HIPAA';
}

function allControls(summary: ComplianceSummary): Tagged[] {
  const out: Tagged[] = [];
  for (const fw of summary.frameworks) {
    for (const c of fw.controls) out.push({ ...c, fw: fwLabel(fw.id) });
  }
  return out;
}

function byStatus(controls: Tagged[], status: ControlStatus): Tagged[] {
  return controls.filter((c) => c.status === status);
}

/** Render the failing/relevant evidence as compact bullet lines. */
function evidenceLines(c: Tagged): string[] {
  if (c.evidence.length === 0) return [];
  return c.evidence.map(
    (e) => `    - [${e.status.toUpperCase()}] ${e.label}: ${e.detail}${e.value ? ` (${e.value})` : ''}`,
  );
}

function controlBlock(c: Tagged, index: number): string {
  const lines: string[] = [];
  lines.push(`${index}. **[${c.fw} ${c.ref}] ${c.title}**`);
  lines.push(`   - Requirement: ${c.intent}`);
  if (c.evidence.length > 0) {
    lines.push(`   - Live signals:`);
    lines.push(...evidenceLines(c));
  }
  lines.push(`   - Fix: ${c.quickFix}`);
  return lines.join('\n');
}

function section(title: string, body: string): string {
  return `## ${title}\n\n${body}\n`;
}

/**
 * Build the remediation brief from a scan summary. Pure + deterministic so it is
 * unit-testable and identical for the same input.
 */
export function buildRemediationBrief(summary: ComplianceSummary): RemediationBrief {
  const controls = allControls(summary);
  const gaps = byStatus(controls, 'gap');
  const partials = byStatus(controls, 'partial');
  const unknowns = byStatus(controls, 'unknown');
  const manual = byStatus(controls, 'manual');
  const met = byStatus(controls, 'met');

  const soc2 = summary.frameworks.find((f) => f.id === 'soc2');
  const hipaa = summary.frameworks.find((f) => f.id === 'hipaa');
  const soc2Score = soc2?.score ?? 0;
  const hipaaScore = hipaa?.score ?? 0;

  const parts: string[] = [];

  parts.push(
    `# ClaudeClaw Compliance Remediation Brief\n\n` +
      `Generated ${summary.generatedAt} from a live posture scan of this deployment ` +
      `(${summary.evidenceCount} signals across ${summary.scan.areas.length} domains).\n`,
  );

  parts.push(
    section(
      'Objective',
      [
        'You are working in this repository (a Netzar OS Enterprise deployment on AWS, CDK-managed).',
        'Close the SOC 2 and HIPAA gaps listed below, highest-impact first. Prefer infrastructure-as-code (CDK) changes and name every file you touch.',
        'After you finish a batch, tell me to refresh the Compliance tab so it re-scans and regenerates this brief with what remains. Work only the items listed here now; the list shrinks each round.',
      ].join(' '),
    ),
  );

  parts.push(
    section(
      'Current standing',
      [
        `- SOC 2: **${soc2Score}%** (graded ${soc2?.gradedCount ?? 0} of ${soc2?.controls.length ?? 0})`,
        `- HIPAA: **${hipaaScore}%** (graded ${hipaa?.gradedCount ?? 0} of ${hipaa?.controls.length ?? 0})`,
        `- Across both: ${met.length} met, ${partials.length} partial, ${gaps.length} gap, ${unknowns.length} unverifiable, ${manual.length} manual.`,
      ].join('\n'),
    ),
  );

  // Priority 1 — critical gaps.
  if (gaps.length > 0) {
    parts.push(
      section(
        'Priority 1 — Critical gaps (a control is actively failing)',
        gaps.map((c, i) => controlBlock(c, i + 1)).join('\n\n'),
      ),
    );
  }

  // Priority 2 — partial coverage.
  if (partials.length > 0) {
    parts.push(
      section(
        'Priority 2 — Partial coverage (control present but degraded)',
        partials.map((c, i) => controlBlock(c, i + 1)).join('\n\n'),
      ),
    );
  }

  // Priority 3 — unverifiable.
  if (unknowns.length > 0) {
    parts.push(
      section(
        'Priority 3 — Unverifiable (the scan could not read the signal)',
        [
          'Each of these is Unknown because the orchestrator role lacks the AWS read/describe permission for the signal, OR the underlying resource does not exist yet. For each, do ONE of:',
          '(a) grant the orchestrator task role the minimal read permission so the control becomes visible (then it will score on the next scan), or',
          '(b) provision the missing control. Do not weaken the protected roles (orchestrator task role / CDK roles).',
          '',
          unknowns.map((c, i) => controlBlock(c, i + 1)).join('\n\n'),
        ].join('\n'),
      ),
    );
  }

  // Manual / specialist.
  if (manual.length > 0) {
    parts.push(
      section(
        'Needs human / specialist intervention (do NOT attempt in code)',
        [
          'These are process/legal controls a coding agent cannot satisfy. Surface them to me and route to compliance/legal. Do not mark them done in code.',
          '',
          manual
            .map((c) => `- **[${c.fw} ${c.ref}] ${c.title}** — ${c.quickFix}`)
            .join('\n'),
        ].join('\n'),
      ),
    );
  }

  parts.push(
    section(
      'How to work this loop',
      [
        '1. Start at Priority 1 and work down. Batch related fixes (e.g. all KMS rotation) into one change.',
        '2. For each fix, change the IaC/source, explain the change, and note the control ref it closes.',
        '3. Never modify the orchestrator task role or CDK roles in a way that removes guardrails; only ADD least-privilege read/permissions.',
        '4. When a batch is done, stop and tell me to refresh the Compliance tab to re-scan. Paste the new brief back to continue.',
        '5. When only Manual items remain, we have reached the automatable ceiling — flag that I should bring in compliance/legal help.',
      ].join('\n'),
    ),
  );

  parts.push(
    section(
      'Guardrails',
      'This brief is decision support generated from live posture, not a certification or legal advice. Verdicts reflect what this deployment can technically read right now. A Met control is a good signal, not an attestation of compliance.',
    ),
  );

  return {
    generatedAt: summary.generatedAt,
    markdown: parts.join('\n'),
    stats: {
      soc2Score,
      hipaaScore,
      met: met.length,
      partial: partials.length,
      gap: gaps.length,
      unknown: unknowns.length,
      manual: manual.length,
    },
  };
}
