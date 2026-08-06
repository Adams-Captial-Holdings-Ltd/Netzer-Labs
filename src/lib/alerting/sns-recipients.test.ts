import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  SubscribeCommand,
  UnsubscribeCommand,
  ListSubscriptionsByTopicCommand,
} from '@aws-sdk/client-sns';

// Mock the SNS client so we can assert which commands are sent without any
// real AWS call. SNSClient is constructed internally by the module.
const snsSend = vi.fn();
vi.mock('@aws-sdk/client-sns', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-sns')>('@aws-sdk/client-sns');
  return {
    ...actual,
    SNSClient: vi.fn(() => ({ send: snsSend })),
  };
});

// Durable intended-recipient record lives in runtime-config; mock both sides.
const getConfig = vi.fn();
const setConfig = vi.fn();
vi.mock('../state/runtime-config-repo.js', () => ({
  getConfig: (...args: unknown[]) => getConfig(...args),
  setConfig: (...args: unknown[]) => setConfig(...args),
}));

vi.mock('../../observability/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { removeRecipientByEmail } from './sns-recipients.js';

const TOPIC = 'arn:aws:sns:us-east-1:123456789012:claudeclaw-ops-alerts';
const SUB_ARN = 'arn:aws:sns:us-east-1:123456789012:claudeclaw-ops-alerts:abc-123';

beforeEach(() => {
  snsSend.mockReset();
  getConfig.mockReset();
  setConfig.mockReset();
  process.env.CCE_ALERT_TOPIC_ARN = TOPIC;
  // No durable record by default.
  getConfig.mockResolvedValue(undefined);
  setConfig.mockResolvedValue(undefined);
});

describe('removeRecipientByEmail', () => {
  it('unsubscribes by resolved ARN for a confirmed recipient', async () => {
    // ListSubscriptionsByTopic returns a confirmed sub for the email; the
    // subsequent Unsubscribe resolves ok. (unsubscribe() lists again to prune,
    // so respond to every list with the same confirmed sub.)
    snsSend.mockImplementation((cmd) => {
      if (cmd instanceof ListSubscriptionsByTopicCommand) {
        return Promise.resolve({
          Subscriptions: [
            { Protocol: 'email', Endpoint: 'oncall@example.com', SubscriptionArn: SUB_ARN },
          ],
        });
      }
      if (cmd instanceof UnsubscribeCommand) return Promise.resolve({});
      return Promise.resolve({});
    });

    const result = await removeRecipientByEmail('oncall@example.com', { updatedBy: 'tester' });

    expect(result.ok).toBe(true);
    const unsub = snsSend.mock.calls
      .map((c) => c[0])
      .find((cmd) => cmd instanceof UnsubscribeCommand) as UnsubscribeCommand | undefined;
    expect(unsub).toBeDefined();
    expect(unsub?.input.SubscriptionArn).toBe(SUB_ARN);
  });

  it('treats a pending recipient (no ARN) as removed without unsubscribing', async () => {
    // Email is present in the durable record but SNS has no confirmed sub yet.
    getConfig.mockResolvedValue(JSON.stringify([{ email: 'pending@example.com' }]));
    snsSend.mockImplementation((cmd) => {
      if (cmd instanceof ListSubscriptionsByTopicCommand) {
        return Promise.resolve({ Subscriptions: [] });
      }
      return Promise.resolve({});
    });

    const result = await removeRecipientByEmail('pending@example.com');

    expect(result.ok).toBe(true);
    // No Unsubscribe should be sent for a pending recipient.
    const sentUnsub = snsSend.mock.calls.some((c) => c[0] instanceof UnsubscribeCommand);
    expect(sentUnsub).toBe(false);
    // The durable record should have been rewritten without the email.
    expect(setConfig).toHaveBeenCalled();
  });

  it('does not report success or unpersist when the SNS read fails for a confirmed recipient', async () => {
    // Regression: ListSubscriptionsByTopic REJECTS (SNS unreadable) while a
    // confirmed subscription for this email is actually still active. Resolving
    // by listSubscriptions() degrades to a no-ARN persisted fallback, which used
    // to look exactly like a pending recipient — so removal claimed success and
    // pruned the durable record while the live subscription stayed armed. The
    // fix must surface the read failure: no success, no unpersist, no unsubscribe.
    getConfig.mockResolvedValue(JSON.stringify([{ email: 'confirmed@example.com' }]));
    snsSend.mockImplementation((cmd) => {
      if (cmd instanceof ListSubscriptionsByTopicCommand) {
        return Promise.reject(new Error('AccessDenied: sns:ListSubscriptionsByTopic'));
      }
      return Promise.resolve({});
    });

    const result = await removeRecipientByEmail('confirmed@example.com', { updatedBy: 'tester' });

    // Removal must NOT report success when SNS could not be read.
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    // The durable record must NOT be rewritten (no unpersist).
    expect(setConfig).not.toHaveBeenCalled();
    // No Unsubscribe should be attempted either.
    const sentUnsub = snsSend.mock.calls.some((c) => c[0] instanceof UnsubscribeCommand);
    expect(sentUnsub).toBe(false);
  });

  it('refuses to remove a LIVE pending SNS subscription and does not unpersist', async () => {
    // Regression (Codex round 3): SNS read SUCCEEDS and returns a real pending
    // email subscription for the target (confirmation link sent, not yet clicked
    // -> SubscriptionArn is the literal "PendingConfirmation", no real ARN). AWS
    // cannot cancel a pending subscription, and unpersisting our intent would not
    // stop a later confirmation, so removal must REFUSE rather than report a
    // false success that could silently confirm later.
    getConfig.mockResolvedValue(JSON.stringify([{ email: 'pendingsns@example.com' }]));
    snsSend.mockImplementation((cmd) => {
      if (cmd instanceof ListSubscriptionsByTopicCommand) {
        return Promise.resolve({
          Subscriptions: [
            { Protocol: 'email', Endpoint: 'pendingsns@example.com', SubscriptionArn: 'PendingConfirmation' },
          ],
        });
      }
      return Promise.resolve({});
    });

    const result = await removeRecipientByEmail('pendingsns@example.com', { updatedBy: 'tester' });

    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
    // Must NOT unpersist: the live pending row can still confirm.
    expect(setConfig).not.toHaveBeenCalled();
    // Must NOT attempt Unsubscribe: there is no real ARN and AWS cannot cancel a
    // pending email subscription.
    const sentUnsub = snsSend.mock.calls.some((c) => c[0] instanceof UnsubscribeCommand);
    expect(sentUnsub).toBe(false);
  });

  it('never sends a SubscribeCommand', async () => {
    snsSend.mockResolvedValue({ Subscriptions: [] });
    await removeRecipientByEmail('someone@example.com');
    const sentSubscribe = snsSend.mock.calls.some((c) => c[0] instanceof SubscribeCommand);
    expect(sentSubscribe).toBe(false);
  });

  it('rejects an empty email', async () => {
    const result = await removeRecipientByEmail('   ');
    expect(result.ok).toBe(false);
    expect(snsSend).not.toHaveBeenCalled();
  });
});
