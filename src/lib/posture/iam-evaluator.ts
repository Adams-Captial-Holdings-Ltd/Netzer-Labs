/**
 * IAM posture evaluator (Tier B, pure + deterministic).
 *
 * Given the policy documents gathered by iam-reader.ts, produce a set of
 * findings and a single least-privilege grade. This module performs NO IO:
 * every function is a pure transform over plain objects, which makes it fully
 * unit-testable without AWS (see iam-evaluator.test.ts).
 *
 * What we flag (least-privilege heuristics over Allow statements):
 *   - Action '*'                     -> full admin on the matched resources.
 *   - Action 'service:*'             -> service-wide wildcard.
 *   - Resource '*' on a sensitive    -> broad blast radius on iam / kms /
 *     service                           secretsmanager / s3 / sts.
 *   - NotAction with Effect Allow    -> allow-all-except, an easy footgun.
 *
 * Grade scale (worst finding wins):
 *   - 'A' clean: no broad Allow statements found.
 *   - 'B' minor: only narrow service wildcards (service:* on a scoped ARN).
 *   - 'C' broad: Resource '*' on a sensitive service, or NotAction allow.
 *   - 'F' critical: Action '*' (full admin) anywhere.
 *   - 'unknown': nothing could be read (role undiscovered / all denied).
 */

import type { IamPosture, PolicyDocument, PolicyStatement } from './iam-reader.js';

/** Uniform card shape shared by all four posture routers. */
export interface PostureCard {
  id: string;
  label: string;
  status: 'ok' | 'warn' | 'crit' | 'unknown';
  detail: string;
  value?: string;
}

export type IamGrade = 'A' | 'B' | 'C' | 'F' | 'unknown';

/** A single least-privilege finding extracted from one statement. */
export interface IamFinding {
  /** Stable kind used for the card id + grade mapping. */
  kind: 'admin-star' | 'service-wildcard' | 'sensitive-resource-star' | 'notaction-allow';
  severity: 'warn' | 'crit';
  /** Which policy the statement lived in. */
  policyName: string;
  source: 'inline' | 'managed';
  /** Statement Sid when present, else a synthetic index label. */
  sid: string;
  detail: string;
}

export interface IamEvaluation {
  grade: IamGrade;
  findings: IamFinding[];
  cards: PostureCard[];
}

/**
 * Services where a Resource:'*' grant is materially dangerous. A wildcard
 * resource on, say, cloudwatch:PutMetricData is mundane; on iam or kms it is
 * a privilege-escalation / data-exfil risk.
 */
const SENSITIVE_SERVICES = new Set([
  'iam',
  'kms',
  'secretsmanager',
  'sts',
  's3',
  'dynamodb',
]);

function toArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function statements(doc: PolicyDocument | null): PolicyStatement[] {
  if (!doc || !doc.Statement) return [];
  return Array.isArray(doc.Statement) ? doc.Statement : [doc.Statement];
}

/** service prefix from an action like "s3:GetObject" -> "s3". */
function serviceOf(action: string): string | null {
  const idx = action.indexOf(':');
  if (idx <= 0) return null;
  return action.slice(0, idx).toLowerCase();
}

/**
 * Evaluate a single Allow statement, pushing any findings. Deny statements
 * and statements without Effect:'Allow' are ignored, since they only ever
 * tighten access.
 */
function evalStatement(
  st: PolicyStatement,
  policyName: string,
  source: 'inline' | 'managed',
  index: number,
  out: IamFinding[],
): void {
  if ((st.Effect ?? 'Allow') !== 'Allow') return;

  const sid = st.Sid ?? `#${index}`;
  const actions = toArray(st.Action);
  const resources = toArray(st.Resource);
  const resourceStar = resources.includes('*');

  // NotAction + Allow is an allow-all-except pattern; flag regardless of
  // resource since it is almost never intentional least-privilege.
  if (st.NotAction !== undefined) {
    out.push({
      kind: 'notaction-allow',
      severity: 'crit',
      policyName,
      source,
      sid,
      detail: `Allow with NotAction in "${policyName}" (${sid}) grants all-actions-except, hard to reason about.`,
    });
  }

  for (const action of actions) {
    if (action === '*') {
      out.push({
        kind: 'admin-star',
        severity: 'crit',
        policyName,
        source,
        sid,
        detail: `Action "*" in "${policyName}" (${sid}) grants full admin${resourceStar ? ' on Resource "*"' : ''}.`,
      });
      continue;
    }

    // service:* style wildcard.
    if (action.endsWith(':*')) {
      const svc = serviceOf(action);
      if (resourceStar && svc && SENSITIVE_SERVICES.has(svc)) {
        out.push({
          kind: 'sensitive-resource-star',
          severity: 'crit',
          policyName,
          source,
          sid,
          detail: `Action "${action}" with Resource "*" in "${policyName}" (${sid}) is broad on sensitive service "${svc}".`,
        });
      } else {
        out.push({
          kind: 'service-wildcard',
          severity: 'warn',
          policyName,
          source,
          sid,
          detail: `Action "${action}" in "${policyName}" (${sid}) is a service-wide wildcard.`,
        });
      }
      continue;
    }

    // Specific action but wide-open resource on a sensitive service.
    if (resourceStar) {
      const svc = serviceOf(action);
      if (svc && SENSITIVE_SERVICES.has(svc)) {
        out.push({
          kind: 'sensitive-resource-star',
          severity: 'warn',
          policyName,
          source,
          sid,
          detail: `Action "${action}" with Resource "*" in "${policyName}" (${sid}) on sensitive service "${svc}".`,
        });
      }
    }
  }
}

/** Map the worst finding severity/kind to a grade. */
function gradeFor(findings: IamFinding[]): IamGrade {
  if (findings.some((f) => f.kind === 'admin-star')) return 'F';
  if (
    findings.some(
      (f) =>
        (f.kind === 'sensitive-resource-star' && f.severity === 'crit') ||
        f.kind === 'notaction-allow',
    )
  ) {
    return 'C';
  }
  if (findings.some((f) => f.kind === 'sensitive-resource-star')) return 'C';
  if (findings.some((f) => f.kind === 'service-wildcard')) return 'B';
  return 'A';
}

const GRADE_STATUS: Record<Exclude<IamGrade, 'unknown'>, PostureCard['status']> = {
  A: 'ok',
  B: 'warn',
  C: 'warn',
  F: 'crit',
};

/**
 * Pure evaluation entry point. Deterministic for a given posture input.
 *
 * Returns at least two cards:
 *   - iam-role-discovered: did we resolve + read the task role at all.
 *   - iam-least-privilege: the overall grade.
 * Plus one card per distinct finding kind that fired.
 */
export function evaluateIamPosture(posture: IamPosture): IamEvaluation {
  // Could not read anything meaningful -> honest 'unknown', never a false OK.
  if (!posture.roleName || (!posture.roleFound && posture.policies.length === 0)) {
    const detail = !posture.roleName
      ? 'Task role could not be discovered (no STS identity / role env). Posture unknown.'
      : 'Task role found but no policies could be read (describe denied). Posture unknown.';
    return {
      grade: 'unknown',
      findings: [],
      cards: [
        {
          id: 'iam-role-discovered',
          label: 'Task role discovery',
          status: 'unknown',
          detail,
          value: posture.roleName ?? 'unknown',
        },
        {
          id: 'iam-least-privilege',
          label: 'Least-privilege grade',
          status: 'unknown',
          detail: 'Insufficient IAM read access to grade least privilege.',
          value: 'unknown',
        },
      ],
    };
  }

  const findings: IamFinding[] = [];
  for (const p of posture.policies) {
    const sts = statements(p.document);
    sts.forEach((st, i) => evalStatement(st, p.name, p.source, i, findings));
  }

  const grade = gradeFor(findings);
  const cards: PostureCard[] = [];

  // Discovery / read-coverage card.
  const partialRead = posture.errors.length > 0;
  cards.push({
    id: 'iam-role-discovered',
    label: 'Task role discovery',
    status: partialRead ? 'warn' : 'ok',
    detail: partialRead
      ? `Read task role "${posture.roleName}" with partial coverage; some describe calls were denied (${posture.errors.join(', ')}).`
      : `Read task role "${posture.roleName}": ${posture.policies.length} policy document(s) evaluated.`,
    value: posture.roleName,
  });

  // Overall grade card.
  cards.push({
    id: 'iam-least-privilege',
    label: 'Least-privilege grade',
    status: GRADE_STATUS[grade as Exclude<IamGrade, 'unknown'>],
    detail:
      findings.length === 0
        ? 'No broad Allow statements found on the task role.'
        : `${findings.length} least-privilege finding(s); worst grade ${grade}.`,
    value: grade,
  });

  // One card per finding kind that fired (deterministic order).
  const KIND_ORDER: IamFinding['kind'][] = [
    'admin-star',
    'sensitive-resource-star',
    'notaction-allow',
    'service-wildcard',
  ];
  const KIND_LABEL: Record<IamFinding['kind'], string> = {
    'admin-star': 'Full-admin wildcard',
    'sensitive-resource-star': 'Broad grant on sensitive service',
    'notaction-allow': 'Allow with NotAction',
    'service-wildcard': 'Service-wide wildcard',
  };
  for (const kind of KIND_ORDER) {
    const hits = findings.filter((f) => f.kind === kind);
    if (hits.length === 0) continue;
    const worst = hits.some((h) => h.severity === 'crit') ? 'crit' : 'warn';
    cards.push({
      id: `iam-finding-${kind}`,
      label: KIND_LABEL[kind],
      status: worst,
      detail: hits.map((h) => h.detail).join(' '),
      value: String(hits.length),
    });
  }

  return { grade, findings, cards };
}
