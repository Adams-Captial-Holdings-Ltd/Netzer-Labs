/**
 * MCP server registry, stored as one JSON value in runtime-config
 * (category 'mcp', key 'servers'). Reuses that repo's 30s cache + SNS
 * invalidation, so a dashboard edit reaches all tasks within seconds and no
 * redeploy is ever needed — same operational story as channel connections.
 */

import { getConfig, setConfig } from '../state/runtime-config-repo.js';
import { logger } from '../../observability/logger.js';
import type { McpServerConfig } from './types.js';

const CATEGORY = 'mcp';
const KEY = 'servers';

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/**
 * Block SSRF targets: the MCP client fetches these URLs from inside the VPC and,
 * in auth:'iam' mode, SigV4-signs them with the task role. Reject the cloud
 * metadata endpoint, loopback, link-local, RFC-1918 / CGNAT private ranges, and
 * internal TLDs. Note: this is a static host/IP check at registration+read time;
 * it does not defend against DNS rebinding (a public name resolving to a private
 * IP at fetch time), which needs resolve-and-pin at the fetch layer — tracked
 * separately. It does close the direct-literal and obvious-name vectors.
 */
function isBlockedV4(a: number, b: number, c: number, d: number): boolean {
  if ([a, b, c, d].some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 (IMDS)
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a >= 224) return true; // multicast / reserved
  return false;
}

/**
 * Parse an IPv6 literal (brackets already stripped; optional zone id, optional
 * embedded IPv4 tail) into its 16 bytes, or null if it isn't a valid literal.
 * URL hostname normalization compresses IPv4-mapped forms to hex
 * (`::ffff:169.254.169.254` -> `::ffff:a9fe:a9fe`), so a dotted-quad-only check
 * misses them — parsing to bytes catches every spelling.
 */
function ipv6ToBytes(input: string): number[] | null {
  let s = input;
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct); // drop zone id
  // Embedded IPv4 tail -> two hex groups.
  if (s.includes('.')) {
    const lastColon = s.lastIndexOf(':');
    if (lastColon < 0) return null;
    const m = s.slice(lastColon + 1).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m) return null;
    const o = m.slice(1, 5).map(Number);
    if (o.some((n) => n > 255)) return null;
    s = `${s.slice(0, lastColon + 1)}${((o[0] << 8) | o[1]).toString(16)}:${(
      (o[2] << 8) |
      o[3]
    ).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const out: number[] = [];
    for (const g of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = toGroups(halves[0]);
  const tail = halves.length === 2 ? toGroups(halves[1]) : [];
  if (head === null || tail === null) return null;
  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = [...head, ...new Array(fill).fill(0), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const bytes: number[] = [];
  for (const g of groups) bytes.push((g >> 8) & 0xff, g & 0xff);
  return bytes;
}

export function isBlockedMcpHost(host: string): boolean {
  let h = host.toLowerCase().replace(/\.$/, '');
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1); // bracketed IPv6
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.internal') || h.endsWith('.local')) return true;
  if (h === 'metadata.google.internal') return true;
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) return isBlockedV4(Number(v4[1]), Number(v4[2]), Number(v4[3]), Number(v4[4]));
  if (h.includes(':')) {
    const bytes = ipv6ToBytes(h);
    if (!bytes) {
      // Unparseable as IPv6 — conservative string backstop.
      return h === '::1' || h === '::' || /^f[cd]/.test(h) || h.startsWith('fe80');
    }
    if (bytes.every((x) => x === 0)) return true; // ::
    if (bytes.slice(0, 15).every((x) => x === 0) && bytes[15] === 1) return true; // ::1
    if ((bytes[0] & 0xfe) === 0xfc) return true; // fc00::/7 unique-local
    if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return true; // fe80::/10 link-local
    // IPv4-mapped ::ffff:a.b.c.d (any spelling, incl. hex-compressed).
    if (bytes.slice(0, 10).every((x) => x === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
      return isBlockedV4(bytes[12], bytes[13], bytes[14], bytes[15]);
    }
    // IPv4-compatible ::a.b.c.d (deprecated) — first 12 bytes zero, non-trivial tail.
    if (bytes.slice(0, 12).every((x) => x === 0) && !(bytes[12] === 0 && bytes[13] === 0)) {
      return isBlockedV4(bytes[12], bytes[13], bytes[14], bytes[15]);
    }
    return false;
  }
  return false;
}

/** https:// only, and not pointed at a private/metadata host. */
export function isAllowedMcpUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  return !isBlockedMcpHost(u.hostname);
}

function sanitize(raw: unknown): McpServerConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) return null;
  if (typeof r.url !== 'string' || !isAllowedMcpUrl(r.url)) return null;
  const auth = r.auth === 'iam' || r.auth === 'bearer' || r.auth === 'none' ? r.auth : null;
  if (!auth) return null;
  return {
    id: r.id,
    name: typeof r.name === 'string' && r.name.trim() ? r.name.trim() : r.id,
    url: r.url,
    auth,
    ...(auth === 'bearer' && typeof r.bearerToken === 'string'
      ? { bearerToken: r.bearerToken }
      : {}),
    enabled: r.enabled !== false,
    agents: Array.isArray(r.agents) ? r.agents.filter((a): a is string => typeof a === 'string') : [],
  };
}

/** All configured MCP servers (invalid entries dropped, never throws). */
export async function listMcpServers(): Promise<McpServerConfig[]> {
  const raw = await getConfig(CATEGORY, KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(sanitize).filter((s): s is McpServerConfig => s !== null);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'mcp servers config unparseable — treating as empty',
    );
    return [];
  }
}

/** Enabled servers whose agent allowlist admits this agent. */
export async function mcpServersForAgent(agentId: string): Promise<McpServerConfig[]> {
  const all = await listMcpServers();
  return all.filter((s) => s.enabled && (s.agents.length === 0 || s.agents.includes(agentId)));
}

/** Replace the full server list (dashboard writes go through here). */
export async function saveMcpServers(
  servers: McpServerConfig[],
  updatedBy: string,
): Promise<McpServerConfig[]> {
  const clean = servers.map(sanitize).filter((s): s is McpServerConfig => s !== null);
  const ids = new Set<string>();
  for (const s of clean) {
    if (ids.has(s.id)) throw new Error(`duplicate MCP server id: ${s.id}`);
    ids.add(s.id);
  }
  await setConfig(CATEGORY, KEY, JSON.stringify(clean), { updatedBy });
  return clean;
}
