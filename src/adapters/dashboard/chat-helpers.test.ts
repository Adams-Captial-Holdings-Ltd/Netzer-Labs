import { describe, it, expect } from 'vitest';
import {
  MODEL_NAMES,
  modelOptionLabel,
  freshChatId,
  conversationTitle,
  relativeAge,
  friendlyStreamError,
} from '../../../web/src/lib/chat/helpers.js';
import type { Conversation, Model } from '../../../web/src/lib/chat/types.js';

// Golden tests for the pure chat helpers extracted from web/src/pages/Chat.tsx.
// They encode the PRE-refactor behavior exactly — where a test and the source
// disagree, the source wins. (Import-path note: see chat-stream.test.ts.)

function model(overrides: Partial<Model>): Model {
  return {
    label: 'sonnet',
    id: 'us.anthropic.claude-sonnet-4-5',
    contextWindow: 200_000,
    family: 'sonnet',
    isDefault: false,
    ...overrides,
  };
}

function conversation(overrides: Partial<Conversation>): Conversation {
  return {
    agentId: 'a1',
    chatId: 'dashboard:1700000000000',
    updatedAt: 0,
    messageCount: null,
    firstMessage: null,
    ...overrides,
  };
}

describe('friendlyStreamError', () => {
  it('maps kill-switch errors', () => {
    expect(friendlyStreamError('kill_switch_active: tool_use')).toBe(
      'This was blocked by an active kill switch.',
    );
    expect(friendlyStreamError('turn killed by operator')).toBe(
      'This was blocked by an active kill switch.',
    );
  });

  it('maps cost-cap errors, including the raw dollar dump', () => {
    const want = 'The daily spending limit has been reached. Raise it in Cost or try again tomorrow.';
    expect(friendlyStreamError('daily cost cap exceeded: $1.50 >= $1.00')).toBe(want);
    expect(friendlyStreamError('spend cap reached')).toBe(want);
    expect(friendlyStreamError('spending limit hit')).toBe(want);
  });

  it('maps rate-limit errors', () => {
    const want = 'Too many requests right now. Wait a moment and try again.';
    expect(friendlyStreamError('rate_limited')).toBe(want);
    expect(friendlyStreamError('Too many requests')).toBe(want);
  });

  it('maps sessions-frozen errors', () => {
    expect(friendlyStreamError('sessions_frozen: freeze switch on')).toBe(
      'New messages are paused by a kill switch (sessions frozen).',
    );
  });

  it('maps guardrail errors', () => {
    const want = 'The response was blocked by a safety guardrail.';
    expect(friendlyStreamError('guardrail intervened')).toBe(want);
    expect(friendlyStreamError('blocked by content filter')).toBe(want);
  });

  it('maps no-model / model-config errors', () => {
    const want = 'No model is configured for this agent, or the model failed. Try a different model.';
    expect(friendlyStreamError('No Bedrock model configured')).toBe(want);
    expect(friendlyStreamError('no default model set')).toBe(want);
    expect(friendlyStreamError('model_error: boom')).toBe(want);
  });

  it('surfaces a short clean unknown cause verbatim', () => {
    expect(friendlyStreamError('Upload failed')).toBe('Something went wrong: Upload failed');
  });

  it('collapses causes of length >= 140 to the generic line', () => {
    const generic = 'The agent could not finish this response. Please try again.';
    expect(friendlyStreamError('x'.repeat(140))).toBe(generic);
    // 139 is still under the cap and stays verbatim.
    expect(friendlyStreamError('x'.repeat(139))).toBe(`Something went wrong: ${'x'.repeat(139)}`);
  });

  it('collapses causes containing {, } or $ to the generic line', () => {
    const generic = 'The agent could not finish this response. Please try again.';
    expect(friendlyStreamError('bad payload {"a":1}')).toBe(generic);
    expect(friendlyStreamError('costs $5 somewhere')).toBe(generic);
  });

  it('collapses an empty cause to the generic line', () => {
    expect(friendlyStreamError('')).toBe(
      'The agent could not finish this response. Please try again.',
    );
  });

  it('trims whitespace before matching and rendering', () => {
    expect(friendlyStreamError('  Upload failed  ')).toBe('Something went wrong: Upload failed');
  });

  // The branch ORDER is the whole design of this function ("match known codes
  // first, then substrings of the raw message"). These inputs deliberately
  // match TWO branches each, so only the ordering can produce the expected
  // line — reorder the ifs and these fail.
  it('matches the EARLIER branch when a cause matches two of them', () => {
    // 'blocked by' is the guardrail branch (5th), 'cost cap' is the cost-cap
    // branch (2nd). The spending-limit line wins because it is checked first.
    expect(friendlyStreamError('blocked by daily cost cap')).toBe(
      'The daily spending limit has been reached. Raise it in Cost or try again tomorrow.',
    );
    // 'rate limited' is the rate-limit branch (3rd), 'kill switch' is the
    // kill-switch branch (1st). The kill-switch line wins.
    expect(friendlyStreamError('kill switch: rate limited')).toBe(
      'This was blocked by an active kill switch.',
    );
  });

  it('prefers the kill-switch line over sessions-frozen when both match', () => {
    // The source's own sessions-frozen copy mentions a kill switch, so the two
    // are genuinely adjacent; the 1st branch still wins.
    expect(friendlyStreamError('kill_switch_active: sessions_frozen')).toBe(
      'This was blocked by an active kill switch.',
    );
  });
});

describe('relativeAge', () => {
  const nowMs = 1_700_000_000_000; // fixed clock; epochSeconds are relative to it
  const nowSec = Math.floor(nowMs / 1000);

  // NOTE: this does NOT cover the `Math.max(0, …)` clamp, despite the future
  // timestamp below. The clamp is purely defensive and is UNOBSERVABLE through
  // this public API: the only test on `secs` before the 'now' return is
  // `secs < 60`, which every negative value satisfies too. Dropping the clamp
  // changes no output here, so no assertion can pin it — the future-timestamp
  // case is kept because it is real input (clock skew), not because it is
  // clamp coverage.
  it('renders "now" under a minute, and for future timestamps', () => {
    expect(relativeAge(nowSec, nowMs)).toBe('now');
    expect(relativeAge(nowSec - 59, nowMs)).toBe('now');
    expect(relativeAge(nowSec + 120, nowMs)).toBe('now');
  });

  it('renders minutes from 60s up to an hour', () => {
    expect(relativeAge(nowSec - 60, nowMs)).toBe('1m');
    expect(relativeAge(nowSec - 3599, nowMs)).toBe('59m');
  });

  it('renders hours from 3600s up to a day', () => {
    expect(relativeAge(nowSec - 3600, nowMs)).toBe('1h');
    expect(relativeAge(nowSec - 86399, nowMs)).toBe('23h');
  });

  it('renders days from 86400s on', () => {
    expect(relativeAge(nowSec - 86400, nowMs)).toBe('1d');
    expect(relativeAge(nowSec - 86400 * 12, nowMs)).toBe('12d');
  });
});

describe('conversationTitle', () => {
  it('uses the trimmed first message when present', () => {
    expect(conversationTitle(conversation({ firstMessage: '  hello there  ' }))).toBe('hello there');
  });

  it('falls back to the raw chatId when the first message is null or blank', () => {
    expect(conversationTitle(conversation({ firstMessage: null }))).toBe('dashboard:1700000000000');
    expect(conversationTitle(conversation({ firstMessage: '   ' }))).toBe('dashboard:1700000000000');
  });
});

describe('modelOptionLabel', () => {
  it('renders a friendly name plus "1M ctx" at a million tokens and up', () => {
    expect(modelOptionLabel(model({ label: 'sonnet-1m', contextWindow: 1_000_000 }))).toBe(
      'Sonnet 1M · 1M ctx',
    );
    expect(modelOptionLabel(model({ label: 'opus-1m', contextWindow: 2_000_000 }))).toBe(
      'Opus 1M · 1M ctx',
    );
  });

  it('rounds sub-million context windows to K', () => {
    expect(modelOptionLabel(model({ label: 'haiku', contextWindow: 200_000 }))).toBe(
      'Haiku · 200K ctx',
    );
    expect(modelOptionLabel(model({ label: 'sonnet', contextWindow: 131_072 }))).toBe(
      'Sonnet · 131K ctx',
    );
  });

  it('ROUNDS rather than truncates — 199_500 reads as 200K, not 199K', () => {
    // The cases above pass under Math.floor too (200.0 and 131.072 both floor
    // to the same integer). These are the values where Math.round is the only
    // thing producing the expected label.
    expect(modelOptionLabel(model({ label: 'sonnet', contextWindow: 199_500 }))).toBe(
      'Sonnet · 200K ctx',
    );
    expect(modelOptionLabel(model({ label: 'haiku', contextWindow: 8_600 }))).toBe(
      'Haiku · 9K ctx',
    );
    // …and rounds DOWN just under the halfway point, so it is not a ceil either.
    expect(modelOptionLabel(model({ label: 'haiku', contextWindow: 8_499 }))).toBe(
      'Haiku · 8K ctx',
    );
  });

  it('passes unknown backend labels through verbatim', () => {
    expect(modelOptionLabel(model({ label: 'custom-model', contextWindow: 8_192 }))).toBe(
      'custom-model · 8K ctx',
    );
  });

  it('keeps the friendly-name table intact', () => {
    expect(MODEL_NAMES).toEqual({
      opus: 'Opus',
      'opus-1m': 'Opus 1M',
      sonnet: 'Sonnet',
      'sonnet-1m': 'Sonnet 1M',
      haiku: 'Haiku',
      default: 'Default',
    });
  });
});

describe('freshChatId', () => {
  it('mints dashboard:-prefixed ids from the clock', () => {
    const id = freshChatId();
    expect(id).toMatch(/^dashboard:\d+$/);
    const stamp = Number(id.slice('dashboard:'.length));
    expect(Math.abs(Date.now() - stamp)).toBeLessThan(60_000);
  });
});
