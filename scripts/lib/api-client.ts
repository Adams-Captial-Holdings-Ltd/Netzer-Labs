import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(dirname(__filename)));

function loadEnv(): Record<string, string> {
  const envPath = join(repoRoot, '.env');
  if (!existsSync(envPath)) return {};
  const text = readFileSync(envPath, 'utf-8');
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return out;
}

const env = { ...process.env, ...loadEnv() };

export function getBaseUrl(): string {
  const url = env.CCE_API_BASE_URL ?? env.ALB_DNS_NAME;
  if (!url) {
    throw new Error('CCE_API_BASE_URL or ALB_DNS_NAME not set in .env');
  }
  return url.replace(/\/+$/, '');
}

export function getDashboardToken(): string {
  const token = env.CCE_DASHBOARD_TOKEN ?? env.DASHBOARD_TOKEN;
  if (!token) {
    throw new Error('CCE_DASHBOARD_TOKEN or DASHBOARD_TOKEN not set in .env');
  }
  return token;
}

export async function apiGet<T = unknown>(path: string): Promise<T> {
  const url = `${getBaseUrl()}${path}`;
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${getDashboardToken()}`,
      Accept: 'application/json',
    },
  });
  if (!resp.ok) {
    throw new Error(`GET ${path} failed: ${resp.status} ${resp.statusText}`);
  }
  return resp.json() as Promise<T>;
}

export async function apiPost<T = unknown>(path: string, body?: unknown): Promise<T> {
  const url = `${getBaseUrl()}${path}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getDashboardToken()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    throw new Error(`POST ${path} failed: ${resp.status} ${resp.statusText}`);
  }
  return resp.json() as Promise<T>;
}
