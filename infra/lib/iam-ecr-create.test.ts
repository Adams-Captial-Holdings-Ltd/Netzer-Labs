/**
 * The CI deploy role creates ECR repos under an `ecr:RepositoryName` condition
 * (`ECR_CREATE_NAME_PATTERNS`). Any repo name the deploy bootstraps that is not
 * matched by that condition fails with AccessDeniedException — and it fails
 * during the image-build phase, BEFORE `cdk deploy`, so the blocked run can
 * never deploy the IAM fix that would unblock it. That is exactly what happened
 * when Paperclip (ADR 0010) added a second repo and the condition still named
 * only the orchestrator:
 *
 *   User: .../ClaudeClawGitHubDeploy is not authorized to perform:
 *   ecr:CreateRepository on resource: .../claudeclaw-staging-paperclip
 *
 * These assertions pin the condition against the REAL name builder rather than
 * a copy of the literals, so adding a repo to `constants.ts` without adding it
 * to the policy fails here instead of in a deploy.
 */
import { describe, it, expect } from 'vitest';
import { ECR_CREATE_NAME_PATTERNS } from './iam-stack.js';
import { buildResourceNames } from './constants.js';

/**
 * IAM `StringLike` semantics: `*` matches any sequence of characters, and every
 * other character is a literal. Implemented without a RegExp so no pattern
 * character needs escaping.
 */
function matchesIamStringLike(pattern: string, value: string): boolean {
  const parts = pattern.split('*');
  if (parts.length === 1) return pattern === value;

  if (!value.startsWith(parts[0])) return false;
  const last = parts[parts.length - 1];
  if (!value.endsWith(last)) return false;
  // The fixed head and tail must not overlap in a short value.
  if (parts[0].length + last.length > value.length) return false;

  let cursor = parts[0].length;
  for (const part of parts.slice(1, -1)) {
    const found = value.indexOf(part, cursor);
    if (found === -1) return false;
    cursor = found + part.length;
  }
  return cursor <= value.length - last.length;
}

const SUFFIXES = ['', 'staging', 'qa', 'pr42'];

function covered(name: string): boolean {
  return ECR_CREATE_NAME_PATTERNS.some((p) => matchesIamStringLike(p, name));
}

describe('matchesIamStringLike', () => {
  it('models the wildcard and literal cases the policy relies on', () => {
    expect(matchesIamStringLike('claudeclaw-orchestrator', 'claudeclaw-orchestrator')).toBe(true);
    expect(matchesIamStringLike('claudeclaw-*-orchestrator', 'claudeclaw-staging-orchestrator')).toBe(true);
    // A wildcard must not let the suffix collapse to nothing where the literal
    // form is the one that should match.
    expect(matchesIamStringLike('claudeclaw-*-orchestrator', 'claudeclaw-orchestrator')).toBe(false);
    expect(matchesIamStringLike('claudeclaw-orchestrator', 'claudeclaw-staging-orchestrator')).toBe(false);
  });
});

describe('ECR create condition covers every app repo', () => {
  it.each(SUFFIXES)('covers the orchestrator repo for suffix "%s"', (suffix) => {
    const name = buildResourceNames(suffix).ecrRepo;
    expect(covered(name), `"${name}" matches no ECR_CREATE_NAME_PATTERNS entry`).toBe(true);
  });

  it.each(SUFFIXES)('covers the Paperclip repo for suffix "%s"', (suffix) => {
    const name = buildResourceNames(suffix).paperclipEcrRepo;
    expect(covered(name), `"${name}" matches no ECR_CREATE_NAME_PATTERNS entry`).toBe(true);
  });

  it('covers the exact name from the reported failure', () => {
    expect(covered('claudeclaw-staging-paperclip')).toBe(true);
  });

  it('stays narrow — does not authorise unrelated repositories', () => {
    for (const foreign of [
      'some-other-repo',
      'claudeclaw',
      'notclaudeclaw-orchestrator',
      'claudeclaw-orchestrator-evil',
    ]) {
      expect(covered(foreign), `"${foreign}" must NOT be creatable`).toBe(false);
    }
  });
});
