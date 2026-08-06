import { describe, expect, it } from 'vitest';
import {
  SEED_DEFAULTS,
  applyEnvOverrides,
  runSeed,
  type SeedDdbClient,
  type SeedRow,
} from './seed-defaults.js';

class ConditionalCheckFailedException extends Error {
  override name = 'ConditionalCheckFailedException';
}

interface SentPut {
  TableName?: string;
  Item?: Record<string, unknown>;
  ConditionExpression?: string;
}

/** Fake doc client: records every PutCommand input, behavior per-call pluggable. */
function fakeClient(behavior: (input: SentPut, callIndex: number) => void): {
  client: SeedDdbClient;
  sent: SentPut[];
} {
  const sent: SentPut[] = [];
  const client: SeedDdbClient = {
    send(command: unknown) {
      const input = (command as { input: SentPut }).input;
      sent.push(input);
      try {
        behavior(input, sent.length - 1);
      } catch (err) {
        return Promise.reject(err);
      }
      return Promise.resolve({});
    },
  };
  return { client, sent };
}

const ROWS: SeedRow[] = [
  { category: 'cost', key: 'daily_cap_usd', value: '50', description: 'cap' },
  { category: 'mcp', key: 'servers', value: '[]', description: 'registry' },
  { category: 'iam', key: 'apply_enabled', value: 'false', description: 'gate' },
];

describe('runSeed', () => {
  it('creates every row when none exist, with the live item shape + guard', async () => {
    const { client, sent } = fakeClient(() => {});
    const result = await runSeed({ ddbClient: client, tableName: 'tbl', rows: ROWS });

    expect(result.created).toEqual(['cost/daily_cap_usd', 'mcp/servers', 'iam/apply_enabled']);
    expect(result.skipped).toEqual([]);
    expect(sent).toHaveLength(3);

    // Item shape must match runtime-config-repo setConfig: PK/SK keys, string
    // value, updatedAt/updatedBy — guarded by attribute_not_exists(PK).
    const first = sent[0];
    expect(first.TableName).toBe('tbl');
    expect(first.ConditionExpression).toBe('attribute_not_exists(PK)');
    expect(first.Item).toMatchObject({
      PK: 'CONFIG#cost',
      SK: 'daily_cap_usd',
      value: '50',
      updatedBy: 'seed',
    });
    expect(typeof first.Item?.updatedAt).toBe('string');
    // No stray attributes the dashboard config tab does not expect.
    expect(Object.keys(first.Item ?? {}).sort()).toEqual([
      'PK',
      'SK',
      'updatedAt',
      'updatedBy',
      'value',
    ]);
  });

  it('skips existing rows on ConditionalCheckFailedException and continues', async () => {
    const { client } = fakeClient((input) => {
      if (input.Item?.SK === 'servers') throw new ConditionalCheckFailedException('exists');
    });
    const result = await runSeed({ ddbClient: client, tableName: 'tbl', rows: ROWS });
    expect(result.created).toEqual(['cost/daily_cap_usd', 'iam/apply_enabled']);
    expect(result.skipped).toEqual(['mcp/servers']);
  });

  it('reports all-skipped when every key already exists', async () => {
    const { client } = fakeClient(() => {
      throw new ConditionalCheckFailedException('exists');
    });
    const result = await runSeed({ ddbClient: client, tableName: 'tbl', rows: ROWS });
    expect(result.created).toEqual([]);
    expect(result.skipped).toEqual(['cost/daily_cap_usd', 'mcp/servers', 'iam/apply_enabled']);
  });

  it('propagates non-conditional errors with the failing row named', async () => {
    const boom = new Error('ResourceNotFoundException: table missing');
    const { client, sent } = fakeClient((_input, i) => {
      if (i === 1) throw boom;
    });
    await expect(runSeed({ ddbClient: client, tableName: 'tbl', rows: ROWS })).rejects.toThrow(
      /mcp\/servers.*table missing/,
    );
    // Failed fast: did not continue past the broken put.
    expect(sent).toHaveLength(2);
  });

  it('defaults to SEED_DEFAULTS when rows is omitted', async () => {
    const { client, sent } = fakeClient(() => {});
    const result = await runSeed({ ddbClient: client, tableName: 'tbl' });
    expect(result.created).toHaveLength(SEED_DEFAULTS.length);
    expect(sent).toHaveLength(SEED_DEFAULTS.length);
  });
});

describe('SEED_DEFAULTS sanity', () => {
  it('every row has a non-empty category, key, and description', () => {
    for (const row of SEED_DEFAULTS) {
      expect(row.category.trim().length, `${row.category}/${row.key} category`).toBeGreaterThan(0);
      expect(row.key.trim().length, `${row.category}/${row.key} key`).toBeGreaterThan(0);
      expect(
        row.description.trim().length,
        `${row.category}/${row.key} description`,
      ).toBeGreaterThan(0);
      expect(typeof row.value, `${row.category}/${row.key} value`).toBe('string');
    }
  });

  it('has no duplicate category/key pairs', () => {
    const ids = SEED_DEFAULTS.map((r) => `${r.category}/${r.key}`);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('serializes values the way the readers parse them', () => {
    const byId = new Map(SEED_DEFAULTS.map((r) => [`${r.category}/${r.key}`, r.value]));
    // Numeric readers: Number(raw) must be finite.
    expect(Number(byId.get('memory/ingest_every_n_turns'))).toBe(8);
    expect(Number(byId.get('memory/hive_promote_min_confidence'))).toBe(0.6);
    expect(Number(byId.get('cost/daily_cap_usd'))).toBe(50);
    // Boolean gates compare === 'true'; default-off seeds must be 'false'.
    for (const id of [
      'cost/watch_enabled',
      'cost/remediation_enabled',
      'cost/report_async_enabled',
      'iam/apply_enabled',
      'drift/watch_enabled',
    ]) {
      expect(byId.get(id), id).toBe('false');
    }
    // JSON readers: must parse to an array.
    expect(JSON.parse(byId.get('mcp/servers') ?? '')).toEqual([]);
    expect(JSON.parse(byId.get('alerting/recipients') ?? '')).toEqual([]);
  });
});

describe('applyEnvOverrides', () => {
  it('substitutes CCE_DAILY_COST_CAP_USD for the cost cap default', () => {
    const rows = applyEnvOverrides(SEED_DEFAULTS, { CCE_DAILY_COST_CAP_USD: '1000' });
    const cap = rows.find((r) => r.category === 'cost' && r.key === 'daily_cap_usd');
    expect(cap?.value).toBe('1000');
    // Everything else untouched.
    expect(rows.filter((r) => !(r.category === 'cost' && r.key === 'daily_cap_usd'))).toEqual(
      SEED_DEFAULTS.filter((r) => !(r.category === 'cost' && r.key === 'daily_cap_usd')),
    );
  });

  it('keeps the hardcoded 50 when the env value is missing or junk', () => {
    for (const env of [{}, { CCE_DAILY_COST_CAP_USD: 'banana' }, { CCE_DAILY_COST_CAP_USD: '0' }]) {
      const cap = applyEnvOverrides(SEED_DEFAULTS, env).find(
        (r) => r.category === 'cost' && r.key === 'daily_cap_usd',
      );
      expect(cap?.value).toBe('50');
    }
  });

  it('seeds cap_enabled true when CCE_COST_CAP_ENFORCED opts in', () => {
    for (const v of ['1', 'true', 'TRUE', ' true ']) {
      const row = applyEnvOverrides(SEED_DEFAULTS, { CCE_COST_CAP_ENFORCED: v }).find(
        (r) => r.category === 'cost' && r.key === 'cap_enabled',
      );
      expect(row?.value, `CCE_COST_CAP_ENFORCED=${JSON.stringify(v)}`).toBe('true');
    }
  });

  it('keeps cap_enabled false when the flag is absent or opts out', () => {
    for (const env of [{}, { CCE_COST_CAP_ENFORCED: '0' }, { CCE_COST_CAP_ENFORCED: 'no' }]) {
      const row = applyEnvOverrides(SEED_DEFAULTS, env).find(
        (r) => r.category === 'cost' && r.key === 'cap_enabled',
      );
      expect(row?.value).toBe('false');
    }
  });

  it('does not mutate the input rows', () => {
    const before = JSON.stringify(SEED_DEFAULTS);
    applyEnvOverrides(SEED_DEFAULTS, { CCE_DAILY_COST_CAP_USD: '1234' });
    expect(JSON.stringify(SEED_DEFAULTS)).toBe(before);
  });
});
