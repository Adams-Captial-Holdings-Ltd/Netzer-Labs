import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import {
  authenticateDashboardToken,
  extractBearerToken,
  type TokenPrincipal,
} from '../../lib/auth/dashboard-auth.js';
import { writeAudit } from '../../lib/audit/audit-writer.js';
import { logger } from '../../observability/logger.js';
import { presignUploadUrl, uploadKeyFor, isUploadKey } from '../../lib/vectors/store.js';
import {
  brandingExtFromFilename,
  commitBrandingAsset,
  getBrandingObject,
  isBrandingAssetId,
} from '../../lib/branding/assets.js';

type BrandingEnv = { Variables: { principal: TokenPrincipal } };

// Branding writes match the admin gate that protects theme persistence: themes
// are saved via POST /config/themes/library (admin-only), and a logo upload is
// only useful as part of saving a theme, so it carries the same bar.
const ROLE_RANK: Record<TokenPrincipal['role'], number> = { viewer: 0, operator: 1, admin: 2 };

/**
 * White-label branding asset router (mounted at /api/branding).
 *
 *   GET  /asset/:id   PUBLIC  — serve a logo/favicon. An <img src> can't carry a
 *                              bearer, and the logo must render on the pre-auth
 *                              login screen, so this is intentionally unauthed.
 *   POST /upload-url  ADMIN   — mint a presigned PUT into the CORS-enabled staging
 *                              bucket (bypasses the CloudFront WAF 8KB body cap).
 *   POST /commit      ADMIN   — promote the staged file into the persistent
 *                              curated bucket and return its stable asset URL.
 *
 * Auth is per-route (not a router-wide use('*') gate) precisely because GET must
 * stay public while the two writes are admin-only.
 */
export function buildBrandingRouter(): Hono<BrandingEnv> {
  const router = new Hono<BrandingEnv>();

  router.get('/asset/:id', async (c) => {
    const id = c.req.param('id');
    if (!isBrandingAssetId(id)) return c.json({ error: 'invalid_asset_id' }, 400);
    try {
      const obj = await getBrandingObject(id);
      if (!obj) return c.json({ error: 'not_found' }, 404);
      return new Response(obj.body, {
        status: 200,
        headers: {
          'Content-Type': obj.contentType,
          // The asset id is unique per upload, so the bytes never change: cache hard.
          'Cache-Control': 'public, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
          // Neuters any script in a directly-opened SVG; irrelevant to <img> loads.
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        },
      });
    } catch (err) {
      logger.warn(
        { errMessage: err instanceof Error ? err.message : String(err), id },
        'branding asset fetch failed',
      );
      return c.json({ error: 'asset_fetch_failed' }, 500);
    }
  });

  router.post('/upload-url', async (c) => {
    const principal = await authenticateDashboardToken(extractBearerToken(c.req.header('authorization')));
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    if (ROLE_RANK[principal.role] < ROLE_RANK.admin) {
      return c.json({ error: 'forbidden', requiredRole: 'admin', yourRole: principal.role }, 403);
    }
    const body = await c.req.json<{ filename?: string }>().catch(() => null);
    const ext = brandingExtFromFilename(body?.filename ?? '');
    if (!ext) {
      return c.json(
        {
          error: 'unsupported_type',
          detail: 'file must be a .png, .jpg, .jpeg, .gif, .webp, .svg, or .ico image',
        },
        400,
      );
    }
    const assetId = `${randomUUID()}.${ext}`;
    // Stage under the upload-staging prefix the vectors path already guards.
    const stagingKey = uploadKeyFor(`branding.${ext}`, randomUUID());
    try {
      const url = await presignUploadUrl(stagingKey);
      return c.json({ url, assetId, stagingKey });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.warn({ errMessage: detail }, 'branding presign upload url failed');
      return c.json({ error: 'presign_failed', detail }, 400);
    }
  });

  router.post('/commit', async (c) => {
    const principal = await authenticateDashboardToken(extractBearerToken(c.req.header('authorization')));
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    if (ROLE_RANK[principal.role] < ROLE_RANK.admin) {
      return c.json({ error: 'forbidden', requiredRole: 'admin', yourRole: principal.role }, 403);
    }
    const body = await c.req.json<{ assetId?: string; stagingKey?: string }>().catch(() => null);
    const assetId = body?.assetId ?? '';
    const stagingKey = body?.stagingKey ?? '';
    if (!isBrandingAssetId(assetId)) return c.json({ error: 'invalid_asset_id' }, 400);
    // Only promote a real upload-staging key, never an arbitrary object.
    if (!isUploadKey(stagingKey)) return c.json({ error: 'invalid_staging_key' }, 400);
    try {
      await commitBrandingAsset(stagingKey, assetId);
      const assetUrl = `/api/branding/asset/${assetId}`;
      void writeAudit({
        action: 'media_upload',
        detail: { kind: 'branding', assetId, assetUrl },
        userId: principal.hashPrefix16 ?? 'dashboard',
        operatorLabel: principal.label ?? undefined,
        surface: 'dashboard',
        result: 'ok',
      });
      return c.json({ ok: true, assetUrl, assetId });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.warn({ errMessage: detail, assetId }, 'branding commit (copy to curated) failed');
      return c.json({ error: 'commit_failed', detail }, 400);
    }
  });

  return router;
}
