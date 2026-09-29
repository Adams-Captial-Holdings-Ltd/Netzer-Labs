/**
 * P1 WI-1.4 — move dashboard conversations written before WI-1.1 onto the owner
 * model (owner decisions 8, 40 and 46).
 *
 * Before WI-1.1 a dashboard conversation's owner was `dashboard:<tokenHash>`. A
 * person can be proven for it only through that token: its own `userId` (a
 * magic-link session) or the one user an admin linked it to (decision 1).
 *  - provable   → re-owned with an immutable source record, and every window
 *                 turn written before P1 gets its own record
 *                 (sessions-repo reownLegacyConversation);
 *  - unprovable → deleted, records and all, and audited. Decision 46: the count
 *                 found a handful (9 dashboard chats in production, 5 of them the
 *                 master token's), so there is no retention window and no claim
 *                 path.
 * Left alone: other surfaces and ephemeral rows (both carry a ttl and expire on
 * their own), and conversations a person already owns.
 *
 * A dry run unless `apply` is set. Real data only at S1 (decision 18), and only
 * AFTER the owner links the master token (POST /tokens/:hashPrefix/link) — until
 * then its conversations are unprovable and `apply` deletes them.
 */

import { ScanCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './ddb.js';
import { lookupToken, type TokenRecord } from './tokens-repo.js';
import { deleteSession, reownLegacyConversation } from './sessions-repo.js';
import { writeAudit } from '../audit/audit-writer.js';

const TABLE = process.env.TABLE_SESSIONS ?? 'claudeclaw-sessions';
/** The owner every dashboard conversation carried before WI-1.1. */
const LEGACY_OWNER = /^dashboard:([0-9a-f]{64})$/;

export interface MigrationReport {
  apply: boolean;
  /** Durable dashboard conversations still owned by a token hash. */
  legacy: number;
  mapped: { session: number; link: number };
  unprovable: { tokenGone: number; noPerson: number; noOwner: number };
  skipped: { alreadyOwned: number; ephemeral: number; otherSurface: number };
  reowned: number;
  backfilled: number;
  deleted: number;
  /** `agentId/chatId: error name` — never content. */
  failures: string[];
}

type Unprovable = keyof MigrationReport['unprovable'];

export async function migrateLegacyConversations(opts: { apply: boolean }): Promise<MigrationReport> {
  const report: MigrationReport = {
    apply: opts.apply,
    legacy: 0,
    mapped: { session: 0, link: 0 },
    unprovable: { tokenGone: 0, noPerson: 0, noOwner: 0 },
    skipped: { alreadyOwned: 0, ephemeral: 0, otherSurface: 0 },
    reowned: 0,
    backfilled: 0,
    deleted: 0,
    failures: [],
  };
  const tokens = new Map<string, TokenRecord | null>();
  const tokenFor = async (hash: string): Promise<TokenRecord | null> => {
    if (!tokens.has(hash)) tokens.set(hash, await lookupToken(hash));
    return tokens.get(hash) ?? null;
  };
  let startKey: Record<string, unknown> | undefined;
  do {
    const out = await ddb().send(
      new ScanCommand({
        TableName: TABLE,
        ProjectionExpression: 'PK, SK, userId, #t',
        ExpressionAttributeNames: { '#t': 'ttl' },
        ExclusiveStartKey: startKey,
      }),
    );
    for (const row of out.Items ?? []) await visit(row, opts.apply, report, tokenFor);
    startKey = out.LastEvaluatedKey;
  } while (startKey);
  return report;
}

async function visit(
  row: Record<string, unknown>,
  apply: boolean,
  report: MigrationReport,
  tokenFor: (hash: string) => Promise<TokenRecord | null>,
): Promise<void> {
  const pk = String(row.PK ?? '');
  const sk = String(row.SK ?? '');
  // Conversation rows only — the shape WI-1.0's isConversationRow admits.
  if (!pk.startsWith('AGENT#') || !/^CHAT#[^#]+$/.test(sk)) return;
  const agentId = pk.slice('AGENT#'.length);
  const chatId = sk.slice('CHAT#'.length);
  if (!chatId.startsWith('dashboard:')) return void report.skipped.otherSurface++;
  if (row.ttl !== undefined) return void report.skipped.ephemeral++;
  const owner = typeof row.userId === 'string' ? row.userId : '';
  if (owner.startsWith('dashboard:user:')) return void report.skipped.alreadyOwned++;

  report.legacy++;
  const hash = LEGACY_OWNER.exec(owner)?.[1];
  const token = hash ? await tokenFor(hash) : null;
  const person = token?.userId ?? token?.linkedUserId;
  const where = `${agentId}/${chatId}`;
  if (person) {
    const provenBy = token?.userId ? 'session' : 'link';
    report.mapped[provenBy]++;
    if (!apply) return;
    try {
      const { backfilled } = await reownLegacyConversation(agentId, chatId, owner, `dashboard:user:${person}`, provenBy);
      report.reowned++;
      report.backfilled += backfilled;
    } catch (err) {
      report.failures.push(`${where}: ${err instanceof Error ? err.name : 'error'}`);
    }
    return;
  }

  const reason: Unprovable = !hash ? 'noOwner' : !token ? 'tokenGone' : 'noPerson';
  report.unprovable[reason]++;
  if (!apply) return;
  try {
    await deleteSession(agentId, chatId);
    report.deleted++;
    await writeAudit({ action: 'data_purged', agentId, chatId, detail: { scope: 'legacy-migration', reason }, result: 'ok' });
  } catch (err) {
    report.failures.push(`${where}: ${err instanceof Error ? err.name : 'error'}`);
  }
}
