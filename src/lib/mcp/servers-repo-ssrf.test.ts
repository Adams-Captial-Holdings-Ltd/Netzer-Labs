import { describe, it, expect } from 'vitest';
import { isAllowedMcpUrl, isBlockedMcpHost } from './servers-repo.js';

// H4 regression: operator-registered MCP URLs are fetched from inside the VPC
// and, in auth:'iam' mode, SigV4-signed with the task role. The only prior
// validation was `^https://`, so 169.254.169.254 / RFC-1918 / *.internal were
// reachable. These cover the host/IP SSRF guard.

describe('isAllowedMcpUrl', () => {
  it('allows a public https AgentCore gateway URL', () => {
    expect(
      isAllowedMcpUrl('https://abc.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp'),
    ).toBe(true);
    expect(isAllowedMcpUrl('https://8.8.8.8/mcp')).toBe(true);
    expect(isAllowedMcpUrl('https://172.32.0.1/mcp')).toBe(true); // just outside 172.16/12
  });

  it('rejects non-https schemes', () => {
    expect(isAllowedMcpUrl('http://example.com/mcp')).toBe(false);
    expect(isAllowedMcpUrl('file:///etc/passwd')).toBe(false);
    expect(isAllowedMcpUrl('not a url')).toBe(false);
  });

  it('rejects the cloud metadata endpoint', () => {
    expect(isAllowedMcpUrl('https://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(isAllowedMcpUrl('https://metadata.google.internal/computeMetadata/v1/')).toBe(false);
  });

  it('rejects RFC-1918, loopback, CGNAT, and internal TLDs', () => {
    expect(isAllowedMcpUrl('https://10.0.0.5/mcp')).toBe(false);
    expect(isAllowedMcpUrl('https://192.168.1.1/mcp')).toBe(false);
    expect(isAllowedMcpUrl('https://172.16.0.1/mcp')).toBe(false);
    expect(isAllowedMcpUrl('https://172.31.255.255/mcp')).toBe(false);
    expect(isAllowedMcpUrl('https://127.0.0.1/mcp')).toBe(false);
    expect(isAllowedMcpUrl('https://100.64.0.1/mcp')).toBe(false);
    expect(isAllowedMcpUrl('https://localhost/mcp')).toBe(false);
    expect(isAllowedMcpUrl('https://vault.internal/mcp')).toBe(false);
    expect(isAllowedMcpUrl('https://db.local/mcp')).toBe(false);
  });

  it('rejects IPv6 loopback / unique-local / link-local and IPv4-mapped', () => {
    expect(isAllowedMcpUrl('https://[::1]/mcp')).toBe(false);
    expect(isAllowedMcpUrl('https://[fd00::1]/mcp')).toBe(false);
    expect(isAllowedMcpUrl('https://[fe80::1]/mcp')).toBe(false);
    expect(isBlockedMcpHost('::ffff:169.254.169.254')).toBe(true);
  });

  // Codex P1: new URL() normalizes an IPv4-mapped IPv6 literal to its
  // hex-compressed form (::ffff:a9fe:a9fe), which the old dotted-quad-only
  // regex did not match — so the full URL path was bypassable even though the
  // dotted string tested true. Cover both spellings AND the URL path.
  it('rejects IPv4-mapped IPv6 in every spelling, including via the URL path', () => {
    expect(isBlockedMcpHost('::ffff:a9fe:a9fe')).toBe(true); // hex-compressed IMDS
    expect(isBlockedMcpHost('::ffff:0a00:0001')).toBe(true); // 10.0.0.1 mapped
    expect(isAllowedMcpUrl('https://[::ffff:169.254.169.254]/latest/meta-data/')).toBe(false);
    expect(isAllowedMcpUrl('https://[::ffff:a9fe:a9fe]/latest/meta-data/')).toBe(false);
    expect(isAllowedMcpUrl('https://[::ffff:10.0.0.5]/mcp')).toBe(false);
    // A mapped PUBLIC address is still allowed (not over-blocking).
    expect(isBlockedMcpHost('::ffff:8.8.8.8')).toBe(false);
    expect(isAllowedMcpUrl('https://[::ffff:808:808]/mcp')).toBe(true);
  });
});
