export function formatSessionId(chatId: string, surface?: string | null): string {
  if (!chatId) return 'Unknown';
  if (chatId.startsWith('dashboard:')) return 'Dashboard chat';
  if (chatId.startsWith('slack:')) return 'Slack conversation';
  if (/^\d+$/.test(chatId)) return 'Telegram chat';
  if (surface === 'telegram') return 'Telegram chat';
  if (surface === 'slack') return 'Slack conversation';
  if (surface === 'dashboard') return 'Dashboard chat';
  return chatId.length > 24 ? chatId.slice(0, 21) + '...' : chatId;
}

export function formatRelativeTime(epochSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - epochSeconds;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ChatGPT-style sidebar grouping. Compares LOCAL calendar days (midnight
// boundaries), not rolling 24h windows: a chat from 11pm yesterday is
// "Yesterday" even if it was 2 hours ago. Input is epoch SECONDS (the
// sessions-table convention).
export function dateGroupLabel(epochSeconds: number, now = new Date()): string {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const ms = epochSeconds * 1000;
  if (ms >= startOfToday) return 'Today';
  if (ms >= startOfToday - 86_400_000) return 'Yesterday';
  if (ms >= startOfToday - 7 * 86_400_000) return 'Previous 7 days';
  return 'Older';
}

// Local wall-clock time for "updated ..." freshness captions. Accepts a Date or
// an epoch in MILLISECONDS (Date.now()), since the freshness stamp is recorded
// with Date.now() at fetch completion (not the epoch-SECONDS used elsewhere).
export function formatLocalTime(value: Date | number): string {
  const d = typeof value === 'number' ? new Date(value) : value;
  return d.toLocaleTimeString();
}

export function formatDuration(startEpoch: number, endEpoch: number): string {
  const diff = Math.max(0, endEpoch - startEpoch);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) {
    const h = Math.floor(diff / 3600);
    const m = Math.floor((diff % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  return `${Math.floor(diff / 86400)}d`;
}

const MODEL_MAP: Record<string, string> = {
  'sonnet-4-6': 'Claude Sonnet 4.6',
  'opus-4-7': 'Claude Opus 4.7',
  'haiku-4-5': 'Claude Haiku 4.5',
  'sonnet-4-5': 'Claude Sonnet 4.5',
  'opus-4-6': 'Claude Opus 4.6',
};

export function formatModelName(modelId: string | null | undefined): string {
  if (!modelId) return 'Default';
  for (const [key, name] of Object.entries(MODEL_MAP)) {
    if (modelId.includes(key)) return name;
  }
  const lastPart = modelId.split('.').pop() ?? modelId;
  return lastPart.replace(/(^|-)(\w)/g, (_, sep, ch) =>
    (sep ? ' ' : '') + ch.toUpperCase()
  );
}
