/**
 * `tsx scripts/demo/reset.ts --env=demo` - nightly reset of the public demo.
 *
 * Wipes the conversational state visitors generated, deletes any agent a
 * visitor created, then re-runs the seed so the instance is identical every
 * morning. Safe to run while the demo is live; the wipe and re-seed are both
 * idempotent.
 *
 * What it clears: sessions, memories, hive-mind, consolidations, mission-tasks,
 * scheduled-tasks, inter-agent-tasks. What it preserves: the lockdown config
 * (runtime-config), kill switches, dashboard tokens, and the six seed agents.
 *
 * Known caveat: knowledge-base docs a visitor uploaded live in S3 Vectors, not
 * in these DDB tables, so they are NOT purged here. The canonical demo docs are
 * re-ingested by the seed (fixed docIds), but visitor uploads accumulate until
 * the vector store gains an enumerate-and-purge path. This is logged, not faked.
 *
 * Wiring it to run nightly (AWS-native options, in order of least moving parts):
 *   - EventBridge Scheduler -> a small Lambda that imports and calls
 *     runDemoReset(). Package this file's logic as the handler.
 *   - or EventBridge Scheduler -> ECS RunTask of a one-off container that runs
 *     `tsx scripts/demo/reset.ts --env=demo`.
 * Either way it runs OUTSIDE the agent service, on its own IAM role scoped to
 * the demo deployment's tables and config bucket.
 *
 * Usage:
 *   tsx scripts/demo/reset.ts --env=demo
 *   tsx scripts/demo/reset.ts --env=demo --json
 */

import { DynamoDBClient, DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  ScanCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { bold, dim, fail, ok } from '../lib/ansi.js';
import { bootstrapDemoEnv } from './env.js';
import { runDemoSeed, SEED_AGENT_IDS } from './seed.js';

/** Env vars (set by bootstrapDemoEnv) for the conversational tables to wipe. */
const EPHEMERAL_TABLE_ENVS = [
  'TABLE_SESSIONS',
  'TABLE_MEMORIES',
  'TABLE_HIVE_MIND',
  'TABLE_CONSOLIDATIONS',
  'TABLE_MISSION_TASKS',
  'TABLE_SCHEDULED_TASKS',
  'TABLE_INTER_AGENT_TASKS',
] as const;

/**
 * Delete every item in a table without knowing its key schema ahead of time.
 * DescribeTable gives the key attribute names, so this works across the
 * PK/SK tables and any table with a different schema. Returns the delete count.
 */
async function wipeTable(
  base: DynamoDBClient,
  doc: DynamoDBDocumentClient,
  tableName: string,
): Promise<number> {
  const desc = await base.send(new DescribeTableCommand({ TableName: tableName }));
  const keyAttrs = (desc.Table?.KeySchema ?? []).map((k) => k.AttributeName!).filter(Boolean);
  if (keyAttrs.length === 0) {
    throw new Error(`${tableName}: could not resolve key schema`);
  }
  // Project only the key attributes, aliased so reserved words are safe.
  const names: Record<string, string> = {};
  keyAttrs.forEach((a, i) => (names[`#k${i}`] = a));
  const projection = Object.keys(names).join(', ');

  let deleted = 0;
  let lastKey: Record<string, unknown> | undefined;
  do {
    const page = await doc.send(
      new ScanCommand({
        TableName: tableName,
        ProjectionExpression: projection,
        ExpressionAttributeNames: names,
        ExclusiveStartKey: lastKey,
      }),
    );
    const items = page.Items ?? [];
    for (let i = 0; i < items.length; i += 25) {
      const batch = items.slice(i, i + 25).map((item) => {
        const key: Record<string, unknown> = {};
        for (const a of keyAttrs) key[a] = (item as Record<string, unknown>)[a];
        return { DeleteRequest: { Key: key } };
      });
      let request: Record<string, typeof batch> | undefined = { [tableName]: batch };
      // BatchWrite can return UnprocessedItems under throttling; retry a few times.
      for (let attempt = 0; attempt < 4 && request && Object.keys(request).length > 0; attempt++) {
        const res = await doc.send(new BatchWriteCommand({ RequestItems: request }));
        const unprocessed = res.UnprocessedItems as typeof request | undefined;
        request = unprocessed && Object.keys(unprocessed).length > 0 ? unprocessed : undefined;
      }
      deleted += batch.length;
    }
    lastKey = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (lastKey);

  return deleted;
}

export interface DemoResetSummary {
  wiped: Record<string, number>;
  agentsDeleted: string[];
  reseed: Awaited<ReturnType<typeof runDemoSeed>>;
}

export async function runDemoReset(region: string, log: (s: string) => void): Promise<DemoResetSummary> {
  const base = new DynamoDBClient({ region });
  const doc = DynamoDBDocumentClient.from(base);
  const wiped: Record<string, number> = {};

  try {
    // 1. Wipe conversational state.
    log(bold('Phase 1: wipe ephemeral state'));
    for (const envName of EPHEMERAL_TABLE_ENVS) {
      const table = process.env[envName];
      if (!table) {
        log(dim(`skip   ${envName} (unset)`));
        continue;
      }
      const n = await wipeTable(base, doc, table);
      wiped[table] = n;
      log(ok(`wiped  ${table} (${n} items)`));
    }

    // 2. Delete visitor-created agents; keep the seed six.
    log(bold('Phase 2: remove visitor agents'));
    const { listAgents } = await import('../../src/lib/state/agents-repo.js');
    const { deleteAgentFull } = await import('../../src/lib/agents/agent-manager.js');
    const keep = new Set<string>(SEED_AGENT_IDS);
    const agentsDeleted: string[] = [];
    for (const agent of await listAgents()) {
      if (keep.has(agent.agentId)) continue;
      await deleteAgentFull(agent.agentId);
      agentsDeleted.push(agent.agentId);
      log(ok(`deleted ${agent.agentId}`));
    }
    if (agentsDeleted.length === 0) log(dim('none - fleet already clean'));

    // 3. Re-seed (re-activate the six, re-ingest canonical docs, re-assert lockdown).
    log(bold('Phase 3: re-seed'));
    const reseed = await runDemoSeed(log);

    return { wiped, agentsDeleted, reseed };
  } finally {
    base.destroy();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const log = (s: string) => {
    if (!json) console.log(s);
  };

  try {
    const { region, envFlag } = bootstrapDemoEnv(argv);
    if (!json) console.log(bold(`Resetting demo instance (${envFlag}, ${region})`));
    const summary = await runDemoReset(region, log);
    if (json) {
      console.log(JSON.stringify({ ok: true, ...summary }));
    } else {
      const totalWiped = Object.values(summary.wiped).reduce((a, b) => a + b, 0);
      console.log(
        bold(
          `done: wiped ${totalWiped} items, removed ${summary.agentsDeleted.length} agents, ` +
            `re-seeded ${summary.reseed.agentsActivated.length}`,
        ),
      );
    }
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (json) console.log(JSON.stringify({ ok: false, error: msg }));
    else console.error(fail(msg));
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
