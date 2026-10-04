import { paperclipClientFromEnvironment, type PaperclipClient } from '../paperclip/client.js';
import { loadPaperclipConfig } from '../paperclip/config.js';
import { PaperclipDisabledError, PaperclipLockClosedError } from '../paperclip/error.js';
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

export function paperclipApprovalsPort(deps: Dependencies = {}): ApprovalsPort {
  const client = deps.client ?? paperclipClientFromEnvironment;
  const loadConfig = deps.loadConfig ?? loadPaperclipConfig;
  const fetchFn = deps.fetchFn ?? fetch;
  const lockState = deps.lockState ?? getPaperclipLockState;
  const killSwitch = deps.killSwitch ?? isKillSwitchActive;
  return {
    async create(body) {
      const config = await loadConfig();
      return (await client()).request<ApprovalRecord>('POST',
        `/api/companies/${encodeURIComponent(config.companyId ?? '')}/approvals`, { body });
    },
    async get(id) {
      try { return await (await client()).request<ApprovalRecord>('GET', `/api/approvals/${encodeURIComponent(id)}`); }
      catch (error) {
        if ((error as { status?: number } | null)?.status === 404) return undefined;
        throw error;
      }
    },
    async decide(id, verb, decisionNote, boardKey) {
      const lock = lockState();
      if (lock.closed) throw new PaperclipLockClosedError({ notSent: true,
        body: { error: `Paperclip runtime lock closed: ${lock.code}` } }, lock.code ?? 'unknown');
      const gate = await killSwitch('paperclip_disabled');
      if (gate.active) throw new PaperclipDisabledError({ notSent: true,
        body: { error: 'paperclip_disabled kill switch active' } });
      const config = await loadConfig();
      if (!config.baseUrl) throw new PaperclipDisabledError({ notSent: true,
        body: { error: 'Paperclip base URL is not configured' } });
      const response = await fetchFn(`${config.baseUrl.replace(/\/+$/, '')}/api/approvals/${encodeURIComponent(id)}/${verb}`, {
        method: 'POST', headers: { authorization: `Bearer ${boardKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ decisionNote }), signal: AbortSignal.timeout(20_000), redirect: 'error',
      });
      if (!response.ok) throw new PaperclipApprovalHttpError(response.status);
      return await response.json() as ApprovalRecord;
    },
  };
}

export function defaultApprovals(): ReturnType<typeof createApprovals> {
  return createApprovals({ port: paperclipApprovalsPort(), shadows: dynamoShadowRows(),
    keys: defaultShadowKeyStore(), audit: writeAuditOrThrow, now: Date.now });
}
