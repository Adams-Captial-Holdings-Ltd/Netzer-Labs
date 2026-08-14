import { describe, it, expect } from 'vitest';
import {
  syncSesIdentity,
  planSesDnsRecords,
  senderDomain,
  assertPublishableDomain,
  SesSetupBlocker,
  EMAIL_MAIL_FROM_DOMAIN,
  EMAIL_ZONE,
  SES_SANDBOX_REMEDIATION,
  type SesLike,
} from './setup.js';

/**
 * The value at risk in this feature is not a secret — DKIM tokens are public
 * by design. It is the `pgnos.ai` APEX, which carries live Microsoft 365
 * records (`MS=ms53482844`) and company mail routing. These tests pin the
 * invariant that makes this component safe to run against a domain already
 * serving production email: nothing it emits ever lands on the apex.
 *
 * They also pin the ordering guarantee that makes a wrong-profile run
 * harmless, and the design's refusal to route around the SES sandbox.
 */

const ACCOUNT = '239887088812';
const REGION = 'us-east-1';
const SENDER = 'no-reply@pgnos.ai';
const TOKENS = ['tok1', 'tok2', 'tok3'];

function sesStub(
  opts: {
    identity?: Record<string, unknown> | null;
    productionAccess?: boolean;
    calls?: string[];
  } = {},
) {
  const calls = opts.calls ?? [];
  // Mutable so the "create then re-read" path can flip from absent to present.
  let identity = opts.identity === undefined ? defaultIdentity() : opts.identity;
  const client: SesLike = {
    async send(command: unknown): Promise<Record<string, unknown>> {
      const name = (command as { constructor: { name: string } }).constructor.name;
      calls.push(name);
      if (name === 'GetEmailIdentityCommand') {
        if (!identity) {
          const err = new Error('not found');
          err.name = 'NotFoundException';
          throw err;
        }
        return identity as Record<string, unknown>;
      }
      if (name === 'CreateEmailIdentityCommand') {
        identity = defaultIdentity();
        return {};
      }
      if (name === 'PutEmailIdentityMailFromAttributesCommand') {
        identity = defaultIdentity({ MailFromDomain: EMAIL_MAIL_FROM_DOMAIN });
        return {};
      }
      if (name === 'GetAccountCommand') {
        return { ProductionAccessEnabled: opts.productionAccess ?? false };
      }
      return {};
    },
  };
  return { client, calls };
}

function defaultIdentity(mailFrom?: Record<string, unknown>): Record<string, unknown> {
  return {
    VerifiedForSendingStatus: false,
    DkimAttributes: { Status: 'PENDING', Tokens: TOKENS },
    MailFromAttributes: {
      MailFromDomainStatus: 'PENDING',
      ...(mailFrom ?? {}),
    },
  };
}

describe('planSesDnsRecords — apex safety', () => {
  it('never emits a record at the bare apex, so Microsoft 365 records are untouched', () => {
    const records = planSesDnsRecords(EMAIL_ZONE, TOKENS, REGION);
    expect(records.length).toBeGreaterThan(0);
    for (const r of records) {
      expect(r.name).not.toBe(EMAIL_ZONE);
      expect(r.name.endsWith(`.${EMAIL_ZONE}`)).toBe(true);
    }
  });

  it('puts SPF on the MAIL FROM subdomain, never at the apex', () => {
    const records = planSesDnsRecords(EMAIL_ZONE, TOKENS, REGION);
    const spf = records.filter((r) => r.value.startsWith('v=spf1'));
    expect(spf).toHaveLength(1);
    expect(spf[0]!.name).toBe(EMAIL_MAIL_FROM_DOMAIN);
    expect(spf[0]!.type).toBe('TXT');
  });

  it('puts the bounce MX on the subdomain with a region-matched endpoint', () => {
    const records = planSesDnsRecords(EMAIL_ZONE, TOKENS, 'eu-west-1');
    const mx = records.filter((r) => r.type === 'MX');
    expect(mx).toHaveLength(1);
    expect(mx[0]!.name).toBe(EMAIL_MAIL_FROM_DOMAIN);
    expect(mx[0]!.value).toBe('feedback-smtp.eu-west-1.amazonses.com');
    expect(mx[0]!.priority).toBe(10);
  });

  it('emits one DKIM CNAME per token', () => {
    const records = planSesDnsRecords(EMAIL_ZONE, TOKENS, REGION);
    const dkim = records.filter((r) => r.name.includes('._domainkey.'));
    expect(dkim).toHaveLength(3);
    expect(dkim[0]!.name).toBe(`tok1._domainkey.${EMAIL_ZONE}`);
    expect(dkim[0]!.value).toBe('tok1.dkim.amazonses.com');
    expect(dkim[0]!.type).toBe('CNAME');
  });

  it('publishes DMARC in monitoring mode so it can never reject live mail', () => {
    const records = planSesDnsRecords(EMAIL_ZONE, TOKENS, REGION);
    const dmarc = records.find((r) => r.name === `_dmarc.${EMAIL_ZONE}`);
    expect(dmarc).toBeDefined();
    expect(dmarc!.value).toContain('p=none');
    expect(dmarc!.value).not.toContain('p=reject');
    expect(dmarc!.value).not.toContain('p=quarantine');
  });
});

describe('domain guards', () => {
  it('extracts the sender domain', () => {
    expect(senderDomain('no-reply@pgnos.ai')).toBe('pgnos.ai');
    expect(senderDomain('No-Reply@PGNOS.AI')).toBe('pgnos.ai');
  });

  it('rejects a malformed sender', () => {
    expect(() => senderDomain('pgnos.ai')).toThrow(SesSetupBlocker);
    expect(() => senderDomain('@pgnos.ai')).toThrow(SesSetupBlocker);
    expect(() => senderDomain('')).toThrow(SesSetupBlocker);
  });

  it('reports salessly.io as a PROHIBITION, not a generic mismatch', () => {
    // Checked before the zone comparison so the message names the real rule.
    expect(() => assertPublishableDomain('salessly.io')).toThrow(/prohibited/);
    expect(() => assertPublishableDomain('mail.salessly.io')).toThrow(/prohibited/);
  });

  it('refuses any zone other than pgnos.ai', () => {
    expect(() => assertPublishableDomain('example.com')).toThrow(/must be inside pgnos.ai/);
    expect(() => assertPublishableDomain(EMAIL_ZONE)).not.toThrow();
  });
});

describe('syncSesIdentity', () => {
  it('refuses a wrong account BEFORE touching SES', async () => {
    const { client, calls } = sesStub();
    await expect(
      syncSesIdentity({
        expectedAccountId: ACCOUNT,
        actualAccountId: '000000000000',
        sender: SENDER,
        region: REGION,
        ses: client,
      }),
    ).rejects.toThrow(SesSetupBlocker);
    expect(calls).toHaveLength(0);
  });

  it('refuses when no expected account is configured', async () => {
    const { client, calls } = sesStub();
    await expect(
      syncSesIdentity({
        expectedAccountId: '',
        actualAccountId: ACCOUNT,
        sender: SENDER,
        region: REGION,
        ses: client,
      }),
    ).rejects.toThrow(/without an expected AWS account id/);
    expect(calls).toHaveLength(0);
  });

  it('refuses salessly.io before creating anything', async () => {
    const { client, calls } = sesStub();
    await expect(
      syncSesIdentity({
        expectedAccountId: ACCOUNT,
        actualAccountId: ACCOUNT,
        sender: 'no-reply@salessly.io',
        region: REGION,
        ses: client,
      }),
    ).rejects.toThrow(/prohibited/);
    expect(calls).toHaveLength(0);
  });

  it('creates the identity when SES reports NotFoundException', async () => {
    const { client, calls } = sesStub({ identity: null });
    const result = await syncSesIdentity({
      expectedAccountId: ACCOUNT,
      actualAccountId: ACCOUNT,
      sender: SENDER,
      region: REGION,
      ses: client,
    });
    expect(result.created).toBe(true);
    expect(calls).toContain('CreateEmailIdentityCommand');
    expect(result.records.filter((r) => r.type === 'CNAME')).toHaveLength(3);
  });

  it('discovers an existing identity without creating a second one', async () => {
    const { client, calls } = sesStub();
    const result = await syncSesIdentity({
      expectedAccountId: ACCOUNT,
      actualAccountId: ACCOUNT,
      sender: SENDER,
      region: REGION,
      ses: client,
    });
    expect(result.created).toBe(false);
    expect(calls).not.toContain('CreateEmailIdentityCommand');
  });

  it('is idempotent: re-asserting an already-correct MAIL FROM writes nothing', async () => {
    const { client, calls } = sesStub({
      identity: defaultIdentity({ MailFromDomain: EMAIL_MAIL_FROM_DOMAIN }),
    });
    await syncSesIdentity({
      expectedAccountId: ACCOUNT,
      actualAccountId: ACCOUNT,
      sender: SENDER,
      region: REGION,
      ses: client,
    });
    expect(calls).not.toContain('PutEmailIdentityMailFromAttributesCommand');
  });

  it('attaches the custom MAIL FROM when it is absent', async () => {
    const { client, calls } = sesStub();
    const result = await syncSesIdentity({
      expectedAccountId: ACCOUNT,
      actualAccountId: ACCOUNT,
      sender: SENDER,
      region: REGION,
      ses: client,
    });
    expect(calls).toContain('PutEmailIdentityMailFromAttributesCommand');
    expect(result.mailFromDomain).toBe(EMAIL_MAIL_FROM_DOMAIN);
  });

  it('surfaces the sandbox human gate instead of claiming a working sender', async () => {
    const { client } = sesStub({ productionAccess: false });
    const result = await syncSesIdentity({
      expectedAccountId: ACCOUNT,
      actualAccountId: ACCOUNT,
      sender: SENDER,
      region: REGION,
      ses: client,
    });
    expect(result.productionAccessEnabled).toBe(false);
    expect(result.sandboxRemediation).toBe(SES_SANDBOX_REMEDIATION);
    // The design forbids the workaround of asking recipients to self-verify.
    expect(result.sandboxRemediation).toMatch(/do not weaken the invite-only model/i);
  });

  it('omits the remediation once production access is enabled', async () => {
    const { client } = sesStub({ productionAccess: true });
    const result = await syncSesIdentity({
      expectedAccountId: ACCOUNT,
      actualAccountId: ACCOUNT,
      sender: SENDER,
      region: REGION,
      ses: client,
    });
    expect(result.productionAccessEnabled).toBe(true);
    expect(result.sandboxRemediation).toBeUndefined();
  });
});
