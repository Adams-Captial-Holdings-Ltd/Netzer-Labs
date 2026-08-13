/**
 * Owner-scoped conversation history router. Mounted at /api/conversations
 * (see src/server.ts), before the /api catch-all.
 *
 * Both routes are strictly caller-scoped (ADR 0010): the conversation meta
 * lives under the OWNER'S partition and is only ever read there, so another
 * user's conversation is indistinguishable from a nonexistent one — a uniform
 * 404 with no existence leak. Identity comes from the principal
 * (conversationOwnerId), never from a query param.
 *
 *   GET /                    chat:read   list MY conversations (newest first)
 *   GET /:conversationId     chat:read   one conversation + full transcript
 *
 * Gated on chat:read (not sessions:read): this is the chat surface's own
 * history, unlike the org-visible admin Sessions tab. Capability resolution
 * via principalHasRouteCapability, the shared dedicated-router pattern
 * (seat-admin.ts / posture routers).
 */

import { Hono } from 'hono';
import {
  authenticateDashboardToken,
  extractBearerToken,
  type TokenPrincipal,
} from '../../lib/auth/dashboard-auth.js';
import { principalHasRouteCapability } from '../../lib/auth/route-capability.js';
import {
  conversationOwnerId,
  getConversation,
  listConversations,
  listMessages,
  type ConversationMeta,
} from '../../lib/state/conversations-repo.js';

type ConversationsEnv = { Variables: { principal: TokenPrincipal } };

/** Public view of a conversation: internal bookkeeping fields stay server-side. */
function toView(meta: ConversationMeta): {
  conversationId: string;
  title: string;
  agentId: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
} {
  return {
    conversationId: meta.conversationId,
    title: meta.title,
    agentId: meta.agentId,
    messageCount: meta.messageCount,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
  };
}

export function buildConversationsRouter(): Hono<ConversationsEnv> {
  const router = new Hono<ConversationsEnv>();

  // Authenticate every request; the capability gate is per route below.
  router.use('*', async (c, next) => {
    const raw = extractBearerToken(c.req.header('authorization'));
    const principal = await authenticateDashboardToken(raw);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    c.set('principal', principal);
    await next();
  });

  router.get('/', async (c) => {
    const principal = c.get('principal');
    if (!(await principalHasRouteCapability(principal, 'chat:read'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'chat:read' }, 403);
    }
    const conversations = await listConversations(conversationOwnerId(principal));
    return c.json({ conversations: conversations.map(toView) });
  });

  router.get('/:conversationId', async (c) => {
    const principal = c.get('principal');
    if (!(await principalHasRouteCapability(principal, 'chat:read'))) {
      return c.json({ error: 'forbidden', requiredCapability: 'chat:read' }, 403);
    }
    const conversationId = c.req.param('conversationId');
    const meta = await getConversation(conversationOwnerId(principal), conversationId);
    if (!meta) return c.json({ error: 'not_found' }, 404);
    const messages = await listMessages(conversationId, 200);
    return c.json({ conversation: toView(meta), messages });
  });

  return router;
}
