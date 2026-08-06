/**
 * Slack token validation via auth.test.
 *
 * https://api.slack.com/methods/auth.test — confirms the token works
 * without requiring any non-trivial scope. Returns the workspace and
 * bot user so we can show the user what they connected to.
 */

export interface SlackAuthResult {
  ok: boolean;
  team?: string;
  user?: string;
  teamId?: string;
  userId?: string;
  error?: string;
}

export async function validateSlackToken(token: string): Promise<SlackAuthResult> {
  if (!token.startsWith('xoxb-')) {
    return { ok: false, error: 'Token does not start with xoxb-. Use the Bot User OAuth Token.' };
  }
  try {
    const resp = await fetch('https://slack.com/api/auth.test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: '',
    });
    const data = (await resp.json()) as {
      ok: boolean;
      team?: string;
      user?: string;
      team_id?: string;
      user_id?: string;
      error?: string;
    };
    if (!data.ok) return { ok: false, error: data.error ?? 'unknown error from slack' };
    return {
      ok: true,
      team: data.team,
      user: data.user,
      teamId: data.team_id,
      userId: data.user_id,
    };
  } catch (err) {
    const e = err as { message?: string };
    return { ok: false, error: e.message ?? String(err) };
  }
}

export function validateSlackSigningSecret(secret: string): boolean {
  // Slack signing secrets are 32-char hex strings.
  return /^[a-f0-9]{32}$/i.test(secret);
}
