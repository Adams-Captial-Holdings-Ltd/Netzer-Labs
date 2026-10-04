import { paperclipClientFromEnvironment, type PaperclipClient } from '../paperclip/client.js';
import { loadPaperclipConfig } from '../paperclip/config.js';
import { PaperclipDisabledError, PaperclipError, PaperclipLockClosedError } from '../paperclip/error.js';
import { getPaperclipLockState } from '../paperclip/runtime-lock.js';
import { isKillSwitchActive } from '../state/kill-switches-repo.js';
import { dynamoShadowRows } from '../paperclip/shadow-rows-dynamo.js';
import { defaultShadowKeyStore } from '../paperclip/shadow-keys.js';
import { writeAuditOrThrow } from '../audit/audit-writer.js';
import { createApprovals, type ApprovalRecord, type ApprovalsPort } from './approvals.js';

type Client = Pick<PaperclipClient, 'request'>;
type Dependencies = {
  client?: () => Promise<Client>;
  loadConfig?: typeof loadPaperclipConfig;
  fetchFn?: typeof fetch;
  lockState?: typeof getPaperclipLockState;
  killSwitch?: typeof isKillSwitchActive;
};

export class PaperclipApprovalHttpError extends Error {
  constructor(public readonly status: number) {
    super(`Paperclip approval request failed (HTTP ${status})`);
    this.name = 'PaperclipApprovalHttpError';
  }
}

function approvalRecord(value: unknown, status: number): ApprovalRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new PaperclipApprovalHttpError(status);
  const row = value as Record<string, unknown>;
  if (typeof row.id !== 'string' || !row.id.trim() || typeof row.type !== 'string'
    || typeof row.status !== 'string') throw new PaperclipApprovalHttpError(status);
  return value as ApprovalRecord;
}

export function paperclipApprovalsPort(deps: Dependencies = {}): ApprovalsPort {
  const client = deps.client ?? paperclipClientFromEnvironment;
  const loadConfig = deps.loadConfig ?? loadPaperclipConfig;
  const fetchFn = deps.fetchFn ?? fetch;
  const lockState = deps.lockState ?? getPaperclipLockState;
  const killSwitch = deps.killSwitch ?? isKillSwitchActive;
  return {
    async create(body) {
      const config = await loadConfig();
      if (!config.companyId?.trim()) throw new PaperclipDisabledError({ notSent: true,
        body: { error: 'Paperclip company ID is not configured' } });
      const value = await (await client()).request<unknown>('POST',
        `/api/companies/${encodeURIComponent(config.companyId)}/approvals`, { body });
      return approvalRecord(value, 200);
    },
    async get(id) {
      try { return await (await client()).request<ApprovalRecord>('GET', `/api/approvals/${encodeURIComponent(id)}`); }
      catch (error) {
        if (error instanceof PaperclipError && error.status === 404) return undefined;
        throw error;
      }
    },
    async decide(id, verb, decisionNote, boardKey) {
      if (!boardKey || /\s|[\x00-\x1f\x7f]/.test(boardKey)) throw new PaperclipApprovalHttpError(0);
      const lock = lockState();
      if (lock.closed) throw new PaperclipLockClosedError({ notSent: true,
        body: { error: `Paperclip runtime lock closed: ${lock.code}` } }, lock.code ?? 'unknown');
      const gate = await killSwitch('paperclip_disabled');
      if (gate.active) throw new PaperclipDisabledError({ notSent: true,
        body: { error: 'paperclip_disabled kill switch active' } });
      const config = await loadConfig();
      if (!config.baseUrl) throw new PaperclipDisabledError({ notSent: true,
        body: { error: 'Paperclip base URL is not configured' } });
      let response: Response;
      try {
        response = await fetchFn(`${config.baseUrl.replace(/\/+$/, '')}/api/approvals/${encodeURIComponent(id)}/${verb}`, {
          method: 'POST', headers: { authorization: `Bearer ${boardKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ decisionNote }), signal: AbortSignal.timeout(20_000), redirect: 'error',
        });
      } catch { throw new PaperclipApprovalHttpError(0); }
      if (!response.ok) throw new PaperclipApprovalHttpError(response.status);
      let value: unknown;
      try { value = await response.json(); } catch { throw new PaperclipApprovalHttpError(response.status); }
      return approvalRecord(value, response.status);
    },
  };
}

let defaultKeys: ReturnType<typeof defaultShadowKeyStore> | undefined;
let defaultRows: ReturnType<typeof dynamoShadowRows> | undefined;
export function defaultApprovals(): ReturnType<typeof createApprovals> {
  defaultKeys ??= defaultShadowKeyStore();
  defaultRows ??= dynamoShadowRows();
  return createApprovals({ port: paperclipApprovalsPort(), shadows: defaultRows,
    keys: defaultKeys, audit: writeAuditOrThrow, now: Date.now });
}
