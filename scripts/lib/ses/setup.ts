/**
 * SES sender identity lifecycle for `no-reply@pgnos.ai` (pgnos public
 * dashboard + email design, Component 5).
 *
 * The application half of this feature already exists and is untouched by
 * this module: `src/lib/email/invite-email.ts` owns invitations, login links,
 * the `email_send_disabled` kill switch, the per-process send cap, the audit
 * rows, and the fail-soft contract. Component 6 of the design says that module
 * stays the sole owner of delivery, so nothing here sends, renders, or
 * addresses a message. This is deploy-time plumbing only:
 *
 *   discover-or-create the domain identity -> attach a custom MAIL FROM
 *   -> emit the PUBLIC DNS records -> report verification + production access
 *
 * WHY A CUSTOM MAIL FROM SUBDOMAIN, AND WHY IT IS THE SAFETY PROPERTY.
 * `pgnos.ai`'s apex carries live Microsoft 365 records — the
 * `MS=ms53482844` verification TXT and company mail routing. Publishing SPF at
 * the apex, or an apex MX, would sit on top of production company email. A
 * custom MAIL FROM moves BOTH of those under `bounce.pgnos.ai`, so every
 * record this module emits lands on a subdomain the apex does not share:
 *
 *   DKIM   <token>._domainkey.pgnos.ai   CNAME  (three, per-token)
 *   MX     bounce.pgnos.ai                       feedback-smtp.<region>...
 *   SPF    bounce.pgnos.ai               TXT     v=spf1 include:amazonses.com
 *   DMARC  _dmarc.pgnos.ai               TXT     p=none (monitoring only)
 *
 * `planSesDnsRecords` is a pure function precisely so that "nothing this
 * feature emits can collide with the apex" is provable in a unit test rather
 * than asserted in review. See the apex-safety test.
 *
 * There is NO secret in this lifecycle. DKIM tokens are public CNAME targets
 * and MUST be published to work, which is why — unlike the connector token in
 * `scripts/lib/public-tunnel/setup.ts` — these values are printed on purpose.
 * Nothing here reads, writes, or returns a credential.
 *
 * Invariants, mirroring `infra/lib/public-dashboard-access.ts`:
 *
 *   1. `pgnos.ai` ONLY. The identity domain is checked against the one zone
 *      this system owns, so creating a sender in another zone is impossible
 *      by construction rather than by review.
 *   2. `salessly.io` IS PROHIBITED, checked FIRST so that zone reports itself
 *      as a prohibition rather than as a generic "wrong domain".
 *   3. ACCOUNT-GUARDED. The account check runs before any AWS mutation, so a
 *      wrong-profile run creates nothing.
 *   4. SANDBOX IS REPORTED, NEVER WORKED AROUND. When production access is
 *      off, this returns the typed human gate. The design forbids weakening
 *      the invite-only model or asking recipients to self-verify.
 *   5. IDEMPOTENT. Re-running discovers the existing identity and re-asserts
 *      the same MAIL FROM, so the command is safe to poll with while DNS
 *      propagates.
 *
 * The SES client is injected as a minimal `{ send }` so the unit tests
 * exercise the real control flow without touching AWS.
 */

import {
  CreateEmailIdentityCommand,
  GetAccountCommand,
  GetEmailIdentityCommand,
  PutEmailIdentityMailFromAttributesCommand,
} from '@aws-sdk/client-sesv2';

/** The one zone this system may create a sender in. */
export const EMAIL_ZONE = 'pgnos.ai';

/** Subdomain that carries the bounce path, keeping the apex untouched. */
export const EMAIL_MAIL_FROM_DOMAIN = `bounce.${EMAIL_ZONE}`;

/** The sender the design names. */
export const EMAIL_DEFAULT_SENDER = `no-reply@${EMAIL_ZONE}`;

/** Dashboard origin the magic links are built from. */
export const EMAIL_DASHBOARD_URL = 'https://app.pgnos.ai';

/**
 * DMARC in MONITORING mode, as the design requires. `p=none` asks receivers
 * to report but never to reject, so publishing it cannot bounce existing
 * Microsoft 365 mail from the apex while DKIM is still propagating.
 */
export const EMAIL_DMARC_VALUE = 'v=DMARC1; p=none;';

/** The exact AWS human gate. Emitted instead of claiming a working sender. */
export const SES_SANDBOX_REMEDIATION =
  'ACTION NEEDED: SES is in the sandbox for this account, so mail can only reach ' +
  'addresses you have separately verified. Invitations to arbitrary client addresses ' +
  'require production access, which is a human-reviewed AWS request. Request it from ' +
  'the SES console (Account dashboard -> Request production access), or with ' +
  '`aws sesv2 put-account-details`. Do NOT work around this by asking recipients to ' +
  'verify themselves, and do not weaken the invite-only model.';

/** A typed operator blocker: expected, actionable, not a crash. */
export class SesSetupBlocker extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SesSetupBlocker';
  }
}

/** Minimal SESv2 surface (the `{ send }` of the real client). */
export interface SesLike {
  send(command: unknown): Promise<Record<string, unknown>>;
}

/** One public DNS record the operator (or the Cloudflare API) must publish. */
export interface SesDnsRecord {
  type: 'CNAME' | 'MX' | 'TXT';
  /** Fully-qualified record name. */
  name: string;
  value: string;
  /** MX only. */
  priority?: number;
  /** Why this record exists, for the operator-facing table. */
  purpose: string;
}

export interface SesSetupResult {
  domain: string;
  sender: string;
  mailFromDomain: string;
  /** True when this run created the identity rather than discovering it. */
  created: boolean;
  /** SES's own words: PENDING | SUCCESS | FAILED | TEMPORARY_FAILURE | NOT_STARTED. */
  dkimStatus: string;
  /** SES's own words: PENDING | SUCCESS | FAILED | TEMPORARY_FAILURE. */
  mailFromStatus: string;
  verifiedForSending: boolean;
  productionAccessEnabled: boolean;
  records: SesDnsRecord[];
  /** Present only when production access is off. */
  sandboxRemediation?: string;
}

/**
 * Build every public DNS record for a verified SES sender.
 *
 * Pure and side-effect free so the apex-safety invariant is unit-testable:
 * every emitted name is either `_dmarc.<domain>`, `<something>.<domain>` under
 * the MAIL FROM subdomain, or a `_domainkey` CNAME. None is the bare apex.
 */
export function planSesDnsRecords(
  domain: string,
  dkimTokens: readonly string[],
  region: string,
): SesDnsRecord[] {
  const mailFrom = `bounce.${domain}`;
  const records: SesDnsRecord[] = dkimTokens.map((token) => ({
    type: 'CNAME',
    name: `${token}._domainkey.${domain}`,
    value: `${token}.dkim.amazonses.com`,
    purpose: 'SES Easy DKIM signing key',
  }));

  records.push({
    type: 'MX',
    name: mailFrom,
    // Region-specific by design: the feedback endpoint must match the sending
    // region or MAIL FROM verification never leaves PENDING.
    value: `feedback-smtp.${region}.amazonses.com`,
    priority: 10,
    purpose: 'Custom MAIL FROM bounce and complaint path',
  });

  records.push({
    type: 'TXT',
    name: mailFrom,
    value: 'v=spf1 include:amazonses.com ~all',
    // Deliberately on the subdomain: an apex SPF would sit on top of the live
    // Microsoft 365 records and is not ours to publish.
    purpose: 'SPF authorizing SES for the MAIL FROM subdomain only',
  });

  records.push({
    type: 'TXT',
    name: `_dmarc.${domain}`,
    value: EMAIL_DMARC_VALUE,
    purpose: 'DMARC in monitoring mode (p=none, never rejects)',
  });

  return records;
}

/** Extract the domain from a sender address, or throw a typed blocker. */
export function senderDomain(sender: string): string {
  const at = sender.lastIndexOf('@');
  const domain = at === -1 ? '' : sender.slice(at + 1).trim().toLowerCase();
  if (!domain || !sender.slice(0, at).trim()) {
    throw new SesSetupBlocker(`invalid CCE_EMAIL_FROM address: ${sender || '(empty)'}`);
  }
  return domain;
}

/**
 * Guard the target domain. Invariant 2 runs BEFORE invariant 1 so every
 * `salessly.io` form reports the prohibition rather than a generic mismatch.
 */
export function assertPublishableDomain(domain: string): void {
  if (domain === 'salessly.io' || domain.endsWith('.salessly.io')) {
    throw new SesSetupBlocker('salessly.io is prohibited for Netzar email setup');
  }
  if (domain !== EMAIL_ZONE) {
    throw new SesSetupBlocker(`CCE_EMAIL_FROM must be inside ${EMAIL_ZONE}: got ${domain}`);
  }
}

function nameOf(err: unknown): string {
  return (err as { name?: string } | null)?.name ?? '';
}

export interface SyncSesIdentityOptions {
  /** The only account allowed to receive these writes. */
  expectedAccountId: string;
  /** What STS actually reports for the current credentials. */
  actualAccountId: string;
  /** Full sender address, e.g. `no-reply@pgnos.ai`. */
  sender: string;
  region: string;
  ses: SesLike;
  /** Progress sink. */
  log?: (line: string) => void;
}

/**
 * Discover-or-create the SES domain identity, attach the custom MAIL FROM,
 * and report DNS + verification + production access.
 *
 * Order matters: the account guard runs before any AWS write, so a
 * wrong-profile run mutates nothing.
 */
export async function syncSesIdentity(
  opts: SyncSesIdentityOptions,
): Promise<SesSetupResult> {
  const { expectedAccountId, actualAccountId, sender, region, ses } = opts;
  const log = opts.log ?? ((): void => {});

  // Invariant 3: account identity, before anything is created.
  if (!expectedAccountId) {
    throw new SesSetupBlocker(
      'refusing to run without an expected AWS account id (AWS_ACCOUNT_ID); ' +
        'this command must never create a sender in whatever account happens to be current',
    );
  }
  if (actualAccountId !== expectedAccountId) {
    throw new SesSetupBlocker(
      `refusing to create an SES identity: expected ${expectedAccountId}, ` +
        `current credentials resolve to ${actualAccountId || '(unknown)'}`,
    );
  }

  // Invariants 1 and 2.
  const domain = senderDomain(sender);
  assertPublishableDomain(domain);
  log(`AWS account ${expectedAccountId} confirmed; target domain ${domain}.`);

  // Invariant 5: discover first, create only when genuinely absent.
  let identity: Record<string, any> | null = null;
  try {
    identity = (await ses.send(
      new GetEmailIdentityCommand({ EmailIdentity: domain }),
    )) as Record<string, any>;
  } catch (err) {
    if (nameOf(err) !== 'NotFoundException') throw err;
  }

  let created = false;
  if (!identity) {
    log(`No SES identity for ${domain}; creating it with Easy DKIM.`);
    await ses.send(new CreateEmailIdentityCommand({ EmailIdentity: domain }));
    created = true;
    identity = (await ses.send(
      new GetEmailIdentityCommand({ EmailIdentity: domain }),
    )) as Record<string, any>;
  } else {
    log(`Found existing SES identity for ${domain}.`);
  }

  // Re-asserting the same MAIL FROM is a no-op in SES, which is what makes
  // the whole command safe to re-run while DNS propagates.
  const currentMailFrom = identity?.MailFromAttributes?.MailFromDomain as string | undefined;
  if (currentMailFrom !== EMAIL_MAIL_FROM_DOMAIN) {
    log(`Setting custom MAIL FROM to ${EMAIL_MAIL_FROM_DOMAIN}.`);
    await ses.send(
      new PutEmailIdentityMailFromAttributesCommand({
        EmailIdentity: domain,
        MailFromDomain: EMAIL_MAIL_FROM_DOMAIN,
        // USE_DEFAULT_VALUE, not REJECT_MESSAGE: during propagation the MX may
        // not resolve yet, and rejecting would drop real invitations. SES
        // falls back to amazonses.com until the record lands.
        BehaviorOnMxFailure: 'USE_DEFAULT_VALUE',
      }),
    );
    identity = (await ses.send(
      new GetEmailIdentityCommand({ EmailIdentity: domain }),
    )) as Record<string, any>;
  }

  const dkimTokens: string[] = identity?.DkimAttributes?.Tokens ?? [];
  const dkimStatus: string = identity?.DkimAttributes?.Status ?? 'NOT_STARTED';
  const mailFromStatus: string = identity?.MailFromAttributes?.MailFromDomainStatus ?? 'PENDING';
  const verifiedForSending = Boolean(identity?.VerifiedForSendingStatus);

  // Invariant 4: report the sandbox, never route around it.
  const account = (await ses.send(new GetAccountCommand({}))) as Record<string, any>;
  const productionAccessEnabled = Boolean(account?.ProductionAccessEnabled);

  return {
    domain,
    sender,
    mailFromDomain: EMAIL_MAIL_FROM_DOMAIN,
    created,
    dkimStatus,
    mailFromStatus,
    verifiedForSending,
    productionAccessEnabled,
    records: planSesDnsRecords(domain, dkimTokens, region),
    ...(productionAccessEnabled ? {} : { sandboxRemediation: SES_SANDBOX_REMEDIATION }),
  };
}
