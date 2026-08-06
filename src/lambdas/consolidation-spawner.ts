/**
 * Consolidation spawner Lambda. Triggered by EventBridge Scheduler
 * nightly at 02:30 UTC. Scans for agents with unconsolidated memories
 * and spawns Fargate one-shot tasks for each.
 *
 * Two-layer idempotency:
 *   1. clientToken on ECS RunTask (prevents duplicate tasks on retry)
 *   2. spawn-ledger DDB state machine (invoking -> running -> completed/failed)
 */

import { ECSClient, RunTaskCommand } from '@aws-sdk/client-ecs';
import { DynamoDBDocumentClient, PutCommand, GetCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { createHash, randomUUID } from 'node:crypto';

const region = process.env.AWS_REGION ?? 'us-east-1';
const CLUSTER = process.env.ECS_CLUSTER ?? 'claudeclaw-cluster';
const TASK_DEFINITION = process.env.CONSOLIDATION_TASK_DEF ?? 'claudeclaw-consolidation-worker';
const SUBNET_IDS = (process.env.CONSOLIDATION_SUBNETS ?? '').split(',').filter(Boolean);
const SECURITY_GROUP = process.env.CONSOLIDATION_SG ?? '';
const SPAWN_LEDGER_TABLE = process.env.TABLE_SPAWN_LEDGER ?? 'claudeclaw-spawn-ledger';
const MEMORIES_TABLE = process.env.TABLE_MEMORIES ?? 'claudeclaw-memories';

const ecs = new ECSClient({ region });
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region }));

interface SpawnEvent {
  source?: string;
}

function clientToken(agentId: string, chatId: string, date: string): string {
  return createHash('sha256')
    .update(`${agentId}:${chatId}:${date}`)
    .digest('hex')
    .slice(0, 32);
}

async function isAlreadySpawned(agentId: string, chatId: string, date: string): Promise<boolean> {
  const out = await ddb.send(
    new GetCommand({
      TableName: SPAWN_LEDGER_TABLE,
      Key: { PK: `SPAWN#${agentId}#${chatId}`, SK: `DATE#${date}` },
    }),
  );
  return !!out.Item;
}

async function recordSpawn(agentId: string, chatId: string, date: string, taskArn: string): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: SPAWN_LEDGER_TABLE,
      Item: {
        PK: `SPAWN#${agentId}#${chatId}`,
        SK: `DATE#${date}`,
        taskArn,
        spawnedAt: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + 7 * 86400,
      },
    }),
  );
}

/** Hard ceiling on pages so a runaway scan can't loop forever. */
const MAX_SCAN_PAGES = 50;

async function findAgentsWithUnconsolidated(): Promise<Array<{ agentId: string; chatId: string }>> {
  // The gsi2-unconsolidated index is SPARSE: a row only carries GSI2PK/GSI2SK
  // while it is unconsolidated, and markConsolidated() REMOVEs both attributes
  // (memories-repo.ts), so the row drops off the index. There is no single
  // partition that holds every agent, and a Query KeyCondition cannot use
  // begins_with on the partition key — so we Scan the (already small, sparse)
  // index to enumerate every (agent, chat) pair that still has work pending.
  //
  // GSI2PK = AGENT#<agentId>, GSI2SK = UNCON#<chatId>#<createdAt>#<id>.
  const seen = new Set<string>();
  const results: Array<{ agentId: string; chatId: string }> = [];
  let lastKey: Record<string, unknown> | undefined;
  let pages = 0;

  do {
    const out = await ddb.send(
      new ScanCommand({
        TableName: MEMORIES_TABLE,
        IndexName: 'gsi2-unconsolidated',
        ProjectionExpression: 'GSI2PK, GSI2SK',
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of out.Items ?? []) {
      const agentId = String(item.GSI2PK ?? '').replace('AGENT#', '');
      // GSI2SK = UNCON#<chatId>#<createdAt>#<id>; chatId is the segment after
      // the UNCON# prefix. chatIds never contain '#', so split is safe.
      const skParts = String(item.GSI2SK ?? '').split('#');
      const chatId = skParts[0] === 'UNCON' ? skParts[1] ?? '' : '';
      const key = `${agentId}:${chatId}`;
      if (agentId && chatId && !seen.has(key)) {
        seen.add(key);
        results.push({ agentId, chatId });
      }
    }
    lastKey = out.LastEvaluatedKey as Record<string, unknown> | undefined;
    pages++;
  } while (lastKey && pages < MAX_SCAN_PAGES);

  if (lastKey) {
    console.warn(
      `findAgentsWithUnconsolidated hit MAX_SCAN_PAGES (${MAX_SCAN_PAGES}); ` +
        `${results.length} pairs found, remaining pairs will be picked up on the next run`,
    );
  }
  return results;
}

export async function handler(_event: SpawnEvent): Promise<{ spawned: number }> {
  const date = new Date().toISOString().slice(0, 10);
  const targets = await findAgentsWithUnconsolidated();
  let spawned = 0;

  for (const { agentId, chatId } of targets) {
    if (await isAlreadySpawned(agentId, chatId, date)) continue;

    const token = clientToken(agentId, chatId, date);
    const workerId = randomUUID();

    try {
      const result = await ecs.send(
        new RunTaskCommand({
          cluster: CLUSTER,
          taskDefinition: TASK_DEFINITION,
          launchType: 'FARGATE',
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets: SUBNET_IDS,
              securityGroups: SECURITY_GROUP ? [SECURITY_GROUP] : undefined,
              assignPublicIp: 'DISABLED',
            },
          },
          overrides: {
            containerOverrides: [
              {
                name: 'worker',
                environment: [
                  { name: 'CONSOLIDATION_AGENT_ID', value: agentId },
                  { name: 'CONSOLIDATION_CHAT_ID', value: chatId },
                  { name: 'CONSOLIDATION_WORKER_ID', value: workerId },
                ],
              },
            ],
          },
          clientToken: token,
        }),
      );

      const taskArn = result.tasks?.[0]?.taskArn ?? 'unknown';
      await recordSpawn(agentId, chatId, date, taskArn);
      spawned++;
    } catch (err) {
      console.error(`Failed to spawn consolidation for ${agentId}/${chatId}:`, err);
    }
  }

  return { spawned };
}
