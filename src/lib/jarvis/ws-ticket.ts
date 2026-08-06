/**
 * Scoped, single-use WebSocket tickets (JARVIS-PLAN.md §1b H10 + Reference
 * Contracts B / D).
 *
 * The browser cannot set an Authorization header on a WS upgrade, and the raw
 * cce_token must NEVER ride the socket (subprotocol metadata is captured by
 * proxies/APM, and the token is a full reusable dashboard credential). Instead
 * the client calls POST /api/jarvis/ws-ticket over authenticated HTTPS to mint
 * a short-lived (~30s), single-use, Jarvis-scoped ticket stored in DDB holding
 * the RESOLVED principal {tokenHash, role, label} — never the raw token. The
 * client puts only the ticket in Sec-WebSocket-Protocol; the relay consumes it
 * atomically on upgrade.
 *
 * Table `claudeclaw-jarvis-tickets`: PK attribute `ticket` (random 256-bit),
 * attrs {tokenHash, role, label, expiresAt}, TTL=`expiresAt`. TTL deletion is
 * ASYNC, so it is NOT the expiry check — consume is conditioned on
 * `expiresAt >= :now` so a still-present-but-expired ticket fails (closes the
 * async-TTL reuse window).
 */

import { randomBytes } from 'node:crypto';
import { PutCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../state/ddb.js';
import { logger } from '../../observability/logger.js';
import type { TokenPrincipal } from '../auth/dashboard-auth.js';
import type { JarvisRole } from './route-manifest.js';

const TABLE = process.env.TABLE_JARVIS_TICKETS ?? 'claudeclaw-jarvis-tickets';

/** Ticket lifetime. Short by design — a leaked ticket is single-use + scoped. */
export const TICKET_TTL_SECONDS = 30;

export interface TicketPrincipal {
  tokenHash: string;
  role: JarvisRole;
  label: string;
  /** Whether the session should open with the spoken greeting. False on a
   *  transient reconnect so "How are you, sir?" doesn't replay. Defaults true. */
  greet?: boolean;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Mint a single-use ticket for the authenticated principal. The raw token is
 * never stored — only the resolved {tokenHash, role, label}. Returns the opaque
 * ticket id the client passes as the subprotocol value.
 */
export async function mintWsTicket(principal: TokenPrincipal, greet = true): Promise<string> {
  const ticket = randomBytes(32).toString('base64url'); // 256-bit
  const expiresAt = nowSec() + TICKET_TTL_SECONDS;
  await ddb().send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        ticket,
        tokenHash: principal.tokenHash,
        role: principal.role,
        label: principal.label,
        greet,
        expiresAt,
      },
    }),
  );
  return ticket;
}

/**
 * Atomically consume a ticket on WS upgrade. A conditional delete that requires
 * the ticket to still exist AND be unexpired (closing the async-TTL reuse
 * window). Returns the principal on success, or null when the ticket is
 * missing, already consumed, or expired (the relay then closes 4001).
 */
export async function consumeWsTicket(ticket: string): Promise<TicketPrincipal | null> {
  if (!ticket) return null;
  try {
    const out = await ddb().send(
      new DeleteCommand({
        TableName: TABLE,
        Key: { ticket },
        ConditionExpression: 'attribute_exists(ticket) AND expiresAt >= :now',
        ExpressionAttributeValues: { ':now': nowSec() },
        ReturnValues: 'ALL_OLD',
      }),
    );
    const item = out.Attributes as
      | { tokenHash?: string; role?: JarvisRole; label?: string; greet?: boolean }
      | undefined;
    if (!item?.tokenHash || !item.role) return null;
    return { tokenHash: item.tokenHash, role: item.role, label: item.label ?? '', greet: item.greet !== false };
  } catch (err) {
    const name = (err as { name?: string }).name ?? '';
    if (name === 'ConditionalCheckFailedException') return null; // consumed or expired
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'ws-ticket consume failed');
    return null; // fail-closed: any error denies the connection
  }
}
