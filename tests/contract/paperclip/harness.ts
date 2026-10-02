import { describe } from 'vitest';
import { ensureLockAuditor } from '../../../scripts/lib/paperclip/bootstrap-core.js';
import { bootstrapPaperclip, paperclipAdminRequest } from '../../fixtures/paperclip-bootstrap.js';

export const describeNewPin = describe.skipIf(!process.env.PAPERCLIP_TEST_AUTH_SECRET);

let detectedPin: Promise<'new'> | undefined;
let auditorKey: Promise<string> | undefined;

export function paperclipPin(): Promise<'new'> {
  detectedPin ??= (async (): Promise<'new'> => {
    const response = await paperclipAdminRequest('/api/instance/settings/experimental');
    if (response.status !== 200) throw new Error(`Paperclip experimental settings returned HTTP ${response.status}`);
    const body = await response.json().catch(() => null) as unknown;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new Error(`Paperclip experimental settings returned HTTP ${response.status} with a non-object body`);
    }
    if (typeof (body as Record<string, unknown>).enableNativeRunner === 'boolean') return 'new';
    if (!('enableNativeRunner' in body)) {
      throw new Error('Paperclip under test answered experimental-settings without a boolean enableNativeRunner: this suite pins v2026.916.1 behaviour; re-pin, fix the image under test, or update the suite deliberately.');
    }
    throw new Error(`Paperclip experimental settings returned HTTP ${response.status} with an invalid enableNativeRunner`);
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
  auditorKey ??= (async () => {
    const fixture = await bootstrapPaperclip();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const result = await ensureLockAuditor({
          request: paperclipAdminRequest,
          companyId: fixture.companyId,
          baseUrl: fixture.baseUrl,
        });
        if (result.action !== 'created') throw new Error('Paperclip auditor was not created');
        return result.key;
      } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('HTTP 429') || attempt === 2) throw error;
        await new Promise((resolve) => setTimeout(resolve, 11_000));
      }
    }
    throw new Error('Paperclip auditor retry exhausted');
  })();
  return auditorKey;
}
