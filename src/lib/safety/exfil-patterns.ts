/**
 * Built-in exfil detection patterns. Each pattern is a regex string
 * compiled at load time. Patterns should be simple enough to not
 * cause catastrophic backtracking; we rely on RE2-safe subset only.
 */

export interface ExfilPattern {
  id: string;
  name: string;
  regex: string;
  severity: 'block' | 'warn';
  enabled: boolean;
}

export const BUILTIN_PATTERNS: ExfilPattern[] = [
  {
    id: 'aws_access_key',
    name: 'AWS Access Key',
    regex: 'AKIA[0-9A-Z]{16}',
    severity: 'block',
    enabled: true,
  },
  {
    id: 'aws_secret_key',
    name: 'AWS Secret Key',
    regex: '[A-Za-z0-9/+=]{40}',
    // 'warn' not 'block': this regex matches any 40-char base64/hex run,
    // which collides with commit SHAs, SHA-256 digests, and base64 blobs.
    // At 'block' severity the egress scanner would redact those legitimate
    // technical replies. 'warn' still surfaces and audits the match without
    // corrupting output. The AKIA-prefixed access-key pattern stays 'block'.
    severity: 'warn',
    enabled: true,
  },
  {
    id: 'generic_api_key',
    name: 'Generic API Key Header',
    regex: '(?:api[_-]?key|apikey|api_secret|secret_key)["\']?\\s*[:=]\\s*["\']?[A-Za-z0-9_\\-]{20,}',
    severity: 'block',
    enabled: true,
  },
  {
    id: 'private_key_pem',
    name: 'Private Key (PEM)',
    regex: '-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----',
    severity: 'block',
    enabled: true,
  },
  {
    id: 'jwt_token',
    name: 'JWT Token',
    regex: 'eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}',
    severity: 'warn',
    enabled: true,
  },
  {
    id: 'slack_token',
    name: 'Slack Token',
    regex: 'xox[bpras]-[0-9A-Za-z\\-]{10,}',
    severity: 'block',
    enabled: true,
  },
  {
    id: 'github_pat',
    name: 'GitHub PAT',
    regex: 'gh[ps]_[A-Za-z0-9]{36,}',
    severity: 'block',
    enabled: true,
  },
  {
    id: 'credit_card',
    name: 'Credit Card Number',
    regex: '\\b(?:4[0-9]{12}(?:[0-9]{3})?|5[1-5][0-9]{14}|3[47][0-9]{13})\\b',
    severity: 'block',
    enabled: true,
  },
  {
    id: 'ssn',
    name: 'US SSN',
    regex: '\\b[0-9]{3}-[0-9]{2}-[0-9]{4}\\b',
    severity: 'block',
    enabled: true,
  },
];
