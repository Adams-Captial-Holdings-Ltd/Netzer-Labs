/**
 * Mission provenance — the three Netzar-side facts a Paperclip issue cannot carry.
 *
 * C-11 / M31, AND IT IS A COMPLIANCE GATE, NOT A CONVENIENCE. `issueToMission`
 * (`src/lib/paperclip/mission-projection.ts`) hardcodes an unconditional
 * `createdByChat: 'paperclip'` — there is no branch, no parameter and no
 * `metadata` column on `issues` to round-trip one through. Meanwhile
 * `exportChatData` (`src/lib/tools/privacy-tools.ts`) selects a subject's
 * missions with `m.createdByChat === chatId`. Those two facts together mean
 * every Paperclip-origin mission would return an EMPTY `missions: []` from a
 * GDPR subject-access export — no error, no log, silent data loss, and the
 * default behaviour for the whole board once the ACL is armed.
 *
 * The fix is this row, written on the Netzar side at create time and joined
 * back on every read, so `createdByChat` is restored before the export filter
 * ever sees it and `privacy-tools.ts` keeps its one-line filter unchanged.
 *
 * `assignmentReason` and `dueAt` ride along because they have the same problem
 * for a different reason: `missionToIssueCreate` sends neither and
 * `ProjectedMission` carries neither, yet `web/src/pages/Missions.tsx` renders
 * both. One write, one join, three fields recovered.
 *
 * NO NEW TABLE AND NO CDK EDIT. These rows live in the existing mission-tasks
 * table on a partition key no mission query touches (`listMissionsForAgent`
 * reads `PK = AGENT#<owner>`), so they are invisible to every existing query.
 *
 * THE ONLY ACCESS PATTERN IS BY MISSION ID. There is deliberately no
 * chat-scoped index: the GDPR export reaches these rows by joining onto a board
 * read it already performs (`getMissionProvenance`), so a `CHAT#<id>` secondary
 * key would be a second way to ask a question nothing asks. It was written and
 * removed rather than kept "in case" — an unread index key is a migration to
 * maintain, not an option to hold.
 */

import { BatchGetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from './ddb.js';

const TABLE = process.env.TABLE_MISSION_TASKS ?? 'claudeclaw-mission-tasks';

/** DynamoDB's hard cap on one BatchGetItem request. */
const BATCH_GET_MAX_KEYS = 100;

export interface MissionProvenance {
  /** The Paperclip issue uuid, which is also `Mission.id` on the wire. */
  missionId: string;
  /** The originating chat — the field `privacy-tools.ts` filters a GDPR export on. */
  createdByChat: string;
  createdByAgent: string;
  assignmentReason?: string;
  dueAt?: string;
}

function pk(missionId: string): string {
  return `PROVENANCE#${missionId}`;
}

export async function putMissionProvenance(row: MissionProvenance): Promise<void> {
  await ddb().send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: pk(row.missionId),
        SK: 'PROVENANCE',
        missionId: row.missionId,
        createdByChat: row.createdByChat,
        createdByAgent: row.createdByAgent,
        ...(row.assignmentReason ? { assignmentReason: row.assignmentReason } : {}),
        ...(row.dueAt ? { dueAt: row.dueAt } : {}),
      },
    }),
  );
}

/**
 * ONE round trip per 100 missions, not one per mission: the board read is
 * capped at 100 rows and this is on its hot path.
 *
 * A missing row is a missing map entry, never a throw. Rows created in
 * Paperclip's own UI have no Netzar provenance and must still render.
 */
export async function getMissionProvenance(
  missionIds: readonly string[],
): Promise<Map<string, MissionProvenance>> {
  const out = new Map<string, MissionProvenance>();
  const unique = [...new Set(missionIds)].filter((id) => id.length > 0);
  for (let i = 0; i < unique.length; i += BATCH_GET_MAX_KEYS) {
    const chunk = unique.slice(i, i + BATCH_GET_MAX_KEYS);
    const res = await ddb().send(
      new BatchGetCommand({
        RequestItems: {
          [TABLE]: { Keys: chunk.map((id) => ({ PK: pk(id), SK: 'PROVENANCE' })) },
        },
      }),
    );
    for (const item of res.Responses?.[TABLE] ?? []) {
      const row = toProvenance(item as Record<string, unknown>);
      if (row) out.set(row.missionId, row);
    }
  }
  return out;
}

function toProvenance(i: Record<string, unknown>): MissionProvenance | undefined {
  const missionId = typeof i.missionId === 'string' ? i.missionId : '';
  if (!missionId) return undefined;
  return {
    missionId,
    createdByChat: String(i.createdByChat ?? ''),
    createdByAgent: String(i.createdByAgent ?? ''),
    ...(i.assignmentReason ? { assignmentReason: String(i.assignmentReason) } : {}),
    ...(i.dueAt ? { dueAt: String(i.dueAt) } : {}),
  };
}
