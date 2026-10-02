/**
 * FROZEN ACCEPTANCE TEST: Work Platform step 2 (SPECIFICATION checkpoint).
 *
 * Written by the coordinator BEFORE any production code. The builder makes it
 * pass and MUST NOT edit it (the step gate pins its sha256).
 *
 * WHAT THIS PINS (ADR 0014 item 3, "behind an SSRF allowlist"): a runtime-config
 * write is the only way a base URL enters the Paperclip client that is NOT fixed
 * at deploy time, and any dashboard admin can make that write
 * (POST /api/config/:category/:key, no denylist for the paperclip category).
 * The client sends an agent API key to whatever host it is pointed at, so an
 * override that names a public host is a credential-exfiltration path.
 *
 * THE RULE, for the runtime-config override ONLY. The deploy-time environment
 * value (PAPERCLIP_BASE_URL, set in the task definition) stays trusted and
 * unvalidated, exactly as before, so every existing fixture keeps working:
 *   - scheme http or https; no userinfo; origin only (no path but "/", no query,
 *     no fragment);
 *   - host is one of: localhost; a loopback address (127.0.0.0/8, [::1]); an
 *     RFC 1918 literal (10/8, 172.16/12, 192.168/16); or a DNS name ending in
 *     ".internal" (the Cloud Map private namespace);
 *   - everything else is refused with PaperclipDisabledError: public hosts and
 *     IPs, link-local (169.254/16, which includes the metadata services),
 *     0.0.0.0, other schemes.
 * And the client never follows a redirect (an Authorization header must not be
 * replayed to a host the admin-chosen server redirects to).
 */
import { describe, expect, it, vi } from 'vitest';
import { loadPaperclipConfig } from './config.js';
import { PaperclipClient, __resetPaperclipCompanyPin } from './client.js';
import { PaperclipDisabledError } from './error.js';

const ENV = { PAPERCLIP_COMPANY_ID: 'co', PAPERCLIP_AGENT_KEYS_JSON: '{"main":"k"}', PAPERCLIP_BASE_URL: 'http://paperclip.claudeclaw.internal:3100' };

const withOverride = (value: string | undefined) =>
  loadPaperclipConfig({
    env: ENV,
    getConfigFn: (async (category: string, key: string) =>
      category === 'paperclip' && key === 'base_url' ? value : undefined) as never,
  });

describe('a runtime-config base_url override is accepted only for private destinations', () => {
  it.each([
    'http://paperclip.claudeclaw.internal:3100',
    'https://paperclip.internal',
    'http://paperclip.internal/',
    'http://localhost:3100',
    'http://127.0.0.1:3100',
    'http://127.8.9.10:3100',
    'http://[::1]:3100',
    'http://10.0.4.7:3100',
    'http://172.16.0.9:3100',
    'http://172.31.255.254:3100',
    'http://192.168.1.5:3100',
  ])('accepts %s', async (url) => {
    const input = await withOverride(url);
    expect(input.baseUrl).toBe(url);
  });

  it.each([
    ['a public host', 'https://evil.example.com'],
    ['a public IP', 'http://8.8.8.8'],
    ['the EC2 metadata address', 'http://169.254.169.254'],
    ['the ECS task metadata address', 'http://169.254.170.2'],
    ['0.0.0.0', 'http://0.0.0.0:3100'],
    ['an IP just outside 172.16/12', 'http://172.32.0.1:3100'],
    ['an IP just outside 192.168/16', 'http://192.169.0.1:3100'],
    ['a scheme that is not http(s)', 'ftp://paperclip.internal'],
    ['a javascript: URL', 'javascript:alert(1)'],
    ['embedded credentials', 'http://user:pw@paperclip.internal'],
    ['a path', 'http://paperclip.internal/evil/path'],
    ['a query', 'http://paperclip.internal?x=1'],
    ['a fragment', 'http://paperclip.internal#x'],
    ['the bare word internal', 'http://internal'],
    ['a lookalike that only contains .internal', 'http://paperclip.internal.example.com'],
    ['a protocol-relative URL', '//paperclip.internal'],
    ['something that is not a URL', 'not a url'],
  ])('refuses %s with PaperclipDisabledError', async (_label, url) => {
    const err = await withOverride(url).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PaperclipDisabledError);
    expect(JSON.stringify((err as PaperclipDisabledError).body)).toMatch(/not allowed|private/i);
  });

  it('the refusal never echoes a credential-bearing URL back verbatim', async () => {
    const err = await withOverride('http://user:hunter2@paperclip.internal').catch((e: unknown) => e);
    expect(JSON.stringify((err as PaperclipDisabledError).body)).not.toContain('hunter2');
  });

  it('no override means the trusted env value is used unvalidated, as before', async () => {
    const input = await loadPaperclipConfig({
      env: { ...ENV, PAPERCLIP_BASE_URL: 'https://from-env' },
      getConfigFn: (async () => undefined) as never,
    });
    expect(input.baseUrl).toBe('https://from-env');
  });
});

describe('the client never follows a redirect', () => {
  it('every outbound request carries redirect: "error"', async () => {
    __resetPaperclipCompanyPin();
    const seen: Array<RequestInit | undefined> = [];
    const fetchFn = vi.fn(async (_url: unknown, init?: RequestInit) => {
      seen.push(init);
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const client = new PaperclipClient({
      baseUrl: 'http://paperclip.claudeclaw.internal:3100',
      companyId: 'co',
      agentKeys: { main: 'k' },
      fetchFn: fetchFn as unknown as typeof fetch,
      killSwitch: (async () => ({ active: false })) as never,
    });
    await client.listAgents();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.redirect).toBe('error');
  });
});
