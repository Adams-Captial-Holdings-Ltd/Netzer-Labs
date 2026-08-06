import { APP } from '../constants.js';

/**
 * Resource name prefixes that extensions are forbidden to use in their
 * IAM statements or CloudFormation resources. Any extension manifest that
 * references an ARN matching one of these prefixes is rejected at deploy
 * time by the deployer Lambda (P5.1).
 *
 * The list is intentionally broad: we err on the side of blocking.
 * Extensions can request egress to external services via Network Firewall
 * rules; they should never need to touch platform internals.
 */
export const RESERVED_RESOURCE_PREFIXES: readonly string[] = [
  `${APP}-`,
  'claudeclaw-',
  'ClaudeClaw',
  'CCE-',
  'cce-',
] as const;
