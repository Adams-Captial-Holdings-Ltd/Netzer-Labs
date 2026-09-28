/**
 * P7 (step 9) — work order B: the file note is a notice (A241), at the chat
 * page's DOM-free helpers, run by the root vitest.
 *
 * Written BEFORE the change, as the bar (netzar-chat-plan/p7-proof.sh row C-3).
 * Follows src/adapters/dashboard/chat-ux-p6.test.ts, which imports DOM-free web
 * modules into the root vitest (this file must stay DOM-free too).
 *
 * The decided design (owner decision 66): the web module that turns a
 * transcript into page messages (web/src/lib/chat/helpers.ts,
 * `transcriptToMessages`) maps a stored turn's `status: 'notice'` to the
 * page's `isReply: true` — the same flag a slash-command reply already
 * carries — which MessagesView.tsx reads to hide Regenerate
 * (`canRegenerate={... && !m.isReply}`). Today `transcriptToMessages` only
 * recognises `status: 'stopped'`; a stored notice reads back as a plain
 * reply, so this fails at the assertion below rather than passing by
 * construction (M41/P54).
 */
import { describe, it, expect } from 'vitest';
import { transcriptToMessages } from '../../../web/src/lib/chat/helpers.js';
import type { Message } from '../../../web/src/lib/chat/types.js';

describe('P7 chat page helpers — the file note is a notice', () => {
  it('P7 a stored notice loads without Regenerate', () => {
    const turns = [
      { role: 'user', text: 'Here is the file', ts: 1_758_970_000 },
      { role: 'assistant', text: 'notes.pdf was stored but not read.', ts: 1_758_970_001, status: 'notice' },
    ];

    const messages = transcriptToMessages(turns);

    const reply = messages.find((m) => m.role === 'assistant');
    expect(reply, `messages: ${JSON.stringify(messages)}`).toMatchObject({ isReply: true });

    // A turn saved before this change (no status) is unaffected: still a
    // regular reply that can be regenerated.
    const older = transcriptToMessages([
      { role: 'user', text: 'Older file note', ts: 1 },
      { role: 'assistant', text: 'Stored the file.', ts: 2 },
    ]);
    expect(older.find((m) => m.role === 'assistant')).not.toMatchObject({ isReply: true });
  });
});

/**
 * P7 (step 9) — work order D: the Markdown export's error line (A242).
 *
 * Written BEFORE the change, as the bar (netzar-chat-plan/p7-proof.sh row A-2).
 * Follows src/adapters/dashboard/chat-ux-p6.test.ts's lazy-import pattern.
 *
 * The decided design: `conversationMarkdown` (web/src/lib/chat/export.ts)
 * writes its `Error:` line for a failed reply. This ALREADY EXISTS (export.ts
 * ~:18: `if (message.failure) lines.push('', \`Error: ${message.failure}\`);`),
 * pinned here rather than driven red (M41/P54 excepts a pin of behaviour that
 * already exists). Red is impossible: proved by a TEMPORARY mutation of
 * export.ts, run alone to record the failure below, then export.ts is
 * restored exactly. The mutation and its failure message are logged in the D
 * commit's log directory (P28).
 */
describe('P7 chat page helpers — the Markdown export pins its error line', () => {
  it('P7 the Markdown export writes an error line for a failed reply', async () => {
    type ExportModule = {
      conversationMarkdown: (c: { title: string; agentName: string; messages: Message[] }) => string;
    };
    const mod = (await import('../../../web/src/lib/chat/export.js').catch(() => null)) as ExportModule | null;
    expect(mod, 'web/src/lib/chat/export.ts exports conversationMarkdown').not.toBeNull();
    const messages: Message[] = [
      { role: 'user', text: 'Summarize the outage', ts: 1 },
      { role: 'assistant', text: '', failure: 'Something went wrong: timeout', ts: 2, error: true },
    ];

    const md = mod!.conversationMarkdown({ title: 'Outage summary', agentName: 'Netzar Prime', messages });

    // The exact line, not merely a substring: A-2 pins it.
    expect(md.split('\n'), `markdown: ${JSON.stringify(md)}`).toContain('Error: Something went wrong: timeout');
  });
});
