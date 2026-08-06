/**
 * Identity claim tools (C4).
 *
 * Two tools: start_identity_claim issues a 6-digit code on the current
 * surface; complete_identity_claim accepts the code on another surface
 * and binds both into a single canonical identity.
 *
 * The bot calls one of these only when the user explicitly asks. The
 * code is shown to the user verbatim; they relay it themselves to the
 * other surface.
 *
 * Both tools encode the originating surface and surface-user-id from
 * the chatId. Surface prefixes the orchestrator uses:
 *   slack:CXXXX[:UYYYY[:thread]]   → surface=slack,  surfaceUserId=UYYYY (or CXXXX if absent)
 *   tg:<chatId>                     → surface=telegram, surfaceUserId=<chatId>
 *   wa:<phoneNumber>                → surface=whatsapp, surfaceUserId=<phoneNumber>
 *   <anything else>                 → no claim possible
 */

import type { Tool as BedrockTool } from '@aws-sdk/client-bedrock-runtime';
import { tools } from './registry.js';
import {
  completeClaim,
  startClaim,
  type IdentitySurface,
} from '../state/identities-repo.js';

function spec(name: string, description: string, schema: unknown): BedrockTool {
  return {
    toolSpec: {
      name,
      description,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inputSchema: { json: schema as any },
    },
  };
}

interface SurfaceRef {
  surface: IdentitySurface;
  surfaceUserId: string;
}

/**
 * Parse the surface + surfaceUserId out of a chatId. Returns
 * undefined for chatIds we cannot canonicalize (dashboard sessions,
 * system canaries, owner aliases already resolved).
 */
export function parseSurfaceRef(chatId: string): SurfaceRef | undefined {
  if (chatId.startsWith('slack:')) {
    const rest = chatId.slice('slack:'.length);
    const parts = rest.split(':');
    // slack:CXXXX                       → use channel id as surface user
    // slack:CXXXX:UYYYY                 → user id is the canonical handle
    // slack:CXXXX:UYYYY:thread          → same
    // slack:CXXXX:thread                → DM thread, use channel
    let surfaceUserId = parts[0];
    for (const seg of parts.slice(1)) {
      if (/^[UW][A-Z0-9]{5,}$/.test(seg)) {
        surfaceUserId = seg;
        break;
      }
    }
    return { surface: 'slack', surfaceUserId };
  }
  if (chatId.startsWith('tg:')) {
    return { surface: 'telegram', surfaceUserId: chatId.slice('tg:'.length) };
  }
  if (chatId.startsWith('wa:')) {
    return { surface: 'whatsapp', surfaceUserId: chatId.slice('wa:'.length) };
  }
  return undefined;
}

tools.register('start_identity_claim', {
  spec: spec(
    'start_identity_claim',
    'Begin linking this surface (Telegram chat, Slack user, or WhatsApp number) to the user\'s canonical identity. Returns a 6-digit code that the user must paste into the bot on ANOTHER surface using complete_identity_claim. Use only when the user explicitly asks to link surfaces, e.g. "claim my identity", "link my Slack and Telegram", "this is also me on the other bot".',
    {
      type: 'object',
      properties: {},
    },
  ),
  async invoke(_args, ctx) {
    const ref = parseSurfaceRef(ctx.chatId);
    if (!ref) {
      return {
        text: 'Identity claim is only available on Telegram, Slack, and WhatsApp surfaces.',
        isError: true,
      };
    }
    const pending = await startClaim(ref);
    return {
      text: `Identity claim code: ${pending.code}. Paste this into the bot on the other surface within 10 minutes by saying "complete identity claim with code ${pending.code}".`,
    };
  },
});

tools.register('complete_identity_claim', {
  spec: spec(
    'complete_identity_claim',
    'Finish linking this surface to a previously started identity claim. The user provides the 6-digit code they received on the other surface. After completion, memories and conversations from both surfaces resolve to the same canonical user.',
    {
      type: 'object',
      required: ['code'],
      properties: {
        code: {
          type: 'string',
          description: 'The 6-digit code printed by start_identity_claim on the other surface.',
        },
      },
    },
  ),
  async invoke(args, ctx) {
    const ref = parseSurfaceRef(ctx.chatId);
    if (!ref) {
      return {
        text: 'Identity claim is only available on Telegram, Slack, and WhatsApp surfaces.',
        isError: true,
      };
    }
    const code = String(args.code ?? '').trim();
    const result = await completeClaim({ ...ref, code });
    if (!result.ok) {
      return { text: result.reason, isError: true };
    }
    return {
      text: `Identity linked. Both surfaces now share memories and conversation history under canonical id ${result.canonicalId.slice(0, 8)}.`,
    };
  },
});
