import { describe, it, expect } from 'vitest';
import {
  CONTROL_CATALOG,
  controlById,
  evaluateControl,
  buildComplianceSummary,
  type ControlStatus,
} from './control-catalog.js';
import type { EvidenceCard } from './evidence.js';

function card(
  id: string,
  status: EvidenceCard['status'],
  tags: string[],
): EvidenceCard {
  return { id, label: id, status, detail: `${id} detail`, area: 'test', tags };
}

describe('evaluateControl', () => {
  const encryption = controlById('soc2-cc6.1-encryption')!; // requires encryption-at-rest, key-rotation

  it('is met when all matched evidence is ok', () => {
    const ev = [card('k1', 'ok', ['encryption-at-rest', 'key-rotation'])];
    expect(evaluateControl(encryption, ev).status).toBe<ControlStatus>('met');
  });

  it('is partial when a matched card is warn (and none critical)', () => {
    const ev = [
      card('k1', 'ok', ['encryption-at-rest']),
      card('k2', 'warn', ['key-rotation']),
    ];
    expect(evaluateControl(encryption, ev).status).toBe<ControlStatus>('partial');
  });

  it('is gap when any matched card is crit (gap dominates partial)', () => {
    const ev = [
      card('k1', 'warn', ['encryption-at-rest']),
      card('k2', 'crit', ['key-rotation']),
    ];
    expect(evaluateControl(encryption, ev).status).toBe<ControlStatus>('gap');
  });

  it('is unknown when there is no readable matched evidence', () => {
    expect(evaluateControl(encryption, []).status).toBe<ControlStatus>('unknown');
    const onlyUnknown = [card('k1', 'unknown', ['encryption-at-rest'])];
    expect(evaluateControl(encryption, onlyUnknown).status).toBe<ControlStatus>('unknown');
  });

  it('only matches evidence carrying a required tag', () => {
    const ev = [card('irrelevant', 'crit', ['threat-detection'])];
    const out = evaluateControl(encryption, ev);
    expect(out.status).toBe<ControlStatus>('unknown');
    expect(out.evidence).toHaveLength(0);
  });

  it('treats manual controls as manual regardless of evidence', () => {
    const manual = controlById('hipaa-164.308a1iiA-risk-analysis')!;
    expect(manual.manual).toBe(true);
    const out = evaluateControl(manual, [card('x', 'ok', ['encryption-at-rest'])]);
    expect(out.status).toBe<ControlStatus>('manual');
    expect(out.evidence).toHaveLength(0); // manual controls never attach auto-evidence
  });
});

describe('cross-domain tag isolation (merged_bug_011)', () => {
  // After splitting the shared 'availability' tag and trimming over-broad
  // tags, a crit signal in one domain must not flip an unrelated control.
  const monitoring = controlById('soc2-cc7.2-monitoring')!; // monitoring-alerting, service-uptime
  const contingency = controlById('hipaa-164.308a7-contingency')!; // backup-recovery
  const auditLogging = controlById('soc2-cc7.1-audit-logging')!; // audit-logging, activity-review

  it('a crit PITR (backup) does not gap the monitoring control', () => {
    // PITR is tagged backup-recovery only; monitoring requires
    // monitoring-alerting/service-uptime, so a crit PITR must not match it.
    const ev = [
      card('ddb-pitr', 'crit', ['backup-recovery']),
      card('obs-alarms', 'ok', ['monitoring-alerting']),
      card('obs-canary', 'ok', ['monitoring-alerting', 'service-uptime']),
    ];
    const out = evaluateControl(monitoring, ev);
    expect(out.status).toBe<ControlStatus>('met');
    expect(out.evidence.map((e) => e.id)).not.toContain('ddb-pitr');
  });

  it('a crit canary (uptime) does not gap the contingency control', () => {
    // The canary is tagged service-uptime, not availability/backup-recovery,
    // so a crit canary must not flip the backup/recovery contingency control.
    const ev = [
      card('obs-canary', 'crit', ['monitoring-alerting', 'service-uptime']),
      card('ddb-pitr', 'ok', ['backup-recovery']),
    ];
    const out = evaluateControl(contingency, ev);
    expect(out.status).toBe<ControlStatus>('met');
    expect(out.evidence.map((e) => e.id)).not.toContain('obs-canary');
  });

  it('a crit GuardDuty does not flip the monitoring control', () => {
    // GuardDuty is tagged threat-detection only; it must not also gap
    // soc2-cc7.2-monitoring (cc7.3 owns threat detection).
    const ev = [
      card('guardduty', 'crit', ['threat-detection']),
      card('obs-alarms', 'ok', ['monitoring-alerting']),
      card('obs-canary', 'ok', ['monitoring-alerting', 'service-uptime']),
    ];
    const out = evaluateControl(monitoring, ev);
    expect(out.status).toBe<ControlStatus>('met');
    expect(out.evidence.map((e) => e.id)).not.toContain('guardduty');
  });

  it('audit-logging grades unknown (not met) with only unknown CloudTrail evidence', () => {
    // The two ok S3 audit-bucket cards no longer carry 'audit-logging', so
    // when CloudTrail describe is denied (unknown), audit-logging has no
    // definite signal and must NOT grade met from bucket config alone.
    const ev = [
      card('s3-audit-encrypted', 'ok', ['encryption-at-rest']),
      card('s3-audit-object-lock', 'ok', ['audit-immutability']),
      card('posture.cloudtrail.enabled', 'unknown', ['audit-logging', 'activity-review']),
    ];
    const out = evaluateControl(auditLogging, ev);
    expect(out.status).toBe<ControlStatus>('unknown');
  });
});

describe('buildComplianceSummary', () => {
  it('returns soc2 + hipaa frameworks with consistent counts and bounded scores', () => {
    const evidence: EvidenceCard[] = [
      card('kms', 'ok', ['encryption-at-rest', 'key-rotation']),
      card('iam', 'warn', ['access-control-iam']),
      card('gd', 'crit', ['threat-detection']),
    ];
    const summary = buildComplianceSummary(evidence, '2026-06-05T00:00:00.000Z');

    expect(summary.frameworks.map((f) => f.id)).toEqual(['soc2', 'hipaa']);
    expect(summary.evidenceCount).toBe(3);
    expect(summary.disclaimer).toMatch(/attestation/i);
    expect(Array.isArray(summary.scan.areas)).toBe(true);

    for (const fw of summary.frameworks) {
      const catalogCount = CONTROL_CATALOG.filter((c) => c.framework === fw.id).length;
      const summed =
        fw.counts.met + fw.counts.partial + fw.counts.gap + fw.counts.unknown + fw.counts.manual;
      expect(summed).toBe(catalogCount);
      expect(fw.controls).toHaveLength(catalogCount);
      expect(fw.score).toBeGreaterThanOrEqual(0);
      expect(fw.score).toBeLessThanOrEqual(100);
      // gradedCount excludes unknown + manual.
      expect(fw.gradedCount).toBe(fw.counts.met + fw.counts.partial + fw.counts.gap);
    }
  });

  it('scores manual + unknown controls out of the denominator (not as passes)', () => {
    // No evidence: every automated control is unknown, every manual control is
    // manual, so nothing is graded and the score is 0 (not 100).
    const summary = buildComplianceSummary([], '2026-06-05T00:00:00.000Z');
    for (const fw of summary.frameworks) {
      expect(fw.counts.met).toBe(0);
      expect(fw.gradedCount).toBe(0);
      expect(fw.score).toBe(0);
      expect(fw.counts.manual).toBeGreaterThan(0); // both frameworks have manual controls
    }
  });
});
