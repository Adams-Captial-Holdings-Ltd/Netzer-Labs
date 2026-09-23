/**
 * dynamodb_query tool — exposes a tiny safe subset of DDB to the model.
 *
 * The model picks a logical table name (we map to the real table), gives
 * us a PK + optional SK prefix, and gets back up to N rows. There is no
 * arbitrary KeyConditionExpression input — that would let the model
 * craft anything, including queries that scan an entire partition. By
 * forcing the shape into PK + SK prefix we keep cost and surface area
 * predictable.
 *
 * The allowlist is intentional. Adding a table requires a code change,
 * which forces a human to think about what data we're handing to the
 * model.
 */

import type { Tool as BedrockTool } from '@aws-sdk/client-bedrock-runtime';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { tools } from './registry.js';
import { ddb } from '../state/ddb.js';

/**
 * Who a table's partitions belong to, which decides how we constrain the
 * model-supplied `pk` at invoke time:
 *
 * - `agent`  — partitions are keyed `AGENT#<id>`; a caller may only read its
 *   OWN partition. `pk` must equal `AGENT#<ctx.agentId>` or begin with
 *   `AGENT#<ctx.agentId>#` (covers composite keys like token_usage's
 *   `AGENT#<id>#DAY#<date>`).
 * - `open`   — deliberately cross-agent shared data (hive_mind); no `pk`
 *   constraint beyond the allowlist itself.
 *
 * Deployment-wide, confidentiality-sensitive tables (the audit log) are NOT
 * in the allowlist at all — there is no per-agent partitioning that makes
 * them safe to hand to an arbitrary agent turn, and no agent's job needs the
 * deployment audit trail.
 */
type TableScope = 'agent' | 'open';

interface AllowlistEntry {
  /** The actual env-resolved table name. */
  table: string;
  /** Per-table description shown to the model. */
  description: string;
  /** Default cap so the model can't drag in 10MB. */
  defaultLimit: number;
  hardLimit: number;
  /** How `pk` is constrained to the caller at invoke time. */
  scope: TableScope;
  /** Optional attributes to project; undefined = all. */
  attributes?: string[];
  /** Rows of the caller's own partition the model is still never handed. */
  hidden?: (row: Record<string, unknown>) => boolean;
}

const ALLOWLIST: Record<string, AllowlistEntry> = {
  sessions: {
    table: process.env.TABLE_SESSIONS ?? 'claudeclaw-sessions',
    description: 'Per-(agent, chat) session rows. PK=AGENT#<id>, SK=CHAT#<chatId>.',
    defaultLimit: 10,
    hardLimit: 50,
    scope: 'agent',
    // Since P1 an agent's partition also holds every message of every person's
    // conversations with it (SK=CHAT#<chatId>#MSG#…), and a migrated one's source
    // record (…#SRC). Returning them would hand anyone chatting with the agent
    // other people's transcripts one message at a time (owner decision 1), so
    // only conversation rows come back — what this returned before P1. The same
    // shape isConversationRow selects in the dashboard.
    hidden: (row) => !/^CHAT#[^#]+$/.test(String(row.SK ?? '')),
  },
  memories: {
    table: process.env.TABLE_MEMORIES ?? 'claudeclaw-memories',
    description: 'Long-term memory rows. PK=AGENT#<id>, SK=MEM#<chatId>#<iso>#<uuid>.',
    defaultLimit: 25,
    hardLimit: 100,
    scope: 'agent',
  },
  token_usage: {
    table: process.env.TABLE_TOKEN_USAGE ?? 'claudeclaw-token-usage',
    description: 'Per-call Bedrock usage rows. PK=AGENT#<id>#DAY#YYYY-MM-DD, SK=<iso>#<uuid>.',
    defaultLimit: 50,
    hardLimit: 200,
    scope: 'agent',
  },
  scheduled_tasks: {
    table: process.env.TABLE_SCHEDULED_TASKS ?? 'claudeclaw-scheduled-tasks',
    description: 'Scheduled-task rows. PK=AGENT#<id>, SK=TASK#<id>.',
    defaultLimit: 25,
    hardLimit: 100,
    scope: 'agent',
  },
  inter_agent_tasks: {
    table: process.env.TABLE_INTER_AGENT_TASKS ?? 'claudeclaw-inter-agent-tasks',
    description: 'Your cross-agent inbox rows. PK=AGENT#<toAgent>, SK=TASK#<iso>#<id>.',
    defaultLimit: 25,
    hardLimit: 100,
    scope: 'agent',
  },
  hive_mind: {
    table: process.env.TABLE_HIVE_MIND ?? 'claudeclaw-hive-mind',
    description: 'Cross-agent shared notes. PK=DATE#YYYYMMDD, SK=TS#<ms>#AGENT#<agent>#ID#<id>.',
    defaultLimit: 25,
    hardLimit: 100,
    scope: 'open',
  },
  mission_tasks: {
    table: process.env.TABLE_MISSION_TASKS ?? 'claudeclaw-mission-tasks',
    description: 'Your mission tasks queue. PK=AGENT#<owner>, SK=MISSION#<iso>#<id>.',
    defaultLimit: 25,
    hardLimit: 100,
    scope: 'agent',
  },
};

/**
 * The most items a table with hidden rows reads to find the rows it may show.
 * ponytail: a busy partition is mostly message records (no index, owner
 * decision 11); past this the answer says more may exist — narrow with sk_prefix.
 */
const HIDDEN_READ_CEILING = 5_000;

/**
 * Enforce table scope against the calling agent. Returns an error message if
 * the model-supplied `pk` reaches outside what this agent may read, or null
 * if the query is allowed.
 */
function authorizePk(entry: AllowlistEntry, pk: string, agentId: string): string | null {
  if (entry.scope === 'open') return null;
  const own = `AGENT#${agentId}`;
  if (pk === own || pk.startsWith(`${own}#`)) return null;
  return `Not authorized: this table is agent-scoped; pk must be your own partition ('${own}' or '${own}#...'), not '${pk}'.`;
}

function spec(name: string, description: string, schema: unknown): BedrockTool {
  return {
    toolSpec: {
      name,
      description,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inputSchema: { json: schema as any },
    },
  };
}

tools.register('dynamodb_query', {
  spec: spec(
    'dynamodb_query',
    `Query one of the orchestrator's DynamoDB tables. Allowed tables: ${Object.entries(
      ALLOWLIST,
    )
      .map(([n, e]) => `${n} (${e.description})`)
      .join('; ')}. You must pass the partition key value. SK prefix optional. Agent-scoped tables only return rows in YOUR OWN partition (pk must be AGENT#<your id>...); hive_mind is shared across agents.`,
    {
      type: 'object',
      required: ['table', 'pk'],
      properties: {
        table: {
          type: 'string',
          enum: Object.keys(ALLOWLIST),
          description: 'Logical table name (allowlisted).',
        },
        pk: {
          type: 'string',
          description: 'Exact partition key value (PK attribute). Example: "AGENT#main" or "AGENT#main#DAY#2026-05-19".',
        },
        sk_prefix: {
          type: 'string',
          description: 'Optional sort-key prefix for begins_with filtering.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: 'Max rows to return; defaults to the per-table default. Capped at per-table hard limit.',
        },
        reverse: {
          type: 'boolean',
          description: 'Return newest-first (default true).',
        },
      },
    },
  ),
  async invoke(args, ctx) {
    const logical = String(args.table ?? '');
    const entry = ALLOWLIST[logical];
    if (!entry) {
      return {
        text: `Unknown table '${logical}'. Allowed: ${Object.keys(ALLOWLIST).join(', ')}.`,
        isError: true,
      };
    }
    const pk = String(args.pk ?? '').trim();
    if (!pk) return { text: 'pk is required', isError: true };

    // Authorization is enforced HERE, at dispatch, not when the tool is
    // advertised — the model can name any pk, so the invoke path is the only
    // place that can bind the read to the calling agent's own partition.
    const denied = authorizePk(entry, pk, ctx.agentId);
    if (denied) return { text: denied, isError: true };
    const skPrefix = typeof args.sk_prefix === 'string' ? args.sk_prefix : undefined;
    const reverse = args.reverse !== false; // default true
    const requestedLimit = Number.isFinite(args.limit)
      ? Number(args.limit)
      : entry.defaultLimit;
    const limit = Math.min(entry.hardLimit, Math.max(1, requestedLimit));

    const condition = skPrefix
      ? 'PK = :pk AND begins_with(SK, :sk)'
      : 'PK = :pk';
    const values: Record<string, unknown> = { ':pk': pk };
    if (skPrefix) values[':sk'] = skPrefix;

    try {
      // A table with hidden rows cannot let DynamoDB stop at `limit` items: the
      // rows it may show can all sit behind rows it may not, so it reads on until
      // it has them or reaches its ceiling (the P1 critic's NEW-4).
      const rows: Record<string, unknown>[] = [];
      let read = 0;
      let startKey: Record<string, unknown> | undefined;
      do {
        const out = await ddb().send(
          new QueryCommand({
            TableName: entry.table,
            KeyConditionExpression: condition,
            ExpressionAttributeValues: values,
            ...(entry.hidden ? {} : { Limit: limit }),
            ScanIndexForward: !reverse,
            ExclusiveStartKey: startKey,
          }),
        );
        read += out.Items?.length ?? 0;
        for (const r of out.Items ?? []) if (!entry.hidden?.(r) && rows.length < limit) rows.push(r);
        startKey = out.LastEvaluatedKey;
      } while (entry.hidden && startKey && rows.length < limit && read < HIDDEN_READ_CEILING);
      const more = entry.hidden && startKey && rows.length < limit
        ? ` More may exist beyond the ${read} rows read; narrow with sk_prefix.`
        : '';
      if (rows.length === 0) {
        return { text: `0 rows in ${logical} for pk='${pk}'${skPrefix ? ` sk~'${skPrefix}'` : ''}.${more}` };
      }
      const trimmed = rows.map(redact);
      return {
        text: `${rows.length} rows from ${logical}:\n${trimmed
          .map((r, i) => `[${i + 1}] ${JSON.stringify(r).slice(0, 500)}`)
          .join('\n')}${more}`,
      };
    } catch (err) {
      return {
        text: `DDB query failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  },
});

/**
 * Drop GSI partition keys + heavy fields from the returned rows so the
 * model isn't paying tokens on internal index columns.
 */
function redact(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (k.startsWith('GSI')) continue;
    if (k === 'PK' || k === 'SK' || k === 'ttl') continue;
    out[k] = v;
  }
  return out;
}
