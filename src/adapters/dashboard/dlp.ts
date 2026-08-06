import { Hono } from 'hono';
import { scanForExfil, getActivePatterns } from '../../lib/safety/exfil-guard.js';
import { saveCustomPattern, deleteCustomPattern, getCustomPatterns } from '../../lib/state/exfil-patterns-repo.js';
import { authenticateDashboardToken, extractBearerToken, type TokenPrincipal } from '../../lib/auth/dashboard-auth.js';
import { writeAudit } from '../../lib/audit/audit-writer.js';
import type { ExfilPattern } from '../../lib/safety/exfil-patterns.js';

type DlpEnv = { Variables: { principal: TokenPrincipal } };

const ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

export function buildDlpRouter(): Hono<DlpEnv> {
  const router = new Hono<DlpEnv>();

  router.use('*', async (c, next) => {
    const raw = extractBearerToken(c.req.header('authorization'));
    const principal = await authenticateDashboardToken(raw);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    // DLP/exfil pattern inspection is admin-only.
    if (principal.role !== 'admin') {
      return c.json({ error: 'forbidden', requiredRole: 'admin', yourRole: principal.role }, 403);
    }
    c.set('principal', principal);
    await next();
  });

  router.post('/test', async (c) => {
    const body = await c.req.json<{ text?: string }>();
    if (!body.text) return c.json({ error: 'text required' }, 400);
    const result = await scanForExfil(body.text);
    return c.json(result);
  });

  router.get('/patterns', async (c) => {
    const patterns = await getActivePatterns();
    return c.json({ patterns });
  });

  router.post('/validate', async (c) => {
    const body = await c.req.json<{ regex?: string }>();
    if (!body.regex) return c.json({ error: 'regex required' }, 400);
    try {
      new RegExp(body.regex);
      return c.json({ valid: true });
    } catch (err) {
      return c.json({ valid: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Persist a custom (operator-supplied) pattern. Built-in patterns are not
  // editable here; custom patterns are additive and take effect within the
  // exfil-guard cache TTL (~30s) across all workers.
  router.post('/patterns', async (c) => {
    const body = await c.req.json<Partial<ExfilPattern>>().catch(() => ({} as Partial<ExfilPattern>));
    const id = (body.id ?? '').trim().toLowerCase();
    const name = (body.name ?? '').trim();
    const regex = body.regex ?? '';
    const severity = body.severity;

    if (!ID_RE.test(id)) {
      return c.json({ error: 'id must be 2-64 chars: lowercase letters, digits, _ or -' }, 400);
    }
    if (!name) return c.json({ error: 'name required' }, 400);
    if (!regex) return c.json({ error: 'regex required' }, 400);
    if (severity !== 'block' && severity !== 'warn') {
      return c.json({ error: "severity must be 'block' or 'warn'" }, 400);
    }
    try {
      new RegExp(regex);
    } catch (err) {
      return c.json({ error: `invalid regex: ${err instanceof Error ? err.message : String(err)}` }, 400);
    }

    const pattern: ExfilPattern = { id, name, regex, severity, enabled: true };
    const patterns = await saveCustomPattern(pattern);

    const principal = c.get('principal');
    void writeAudit({
      action: 'exfil_pattern_added',
      detail: { id, name, severity },
      userId: principal?.hashPrefix16 ?? 'dashboard',
      operatorLabel: principal?.label ?? undefined,
      surface: 'dashboard',
      result: 'ok',
    });

    return c.json({ ok: true, pattern, patterns });
  });

  router.delete('/patterns/:id', async (c) => {
    const id = c.req.param('id');
    const before = await getCustomPatterns(true);
    if (!before.some((p) => p.id === id)) {
      // Either it's a built-in (not removable) or it never existed.
      return c.json({ error: 'no custom pattern with that id' }, 404);
    }
    const patterns = await deleteCustomPattern(id);

    const principal = c.get('principal');
    void writeAudit({
      action: 'exfil_pattern_removed',
      detail: { id },
      userId: principal?.hashPrefix16 ?? 'dashboard',
      operatorLabel: principal?.label ?? undefined,
      surface: 'dashboard',
      result: 'ok',
    });

    return c.json({ ok: true, patterns });
  });

  return router;
}
