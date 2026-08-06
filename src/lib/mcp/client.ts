/**
 * Minimal MCP (Model Context Protocol) client over Streamable HTTP.
 *
 * Speaks JSON-RPC 2.0 via HTTP POST. Two auth modes matter here:
 *   - 'iam'    → SigV4-sign the request with the task role (AgentCore
 *                gateways; service name "bedrock-agentcore").
 *   - 'bearer' → Authorization: Bearer <token> (vendor remote MCPs).
 *
 * Responses may come back as plain JSON or as text/event-stream (the spec
 * allows either for POST); both are handled. Servers that insist on an
 * initialize handshake get one transparently (the resulting session id is
 * cached per server and replayed; AgentCore gateways are stateless and skip
 * this path entirely).
 */

import { SignatureV4 } from '@smithy/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';
import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import type { McpServerConfig, McpToolInfo } from './types.js';

const PROTOCOL_VERSION = '2025-03-26';
const REQUEST_TIMEOUT_MS = 25_000;

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number | string | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

// serverId -> Mcp-Session-Id captured from an initialize handshake.
const sessions = new Map<string, string>();

let _signer: SignatureV4 | null = null;
function signer(region: string): SignatureV4 {
  if (!_signer) {
    _signer = new SignatureV4({
      service: 'bedrock-agentcore',
      region,
      credentials: defaultProvider(),
      sha256: Sha256,
    });
  }
  return _signer;
}

/** Region from a gateway host like <id>.gateway.bedrock-agentcore.us-east-1.amazonaws.com */
function regionFromUrl(url: URL): string {
  const m = url.hostname.match(/\.bedrock-agentcore\.([a-z0-9-]+)\.amazonaws\.com$/);
  return m?.[1] ?? process.env.AWS_REGION ?? 'us-east-1';
}

async function buildHeaders(
  server: McpServerConfig,
  url: URL,
  body: string,
): Promise<Record<string, string>> {
  const base: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  const sessionId = sessions.get(server.id);
  if (sessionId) base['mcp-session-id'] = sessionId;

  if (server.auth === 'bearer' && server.bearerToken) {
    return { ...base, authorization: `Bearer ${server.bearerToken}` };
  }
  if (server.auth !== 'iam') return base;

  const req = new HttpRequest({
    method: 'POST',
    protocol: url.protocol,
    hostname: url.hostname,
    path: url.pathname + url.search,
    headers: { ...base, host: url.hostname },
    body,
  });
  const signed = await signer(regionFromUrl(url)).sign(req);
  return signed.headers as Record<string, string>;
}

/** Extract the JSON-RPC response from a plain-JSON or SSE body. */
function parseRpcBody(text: string, contentType: string): JsonRpcResponse {
  if (contentType.includes('text/event-stream')) {
    // Take the last data: payload that parses as a JSON-RPC response.
    let last: JsonRpcResponse | null = null;
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        const obj = JSON.parse(line.slice(5).trim()) as JsonRpcResponse;
        if (obj && obj.jsonrpc === '2.0' && ('result' in obj || 'error' in obj)) last = obj;
      } catch {
        // keep-alives and partial frames are expected; skip
      }
    }
    if (!last) throw new Error('no JSON-RPC response in event stream');
    return last;
  }
  return JSON.parse(text) as JsonRpcResponse;
}

let rpcId = 0;

async function rpc(
  server: McpServerConfig,
  method: string,
  params: Record<string, unknown>,
  allowInitRetry = true,
): Promise<Record<string, unknown>> {
  const url = new URL(server.url);
  const body = JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params });
  const headers = await buildHeaders(server, url, body);

  const res = await fetch(server.url, {
    method: 'POST',
    headers,
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const sessionHeader = res.headers.get('mcp-session-id');
  if (sessionHeader) sessions.set(server.id, sessionHeader);

  const text = await res.text();
  if (!res.ok) {
    // Some servers reject non-initialized sessions with 400/404; one
    // transparent initialize + retry covers them.
    if (allowInitRetry && (res.status === 400 || res.status === 404) && method !== 'initialize') {
      await initialize(server);
      return rpc(server, method, params, false);
    }
    throw new Error(`MCP ${method} HTTP ${res.status}: ${text.slice(0, 300)}`);
  }

  const parsed = parseRpcBody(text, res.headers.get('content-type') ?? '');
  if (parsed.error) {
    if (allowInitRetry && method !== 'initialize' && parsed.error.code === -32002) {
      await initialize(server);
      return rpc(server, method, params, false);
    }
    throw new Error(`MCP ${method} error ${parsed.error.code}: ${parsed.error.message}`);
  }
  return parsed.result ?? {};
}

async function initialize(server: McpServerConfig): Promise<void> {
  sessions.delete(server.id);
  await rpc(
    server,
    'initialize',
    {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'claudeclaw-enterprise', version: '1.0.0' },
    },
    false,
  );
}

/** List the server's tools. Throws on transport/auth failure. */
export async function mcpListTools(server: McpServerConfig): Promise<McpToolInfo[]> {
  const result = await rpc(server, 'tools/list', {});
  const tools = Array.isArray(result.tools) ? result.tools : [];
  return tools
    .filter((t): t is Record<string, unknown> => Boolean(t) && typeof t === 'object')
    .filter((t) => typeof t.name === 'string')
    .map((t) => ({
      name: t.name as string,
      ...(typeof t.description === 'string' ? { description: t.description } : {}),
      ...(t.inputSchema && typeof t.inputSchema === 'object'
        ? { inputSchema: t.inputSchema as Record<string, unknown> }
        : {}),
    }));
}

/** Call one tool; returns flattened text + isError per MCP semantics. */
export async function mcpCallTool(
  server: McpServerConfig,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const result = await rpc(server, 'tools/call', { name: toolName, arguments: args });
  const content = Array.isArray(result.content) ? result.content : [];
  const text = content
    .filter((b): b is Record<string, unknown> => Boolean(b) && typeof b === 'object')
    .map((b) => (typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n');
  return {
    text: text || JSON.stringify(result.structuredContent ?? result),
    isError: result.isError === true,
  };
}

/** Test hook: reset cached sessions/signer between unit tests. */
export function resetMcpClientState(): void {
  sessions.clear();
  _signer = null;
}
