/**
 * Minimal Salesforce REST client over the OAuth connection landed by the
 * Connect button (runtime-config oauth/salesforce_tokens).
 *
 * Refresh-on-401-once: an expired access token triggers one refresh + retry;
 * a second 401 surfaces SalesforceAuthError("reconnect required") so the
 * agent tells the user to re-run the Connect flow instead of looping.
 */

import { getConfig, setConfig } from '../state/runtime-config-repo.js';
import { salesforceRefresh, type SalesforceTokens } from '../oauth/providers.js';
import { logger } from '../../observability/logger.js';

const API_VERSION = 'v61.0';
/** Cap query pagination so a runaway SOQL can't stream an org into a turn. */
const MAX_QUERY_RECORDS = 2000;

export class SalesforceAuthError extends Error {
  constructor(message = 'Salesforce connection expired — reconnect from Integrations') {
    super(message);
    this.name = 'SalesforceAuthError';
  }
}

export class SalesforceNotConnectedError extends Error {
  constructor() {
    super('Salesforce is not connected. An admin can connect it from Integrations.');
    this.name = 'SalesforceNotConnectedError';
  }
}

async function loadTokens(): Promise<SalesforceTokens> {
  const raw = await getConfig('oauth', 'salesforce_tokens');
  if (!raw) throw new SalesforceNotConnectedError();
  try {
    const t = JSON.parse(raw) as SalesforceTokens;
    if (!t.accessToken || !t.instanceUrl) throw new Error('incomplete');
    return t;
  } catch {
    throw new SalesforceNotConnectedError();
  }
}

export async function sfRequest(opts: {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
}): Promise<unknown> {
  let tokens = await loadTokens();
  for (let attempt = 0; attempt < 2; attempt++) {
    const resp = await fetch(`${tokens.instanceUrl}${opts.path}`, {
      method: opts.method,
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        'Content-Type': 'application/json',
      },
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
    });
    if (resp.status === 401 && attempt === 0 && tokens.refreshToken) {
      // Expired session: refresh once, persist, retry.
      try {
        const fresh = await salesforceRefresh(tokens.refreshToken);
        tokens = { ...tokens, accessToken: fresh.accessToken, instanceUrl: fresh.instanceUrl };
        await setConfig('oauth', 'salesforce_tokens', JSON.stringify(tokens), {
          updatedBy: 'salesforce:auto-refresh',
        });
        continue;
      } catch (err) {
        logger.warn(
          { errMessage: err instanceof Error ? err.message : String(err) },
          'salesforce token refresh failed',
        );
        throw new SalesforceAuthError();
      }
    }
    if (resp.status === 401) throw new SalesforceAuthError();
    if (resp.status === 204) return null; // PATCH/DELETE success
    const json = (await resp.json().catch(() => null)) as unknown;
    if (!resp.ok) {
      const detail = Array.isArray(json)
        ? (json[0] as { message?: string })?.message
        : (json as { message?: string } | null)?.message;
      throw new Error(`Salesforce ${opts.method} ${opts.path} -> ${resp.status}: ${detail ?? 'error'}`);
    }
    return json;
  }
  throw new SalesforceAuthError();
}

export async function sfQuery(
  soql: string,
): Promise<{ totalSize: number; records: Record<string, unknown>[] }> {
  let out = (await sfRequest({
    method: 'GET',
    path: `/services/data/${API_VERSION}/query?q=${encodeURIComponent(soql)}`,
  })) as { totalSize: number; done: boolean; records: Record<string, unknown>[]; nextRecordsUrl?: string };
  const records = [...out.records];
  while (!out.done && out.nextRecordsUrl && records.length < MAX_QUERY_RECORDS) {
    out = (await sfRequest({ method: 'GET', path: out.nextRecordsUrl })) as typeof out;
    records.push(...out.records);
  }
  return { totalSize: out.totalSize, records: records.slice(0, MAX_QUERY_RECORDS) };
}

export function sobjectPath(object: string, id?: string): string {
  const safeObject = object.replace(/[^A-Za-z0-9_]/g, '');
  const safeId = id?.replace(/[^A-Za-z0-9]/g, '');
  return `/services/data/${API_VERSION}/sobjects/${safeObject}${safeId ? `/${safeId}` : ''}`;
}
