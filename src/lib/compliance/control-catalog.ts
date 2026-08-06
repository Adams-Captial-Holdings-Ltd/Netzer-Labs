/**
 * Compliance control catalog (SOC 2 + HIPAA) and scoring.
 *
 * This is the single source of truth for "what a compliant ClaudeClaw
 * deployment must demonstrate" and how each requirement maps to the LIVE
 * posture evidence the platform already reads (encryption, IAM, backups,
 * audit immutability, monitoring, threat detection — see ./evidence.ts).
 *
 * Two honesty rules drive the design so the dashboard never overclaims:
 *   1. AUTOMATED controls are graded ONLY from live evidence. ok→met,
 *      warn→partial, crit→gap, unknown→unknown. No evidence ⇒ unknown, never
 *      "met". A green score reflects controls we can actually verify right now.
 *   2. MANUAL controls (workforce training, risk assessment, BAAs, physical
 *      safeguards) cannot be machine-verified. They are listed as `manual` so
 *      the gap view stays complete, but they are EXCLUDED from the automated
 *      score and clearly labelled as requiring human attestation.
 *
 * Editions referenced: SOC 2 — AICPA 2017 Trust Services Criteria (incl. the
 * 2022 revised points of focus). HIPAA — the Security Rule, 45 CFR Part 164
 * Subpart C, as amended by the HITECH Act; the AI analyst (./analyst.ts) also
 * surfaces the Jan 2025 HHS Security Rule NPRM where a proposed change is
 * material. The catalog `ref` strings cite the controlling section so an
 * auditor can trace each row back to the standard.
 */

import type { EvidenceCard } from './evidence.js';

export type ComplianceFrameworkId = 'soc2' | 'hipaa';

/**
 * A control's verdict.
 *   met     — every mapped evidence signal is healthy.
 *   partial — at least one signal is degraded (warn) but none critical.
 *   gap     — at least one signal is critical/exposed (crit).
 *   unknown — no readable evidence (a describe was denied, or nothing emitted).
 *   manual  — a process control the platform cannot verify; needs attestation.
 */
export type ControlStatus = 'met' | 'partial' | 'gap' | 'unknown' | 'manual';

/** A control definition in the catalog. */
export interface ControlDef {
  /** Stable, unique id. */
  id: string;
  framework: ComplianceFrameworkId;
  /** The controlling clause, e.g. 'CC6.1' or '§164.312(a)(2)(iv)'. */
  ref: string;
  title: string;
  /** UI grouping bucket. */
  category: string;
  /** What the standard requires, in plain English (latest edition). */
  intent: string;
  /**
   * Evidence tags that inform this control. A card carrying ANY of these tags
   * (see ./evidence.ts tagging) is matched to the control. Empty ⇒ manual.
   */
  requires: string[];
  /** True for process controls that cannot be auto-verified. */
  manual?: boolean;
  /** Short, concrete remediation shown without needing the AI analyst. */
  quickFix: string;
}

/** A control after grading against live evidence. */
export interface EvaluatedControl {
  id: string;
  framework: ComplianceFrameworkId;
  ref: string;
  title: string;
  category: string;
  intent: string;
  quickFix: string;
  manual: boolean;
  status: ControlStatus;
  /** The live evidence cards matched to this control (for the UI drill-down). */
  evidence: Array<{
    id: string;
    label: string;
    status: EvidenceCard['status'];
    detail: string;
    value?: string;
  }>;
}

export interface FrameworkResult {
  id: ComplianceFrameworkId;
  label: string;
  description: string;
  /** 0–100 over the AUTOMATED, gradeable controls (met=1, partial=0.5, gap=0). */
  score: number;
  /** Count of automated controls with a definite verdict (met+partial+gap). */
  gradedCount: number;
  counts: Record<ControlStatus, number>;
  controls: EvaluatedControl[];
}

/**
 * One scanned evidence domain, with the real per-domain signal tally from the
 * live scan. Drives the scanning visual: the UI animates a fixed domain list
 * and fills each one in from this real backend output as the scan resolves.
 */
export interface ScanArea {
  id: string;
  label: string;
  total: number;
  ok: number;
  warn: number;
  crit: number;
  unknown: number;
}

export interface ComplianceSummary {
  generatedAt: string;
  evidenceCount: number;
  disclaimer: string;
  frameworks: FrameworkResult[];
  /** Per-domain breakdown of the evidence actually read this scan. */
  scan: { areas: ScanArea[] };
}

// ── The catalog ─────────────────────────────────────────────────────
// Kept deliberately readable: each row names the requirement, the live signal
// that proves it, and the fix. Tags must match those produced in ./evidence.ts.

const SOC2_CONTROLS: ControlDef[] = [
  {
    id: 'soc2-cc6.1-encryption',
    framework: 'soc2',
    ref: 'CC6.1',
    title: 'Data at rest is encrypted with managed keys',
    category: 'Logical & Physical Access (CC6)',
    intent:
      'Restrict access to data by encrypting it at rest under customer-managed keys with a rotation schedule, so a storage-layer compromise does not expose plaintext.',
    requires: ['encryption-at-rest', 'key-rotation'],
    quickFix:
      'Enable automatic rotation on every customer-managed KMS key and confirm S3/DynamoDB default encryption is on.',
  },
  {
    id: 'soc2-cc6.1-iam',
    framework: 'soc2',
    ref: 'CC6.1 / CC6.3',
    title: 'Least-privilege IAM on the orchestrator role',
    category: 'Logical & Physical Access (CC6)',
    intent:
      'Grant the running workload only the permissions it needs (no wildcard admin, no privilege-escalation actions) and review them.',
    requires: ['access-control-iam'],
    quickFix:
      'Resolve the IAM posture findings (scope wildcard actions/resources) on the task role using the IAM Copilot on Security Posture > IAM.',
  },
  {
    id: 'soc2-cc6.6-boundary',
    framework: 'soc2',
    ref: 'CC6.6',
    title: 'Network boundary protection (WAF + private subnets)',
    category: 'Logical & Physical Access (CC6)',
    intent:
      'Protect the system perimeter: a WAF in front of public entry points and compute isolated in private subnets.',
    requires: ['network-boundary'],
    quickFix:
      'Attach/enable the WAF web ACL on the CloudFront/ALB front door and keep tasks in private subnets behind NAT.',
  },
  {
    id: 'soc2-cc6.7-transmission-secrets',
    framework: 'soc2',
    ref: 'CC6.7',
    title: 'Credentials held in a managed secrets store',
    category: 'Logical & Physical Access (CC6)',
    intent:
      'Protect credentials in transit and at rest: no plaintext secrets in env/code; store them in Secrets Manager with rotation where feasible.',
    requires: ['secrets-mgmt'],
    quickFix:
      'Move any remaining static credentials into Secrets Manager and turn on a rotation schedule for the rotatable ones.',
  },
  {
    id: 'soc2-cc7.1-audit-logging',
    framework: 'soc2',
    ref: 'CC7.1 / CC7.2',
    title: 'Audit logging of account & API activity',
    category: 'System Operations (CC7)',
    intent:
      'Capture a complete, queryable record of management-plane and application activity (CloudTrail + the immutable app audit log) for detection and investigation.',
    requires: ['audit-logging', 'activity-review'],
    quickFix:
      'Ensure a multi-region CloudTrail trail is logging and the app audit trail is shipping to the WORM bucket.',
  },
  {
    id: 'soc2-cc7.2-monitoring',
    framework: 'soc2',
    ref: 'CC7.2',
    title: 'Monitoring & alerting on anomalies',
    category: 'System Operations (CC7)',
    intent:
      'Detect and alert on operational anomalies and failures (CloudWatch alarms, synthetic canary) so issues are caught proactively.',
    requires: ['monitoring-alerting', 'service-uptime'],
    quickFix:
      'Configure CloudWatch alarms for error/latency and confirm the synthetic canary is firing on schedule.',
  },
  {
    id: 'soc2-cc7.3-threat-detection',
    framework: 'soc2',
    ref: 'CC7.3 / CC7.4',
    title: 'Threat detection on the account',
    category: 'System Operations (CC7)',
    intent:
      'Continuously detect malicious or unauthorized activity (GuardDuty) and route findings to responders.',
    requires: ['threat-detection'],
    quickFix:
      'Enable GuardDuty in every active region and subscribe an alert recipient to its findings.',
  },
  {
    id: 'soc2-c1.1-audit-integrity',
    framework: 'soc2',
    ref: 'CC7.1 / C1.1',
    title: 'Tamper-evident, immutable audit records',
    category: 'System Operations (CC7)',
    intent:
      'Preserve the integrity of audit evidence: the audit log bucket uses Object Lock (WORM) + versioning so records cannot be altered or deleted.',
    requires: ['audit-immutability'],
    quickFix:
      'Enable S3 Object Lock (compliance mode) and versioning on the audit-log bucket.',
  },
  {
    id: 'soc2-a1.2-availability',
    framework: 'soc2',
    ref: 'A1.2',
    title: 'Backups & point-in-time recovery',
    category: 'Availability (A1)',
    intent:
      'Meet availability commitments with recoverable data: point-in-time recovery on the system-of-record tables and a tested restore path.',
    requires: ['backup-recovery'],
    quickFix:
      'Turn on PITR for every key DynamoDB table and document/test the restore runbook.',
  },
  {
    id: 'soc2-cc4.1-observability',
    framework: 'soc2',
    ref: 'CC4.1',
    title: 'Distributed tracing / observability depth',
    category: 'Monitoring of Controls (CC4)',
    intent:
      'Evaluate control operation over time with sufficient observability (distributed tracing) to investigate incidents end to end.',
    requires: ['tracing'],
    quickFix:
      'Enable X-Ray tracing (Tier 2+) so requests can be traced across services.',
  },
  {
    id: 'soc2-cc1.1-governance',
    framework: 'soc2',
    ref: 'CC1.1–CC1.4',
    title: 'Governance: code of conduct & workforce policies',
    category: 'Control Environment (CC1)',
    intent:
      'Demonstrate a control environment: documented security policies, a code of conduct, defined roles, and onboarding/offboarding procedures.',
    requires: [],
    manual: true,
    quickFix:
      'Maintain signed security policies and a code of conduct; record workforce onboarding/offboarding. Attach evidence in your GRC tool.',
  },
  {
    id: 'soc2-cc9.2-vendor-risk',
    framework: 'soc2',
    ref: 'CC9.2',
    title: 'Vendor & subservice risk management',
    category: 'Risk Mitigation (CC9)',
    intent:
      'Assess and monitor the risk of vendors and subservice organizations (e.g. AWS, model providers), including reviewing their SOC 2 reports.',
    requires: [],
    manual: true,
    quickFix:
      'Track subservice providers, review their SOC 2 Type II reports annually, and record carve-out vs inclusive complementary controls.',
  },
];

const HIPAA_CONTROLS: ControlDef[] = [
  {
    id: 'hipaa-164.312a1-access-control',
    framework: 'hipaa',
    ref: '§164.312(a)(1)',
    title: 'Access control (technical) — least privilege',
    category: 'Technical Safeguards §164.312',
    intent:
      'Implement technical policies that allow access to ePHI only to authorized persons/processes — enforced here as least-privilege IAM on the workload.',
    requires: ['access-control-iam'],
    quickFix:
      'Scope the task role to the minimum actions/resources; remove wildcard and privilege-escalation grants.',
  },
  {
    id: 'hipaa-164.312a2iv-encryption-rest',
    framework: 'hipaa',
    ref: '§164.312(a)(2)(iv)',
    title: 'Encryption of ePHI at rest',
    category: 'Technical Safeguards §164.312',
    intent:
      'Encrypt ePHI at rest (addressable, and effectively expected) under managed, rotated keys. The 2025 NPRM proposes making encryption required rather than addressable.',
    requires: ['encryption-at-rest', 'key-rotation'],
    quickFix:
      'Confirm KMS encryption with rotation on all stores holding ePHI; document the key management process.',
  },
  {
    id: 'hipaa-164.312e2ii-transmission',
    framework: 'hipaa',
    ref: '§164.312(e)(2)(ii)',
    title: 'Transmission security (encryption in transit)',
    category: 'Technical Safeguards §164.312',
    intent:
      'Guard against unauthorized access to ePHI transmitted over a network: TLS everywhere and a protected network boundary (WAF/private subnets).',
    requires: ['transmission-security', 'network-boundary'],
    quickFix:
      'Enforce TLS on all inbound/outbound paths and keep the WAF + private-subnet boundary in place.',
  },
  {
    id: 'hipaa-164.312b-audit-controls',
    framework: 'hipaa',
    ref: '§164.312(b)',
    title: 'Audit controls — record activity on systems with ePHI',
    category: 'Technical Safeguards §164.312',
    intent:
      'Record and examine activity in information systems that contain or use ePHI (CloudTrail + the application audit log).',
    requires: ['audit-logging', 'activity-review'],
    quickFix:
      'Keep CloudTrail and the app audit log running; ensure both are retained and reviewable.',
  },
  {
    id: 'hipaa-164.312c1-integrity',
    framework: 'hipaa',
    ref: '§164.312(c)(1)',
    title: 'Integrity — protect ePHI/records from improper alteration',
    category: 'Technical Safeguards §164.312',
    intent:
      'Protect ePHI and audit records from improper alteration or destruction — here, WORM Object Lock + versioning on the audit bucket.',
    requires: ['audit-immutability'],
    quickFix:
      'Enable S3 Object Lock (compliance mode) + versioning on the audit bucket so records are tamper-evident.',
  },
  {
    id: 'hipaa-164.312a2i-unique-id',
    framework: 'hipaa',
    ref: '§164.312(a)(2)(i)',
    title: 'Unique user identification & credential protection',
    category: 'Technical Safeguards §164.312',
    intent:
      'Assign a unique identity to each user/process and protect authentication credentials in a managed secrets store.',
    requires: ['secrets-mgmt', 'access-control-iam'],
    quickFix:
      'Use per-user identities (no shared logins) and keep all credentials in Secrets Manager.',
  },
  {
    id: 'hipaa-164.308a7-contingency',
    framework: 'hipaa',
    ref: '§164.308(a)(7)',
    title: 'Contingency plan — data backup & recovery',
    category: 'Administrative Safeguards §164.308',
    intent:
      'Establish data backup and disaster-recovery so ePHI can be restored — point-in-time recovery on the data tables plus a tested restore.',
    requires: ['backup-recovery'],
    quickFix:
      'Enable PITR on all ePHI tables and run a documented restore test; the 2025 NPRM proposes a 72-hour restoration target.',
  },
  {
    id: 'hipaa-164.308a1iiD-activity-review',
    framework: 'hipaa',
    ref: '§164.308(a)(1)(ii)(D)',
    title: 'Information system activity review',
    category: 'Administrative Safeguards §164.308',
    intent:
      'Regularly review records of system activity such as audit logs, access reports, and security-incident tracking.',
    requires: ['activity-review', 'monitoring-alerting'],
    quickFix:
      'Schedule a recurring review of CloudTrail/audit activity and alarm history; record who reviewed and when.',
  },
  {
    id: 'hipaa-164.308a6-incident',
    framework: 'hipaa',
    ref: '§164.308(a)(6)',
    title: 'Security incident procedures & detection',
    category: 'Administrative Safeguards §164.308',
    intent:
      'Identify and respond to suspected or known security incidents — threat detection (GuardDuty) and alerting feed the response process.',
    requires: ['threat-detection', 'monitoring-alerting'],
    quickFix:
      'Enable GuardDuty and route findings + alarms to an on-call recipient with a documented response runbook.',
  },
  {
    id: 'hipaa-164.308a1iiA-risk-analysis',
    framework: 'hipaa',
    ref: '§164.308(a)(1)(ii)(A)',
    title: 'Risk analysis (accurate & thorough)',
    category: 'Administrative Safeguards §164.308',
    intent:
      'Conduct an accurate and thorough assessment of risks/vulnerabilities to ePHI. This is the foundational HIPAA requirement and is the most commonly cited in enforcement.',
    requires: [],
    manual: true,
    quickFix:
      'Run and document a formal risk analysis covering all ePHI; keep it current. The 2025 NPRM proposes a required written risk analysis with a defined methodology.',
  },
  {
    id: 'hipaa-164.308b1-baa',
    framework: 'hipaa',
    ref: '§164.308(b)(1) / §164.314',
    title: 'Business Associate Agreements in place',
    category: 'Organizational Requirements §164.314',
    intent:
      'Have signed BAAs with every business associate that creates, receives, maintains, or transmits ePHI (e.g. your cloud and model providers).',
    requires: [],
    manual: true,
    quickFix:
      'Execute a BAA with AWS and with any model/data subprocessor handling ePHI; track expiry and scope.',
  },
  {
    id: 'hipaa-164.308a5-training',
    framework: 'hipaa',
    ref: '§164.308(a)(5)',
    title: 'Security awareness & workforce training',
    category: 'Administrative Safeguards §164.308',
    intent:
      'Provide a security awareness and training program for all workforce members, including periodic reminders and malware/login monitoring.',
    requires: [],
    manual: true,
    quickFix:
      'Deliver and log annual security training; retain completion records per workforce member.',
  },
  {
    id: 'hipaa-164.310-physical',
    framework: 'hipaa',
    ref: '§164.310',
    title: 'Physical safeguards (inherited from AWS)',
    category: 'Physical Safeguards §164.310',
    intent:
      'Control physical access to systems housing ePHI. For a cloud deployment these are largely inherited from AWS and covered by the AWS BAA + their SOC 2 report.',
    requires: [],
    manual: true,
    quickFix:
      'Reference the AWS BAA and AWS SOC 2/HIPAA attestation as inherited physical controls; document the shared-responsibility split.',
  },
];

export const CONTROL_CATALOG: ControlDef[] = [...SOC2_CONTROLS, ...HIPAA_CONTROLS];

export function controlById(id: string): ControlDef | undefined {
  return CONTROL_CATALOG.find((c) => c.id === id);
}

const FRAMEWORK_META: Record<
  ComplianceFrameworkId,
  { label: string; description: string }
> = {
  soc2: {
    label: 'SOC 2',
    description:
      'AICPA 2017 Trust Services Criteria (Security, Availability, Confidentiality). Each control is scored against live AWS posture.',
  },
  hipaa: {
    label: 'HIPAA',
    description:
      'HIPAA Security Rule (45 CFR Part 164, Subpart C) technical, administrative, and organizational safeguards for ePHI.',
  },
};

const DISCLAIMER =
  'Automated controls are scored from live AWS posture this deployment can read. Manual controls require human attestation and are excluded from the score. This view is decision support, not a certification or legal advice.';

// ── Grading ─────────────────────────────────────────────────────────

/** Map a single posture status onto a compliance verdict. */
function statusFromPosture(s: EvidenceCard['status']): ControlStatus {
  switch (s) {
    case 'ok':
      return 'met';
    case 'warn':
      return 'partial';
    case 'crit':
      return 'gap';
    default:
      return 'unknown';
  }
}

/**
 * Grade one control against the tagged evidence set. Manual controls are always
 * 'manual'. Automated controls aggregate their matched cards: any gap ⇒ gap,
 * else any partial ⇒ partial, else met; if no card has a definite (non-unknown)
 * verdict the control is 'unknown' (we do not guess "met" from missing data).
 */
export function evaluateControl(
  def: ControlDef,
  evidence: EvidenceCard[],
): EvaluatedControl {
  const matched = def.manual
    ? []
    : evidence.filter((card) => card.tags.some((t) => def.requires.includes(t)));

  let status: ControlStatus;
  if (def.manual) {
    status = 'manual';
  } else {
    const verdicts = matched.map((c) => statusFromPosture(c.status));
    const definite = verdicts.filter((v) => v !== 'unknown');
    if (definite.length === 0) status = 'unknown';
    else if (definite.includes('gap')) status = 'gap';
    else if (definite.includes('partial')) status = 'partial';
    else status = 'met';
  }

  return {
    id: def.id,
    framework: def.framework,
    ref: def.ref,
    title: def.title,
    category: def.category,
    intent: def.intent,
    quickFix: def.quickFix,
    manual: Boolean(def.manual),
    status,
    evidence: matched.map((c) => ({
      id: c.id,
      label: c.label,
      status: c.status,
      detail: c.detail,
      ...(c.value ? { value: c.value } : {}),
    })),
  };
}

const ZERO_COUNTS = (): Record<ControlStatus, number> => ({
  met: 0,
  partial: 0,
  gap: 0,
  unknown: 0,
  manual: 0,
});

const SCORE_WEIGHT: Partial<Record<ControlStatus, number>> = {
  met: 1,
  partial: 0.5,
  gap: 0,
};

function buildFramework(
  id: ComplianceFrameworkId,
  evidence: EvidenceCard[],
): FrameworkResult {
  const controls = CONTROL_CATALOG.filter((c) => c.framework === id).map((c) =>
    evaluateControl(c, evidence),
  );
  const counts = ZERO_COUNTS();
  for (const ctl of controls) counts[ctl.status] += 1;

  // Score over controls with a definite automated verdict only (met/partial/gap).
  // unknown + manual are excluded so the number reflects what we can verify.
  const graded = controls.filter((c) => c.status in SCORE_WEIGHT);
  const earned = graded.reduce((s, c) => s + (SCORE_WEIGHT[c.status] ?? 0), 0);
  const score = graded.length === 0 ? 0 : Math.round((earned / graded.length) * 100);

  return {
    id,
    label: FRAMEWORK_META[id].label,
    description: FRAMEWORK_META[id].description,
    score,
    gradedCount: graded.length,
    counts,
    controls,
  };
}

// The evidence domains the collector reads, in scan order, with friendly
// labels. The scanning visual animates this fixed list and fills each one in
// from the real per-domain tally below. Order roughly follows a "data → access
// → boundary → resilience → detection → record" narrative.
const AREA_META: Array<{ id: string; label: string }> = [
  { id: 'encryption', label: 'Encryption & keys' },
  { id: 'secrets', label: 'Secrets management' },
  { id: 'iam', label: 'IAM least-privilege' },
  { id: 'network', label: 'Network & WAF' },
  { id: 'backup', label: 'Backups & recovery' },
  { id: 'observability', label: 'Monitoring & tracing' },
  { id: 'audit', label: 'Audit trail' },
  { id: 'security', label: 'Security baseline' },
];

/** Tally the real evidence per domain (only domains that returned signals). */
function computeScanAreas(evidence: EvidenceCard[]): ScanArea[] {
  const areas: ScanArea[] = [];
  for (const meta of AREA_META) {
    const cards = evidence.filter((c) => c.area === meta.id);
    if (cards.length === 0) continue;
    areas.push({
      id: meta.id,
      label: meta.label,
      total: cards.length,
      ok: cards.filter((c) => c.status === 'ok').length,
      warn: cards.filter((c) => c.status === 'warn').length,
      crit: cards.filter((c) => c.status === 'crit').length,
      unknown: cards.filter((c) => c.status === 'unknown').length,
    });
  }
  return areas;
}

/** Assemble the full SOC 2 + HIPAA summary from a tagged evidence set. */
export function buildComplianceSummary(
  evidence: EvidenceCard[],
  generatedAt: string,
): ComplianceSummary {
  return {
    generatedAt,
    evidenceCount: evidence.length,
    disclaimer: DISCLAIMER,
    frameworks: [buildFramework('soc2', evidence), buildFramework('hipaa', evidence)],
    scan: { areas: computeScanAreas(evidence) },
  };
}
