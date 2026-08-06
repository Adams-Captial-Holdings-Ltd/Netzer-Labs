import { describe, it, expect } from 'vitest';
import { evaluateIamPosture } from './iam-evaluator.js';
import type { IamPosture, PolicyDocument } from './iam-reader.js';

/** Build a posture fixture from raw policy docs (no AWS calls anywhere). */
function postureWith(docs: { name: string; document: PolicyDocument }[]): IamPosture {
  return {
    roleName: 'claudeclaw-task-role',
    roleFound: true,
    policies: docs.map((d) => ({ name: d.name, source: 'inline' as const, document: d.document })),
    errors: [],
  };
}

describe('evaluateIamPosture', () => {
  it('grades a clean, scoped policy as A with no findings', () => {
    const doc: PolicyDocument = {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'BedrockInvoke',
          Effect: 'Allow',
          Action: ['bedrock:InvokeModel', 'bedrock:Converse'],
          Resource: ['arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-*'],
        },
        {
          Sid: 'DdbScoped',
          Effect: 'Allow',
          Action: 'dynamodb:GetItem',
          Resource: 'arn:aws:dynamodb:us-east-1:123:table/claudeclaw-sessions',
        },
      ],
    };
    const result = evaluateIamPosture(postureWith([{ name: 'app', document: doc }]));
    expect(result.grade).toBe('A');
    expect(result.findings).toHaveLength(0);
    const gradeCard = result.cards.find((c) => c.id === 'iam-least-privilege');
    expect(gradeCard?.status).toBe('ok');
    expect(gradeCard?.value).toBe('A');
  });

  it('flags Action:"*" as a critical full-admin finding and grades F', () => {
    const doc: PolicyDocument = {
      Version: '2012-10-17',
      Statement: { Sid: 'GodMode', Effect: 'Allow', Action: '*', Resource: '*' },
    };
    const result = evaluateIamPosture(postureWith([{ name: 'broad', document: doc }]));
    expect(result.grade).toBe('F');
    expect(result.findings.some((f) => f.kind === 'admin-star')).toBe(true);
    const card = result.cards.find((c) => c.id === 'iam-finding-admin-star');
    expect(card?.status).toBe('crit');
  });

  it('flags service:* on a sensitive service with Resource:* as crit and grades C', () => {
    const doc: PolicyDocument = {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Action: 'iam:*', Resource: '*' }],
    };
    const result = evaluateIamPosture(postureWith([{ name: 'iamwide', document: doc }]));
    expect(result.grade).toBe('C');
    expect(result.findings.some((f) => f.kind === 'sensitive-resource-star')).toBe(true);
  });

  it('treats a narrow service wildcard (scoped resource) as a B warn only', () => {
    const doc: PolicyDocument = {
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: 'logs:*',
          Resource: 'arn:aws:logs:us-east-1:123:log-group:/claudeclaw/*',
        },
      ],
    };
    const result = evaluateIamPosture(postureWith([{ name: 'logs', document: doc }]));
    expect(result.grade).toBe('B');
    expect(result.findings.every((f) => f.kind === 'service-wildcard')).toBe(true);
  });

  it('flags NotAction + Allow as critical', () => {
    const doc: PolicyDocument = {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', NotAction: 'iam:DeleteUser', Resource: '*' }],
    };
    const result = evaluateIamPosture(postureWith([{ name: 'notaction', document: doc }]));
    expect(result.grade).toBe('C');
    expect(result.findings.some((f) => f.kind === 'notaction-allow')).toBe(true);
  });

  it('ignores Deny statements (they only tighten access)', () => {
    const doc: PolicyDocument = {
      Version: '2012-10-17',
      Statement: [{ Effect: 'Deny', Action: '*', Resource: '*' }],
    };
    const result = evaluateIamPosture(postureWith([{ name: 'deny', document: doc }]));
    expect(result.grade).toBe('A');
    expect(result.findings).toHaveLength(0);
  });

  it('returns unknown when the role could not be discovered', () => {
    const posture: IamPosture = {
      roleName: null,
      roleFound: false,
      policies: [],
      errors: ['role-undiscovered'],
    };
    const result = evaluateIamPosture(posture);
    expect(result.grade).toBe('unknown');
    expect(result.cards.every((c) => c.status === 'unknown')).toBe(true);
    expect(result.cards.find((c) => c.id === 'iam-least-privilege')?.value).toBe('unknown');
  });

  it('returns unknown when the role is named but every describe was denied', () => {
    const posture: IamPosture = {
      roleName: 'claudeclaw-task-role',
      roleFound: false,
      policies: [],
      errors: ['get-role-denied', 'list-inline-denied', 'list-managed-denied'],
    };
    const result = evaluateIamPosture(posture);
    expect(result.grade).toBe('unknown');
  });

  it('marks discovery card as warn when read coverage was partial', () => {
    const posture = postureWith([
      {
        name: 'app',
        document: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: 'arn:aws:s3:::b/*' }] },
      },
    ]);
    posture.errors = ['managed:SomePolicy'];
    const result = evaluateIamPosture(posture);
    const discovery = result.cards.find((c) => c.id === 'iam-role-discovered');
    expect(discovery?.status).toBe('warn');
    expect(result.grade).toBe('A');
  });
});
