import { Stack, RemovalPolicy, CfnOutput, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  AttributeType,
  BillingMode,
  Table,
  TableEncryption,
  ProjectionType,
} from 'aws-cdk-lib/aws-dynamodb';
import type { IKey } from 'aws-cdk-lib/aws-kms';
import {
  AwsCustomResource,
  AwsCustomResourcePolicy,
  PhysicalResourceId,
} from 'aws-cdk-lib/custom-resources';
import { Function as LambdaFunction, Runtime, Code } from 'aws-cdk-lib/aws-lambda';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction as LambdaTarget } from 'aws-cdk-lib/aws-events-targets';
import { Role, ServicePrincipal, PolicyStatement, Effect, ManagedPolicy } from 'aws-cdk-lib/aws-iam';
import { RESOURCE_NAMES, TAGS } from './constants.js';
import type { BaseStackProps, DynamoOutputs } from './interfaces.js';

export interface DynamoStackProps extends BaseStackProps {
  dataKey: IKey;
}

/**
 * All 14 DynamoDB tables.
 *
 * Defaults applied to every table:
 *   - PAY_PER_REQUEST (no capacity planning at MVP scale)
 *   - Point-in-time recovery enabled
 *   - Customer-managed KMS encryption with dataKey
 *   - RemovalPolicy.RETAIN (never auto-delete on stack destroy)
 *   - Deterministic table names (no CDK hash suffix)
 *
 * TTL attribute is `ttl` on every table that uses it; sparse otherwise.
 */
export class DynamoStack extends Stack implements DynamoOutputs {
  public readonly sessionsTable: Table;
  public readonly hiveMindTable: Table;
  public readonly auditLogTable: Table;
  public readonly chatConfigTable: Table;
  public readonly tokenUsageTable: Table;
  public readonly memoriesTable: Table;
  public readonly consolidationsTable: Table;
  public readonly agentFileHistoryTable: Table;
  public readonly missionTasksTable: Table;
  public readonly scheduledTasksTable: Table;
  public readonly killSwitchesTable: Table;
  public readonly interAgentTasksTable: Table;
  public readonly compactionEventsTable: Table;
  public readonly queueLeaseTable: Table;
  public readonly effectLedgerTable: Table;
  public readonly spendLedgerTable: Table;
  /** C4: cross-surface identity mapping. */
  public readonly identitiesTable: Table;
  // v5.6 tables
  public readonly hookIdempotencyTable: Table;
  public readonly spawnLedgerTable: Table;
  public readonly extensionSubnetPoolTable: Table;
  public readonly extensionsRegistryTable: Table;
  public readonly warroomMeetingsTable: Table;
  public readonly warroomTurnsTable: Table;
  public readonly warroomConnectionsTable: Table;
  public readonly rateLimitsTable: Table;
  public readonly agentsTable: Table;
  public readonly dashboardTokensTable: Table;
  /** Generic key-value runtime config (daily cost cap, idle timeout, ...). */
  public readonly runtimeConfigTable: Table;
  /** Wave 4a: multi-user + RBAC. User profiles + magic-link tokens (single-table). */
  public readonly usersTable: Table;
  // Jarvis voice co-pilot (Phase 1).
  public readonly jarvisTicketsTable: Table;
  public readonly jarvisLeasesTable: Table;
  public readonly jarvisLedgerTable: Table;
  public readonly jarvisCanaryTable: Table;

  constructor(scope: Construct, id: string, props: DynamoStackProps) {
    super(scope, id, props);
    Object.entries(TAGS).forEach(([k, v]) => this.tags.setTag(k, v));

    const baseProps = {
      billingMode: BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      encryption: TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: props.dataKey,
      removalPolicy: RemovalPolicy.RETAIN,
    } as const;

    // ── sessions: PK=agentId, SK=chatId ─────────────────────────────
    this.sessionsTable = new Table(this, 'SessionsTable', {
      ...baseProps,
      tableName: RESOURCE_NAMES.ddb.sessions,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
    });

    // ── hive_mind: PK=DATE#YYYYMMDD, SK=TS#ms#AGENT#id#ID#ulid ──────
    this.hiveMindTable = new Table(this, 'HiveMindTable', {
      ...baseProps,
      tableName: RESOURCE_NAMES.ddb.hiveMind,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
    });
    this.hiveMindTable.addGlobalSecondaryIndex({
      indexName: 'gsi1-agent-time',
      partitionKey: { name: 'GSI1PK', type: AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });
    this.hiveMindTable.addGlobalSecondaryIndex({
      indexName: 'gsi2-xagent',
      partitionKey: { name: 'GSI2PK', type: AttributeType.STRING },
      sortKey: { name: 'GSI2SK', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    // ── audit_log ───────────────────────────────────────────────────
    this.auditLogTable = new Table(this, 'AuditLogTable', {
      ...baseProps,
      tableName: RESOURCE_NAMES.ddb.auditLog,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
    });
    this.auditLogTable.addGlobalSecondaryIndex({
      indexName: 'gsi1-date',
      partitionKey: { name: 'GSI1PK', type: AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    // ── chat_config: one item per agent ─────────────────────────────
    this.chatConfigTable = new Table(this, 'ChatConfigTable', {
      ...baseProps,
      tableName: RESOURCE_NAMES.ddb.chatConfig,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
    });

    // ── token_usage ─────────────────────────────────────────────────
    this.tokenUsageTable = new Table(this, 'TokenUsageTable', {
      ...baseProps,
      tableName: RESOURCE_NAMES.ddb.tokenUsage,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
    });
    this.tokenUsageTable.addGlobalSecondaryIndex({
      indexName: 'gsi1-agent-time',
      partitionKey: { name: 'GSI1PK', type: AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    // ── memories ────────────────────────────────────────────────────
    this.memoriesTable = new Table(this, 'MemoriesTable', {
      ...baseProps,
      tableName: RESOURCE_NAMES.ddb.memories,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
    });
    this.memoriesTable.addGlobalSecondaryIndex({
      indexName: 'gsi1-importance',
      partitionKey: { name: 'GSI1PK', type: AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });
    this.memoriesTable.addGlobalSecondaryIndex({
      indexName: 'gsi2-unconsolidated',
      partitionKey: { name: 'GSI2PK', type: AttributeType.STRING },
      sortKey: { name: 'GSI2SK', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    // ── consolidations ──────────────────────────────────────────────
    this.consolidationsTable = new Table(this, 'ConsolidationsTable', {
      ...baseProps,
      tableName: RESOURCE_NAMES.ddb.consolidations,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
    });

    // ── agent_file_history ──────────────────────────────────────────
    this.agentFileHistoryTable = new Table(this, 'AgentFileHistoryTable', {
      ...baseProps,
      tableName: RESOURCE_NAMES.ddb.agentFileHistory,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
    });

    // ── mission_tasks ───────────────────────────────────────────────
    this.missionTasksTable = new Table(this, 'MissionTasksTable', {
      ...baseProps,
      tableName: RESOURCE_NAMES.ddb.missionTasks,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
    });
    this.missionTasksTable.addGlobalSecondaryIndex({
      indexName: 'gsi1-status-agent-priority',
      partitionKey: { name: 'GSI1PK', type: AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    // ── scheduled_tasks ─────────────────────────────────────────────
    this.scheduledTasksTable = new Table(this, 'ScheduledTasksTable', {
      ...baseProps,
      tableName: RESOURCE_NAMES.ddb.scheduledTasks,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
    });
    this.scheduledTasksTable.addGlobalSecondaryIndex({
      indexName: 'gsi1-active-nextrun',
      partitionKey: { name: 'GSI1PK', type: AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    // ── kill_switches ───────────────────────────────────────────────
    this.killSwitchesTable = new Table(this, 'KillSwitchesTable', {
      ...baseProps,
      tableName: RESOURCE_NAMES.ddb.killSwitches,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
    });

    // ── inter_agent_tasks ───────────────────────────────────────────
    this.interAgentTasksTable = new Table(this, 'InterAgentTasksTable', {
      ...baseProps,
      tableName: RESOURCE_NAMES.ddb.interAgentTasks,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
    });
    this.interAgentTasksTable.addGlobalSecondaryIndex({
      indexName: 'gsi1-from-agent',
      partitionKey: { name: 'GSI1PK', type: AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    // ── compaction_events ───────────────────────────────────────────
    this.compactionEventsTable = new Table(this, 'CompactionEventsTable', {
      ...baseProps,
      tableName: RESOURCE_NAMES.ddb.compactionEvents,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
    });

    // ── queue_lease ─────────────────────────────────────────────────
    // For multi-task safety: every per-chat work-item acquires a lease
    // with a fencing token. Downstream writes verify the token to prevent
    // stale writes after expiry.
    this.queueLeaseTable = new Table(this, 'QueueLeaseTable', {
      ...baseProps,
      tableName: RESOURCE_NAMES.ddb.queueLease,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
    });

    this.effectLedgerTable = new Table(this, 'EffectLedgerTable', {
      ...baseProps,
      tableName: RESOURCE_NAMES.ddb.effectLedger,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
    });
    this.effectLedgerTable.addGlobalSecondaryIndex({
      indexName: 'gsi1-unknown',
      partitionKey: { name: 'GSI1PK', type: AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    // ── spend_ledger (C2-full, invariant I3) ────────────────────────
    // Atomic daily Bedrock spend ledger: reserve-before-spend admission for
    // every paid model call, across all tasks. One item per UTC day
    // (PK=DAY#<yyyy-mm-dd>: cap/spent/reserved/headroom/seq) plus one item
    // per reservation (PK=RES#<idempotencyKey>). All admission decisions are
    // single-item conditional writes, so PK-only keys suffice. Day items are
    // tiny and self-expire via ttl (reservations carry none today; the day
    // record is the durable accounting row).
    this.spendLedgerTable = new Table(this, 'SpendLedgerTable', {
      ...baseProps,
      tableName: RESOURCE_NAMES.ddb.spendLedger,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
    });

    // ── identities (C4) ─────────────────────────────────────────────
    // Cross-surface identity claim: a single canonical user spans
    // multiple Telegram chats / Slack user ids / future WhatsApp ids.
    //
    // Schema:
    //   PK = SURFACE#<surface>#<surfaceUserId>
    //   SK = CLAIM           (one row per surface-user link)
    //
    //   PK = CANONICAL#<canonicalUserId>
    //   SK = SURFACE#<surface>#<surfaceUserId>
    //
    // Pending claim codes live with:
    //   PK = CODE#<code>
    //   SK = CLAIM-STATE     (ttl = 10 min)
    //
    // The repo issues a 6-digit code on one surface, then accepts the
    // same code on another surface to bind both to a canonical id.
    this.identitiesTable = new Table(this, 'IdentitiesTable', {
      ...baseProps,
      tableName: RESOURCE_NAMES.ddb.identities,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
    });

    // ── v5.6: hook idempotency ────────────────────────────────────
    this.hookIdempotencyTable = new Table(this, 'HookIdempotencyTable', {
      ...baseProps,
      tableName: RESOURCE_NAMES.ddb.hookIdempotency,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
    });

    // ── v5.6: spawn ledger ─────────────────────────────────────────
    this.spawnLedgerTable = new Table(this, 'SpawnLedgerTable', {
      ...baseProps,
      tableName: RESOURCE_NAMES.ddb.spawnLedger,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
    });

    // ── v5.6: extension subnet pool ────────────────────────────────
    this.extensionSubnetPoolTable = new Table(this, 'ExtensionSubnetPoolTable', {
      ...baseProps,
      tableName: RESOURCE_NAMES.ddb.extensionSubnetPool,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
    });

    // ── v5.6: extensions registry ──────────────────────────────────
    this.extensionsRegistryTable = new Table(this, 'ExtensionsRegistryTable', {
      ...baseProps,
      tableName: RESOURCE_NAMES.ddb.extensionsRegistry,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
    });

    // ── v5.6: warroom meetings ─────────────────────────────────────
    this.warroomMeetingsTable = new Table(this, 'WarroomMeetingsTable', {
      ...baseProps,
      tableName: RESOURCE_NAMES.ddb.warroomMeetings,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
    });

    // ── v5.6: warroom turns ────────────────────────────────────────
    this.warroomTurnsTable = new Table(this, 'WarroomTurnsTable', {
      ...baseProps,
      tableName: RESOURCE_NAMES.ddb.warroomTurns,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
    });

    // ── v5.6: warroom connections ──────────────────────────────────
    this.warroomConnectionsTable = new Table(this, 'WarroomConnectionsTable', {
      ...baseProps,
      tableName: RESOURCE_NAMES.ddb.warroomConnections,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
    });
    this.warroomConnectionsTable.addGlobalSecondaryIndex({
      indexName: 'gsi1-by-connection',
      partitionKey: { name: 'GSI1PK', type: AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    // ── v5.6: rate limits ──────────────────────────────────────────
    this.rateLimitsTable = new Table(this, 'RateLimitsTable', {
      ...baseProps,
      tableName: RESOURCE_NAMES.ddb.rateLimits,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
    });

    // ── agents: per-agent metadata for dynamic agent management ──
    this.agentsTable = new Table(this, 'AgentsTable', {
      ...baseProps,
      tableName: RESOURCE_NAMES.ddb.agents,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
    });

    // ── dashboard_tokens: per-operator bearer tokens ─────────────
    this.dashboardTokensTable = new Table(this, 'DashboardTokensTable', {
      ...baseProps,
      tableName: RESOURCE_NAMES.ddb.dashboardTokens,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
    });
    // Wave 4a per-user revocation index. Session tokens minted by the magic-link
    // accept/verify flows stamp GSI2PK=USER#<userId>, so disabling or downgrading
    // a member can find and revoke every live session for that user without a
    // full table scan. Index name must match tokens-repo.revokeTokensForUser
    // (`gsi2-user`); a mismatch silently drops revocation back to the scan
    // fallback, so keep the two in lockstep.
    this.dashboardTokensTable.addGlobalSecondaryIndex({
      indexName: 'gsi2-user',
      partitionKey: { name: 'GSI2PK', type: AttributeType.STRING },
      sortKey: { name: 'GSI2SK', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    // ── runtime_config: generic key-value runtime config ─────────
    // Home for daily cost cap, session idle timeout, and future tunables.
    // Mirrors the kill-switches table construct exactly (PK + SK, no TTL).
    this.runtimeConfigTable = new Table(this, 'RuntimeConfigTable', {
      ...baseProps,
      tableName: RESOURCE_NAMES.ddb.runtimeConfig,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
    });

    // ── users (Wave 4a: multi-user + RBAC) ───────────────────────
    // Single-table design. Holds two item kinds:
    //
    //   User profile:
    //     PK = USER#<uuid>          SK = PROFILE
    //     GSI1PK = EMAIL#<emailLower>  GSI1SK = USER   (email→user lookup)
    //     fields: userId, email, emailLower, profileId (RBAC role/profile),
    //             status in {invited,active,disabled}, invitedBy, invitedAt,
    //             activatedAt, lastLoginAt, disabledAt.
    //
    //   Magic-link token (TRUE passwordless — only the sha256 hash is stored,
    //   the raw token lives only in the emailed link):
    //     PK = MAGIC#<sha256(rawToken)>   SK = STATE
    //     fields: userId, purpose in {invite,login}, createdAt, expiresAt,
    //             ttl = floor(expiresAt/1000), consumedAt (single-use).
    //
    // There is NO separate invitations table. TTL on `ttl` GCs expired magic
    // tokens; the consume path is conditioned (consumedAt absence + expiry),
    // so async TTL deletion is a GC backstop, not the expiry/single-use check.
    // Mirrors identitiesTable: KMS dataKey, PITR, RETAIN, PAY_PER_REQUEST.
    this.usersTable = new Table(this, 'UsersTable', {
      ...baseProps,
      tableName: RESOURCE_NAMES.ddb.users,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      sortKey: { name: 'SK', type: AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
    });
    this.usersTable.addGlobalSecondaryIndex({
      indexName: 'gsi1-email',
      partitionKey: { name: 'GSI1PK', type: AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: AttributeType.STRING },
      projectionType: ProjectionType.ALL,
    });

    // ── Jarvis: WS tickets (H10) ─────────────────────────────────
    // PK attribute is `ticket` (random 256-bit); single item per ticket, no SK.
    // TTL=expiresAt (GC only — consume is conditioned on expiresAt>=:now, so
    // async TTL deletion is NOT the expiry check).
    this.jarvisTicketsTable = new Table(this, 'JarvisTicketsTable', {
      ...baseProps,
      tableName: RESOURCE_NAMES.ddb.jarvisTickets,
      partitionKey: { name: 'ticket', type: AttributeType.STRING },
      timeToLiveAttribute: 'expiresAt',
    });

    // ── Jarvis: concurrency leases (H6) ──────────────────────────
    // PK=`SLOT#<i>` | `TOK#<hash>`. TTL=expiresAt (GC only — the acquire
    // condition `expiresAt < :now` is the correctness mechanism).
    this.jarvisLeasesTable = new Table(this, 'JarvisLeasesTable', {
      ...baseProps,
      tableName: RESOURCE_NAMES.ddb.jarvisLeases,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
      timeToLiveAttribute: 'expiresAt',
    });

    // ── Jarvis: spend ledger (H5) ────────────────────────────────
    // PK=`DAY#<utcDate>` (running aggregate, NO TTL) | `RES#<ownerId>`
    // (reaped, not TTL'd). GSI res-by-expiry (gpk='RES', expiresAt) drives
    // the reaper sweep.
    this.jarvisLedgerTable = new Table(this, 'JarvisLedgerTable', {
      ...baseProps,
      tableName: RESOURCE_NAMES.ddb.jarvisLedger,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
    });
    this.jarvisLedgerTable.addGlobalSecondaryIndex({
      indexName: 'res-by-expiry',
      partitionKey: { name: 'gpk', type: AttributeType.STRING },
      sortKey: { name: 'expiresAt', type: AttributeType.NUMBER },
      projectionType: ProjectionType.ALL,
    });

    // ── Jarvis: canary allowlist (Reference Contracts D) ─────────
    // PK=tokenHash. Seeded empty; fail-closed membership check.
    this.jarvisCanaryTable = new Table(this, 'JarvisCanaryTable', {
      ...baseProps,
      tableName: RESOURCE_NAMES.ddb.jarvisCanary,
      partitionKey: { name: 'PK', type: AttributeType.STRING },
    });

    // ── CfnOutputs for deploy-script consumption ─────────────────
    const tables: Record<string, Table> = {
      Sessions: this.sessionsTable,
      HiveMind: this.hiveMindTable,
      AuditLog: this.auditLogTable,
      ChatConfig: this.chatConfigTable,
      TokenUsage: this.tokenUsageTable,
      Memories: this.memoriesTable,
      Consolidations: this.consolidationsTable,
      AgentFileHistory: this.agentFileHistoryTable,
      MissionTasks: this.missionTasksTable,
      ScheduledTasks: this.scheduledTasksTable,
      KillSwitches: this.killSwitchesTable,
      InterAgentTasks: this.interAgentTasksTable,
      CompactionEvents: this.compactionEventsTable,
      QueueLease: this.queueLeaseTable,
      EffectLedger: this.effectLedgerTable,
      SpendLedger: this.spendLedgerTable,
      Identities: this.identitiesTable,
      HookIdempotency: this.hookIdempotencyTable,
      SpawnLedger: this.spawnLedgerTable,
      ExtensionSubnetPool: this.extensionSubnetPoolTable,
      ExtensionsRegistry: this.extensionsRegistryTable,
      WarroomMeetings: this.warroomMeetingsTable,
      WarroomTurns: this.warroomTurnsTable,
      WarroomConnections: this.warroomConnectionsTable,
      RateLimits: this.rateLimitsTable,
      Agents: this.agentsTable,
      DashboardTokens: this.dashboardTokensTable,
      RuntimeConfig: this.runtimeConfigTable,
      Users: this.usersTable,
      JarvisTickets: this.jarvisTicketsTable,
      JarvisLeases: this.jarvisLeasesTable,
      JarvisLedger: this.jarvisLedgerTable,
      JarvisCanary: this.jarvisCanaryTable,
    };
    for (const [name, table] of Object.entries(tables)) {
      new CfnOutput(this, `${name}TableName`, { value: table.tableName });
    }

    // ── Jarvis H7: create-only seed of the launch gate rows ──────
    // isJarvisEnabled() is fail-closed and DENIES on a MISSING jarvis_disabled
    // item, so a fresh table would stay disabled even with LAUNCH_ENABLED=true.
    // We seed BOTH jarvis_canary_mode=active AND jarvis_disabled=inactive,
    // create-only (ConditionExpression attribute_not_exists + ignore the
    // conditional-fail) so a redeploy never clobbers an operator-tripped kill.
    const ksTableName = RESOURCE_NAMES.ddb.killSwitches;
    const seedKmsActions = ['kms:GenerateDataKey', 'kms:Encrypt', 'kms:Decrypt'];
    const seedSwitch = (logicalId: string, switchName: string, active: boolean): void => {
      const call = {
        service: 'DynamoDB',
        action: 'putItem',
        parameters: {
          TableName: ksTableName,
          Item: {
            PK: { S: `SWITCH#${switchName}` },
            SK: { S: 'STATUS' },
            active: { BOOL: active },
            reason: { S: 'seeded by CDK (create-only)' },
            setBy: { S: 'cdk' },
            setAt: { S: '1970-01-01T00:00:00.000Z' },
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
        physicalResourceId: PhysicalResourceId.of(`seed-${switchName}`),
        ignoreErrorCodesMatching: 'ConditionalCheckFailedException',
      };
      new AwsCustomResource(this, logicalId, {
        onCreate: call,
        onUpdate: call,
        installLatestAwsSdk: false,
        policy: AwsCustomResourcePolicy.fromStatements([
          new PolicyStatement({ effect: Effect.ALLOW, actions: ['dynamodb:PutItem'], resources: [this.killSwitchesTable.tableArn] }),
          new PolicyStatement({ effect: Effect.ALLOW, actions: seedKmsActions, resources: [props.dataKey.keyArn] }),
        ]),
      });
    };
    seedSwitch('SeedJarvisCanaryMode', 'jarvis_canary_mode', true);
    seedSwitch('SeedJarvisDisabled', 'jarvis_disabled', false);

    // ── Wave 4a: default auth rate-limit policies (fail-CLOSED on auth) ──
    // The enforced-policy path (getEnforcedPolicy) returns limit 0 = UNLIMITED
    // for any scope an operator has not explicitly seeded, so the auth router's
    // authRateLimited() is inert until a policy row exists. That leaves
    // POST /api/auth/login and /verify unthrottled to brute-force / enumeration.
    // Seed conservative defaults for POLICY#auth_ip and POLICY#auth_email
    // create-only (attribute_not_exists + ignore ConditionalCheckFailed) so a
    // redeploy never clobbers an operator-tuned limit. An operator can raise or
    // disable (set limit 0) these later via the rate-limits admin surface.
    const rlTableName = RESOURCE_NAMES.ddb.rateLimits;
    const seedAuthPolicy = (
      logicalId: string,
      scope: string,
      limit: number,
      windowSec: number,
    ): void => {
      const call = {
        service: 'DynamoDB',
        action: 'putItem',
        parameters: {
          TableName: rlTableName,
          Item: {
            PK: { S: `POLICY#${scope}` },
            SK: { S: 'LIMIT' },
            limit: { N: String(limit) },
            windowSec: { N: String(windowSec) },
            updatedBy: { S: 'cdk' },
            updatedAt: { S: '1970-01-01T00:00:00.000Z' },
          },
          ConditionExpression: 'attribute_not_exists(PK)',
        },
        physicalResourceId: PhysicalResourceId.of(`seed-rl-${scope}`),
        ignoreErrorCodesMatching: 'ConditionalCheckFailedException',
      };
      new AwsCustomResource(this, logicalId, {
        onCreate: call,
        onUpdate: call,
        installLatestAwsSdk: false,
        policy: AwsCustomResourcePolicy.fromStatements([
          new PolicyStatement({ effect: Effect.ALLOW, actions: ['dynamodb:PutItem'], resources: [this.rateLimitsTable.tableArn] }),
          new PolicyStatement({ effect: Effect.ALLOW, actions: seedKmsActions, resources: [props.dataKey.keyArn] }),
        ]),
      });
    };
    // 10 auth attempts per IP per 5 min; 5 per email per 15 min. Tight enough to
    // blunt online guessing, loose enough not to lock out a legitimate operator
    // requesting a second magic link.
    seedAuthPolicy('SeedAuthIpPolicy', 'auth_ip', 10, 300);
    seedAuthPolicy('SeedAuthEmailPolicy', 'auth_email', 5, 900);

    // ── Jarvis H5: spend-reservation reaper ──────────────────────
    // Scheduled backstop that returns crashed sessions' unspent estimate to
    // headroom (the relay also reaps opportunistically at each handshake). The
    // ledger reclaim is owner-conditioned, so it never frees a replacement's
    // reservation (mirrors the unit-tested reapReservation()).
    const appPrefix = RESOURCE_NAMES.ddb.jarvisLedger.replace(/-jarvis-ledger$/, '');
    const reaperRole = new Role(this, 'JarvisReaperRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      description: 'Jarvis spend-ledger reservation reaper',
      managedPolicies: [ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')],
    });
    reaperRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['dynamodb:Query', 'dynamodb:TransactWriteItems'],
        resources: [this.jarvisLedgerTable.tableArn, `${this.jarvisLedgerTable.tableArn}/index/*`],
      }),
    );
    reaperRole.addToPolicy(
      new PolicyStatement({ effect: Effect.ALLOW, actions: seedKmsActions, resources: [props.dataKey.keyArn] }),
    );

    const reaperSource = [
      "const { DynamoDBClient, QueryCommand, TransactWriteItemsCommand } = require('@aws-sdk/client-dynamodb');",
      'const TABLE = process.env.LEDGER_TABLE;',
      'exports.handler = async () => {',
      '  const ddb = new DynamoDBClient({});',
      '  const now = Math.floor(Date.now() / 1000);',
      '  const q = await ddb.send(new QueryCommand({',
      '    TableName: TABLE, IndexName: "res-by-expiry",',
      '    KeyConditionExpression: "gpk = :g AND expiresAt < :now",',
      '    ExpressionAttributeValues: { ":g": { S: "RES" }, ":now": { N: String(now) } }, Limit: 50,',
      '  }));',
      '  let reaped = 0;',
      '  for (const it of (q.Items || [])) {',
      '    const ownerId = it.ownerId.S; const utcDate = it.utcDate.S;',
      '    const rem = Math.max(0, Number(it.estimate?.N || 0) - Number(it.settled?.N || 0));',
      '    try {',
      '      await ddb.send(new TransactWriteItemsCommand({ TransactItems: [',
      '        { Update: { TableName: TABLE, Key: { PK: { S: "DAY#" + utcDate } },',
      '          ConditionExpression: "reserved >= :rem",',
      '          UpdateExpression: "SET headroom = headroom + :rem, reserved = reserved - :rem",',
      '          ExpressionAttributeValues: { ":rem": { N: String(rem) } } } },',
      '        { Delete: { TableName: TABLE, Key: { PK: { S: "RES#" + ownerId } },',
      '          ConditionExpression: "ownerId = :o",',
      '          ExpressionAttributeValues: { ":o": { S: ownerId } } } },',
      '      ] }));',
      '      reaped++;',
      '    } catch (e) { /* concurrent settle/release — skip, owner-conditioned */ }',
      '  }',
      '  return { reaped };',
      '};',
    ].join('\n');

    const reaper = new LambdaFunction(this, 'JarvisReaperLambda', {
      functionName: `${appPrefix}-jarvis-reaper`,
      runtime: Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: Code.fromInline(reaperSource),
      role: reaperRole,
      timeout: Duration.minutes(2),
      memorySize: 256,
      environment: { LEDGER_TABLE: RESOURCE_NAMES.ddb.jarvisLedger },
      description: 'Reclaims expired Jarvis spend reservations (H5 crash reaper)',
    });
    new Rule(this, 'JarvisReaperSchedule', {
      ruleName: `${appPrefix}-jarvis-reaper`,
      description: 'Sweeps expired Jarvis reservations every 5 minutes',
      schedule: Schedule.rate(Duration.minutes(5)),
      targets: [new LambdaTarget(reaper)],
    });
  }
}
