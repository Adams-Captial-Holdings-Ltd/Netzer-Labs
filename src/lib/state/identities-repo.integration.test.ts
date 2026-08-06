/**
 * Integration test: identities-repo against LocalStack.
 *
 * Exercises the full claim flow end-to-end against a real DDB. Skips
 * if LocalStack is not running.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import {
  ensureLocalStack,
  configureLocalAwsEnv,
  createDdbTable,
} from '../../__test-utils__/localstack.js';

const TABLE = 'claudeclaw-integ-identities';

beforeAll(async () => {
  configureLocalAwsEnv();
  process.env.TABLE_IDENTITIES = TABLE;
  delete process.env.CCE_IDENTITY_RESOLUTION_DISABLED;
  await ensureLocalStack();
  await createDdbTable({
    name: TABLE,
    partitionKey: { name: 'PK', type: 'S' },
    sortKey: { name: 'SK', type: 'S' },
  });
});

// Import AFTER configureLocalAwsEnv + TABLE_IDENTITIES are set, so the
// repo's TABLE constant captures the right table name on first read.
async function loadRepo(): Promise<typeof import('./identities-repo.js')> {
  return await import('./identities-repo.js');
}

describe('identities-repo (LocalStack)', () => {
  it('end-to-end: start on slack, complete on telegram, both surfaces resolve to the same canonical id', async () => {
    const repo = await loadRepo();
    const pending = await repo.startClaim({
      surface: 'slack',
      surfaceUserId: 'U05NFC6BUSC',
    });
    expect(pending.code).toMatch(/^\d{6}$/);
    expect(pending.canonicalId).toBeTruthy();

    const result = await repo.completeClaim({
      code: pending.code,
      surface: 'telegram',
      surfaceUserId: '987654321',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`completeClaim failed: ${result.reason}`);
    expect(result.canonicalId).toBe(pending.canonicalId);

    const fromSlack = await repo.resolveCanonical('slack', 'U05NFC6BUSC');
    const fromTelegram = await repo.resolveCanonical('telegram', '987654321');
    expect(fromSlack).toBe(pending.canonicalId);
    expect(fromTelegram).toBe(pending.canonicalId);
  });

  it('rejects completing from the same surface that started the claim', async () => {
    const repo = await loadRepo();
    const pending = await repo.startClaim({
      surface: 'slack',
      surfaceUserId: 'U_SAMETEST',
    });
    const result = await repo.completeClaim({
      code: pending.code,
      surface: 'slack',
      surfaceUserId: 'U_SAMETEST',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/different surface/);
  });

  it('treats an unknown code as expired/unknown', async () => {
    const repo = await loadRepo();
    const result = await repo.completeClaim({
      code: '000000',
      surface: 'telegram',
      surfaceUserId: 'nope',
    });
    expect(result.ok).toBe(false);
  });

  it('lists every surface bound to a canonical id', async () => {
    const repo = await loadRepo();
    const pending = await repo.startClaim({
      surface: 'slack',
      surfaceUserId: 'U_LIST_TEST',
    });
    await repo.completeClaim({
      code: pending.code,
      surface: 'telegram',
      surfaceUserId: 'tg-list-test',
    });
    const links = await repo.listLinks(pending.canonicalId);
    const surfaces = links.map((l) => l.surface).sort();
    expect(surfaces).toContain('slack');
    expect(surfaces).toContain('telegram');
  });

  it('honors CCE_IDENTITY_RESOLUTION_DISABLED', async () => {
    const repo = await loadRepo();
    process.env.CCE_IDENTITY_RESOLUTION_DISABLED = '1';
    const result = await repo.resolveCanonical('slack', 'U05NFC6BUSC');
    expect(result).toBeUndefined();
    delete process.env.CCE_IDENTITY_RESOLUTION_DISABLED;
  });
});
