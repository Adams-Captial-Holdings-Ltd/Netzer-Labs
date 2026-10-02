import { describe, expect, it } from 'vitest';
import { loadPaperclipConfig } from './config.js';
import { PaperclipDisabledError } from './error.js';

const env = { PAPERCLIP_COMPANY_ID: 'co', PAPERCLIP_AGENT_KEYS_JSON: '{"main":"test-key"}', PAPERCLIP_BASE_URL: 'http://paperclip.internal' };
const withOverride = (value: string) => loadPaperclipConfig({
  env,
  getConfigFn: (async (category: string, key: string) => category === 'paperclip' && key === 'base_url' ? value : undefined) as never,
});

describe('SSRF override address boundaries', () => {
  it.each([
    'http://[::ffff:a9fe:a9fe]', 'http://[2001:db8::1]', 'http://[fd00::1]', 'http://[fe80::1]',
    'http://localhost.evil.com', 'http://localhostx', 'http://172.15.0.1', 'http://172.32.0.1',
    'http://100.64.0.1', 'http://10.0.0.1.evil.com', 'http://169.254.169.254',
  ])('refuses %s', async (url) => {
    await expect(withOverride(url)).rejects.toBeInstanceOf(PaperclipDisabledError);
  });

  it.each([
    'http://[::1]', 'http://172.16.0.1', 'http://172.31.255.255', 'http://10.1.2.3:3100',
    'http://orchestrator.dispatch.internal',
  ])('accepts %s', async (url) => {
    expect((await withOverride(url)).baseUrl).toBe(url);
  });
});
