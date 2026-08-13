/**
 * Magic-link email sender (Wave 4a, passwordless auth).
 *
 * Sends the two transactional emails the magic-link flow needs:
 *   - invite:  <DASHBOARD_URL>/dashboard/accept?token=<raw>   (admin invited a new member)
 *   - login:   <DASHBOARD_URL>/dashboard/verify?token=<raw>   (returning member sign-in)
 *
 * The /dashboard segment is the SPA base (wouter base="/dashboard"); the accept
 * and verify routes live UNDER it, so links that omit the base 404. The base is
 * baked into buildMagicLink, not into DASHBOARD_URL, so the env stays the bare
 * origin.
 *
 * Everything routes through ONE guarded send path (sendMagicLinkEmail) so the
 * security must-fixes hold for both purposes:
 *
 *   1. Links are built from server config (CCE_DASHBOARD_URL / DASHBOARD_URL),
 *      NEVER from a request Host / X-Forwarded-Host header. The caller does not
 *      get to pass a base URL.
 *   2. The send honors the `email_send_disabled` kill switch plus a per-process
 *      send cap, mirroring the SES email tool.
 *   3. Every send (and every drop) is audited.
 *   4. Failures are fail-soft: a sandboxed / unverified / unconfigured SES never
 *      throws back into the auth route. The caller still returns its constant
 *      202 / token; the email just doesn't land. The failure is logged + audited.
 *
 * The raw token only ever lives in the emitted link. Hashing + single-use are
 * the magic-link repo's job; this module just delivers the URL.
 *
 * Style follows the project's email rules: no em-dashes, no colons in copy, real
 * <a> button, paragraphs as single long lines, multipart HTML + plain.
 */

import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { isKillSwitchActive } from '../state/kill-switches-repo.js';
import { writeAudit } from '../audit/audit-writer.js';
import { logger } from '../../observability/logger.js';

const region = process.env.AWS_REGION ?? 'us-east-1';

/**
 * Per-process send cap. A bug or an abuse loop must not let the auth routes
 * fan out an unbounded number of SES sends from a single task. The window is
 * coarse on purpose (the real per-identity throttle is the fail-closed rate
 * limiter on the auth routes); this is a blunt backstop. Tunable via
 * CCE_MAGIC_LINK_SEND_CAP / CCE_MAGIC_LINK_SEND_WINDOW_SEC.
 */
const SEND_CAP = Math.max(1, Number(process.env.CCE_MAGIC_LINK_SEND_CAP ?? '200'));
const SEND_WINDOW_MS =
  Math.max(1, Number(process.env.CCE_MAGIC_LINK_SEND_WINDOW_SEC ?? '3600')) * 1000;
let _windowStart = Date.now();
let _windowCount = 0;

let _ses: SESv2Client | null = null;
function ses(): SESv2Client {
  if (!_ses) _ses = new SESv2Client({ region });
  return _ses;
}

export type MagicLinkPurpose = 'invite' | 'login';

export interface MagicLinkEmailInput {
  /** Recipient address. */
  to: string;
  /** Which flow this email serves; drives the path + copy. */
  purpose: MagicLinkPurpose;
  /** The RAW (un-hashed) one-time token. Embedded in the link only. */
  rawToken: string;
  /** Who triggered the send, for the audit row. Display only. */
  invitedBy?: string;
}

export interface MagicLinkSendResult {
  /** True only when SES accepted the message. */
  sent: boolean;
  /** Present when sent. */
  messageId?: string;
  /**
   * Why a send did not happen. 'kill_switch' (email_send_disabled),
   * 'send_cap', 'unconfigured' (no CCE_EMAIL_FROM / no dashboard URL),
   * or 'ses_error' (sandboxed / unverified / transient).
   */
  skippedReason?: 'kill_switch' | 'send_cap' | 'unconfigured' | 'ses_error';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Resolve the dashboard base URL from server config ONLY. Never from a request
 * header. Returns '' (caller treats as unconfigured) when neither env is set so
 * we never mint a link against an attacker-controlled or guessed host.
 */
export function dashboardBaseUrl(): string {
  const raw = (process.env.CCE_DASHBOARD_URL ?? process.env.DASHBOARD_URL ?? '').trim();
  if (!raw) return '';
  // Normalize: ensure a scheme, drop any trailing slash so we can append paths.
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  return withScheme.replace(/\/+$/, '');
}

/**
 * Build the magic-link URL for a purpose from server config. Returns null when
 * the dashboard URL is unconfigured (caller should treat the send as skipped /
 * unconfigured rather than emit a header-derived link).
 */
function buildMagicLink(purpose: MagicLinkPurpose, rawToken: string): string | null {
  const base = dashboardBaseUrl();
  if (!base) return null;
  // The SPA is served under the /dashboard base (wouter base="/dashboard"), and
  // the accept/verify routes live UNDER that base. A link that omits /dashboard
  // 404s. dashboardBaseUrl() already stripped any trailing slash on the origin,
  // so we prepend the fixed /dashboard segment here.
  const path = purpose === 'invite' ? '/dashboard/accept' : '/dashboard/verify';
  return `${base}${path}?token=${encodeURIComponent(rawToken)}`;
}

function renderCopy(
  purpose: MagicLinkPurpose,
  link: string,
  invitedBy?: string,
): { subject: string; text: string; html: string } {
  const buttonLabel = purpose === 'invite' ? 'Accept your invite' : 'Sign in';
  const subject =
    purpose === 'invite'
      ? 'You have been invited to Netzar OS'
      : 'Your Netzar OS sign-in link';
  const lead =
    purpose === 'invite'
      ? invitedBy
        ? `${invitedBy} invited you to the Netzar OS dashboard.`
        : 'You have been invited to the Netzar OS dashboard.'
      : 'Use the link below to sign in to the Netzar OS dashboard.';
  const expiry =
    purpose === 'invite'
      ? 'This invite link works once and expires in 72 hours.'
      : 'This sign-in link works once and expires in 15 minutes.';
  const ignore =
    purpose === 'invite'
      ? 'If you were not expecting this invite you can ignore this email.'
      : 'If you did not request this you can ignore this email and your account stays unchanged.';

  // Plain-text fallback: paragraphs as single long lines, link on its own line,
  // no leading whitespace (Gmail mangles it).
  const text = [lead, '', `${buttonLabel}: ${link}`, '', expiry, '', ignore].join('\n');

  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a">
<p>${escapeHtml(lead)}</p>
<p style="margin-top:16px;margin-bottom:16px"><a href="${escapeHtml(link)}" style="background:#111827;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:6px;display:inline-block">${escapeHtml(buttonLabel)}</a></p>
<p style="color:#6b7280;font-size:13px">${escapeHtml(expiry)}</p>
<p style="color:#6b7280;font-size:13px">${escapeHtml(ignore)}</p>
<p style="color:#9ca3af;font-size:12px;margin-top:16px">If the button does not work, paste this link into your browser.<br>${escapeHtml(link)}</p>
</div>`;

  return { subject, text, html };
}

/** Reset the per-process send window if it has rolled over. */
function withinSendCap(): boolean {
  const now = Date.now();
  if (now - _windowStart >= SEND_WINDOW_MS) {
    _windowStart = now;
    _windowCount = 0;
  }
  if (_windowCount >= SEND_CAP) return false;
  _windowCount += 1;
  return true;
}

/**
 * Guarded send. Honors email_send_disabled + the per-process cap, builds the
 * link from server config, audits every outcome, and fails soft. NEVER throws
 * back to the auth route: a sandboxed or unconfigured SES returns
 * { sent:false, skippedReason } so the caller's constant-time 202 / token path
 * is unaffected.
 */
export async function sendMagicLinkEmail(
  input: MagicLinkEmailInput,
): Promise<MagicLinkSendResult> {
  const { to, purpose, rawToken, invitedBy } = input;

  // 1. Kill switch — email_send_disabled blocks ALL magic-link sends.
  const killed = await isKillSwitchActive('email_send_disabled').catch(() => ({
    active: false as const,
    reason: undefined as string | undefined,
  }));
  if (killed.active) {
    logger.warn(
      { purpose, reason: killed.reason },
      'magic-link email skipped: email_send_disabled',
    );
    void writeAudit({
      action: 'login_request',
      surface: 'dashboard',
      result: 'blocked',
      detail: {
        kind: 'magic_link_email',
        purpose,
        skipped: 'kill_switch',
        ...(killed.reason ? { reason: killed.reason } : {}),
      },
    });
    return { sent: false, skippedReason: 'kill_switch' };
  }

  // 2. Per-process send cap backstop.
  if (!withinSendCap()) {
    logger.warn({ purpose, cap: SEND_CAP }, 'magic-link email skipped: send cap');
    void writeAudit({
      action: 'login_request',
      surface: 'dashboard',
      result: 'blocked',
      detail: { kind: 'magic_link_email', purpose, skipped: 'send_cap', cap: SEND_CAP },
    });
    return { sent: false, skippedReason: 'send_cap' };
  }

  // 3. Config — sender + dashboard URL both come from server env, not headers.
  const from = (process.env.CCE_EMAIL_FROM ?? '').trim();
  const link = buildMagicLink(purpose, rawToken);
  // Optional SES configuration set. When set, all magic-link sends route
  // through it so bounce/complaint events publish to SNS and offending
  // addresses are auto-suppressed (config-set + account suppression list).
  const configSet = (process.env.CCE_SES_CONFIG_SET ?? '').trim();
  if (!from || !link) {
    logger.warn(
      { purpose, hasFrom: Boolean(from), hasLink: Boolean(link) },
      'magic-link email skipped: SES sender or dashboard URL unconfigured',
    );
    void writeAudit({
      action: 'login_request',
      surface: 'dashboard',
      result: 'error',
      detail: {
        kind: 'magic_link_email',
        purpose,
        skipped: 'unconfigured',
        hasFrom: Boolean(from),
        hasDashboardUrl: Boolean(link),
      },
    });
    return { sent: false, skippedReason: 'unconfigured' };
  }

  const { subject, text, html } = renderCopy(purpose, link, invitedBy);

  // 4. Send. Fail soft on any SES error (sandbox, unverified recipient,
  // throttle, transient). Audit the outcome either way. Never leak the token.
  try {
    const resp = await ses().send(
      new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: [to] },
        ...(configSet ? { ConfigurationSetName: configSet } : {}),
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: {
              Text: { Data: text, Charset: 'UTF-8' },
              Html: { Data: html, Charset: 'UTF-8' },
            },
          },
        },
      }),
    );
    logger.info(
      { purpose, messageId: resp.MessageId },
      'magic-link email sent',
    );
    void writeAudit({
      action: 'login_request',
      surface: 'dashboard',
      result: 'ok',
      detail: {
        kind: 'magic_link_email',
        purpose,
        sent: true,
        messageId: resp.MessageId ?? null,
        ...(invitedBy ? { invitedBy } : {}),
      },
    });
    return { sent: true, ...(resp.MessageId ? { messageId: resp.MessageId } : {}) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(
      { purpose, errMessage: msg },
      'magic-link email send failed (fail-soft); SES may be sandboxed or unverified',
    );
    void writeAudit({
      action: 'login_request',
      surface: 'dashboard',
      result: 'error',
      detail: { kind: 'magic_link_email', purpose, skipped: 'ses_error', errMessage: msg },
    });
    return { sent: false, skippedReason: 'ses_error' };
  }
}

/** Convenience: send an invite (status=invited) magic link. */
export function sendInviteEmail(
  to: string,
  rawToken: string,
  invitedBy?: string,
): Promise<MagicLinkSendResult> {
  return sendMagicLinkEmail({
    to,
    purpose: 'invite',
    rawToken,
    ...(invitedBy ? { invitedBy } : {}),
  });
}

/** Convenience: send a returning-user login magic link. */
export function sendLoginEmail(to: string, rawToken: string): Promise<MagicLinkSendResult> {
  return sendMagicLinkEmail({ to, purpose: 'login', rawToken });
}
