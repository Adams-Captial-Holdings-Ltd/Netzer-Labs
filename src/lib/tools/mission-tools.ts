/**
 * Mission tasks tools.
 *
 * create_mission spawns a tracked work unit and asks Haiku 4.5 to pick
 * the right owner agent. Haiku reads the title + body + the known
 * agents' system-prompt previews and returns a single agent id plus a
 * one-sentence rationale.
 *
 * The model creating the mission may also pass `owner` explicitly to
 * skip the Haiku step (faster, cheaper).
 *
 * Once assigned, the recipient gets a notification in their inter-agent
 * inbox so they see it on the next turn.
 */

import type { Tool as BedrockTool } from '@aws-sdk/client-bedrock-runtime';
import { tools } from './registry.js';
import type { ToolContext } from './registry.js';
import {
  MISSION_PRIORITIES,
  MISSION_STATUSES,
  type Mission,
  type MissionPriority,
  type MissionStatus,
} from '../state/mission-tasks-repo.js';
// The SAME ACL the dashboard route, Jarvis and the GDPR export use. Phase 7
// repointed three SUBSTRATE call sites here — create, list, set-status. P0-3
// adds three more: `resolveBoardMission`, which reads the board to fetch the
// row an authorization decision needs, and the two pure predicates that make
// the decision, `canReadBoard` and `canMutateMission`. The rules are
// STATED there and only ASKED here, so a second caller cannot restate them
// (A3-1). Phase 9 deliberately widens the status schemas,
// changes priority to the exact four bands, and removes the retired due date.
//
// Phase 9 makes the shared domain match Paperclip's four exact priority bands;
// there is no numeric projection or due-date field to lose at this boundary.
import {
  AmbiguousMissionPrefixError,
  canMutateMission,
  canReadBoard,
  createBoardMission,
  listBoardMissions,
  listBoardMissionsByStatus,
  resolveBoardMission,
  setBoardMissionStatus,
} from '../missions/mission-acl.js';
import { sendInterAgent } from '../state/inter-agent-tasks-repo.js';
import {
  MISSION_LIST_LIMIT,
  formatAmbiguousRef,
  formatAssignmentPush,
  formatMissingArgument,
  formatMissionCreated,
  formatMissionList,
  formatNoMatch,
  formatStatusChanged,
  missionRef,
} from '../missions/format.js';
import { deliverToReplyChat } from '../scheduler/delivery.js';
import { listKnownAgents, loadAgent } from '../config/agent-loader.js';
import { converseTurn } from '../bedrock/client.js';
import { logger } from '../../observability/logger.js';

const HAIKU =
  process.env.BEDROCK_HAIKU_MODEL ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0';

const ASSIGN_SYSTEM = `You assign work to one of several AI agents in a multi-agent deployment. Read the mission title and body, plus each agent's one-line role, and pick the single best owner. Reply in this exact format:
AGENT: <agent id>
REASON: <one-sentence rationale, <= 25 words>
Do not include anything else.`;

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

interface AssignResult {
  owner: string;
  reason: string;
}

export async function autoAssign(
  title: string,
  body: string,
): Promise<AssignResult> {
  const ids = listKnownAgents();
  if (ids.length === 0) {
    throw new Error('no agents configured to assign to');
  }
  if (ids.length === 1) {
    return { owner: ids[0], reason: 'only agent available' };
  }
  const briefs = await Promise.all(
    ids.map(async (id) => {
      const a = await loadAgent(id);
      const oneLine = a.systemPrompt
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 240);
      return `- ${id} (${a.displayName ?? id}): ${oneLine}`;
    }),
  );
  const out = await converseTurn({
    modelId: HAIKU,
    systemPrompt: ASSIGN_SYSTEM,
    userText: `Available agents:\n${briefs.join('\n')}\n\nMission title: ${title}\n\nMission body:\n${body}`,
    maxTokens: 120,
    temperature: 0,
  });
  return parseAssignResponse(out.text, ids);
}

export function parseAssignResponse(
  raw: string,
  validAgents: string[],
): AssignResult {
  const lines = raw.split(/\r?\n/).map((l) => l.trim());
  let owner = '';
  let reason = '';
  for (const line of lines) {
    const a = /^AGENT:\s*(.+)$/i.exec(line);
    if (a) owner = a[1].trim().replace(/^[`'"]+|[`'"]+$/g, '');
    const r = /^REASON:\s*(.+)$/i.exec(line);
    if (r) reason = r[1].trim();
  }
  if (!owner || !validAgents.includes(owner)) {
    // Fall back: lowercase match, then first agent.
    const lower = owner.toLowerCase();
    const match = validAgents.find((a) => a.toLowerCase() === lower);
    owner = match ?? validAgents[0];
    if (!reason) reason = `auto-fallback (Haiku output unclear: ${raw.slice(0, 80)})`;
  }
  return { owner, reason: reason || 'no rationale given' };
}

/**
 * THE IDENTITY THE MISSION TOOLS ACT AS — one scope, used by all three.
 *
 * `ctx.agentId` is the SESSION scope (whose history and records this turn uses)
 * and `ctx.boardAgentId` is the BOARD scope (whose mission board this chat
 * addresses); the doc comment at `agent-loop.ts:178-197` is the authority on
 * the difference. They diverge only where a surface runs more than one bot AND
 * the picker can answer as someone else — Telegram, where the sticky default
 * answers `main` inside `/tg/research/webhook`. Slack's per-agent apps and the
 * dashboard pass one id and the two coincide.
 *
 * THESE TOOLS ADDRESS A BOARD, so they take the board scope — and they take it
 * for PROVENANCE as much as for scoping. The identity that acts on a board is
 * the identity that later transitions its rows, so the creator recorded by
 * `create_mission` and the actor judged by `canMutateMission` have to be the
 * SAME scope. Stamping the session actor and judging the board agent would fail
 * closed, and would fail closed on Telegram ONLY: the agent that opened a
 * mission would be refused as its own creator on one surface and allowed on the
 * other two. That is the parity failure CLAUDE.md is about, and it is why this
 * is a named function rather than the expression repeated four times.
 *
 * `ctx.agentId` still names the SESSION actor where the fact is about who did
 * the thing rather than about which board it happened on: the assignment push's
 * sender and the inter-agent note's `fromAgent`, both below.
 */
function boardSelf(ctx: ToolContext): string {
  return ctx.boardAgentId ?? ctx.agentId;
}

tools.register('create_mission', {
  spec: spec(
    'create_mission',
    'Create a tracked mission task. If `owner` is omitted, Haiku 4.5 picks the best agent based on the title and body. Use this when the user asks you to "open a ticket", "track this work", "follow up on X next week", or any persistent multi-step item that should outlive this conversation.',
    {
      type: 'object',
      required: ['title', 'body'],
      properties: {
        title: { type: 'string', description: 'Short headline (under 80 chars).' },
        body: { type: 'string', description: 'Full task description with acceptance criteria.' },
        owner: {
          type: 'string',
          description: 'Optional explicit owner agent id. Skip to let Haiku auto-assign.',
        },
        priority: {
          type: 'string',
          enum: [...MISSION_PRIORITIES],
          description: 'Priority band; default medium.',
        },
      },
    },
  ),
  async invoke(args, ctx) {
    // ONE CONVERSATION, ONE BOARD (CLAUDE.md, "chat surface parity"). `self` is
    // the agent whose board this chat addresses, and on a surface running one
    // bot per agent that is the BOT, not the turn agent: `/missions` already
    // scopes on the receiving bot (`CommandScope.boardAgentId`), and a tool
    // scoping on `ctx.agentId` therefore answered from a DIFFERENT board in the
    // same chat — `/missions` listing `[abc12345]` while `list_missions` said
    // "No Open missions for main", and `create_mission` writing where
    // `/mission new` does not. `boardAgentId` is absent on every surface with
    // one identity per conversation (Slack per-agent, the dashboard), where it
    // collapses to the old behaviour exactly. `boardSelf` above says why this
    // scope is also the one RECORDED as the creator, and why `ctx.agentId`
    // still names the sender of the push and the inter-agent note below.
    const self = boardSelf(ctx);
    const title = String(args.title ?? '').trim();
    const body = String(args.body ?? '').trim();
    if (!title) return { text: formatMissingArgument('title'), isError: true };
    if (!body) return { text: formatMissingArgument('body'), isError: true };
    const priority = MISSION_PRIORITIES.includes(args.priority as MissionPriority)
      ? args.priority as MissionPriority
      : 'medium';

    let owner: string;
    let reason: string;
    if (typeof args.owner === 'string' && args.owner) {
      owner = args.owner;
      reason = 'explicit assignment';
      const known = listKnownAgents();
      if (!known.includes(owner)) {
        return {
          text: `Unknown owner '${owner}'. Known: ${known.join(', ')}.`,
          isError: true,
        };
      }
    } else {
      try {
        const assign = await autoAssign(title, body);
        owner = assign.owner;
        reason = assign.reason;
      } catch (err) {
        logger.warn(
          { errMessage: err instanceof Error ? err.message : String(err) },
          'auto-assign failed; defaulting to creator',
        );
        owner = self;
        reason = 'auto-assign failed; defaulted to creating agent';
      }
    }

    const mission = await createBoardMission({
      ownerAgent: owner,
      // THE BOARD SCOPE, not `ctx.agentId` — the same `self` this tool scopes
      // with. The creator recorded here is the actor `canMutateMission` judges
      // when someone later transitions this row, so recording the session actor
      // while judging the board agent would refuse an agent its own mission
      // wherever the two differ, and only there. See `boardSelf`.
      createdByAgent: self,
      // The provenance value. `mission.id` below is the Paperclip issue uuid,
      // which is still a stable, 8-char-sliceable id — both the return text and
      // the inbox note depend on that and neither changes.
      createdByChat: ctx.chatId,
      title,
      body,
      priority,
      assignmentReason: reason,
    });

    // THE ASSIGNMENT PUSH (A3-12), and it is ONE emission site for every
    // surface. Handing work to another agent used to be PULL-ONLY: the
    // `sendInterAgent` note below lands in the owner's inbox and nobody sees it
    // until the owner's next turn. This posts the same fact into the chat the
    // handoff happened in, so the room learns immediately.
    //
    // It is surface-agnostic by construction and there is no mission-specific
    // adapter code behind it: `deliverToReplyChat` routes `ctx.replyChatId` and
    // the words come from the shared pure formatter, so Telegram, Slack main
    // and Slack per-agent post the identical sentence.
    //
    // AND EACH BOT POSTS IT AS ITSELF, which is the half that was wrong twice
    // and the reason CLAUDE.md prints "TWO send paths" in bold. A delivery
    // layer that sees only WHERE the chat is has to guess WHO speaks, and the
    // guess it had was the turn agent — which the sticky default routinely
    // makes `main` inside another bot's chat. On Slack that posted a per-agent
    // app's notice with the workspace token; on Telegram it posted over the
    // wrong bot's token entirely, which Telegram answers with a 403, or worse
    // delivers into that other bot's DM with the user. Both handlers therefore
    // stamp the identity into `replyChatId` — `:app-<agentId>` on Slack,
    // `:bot-<agentId>` on Telegram — and `deliverToReplyChat` resolves the
    // token back. `mission-assignment-push.test.ts` asserts the two Slack paths
    // differ in their token and that Telegram's send is addressed to the OWNING
    // bot; `delivery.telegram-identity.test.ts` drives the real sender and
    // asserts the token in the wire URL, which is the only assertion that can
    // tell one Telegram bot from another.
    //
    // PARITY GAP, DELIBERATE (see CLAUDE.md, "chat surface parity"): the
    // DASHBOARD gets no push, and `deliverToReplyChat` returns false rather
    // than pretending otherwise. The missing primitive is an out-of-band
    // channel — dashboard chat is request/response over an SSE stream open only
    // for the turn in flight, and there is no bot identity that can post into it
    // between turns. The dashboard handler passes NO `replyChatId` at all (grep
    // it: zero occurrences), and `resolveDeliveryTarget` has answered null for
    // `dashboard:` ids since the scheduler shipped. The fallback is one
    // the dashboard already has and the chat surfaces do not — its Missions tab
    // renders the owner's board live, and `/missions` answers there too. So it
    // is marked rather than silently omitted.
    //
    // The catch swallows on purpose. The mission is ALREADY CREATED at this
    // point and the tool result below is the authoritative answer; a Slack
    // outage or a stale Telegram chat id must not turn a successful create into
    // a failed tool call. Same policy as onToolEvent's emission — a surface bug
    // must not kill the turn — except this one logs, because a push that never
    // arrives is invisible otherwise.
    //
    // IT SWALLOWS THE FAILURE, IT DOES NOT HIDE IT. `pushed` stays undefined
    // when no push was owed (the mission stayed with the agent in the room, or
    // there is no chat to push into), and goes FALSE when one was owed and did
    // not arrive — a refusal from the surface as much as a thrown error, since
    // both adapters report a 403 or a `not_in_channel` by returning, not by
    // throwing. The receipt below says which, because the model relays that
    // text and a receipt that reads the same either way tells the room everyone
    // has been told when nobody has.
    let pushed: boolean | undefined;
    if (owner !== self && ctx.replyChatId) {
      try {
        pushed = await deliverToReplyChat(
          ctx.agentId,
          ctx.replyChatId,
          formatAssignmentPush({ mission, byAgent: ctx.agentId }),
        );
      } catch (err) {
        pushed = false;
        logger.warn(
          { errMessage: err instanceof Error ? err.message : String(err) },
          'mission assignment push failed',
        );
      }
    }

    // Drop a note in the owner's inbox if it's not the agent in the room.
    if (owner !== self) {
      await sendInterAgent({
        fromAgent: ctx.agentId,
        fromChat: ctx.chatId,
        toAgent: owner,
        // `missionRef`, not a private `slice(0, 8)`: the inbox note is read by
        // an agent that will type the ref back into `update_mission` or
        // `paperclip_comment`, so it must be the one width the resolver
        // resolves. This is the pull half; the push above is the same fact
        // in the room the handoff happened in.
        messageText: `New mission [${missionRef(mission.id)}] "${title}" (priority ${priority}). ${reason}`,
        intent: 'request',
      }).catch((err) => {
        logger.warn(
          { errMessage: err instanceof Error ? err.message : String(err) },
          'mission inbox notification failed',
        );
      });
    }
    return {
      text: formatMissionCreated({
        mission,
        reason,
        ...(pushed === false ? { pushFailed: true } : {}),
      }),
    };
  },
});

tools.register('list_missions', {
  spec: spec(
    'list_missions',
    "List missions on any agent's board. Defaults to your own open missions.",
    {
      type: 'object',
      properties: {
        owner: {
          type: 'string',
          description: "Owner agent id; any agent's board. Defaults to your own.",
        },
        status: {
          type: 'string',
          enum: [...MISSION_STATUSES, 'all'],
          description: 'Filter; defaults to "open".',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Max rows; defaults to 15.',
        },
      },
    },
  ),
  async invoke(args, ctx) {
    // The board scope, exactly as in `create_mission` above: this must be the
    // same board `/missions` reads in this chat, or one conversation has two.
    const self = boardSelf(ctx);
    const owner = typeof args.owner === 'string' && args.owner ? args.owner : self;
    // THE READ GATE, asked at invoke time (Phase 8) and STATED IN `src/lib`
    // rather than here (A3-1). `canReadBoard` is ADR 0009 :93-96's
    // participation test — "an agent may read a mission iff it has a task on
    // that mission, or it is the coordinator" — as the owner instantiated it on
    // 2026-09-05: read any board in the company. The refusal it replaces read
    // another agent's board as leakage; the board IS the shared work surface,
    // and an agent that cannot see the queue it is being asked about answers
    // about the wrong one. The MUTATION half of that same ADR line stays
    // narrow, in `update_mission` below.
    //
    // THE BRANCH BELOW IS UNREACHABLE AT THIS COMMIT: the predicate answers
    // true for every pair. It is still written and still asked, because the
    // alternative is a rule that exists only as this comment — which is what it
    // was, and which is why nothing stopped a second caller from inventing its
    // own comparison. When reads tighten, the change lands in `canReadBoard`
    // and this call site does not move; it never lands in an adapter (A3-1),
    // and a chat surface cannot make the call for us (A3-12).
    if (!canReadBoard(self, owner)) {
      return {
        text: `You can only list boards you may read (owner '${self}').`,
        isError: true,
      };
    }
    const status =
      typeof args.status === 'string' && args.status
        ? (args.status as MissionStatus | 'all')
        : 'open';
    // The shared constant, not a re-typed 15: the toolSpec above advertises
    // "defaults to 15", and the number a chat `/missions` shows and the number
    // this tool shows have to move together or the spec starts lying. The test
    // that would catch a drift is `../../agent/commands.missions.test.ts`,
    // which asserts the command passes 15 — NOT `mission-toolspec.test.ts`,
    // which freezes `create_mission`'s spec only and never sees this sentence.
    const limit = Number.isFinite(args.limit) ? Number(args.limit) : MISSION_LIST_LIMIT;

    const rows =
      status === 'all'
        ? await listBoardMissions(owner, limit)
        : await listBoardMissionsByStatus(owner, status as MissionStatus, limit);
    // THE SAME BOARD IN THE SAME WORDS AS `/missions` (A3-4). This used to
    // render its own rows - `- [abc12345] p50 open | Ship the ACL`, with the
    // raw enum, a lowercase `p`, a pipe and a leading dash - so an agent asked
    // "what is on my board" answered in one vocabulary while the same user
    // typing `/missions` in the same conversation got another. `ToolResult.text`
    // is relayed to the user by the model, so it is the same audience.
    return { text: formatMissionList(rows, { owner, status }) };
  },
});

tools.register('update_mission', {
  spec: spec(
    'update_mission',
    'Transition a mission to a new status.',
    {
      type: 'object',
      required: ['mission_id', 'status'],
      properties: {
        mission_id: {
          type: 'string',
          description: 'Full id or 8-char prefix from list_missions.',
        },
        owner: {
          type: 'string',
          description:
            "Owner agent id — whose board the mission is on. Defaults to your own. You may transition a mission on another agent's board only if you opened it.",
        },
        status: {
          type: 'string',
          enum: [...MISSION_STATUSES],
          description: 'New status.',
        },
      },
    },
  ),
  async invoke(args, ctx) {
    // The board scope, exactly as in `create_mission` above: `/mission done`
    // and this tool must transition rows on the same board. It is also the
    // identity `canMutateMission` judges below, and the identity
    // `create_mission` stamped as the creator — one scope, by `boardSelf`.
    const self = boardSelf(ctx);
    const id = String(args.mission_id ?? '').trim();
    if (!id) return { text: formatMissingArgument('mission_id'), isError: true };
    const owner = typeof args.owner === 'string' && args.owner ? args.owner : self;
    const status = String(args.status ?? '') as MissionStatus;
    // `id` may be an 8-char prefix — the schema above says so and
    // `list_missions` prints one. The ACL resolves prefixes owner-scoped, the
    // same scan-and-`startsWith` the repo did; the engine itself resolves
    // neither prefixes nor `NZR-42` identifiers (C-16).
    // The ambiguous-prefix refusal is UNWRAPPED here rather than left to
    // `registry.invoke`'s generic catch, which would prefix it "Tool
    // 'update_mission' failed:" and turn a precise user-fixable answer into an
    // apparent tool fault. Both sentences come from the shared module — the
    // no-match one used to be spelled without quotes here and with quotes in
    // three other places (A3-4).
    try {
      // THE MUTATION GATE, at invoke time (Phase 8) and stated in `src/lib`
      // rather than here (A3-1): the rule itself is `canMutateMission`, ADR 0009
      // :93-96 instantiated as owner-or-creator. It is asked HERE because chat
      // surfaces carry no capability model (A3-12), so the tool is the gate.
      //
      // Naming YOUR OWN board costs no extra read. A board read is owner-scoped
      // — `mission-acl.test.ts` "a mission addressed to the WRONG owner is not
      // found" — so every row `owner === self` could resolve to already has
      // `ownerAgent === self` and already satisfies the predicate. Naming
      // ANOTHER agent's board does need the row, because only the row says who
      // created it. That row is handed on to `setBoardMissionStatus`, which
      // REUSES it on the Paperclip branch — one board read for the whole
      // mutation, not two. The legacy branch ignores it and re-scans inside the
      // repo (`mission-tasks-repo.ts:184`), so a cross-board update costs it
      // two reads; that branch is reproduced byte for byte, not optimized.
      let resolved: Mission | undefined;
      if (owner !== self) {
        resolved = await resolveBoardMission(owner, id);
        if (!resolved) return { text: formatNoMatch({ owner, ref: id }), isError: true };
        if (!canMutateMission(self, resolved)) {
          return {
            text: `You can only update missions you own or created (owner '${self}').`,
            isError: true,
          };
        }
      }
      const ok = await setBoardMissionStatus(owner, id, status, resolved);
      return ok
        ? { text: formatStatusChanged({ ref: id, status }) }
        : { text: formatNoMatch({ owner, ref: id }), isError: true };
    } catch (err) {
      if (err instanceof AmbiguousMissionPrefixError) {
        return {
          text: formatAmbiguousRef({ owner: err.owner, ref: err.prefix, ids: err.matches }),
          isError: true,
        };
      }
      throw err;
    }
  },
});
