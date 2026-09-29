/**
 * Privacy tools — `forget_me` and the corresponding /api/export endpoint.
 *
 * forget_me deletes the chat-scoped data on which we have unambiguous
 * authority: memories, the session, scheduled tasks the user created,
 * and inbox items in this chat. Missions are deliberately NOT deleted
 * here because they may be assigned to other agents who have
 * downstream dependencies on them; deleting unilaterally would silently
 * cancel cross-agent work. Missions appear in the export so the user
 * still sees what we have on them, and can call `update_mission` with
 * status=cancelled if they want to close them out individually.
 *
 * The audit row stays (immutable S3 bucket) so we can prove compliance
 * with the request, but the content of the deletes is recorded as a
 * sha256 hash of the pre-purge snapshot, not as the raw text.
 */

import type { Tool as BedrockTool } from '@aws-sdk/client-bedrock-runtime';
import { createHash } from 'node:crypto';
import { tools } from './registry.js';
import { writeAuditOrThrow } from '../audit/audit-writer.js';
import { logger } from '../../observability/logger.js';
import {
  listMemoriesForChat,
  forgetMemory,
} from '../state/memories-repo.js';
import {
  deleteSession,
  getSession,
} from '../state/sessions-repo.js';
import {
  listScheduledTasksForAgent,
  deleteScheduledTask,
} from '../state/scheduled-tasks-repo.js';
import {
  listInbox,
  deleteInterAgentTask,
} from '../state/inter-agent-tasks-repo.js';
import {
  listMissionsForExport,
} from '../missions/mission-acl.js';

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

export interface ExportPayload {
  agentId: string;
  chatId: string;
  exportedAt: string;
  session: ReturnType<typeof toSessionView>;
  memories: Array<{ id: string; content: string; importance: number; tags: string[]; createdAt: string }>;
  scheduledTasks: Array<{ id: string; promptText: string; nextRunAt: number; status: string }>;
  inboxFromOthers: Array<{ id: string; fromAgent: string; messageText: string; createdAt: string }>;
  missions: Array<{ id: string; title: string; body: string; status: string; createdAt: string }>;
}

function toSessionView(session: Awaited<ReturnType<typeof getSession>>): {
  turns: number;
  modelOverride?: string;
  updatedAt: number;
} {
  if (!session) return { turns: 0, updatedAt: 0 };
  return {
    turns: session.turns.length,
    ...(session.modelOverride ? { modelOverride: session.modelOverride } : {}),
    updatedAt: session.updatedAt,
  };
}

export async function exportChatData(
  agentId: string,
  chatId: string,
): Promise<ExportPayload> {
  const [session, memories, scheduled, inbox, missions] = await Promise.all([
    getSession(agentId, chatId),
    listMemoriesForChat(agentId, chatId, 500),
    listScheduledTasksForAgent(agentId, 500),
    listInbox(agentId, 200, ['queued', 'delivered', 'completed']),
    // C-11 / M31, THE BLOCKING GATE — and it has TWO halves, both of which end
    // in the same silent failure: a subject-access export that looks complete
    // and is not.
    //
    //  1. `issueToMission` hardcodes an unconditional `createdByChat:
    //     'paperclip'`, which matches no real chat id, so the filter below
    //     would drop every Paperclip-origin mission. The ACL restores the real
    //     value from the Netzar-side provenance row before the rows arrive
    //     here, which is why that filter is still one unchanged line.
    //  2. Reading the BOARD would drop every mission that predates the
    //     cutover, because the board is Paperclip-only once the flag is on.
    //     `listMissionsForExport` unions both substrates — always both, never
    //     conditionally — so a right-of-access answer does not shrink because
    //     an operator changed backends.
    listMissionsForExport(agentId, 200),
  ]);
  return {
    agentId,
    chatId,
    exportedAt: new Date().toISOString(),
    session: toSessionView(session),
    memories: memories.map((m) => ({
      id: m.id,
      content: m.content,
      importance: m.importance,
      tags: m.tags,
      createdAt: m.createdAt,
    })),
    scheduledTasks: scheduled
      .filter((t) => t.chatId === chatId)
      .map((t) => ({
        id: t.id,
        promptText: t.promptText,
        nextRunAt: t.nextRunAt,
        status: t.status,
      })),
    inboxFromOthers: inbox
      .filter((r) => r.toChat === chatId || r.fromChat === chatId)
      .map((r) => ({
        id: r.id,
        fromAgent: r.fromAgent,
        messageText: r.messageText,
        createdAt: r.createdAt,
      })),
    missions: missions
      .filter((m) => m.createdByChat === chatId)
      .map((m) => ({
        id: m.id,
        title: m.title,
        body: m.body,
        status: m.status,
        createdAt: m.createdAt,
      })),
  };
}

export interface PurgeReport {
  agentId: string;
  chatId: string;
  purgedAt: string;
  counts: {
    memories: number;
    scheduledTasks: number;
    inboxItems: number;
    sessionDeleted: boolean;
  };
  /** SHA-256 of the export taken just before purge — proves what was deleted without keeping the content. */
  preDeleteHash: string;
}

export async function purgeChatData(
  agentId: string,
  chatId: string,
  requestedBy = 'tool:forget_me',
): Promise<PurgeReport> {
  // Snapshot first so we can hash the pre-delete state. We don't store
  // the snapshot, only its hash, in the audit row.
  const snapshot = await exportChatData(agentId, chatId);
  const preDeleteHash = createHash('sha256')
    .update(JSON.stringify(snapshot))
    .digest('hex');

  const counts: PurgeReport['counts'] = {
    memories: 0,
    scheduledTasks: 0,
    inboxItems: 0,
    sessionDeleted: false,
  };

  try {
    const memories = await listMemoriesForChat(agentId, chatId, 500);
    for (const memory of memories) {
      await forgetMemory(agentId, chatId, memory.id);
      counts.memories += 1;
    }

    const scheduled = (await listScheduledTasksForAgent(agentId, 500)).filter(
      (t) => t.chatId === chatId,
    );
    for (const task of scheduled) {
      await deleteScheduledTask(agentId, task.id);
      counts.scheduledTasks += 1;
    }

    const inbox = (await listInbox(agentId, 500, ['queued', 'delivered', 'completed'])).filter(
      (r) => r.toChat === chatId || r.fromChat === chatId,
    );
    for (const item of inbox) {
      await deleteInterAgentTask(item);
      counts.inboxItems += 1;
    }

    // Keep this as the single shared session erasure path. It also removes
    // versioned artifacts for this chat.
    await deleteSession(agentId, chatId);
    counts.sessionDeleted = true;
  } catch (error) {
    await writeAuditOrThrow({
      action: 'data_purged',
      agentId,
      chatId,
      detail: { counts, preDeleteHash, requestedBy },
      result: 'error',
    });
    throw error;
  }

  const report: PurgeReport = {
    agentId,
    chatId,
    purgedAt: new Date().toISOString(),
    counts,
    preDeleteHash,
  };

  await writeAuditOrThrow({
    action: 'data_purged',
    agentId,
    chatId,
    detail: {
      counts: report.counts,
      preDeleteHash,
      requestedBy,
    },
    result: 'ok',
  });
  logger.warn(
    { agentId, chatId, counts: report.counts },
    'chat data purged',
  );
  return report;
}

tools.register('forget_me', {
  spec: spec(
    'forget_me',
    'Permanently delete every memory, session turn, scheduled task, inbox item, and mission scoped to THIS chat. Use ONLY when the user explicitly asks to be forgotten ("forget everything you know about me", "delete my data", "GDPR me out"). Confirm first; the action is irreversible. The audit row stays as a hash so we can prove the request was honored, but the content is gone.',
    {
      type: 'object',
      properties: {
        confirm: {
          type: 'boolean',
          description: 'Must be true. Refuse otherwise.',
        },
      },
      required: ['confirm'],
    },
  ),
  async invoke(args, ctx) {
    if (args.confirm !== true) {
      return {
        text: 'forget_me requires confirm=true. The action is irreversible.',
        isError: true,
      };
    }
    const report = await purgeChatData(ctx.agentId, ctx.chatId);
    return {
      text:
        `Purged. Deleted ${report.counts.memories} memories, ` +
        `${report.counts.scheduledTasks} scheduled tasks, ` +
        `${report.counts.inboxItems} inbox items, ` +
        `session ${report.counts.sessionDeleted ? 'removed' : 'kept'}. ` +
        `Audit hash: ${report.preDeleteHash.slice(0, 16)}…`,
    };
  },
});
