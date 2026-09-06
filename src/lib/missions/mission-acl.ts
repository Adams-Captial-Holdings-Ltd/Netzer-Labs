/**
 * The Mission ACL — ONE anti-corruption layer, four callers.
 *
 * `/api/missions*` is not the only reader of the mission board. `jarvis.ts`
 * hand-reproduces the `{owner, count, missions}` envelope from its own
 * `listMissionsForAgent(owner, 100)`; `privacy-tools.ts` builds the GDPR
 * subject-access export from `listMissionsForAgent(agentId, 200)`; and
 * `mission-tools.ts` is what an agent turn calls. Repointing only the HTTP
 * route would leave the Missions tab, the voice co-pilot, the export and the
 * LLM tools reporting four different boards. So the swap happens HERE, once,
 * and all four import these functions.
 *
 * WHAT THIS FILE IS NOT. It is not a fallback layer. C-8: the flag picks ONE
 * WHOLE STACK. `paperclipRoutingEnabled()` is read at the top of each function
 * and selects the Paperclip path or the DynamoDB path; there is no `catch` that
 * retries the other one, and a Paperclip failure surfaces as a Paperclip
 * failure. The `paperclip_disabled` kill switch lives inside the transport
 * (`client.ts` re-checks it at every invoke) and arrives here as a
 * `PaperclipDisabledError` — which is a REFUSAL to return, never a reason to
 * read DynamoDB instead.
 *
 * THE WIRE CONTRACT DOES NOT CHANGE. `toWireMission` below is the only place a
 * `ProjectedMission` becomes a `Mission`, and it is deliberately lossy in one
 * direction: it DROPS `identifier` and `bodyTruncated`. Both are additive and
 * harmless to the SPA, but Phase 7's acceptance is envelope equality against
 * the recorded legacy response FIELD FOR FIELD, and two extra keys fail a
 * `toEqual`. `identifier` returns the day a consumer needs it and the envelope
 * test is widened deliberately, not as a side effect.
 *
 * WHAT PAPERCLIP CANNOT SUPPLY. `createdByChat` and `assignmentReason` have no
 * Paperclip source (`issueToMission` hardcodes the first and omits the other).
 * They come back off the provenance row written at create
 * time — see `src/lib/state/mission-provenance-repo.ts` for why that is a
 * compliance gate and not a nicety.
 *
 * KNOWN, DOCUMENTED LOSSES on the Paperclip path, none of them papered over:
 *   - Priority no longer quantizes: Phase 9 made the shared Mission domain use
 *     Paperclip's four exact bands.
 *   - `status` narrows, but ONLY where the narrowing is recoverable. Phase 9
 *     gave `blocked` and `in_review` their own lanes, so those two no longer
 *     collapse; what remains is `backlog` and `todo` both arriving as `open`,
 *     and that one is lossless in practice because the split they encode is
 *     "has an assignee", which `Mission.ownerAgent` carries and
 *     `toIssueStatus` reconstructs.
 *   - UNVERIFIED: what status Paperclip gives an ASSIGNED, status-omitted
 *     create. No probe has ever read `.status` off a created row, so a created
 *     mission's column is not claimed here — whatever `toMissionStatus` makes
 *     of it is what ships. Legacy always answered `'open'`.
 *   - A row assigned to an agent with no `metadata.netzarAgentId` fails
 *     projection and is logged-and-dropped by the engine's `projectOrSkip`. The
 *     board always filters by owner, so the only reachable case is an agent
 *     missing from the map.
 *   - THE BIGGEST ONE, AND IT IS A CUTOVER LOSS, NOT A PROJECTION LOSS: every
 *     mission that already exists in DynamoDB disappears from the BOARD the
 *     instant the flag flips. `listBoardMissions` reads Paperclip and only
 *     Paperclip; nothing in this phase migrates the existing rows. The Missions
 *     tab, `list_missions` and Jarvis all go as empty as Paperclip is. That is
 *     the intended meaning of "the flag picks one whole stack" and it is why
 *     the flip belongs behind a migration, but it is NOT acceptable for the
 *     GDPR subject-access export — a compliance answer may not silently shrink
 *     because an operator changed substrates. `listMissionsForExport` below is
 *     the one reader that refuses this loss, and it is deliberately the ONLY
 *     one.
 */
import { randomUUID } from 'node:crypto';
import { loadEnv } from '../../config/env.js';
import { logger } from '../../observability/logger.js';
import {
  createMission as repoCreateMission,
  listMissionsByStatus as repoListMissionsByStatus,
  listMissionsForAgent as repoListMissionsForAgent,
  reassignMission as repoReassignMission,
  updateMissionStatus as repoUpdateMissionStatus,
  type Mission,
  type MissionPriority,
  type MissionStatus,
} from '../state/mission-tasks-repo.js';
import {
  getMissionProvenance,
  putMissionProvenance,
  type MissionProvenance,
} from '../state/mission-provenance-repo.js';
import { paperclipClientFromEnvironment } from '../paperclip/client.js';
import { createPaperclipMissionEngine } from '../paperclip/paperclip-mission-engine.js';
import type { MissionEngine } from '../paperclip/mission-engine.js';
import { UnknownAgentError, type ProjectedMission } from '../paperclip/mission-projection.js';
import { MISSION_RESOLVE_WINDOW, formatAmbiguousRef, resolveMissionRef } from './format.js';

/**
 * THE ROUTER-LEVEL ROLLOUT FLAG (C-8).
 *
 * Phase 9 installs the Paperclip substrate independently of this flag. During
 * the temporary rollout window `CCE_PAPERCLIP_ENABLED` selects only which
 * mission router serves requests; unset still leaves the legacy router serving.
 * The flag is removed only in the separately gated retirement change.
 *
 * Read per call, never cached: an operator flipping a task definition gets a new
 * process anyway, and a memo here would only make tests fight each other.
 */
export function paperclipRoutingEnabled(): boolean {
  const raw = loadEnv().CCE_PAPERCLIP_ENABLED;
  return raw === '1' || raw?.toLowerCase() === 'true';
}

/** Memoized so the client's circuit breaker and agent-map cache survive across requests. */
let cachedEngine: MissionEngine | undefined;

/** Overridden by tests and by the dashboard router's dependency bag; never in production. */
let injectedEngine: MissionEngine | undefined;

export async function missionEngine(): Promise<MissionEngine> {
  if (injectedEngine) return injectedEngine;
  if (cachedEngine === undefined) {
    cachedEngine = createPaperclipMissionEngine({ client: await paperclipClientFromEnvironment() });
  }
  return cachedEngine;
}

/** Test seam. The memo above would otherwise leak a client between suites. */
export function __setMissionEngineForTest(engine: MissionEngine | undefined): void {
  injectedEngine = engine;
  cachedEngine = undefined;
}

/**
 * The ONE `ProjectedMission` → `Mission` crossing.
 *
 * Key insertion order is the legacy `toMission` order verbatim
 * (`mission-tasks-repo.ts`), because `JSON.stringify` serialises in insertion
 * order and "byte-for-byte" is the phase's defining constraint.
 *
 * `assignmentReason` is conditionally spread: the contract is an absent key on
 * absence, never `null` and never `undefined`.
 */
export function toWireMission(projected: ProjectedMission, provenance?: MissionProvenance): Mission {
  const assignmentReason = provenance?.assignmentReason;
  return {
    id: projected.id,
    ownerAgent: projected.ownerAgent,
    createdByAgent: provenance?.createdByAgent || projected.createdByAgent,
    // The C-11 restore. Without the provenance row this is the literal
    // 'paperclip' the projection hardcodes, which matches no real chat id and
    // is what would empty a GDPR export.
    createdByChat: provenance?.createdByChat || projected.createdByChat,
    title: projected.title,
    body: projected.body,
    priority: projected.priority,
    status: projected.status,
    ...(assignmentReason ? { assignmentReason } : {}),
    createdAt: projected.createdAt,
    updatedAt: projected.updatedAt,
  };
}

async function decorate(projected: readonly ProjectedMission[]): Promise<Mission[]> {
  const provenance = await getMissionProvenance(projected.map((p) => p.id));
  return projected.map((p) => toWireMission(p, provenance.get(p.id)));
}

/**
 * The board for one owner, capped the way legacy capped it — in ONE READ.
 *
 * WHY `maxPages: 1` AND A `slice`, ON EVERY CALLER OF THIS FUNCTION. Legacy was
 * `listMissionsForAgent(owner, limit)`: a single DynamoDB Query with
 * `Limit: limit`, one round trip, quietly short on a longer board. `maxPages: 1`
 * is the engine's one-page read (see `paperclip-mission-engine.ts`) and is that
 * same shape — one issue-list read bounded by `limit`, no page walk.
 *
 * THE ALTERNATIVE WAS AN AMPLIFICATION LEGACY DID NOT HAVE, and it is an A1-10
 * hazard rather than merely a slow path. The probe "A1-10 (BLOCKING): the
 * issue-list retry is a coalescer, not a rate limit, and identical reads never
 * trip it" measured a ceiling of 8 DISTINCT concurrent issue-list reads per
 * actor before `429 Too many concurrent issue-list requests for this
 * actor/client`; identical reads coalesce and are never refused. `paginateAll`
 * walks SERIALLY, so one sweep cannot exceed the ceiling by itself — but it
 * holds its one slot open for as many round trips as the board is long, and the
 * SPA's per-agent fan-out is what puts several of those in flight at once. This
 * read is the SPA's actual fan-out surface, so the walk is removed here and not
 * only on the mutation path.
 *
 * UNVERIFIED, and deliberately not claimed: how wide that fan-out actually gets.
 * No probe counts concurrent Missions-tab reads against the measured ceiling of
 * 8. What is claimed is only the part the ACL controls — one read per call,
 * whatever the board is doing — not that the dashboard can never reach 8.
 *
 * AND IT IS WHY NOTHING HERE CAN RAISE `PaperclipPaginationTruncatedError` ANY
 * MORE. A bounded walk (`maxPages: 2`) turned a board of more than `limit` rows
 * into a hard failure on EVERY read and EVERY mutation of that board, including
 * the rows well inside the legacy window that legacy answered correctly — a 503
 * on the route, an `isError` on the tool, where legacy returned 200. One page
 * cannot truncate, so that whole class is gone rather than traded.
 *
 * The `slice` stays because `limit` is a wire hint the artifact may clamp
 * upward, and the legacy cap is a promise to the caller.
 *
 * AN OWNER PAPERCLIP HAS NEVER HEARD OF IS AN EMPTY BOARD, NOT AN ERROR — and
 * getting this wrong is the sharpest way to break the wire contract from the
 * inside. `engine.listMissions` resolves `ownerAgent` through
 * `toUuidOrThrow(...)` BEFORE it touches the wire, so a slug that Netzar's
 * `listKnownAgents()` returns but Paperclip's `metadata.netzarAgentId` map does
 * not carry — a newly added agent, a bootstrap that has not run, or merely the
 * agent-map cache not yet expired — throws `UnknownAgentError` on what is only a
 * SCOPING parameter. Legacy scoped with a DynamoDB partition key: an owner with
 * no partition was `{count: 0}`, never a failure. Two different legacy answers
 * ride on that, and both come back for free by answering with an empty board
 * here: R1 returns `200 {owner, count:0, missions:[]}`, and `resolveBoardMission` finds
 * nothing, so R3/R4 return the legacy `404 {error:'not_found', owner, id}`.
 *
 * The catch is narrowed to `err.slug === ownerAgent` so it can only ever swallow
 * THIS argument's resolution. It is not a general `UnknownAgentError` amnesty:
 * the same class thrown for an ASSIGNMENT TARGET (`createMission`,
 * `reassign(id, newOwner)`) names a different slug, propagates, and reaches the
 * caller as the legacy `400 unknown_agent` — because a target Paperclip cannot
 * assign to is a real, reportable failure, where a scope it cannot resolve is
 * just an empty result. A row whose ASSIGNEE is outside the map cannot reach
 * here at all: `projectOrSkip` rethrows only `PaperclipError`, so it logs and
 * drops that one inside the engine.
 */
export async function listBoardMissions(ownerAgent: string, limit = 100): Promise<Mission[]> {
  if (!paperclipRoutingEnabled()) return repoListMissionsForAgent(ownerAgent, limit);
  const engine = await missionEngine();
  // Always scoped by owner. Unassigned rows and rows assigned outside the agent
  // map fail projection and are dropped by the engine; passing an owner turns
  // that client-side drop into a server-side filter, and no caller here ever
  // asks for the unassigned set.
  let projected: readonly ProjectedMission[];
  try {
    projected = await engine.listMissions({ ownerAgent, limit, maxPages: 1 });
  } catch (err) {
    if (!(err instanceof UnknownAgentError) || err.slug !== ownerAgent) throw err;
    logger.info(
      { ownerAgent, knownSlugs: err.knownSlugs },
      'mission board scoped to an owner Paperclip does not map; answering empty, as the legacy partition did',
    );
    return [];
  }
  return decorate(projected.slice(0, limit));
}

/**
 * `list_missions`' status filter, which the engine deliberately does NOT offer:
 * the domain `open` still fans out to `backlog|todo` (Phase 9 took `blocked`
 * out of that fan, but not the other two), the wire filter is proven for a
 * single value only, and an unrecognized status is a silent `200 []` rather
 * than a 400. Filtering client-side off rows we already hold loses nothing and
 * claims nothing.
 *
 * The fetch is widened before the filter so a status with few matches on a busy
 * board still fills `limit`.
 */
export async function listBoardMissionsByStatus(
  ownerAgent: string,
  status: MissionStatus,
  limit = 25,
): Promise<Mission[]> {
  if (!paperclipRoutingEnabled()) return repoListMissionsByStatus(ownerAgent, status, limit);
  const rows = await listBoardMissions(ownerAgent, Math.max(limit, 100));
  return rows.filter((m) => m.status === status).slice(0, limit);
}

/**
 * THE GDPR READ, AND THE ONE PLACE THAT READS BOTH SUBSTRATES.
 *
 * `listBoardMissions` reads Paperclip and only Paperclip once the flag is on,
 * which is correct for a BOARD — an operator who switched substrates is asking
 * to see the new one. It is wrong for a SUBJECT-ACCESS EXPORT. A person
 * exercising a right of access is owed every mission they opened, and "the
 * operator changed backends last Tuesday" is not a lawful reason to return a
 * shorter list. Without this function the flag flip empties the export of every
 * pre-cutover mission: no error, no log, no test — the same silent shape as the
 * `createdByChat` hole the provenance row closes, arriving through a different
 * door.
 *
 * WHY THIS IS NOT THE PER-REQUEST FALLBACK C-8 FORBIDS. A fallback is
 * conditional and failure-driven: try A, and if A fails or comes back thin,
 * quietly serve B instead. This is neither. Both reads ALWAYS run, on every
 * call, in parallel, and the result is their union — the composition never
 * varies and never depends on an outcome. Nothing here inspects an error to
 * decide where to read, because nothing here catches one:
 *
 *   `Promise.all` means a Paperclip failure REJECTS THE WHOLE EXPORT. That is
 *   the point. Returning the DynamoDB half of a subject-access response, shaped
 *   exactly like a complete one, is the worst available outcome — strictly
 *   worse than an error the caller can retry. Loud beats short here for the
 *   same reason it beats short on a truncated board sweep.
 *
 * DEDUPE IS BY `id` AND IS DELIBERATELY INCOMPLETE. If a future migration
 * copies rows into Paperclip while preserving ids, this is exact. If it re-mints
 * ids — which the create path does, since the wire id is the Paperclip issue
 * uuid and not the seed — a migrated mission appears twice. A duplicate of the
 * subject's own record in the subject's own export is a cosmetic flaw; an
 * omission is a compliance breach. The asymmetry is chosen, not overlooked.
 *
 * This is a MIGRATION-WINDOW read. It stops being needed the day no
 * pre-cutover rows remain, and deleting it then is a one-line change.
 */
export async function listMissionsForExport(agentId: string, limit = 200): Promise<Mission[]> {
  if (!paperclipRoutingEnabled()) return repoListMissionsForAgent(agentId, limit);
  const [board, preCutover] = await Promise.all([
    listBoardMissions(agentId, limit),
    repoListMissionsForAgent(agentId, limit),
  ]);
  const onBoard = new Set(board.map((m) => m.id));
  return [...board, ...preCutover.filter((m) => !onBoard.has(m.id))];
}

export interface CreateBoardMissionArgs {
  ownerAgent: string;
  createdByAgent: string;
  createdByChat: string;
  title: string;
  body: string;
  priority?: MissionPriority;
  assignmentReason?: string;
}

/**
 * Create, with the provenance row written in the same call.
 *
 * The minted uuid is NOT the returned mission's id. It is the idempotency-key
 * seed the engine derives `netzar-mission:<uuid>` from (A1-13 proved the
 * `{idempotencyKey, allowDuplicate:true}` pair replays to the SAME issue), and
 * it is deterministic per attempt rather than random per retry. The id on the
 * wire is the Paperclip issue uuid the projection returns, which is what the
 * provenance row is keyed on.
 *
 * THE TWO WRITES ARE NOT ATOMIC, AND THE SECOND ONE FAILING IS A COMPLIANCE
 * EVENT, SO IT IS COMPENSATED RATHER THAN LOGGED AND FORGOTTEN. Paperclip has
 * nowhere to put `createdByChat`, so the provenance row is the ONLY thing that
 * makes this mission visible to its own subject's GDPR export
 * (`privacy-tools.ts` selects on `createdByChat === chatId`). If the issue lands
 * and the row does not, the naive outcome is the exact silent shape C-11 exists
 * to close, re-entered through a different door: a live mission on the board
 * that no subject-access request can ever see.
 *
 * The row cannot be written first — it is keyed on the issue uuid, which does
 * not exist until the create returns — and it cannot be retried into existence
 * on the next request, because the seed is minted per attempt, so a retry mints
 * a NEW idempotency key and a SECOND issue. So the create is UNWOUND: the issue
 * is cancelled, best effort, and the original failure is rethrown. The caller
 * gets a 500 and retries into a clean create.
 *
 * A cancelled-and-recreated mission is a worse outcome than a successful one and
 * a better one than an invisible one. If the compensation ALSO fails, the whole
 * provenance payload is logged at error so the row is replayable by hand — that
 * is the floor, not the plan.
 */
export async function createBoardMission(args: CreateBoardMissionArgs): Promise<Mission> {
  if (!paperclipRoutingEnabled()) return repoCreateMission(args);
  const engine = await missionEngine();
  const now = new Date().toISOString();
  const seed: Mission = {
    id: randomUUID(),
    ownerAgent: args.ownerAgent,
    createdByAgent: args.createdByAgent,
    createdByChat: args.createdByChat,
    title: args.title,
    body: args.body,
    priority: args.priority ?? 'medium',
    status: 'open',
    ...(args.assignmentReason ? { assignmentReason: args.assignmentReason } : {}),
    createdAt: now,
    updatedAt: now,
  };
  const projected = await engine.createMission(seed);
  const provenance: MissionProvenance = {
    missionId: projected.id,
    createdByChat: args.createdByChat,
    createdByAgent: args.createdByAgent,
    ...(args.assignmentReason ? { assignmentReason: args.assignmentReason } : {}),
  };
  try {
    await putMissionProvenance(provenance);
  } catch (err) {
    try {
      await engine.setStatus(projected.id, 'cancelled');
      logger.error(
        { missionId: projected.id, err: err instanceof Error ? err.message : String(err) },
        'mission provenance write failed; the issue was cancelled to avoid a mission invisible to its subject export',
      );
    } catch (cancelErr) {
      logger.error(
        {
          provenance,
          err: err instanceof Error ? err.message : String(err),
          cancelErr: cancelErr instanceof Error ? cancelErr.message : String(cancelErr),
        },
        'mission provenance write failed AND the compensating cancel failed; replay this provenance row by hand',
      );
    }
    throw err;
  }
  return toWireMission(projected, provenance);
}

/**
 * Resolve `:owner` + an id-or-8-char-prefix to a row, EXACTLY as the repo does.
 *
 * Two legacy behaviours ride on this and both are contract:
 *   1. OWNER SCOPING. `updateMissionStatus`/`reassignMission` look inside
 *      `AGENT#<owner>`; a mismatched owner is a 404. `engine.setStatus` and
 *      `engine.reassign` take a bare issue id and are owner-BLIND, so without
 *      this lookup the ACL would happily mutate a mission the caller addressed
 *      to the wrong owner.
 *   2. PREFIX MATCH. `update_mission`'s schema advertises "Full id or 8-char
 *      prefix from list_missions" and `list_missions` prints `id.slice(0, 8)`,
 *      so every LLM call passes a prefix. The engine resolves neither prefixes
 *      nor `NZR-42` identifiers (C-16), so the resolution happens here — the
 *      same 200-row scan-and-find the repo already performs.
 *
 * AND IT IS THE SAME WINDOW, READ THE SAME NUMBER OF TIMES. Legacy resolved
 * inside ONE `listMissionsForAgent(owner, 200)` — a single `Limit: 200` Query,
 * one round trip. `listBoardMissions` is now that same one-read shape (see its
 * comment and the A1-10 ceiling it cites), so a mutation costs exactly ONE
 * issue-list read regardless of how long the owner's board is, which is the
 * amplification legacy did not have and this must not introduce.
 *
 * ON A BOARD OF MORE THAN 200 ROWS FOR ONE OWNER, stated plainly because an
 * earlier bound got this wrong: this reads a `RESOLVE_WINDOW`-row window and
 * answers with the SAME TWO OUTCOMES legacy had — found means mutate, not found
 * means the legacy `404 {error:'not_found', owner, id}`. What it must never do
 * again is invent a THIRD outcome. A bounded page WALK did exactly that: a board
 * of 201 rows raised `PaperclipPaginationTruncatedError` for every mutation on
 * it, including rows 1-200, which legacy mutated and answered 200. A one-page
 * read cannot truncate, so that outcome no longer exists.
 *
 * NOT CLAIMED, because it is not true: that the two windows hold the SAME 200
 * rows. Legacy's window was the first 200 by DynamoDB sort key; this one is the
 * first 200 of a `sortField: 'updated'` list this file claims no ordering for
 * (see `listMissions`' own UNVERIFIED note). On a board longer than the window
 * the two substrates can therefore miss different rows. That is a cutover
 * difference of the same family as the empty-board note at the top of this file,
 * and it is a property of migrating substrates — not something the bound
 * introduces, and not something it can fix.
 */
/**
 * AND THE WINDOW IS NOW ONE NUMBER FOR EVERY CONSUMER. It used to be a private
 * `200` here, a `15` in the chat router's `/mission <ref>` read and a `100` in
 * `paperclip_comment` — the same 8 characters resolved against three different
 * boards. `MISSION_RESOLVE_WINDOW` and `resolveMissionRef` live in the pure
 * shared module beside the copy, per A3-4 ("every user-visible string AND
 * NUMBERING RULE"), and this file is one of their three callers.
 */
const RESOLVE_WINDOW = MISSION_RESOLVE_WINDOW;

/**
 * C-16, the half of it the engine cannot do: an 8-char prefix that matches TWO
 * missions.
 *
 * `list_missions` prints `id.slice(0, 8)` and `update_mission`'s schema
 * advertises that prefix as an input, so the collision is reachable from a model
 * turn with no misuse at all — 8 hex chars over one owner's board.
 *
 * THIS IS NOT A NEW ERROR SHAPE ON THE WIRE. It is a plain `Error`, deliberately
 * NOT a `PaperclipError`, so `paperclipFailure` leaves it alone and it lands on
 * the rungs that already exist for a thrown mutation: `500
 * {error:'internal_error'}` on `/api/missions*` — the identical rung a DynamoDB
 * throw took on the legacy stack — and `{text: "Tool 'update_mission' failed:
 * …", isError: true}` from the tool registry's own catch. No response body that
 * a consumer can produce today changes shape.
 *
 * AND THE CASE IT NEWLY REACHES COULD NOT PREVIOUSLY SUCCEED CORRECTLY. The old
 * `find(m => m.id === missionId || m.id.startsWith(missionId))` returned the
 * FIRST row in a sweep this file explicitly claims no ordering for, so an
 * ambiguous prefix silently cancelled or reassigned THE WRONG MISSION. Refusing
 * is a fix, not a contract break: there was no correct answer to preserve.
 *
 * Every prefix that is unambiguous today resolves to exactly the same row, by
 * exactly the same `startsWith`, and stays byte-identical.
 */
export class AmbiguousMissionPrefixError extends Error {
  constructor(
    readonly owner: string,
    readonly prefix: string,
    readonly matches: readonly string[],
  ) {
    // The MESSAGE is the shared module's, not a fifth spelling of it (A3-4).
    // This error crosses into chat as a caught `Error.message` wherever a
    // caller does not unwrap it, so the sentence a user sees must be the same
    // one the chat router prints when it DOES unwrap it.
    super(formatAmbiguousRef({ owner, ref: prefix, ids: matches }));
    this.name = 'AmbiguousMissionPrefixError';
  }
}

export async function resolveBoardMission(
  owner: string,
  missionId: string,
): Promise<Mission | undefined> {
  const rows = await listBoardMissions(owner, RESOLVE_WINDOW);
  // The matching itself is `resolveMissionRef` in the shared module — the same
  // function the chat router and `paperclip_comment` call, so a ref means one
  // thing everywhere it is typed back. It holds the exact-id-wins rule (legacy's
  // single `find` tested both arms per row, so a full id could lose to an
  // earlier row that merely shared its prefix) and reports the collision; the
  // ERROR SHAPE stays here, because `AmbiguousMissionPrefixError` is this
  // layer's contract with the routes and the pure module does no throwing.
  const match = resolveMissionRef(rows, missionId);
  if (match.kind === 'ambiguous') {
    throw new AmbiguousMissionPrefixError(owner, missionId, match.matches.map((m) => m.id));
  }
  return match.kind === 'found' ? match.mission : undefined;
}

/**
 * WHO MAY MUTATE A MISSION — ADR 0009 :93-96, stated in ONE place (A3-1).
 *
 * The ADR: "it may write a task iff that task is assigned to it, or it is the
 * coordinator." The owner's 2026-09-05 decision instantiates that for Netzar as
 * OWNER-OR-CREATOR — otherwise `main` can open a mission for `research` and then
 * be unable to cancel the delegation it just made. It is deliberately narrower
 * than the ADR's end state: "or whose parent it owns" needs `parentId` on the
 * wire and lands in P1-3, and THIS FUNCTION is the only place that widening has
 * to happen.
 *
 * READS are not scoped by it. The same ADR line scopes reads by PARTICIPATION,
 * which for a single-company deployment is every board; that half is
 * `canReadBoard` below, and `list_missions` asks that one, not this one.
 *
 * Placed beside the resolver because the row it judges is the row the resolver
 * returns: a caller learns the creator by resolving, then asks this.
 *
 * The empty-actor guard is not decoration. Legacy rows coerce a missing
 * `createdByAgent` to `''` (`mission-tasks-repo.ts:259`) and an actor is a
 * string by type only, so without it `'' === ''` would authorize a mutation.
 */
export function canMutateMission(
  actor: string,
  mission: { ownerAgent?: string; createdByAgent?: string },
): boolean {
  if (!actor) return false;
  return mission.ownerAgent === actor || mission.createdByAgent === actor;
}

/**
 * WHO MAY READ A BOARD — the OTHER half of ADR 0009 :93-96, stated once (A3-1).
 *
 * The ADR: "an agent may read a mission iff it has a task on that mission, or
 * it is the coordinator." The owner's 2026-09-05 decision instantiates that
 * participation test for a single-company Netzar deployment as READ ANY BOARD —
 * every agent in the company is a participant in the company's work, and an
 * agent that cannot see the queue it is being asked about answers about the
 * wrong one.
 *
 * SO IT IS CONSTANT-TRUE AT THIS COMMIT, and the refusal branch guarding it in
 * `list_missions` is unreachable. It is a function anyway because a rule with
 * no address is a rule that gets restated: the read half lived only in a
 * comment, and the next caller that wanted it would have written its own
 * comparison in its own file. Tightening it — per-mission participation, or a
 * real company boundary once there is more than one company — is an edit HERE,
 * and can never be an edit in an adapter.
 *
 * The parameters are underscored because `noUnusedParameters` is on and this
 * rule does not consult its arguments yet. They are named for what the
 * tightened rule needs, so widening it adds no call site: every caller already
 * passes both.
 */
export function canReadBoard(_actor: string, _owner: string): boolean {
  return true;
}

/**
 * `false` means "no mission matches for this owner" — the legacy 404 signal,
 * unchanged.
 *
 * `resolved` is the row a caller ALREADY resolved off this same board with
 * `resolveBoardMission(ownerAgent, missionId)`. `mission-tools.ts` has to
 * resolve before it can apply `canMutateMission` — the creator is only knowable
 * from the row — so handing that row back keeps an authorized cross-board
 * update at ONE board read instead of two ON THE PAPERCLIP BRANCH ONLY. The
 * legacy branch below ignores it and returns first: `repoUpdateMissionStatus`
 * re-scans the board itself (`mission-tasks-repo.ts:184`), and reproducing
 * legacy byte for byte matters more here than saving it a read. Omitted,
 * both branches behave exactly as they did before.
 */
export async function setBoardMissionStatus(
  ownerAgent: string,
  missionId: string,
  status: MissionStatus,
  resolved?: Mission,
): Promise<boolean> {
  if (!paperclipRoutingEnabled()) return repoUpdateMissionStatus(ownerAgent, missionId, status);
  const target = resolved ?? (await resolveBoardMission(ownerAgent, missionId));
  if (!target) return false;
  const engine = await missionEngine();
  await engine.setStatus(target.id, status);
  return true;
}

/** `null` means "no mission matches for this owner" — the legacy 404 signal, unchanged. */
export async function reassignBoardMission(
  currentOwner: string,
  missionId: string,
  newOwner: string,
): Promise<Mission | null> {
  if (!paperclipRoutingEnabled()) return repoReassignMission(currentOwner, missionId, newOwner);
  const target = await resolveBoardMission(currentOwner, missionId);
  if (!target) return null;
  // Legacy short-circuits a no-op reassign and returns the row UNMODIFIED — no
  // write, `updatedAt` untouched — still a 200. Reproduced rather than
  // rediscovered, because a PATCH here would move `updatedAt` and break the
  // watermark the reconciler reads.
  if (newOwner === currentOwner) return target;
  const engine = await missionEngine();
  const projected = await engine.reassign(target.id, newOwner);
  const provenance = await getMissionProvenance([projected.id]);
  return toWireMission(projected, provenance.get(projected.id));
}
