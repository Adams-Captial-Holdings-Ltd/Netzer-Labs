/**
 * WHICH TELEGRAM BOT ACTUALLY SENT IT — asserted on the wire, because nothing
 * else can tell two Telegram bots apart.
 *
 * THE DEFECT THIS PINS. `deliverToReplyChat` is new code and `create_mission`'s
 * assignment push is its only consumer. A person types an ordinary message at
 * `/tg/research/webhook`; the sticky default answers the turn as `main`; the
 * model hands the mission to `ops`; the push is built from `replyChatId`. With
 * a bare chat id there was no bot in that id, so the send used the TURN agent
 * and the wire call went to `api.telegram.org/bot<TOKEN-MAIN>/sendMessage` for
 * a chat every other message in reached over TOKEN-RESEARCH. Telegram answers
 * 403 "Forbidden: bot can't initiate conversation with a user" — and if that
 * user HAS met the main bot, it is worse than a 403: a private chat_id IS the
 * user id, so board data lands in a different conversation. Either way the
 * result was discarded and the push reported success.
 *
 * Slack's half of this is asserted in `mission-assignment-push.test.ts` by the
 * `tokenOverride` the two send paths differ in. Telegram has no such argument —
 * `sendMessage(agentId, …)` looks the token up — so the equivalent assertion
 * has to be made one layer lower, on the URL. This drives the REAL sender with
 * only `fetch` and the two DDB-backed lookups stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../state/kill-switches-repo.js', () => ({
  isKillSwitchActive: vi.fn(async () => ({ active: false })),
}));
vi.mock('../state/agents-repo.js', () => ({ getAgent: vi.fn(async () => null) }));
vi.mock('../state/identities-repo.js', () => ({ listLinks: vi.fn(async () => []) }));

import { deliverToReplyChat } from './delivery.js';
import { resetTokenCache } from '../../adapters/telegram/send.js';

/** Every URL `fetch` was called with, in order. */
let urls: string[];
/** The `chat_id` of every posted body, in the same order. */
let chatIds: string[];
/** Telegram error descriptions to answer with, one per call; undefined = ok. */
let rejections: Array<string | undefined>;

beforeEach(() => {
  urls = [];
  chatIds = [];
  rejections = [];
  process.env.TELEGRAM_TOKENS_JSON = JSON.stringify({
    main: 'TOKEN-MAIN',
    research: 'TOKEN-RESEARCH',
  });
  resetTokenCache();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string }) => {
      urls.push(url);
      chatIds.push((JSON.parse(init.body) as { chat_id: string }).chat_id);
      const description = rejections.shift();
      if (description) {
        return { ok: true, json: async () => ({ ok: false, description }) } as unknown as Response;
      }
      return {
        ok: true,
        json: async () => ({ ok: true, result: { message_id: urls.length } }),
      } as unknown as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.TELEGRAM_TOKENS_JSON;
  resetTokenCache();
});

describe('a push into a per-agent bot chat goes out over THAT bot token', () => {
  it('uses the bot named in the id, not the turn agent that answered', async () => {
    // The executed chain, verbatim: turn agent `main`, conversation owned by
    // the `research` bot. Exactly one call, and it is TOKEN-RESEARCH.
    const ok = await deliverToReplyChat('main', '42:bot-research', 'Mission [abc12345] …');

    expect(ok).toBe(true);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe('https://api.telegram.org/botTOKEN-RESEARCH/sendMessage');
    expect(urls[0]).not.toContain('TOKEN-MAIN');
  });

  it('still addresses the chat id itself, with the identity segment stripped', async () => {
    // The segment is routing metadata, never part of `chat_id`. Sending to a
    // literal "42:bot-research" would be the owner-alias bug one surface over.
    await deliverToReplyChat('main', '-1001234567890:bot-research', 'hi');
    expect(chatIds).toEqual(['-1001234567890']);
  });

  it('falls back to the caller agent for an id stamped before the segment existed', async () => {
    // Back-compat, and the single-identity case: a bare chat id has nothing
    // better to use than the agent the caller named.
    await deliverToReplyChat('main', '42', 'hi');
    expect(urls[0]).toBe('https://api.telegram.org/botTOKEN-MAIN/sendMessage');
  });
});

describe('a refused push does not report success', () => {
  it('returns FALSE on the 403 the wrong bot earns, instead of true', async () => {
    // The second half of the defect: `send()` discarded sendMessage's result,
    // so the caller could not tell a delivered push from a 403. One rejection
    // is enough — a Forbidden is not a markup failure, so there is no
    // plain-text retry to answer.
    rejections = ["Forbidden: bot can't initiate conversation with a user"];
    const ok = await deliverToReplyChat('main', '42:bot-research', 'hi');
    expect(ok).toBe(false);
  });

  it('returns FALSE when the named bot has no token at all', async () => {
    // A bot id off the URL segment is unvalidated by design (the shared webhook
    // secret gates the route), so an unknown one must fail loudly here rather
    // than silently fall back to whoever the turn agent happened to be.
    const ok = await deliverToReplyChat('main', '42:bot-ghost', 'hi');
    expect(ok).toBe(false);
    expect(urls).toHaveLength(0);
  });

  it('and still returns FALSE, not an exception, for a surface with no channel', async () => {
    // Same signal, on purpose: "the room was not told" is all either means.
    expect(await deliverToReplyChat('main', 'dashboard:sess-1', 'hi')).toBe(false);
    expect(urls).toHaveLength(0);
  });
});
