import { describe, expect, it, vi } from 'vitest';
import { PaperclipDisabledError, PaperclipError, PaperclipLockClosedError } from '../paperclip/error.js';
import { paperclipApprovalsPort, PaperclipApprovalHttpError } from './approvals-paperclip.js';

const config = async () => ({ baseUrl: 'http://paperclip.claudeclaw.internal:3100', companyId: 'company-1' });
const unlocked = () => ({ closed: false, code: null });
const enabled = async () => ({ active: false });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const decided = { id: 'ap-1', type: 'request_board_approval', status: 'approved', payload: {}, decidedByUserId: 'pc-1' };

describe('Paperclip approvals port', () => {
  it("sends the decision with the shadow user's board key", async () => {
    const fetchFn = vi.fn(async () => response(decided));
    const agentKey = 'agent-secret';
    const agentAuthorization = vi.fn(() => `Bearer ${agentKey}`);
    const port = paperclipApprovalsPort({ fetchFn: fetchFn as unknown as typeof fetch, loadConfig: config,
      lockState: unlocked, killSwitch: enabled, client: async () => ({
        request: async <T>() => { agentAuthorization(); return decided as T; },
      }) });
    await port.create({ type: 'request_board_approval', payload: {} });
    expect(agentAuthorization).toHaveBeenCalledTimes(1);
    expect(agentAuthorization.mock.results[0]?.value).toBe(`Bearer ${agentKey}`);
    expect(await port.decide('ap-1', 'approve', null, 'board-secret')).toEqual(decided);
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://paperclip.claudeclaw.internal:3100/api/approvals/ap-1/approve');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer board-secret');
    expect(JSON.stringify({ url, init })).not.toContain(agentKey);
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeDefined();
  });
  it('a closed lock sends nothing', async () => {
    const fetchFn = vi.fn(async () => response(decided));
    const port = paperclipApprovalsPort({ fetchFn: fetchFn as unknown as typeof fetch, loadConfig: config,
      lockState: () => ({ closed: true, code: 'sign_up_open' }), killSwitch: enabled });
    await expect(port.decide('ap-1', 'approve', null, 'board-secret')).rejects.toBeInstanceOf(PaperclipLockClosedError);
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it('honors paperclip_disabled before sending', async () => {
    const fetchFn = vi.fn(async () => response(decided));
    const port = paperclipApprovalsPort({ fetchFn: fetchFn as unknown as typeof fetch, loadConfig: config,
      lockState: unlocked, killSwitch: async () => ({ active: true, reason: 'operator' }) });
    await expect(port.decide('ap-1', 'approve', null, 'board-secret')).rejects.toBeInstanceOf(PaperclipDisabledError);
    expect(fetchFn).not.toHaveBeenCalled();
  });
  it('uses request-revision verb and decisionNote body', async () => {
    const fetchFn = vi.fn(async () => response(decided));
    const port = paperclipApprovalsPort({ fetchFn: fetchFn as unknown as typeof fetch, loadConfig: config,
      lockState: unlocked, killSwitch: enabled });
    await port.decide('ap-1', 'request-revision', 'more evidence', 'board-secret');
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/\/request-revision$/);
    expect(JSON.parse(String(init.body))).toEqual({ decisionNote: 'more evidence' });
  });
  it('non-2xx errors carry status but neither response body nor key', async () => {
    const fetchFn = vi.fn(async () => response({ error: 'body-secret' }, 403));
    const port = paperclipApprovalsPort({ fetchFn: fetchFn as unknown as typeof fetch, loadConfig: config,
      lockState: unlocked, killSwitch: enabled });
    try {
      await port.decide('ap-1', 'reject', 'no', 'board-secret');
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(PaperclipApprovalHttpError);
      expect((error as PaperclipApprovalHttpError).status).toBe(403);
      expect(String(error)).not.toMatch(/board-secret|body-secret/);
    }
  });
  it('create and get use the agent client, with 404 returning undefined', async () => {
    const request = vi.fn(async (method: string, _path: string) => {
      if (method === 'POST') return decided;
      throw new PaperclipError({ status: 404 });
    });
    const port = paperclipApprovalsPort({ loadConfig: config,
      client: async () => ({ request: request as unknown as <T>(method: string, path: string) => Promise<T> }) });
    expect(await port.create({ type: 'request_board_approval', payload: {} })).toEqual(decided);
    expect(request.mock.calls[0]?.[1]).toBe('/api/companies/company-1/approvals');
    expect(await port.get('missing')).toBeUndefined();
    expect(request.mock.calls[1]?.[1]).toBe('/api/approvals/missing');
  });

  it('forwards create body and refuses a missing company id', async () => {
    const request = vi.fn(async () => decided);
    const client = async () => ({ request: request as unknown as <T>(method: string, path: string,
      options?: { body?: unknown }) => Promise<T> });
    const port = paperclipApprovalsPort({ client, loadConfig: config });
    const body = { type: 'request_board_approval', payload: { netzerApproval: 1 } };
    await port.create(body);
    expect((request as ReturnType<typeof vi.fn>).mock.calls[0]?.[2]).toEqual({ body });
    const missing = paperclipApprovalsPort({ client, loadConfig: async () => ({ baseUrl: 'http://paperclip', companyId: '' }) });
    await expect(missing.create(body)).rejects.toBeInstanceOf(PaperclipDisabledError);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('rethrows a non-404 get error', async () => {
    const error = new PaperclipError({ status: 503 });
    const port = paperclipApprovalsPort({ client: async () => ({ request: async () => { throw error; } }) });
    await expect(port.get('ap-1')).rejects.toBe(error);
  });

  it('never leaks a key from a rejected fetch and sends null decisionNote', async () => {
    const fetchFn = vi.fn().mockRejectedValueOnce(new Error('board-secret'))
      .mockResolvedValueOnce(response(decided));
    const port = paperclipApprovalsPort({ fetchFn, loadConfig: config, lockState: unlocked, killSwitch: enabled });
    await expect(port.decide('ap-1', 'approve', null, 'board-secret')).rejects.not.toThrow('board-secret');
    await port.decide('ap-1', 'approve', null, 'board-secret');
    expect(JSON.parse(String(fetchFn.mock.calls[1]?.[1]?.body))).toEqual({ decisionNote: null });
  });

  it('rejects malformed success bodies and unsafe board keys', async () => {
    const fetchFn = vi.fn(async () => new Response('not json'));
    const port = paperclipApprovalsPort({ fetchFn, loadConfig: config, lockState: unlocked, killSwitch: enabled });
    await expect(port.decide('ap-1', 'approve', null, 'safe')).rejects.toBeInstanceOf(PaperclipApprovalHttpError);
    await expect(port.decide('ap-1', 'approve', null, 'bad key')).rejects.toThrow();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([{ id: '', type: 'request_board_approval', status: 'pending' },
    { id: 'ap-1', type: 7, status: 'pending' }, { id: 'ap-1', type: 'request_board_approval', status: null }])
  ('rejects malformed create and decide bodies', async (bad) => {
    const port = paperclipApprovalsPort({ loadConfig: config,
      client: async () => ({ request: async <T>() => bad as T }),
      fetchFn: vi.fn(async () => response(bad)) as unknown as typeof fetch,
      lockState: unlocked, killSwitch: enabled });
    await expect(port.create({ type: 'request_board_approval', payload: {} }))
      .rejects.toBeInstanceOf(PaperclipApprovalHttpError);
    await expect(port.decide('ap-1', 'approve', null, 'board-secret'))
      .rejects.toBeInstanceOf(PaperclipApprovalHttpError);
  });
});
