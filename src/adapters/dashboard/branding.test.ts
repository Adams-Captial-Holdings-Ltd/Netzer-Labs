import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import type { TokenPrincipal } from '../../lib/auth/dashboard-auth.js';

// Router contract + security test for the white-label branding endpoints. Drives
// the REAL buildBrandingRouter through app.request() with AWS stubbed out. Locks:
//   - GET /asset/:id is PUBLIC and serves with image content-type + immutable cache
//   - the asset-id / staging-key validators actually gate traversal
//   - upload-url + commit are admin-only and reject non-image filenames
// The pure validators (isBrandingAssetId, brandingExtFromFilename, isUploadKey)
// are kept REAL via importActual; only the S3-touching functions are stubbed.

function principalFor(raw: string): TokenPrincipal | null {
  const role = raw.replace(/^Bearer\s+/i, '');
  if (role !== 'viewer' && role !== 'operator' && role !== 'admin') return null;
  return { tokenHash: `hash-${role}`, label: role, hashPrefix16: role, role };
}

vi.mock('../../lib/auth/dashboard-auth.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/auth/dashboard-auth.js')>();
  return {
    ...actual,
    extractBearerToken: (authHeader?: string) => (authHeader ?? '').replace(/^Bearer\s+/i, ''),
    authenticateDashboardToken: (raw: string) => Promise.resolve(principalFor(raw)),
  };
});

const writeAudit = vi.fn((_event: unknown) => Promise.resolve());
vi.mock('../../lib/audit/audit-writer.js', () => ({ writeAudit: (e: unknown) => writeAudit(e) }));

// vectors/store: keep the real pure key helpers, stub only the presign (AWS).
const presignUploadUrl = vi.fn();
vi.mock('../../lib/vectors/store.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/vectors/store.js')>();
  return { ...actual, presignUploadUrl: (key: string) => presignUploadUrl(key) };
});

// branding/assets: keep the real validators, stub the S3 copy + read.
const commitBrandingAsset = vi.fn();
const getBrandingObject = vi.fn();
vi.mock('../../lib/branding/assets.js', async (importActual) => {
  const actual = await importActual<typeof import('../../lib/branding/assets.js')>();
  return {
    ...actual,
    commitBrandingAsset: (s: string, a: string) => commitBrandingAsset(s, a),
    getBrandingObject: (id: string) => getBrandingObject(id),
  };
});

import { buildBrandingRouter } from './branding.js';
import { isBrandingAssetId } from '../../lib/branding/assets.js';

const readJson = async (res: Response): Promise<Record<string, unknown>> =>
  (await res.json()) as Record<string, unknown>;

function makeApp() {
  const app = new Hono();
  app.route('/api/branding', buildBrandingRouter());
  return app;
}

function req(method: string, path: string, role?: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (role) headers.Authorization = `Bearer ${role}`;
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  return makeApp().request(`/api/branding${path}`, init);
}

beforeEach(() => {
  presignUploadUrl.mockReset();
  commitBrandingAsset.mockReset();
  getBrandingObject.mockReset();
  writeAudit.mockReset();
});

describe('branding router — GET /asset/:id (public)', () => {
  it('serves the bytes with image content-type + immutable cache, no auth required', async () => {
    getBrandingObject.mockResolvedValue({ body: new Uint8Array([1, 2, 3]), contentType: 'image/png' });
    const res = await req('GET', '/asset/abc123.png'); // no Authorization header
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('404s when the asset does not exist', async () => {
    getBrandingObject.mockResolvedValue(null);
    expect((await req('GET', '/asset/missing.png')).status).toBe(404);
  });

  it('rejects a malformed single-segment asset id with 400 and never touches S3', async () => {
    // All single-segment so they reach the handler (multi-segment ids like
    // "a/b.png" are a routing 404, also safe but a different code path).
    for (const bad of ['noextension', 'bad..name.png', 'space%20name.png']) {
      const res = await req('GET', `/asset/${bad}`);
      expect(res.status).toBe(400);
    }
    expect(getBrandingObject).not.toHaveBeenCalled();
  });

  it('the asset-id validator refuses traversal and accepts a normal id', () => {
    expect(isBrandingAssetId('../../etc/passwd')).toBe(false);
    expect(isBrandingAssetId('a/b.png')).toBe(false);
    expect(isBrandingAssetId('logo..png')).toBe(false);
    expect(isBrandingAssetId('9f3c2b1a.png')).toBe(true);
  });
});

describe('branding router — POST /upload-url (admin)', () => {
  it('mints a presigned PUT + assetId for an admin and a valid image filename', async () => {
    presignUploadUrl.mockResolvedValue('https://s3.example/put?sig=1');
    const res = await req('POST', '/upload-url', 'admin', { filename: 'My Logo.PNG' });
    expect(res.status).toBe(200);
    const json = await readJson(res);
    expect(json.url).toBe('https://s3.example/put?sig=1');
    expect(String(json.assetId)).toMatch(/\.png$/); // extension normalized + carried
    expect(String(json.stagingKey)).toMatch(/^uploads\//); // staged under the guarded prefix
    expect(presignUploadUrl).toHaveBeenCalledOnce();
  });

  it('rejects a non-image filename with 400 and never presigns', async () => {
    const res = await req('POST', '/upload-url', 'admin', { filename: 'payload.svgz.exe' });
    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toBe('unsupported_type');
    expect(presignUploadUrl).not.toHaveBeenCalled();
  });

  it('is admin-only', async () => {
    expect((await req('POST', '/upload-url', undefined, { filename: 'a.png' })).status).toBe(401);
    expect((await req('POST', '/upload-url', 'viewer', { filename: 'a.png' })).status).toBe(403);
    expect((await req('POST', '/upload-url', 'operator', { filename: 'a.png' })).status).toBe(403);
  });
});

describe('branding router — POST /commit (admin)', () => {
  it('promotes a staged upload and returns the stable asset URL', async () => {
    commitBrandingAsset.mockResolvedValue(undefined);
    const res = await req('POST', '/commit', 'admin', {
      assetId: 'logo-1.png',
      stagingKey: 'uploads/uuid/branding.png',
    });
    expect(res.status).toBe(200);
    const json = await readJson(res);
    expect(json).toMatchObject({ ok: true, assetId: 'logo-1.png', assetUrl: '/api/branding/asset/logo-1.png' });
    expect(commitBrandingAsset).toHaveBeenCalledWith('uploads/uuid/branding.png', 'logo-1.png');
    expect(writeAudit).toHaveBeenCalledOnce();
  });

  it('rejects a non-staging key so it can only promote real uploads', async () => {
    const res = await req('POST', '/commit', 'admin', {
      assetId: 'logo-1.png',
      stagingKey: 'agents/main/CLAUDE.md', // not under uploads/
    });
    expect(res.status).toBe(400);
    expect(commitBrandingAsset).not.toHaveBeenCalled();
  });

  it('rejects a malformed asset id', async () => {
    const res = await req('POST', '/commit', 'admin', {
      assetId: '../escape',
      stagingKey: 'uploads/uuid/branding.png',
    });
    expect(res.status).toBe(400);
    expect(commitBrandingAsset).not.toHaveBeenCalled();
  });

  it('is admin-only', async () => {
    const body = { assetId: 'logo-1.png', stagingKey: 'uploads/uuid/branding.png' };
    expect((await req('POST', '/commit', undefined, body)).status).toBe(401);
    expect((await req('POST', '/commit', 'viewer', body)).status).toBe(403);
    expect((await req('POST', '/commit', 'operator', body)).status).toBe(403);
  });
});
