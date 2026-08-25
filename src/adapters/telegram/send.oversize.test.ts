/**
 * A3-10, THE OVERSIZE HALF — bound on what Telegram MEASURES.
 *
 * The defect: `formatMissionCard`/`formatMissionList` bound the RAW string at
 * 3000, but Telegram's 4096 applies to the string it RECEIVES, which is
 * `toTelegramHtml(text)`. HTML-escaping `&` alone expands 1 -> 5, so a mission
 * reply well inside the source bound was far past the wire limit. Three things
 * then lost the reply with no error anywhere: `sendMessage` did not split,
 * "message is too long" is not a parse error so the plain-text retry never
 * fired, and the caller discarded the result.
 *
 * This drives the REAL `sendMessage` and the REAL `toTelegramHtml` over the
 * REAL formatters, with only `fetch` and the kill-switch store stubbed, and
 * asserts the property that actually matters: NO PAYLOAD IS EVER POSTED OVER
 * THE CEILING, and the whole reply still arrives.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../lib/state/kill-switches-repo.js', () => ({
  isKillSwitchActive: vi.fn(async () => ({ active: false })),
}));
vi.mock('../../lib/state/agents-repo.js', () => ({ getAgent: vi.fn(async () => null) }));

import { sendMessage, resetTokenCache, TELEGRAM_MAX_CHARS } from './send.js';
import { toTelegramHtml } from './format.js';
import { formatMissionCard, formatMissionList } from '../../lib/missions/format.js';
import type { Mission } from '../../lib/state/mission-tasks-repo.js';

const BASE: Mission = {
  id: 'abc12345-1111-4111-8111-111111111111',
  ownerAgent: 'research',
  createdByAgent: 'research',
  createdByChat: '42',
  title: 'Fix the reconciler',
  body: '',
  priority: 'medium',
  status: 'open',
  createdAt: '2026-08-21T10:00:00.000Z',
  updatedAt: '2026-08-21T10:00:00.000Z',
};

/** A card whose body is 2000 `&` — inside the 3000 source bound, past 4096 sent. */
const AMP_CARD = formatMissionCard({ ...BASE, body: '&'.repeat(2000) });

/** A full board of `&`-heavy titles — the same defect one row-count up. */
const AMP_BOARD = formatMissionList(
  Array.from({ length: 15 }, (_, i) => ({
    ...BASE,
    id: `${i}`.repeat(36),
    title: '&'.repeat(255),
  })),
  { owner: 'research', status: 'open' },
);

interface Posted {
  text: string;
  parse_mode?: string;
  reply_to_message_id?: number;
}

let posted: Posted[];
/** Descriptions Telegram should answer with, one per call; `undefined` = ok. */
let rejections: Array<string | undefined>;

beforeEach(() => {
  posted = [];
  rejections = [];
  process.env.TELEGRAM_TOKENS_JSON = JSON.stringify({ research: 'tok' });
  resetTokenCache();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Posted;
      posted.push(body);
      const description = rejections.shift();
      if (description) {
        return { ok: true, json: async () => ({ ok: false, description }) } as unknown as Response;
      }
      return {
        ok: true,
        json: async () => ({ ok: true, result: { message_id: posted.length } }),
      } as unknown as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TELEGRAM_TOKENS_JSON;
  resetTokenCache();
});

describe('the measurement itself, recorded so it cannot quietly change', () => {
  it('the `&`-heavy card and board are inside the SOURCE bound and past the WIRE cap', () => {
    expect(AMP_CARD.length).toBeLessThanOrEqual(3000);
    expect(AMP_BOARD.length).toBeLessThanOrEqual(3000);
    // The numbers the header quotes. Equality, not an inequality: the whole
    // point is that a source-length check cannot see these.
    expect(AMP_CARD.length).toBe(1071);
    expect(toTelegramHtml(AMP_CARD).length).toBe(5067);
    expect(AMP_BOARD.length).toBe(2220);
    expect(toTelegramHtml(AMP_BOARD).length).toBe(9360);
    expect(toTelegramHtml(AMP_CARD).length).toBeGreaterThan(TELEGRAM_MAX_CHARS);
    expect(toTelegramHtml(AMP_BOARD).length).toBeGreaterThan(TELEGRAM_MAX_CHARS);
  });
});

describe('sendMessage bounds on the rendered length, not the source', () => {
  it.each([
    ['a mission card whose HTML render is 5067', AMP_CARD],
    ['a mission board whose HTML render is 9360', AMP_BOARD],
  ])('delivers %s instead of losing it', async (_name, text) => {
    const res = await sendMessage('research', 42, text, { replyToMessageId: 10 });

    expect(res.ok).toBe(true);
    expect(posted.length).toBeGreaterThan(0);
    for (const p of posted) {
      expect(p.text.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
    }
    // The source fits raw, so it arrives WHOLE — one message, unformatted,
    // rather than split or truncated. Degraded markup is a visible cost; a
    // vanished board is not visible at all.
    expect(posted).toHaveLength(1);
    expect(posted[0].text).toBe(text);
    expect(posted[0].parse_mode).toBeUndefined();
    expect(posted[0].reply_to_message_id).toBe(10);
  });

  it('still sends HTML when the render fits', async () => {
    const res = await sendMessage('research', 42, '**bold** and plain');
    expect(res.ok).toBe(true);
    expect(posted).toHaveLength(1);
    expect(posted[0].parse_mode).toBe('HTML');
    expect(posted[0].text).toBe('<b>bold</b> and plain');
  });

  it('splits a source that is over the ceiling on its own, and every piece fits', async () => {
    const long = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(40)}`).join('\n');
    expect(long.length).toBeGreaterThan(TELEGRAM_MAX_CHARS);

    const res = await sendMessage('research', 42, long, { replyToMessageId: 10 });

    expect(res.ok).toBe(true);
    expect(posted.length).toBeGreaterThan(1);
    for (const p of posted) expect(p.text.length).toBeLessThanOrEqual(TELEGRAM_MAX_CHARS);
    // The reply is whole: nothing was dropped between the pieces.
    expect(posted.map((p) => p.text).join('\n')).toBe(long);
    // Only the first piece answers the user's message.
    expect(posted[0].reply_to_message_id).toBe(10);
    expect(posted.slice(1).every((p) => p.reply_to_message_id === undefined)).toBe(true);
  });

  it('retries plain when Telegram itself says "message is too long"', async () => {
    // The predicate gap, pinned directly: this description is NOT a parse
    // error, so before the fix the retry loop fell straight out and the reply
    // was lost. Belt-and-braces for a length Telegram counts differently.
    rejections = ['Bad Request: message is too long'];
    const res = await sendMessage('research', 42, '**bold** and plain');
    expect(res.ok).toBe(true);
    expect(posted).toHaveLength(2);
    expect(posted[0].parse_mode).toBe('HTML');
    expect(posted[1].parse_mode).toBeUndefined();
    expect(posted[1].text).toBe('**bold** and plain');
  });

  it('reports NOT-ok when a later piece fails, so the caller cannot log success', async () => {
    const long = 'y'.repeat(9000);
    rejections = [undefined, 'Bad Request: chat not found', 'Bad Request: chat not found'];
    const res = await sendMessage('research', 42, long);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('chat not found');
  });
});
