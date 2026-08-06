/**
 * Compliance analyst — a READ-ONLY Bedrock explainer.
 *
 * Given one catalog control and its current live evidence, it asks the model to
 * (a) state what the standard requires under its LATEST edition, (b) assess this
 * deployment against that requirement using the supplied evidence, and (c) give
 * concrete remediation. This is the "look up the latest guidance" surface: it
 * grounds the answer in the evidence we just read and the controlling clause, so
 * the user gets current, specific direction rather than a generic checklist.
 *
 * It never mutates anything and never sees a secret value — it receives only the
 * posture card labels/status/detail the dashboard already shows.
 */

import { converseTurn } from '../bedrock/client.js';
import type { ControlDef, EvaluatedControl, ComplianceFrameworkId } from './control-catalog.js';

const MODEL =
  process.env.BEDROCK_COMPLIANCE_MODEL ??
  process.env.BEDROCK_SONNET_MODEL ??
  process.env.BEDROCK_DEFAULT_MODEL ??
  'us.anthropic.claude-sonnet-4-6';

export interface ControlAnalysis {
  controlId: string;
  framework: ComplianceFrameworkId;
  ref: string;
  title: string;
  /** Which edition/version of the standard the answer reflects. */
  edition: string;
  /** What the standard requires, latest edition. */
  requirement: string;
  /** Assessment of THIS deployment against the requirement, from the evidence. */
  currentState: string;
  /** Specific gaps that remain. */
  gaps: string[];
  /** Concrete, ordered remediation steps. */
  remediation: string[];
  /** Controlling clauses / official sources cited. */
  references: string[];
  modelId: string;
}

const SYSTEM = `You are a senior compliance auditor specializing in SOC 2 (AICPA Trust Services Criteria) and the HIPAA Security Rule. You advise an engineering team running an AWS-hosted multi-tenant AI agent platform.

Reflect the LATEST published editions:
- SOC 2: the AICPA 2017 Trust Services Criteria including the 2022 revised points of focus.
- HIPAA: the Security Rule (45 CFR Part 164, Subpart C) as amended by HITECH, and call out the January 2025 HHS Notice of Proposed Rulemaking (NPRM) where it would materially change the control (e.g. making encryption and a written risk analysis required rather than addressable, a 72-hour data-restoration target, mandatory MFA).

You are given ONE control, its mapped LIVE evidence from the deployment (posture cards with a status of ok/warn/crit/unknown), and the current automated verdict. Ground your assessment in that evidence: cite the specific cards. Be explicit about what is technically verified versus what still needs human attestation (policies, BAAs, training, risk analysis).

Output STRICT JSON and nothing else (no markdown, no code fences), exactly:
{"edition":"<which edition/version you are reflecting>","requirement":"<2-4 sentences: what the standard requires>","currentState":"<2-4 sentences assessing THIS deployment from the evidence>","gaps":["<each remaining gap>"],"remediation":["<each concrete, ordered step>"],"references":["<controlling clause or official source>"]}

Rules:
- Be specific and actionable; name AWS services/controls where relevant.
- If the evidence shows the control is met, say so plainly and list hardening/monitoring follow-ups rather than inventing gaps.
- Never claim certification. This is decision support, not legal advice. Do not output that disclaimer in the JSON; the UI shows it.`;

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

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x)).filter((s) => s.trim().length > 0);
}

function evidenceBlock(evaluated: EvaluatedControl): string {
  if (evaluated.evidence.length === 0) {
    return evaluated.manual
      ? '(No automated evidence — this is a process/attestation control the platform cannot machine-verify.)'
      : '(No readable evidence was found for this control.)';
  }
  return evaluated.evidence
    .map((e) => `- [${e.status.toUpperCase()}] ${e.label}: ${e.detail}${e.value ? ` (${e.value})` : ''}`)
    .join('\n');
}

/**
 * Analyze one control against its current evidence. Throws on a model/parse
 * failure so the router can surface a clean 502; callers should not retry
 * blindly (the model call is the expensive part).
 */
export async function analyzeControl(
  def: ControlDef,
  evaluated: EvaluatedControl,
): Promise<ControlAnalysis> {
  const userText = [
    `Framework: ${def.framework.toUpperCase()}`,
    `Control: ${def.ref} — ${def.title}`,
    `Category: ${def.category}`,
    `Requirement intent (our catalog summary): ${def.intent}`,
    `Automated verdict: ${evaluated.status}${evaluated.manual ? ' (manual/attestation control)' : ''}`,
    '',
    'Live evidence mapped to this control:',
    evidenceBlock(evaluated),
    '',
    'Produce the JSON described in your instructions for THIS control and THIS deployment.',
  ].join('\n');

  const out = await converseTurn({
    modelId: MODEL,
    systemPrompt: SYSTEM,
    userText,
    // Sonnet 4.6 emits ~2.1k output tokens for this multi-field JSON. The old
    // 1200 cap truncated the response mid-string (stopReason=max_tokens), so it
    // never parsed and every control showed "model did not return valid JSON".
    // 4096 leaves comfortable headroom while staying well under the model limit.
    maxTokens: 4096,
    temperature: 0,
  });

  const parsed = extractJson(out.text ?? '');

  return {
    controlId: def.id,
    framework: def.framework,
    ref: def.ref,
    title: def.title,
    edition: String(parsed.edition ?? ''),
    requirement: String(parsed.requirement ?? ''),
    currentState: String(parsed.currentState ?? ''),
    gaps: asStringArray(parsed.gaps),
    remediation: asStringArray(parsed.remediation),
    references: asStringArray(parsed.references),
    modelId: out.modelId,
  };
}

export { MODEL as COMPLIANCE_MODEL };
