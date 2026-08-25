/**
 * Paperclip-native agent verbs the shared Mission tool surface cannot express:
 * adding a durable comment and creating one assigned child mission.
 *
 * REGISTERED IN `src/server.ts`'s side-effect import block. A tools module that
 * is not listed there registers NOTHING and throws nothing: the process starts,
 * the addon is missing from `GET /api/addons`, the verb is absent from every
 * agent's catalog, and no log line says so. That import is part of this file.
 *
 * THE GATE IS AT INVOKE, NEVER AT REGISTRATION. `paperclip_disabled` is a
 * 30-second-cache DynamoDB flag an operator flips live; registration happens
 * once at process start. So the tool registers unconditionally and refuses
 * inside `invoke`, twice over: `paperclipRoutingEnabled()` here (the substrate
 * router — the legacy DynamoDB board has no comment thread to write to), and
 * the kill switch inside the transport, which `client.invoke` re-checks at
 * every call BEFORE the circuit breaker and raises as `PaperclipDisabledError`.
 *
 * `ToolResult.text` IS MODEL-VISIBLE AND CARRIES NO URL. Nothing here mints,
 * embeds or reformats one. That is the rule `registry.ts`'s `ToolMedia` comment
 * records from a real production failure — a signed S3 URL retyped by the model
 * lost its `X-Amz-*` query string and returned AccessDenied — and it is also why
 * `friendly()` below rewrites `PaperclipDisabledError` instead of letting the
 * registry splice its `remediation` (operator free text) into model context.
 */
import { randomUUID } from 'node:crypto';
import type { Tool as BedrockTool } from '@aws-sdk/client-bedrock-runtime';
import { tools, type ToolContext, type ToolResult } from './registry.js';
import { registerAddon } from '../addons/registry.js';
import { writeAudit } from '../audit/audit-writer.js';
import {
  listBoardMissions,
  missionEngine,
  paperclipRoutingEnabled,
} from '../missions/mission-acl.js';
import {
  MISSION_RESOLVE_WINDOW,
  formatAmbiguousRef,
  formatCommentPosted,
  formatMissingArgument,
  formatNoMatch,
  formatSubtaskCreated,
  formatWrongSubstrate,
  resolveMissionRef,
} from '../missions/format.js';
import {
  MISSION_PRIORITIES,
  type Mission,
  type MissionPriority,
} from '../state/mission-tasks-repo.js';
import type { MissionEngineOptions } from '../paperclip/mission-engine.js';
import { PaperclipDisabledError, PaperclipRunIdRequiredError } from '../paperclip/error.js';

/**
 * Surfaces on `GET /api/addons`. `configured` is computed from these env vars
 * at read time (there is no Paperclip OAuth to check); `killSwitchActive` and
 * `active` come from the route's own `isKillSwitchActive('paperclip_disabled')`
 * lookup. Registered at module load, like every other addon — the addon record
 * is an INVENTORY entry, not a gate, and `registerIfConfigured` is deliberately
 * not used here because the verb must exist to be able to refuse.
 */
registerAddon({
  id: 'paperclip',
  title: 'Paperclip (mission work engine)',
  category: 'integration',
  description:
    'Runs the mission board on the Paperclip work engine and lets agents comment or create subtasks from any chat surface.',
  required: [{ envVar: 'PAPERCLIP_BASE_URL' }, { envVar: 'PAPERCLIP_COMPANY_ID' }],
  killSwitch: 'paperclip_disabled',
  defaultOn: true,
});

/** Same wrapper shape as `mission-tools.ts`'s local `spec()`. */
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

/**
 * Paperclip errors carry operator-authored remediation text. `registry.invoke`'s
 * generic catch would splice it into the model's context as
 * `Tool 'x' failed: <message>`, so the two refusals with a fixed meaning get a
 * fixed sentence instead. Same reasoning as the 503 body in
 * `src/adapters/dashboard/missions.ts`, which spreads `reason` conditionally
 * rather than always handing a switch's free text to a principal.
 */
function friendly(err: unknown): string {
  if (err instanceof PaperclipDisabledError) {
    return 'The Paperclip integration is switched off (kill switch: paperclip_disabled). An operator has to clear it.';
  }
  if (err instanceof PaperclipRunIdRequiredError) {
    return 'Paperclip refused: that action needs an agent run id, which a chat turn does not hold.';
  }
  return err instanceof Error ? err.message : String(err);
}

function invokeOptions(ctx: ToolContext): MissionEngineOptions {
  return { actor: ctx.agentId, ...(ctx.runId ? { runId: ctx.runId } : {}) };
}

type OwnedMission = { mission: Mission } | { error: ToolResult };

async function resolveOwnedMission(ctx: ToolContext, ref: string): Promise<OwnedMission> {
  const self = ctx.boardAgentId ?? ctx.agentId;
  const rows = await listBoardMissions(self, MISSION_RESOLVE_WINDOW);
  const match = resolveMissionRef(rows, ref);
  if (match.kind === 'none') {
    return { error: { text: formatNoMatch({ owner: self, ref }), isError: true } };
  }
  if (match.kind === 'ambiguous') {
    return {
      error: {
        text: formatAmbiguousRef({
          owner: self,
          ref,
          ids: match.matches.map((mission) => mission.id),
        }),
        isError: true,
      },
    };
  }
  return { mission: match.mission };
}

function auditMutation(
  ctx: ToolContext,
  toolName: 'paperclip_add_comment' | 'paperclip_create_subtask',
  action: 'add_comment' | 'create_subtask',
  issueId: string,
  extra: Record<string, unknown> = {},
): void {
  void writeAudit({
    action: 'tool_invoke',
    agentId: ctx.agentId,
    chatId: ctx.chatId,
    ...(ctx.surface ? { surface: ctx.surface } : {}),
    toolName,
    detail: { action, issueId, ...extra, runId: ctx.runId ?? null },
    result: 'ok',
  });
}

tools.register('paperclip_add_comment', {
  spec: spec(
    'paperclip_add_comment',
    "Post a comment on one of your own missions. Use this to record progress, leave a handover note, or explain a decision so it outlives this conversation. The comment is visible on the mission's thread, not in this chat.",
    {
      type: 'object',
      required: ['mission_id', 'body'],
      properties: {
        mission_id: {
          type: 'string',
          description: 'Full id or 8-char prefix from list_missions.',
        },
        body: {
          type: 'string',
          description: 'The comment text.',
        },
      },
    },
  ),
  async invoke(args, ctx) {
    // GATE 1, AT INVOKE. The substrate router, read per call. With the legacy
    // DynamoDB board active there is no comment thread to write to, and
    // pretending otherwise would silently drop the agent's note.
    if (!paperclipRoutingEnabled()) {
      // THE WORDS ARE THE SHARED MODULE'S (A3-4), like every other mission
      // sentence a person can end up reading. A wrong SUBSTRATE is not an
      // outage — the board is up, this verb simply does not exist on it — so it
      // has its own sentence rather than reusing `formatBoardError`.
      return { text: formatWrongSubstrate(), isError: true };
    }
    // The board scope, as in `mission-tools.ts`: on a surface running one bot
    // per agent the board is the BOT's, not the turn agent's, so a ref copied
    // out of `/missions` resolves for the agent standing next to that board.
    const ref = String(args.mission_id ?? '').trim();
    const body = String(args.body ?? '').trim();
    if (!ref) return { text: formatMissingArgument('mission_id'), isError: true };
    if (!body) return { text: formatMissingArgument('body'), isError: true };

    try {
      // Ownership is the same pull-based check `list_missions` and
      // `update_mission` make, and for the same reason: chat surfaces have no
      // capability model, so authorization stays at the tool. Resolving the ref
      // against THIS agent's own board means an agent that overhears a prefix
      // cannot write onto someone else's thread.
      //
      // THE WINDOW AND THE MATCHER ARE THE SHARED ONES (A3-4). This read used a
      // private window of 100 while the ACL used 200 and the chat router used
      // 15 — three widths for the one 8-char ref this phase teaches users to
      // copy between surfaces. Both now come from `src/lib/missions/format.ts`.
      const match = await resolveOwnedMission(ctx, ref);
      // THE REFUSALS ARE THE SHARED MODULE'S TOO (A3-4). This file used to
      // hand-type both of them, which made "no mission matches" exist four
      // times in three files in two spellings, and made the ambiguous refusal
      // list 8-char refs that were all identical to the ref it had just called
      // insufficient. `ToolResult.text` is relayed to the user by the model, so
      // it is the same audience as the chat copy and gets the same sentences.
      if ('error' in match) return match.error;

      const engine = await missionEngine();
      // GATE 2, AT INVOKE, INSIDE THE TRANSPORT: the client re-checks
      // `paperclip_disabled` on every call, before the circuit breaker, and
      // throws PaperclipDisabledError. Nothing here re-checks it.
      //
      await engine.comment(match.mission.id, body, invokeOptions(ctx));
      auditMutation(ctx, 'paperclip_add_comment', 'add_comment', match.mission.id);
      return { text: formatCommentPosted(match.mission.id) };
    } catch (err) {
      return { text: friendly(err), isError: true };
    }
  },
});

tools.register('paperclip_create_subtask', {
  spec: spec(
    'paperclip_create_subtask',
    'Create one assigned subtask under one of your own Paperclip missions. Use this to delegate a bounded piece of the parent mission; nested delegation is refused.',
    {
      type: 'object',
      required: ['mission_id', 'title', 'body', 'owner'],
      properties: {
        mission_id: {
          type: 'string',
          description: 'Full id or 8-char prefix of the parent from list_missions.',
        },
        title: { type: 'string', description: 'Short headline for the child mission.' },
        body: { type: 'string', description: 'Bounded work and acceptance criteria.' },
        owner: { type: 'string', description: 'Netzar agent slug that will own the child.' },
        priority: {
          type: 'string',
          enum: [...MISSION_PRIORITIES],
          description: 'Priority band; default medium.',
        },
      },
    },
  ),
  async invoke(args, ctx) {
    if (!paperclipRoutingEnabled()) {
      return { text: formatWrongSubstrate(), isError: true };
    }
    if ((ctx.delegationDepth ?? 0) >= 1) {
      return {
        text: 'Delegation depth limit reached — answer with what you have instead of delegating further.',
        isError: true,
      };
    }

    const ref = String(args.mission_id ?? '').trim();
    const title = String(args.title ?? '').trim();
    const body = String(args.body ?? '').trim();
    const owner = String(args.owner ?? '').trim();
    if (!ref) return { text: formatMissingArgument('mission_id'), isError: true };
    if (!title) return { text: formatMissingArgument('title'), isError: true };
    if (!body) return { text: formatMissingArgument('body'), isError: true };
    if (!owner) return { text: formatMissingArgument('owner'), isError: true };

    try {
      const parent = await resolveOwnedMission(ctx, ref);
      if ('error' in parent) return parent.error;

      const now = new Date().toISOString();
      const child: Mission = {
        id: randomUUID(),
        ownerAgent: owner,
        createdByAgent: ctx.agentId,
        createdByChat: ctx.chatId,
        title,
        body,
        priority: MISSION_PRIORITIES.includes(args.priority as MissionPriority)
          ? args.priority as MissionPriority
          : 'medium',
        status: 'open',
        assignmentReason: `delegated by ${ctx.agentId}`,
        createdAt: now,
        updatedAt: now,
      };
      const engine = await missionEngine();
      const created = await engine.createSubtask(parent.mission.id, child, invokeOptions(ctx));
      auditMutation(ctx, 'paperclip_create_subtask', 'create_subtask', created.id, {
        parentIssueId: parent.mission.id,
      });
      return {
        text: formatSubtaskCreated({
          parentMissionId: parent.mission.id,
          missionId: created.id,
          ownerAgent: created.ownerAgent,
        }),
      };
    } catch (err) {
      return { text: friendly(err), isError: true };
    }
  },
});
