import { Hono } from 'hono';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import {
  createMeeting,
  getMeeting,
  endMeeting,
  addParticipant,
  removeParticipant,
  listMyMeetings,
  deleteMeeting,
} from '../../lib/warroom/meetings-repo.js';
import { publishTurn, getHistory } from '../../lib/warroom/publisher.js';
import { getChannel, removeChannel } from '../../lib/warroom/events.js';
import { haltWarroomOnKillPhrase } from '../../lib/warroom/kill-phrase.js';
import { orchestrateWarroomTurn } from '../../lib/warroom/orchestrator.js';
import { isKillSwitchActive } from '../../lib/state/kill-switches-repo.js';
import { writeAudit } from '../../lib/audit/audit-writer.js';
import {
  authenticateDashboardToken,
  extractBearerToken,
  principalHasCapability,
  profileIdForPrincipal,
  type TokenPrincipal,
} from '../../lib/auth/dashboard-auth.js';
import { isCapability, isTemplatedProfileId, type CustomProfile } from '../../lib/auth/permissions.js';
import { ddb } from '../../lib/state/ddb.js';

const TABLE_USERS = process.env.TABLE_USERS ?? 'claudeclaw-users';

/**
 * Read a custom profile def row (PROFILE_DEF#<id> / DEF) so the capability gate
 * can resolve a non-templated profile. Mirrors the handler's reader (same
 * single-table key + defensive capability filter so a garbage stored string can
 * never widen a grant). Returns null when missing/unreadable (fail closed). */
async function readCustomProfile(profileId: string): Promise<CustomProfile | null> {
  try {
    const out = await ddb().send(
      new GetCommand({
        TableName: TABLE_USERS,
        Key: { PK: `PROFILE_DEF#${profileId}`, SK: 'DEF' },
      }),
    );
    const item = out.Item;
    if (!item || !Array.isArray(item.capabilities)) return null;
    return {
      profileId,
      label: typeof item.label === 'string' ? item.label : profileId,
      capabilities: (item.capabilities as unknown[]).filter(isCapability),
      createdBy: typeof item.createdBy === 'string' ? item.createdBy : '',
      createdAt: typeof item.createdAt === 'string' ? item.createdAt : '',
      ...(typeof item.updatedAt === 'string' ? { updatedAt: item.updatedAt } : {}),
    };
  } catch {
    // Fail closed: an unreadable def yields no custom caps, so a custom profile
    // that should grant the cap is denied rather than the request opening up.
    return null;
  }
}

/**
 * War Room read gate (Wave 5 granular RBAC): the principal must hold
 * warroom:read. The env break-glass token resolves to owner (all capabilities)
 * via the lib helper, so recovery is never blocked. Templated viewer+ hold
 * warroom:read in-memory; a custom profile is resolved through its stored def.
 */
async function hasWarroomRead(p: TokenPrincipal): Promise<boolean> {
  const profileId = profileIdForPrincipal(p);
  // Env root (owner) + templated ids resolve with no storage read.
  if (p.label === 'Root token' || profileId === 'owner' || isTemplatedProfileId(profileId)) {
    return principalHasCapability(p, 'warroom:read');
  }
  const custom = await readCustomProfile(profileId);
  return principalHasCapability(p, 'warroom:read', custom);
}

/**
 * War Room WRITE gate. War Room mutations (create / turn / participants / end)
 * orchestrate agents, so they require agents:write — the operator-tier "routine
 * mutations" capability. Mirrors hasWarroomRead exactly: the env break-glass
 * token resolves to owner (all capabilities), templated ids resolve in-memory,
 * and a custom profile is resolved through its stored def (fail closed when the
 * def is missing/unreadable).
 */
async function hasWarroomWrite(p: TokenPrincipal): Promise<boolean> {
  const profileId = profileIdForPrincipal(p);
  // Env root (owner) + templated ids resolve with no storage read.
  if (p.label === 'Root token' || profileId === 'owner' || isTemplatedProfileId(profileId)) {
    return principalHasCapability(p, 'agents:write');
  }
  const custom = await readCustomProfile(profileId);
  return principalHasCapability(p, 'agents:write', custom);
}

export function buildWarroomRouter(): Hono<{ Variables: { principal: TokenPrincipal } }> {
  const router = new Hono<{ Variables: { principal: TokenPrincipal } }>();

  router.use('*', async (c, next) => {
    const raw = extractBearerToken(c.req.header('authorization'), c.req.query('token'));
    const principal = await authenticateDashboardToken(raw);
    if (!principal) return c.json({ error: 'unauthorized' }, 401);
    const disabled = await isKillSwitchActive('warroom_disabled').catch(() => ({ active: false }));
    if (disabled.active) return c.json({ error: 'war room disabled' }, 503);
    // Every War Room READ (GET) requires warroom:read. War Room MUTATIONS
    // (create/turn/participants/end) require agents:write — enforced per-route
    // below via hasWarroomWrite (they orchestrate agents, so the operator-tier
    // "routine mutations" cap applies). The principal is set for all methods so
    // those per-route write gates can resolve it.
    if (c.req.method === 'GET' && !(await hasWarroomRead(principal))) {
      return c.json({ error: 'forbidden', requiredCapability: 'warroom:read' }, 403);
    }
    c.set('principal', principal);
    await next();
  });

  router.post('/', async (c) => {
    if (!(await hasWarroomWrite(c.get('principal')))) {
      return c.json({ error: 'forbidden', requiredCapability: 'agents:write' }, 403);
    }
    const body = await c.req.json<{
      title?: string;
      createdBy?: string;
      participants?: string[];
      toolPolicyOverride?: Record<string, boolean>;
      importMemoriesFrom?: string[];
    }>();
    const meeting = await createMeeting({
      createdBy: body.createdBy ?? 'dashboard',
      // Default an empty/whitespace topic so inert "Untitled" rooms can't slip
      // through (?? only catches undefined, not '').
      title: body.title?.trim() || 'War Room',
      participants: body.participants ?? [],
      toolPolicyOverride: body.toolPolicyOverride,
      importMemoriesFrom: body.importMemoriesFrom,
    });
    return c.json(meeting, 201);
  });

  router.get('/', async (c) => {
    const userId = c.req.query('mine') ?? 'dashboard';
    const meetings = await listMyMeetings(userId);
    return c.json({ meetings });
  });

  router.get('/:id', async (c) => {
    const meeting = await getMeeting(c.req.param('id'));
    if (!meeting) return c.json({ error: 'not found' }, 404);
    return c.json(meeting);
  });

  router.get('/:id/history', async (c) => {
    const meetingId = c.req.param('id');
    const meeting = await getMeeting(meetingId);
    if (!meeting) return c.json({ error: 'not found' }, 404);
    const sinceSeq = Number(c.req.query('sinceSeq') ?? '0');
    const turns = await getHistory(meetingId, sinceSeq);
    return c.json({ turns });
  });

  router.post('/:id/turn', async (c) => {
    if (!(await hasWarroomWrite(c.get('principal')))) {
      return c.json({ error: 'forbidden', requiredCapability: 'agents:write' }, 403);
    }
    const meetingId = c.req.param('id');
    const meeting = await getMeeting(meetingId);
    if (!meeting) return c.json({ error: 'not found' }, 404);
    if (meeting.status !== 'active') return c.json({ error: 'meeting ended' }, 409);

    const body = await c.req.json<{ speaker?: string; content?: string }>();
    if (!body.content) return c.json({ error: 'content required' }, 400);

    // A person is typing into a live room, so the emergency kill phrase must
    // work here exactly as it does in dashboard chat. Checked on the RAW
    // message, before publishTurn — the orchestrator only ever sees an
    // assembled transcript. Shared with the Telegram entry point so the two
    // cannot drift; see src/lib/warroom/kill-phrase.ts. The confirmation also
    // rides the meeting channel as a system_note, which is what the transcript
    // renders; this body is for non-SSE clients.
    const halt = await haltWarroomOnKillPhrase({
      meetingId,
      rawText: body.content,
      surface: 'dashboard',
    });
    if (halt) return c.json({ halted: true, text: halt });

    const turn = await publishTurn(
      meetingId,
      body.speaker ?? 'dashboard',
      'user',
      body.content,
    );

    const channel = getChannel(meetingId);
    channel.emit({
      type: 'turn_start',
      turnId: String(turn.seq),
      speaker: turn.speaker,
      content: turn.content,
      ts: turn.ts,
    });

    void writeAudit({
      action: 'warroom_turn',
      detail: { meetingId, seq: turn.seq, speaker: turn.speaker },
      result: 'ok',
    });

    // Fan the user turn out to the participant agents. Fire-and-forget: the
    // agent replies stream back to the client over the SSE channel, so we
    // return the user turn immediately rather than blocking on Bedrock. The
    // orchestrator never throws (it surfaces failures as system_note turns).
    void orchestrateWarroomTurn({ meetingId, userTurnSeq: turn.seq, userText: turn.content });

    return c.json(turn);
  });

  router.get('/:id/stream', async (c) => {
    const meetingId = c.req.param('id');
    const meeting = await getMeeting(meetingId);
    if (!meeting) return c.json({ error: 'not found' }, 404);

    const channel = getChannel(meetingId);

    // Resume cursor — ALWAYS the channel's in-memory EVENT seq (the same counter
    // channel.since() / channel.latestSeq operate on, and the same value we emit
    // as each SSE `id:`). It is NOT the persisted TURN seq used by /history.
    // Precedence:
    //   1. Last-Event-ID header — the browser auto-sends the last `id:` it saw
    //      (an event seq) when EventSource transparently reconnects after a drop.
    //   2. ?cursor= — an explicit event-seq cursor (e.g. for non-browser clients).
    //   3. ?sinceSeq= — legacy event-seq param (the static warroom.html passes
    //      sinceSeq=0 to replay the whole buffer); honoured for back-compat.
    //   4. No cursor at all — a fresh open: start from the current tip so we
    //      stream only NEW events. The transcript's past is loaded via /history
    //      (turn seq), so replaying the whole event buffer here would re-stream
    //      stale partial chunks on top of already-loaded history.
    const headerId = c.req.header('last-event-id');
    const cursorQ = c.req.query('cursor');
    const sinceQ = c.req.query('sinceSeq');
    let resumeFrom: number;
    if (headerId !== undefined && headerId !== '' && Number.isFinite(Number(headerId))) {
      resumeFrom = Number(headerId);
    } else if (cursorQ !== undefined && Number.isFinite(Number(cursorQ))) {
      resumeFrom = Number(cursorQ);
    } else if (sinceQ !== undefined && Number.isFinite(Number(sinceQ))) {
      resumeFrom = Number(sinceQ);
    } else {
      // Fresh open with no cursor: only deliver events after the current tip.
      resumeFrom = channel.latestSeq;
    }

    const body = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const send = (data: string, id: string) => {
          try { controller.enqueue(enc.encode(`id: ${id}\ndata: ${data}\n\n`)); } catch {}
        };

        for (const entry of channel.since(resumeFrom)) {
          send(JSON.stringify(entry.event), String(entry.seq));
        }

        const unsub = channel.subscribe((entry) => {
          send(JSON.stringify(entry.event), String(entry.seq));
        });

        const ping = setInterval(() => {
          send(JSON.stringify({ type: 'ping' }), String(channel.latestSeq));
        }, 15_000);

        c.req.raw.signal.addEventListener('abort', () => {
          clearInterval(ping);
          unsub();
          try { controller.close(); } catch {}
        });
      },
    });

    return new Response(body, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  });

  router.post('/:id/participants', async (c) => {
    if (!(await hasWarroomWrite(c.get('principal')))) {
      return c.json({ error: 'forbidden', requiredCapability: 'agents:write' }, 403);
    }
    const meetingId = c.req.param('id');
    const body = await c.req.json<{ action?: 'add' | 'remove'; userId?: string }>();
    if (!body.userId) return c.json({ error: 'userId required' }, 400);

    if (body.action === 'remove') {
      const version = await removeParticipant(meetingId, body.userId);
      void writeAudit({
        action: 'warroom_participant_revoked',
        detail: { meetingId, userId: body.userId, version },
        result: 'ok',
      });
      return c.json({ membershipVersion: version });
    }

    const version = await addParticipant(meetingId, body.userId);
    return c.json({ membershipVersion: version });
  });

  router.post('/:id/end', async (c) => {
    if (!(await hasWarroomWrite(c.get('principal')))) {
      return c.json({ error: 'forbidden', requiredCapability: 'agents:write' }, 403);
    }
    const meetingId = c.req.param('id');
    await endMeeting(meetingId);
    const channel = getChannel(meetingId);
    channel.emit({ type: 'meeting_ended', meetingId });
    return c.json({ status: 'ended' });
  });

  // Permanently remove a room and its transcript. Gated agents:write (it mutates
  // durable state). Idempotent — deleting a gone room still 200s — so the UI can
  // optimistically drop the row. We also evict the in-memory channel so any
  // lingering SSE subscriber stops and the seq counter can't be reused.
  router.delete('/:id', async (c) => {
    if (!(await hasWarroomWrite(c.get('principal')))) {
      return c.json({ error: 'forbidden', requiredCapability: 'agents:write' }, 403);
    }
    const meetingId = c.req.param('id');
    await deleteMeeting(meetingId);
    removeChannel(meetingId);
    void writeAudit({
      action: 'warroom_deleted',
      detail: { meetingId },
      result: 'ok',
    });
    return c.json({ status: 'deleted' });
  });

  return router;
}
