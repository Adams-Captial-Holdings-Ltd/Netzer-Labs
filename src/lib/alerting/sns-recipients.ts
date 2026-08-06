/**
 * SNS alert-recipient management (ops alerts topic).
 *
 * Wraps the existing ClaudeClaw ops-alerts SNS topic (ARN in
 * CCE_ALERT_TOPIC_ARN) so the dashboard can manage who receives the
 * CloudWatch alarm notifications wired to that topic. The only AWS write
 * here is a scoped sns:Subscribe / sns:Unsubscribe on that single topic.
 * No secret values are ever read or written.
 *
 * Email subscriptions follow the AWS-native confirmation flow: Subscribe
 * with the email protocol returns immediately with a subscription that
 * stays 'PendingConfirmation' until the recipient clicks the AWS-sent
 * confirmation link. We surface that status verbatim from
 * ListSubscriptionsByTopic so the UI shows pending vs confirmed.
 *
 * We also mirror the intended recipient list into runtime-config
 * (category 'alerting', key 'recipients') so the dashboard has a durable
 * record of who an admin added even before SNS confirms, and survives a
 * transient SNS read failure.
 *
 * Every AWS call is fail-soft: a denied permission or transient error
 * degrades to an empty/last-known result and logs loudly rather than
 * throwing into the request handler.
 */

import {
  SNSClient,
  SubscribeCommand,
  UnsubscribeCommand,
  ListSubscriptionsByTopicCommand,
  type Subscription,
} from '@aws-sdk/client-sns';
import { logger } from '../../observability/logger.js';
import { getConfig, setConfig } from '../state/runtime-config-repo.js';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const CONFIG_CATEGORY = 'alerting';
const CONFIG_KEY = 'recipients';

let _sns: SNSClient | null = null;
function sns(): SNSClient {
  if (!_sns) _sns = new SNSClient({ region: REGION });
  return _sns;
}

function topicArn(): string | undefined {
  const arn = process.env.CCE_ALERT_TOPIC_ARN;
  return arn && arn.length > 0 ? arn : undefined;
}

export interface SubscribeResult {
  arn?: string;
  status: 'PendingConfirmation' | 'Confirmed' | 'error' | 'not_configured';
  error?: string;
}

export interface RecipientStatus {
  email: string;
  status: string;
  subscriptionArn?: string;
  // Where this recipient came from when the live SNS read SUCCEEDED:
  //  - 'sns'       a real subscription row exists at SNS (confirmed -> has arn,
  //                or pending -> no arn but the confirmation link is live).
  //  - 'persisted' only our durable intent record has it; SNS has no row, so
  //                nothing is or can become active at SNS for this email.
  // Undefined when snsOk is false (we could not read SNS, so we cannot tell).
  source?: 'sns' | 'persisted';
}

interface PersistedRecipient {
  email: string;
  addedBy?: string;
  addedAt?: string;
}

/**
 * Read the durable intended-recipients record from runtime-config.
 * Fail-soft: returns [] on any parse or read error.
 */
async function readPersistedRecipients(): Promise<PersistedRecipient[]> {
  try {
    const raw = await getConfig(CONFIG_CATEGORY, CONFIG_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (r): r is PersistedRecipient =>
        typeof r === 'object' && r !== null && typeof (r as PersistedRecipient).email === 'string',
    );
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'alerting recipients read failed — failing open',
    );
    return [];
  }
}

/**
 * Add or update an email in the durable intended-recipients record.
 * Fail-soft: a write error logs and returns without throwing.
 */
async function persistRecipient(email: string, addedBy?: string): Promise<void> {
  try {
    const existing = await readPersistedRecipients();
    const next = existing.filter((r) => r.email.toLowerCase() !== email.toLowerCase());
    next.push({ email, addedBy, addedAt: new Date().toISOString() });
    await setConfig(CONFIG_CATEGORY, CONFIG_KEY, JSON.stringify(next), {
      updatedBy: addedBy ?? 'dashboard',
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'alerting recipients persist failed — continuing',
    );
  }
}

/**
 * Remove an email from the durable intended-recipients record by matching
 * a subscription ARN's email if we can resolve it, otherwise no-op. Used
 * when an admin unsubscribes.
 */
async function unpersistByEmail(email: string, updatedBy?: string): Promise<void> {
  try {
    const existing = await readPersistedRecipients();
    const next = existing.filter((r) => r.email.toLowerCase() !== email.toLowerCase());
    if (next.length === existing.length) return;
    await setConfig(CONFIG_CATEGORY, CONFIG_KEY, JSON.stringify(next), {
      updatedBy: updatedBy ?? 'dashboard',
    });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'alerting recipients unpersist failed — continuing',
    );
  }
}

/**
 * Subscribe an email to the ops-alerts topic. AWS sends a confirmation
 * link; the subscription stays PendingConfirmation until the recipient
 * clicks it. Mirrors the intended recipient into runtime-config so the UI
 * has a durable record even before SNS confirms. Fail-soft.
 */
export async function subscribeEmail(
  email: string,
  opts?: { addedBy?: string },
): Promise<SubscribeResult> {
  const arn = topicArn();
  if (!arn) {
    logger.warn({}, 'subscribeEmail called but CCE_ALERT_TOPIC_ARN is not set');
    return { status: 'not_configured', error: 'alert topic not configured' };
  }
  // Persist intent first so the durable record exists even if SNS errors.
  await persistRecipient(email, opts?.addedBy);
  try {
    const out = await sns().send(
      new SubscribeCommand({
        TopicArn: arn,
        Protocol: 'email',
        Endpoint: email,
        ReturnSubscriptionArn: true,
      }),
    );
    // For email, AWS returns 'pending confirmation' as the ARN until the
    // recipient confirms, so treat a non-ARN value as still pending.
    const subArn = out.SubscriptionArn;
    const confirmed = typeof subArn === 'string' && subArn.startsWith('arn:');
    return {
      arn: confirmed ? subArn : undefined,
      status: confirmed ? 'Confirmed' : 'PendingConfirmation',
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, 'sns subscribe failed — failing soft');
    return { status: 'error', error: msg };
  }
}

/**
 * Result of resolving the recipient list. `snsOk` records whether the live
 * ListSubscriptionsByTopic read actually succeeded, so callers that must NOT
 * treat a read failure as "no confirmed subscription" can tell the two cases
 * apart. When `snsOk` is false the recipients are the persisted fallback (all
 * marked PendingConfirmation) and carry no real ARN, so a confirmed-vs-pending
 * decision cannot be made from them.
 */
interface ResolvedRecipients {
  recipients: RecipientStatus[];
  snsOk: boolean;
}

/**
 * Resolve the topic's subscriptions joined with the durable intended-recipient
 * record, surfacing whether the live SNS read succeeded. When SNS is unset or
 * the read fails, `snsOk` is false and the recipients are the persisted
 * fallback (all PendingConfirmation, no ARN). This is the shared core behind
 * listSubscriptions() and the removal path, which needs the snsOk flag.
 */
async function resolveRecipients(): Promise<ResolvedRecipients> {
  const arn = topicArn();
  const persisted = await readPersistedRecipients();

  if (!arn) {
    return {
      recipients: persisted.map((r) => ({ email: r.email, status: 'PendingConfirmation' })),
      snsOk: false,
    };
  }

  let subs: Subscription[] = [];
  let snsOk = true;
  try {
    let nextToken: string | undefined;
    do {
      const out = await sns().send(
        new ListSubscriptionsByTopicCommand({ TopicArn: arn, NextToken: nextToken }),
      );
      subs = subs.concat(out.Subscriptions ?? []);
      nextToken = out.NextToken;
    } while (nextToken);
  } catch (err) {
    snsOk = false;
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'sns list subscriptions failed — falling back to persisted recipients',
    );
  }

  if (!snsOk) {
    return {
      recipients: persisted.map((r) => ({ email: r.email, status: 'PendingConfirmation' })),
      snsOk: false,
    };
  }

  const byEmail = new Map<string, RecipientStatus>();

  // SNS truth first (email protocol only).
  for (const s of subs) {
    if (s.Protocol !== 'email' || !s.Endpoint) continue;
    const rawArn = s.SubscriptionArn;
    const confirmed = typeof rawArn === 'string' && rawArn.startsWith('arn:');
    byEmail.set(s.Endpoint.toLowerCase(), {
      email: s.Endpoint,
      status: confirmed ? 'Confirmed' : 'PendingConfirmation',
      subscriptionArn: confirmed ? rawArn : undefined,
      // A live SNS row, even when pending: the confirmation link is out there
      // and could still be clicked, so removal must treat it differently from a
      // persisted-only intent.
      source: 'sns',
    });
  }

  // Add persisted recipients SNS does not yet report (added, never reached SNS
  // as a subscription). These are intent-only: nothing is or can become active
  // at SNS for them, so removal can safely just drop the durable record.
  for (const r of persisted) {
    if (!byEmail.has(r.email.toLowerCase())) {
      byEmail.set(r.email.toLowerCase(), { email: r.email, status: 'PendingConfirmation', source: 'persisted' });
    }
  }

  return { recipients: Array.from(byEmail.values()), snsOk: true };
}

/**
 * List the topic's subscriptions, joined with the durable intended-recipient
 * record so emails that were added but never confirmed still appear. Returns
 * email + status (PendingConfirmation / Confirmed / Deleted). Fail-soft:
 * falls back to the persisted record (all marked PendingConfirmation) when
 * the SNS read fails.
 */
export async function listSubscriptions(): Promise<RecipientStatus[]> {
  const { recipients } = await resolveRecipients();
  return recipients;
}

/**
 * Unsubscribe a subscription by ARN and drop the matching email from the
 * durable record. Fail-soft: a denied/transient error logs and returns
 * { ok: false } rather than throwing.
 */
export async function unsubscribe(
  subscriptionArn: string,
  opts?: { updatedBy?: string },
): Promise<{ ok: boolean; error?: string }> {
  if (!subscriptionArn || !subscriptionArn.startsWith('arn:')) {
    return { ok: false, error: 'a confirmed subscription ARN is required' };
  }
  // Resolve the email behind this ARN (best effort) so we can also prune
  // the durable record.
  let email: string | undefined;
  try {
    const subs = await listSubscriptions();
    email = subs.find((s) => s.subscriptionArn === subscriptionArn)?.email;
  } catch {
    // best effort only
  }

  try {
    await sns().send(new UnsubscribeCommand({ SubscriptionArn: subscriptionArn }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, 'sns unsubscribe failed — failing soft');
    return { ok: false, error: msg };
  }

  if (email) await unpersistByEmail(email, opts?.updatedBy);
  return { ok: true };
}

/**
 * Remove a recipient by email. Resolves the email against live SNS state (via
 * resolveRecipients) and acts per case:
 *   - confirmed (has ARN): Unsubscribe by ARN, then prune the durable record.
 *   - persisted-only (SNS read OK, no SNS row): nothing is or can become active
 *     at SNS, so just prune the durable record and report success.
 *   - live-pending at SNS (SNS read OK, a pending email row, no ARN): AWS has no
 *     API to cancel a pending email subscription, and pruning our intent would
 *     not stop a later confirmation, so we REFUSE and report ok:false rather
 *     than claim a removal that could silently confirm later.
 *
 * Read failures are NOT swallowed here: a "no ARN" result is only safe to
 * treat as pending-only when the live SNS read actually SUCCEEDED. If the
 * ListSubscriptionsByTopic read failed (snsOk === false) we cannot tell a
 * genuinely-pending recipient from a still-confirmed one whose ARN we just
 * could not read, so we refuse to unpersist and return { ok: false } rather
 * than report a false success that would leave a confirmed subscription active.
 *
 * This is the email-keyed entry point the dashboard DELETE route uses; the
 * page never has a subscription ARN for pending rows, so it cannot key on one.
 */
export async function removeRecipientByEmail(
  email: string,
  opts?: { updatedBy?: string },
): Promise<{ ok: boolean; error?: string }> {
  const target = email.trim().toLowerCase();
  if (!target) return { ok: false, error: 'an email is required' };

  // Resolve email -> confirmed subscription ARN from live SNS state, and learn
  // whether that live read actually succeeded.
  let resolved: ResolvedRecipients;
  try {
    resolved = await resolveRecipients();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, 'removeRecipientByEmail: resolve failed — cannot confirm removal');
    return { ok: false, error: 'could not confirm removal, try again' };
  }

  if (!resolved.snsOk) {
    // SNS was unreadable: a "no ARN" recipient might still be confirmed at SNS.
    // Do NOT unpersist and do NOT report success, so the dashboard surfaces a
    // retryable failure instead of silently leaving a live subscription armed.
    logger.warn(
      { email: target },
      'removeRecipientByEmail: SNS unreadable — refusing to report removal',
    );
    return { ok: false, error: 'could not confirm removal, try again' };
  }

  const match = resolved.recipients.find((s) => s.email.toLowerCase() === target);
  const arn = match?.subscriptionArn;

  if (arn) {
    // Confirmed subscription: unsubscribe by ARN (also prunes the record).
    return unsubscribe(arn, opts);
  }

  if (match?.source === 'sns') {
    // A LIVE pending email subscription exists at SNS: the confirmation link was
    // sent and not yet clicked. AWS has no API to cancel a pending email
    // subscription before it confirms or expires (about 3 days), and dropping
    // our durable intent would NOT stop the recipient from later clicking the
    // link and becoming confirmed AFTER we told the admin they were removed. So
    // refuse, keep the record honest, and explain it cannot be removed yet.
    return {
      ok: false,
      error:
        'This recipient has a pending email subscription that has not been confirmed yet. AWS cannot cancel a pending subscription; it expires on its own if the link is never clicked (about 3 days). Try again after it confirms or expires.',
    };
  }

  // Persisted-only intent: the live SNS read succeeded and has NO subscription
  // for this email, so nothing is or can become active at SNS. Safe to drop the
  // durable intent record and report success.
  await unpersistByEmail(email, opts?.updatedBy);
  return { ok: true };
}

/** The configured ops-alerts topic ARN (CCE_ALERT_TOPIC_ARN), or null. */
export function getAlertTopicArn(): string | null {
  return topicArn() ?? null;
}
