/**
 * Cross-surface owner aliasing (C3).
 *
 * Maps a specific Telegram chat ID or Slack user ID to a single synthetic
 * `owner:<label>` chatId so the same person's interactions across both
 * surfaces share one memory namespace.
 *
 * Configured via env vars; no runtime state.
 *   CCE_OWNER_TELEGRAM_CHATS   CSV of telegram chat IDs (the owner's DM chat)
 *   CCE_OWNER_SLACK_USERS      CSV of slack user IDs (the owner's user)
 *   CCE_OWNER_DASHBOARD_EMAILS CSV of member emails (dashboard read-only peek)
 *   CCE_OWNER_LABEL            label embedded in the synthetic chatId; default `owner`
 *
 * New independent deployments use the configured label, with `owner` as the default.
 *
 * If none of the three are set, this module is a no-op and every handler
 * uses its surface-native chatId as before.
 */

function parseCsv(value: string | undefined): Set<string> {
  if (!value) return new Set();
  return new Set(
    value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/**
 * If the surface-native identifier matches one of the configured owner
 * IDs, return the synthetic `owner:<label>` chatId. Otherwise return
 * null, signalling the caller should use its native chatId.
 *
 * Telegram matches against `chatId` (the chat is the owner's DM).
 * Slack matches against `userId` (the message could be in any channel).
 * Dashboard matches against the authenticated member email (lowercased) and
 * is READ-ONLY by contract: dashboard chat never writes into the owner
 * session, it may only peek at it (see the cross_surface_peek flag).
 */
export function resolveOwnerChatId(
  surface: 'telegram' | 'slack' | 'dashboard',
  identifier: string | undefined,
): string | null {
  if (!identifier) return null;
  const label = process.env.CCE_OWNER_LABEL ?? 'owner';
  if (surface === 'telegram') {
    const allowed = parseCsv(process.env.CCE_OWNER_TELEGRAM_CHATS);
    return allowed.has(identifier) ? `owner:${label}` : null;
  }
  if (surface === 'slack') {
    const allowed = parseCsv(process.env.CCE_OWNER_SLACK_USERS);
    return allowed.has(identifier) ? `owner:${label}` : null;
  }
  if (surface === 'dashboard') {
    const allowed = new Set(
      [...parseCsv(process.env.CCE_OWNER_DASHBOARD_EMAILS)].map((e) => e.toLowerCase()),
    );
    return allowed.has(identifier.toLowerCase()) ? `owner:${label}` : null;
  }
  return null;
}

/** True for principal-scoped chatIds (owner aliases / identity claims) — the
 * only sources the dashboard peek may read. Never a Slack channel session. */
export function isPrincipalScopedChatId(chatId: string): boolean {
  return /^(owner:|user:)/.test(chatId);
}
