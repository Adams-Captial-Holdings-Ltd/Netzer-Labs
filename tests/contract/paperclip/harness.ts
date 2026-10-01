import { describe } from 'vitest';
import { ensureLockAuditor } from '../../../scripts/lib/paperclip/bootstrap-core.js';
import { bootstrapPaperclip, paperclipAdminRequest } from '../../fixtures/paperclip-bootstrap.js';

export const describeLive = describe.skipIf(!process.env.PAPERCLIP_TEST_AUTH_SECRET);
export const describeNewPin = describe.skipIf(!process.env.PAPERCLIP_TEST_AUTH_SECRET);

let detectedPin: Promise<'old' | 'new'> | undefined;

export function paperclipPin(): Promise<'old' | 'new'> {
  detectedPin ??= (async () => {
    const fixture = await bootstrapPaperclip();
    const response = await withBearer(fixture.reconcilerKey)('/api/health');
    if (!response.ok) throw new Error(`Authenticated Paperclip health returned HTTP ${response.status}`);
    const body = await response.json() as { serverVersion?: unknown; version?: unknown };
    const version = body.serverVersion ?? body.version;
    if (version === '2026.722.0') return 'old';
    if (version === '2026.916.1') return 'new';
    throw new Error(`Paperclip version ${String(version)} has no contract expectations; add expectations for that pin`);
  })();
  return detectedPin;
}

export function withBearer(key: string): (path: string, init?: RequestInit) => Promise<Response> {
  return async (path, init = {}) => {
    const fixture = await bootstrapPaperclip();
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${key}`);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    return fetch(`${fixture.baseUrl}${path}`, { ...init, headers, redirect: 'error' });
  };
}

export async function freshAuditor(): Promise<string> {
  const fixture = await bootstrapPaperclip();
  const result = await ensureLockAuditor({
    request: paperclipAdminRequest,
    companyId: fixture.companyId,
    baseUrl: fixture.baseUrl,
  });
  if (result.action !== 'created') throw new Error('Paperclip auditor was not created');
  return result.key;
}
