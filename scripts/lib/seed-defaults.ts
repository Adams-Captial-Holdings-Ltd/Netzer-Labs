/**
 * Runtime-config seed defaults (IaC readiness plan items 8c + 27).
 *
 * Every row here is a (category, key) pair the app code READS from the
 * runtime-config table with a hardcoded fallback default. Seeding writes that
 * default into the table explicitly so a fresh deploy's config state is
 * inspectable (dashboard Config tab, `npm run verify` row checks) instead of
 * implicit in scattered source constants.
 *
 * Contract with the reader (src/lib/state/runtime-config-repo.ts):
 *   - one DDB item per (category, key)
 *   - PK = `CONFIG#<category>`, SK = `<key>` (table key schema PK/SK, see
 *     infra/lib/dynamo-stack.ts RuntimeConfigTable)
 *   - the value lives in a string attribute named `value`, serialized exactly
 *     as the reading call site parses it (Number(...), === 'true',
 *     JSON.parse(...))
 *
 * Rules for adding rows:
 *   - ONLY keys some call site actually reads. Never invent keys.
 *   - The value must equal the reader's hardcoded fallback, so seeding is
 *     behavior-neutral on day one.
 *   - Runtime STATE keys (drift/last_run, cost/watch_last_run,
 *     cost/watch_last_risk_total, COSTREPORTJOB rows, jarvis routine items,
 *     profile/first_name) are deliberately absent: their "default" is
 *     absence semantics, not a tunable.
 */

export interface SeedRow {
  category: string;
  key: string;
  value: string;
  description: string;
}

export const SEED_DEFAULTS: SeedRow[] = [
  // src/lib/state/sessions-repo.ts — DEFAULT_INGEST_EVERY_N = 8; reader is
  // clampIngestEveryN(Number(raw)), clamped to [2, 20].
  {
    category: 'memory',
    key: 'ingest_every_n_turns',
    value: '8',
    description:
      'Memory-ingest cadence: distill the conversation into memory every N turns (clamped 2-20).',
  },
  // src/agent/memory-ingest.ts — DEFAULT_PROMOTE_MIN_CONFIDENCE = 0.6; reader
  // is Number(raw), clamped to [0, 1].
  {
    category: 'memory',
    key: 'hive_promote_min_confidence',
    value: '0.6',
    description:
      'Minimum confidence (0-1) for auto-promoting a distilled fact to the fleet-wide hive.',
  },
  // src/lib/state/cost-cap-repo.ts — runtime override for the daily Bedrock
  // spend cap; fallback chain is CCE_DAILY_COST_CAP_USD env then hardcoded 50.
  // scripts/seed.ts substitutes CCE_DAILY_COST_CAP_USD from the loaded env
  // file (see applyEnvOverrides) so seeding never lowers an env-configured cap.
  {
    category: 'cost',
    key: 'daily_cap_usd',
    value: '50',
    description: 'Daily Bedrock spend cap in USD (runtime override of CCE_DAILY_COST_CAP_USD).',
  },
  // src/lib/state/cost-cap-repo.ts (isCostCapEnabled) — `=== 'true'`; absent/
  // anything-else means off, so 'false' is behavior-neutral. Flip to 'true' to
  // enforce the daily Bedrock cost cap without arming the cost_cap_per_day
  // kill switch.
  {
    category: 'cost',
    key: 'cap_enabled',
    value: 'false',
    description:
      'Enforce the daily Bedrock cost cap (alongside the cost_cap_per_day kill switch). On when "true".',
  },
  // src/lib/cost/ledger-gate.ts — `=== 'true'`; absent/anything-else keeps the
  // legacy strict-counter soft cap, so 'false' is behavior-neutral. Flip to
  // 'true' AFTER the claudeclaw-spend-ledger table is deployed to switch cap
  // enforcement to the atomic reserve-before-spend ledger (fail-closed).
  {
    category: 'cost',
    key: 'ledger_enabled',
    value: 'false',
    description:
      'Enforce the daily cap via the atomic spend ledger (reserve-before-spend). Needs the spend-ledger table. On when "true".',
  },
  // src/lib/cost/ledger-gate.ts — per-turn worst-case reservation in USD.
  // Parsed with Number(); non-numeric/<=0 falls back to the built-in 0.5.
  {
    category: 'cost',
    key: 'ledger_reserve_usd',
    value: '0.5',
    description:
      'Worst-case USD reserved per turn by the spend ledger before the model call (settled to actual after).',
  },
  // src/workers/cost-watch.ts — `(await getConfig('cost','watch_enabled')) === 'true'`;
  // absent/anything-else means disabled, so 'false' is behavior-neutral.
  {
    category: 'cost',
    key: 'watch_enabled',
    value: 'false',
    description: 'Daily cost-watch worker (budget projection + waste-jump alerts). On when "true".',
  },
  // src/adapters/dashboard/cost.ts (remediationEnabled) — default off,
  // fail-closed; destructive cost remediation stays inert until armed.
  {
    category: 'cost',
    key: 'remediation_enabled',
    value: 'false',
    description: 'Arms destructive cost-remediation actions in the dashboard. On when "true".',
  },
  // src/adapters/dashboard/cost.ts (reportAsyncEnabled) — default off → the
  // cost report uses the synchronous path.
  {
    category: 'cost',
    key: 'report_async_enabled',
    value: 'false',
    description: 'Generate AI cost reports via the async start+poll job path. On when "true".',
  },
  // src/adapters/dashboard/iam-copilot.ts (applyEnabled) — IAM copilot apply
  // gate, default off (drafting only).
  {
    category: 'iam',
    key: 'apply_enabled',
    value: 'false',
    description: 'Arms IAM-copilot apply (mutating IAM writes). On when "true".',
  },
  // src/adapters/dashboard/drift.ts + src/workers/drift-watch.ts — drift watch
  // runs only when exactly 'true'.
  {
    category: 'drift',
    key: 'watch_enabled',
    value: 'false',
    description: 'Daily CloudFormation drift-watch worker. On when "true".',
  },
  // src/lib/mcp/servers-repo.ts (listMcpServers) — JSON array of MCP server
  // configs; absent/unparseable is treated as []. Seed the empty registry.
  {
    category: 'mcp',
    key: 'servers',
    value: '[]',
    description: 'MCP server registry (JSON array of {id,name,url,auth,enabled,agents}).',
  },
  // src/lib/alerting/sns-recipients.ts (readPersistedRecipients) — JSON array
  // of intended alert recipients; absent is treated as [].
  {
    category: 'alerting',
    key: 'recipients',
    value: '[]',
    description: 'Durable intended alert-recipient record (JSON array of {email,addedBy,addedAt}).',
  },
  // THE ONE DELIBERATE EXCEPTION TO RULE 1, stated rather than hidden: these
  // five rows have NO reader yet. The reconciler that consumes them is Phase 5,
  // and its reader ships beside the poll loop that calls it — where an overlap
  // of 2000 ms can be pinned by a sweep that loses rows without it, instead of
  // by an assertion that 2000 equals 2000 one file over. Rule 2 still binds the
  // Phase 5 reader: its fallbacks must equal the values below, so seeding stays
  // behavior-neutral on the day the reader lands.
  //
  // `paperclip/base_url` is NOT here on purpose: an instance URL's default is
  // absence, not a tunable — the same call the `power/url` precedent makes.
  // `paperclip/reconciler_watermark` is NOT here for rule 3's reason: it is
  // runtime STATE, and its default is absence semantics.
  {
    category: 'paperclip',
    key: 'poll_interval_ms',
    value: '15000',
    description: 'Reconciler poll cadence in milliseconds; reader is Number(raw), positive values only.',
  },
  // The 2000 ms is not arbitrary: `updatedSince` is a STRICT greater-than
  // against a millisecond-truncated stamp, so a row re-queried at its own
  // updatedAt does not come back and only an overlap recovers it. Proven by the
  // probe "C-2 (BLOCKING): a truncated watermark loses rows, and
  // overlap-and-dedupe delivers them exactly once".
  {
    category: 'paperclip',
    key: 'poll_overlap_ms',
    value: '2000',
    description: 'Milliseconds subtracted from the watermark before each poll, so a truncated stamp loses no rows.',
  },
  {
    category: 'paperclip',
    key: 'poll_page_limit',
    value: '500',
    description: 'Issue-list page size per poll. Above the server maximum is silently clamped, never rejected.',
  },
  {
    category: 'paperclip',
    key: 'reconciler_mode',
    value: 'shadow',
    description: 'shadow | live | off. C-7: shadow READ comparator only — nothing is written on either side.',
  },
  {
    category: 'paperclip',
    key: 'enabled_agents',
    value: '[]',
    description: 'JSON array of Netzar agent slugs the reconciler acts for. Empty means none.',
  },
];

/**
 * Behavior-preserving env overrides, applied by the CLI (and the deploy
 * orchestrator) AFTER loading the target .env file. Two today:
 *  - cost/daily_cap_usd mirrors the app's own fallback chain
 *    (CCE_DAILY_COST_CAP_USD env, then 50) — without this, seeding the
 *    hardcoded 50 into an environment whose env cap is e.g. 1000 would CUT
 *    the effective cap, because the runtime-config row wins over the env
 *    default.
 *  - cost/cap_enabled seeds 'true' when CCE_COST_CAP_ENFORCED is '1'/'true'
 *    (setup writes it when the operator accepts day-one enforcement), so a
 *    fresh install's cap has teeth from the first deploy. Conditional-put
 *    semantics mean an EXISTING install's row is never overwritten; this
 *    only shapes brand-new installs.
 */
export function applyEnvOverrides(rows: SeedRow[], env: Record<string, string | undefined>): SeedRow[] {
  return rows.map((row) => {
    if (row.category === 'cost' && row.key === 'daily_cap_usd') {
      const raw = Number(env.CCE_DAILY_COST_CAP_USD ?? '');
      if (Number.isFinite(raw) && raw > 0) return { ...row, value: String(raw) };
    }
    if (row.category === 'cost' && row.key === 'cap_enabled') {
      const raw = (env.CCE_COST_CAP_ENFORCED ?? '').trim().toLowerCase();
      if (raw === '1' || raw === 'true') return { ...row, value: 'true' };
    }
    return row;
  });
}

/**
 * Minimal client surface so tests can pass a fake `{ send }` and deploy.ts can
 * pass a real DynamoDBDocumentClient. The command is produced by this module
 * (a lib-dynamodb PutCommand), callers never construct it.
 */
export interface SeedDdbClient {
  send(command: unknown): Promise<unknown>;
}

export interface RunSeedOptions {
  ddbClient: SeedDdbClient;
  tableName: string;
  /** Defaults to SEED_DEFAULTS. Pass applyEnvOverrides(...) output to honor env caps. */
  rows?: SeedRow[];
}

export interface RunSeedResult {
  /** `category/key` ids written by this run. */
  created: string[];
  /** `category/key` ids that already existed and were left untouched. */
  skipped: string[];
}

function isConditionalCheckFailed(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: string }).name === 'ConditionalCheckFailedException'
  );
}

/**
 * Idempotent seed: one conditional PutItem per row, guarded by
 * `attribute_not_exists(PK)` on the addressed (PK, SK) item, so an existing
 * key is NEVER overwritten — operator-tuned values survive re-runs and
 * re-deploys. ConditionalCheckFailedException is the expected "already there"
 * signal and counts as a skip; any other error propagates to the caller.
 *
 * Item shape matches src/lib/state/runtime-config-repo.ts setConfig exactly:
 * { PK: 'CONFIG#<category>', SK: '<key>', value, updatedAt, updatedBy }.
 */
export async function runSeed(opts: RunSeedOptions): Promise<RunSeedResult> {
  // Lazy import keeps the pure data/validation surface of this module usable
  // in unit tests without touching AWS SDK internals at module load.
  const { PutCommand } = await import('@aws-sdk/lib-dynamodb');
  const rows = opts.rows ?? SEED_DEFAULTS;
  const created: string[] = [];
  const skipped: string[] = [];
  for (const row of rows) {
    const id = `${row.category}/${row.key}`;
    const command = new PutCommand({
      TableName: opts.tableName,
      Item: {
        PK: `CONFIG#${row.category}`,
        SK: row.key,
        value: row.value,
        updatedAt: new Date().toISOString(),
        updatedBy: 'seed',
      },
      ConditionExpression: 'attribute_not_exists(PK)',
    });
    try {
      await opts.ddbClient.send(command);
      created.push(id);
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        skipped.push(id);
        continue;
      }
      throw new Error(
        `seed: PutItem failed for ${id} in ${opts.tableName}: ${
          err instanceof Error ? err.message : String(err)
        }`,
        { cause: err },
      );
    }
  }
  return { created, skipped };
}
