// DOM-free, tab-scoped storage helpers for unsent chat drafts.

function draftKey(agentId: string, chatId: string): string {
  return `cce_chat_draft:${agentId}/${chatId}`;
}

export function loadDraft(agentId: string, chatId: string, storage?: Storage): string {
  try {
    return (storage ?? globalThis.sessionStorage).getItem(draftKey(agentId, chatId)) ?? '';
  } catch {
    return '';
  }
}

export function saveDraft(agentId: string, chatId: string, text: string, storage?: Storage): void {
  try {
    const target = storage ?? globalThis.sessionStorage;
    const key = draftKey(agentId, chatId);
    if (text === '') target.removeItem(key);
    else target.setItem(key, text);
  } catch {
    // Storage may be blocked or unavailable; drafts are best-effort.
  }
}

export function clearDraft(agentId: string, chatId: string, storage?: Storage): void {
  try {
    (storage ?? globalThis.sessionStorage).removeItem(draftKey(agentId, chatId));
  } catch {
    // Storage may be blocked or unavailable; drafts are best-effort.
  }
}
