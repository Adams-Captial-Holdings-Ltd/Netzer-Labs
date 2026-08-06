/**
 * Resource name prefixes that extensions are forbidden to use in their
 * IAM statements or CloudFormation resources.
 */

const APP_BASE = 'claudeclaw';

export const RESERVED_RESOURCE_PREFIXES: readonly string[] = [
  `${APP_BASE}-`,
  'claudeclaw-',
  'ClaudeClaw',
  'CCE-',
  'cce-',
] as const;
