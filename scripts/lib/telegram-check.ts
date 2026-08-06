/**
 * Telegram bot token validation via getMe.
 */

export interface TelegramBotInfo {
  ok: boolean;
  id?: number;
  username?: string;
  firstName?: string;
  canJoinGroups?: boolean;
  error?: string;
}

export async function validateTelegramToken(token: string): Promise<TelegramBotInfo> {
  if (!/^\d{8,12}:[A-Za-z0-9_-]{30,}$/.test(token)) {
    return { ok: false, error: 'Token format does not match the expected Telegram bot token pattern.' };
  }
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await resp.json()) as {
      ok: boolean;
      result?: {
        id: number;
        username: string;
        first_name: string;
        can_join_groups: boolean;
      };
      description?: string;
    };
    if (!data.ok || !data.result) {
      return { ok: false, error: data.description ?? 'unknown error from telegram' };
    }
    return {
      ok: true,
      id: data.result.id,
      username: data.result.username,
      firstName: data.result.first_name,
      canJoinGroups: data.result.can_join_groups,
    };
  } catch (err) {
    const e = err as { message?: string };
    return { ok: false, error: e.message ?? String(err) };
  }
}
