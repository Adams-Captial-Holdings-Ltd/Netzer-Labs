import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── servers-repo: backed by mocked runtime-config ──────────────────────
const configStore = new Map<string, string>();
vi.mock('../state/runtime-config-repo.js', () => ({
  getConfig: vi.fn(async (cat: string, key: string) => configStore.get(`${cat}/${key}`)),
  setConfig: vi.fn(async (cat: string, key: string, value: string) => {
    configStore.set(`${cat}/${key}`, value);
  }),
}));

import { listMcpServers, mcpServersForAgent, saveMcpServers } from './servers-repo.js';
import { mcpListTools, mcpCallTool, resetMcpClientState } from './client.js';
import { mcpToolsFor, invokeMcpTool, isMcpToolName, resetMcpToolsState } from './mcp-tools.js';
import type { McpServerConfig } from './types.js';

const GW: McpServerConfig = {
  id: 'gw1',
  name: 'Gateway One',
  url: 'https://abc.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp',
  auth: 'none', // 'none' in tests: no credential chain in CI
  enabled: true,
  agents: [],
};

function rpcResult(id: number | string | null, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function jsonResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

beforeEach(() => {
  configStore.clear();
  resetMcpClientState();
  resetMcpToolsState();
  vi.restoreAllMocks();
});

describe('mcp servers-repo', () => {
  it('returns [] when unset and drops invalid entries', async () => {
    expect(await listMcpServers()).toEqual([]);
    configStore.set(
      'mcp/servers',
      JSON.stringify([
        GW,
        { id: 'BAD ID!', url: GW.url, auth: 'none' }, // bad id
        { id: 'no-tls', url: 'http://x.test/mcp', auth: 'none' }, // not https
        { id: 'bad-auth', url: GW.url, auth: 'kerberos' }, // unknown auth
      ]),
    );
    const list = await listMcpServers();
    expect(list.map((s) => s.id)).toEqual(['gw1']);
  });

  it('filters by agent allowlist (empty = all agents)', async () => {
    configStore.set(
      'mcp/servers',
      JSON.stringify([
        GW,
        { ...GW, id: 'gw2', agents: ['ops'] },
        { ...GW, id: 'gw3', enabled: false },
      ]),
    );
    expect((await mcpServersForAgent('main')).map((s) => s.id)).toEqual(['gw1']);
    expect((await mcpServersForAgent('ops')).map((s) => s.id)).toEqual(['gw1', 'gw2']);
  });

  it('saveMcpServers rejects duplicate ids', async () => {
    await expect(saveMcpServers([GW, { ...GW }], 'test')).rejects.toThrow(/duplicate/);
  });
});

describe('mcp client', () => {
  it('lists tools from a plain-JSON response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(
          rpcResult(1, {
            tools: [
              { name: 'get_weather', description: 'wx', inputSchema: { type: 'object' } },
              { name: 'get_time' },
            ],
          }),
        ),
      ),
    );
    const tools = await mcpListTools(GW);
    expect(tools.map((t) => t.name)).toEqual(['get_weather', 'get_time']);
    expect(tools[0]?.inputSchema).toEqual({ type: 'object' });
  });

  it('parses SSE bodies and flattens tools/call content', async () => {
    const sse = [
      ': keep-alive',
      `data: ${rpcResult(2, { content: [{ type: 'text', text: 'sunny, 21C' }], isError: false })}`,
      '',
    ].join('\n');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })),
    );
    const out = await mcpCallTool(GW, 'get_weather', { city: 'Toronto' });
    expect(out).toEqual({ text: 'sunny, 21C', isError: false });
  });

  it('sends a bearer token when configured', async () => {
    const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      jsonResponse(rpcResult(3, { tools: [] })),
    );
    vi.stubGlobal('fetch', fetchMock);
    await mcpListTools({ ...GW, auth: 'bearer', bearerToken: 'tok123' });
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok123');
  });

  it('surfaces JSON-RPC errors as thrown errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse(JSON.stringify({ jsonrpc: '2.0', id: 4, error: { code: -32601, message: 'no such tool' } })),
      ),
    );
    await expect(mcpCallTool(GW, 'nope', {})).rejects.toThrow(/no such tool/);
  });
});

describe('mcp-tools bridge', () => {
  it('namespaces gateway tools into Bedrock specs and dispatches back', async () => {
    configStore.set('mcp/servers', JSON.stringify([GW]));
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method: string; id: number };
      if (body.method === 'tools/list') {
        return jsonResponse(
          rpcResult(body.id, {
            tools: [{ name: 'demo-tools___get_weather', description: 'wx' }],
          }),
        );
      }
      return jsonResponse(
        rpcResult(body.id, { content: [{ type: 'text', text: '21C and clear' }] }),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const specs = await mcpToolsFor('main');
    expect(specs).toHaveLength(1);
    const name = specs[0]?.toolSpec?.name ?? '';
    expect(name).toBe('mcp__gw1__demo-tools___get_weather');
    expect(isMcpToolName(name)).toBe(true);

    const result = await invokeMcpTool(name, { city: 'Toronto' }, { agentId: 'main', chatId: 'c1' });
    expect(result.text).toBe('21C and clear');
    expect(result.isError).toBeUndefined();
    // The dispatched tools/call must carry the ORIGINAL tool name, not the namespaced one.
    const callBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      params: { name: string };
    };
    expect(callBody.params.name).toBe('demo-tools___get_weather');
  });

  it('fails soft when tools/list errors: agent gets no MCP tools, no throw', async () => {
    configStore.set('mcp/servers', JSON.stringify([GW]));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    expect(await mcpToolsFor('main')).toEqual([]);
  });

  it('returns an isError ToolResult for unknown dispatch names', async () => {
    const out = await invokeMcpTool('mcp__ghost__tool', {}, { agentId: 'main', chatId: 'c1' });
    expect(out.isError).toBe(true);
  });

  it('blocks dispatch to a server the calling agent is not allowed to reach', async () => {
    // gw1 is open to all agents; gw2 is restricted to 'ops'. Both tool
    // mappings land in the module-global nameMap once 'ops' lists them.
    configStore.set(
      'mcp/servers',
      JSON.stringify([GW, { ...GW, id: 'gw2', agents: ['ops'] }]),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { method: string; id: number };
        return jsonResponse(
          body.method === 'tools/list'
            ? rpcResult(body.id, { tools: [{ name: 'get_weather' }] })
            : rpcResult(body.id, { content: [{ type: 'text', text: 'ok' }] }),
        );
      }),
    );

    // 'ops' populates nameMap with both gw1 and gw2 tool mappings.
    await mcpToolsFor('ops');

    // 'main' may reach gw1 but NOT gw2 — dispatch to the gw2 tool is denied
    // even though the mapping exists globally.
    const denied = await invokeMcpTool('mcp__gw2__get_weather', {}, { agentId: 'main', chatId: 'c1' });
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/not authorized/i);

    // 'ops' is allowed on gw2, so the same call succeeds for it.
    const allowed = await invokeMcpTool('mcp__gw2__get_weather', {}, { agentId: 'ops', chatId: 'c1' });
    expect(allowed.isError).toBeUndefined();
    expect(allowed.text).toBe('ok');
  });

  it('denies a tool after the caller loses access, even with the mapping cached', async () => {
    // gw1 open to all; 'main' lists it and the mapping lands in nameMap.
    configStore.set('mcp/servers', JSON.stringify([GW]));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as { method: string; id: number };
        return jsonResponse(
          body.method === 'tools/list'
            ? rpcResult(body.id, { tools: [{ name: 'get_weather' }] })
            : rpcResult(body.id, { content: [{ type: 'text', text: 'ok' }] }),
        );
      }),
    );
    const specs = await mcpToolsFor('main');
    const toolName = specs[0]?.toolSpec?.name ?? '';
    expect((await invokeMcpTool(toolName, {}, { agentId: 'main', chatId: 'c1' })).text).toBe('ok');

    // Access is narrowed to 'ops' only. The cached nameMap entry still exists,
    // but dispatch must re-check and deny 'main'.
    configStore.set('mcp/servers', JSON.stringify([{ ...GW, agents: ['ops'] }]));
    const out = await invokeMcpTool(toolName, {}, { agentId: 'main', chatId: 'c1' });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/not authorized/i);
  });

  it('truncates oversized tool results', async () => {
    configStore.set('mcp/servers', JSON.stringify([GW]));
    const big = 'x'.repeat(20_000);
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { method: string; id: number };
      return jsonResponse(
        body.method === 'tools/list'
          ? rpcResult(body.id, { tools: [{ name: 'big' }] })
          : rpcResult(body.id, { content: [{ type: 'text', text: big }] }),
      );
    }));
    const specs = await mcpToolsFor('main');
    const out = await invokeMcpTool(specs[0]?.toolSpec?.name ?? '', {}, { agentId: 'main', chatId: 'c1' });
    expect(out.text.length).toBeLessThan(16_100);
    expect(out.text).toContain('[truncated');
  });
});
