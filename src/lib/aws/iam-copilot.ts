/**
 * IAM copilot — draft/edit IAM policies from plain English, validate them with
 * AWS IAM Access Analyzer, and (when explicitly enabled) apply them with hard
 * guardrails.
 *
 * SAFETY MODEL (this is IAM — the guardrails are the feature):
 *   - draftPolicy: Bedrock (Sonnet) authors/edits the policy JSON. Read-only.
 *   - validatePolicy: Access Analyzer returns real findings on the draft.
 *   - applyIam: actually writes to IAM, but ONLY behind every one of:
 *       * admin role (enforced in the router),
 *       * runtime-config iam/apply_enabled === 'true' (kill switch, default off),
 *       * an explicit confirm from the caller,
 *       * assertApplySafe(): refuses to touch the orchestrator's OWN role
 *         (no self-escalation / lockout) and refuses account-wide or
 *         IAM-admin grants unless allowDangerous is set by the admin.
 *     Every apply is audited by the router.
 */

import {
  IAMClient,
  CreatePolicyCommand,
  PutRolePolicyCommand,
  AttachRolePolicyCommand,
  CreateUserCommand,
  PutUserPolicyCommand,
  AttachUserPolicyCommand,
  GetPolicyCommand,
  GetPolicyVersionCommand,
} from '@aws-sdk/client-iam';
import {
  AccessAnalyzerClient,
  ValidatePolicyCommand,
} from '@aws-sdk/client-accessanalyzer';
import { converseTurn } from '../bedrock/client.js';
import { logger } from '../../observability/logger.js';

const MODEL =
  process.env.BEDROCK_IAM_MODEL ??
  process.env.BEDROCK_SONNET_MODEL ??
  'us.anthropic.claude-sonnet-4-6';

// Names we must never let the copilot modify (defense in depth; the code path
// also blocks these). The orchestrator's own task role + the CDK role family.
const PROTECTED_NAME_PATTERNS = [
  process.env.CCE_TASK_ROLE_NAME ?? '',
  'CCE-Iam-TaskRole',
  'cdk-hnb659fds',
].filter(Boolean);

let _iam: IAMClient | null = null;
let _aa: AccessAnalyzerClient | null = null;
function iam(): IAMClient {
  if (!_iam) _iam = new IAMClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  return _iam;
}
function accessAnalyzer(): AccessAnalyzerClient {
  if (!_aa) _aa = new AccessAnalyzerClient({ region: process.env.AWS_REGION ?? 'us-east-1' });
  return _aa;
}

export interface DraftResult {
  policyDocument: string; // pretty-printed JSON
  explanation: string;
  warnings: string[];
}
export interface ValidationFinding {
  type: string; // ERROR | SECURITY_WARNING | SUGGESTION | WARNING
  code: string;
  message: string;
}

const DRAFT_SYSTEM = `You are an expert AWS IAM policy author. You write tightly-scoped, least-privilege IAM identity policies.

Output STRICT JSON and nothing else (no markdown, no code fences), exactly:
{"policyDocument": <the IAM policy as a JSON object, version "2012-10-17">, "explanation": "<2-4 plain-English sentences explaining what it allows>", "warnings": ["<each risk or broad grant>", ...]}

Rules:
- The policy's top-level key MUST be "Statement" (singular), never "Statements", and MUST include "Version":"2012-10-17".
- Prefer specific actions and specific resource ARNs. Never use "Action":"*" or "Resource":"*" unless the user explicitly demands it; if you must, add a clear entry to "warnings".
- Never silently grant privilege-escalation actions (iam:*, iam:PutRolePolicy, iam:AttachRolePolicy, iam:CreatePolicyVersion, sts:AssumeRole on "*"); if requested, include them but warn loudly.
- When editing an existing policy, return the COMPLETE edited policy, preserving unrelated statements.
- Keep it valid IAM JSON that AWS will accept.`;

/**
 * Fix the common model slips so the output is always a valid IAM policy:
 *   - "Statements" (plural) -> "Statement" (IAM requires singular)
 *   - missing "Version" -> "2012-10-17"
 */
function normalizePolicy(p: unknown): Record<string, unknown> {
  const obj = p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
  if (obj.Statements && !obj.Statement) {
    obj.Statement = obj.Statements;
    delete obj.Statements;
  }
  if (!obj.Version) obj.Version = '2012-10-17';
  return obj;
}

function extractJson(text: string): Record<string, unknown> {
  const t = text
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  try {
    return JSON.parse(t) as Record<string, unknown>;
  } catch {
    const m = t.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]) as Record<string, unknown>;
      } catch {
        /* fall through */
      }
    }
    throw new Error('model did not return valid JSON');
  }
}

export async function draftPolicy(input: {
  instruction: string;
  existingPolicy?: string;
}): Promise<DraftResult> {
  const instruction = (input.instruction ?? '').slice(0, 4000);
  const existing = input.existingPolicy?.slice(0, 8000);
  const userText = existing
    ? `Edit this IAM policy per the instruction. Return the full edited policy.\n\nInstruction: ${instruction}\n\nExisting policy:\n${existing}`
    : `Write an IAM identity policy for this request.\n\nInstruction: ${instruction}`;

  const out = await converseTurn({
    modelId: MODEL,
    systemPrompt: DRAFT_SYSTEM,
    userText,
    maxTokens: 1800,
    temperature: 0,
  });

  const parsed = extractJson(out.text ?? '');
  const rawDoc = parsed.policyDocument;
  let obj: unknown;
  try {
    obj = typeof rawDoc === 'string' ? JSON.parse(rawDoc) : (rawDoc ?? {});
  } catch {
    throw new Error('drafted policy was not valid JSON');
  }
  const doc = JSON.stringify(normalizePolicy(obj), null, 2);
  const warnings = Array.isArray(parsed.warnings) ? parsed.warnings.map((w) => String(w)) : [];
  // Always run our own danger lint on top of the model's self-reported warnings.
  for (const w of lintPolicy(doc)) if (!warnings.includes(w)) warnings.push(w);

  return {
    policyDocument: doc,
    explanation: String(parsed.explanation ?? ''),
    warnings,
  };
}

export async function validatePolicy(policyDocument: string): Promise<ValidationFinding[]> {
  try {
    const out = await accessAnalyzer().send(
      new ValidatePolicyCommand({ policyType: 'IDENTITY_POLICY', policyDocument }),
    );
    return (out.findings ?? []).map((f) => ({
      type: f.findingType ?? 'INFO',
      code: f.issueCode ?? '',
      message: f.findingDetails ?? '',
    }));
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'iam-copilot: Access Analyzer validation failed',
    );
    return [];
  }
}

/** Static least-privilege lint. Returns human-readable risk strings. */
export function lintPolicy(policyDocument: string): string[] {
  const out: string[] = [];
  let p: { Statement?: unknown };
  try {
    p = JSON.parse(policyDocument);
  } catch {
    return ['Policy is not valid JSON.'];
  }
  const stmts = Array.isArray(p.Statement) ? p.Statement : p.Statement ? [p.Statement] : [];
  for (const s of stmts as Array<Record<string, unknown>>) {
    if (!s || s.Effect !== 'Allow') continue;
    const actions = ([] as string[]).concat((s.Action as string | string[]) ?? []);
    const resources = ([] as string[]).concat((s.Resource as string | string[]) ?? []);
    const resStar = resources.includes('*');
    if (actions.includes('*') && resStar) out.push('Grants full admin (Action "*" on Resource "*").');
    const iamWrite = actions.some((a) => /^iam:\*$|^iam:(Create|Attach|Put|Update|Delete|Add)/i.test(a));
    if (iamWrite && resStar) out.push('Grants IAM write on all resources (privilege-escalation risk).');
    if (actions.includes('iam:PassRole') && resStar) out.push('Allows iam:PassRole on "*" (privilege-escalation risk).');
    if (actions.some((a) => a === 'sts:AssumeRole') && resStar) out.push('Allows assuming any role (sts:AssumeRole on "*").');
    if (s.NotAction) out.push('Uses NotAction, which is often broader than intended.');
  }
  return out;
}

/** True if the policy grants account-wide or IAM-admin power. */
export function isDangerousPolicy(policyDocument: string): boolean {
  const findings = lintPolicy(policyDocument);
  return findings.some(
    (f) =>
      f.startsWith('Grants full admin') ||
      f.startsWith('Grants IAM write') ||
      f.startsWith('Allows iam:PassRole') ||
      f === 'Policy is not valid JSON.',
  );
}

function assertTargetSafe(name: string | undefined): void {
  if (!name) return;
  for (const pat of PROTECTED_NAME_PATTERNS) {
    if (name === pat || name.includes(pat)) {
      throw new Error(`refusing to modify protected principal "${name}" (orchestrator/CDK role)`);
    }
  }
}

// Well-known AWS-managed policies that confer account-wide or IAM-admin power.
// Attaching any of these is the one-step escalation the inline-policy lint never
// saw, because attach takes an ARN, not a document.
const DANGEROUS_AWS_MANAGED_ARNS = new Set([
  'arn:aws:iam::aws:policy/AdministratorAccess',
  'arn:aws:iam::aws:policy/IAMFullAccess',
  'arn:aws:iam::aws:policy/PowerUserAccess',
]);
const DANGEROUS_MANAGED_NAME_RE = /(administratoraccess|iamfullaccess|poweruseraccess)/i;
const POLICY_ARN_RE = /^arn:aws[a-z-]*:iam::(aws|\d{12}):policy\/.+/;

/** True if `arn` is a syntactically valid IAM managed-policy ARN. */
export function isWellFormedPolicyArn(arn: string | undefined): arn is string {
  return typeof arn === 'string' && POLICY_ARN_RE.test(arn);
}

/** True if `arn` names a known account-admin / IAM-admin managed policy. */
export function isKnownDangerousPolicyArn(arn: string): boolean {
  return DANGEROUS_AWS_MANAGED_ARNS.has(arn) || DANGEROUS_MANAGED_NAME_RE.test(arn);
}

/** True for AWS-managed ARNs (arn:aws:iam::aws:policy/...). */
function isAwsManagedArn(arn: string): boolean {
  return arn.startsWith('arn:aws:iam::aws:policy/');
}

/** Fetch the default version of a managed policy as a JSON string (URL-decoded). */
async function fetchManagedPolicyDocument(arn: string): Promise<string> {
  const c = iam();
  const pol = await c.send(new GetPolicyCommand({ PolicyArn: arn }));
  const ver = pol.Policy?.DefaultVersionId;
  if (!ver) throw new Error('policy has no default version');
  const out = await c.send(new GetPolicyVersionCommand({ PolicyArn: arn, VersionId: ver }));
  const encoded = out.PolicyVersion?.Document;
  if (!encoded) throw new Error('policy version has no document');
  // IAM returns the document URL-encoded.
  return decodeURIComponent(encoded);
}

/**
 * Guard the attach_*_policy paths the inline lint never covered. Attaching a
 * managed-policy ARN is the most common IAM grant, and `AdministratorAccess`
 * (or any IAM-admin policy) is one attach away from standing account-admin.
 * Fails CLOSED: a malformed ARN, a known-dangerous managed policy, or a
 * customer-managed policy we cannot read+verify is refused unless the admin
 * sets allowDangerous (which the router audits).
 */
async function assertPolicyArnSafe(
  arn: string | undefined,
  allowDangerous: boolean | undefined,
): Promise<void> {
  if (!isWellFormedPolicyArn(arn)) {
    throw new Error(`refusing to attach malformed or missing policy ARN "${arn ?? ''}"`);
  }
  if (allowDangerous) return; // explicit, audited admin override
  if (isKnownDangerousPolicyArn(arn)) {
    throw new Error(
      `refusing to attach "${arn}": grants account-wide or IAM-admin access; re-submit with allowDangerous=true to override`,
    );
  }
  // AWS-managed policies other than the known-dangerous set are allowed; for
  // customer-managed policies, read the document and lint it. Fail closed.
  if (!isAwsManagedArn(arn)) {
    let doc: string;
    try {
      doc = await fetchManagedPolicyDocument(arn);
    } catch (err) {
      throw new Error(
        `refusing to attach "${arn}": could not read the policy to verify it is safe (${err instanceof Error ? err.message : String(err)}); re-submit with allowDangerous=true to override`,
      );
    }
    if (isDangerousPolicy(doc)) {
      throw new Error(
        `refusing to attach "${arn}": policy grants account-wide or IAM-admin access; re-submit with allowDangerous=true to override`,
      );
    }
  }
}

export type ApplyAction =
  | 'create_policy'
  | 'put_role_policy'
  | 'attach_role_policy'
  | 'create_user'
  | 'put_user_policy'
  | 'attach_user_policy';

export interface ApplyRequest {
  action: ApplyAction;
  roleName?: string;
  userName?: string;
  policyName?: string;
  policyArn?: string;
  policyDocument?: string;
  allowDangerous?: boolean;
}

export interface ApplyResult {
  ok: true;
  detail: string;
  arn?: string;
}

export async function applyIam(req: ApplyRequest): Promise<ApplyResult> {
  assertTargetSafe(req.roleName);
  assertTargetSafe(req.userName);

  if (req.policyDocument && isDangerousPolicy(req.policyDocument) && !req.allowDangerous) {
    throw new Error(
      'policy grants account-wide or IAM-admin access; re-submit with allowDangerous=true to override',
    );
  }

  const c = iam();
  switch (req.action) {
    case 'create_policy': {
      const out = await c.send(
        new CreatePolicyCommand({ PolicyName: req.policyName, PolicyDocument: req.policyDocument }),
      );
      return { ok: true, detail: `Created managed policy ${req.policyName}`, arn: out.Policy?.Arn };
    }
    case 'put_role_policy':
      await c.send(
        new PutRolePolicyCommand({
          RoleName: req.roleName,
          PolicyName: req.policyName,
          PolicyDocument: req.policyDocument,
        }),
      );
      return { ok: true, detail: `Put inline policy ${req.policyName} on role ${req.roleName}` };
    case 'attach_role_policy':
      await assertPolicyArnSafe(req.policyArn, req.allowDangerous);
      await c.send(new AttachRolePolicyCommand({ RoleName: req.roleName, PolicyArn: req.policyArn }));
      return { ok: true, detail: `Attached ${req.policyArn} to role ${req.roleName}` };
    case 'create_user':
      await c.send(new CreateUserCommand({ UserName: req.userName }));
      return { ok: true, detail: `Created user ${req.userName}` };
    case 'put_user_policy':
      await c.send(
        new PutUserPolicyCommand({
          UserName: req.userName,
          PolicyName: req.policyName,
          PolicyDocument: req.policyDocument,
        }),
      );
      return { ok: true, detail: `Put inline policy ${req.policyName} on user ${req.userName}` };
    case 'attach_user_policy':
      await assertPolicyArnSafe(req.policyArn, req.allowDangerous);
      await c.send(new AttachUserPolicyCommand({ UserName: req.userName, PolicyArn: req.policyArn }));
      return { ok: true, detail: `Attached ${req.policyArn} to user ${req.userName}` };
    default:
      throw new Error(`unknown apply action: ${String((req as ApplyRequest).action)}`);
  }
}
