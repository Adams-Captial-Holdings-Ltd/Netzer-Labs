import { describe, it, expect } from 'vitest';
import {
  appendJournal,
  journalEventKey,
  type JournalEntry,
  LATEST_MANIFEST_KEY,
  manifestKey,
  promoteManifest,
  readLatestManifest,
} from './journal.js';
import {
  APP_SCHEMA_VERSION,
  type DeployManifest,
  MANIFEST_SCHEMA_VERSION,
} from './manifest.js';

const DEPLOY_ID = 'CCE-20260611123456-0123456789ab-d34d';

function entry(seq: number, event = 'image-pushed'): JournalEntry {
  return {
    deployId: DEPLOY_ID,
    seq,
    event,
    at: '2026-06-11T12:35:00.000Z',
    fencingToken: 3,
    data: { digest: 'sha256:abc' },
  };
}

function manifest(): DeployManifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    appSchemaVersion: APP_SCHEMA_VERSION,
    deployId: DEPLOY_ID,
    gitSha: '0123456789abcdef0123456789abcdef01234567',
    cleanTree: true,
    account: '111122223333',
    region: 'us-east-1',
    tier: 1,
    mode: 'infra-only',
    featureFlags: {},
    imageTag: DEPLOY_ID,
    ecrRepo: 'claudeclaw-orchestrator',
    images: [],
    cdkVersion: '2.170.0',
    synthInputs: {},
    stacks: ['CCE-Network'],
    stackTemplateHashes: {},
    secretVersions: [],
    deployedAt: '2026-06-11T12:40:00.000Z',
  };
}

/**
 * Recording fake S3: stores objects by key and enforces IfNoneMatch '*'
 * exactly the way S3 conditional writes do (412 PreconditionFailed when the
 * object already exists).
 */
function fakeS3() {
  const objects = new Map<string, string>();
  const calls: { name: string; input: any }[] = [];
  return {
    objects,
    calls,
    send: async (cmd: any): Promise<any> => {
      const name = cmd.constructor.name as string;
      const input = cmd.input;
      calls.push({ name, input });
      if (name === 'PutObjectCommand') {
        if (input.IfNoneMatch === '*' && objects.has(input.Key)) {
          throw Object.assign(new Error('At least one of the pre-conditions you specified did not hold'), {
            name: 'PreconditionFailed',
            $metadata: { httpStatusCode: 412 },
          });
        }
        objects.set(input.Key, input.Body);
        return {};
      }
      if (name === 'GetObjectCommand') {
        if (!objects.has(input.Key)) {
          throw Object.assign(new Error('The specified key does not exist.'), {
            name: 'NoSuchKey',
            $metadata: { httpStatusCode: 404 },
          });
        }
        const body = objects.get(input.Key)!;
        return { Body: { transformToString: async () => body } };
      }
      throw new Error(`fakeS3: unexpected command ${name}`);
    },
  };
}

describe('journalEventKey', () => {
  it('pads seq to 4 digits inside the per-deploy prefix', () => {
    expect(journalEventKey(DEPLOY_ID, 7, 'secret-written')).toBe(
      `deploys/${DEPLOY_ID}/journal/0007-secret-written.json`,
    );
  });

  it('rejects bad deploy ids, negative seq, and unsafe event names', () => {
    expect(() => journalEventKey('nope', 1, 'x')).toThrow(/not a valid deploy id/);
    expect(() => journalEventKey(DEPLOY_ID, -1, 'x')).toThrow(/non-negative integer/);
    expect(() => journalEventKey(DEPLOY_ID, 1, 'has space')).toThrow(/alphanumeric/);
  });
});

describe('appendJournal', () => {
  it('writes the entry with IfNoneMatch "*" so objects are immutable', async () => {
    const s3 = fakeS3();
    const key = await appendJournal(s3, 'state-bucket', entry(1));
    expect(key).toBe(`deploys/${DEPLOY_ID}/journal/0001-image-pushed.json`);
    const put = s3.calls.find((c) => c.name === 'PutObjectCommand');
    expect(put?.input.IfNoneMatch).toBe('*');
    expect(JSON.parse(s3.objects.get(key)!)).toMatchObject({ seq: 1, fencingToken: 3 });
  });

  it('appending the same seq twice fails loud instead of overwriting', async () => {
    const s3 = fakeS3();
    await appendJournal(s3, 'state-bucket', entry(1));
    await expect(appendJournal(s3, 'state-bucket', entry(1))).rejects.toThrow(/immutable/);
    // The first object is untouched.
    expect(JSON.parse(s3.objects.get(`deploys/${DEPLOY_ID}/journal/0001-image-pushed.json`)!).at).toBe(
      '2026-06-11T12:35:00.000Z',
    );
  });
});

describe('promoteManifest / readLatestManifest', () => {
  it('writes the per-deploy manifest then latest, stamped with the fencing token', async () => {
    const s3 = fakeS3();
    await promoteManifest(s3, 'state-bucket', manifest(), 5);
    const puts = s3.calls.filter((c) => c.name === 'PutObjectCommand');
    expect(puts.map((c) => c.input.Key)).toEqual([manifestKey(DEPLOY_ID), LATEST_MANIFEST_KEY]);
    for (const put of puts) {
      expect(put.input.Metadata).toEqual({ 'fencing-token': '5' });
    }
  });

  it('round-trips through readLatestManifest', async () => {
    const s3 = fakeS3();
    await promoteManifest(s3, 'state-bucket', manifest(), 5);
    await expect(readLatestManifest(s3, 'state-bucket')).resolves.toEqual(manifest());
  });

  it('returns null when no manifest was ever promoted (NoSuchKey)', async () => {
    const s3 = fakeS3();
    await expect(readLatestManifest(s3, 'state-bucket')).resolves.toBeNull();
  });

  it('propagates other failures (state store unavailable is fatal)', async () => {
    const s3 = {
      send: async () => {
        throw Object.assign(new Error('denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
      },
    };
    await expect(readLatestManifest(s3, 'state-bucket')).rejects.toThrow(/denied/);
  });
});
