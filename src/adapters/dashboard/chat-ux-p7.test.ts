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
