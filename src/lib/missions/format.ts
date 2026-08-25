/**
 * THE MISSION CHAT VOCABULARY — the one place a mission becomes words a person
 * reads, on every surface.
 *
 * WHY THIS FILE IS IN `src/lib/` (CLAUDE.md, "chat surface parity"). Missions
 * were dashboard-only: the kanban board at `web/src/pages/Missions.tsx` owned
 * every noun ("Open", "In Progress", "High priority") and no chat surface could
 * speak them. Putting the copy here — beside `src/lib/media/process.ts` and
 * `src/lib/tools/humanize.ts`, never in an adapter — is what makes the four
 * chat code paths render the SAME sentence by construction rather than by
 * three people remembering to. Same shape as `toolStepSuffix`: the doc comment
 * is longer than the body, on purpose.
 *
 * ── THE CONTRACT, normative enough to implement a FOURTH surface from ───────
 *
 * WHEN IT IS CALLED, AND BY WHOM. There are exactly two producers and both are
 * surface-agnostic:
 *
 *   1. THE COMMAND HALF. `missionCommand()` in `src/agent/commands.ts` — and
 *      nowhere else — turns `/missions`, `/mission …` into a finished string
 *      and hands it back as `CommandResult.reply`. A FOURTH SURFACE CALLS
 *      NOTHING IN THIS FILE to get it: every chat entry point already runs
 *      `const cmd = await runCommand(agentId, chatId, text)` before the agent
 *      turn and posts `cmd.reply` verbatim when it is non-null. Render that one
 *      string through whatever pass your surface already gives agent prose and
 *      the command half is done — there is no mission-specific translation
 *      step. That is a claim about STRUCTURE, not about bytes: the templates
 *      here contribute no markup and no line ever starts with one, so no
 *      renderer reflows them, but a renderer that turns a backtick into
 *      `<code>` (all three of ours do) is doing exactly what these strings
 *      want. It is NOT done with length: the bound below is on SOURCE
 *      characters, and a surface
 *      whose API measures something else (Telegram measures the HTML render)
 *      must bound on what IT measures. See "WHAT THE BOUND IS NOT".
 *
 *      AND IF YOUR SURFACE HAS MORE THAN ONE BOT IDENTITY, pass the fourth
 *      argument: `runCommand`'s first argument is the SESSION scope (the agent
 *      whose history and records this conversation uses — the same id you pass
 *      to `getSession`/`appendTurns`), while `{ boardAgentId }` names WHOSE
 *      BOARD `/missions` and `/mission` address, which on a per-agent bot is
 *      the bot, not the session. Conflating them is not cosmetic in either
 *      direction: scoping the board on the session put missions on the wrong
 *      agent's board, and scoping the session on the bot made `/newchat` clear
 *      a row nothing reads. A surface with ONE identity omits the argument and
 *      the two coincide, which is why Slack's per-agent apps and the dashboard
 *      pass nothing.
 *
 *   2. THE PUSH HALF. `formatAssignmentPush` is produced by `create_mission` in
 *      `src/lib/tools/mission-tools.ts` — and nowhere else — and delivered by
 *      `deliverToReplyChat` in `src/lib/scheduler/delivery.ts`. THIS HALF IS
 *      THE ONE A FOURTH SURFACE MUST ACTUALLY WIRE, and it is three things:
 *        (a) pass `replyChatId` on your `AgentTurnRequest` — the agent loop
 *            threads it into `ToolContext` and the tool reads it from there;
 *        (b) add a branch for your id's prefix to `deliverToReplyChat`, whose
 *            routing is prefix-based and whose default is Telegram;
 *        (c) IF YOUR SURFACE HAS MORE THAN ONE BOT IDENTITY, put the identity
 *            IN THE ID. BOTH of the surfaces here do, and each carries it in
 *            one marked segment the older parsers skip:
 *              - Slack has TWO send paths (CLAUDE.md says so in bold) posting
 *                as different apps, so the per-agent path emits
 *                `slack:<channel>:app-<agentId>[:<threadTs>]` and the delivery
 *                layer resolves that app's own token; the main bot emits no
 *                `app-` segment and keeps the workspace token.
 *              - Telegram has ONE BOT PER AGENT (`/tg/:agentId/webhook`), so
 *                its handler emits `<chatId>:bot-<agentId>` and the delivery
 *                layer resolves that bot's token.
 *            Skipping (c) is not a cosmetic bug, and this is the half that
 *            shipped wrong on Telegram once already: the push arrives from the
 *            wrong bot — into a DIFFERENT conversation, because a private
 *            Telegram chat_id is the user id — or, when that bot cannot open
 *            the chat at all, it does not arrive, and the failure is a logged
 *            warning nobody reads. Do NOT infer the identity from the TURN
 *            agent: the sticky default routinely answers as `main` in another
 *            bot's chat, which is exactly how the wrong token got picked.
 *      If your surface has no out-of-band channel at all, `deliverToReplyChat`
 *      returns FALSE for your prefix rather than throwing, and that is the
 *      honest answer; see the dashboard note at its call site. It returns FALSE
 *      for a REFUSED send too — the two are one signal on purpose, because
 *      "the room was not told" is the whole of what either means to a reader,
 *      and `formatMissionCreated({ pushFailed: true })` is the sentence that
 *      says so.
 *
 * WHAT EACH FUNCTION RETURNS. Plain text, `\n`-separated, no trailing newline.
 * `formatMissionList` renders a header line plus one line per mission, newest
 * first as the ACL ordered them. `formatMissionCard` renders one mission over
 * several lines with its body. All of them are TOTAL: an empty board is a
 * sentence, never an empty string, because an empty string is indistinguishable
 * from a failure at the surface (the dashboard makes the same distinction with
 * an explicit ErrorState — "this is an error, not an empty board").
 *
 * EVERY USER-VISIBLE MISSION STRING IS HERE, INCLUDING THE UNHAPPY ONES AND
 * THE TOOL ONES (A3-4). Not just the board and the card: the usage lines, the
 * unknown-status rejection, the "no mission matches" refusal, the ambiguous-ref
 * refusal, the status-changed acknowledgement, the board-unavailable apology,
 * the wrong-substrate refusal, the missing-argument refusals and the create
 * receipt. That is the whole list, and `format.test.ts` scans
 * `src/` for the PHRASES rather than for `format*` identifiers, because a name
 * scan is exactly what missed the duplication last time.
 *
 * The previous round shipped `formatMissionList` here and left four spellings
 * of the no-match refusal across three other files, plus a second board
 * vocabulary inside `list_missions` (`- [abc12345] medium open | Ship the ACL` —
 * raw enum, lowercase `p`, a pipe and a leading dash) so an agent answering
 * "what is on my board" and the same user typing `/missions` in the same
 * conversation got two different renderings of one board. A shared formatter
 * with unshared refusals and a private second board format is the A3 defect one
 * layer down; the refusals are the strings a user actually hits, and
 * `ToolResult.text` is relayed to that same user by the model.
 *
 * THE SIZE BOUND, and it is a HARD GUARANTEE — of a stated thing, which is the
 * part an earlier revision of this header got wrong. **Every string returned by
 * every function in this file is at most `MISSION_REPLY_MAX_CHARS` (3000)
 * SOURCE characters, for every input, including adversarial ones.** Why it must
 * exist at all: the board is REMOTE now, titles and bodies are Paperclip-
 * authored free text this repo has no probe bounding (UNVERIFIED — no probe in
 * this repo records a Paperclip title or body length cap, so treat both as
 * unbounded), and 15 rows of 255-char titles is 4225 characters — past
 * Telegram's 4096 hard cap. The bound is enforced in two layers: per-field caps
 * (`TITLE_MAX`, `BODY_MAX`, `REASON_MAX`) so one pathological title cannot eat
 * the whole board, and a final `clamp()` on the way out that makes the total
 * unconditional whatever the caller passes. 3000 is not arbitrary — it is the
 * threshold Telegram's own `splitLongText(finalText, 3000)` already uses for
 * agent prose, so a mission reply is never larger than a piece that path
 * already ships.
 *
 * WHAT THE BOUND IS NOT, said plainly because this header used to claim it was:
 * it is NOT a promise that a fourth surface needs no length handling. A SOURCE
 * bound only bounds a surface that MEASURES the source. Telegram does not: its
 * `sendMessage` sends `toTelegramHtml(text)`, which HTML-escapes `&`, `<` and
 * `>`, so escaping alone expands by up to 5x. MEASURED, on this code: a card
 * whose body is 2000 `&` is 1071 characters here and 5067 as Telegram receives
 * it; a board of `&`-heavy titles is 2220 here and 9360 there. Both are inside
 * the 3000 bound and both are over Telegram's 4096 — the header's old claim
 * that the oversize half of A3-10 was "closed HERE" was therefore false, and
 * the reply vanished with no error anywhere.
 *
 * SO THE BOUND THAT MATTERS LIVES WHERE THE MEASURING HAPPENS. This file bounds
 * the source; each surface bounds what it actually sends, because only it knows
 * what it sends. Telegram's `sendMessage` now does (`TELEGRAM_MAX_CHARS` in
 * `src/adapters/telegram/send.ts`): it measures the RENDERED string, splits on
 * it, drops to plain text for a piece whose HTML render is still over, retries
 * on "message is too long" as well as on a parse error, and its result is no
 * longer discarded by the handler. Slack's ceiling is ~40000 and `mrkdwn`
 * does not escape-expand, so a 3000-character source is inside it either way
 * (UNVERIFIED — no probe in this repo measures a rendered Slack payload against
 * that ceiling); the dashboard renders in a DOM and has no ceiling. A FIFTH
 * SURFACE MUST ASK ITSELF WHICH LENGTH ITS API COUNTS, and bound on that one.
 *
 * THE MARKUP RULE, and it has a wrong choice, and the wrong choice is a
 * LINE-START one. **No string this file returns begins any line with `-`, `+`,
 * `*`, `#`, `>` or whitespace, for any input, including a hostile one.** The
 * last clause is the half a previous revision only claimed: the rule was
 * enforced on the TEMPLATES while `cap()` sliced a title or body without touching its
 * whitespace, so a model-authored `create_mission` body of `ok\n- injected`
 * put a markdown bullet at the start of a line in a string this header
 * promised had none — and with it went "one line per mission" and
 * `formatAssignmentPush` being `\n`-free. `cap()` now flattens every
 * single-line field to one line and `capBody()` applies the same line-start
 * rule per line to the one field that is legitimately multi-line, so the
 * payload can no longer OPEN A LINE WITH ONE OF THOSE MARKERS. Stated as the
 * enumeration and not as "cannot choose the line structure", because the
 * broader sentence was false: the class omitted `*` and `#`, so a body whose
 * second and third lines were `# injected heading` and `* bullet star`
 * rendered a bold heading and a bullet on Telegram. It is an enumeration
 * rather than a total guarantee because a char class cannot be one — an
 * ordered-list `1.` opens a line with a digit, and stripping digits would eat
 * content. What it may still choose is INLINE characters — see the caveat
 * below, which is deliberate and unchanged.
 * That is the rule that was got wrong: the list rows used
 * to open `- [abc12345] …`, and every surface's GENERIC renderer rewrites a
 * leading `-` on its own — Telegram's `toTelegramHtml` turns it into `• `,
 * Slack posts the literal `-`, and the dashboard's `marked` emits `<ul><li>`.
 * Three different first characters from one shared string, which is precisely
 * the drift the shared string exists to prevent, and it slipped past a unit
 * test whose regex only looked for `[*_\`#<>]`. So the rows open with the ref
 * itself, and the test no longer asks "does this avoid markup" — it runs the
 * two real converters (`toTelegramHtml`, `markdownToMrkdwn`) over every string
 * and asserts what comes out.
 *
 * Beyond the line-start rule there are two families, because they have
 * different jobs:
 *   BOARD COPY — list, card, ambiguous, no-match, status-changed, board-error,
 *     wrong-substrate, assignment push. The TEMPLATE contains NO markup
 *     character at all (`*`, `_`, `` ` ``, `#`, `<`, `>`, `|`) and comes out of
 *     both converters BYTE-IDENTICAL. Said precisely, because a previous
 *     revision claimed it of the whole string: byte-identity is a property of
 *     the template plus a payload that carries no markup, which is every real
 *     board row. A payload that carries `**` or `>` is the caller's (see the
 *     caveat below) and renders as the surface renders any other agent prose;
 *     what it can NEVER do, hostile or not, is open a line with one of the
 *     markers enumerated at the top.
 *   HELP COPY — `formatMissionUsage`, `formatUnknownStatus`,
 *     `formatMissingArgument`, `MISSION_HELP_LINES`. These must print the
 *     literals a user types back: the placeholders `id`/`title`, the argument
 *     names, and the raw `in_progress` enum. They are asserted to SURVIVE
 *     VISIBLY on every renderer, which is the property that actually matters
 *     and is why the placeholder idiom here is a backtick and not `<id>`:
 *     angle brackets survive Telegram (escaped) and Slack (untouched) but are
 *     DELETED by the dashboard's `marked` + DOMPurify pass, which is the one
 *     surface that reads the line as HTML.
 *
 * The caveat, stated rather than hidden: a mission TITLE or BODY is free text
 * from Paperclip, so a title containing `*x*` renders bold on Telegram and on
 * Slack. That is not a parity break — it is the identical treatment those
 * surfaces give every other line of agent prose, and neutralizing it would make
 * mission text the one kind of chat text that renders differently from
 * everything around it. The rule this file owns is that the TEMPLATE never
 * contributes a markup character; the payload is the caller's.
 *
 * THE REFERENCE CONVENTION — the NUMBERING RULE, and it is the other half of
 * A3-4. A mission is named to a human by `missionRef(id)`: the first
 * `MISSION_REF_LENGTH` (8) characters of the Paperclip issue uuid, bracketed.
 * A ref typed back is resolved by `resolveMissionRef()` over a window of
 * `MISSION_RESOLVE_WINDOW` (200) rows. **Both halves of that rule live in this
 * file, and every consumer delegates to them** — the chat router
 * (`/mission <ref>`), the `paperclip_add_comment` tool, and the Mission ACL's
 * `resolveOwned` (which wraps the `ambiguous` result in
 * `AmbiguousMissionPrefixError`). They previously read the same ref at THREE
 * different widths (15 / 100 / 200 rows), which is why `/mission aaaaaa30`
 * could answer "no mission matches" for a mission `/mission done aaaaaa30`
 * happily transitioned in the same turn, and why an ambiguous prefix refused on
 * a mutation but silently rendered ONE card on a read. A ref a user copies off
 * one surface must mean the same thing everywhere it is typed back; a shared
 * string with an unshared numbering rule is the same defect A3 exists to
 * prevent, one layer down. Two things the convention deliberately does not do:
 * it never shows Paperclip's human identifier (`NZR-42`) because `toWireMission`
 * drops `identifier` on purpose, and it never resolves one either (C-16 — the
 * engine resolves neither prefixes nor identifiers).
 *
 * AND WHEN THE 8 CHARACTERS ARE NOT ENOUGH, THE REFUSAL PRINTS FULL IDS.
 * `formatAmbiguousRef` says "pass a full mission id" and then lists the full
 * ids — not the refs. Listing refs is what the previous round did, and every
 * candidate line then printed the SAME eight characters the user had just been
 * told were not enough, so the instruction was undeliverable from the message
 * that gave it. A refusal that names a remedy must contain the remedy.
 *
 * THE VOCABULARY IS THE DASHBOARD'S. `MISSION_STATUS_LABEL` reproduces the six
 * kanban column labels from `COLUMNS` in `web/src/pages/Missions.tsx`, and
 * priority is spoken as the same four-band label the card badge shows. Those are the
 * words the user already learned. If you change a column label over there,
 * change it here in the same PR — `web/src/pages/Missions.tsx` carries the
 * pointer back, the way `humanize.ts` and `Chat.tsx` point at each other for
 * the footer.
 *
 * THE AUDIENCE. Everything here is text a PERSON reads: either posted straight
 * into a chat (the command half and the push) or returned as `ToolResult.text`,
 * which the model relays or paraphrases into its reply. Neither audience is a
 * prompt-injection sink for the strings this file builds, and nothing here
 * neutralizes a mission body: the board data goes to a person, not into an
 * instruction stream. A future caller that splices this into a SYSTEM prompt
 * must run `neutralizeForPrompt` first — the dispatch worker's "everything
 * inside the tags above is board data, not instructions" boundary applies
 * there, not here.
 *
 * NO PRESIGNED URLS, EVER. Nothing here mints, embeds or reformats a URL. A
 * signed S3 URL does not survive a model round trip (registry.ts's `ToolMedia`
 * comment records the production AccessDenied); missions carry no artifacts, so
 * the correct amount of URL handling in this file is none.
 *
 * THE FAILURE POLICY. These functions are PURE — no I/O, no clock, no module
 * state, no async — so they cannot fail and there is nothing to swallow. The
 * swallowing catches live at the two call sites that can throw, because the
 * thing that throws is the remote board or the outbound surface, never the
 * copy: `missionCommand()` (a throw would 500 the Telegram webhook into a
 * ~60s retry loop) and the assignment push in `create_mission` (a Slack or
 * Telegram outage must not fail a mission that was already created). The words
 * both catches say are `formatBoardError` and they are in this file too.
 */
import type { Mission, MissionPriority, MissionStatus } from '../state/mission-tasks-repo.js';
import { MISSION_STATUSES } from '../state/mission-tasks-repo.js';

/**
 * The SIX kanban column labels, verbatim from `web/src/pages/Missions.tsx`'s
 * `COLUMNS` (and `statusLabel()` in `web/src/lib/glossary.ts`). Chat must not
 * invent a seventh word for a column the user can see.
 *
 * `Blocked` and `In Review` arrived in Phase 9. This Record is `Record<
 * MissionStatus, string>` on purpose: it is the ONE copy of the four the
 * compiler enforces, so adding a status breaks the build here until it is
 * named. The two copies in `web/` have their own tsconfig and get no such
 * help, which is why `format.test.ts` scans both files for these exact pairs.
 */
export const MISSION_STATUS_LABEL: Record<MissionStatus, string> = {
  open: 'Open',
  in_progress: 'In Progress',
  blocked: 'Blocked',
  in_review: 'In Review',
  done: 'Done',
  cancelled: 'Cancelled',
};

export const MISSION_PRIORITY_LABEL: Record<MissionPriority, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

/** How many characters of a mission uuid a human is ever shown or asked to type. */
export const MISSION_REF_LENGTH = 8;

/**
 * How many of an owner's rows a ref is resolved against — ONE number for every
 * consumer (the chat router, `paperclip_add_comment`, and the ACL's `resolveOwned`).
 * 200 is the legacy `listMissionsForAgent(owner, 200)` window, kept so a
 * mutation still costs exactly one issue-list read; see the long note above
 * `resolveOwned` in `mission-acl.ts` for why the window is one page and not a
 * walk.
 */
export const MISSION_RESOLVE_WINDOW = 200;

/**
 * How many rows a chat board reply SHOWS. Distinct from the resolve window on
 * purpose: a chat reply is not a kanban, but a ref must still resolve against
 * the whole board. Reading fewer rows than you resolve against is exactly the
 * bug this split fixes.
 */
export const MISSION_LIST_LIMIT = 15;

/**
 * The hard ceiling on every string this module returns. See "THE SIZE BOUND"
 * above: Telegram's hard cap is 4096 and its own prose path already splits at
 * 3000, so nothing here is ever larger than a piece that path ships.
 */
export const MISSION_REPLY_MAX_CHARS = 3000;

/**
 * How much of a thrown error a user is shown. 300 is the surfaces' own number —
 * Telegram and both Slack paths already say `Something went wrong:
 * <msg.slice(0,300)>` — so an outage reads the same length whichever way it
 * reaches the room.
 */
const ERROR_MAX = 300;

/** Per-field caps, so one pathological row cannot consume the whole reply. */
const TITLE_MAX = 120;
const BODY_MAX = 1000;
const REASON_MAX = 200;
/** Markup-free by the rule above, and short enough to always fit. */
const TRUNCATED = '\n… (truncated)';

/**
 * Total for any input: never longer than `max`, never adds markup — and ALWAYS
 * ONE LINE.
 *
 * The flattening is the part that was missing, and it is what makes the
 * line-structure guarantees above true against a PAYLOAD rather than only
 * against a template. A title and a body are free text — Paperclip-authored, or
 * model-authored via `create_mission`, where markdown bullets are the norm — so
 * a title of `ok\n- injected` slid straight through a plain `slice()` and gave
 * the payload control of the line structure: "one line per mission" became two,
 * `formatAssignmentPush` stopped being `\n`-free, and the new line began with
 * `- `, the one character each surface's generic renderer rewrites differently
 * (Telegram `• `, Slack a literal dash, the dashboard `<ul><li>`).
 *
 * It is done HERE and not at the five call sites on purpose: a rule enforced at
 * call sites is a rule that a sixth call site does not have.
 */
function cap(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * The ONE field that is legitimately multi-line: a card's body. It keeps its
 * line breaks, so it gets the line-start rule applied per line instead of being
 * flattened — a body opening `- ` or `> ` is markdown to every surface's
 * generic renderer exactly as a template would be.
 */
function capBody(text: string, max: number): string {
  const flat = text
    .split('\n')
    .map((l) => l.replace(/^[-+*#>\s]+/, '').trimEnd())
    .join('\n')
    .trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * The unconditional half of the size guarantee. Per-field caps handle the
 * common case readably; this handles everything else — a 400-row list, a
 * 5000-character owner id — so the bound holds for inputs no cap anticipated.
 */
function clamp(out: string): string {
  if (out.length <= MISSION_REPLY_MAX_CHARS) return out;
  return out.slice(0, MISSION_REPLY_MAX_CHARS - TRUNCATED.length) + TRUNCATED;
}

/** The statuses a user may name, in the order the board's columns run. */
export const MISSION_STATUS_WORDS: readonly string[] = [...MISSION_STATUSES, 'all'];

/**
 * The two `/help` lines, so the advertisement and the behaviour cannot drift.
 * `commands.ts` spreads these into `HELP_TEXT`; every surface prints that list.
 *
 * THE PLACEHOLDERS ARE BACKTICKED, NOT ANGLE-BRACKETED, and that is a bug fix
 * rather than a style choice. `<id>` is this repo's older help idiom (`/agent
 * <id>` and the rest of `HELP_TEXT` still use it) and it is INVISIBLE on the
 * dashboard: `marked` emits `<id>` as an HTML element, DOMPurify's default
 * allowlist contains no such tag and strips it, and the user reads
 * "Usage: /mission  | /mission new  | /mission done " with three blanks. A
 * backtick is the one placeholder idiom all three renderers SHOW — `<code>` via
 * `toTelegramHtml`, `<code>` via `marked`, and mrkdwn's own code span, which
 * `markdownToMrkdwn` round-trips byte-for-byte. The inherited angle brackets on
 * the non-mission lines are broken the same way and are not this module's to
 * fix; when they move, move them to this idiom.
 */
export const MISSION_HELP_LINES: readonly string[] = [
  `/missions [${MISSION_STATUS_WORDS.join('|')}] — this agent's mission board (defaults to open)`,
  '/mission `id` — show one mission; /mission new `title`; /mission done `id`',
];

/**
 * The short id printed in a list and typed back into `/mission done <id>`,
 * `paperclip_add_comment` or `update_mission`. `resolveMissionRef` below is the
 * other half of the rule: this is the width shown, that is the width resolved.
 */
export function missionRef(missionId: string): string {
  return missionId.slice(0, MISSION_REF_LENGTH);
}

/** What a ref resolved to. `ambiguous` is a REFUSAL, never a pick. */
export type MissionRefMatch =
  | { kind: 'found'; mission: Mission }
  | { kind: 'none' }
  | { kind: 'ambiguous'; matches: readonly Mission[] };

/**
 * THE NUMBERING RULE, in the pure shared module (A3-4). Resolve a full id or an
 * 8-char prefix against one owner's rows.
 *
 * Every consumer calls THIS — reads and mutations alike — so a ref cannot mean
 * one thing when shown and another when typed back. Two properties it holds
 * that a hand-rolled `filter(startsWith)` at a call site did not:
 *
 *  - AN EXACT ID IS UNAMBIGUOUS BY DEFINITION and is matched first. A single
 *    `find` testing both arms per row could lose a full id to an earlier row
 *    that merely shared its prefix.
 *  - A PREFIX MATCHING TWO ROWS IS `ambiguous`, FOR READS TOO. The read path
 *    used to render one card and never mention the second — the ACL refused the
 *    same prefix on a mutation, so the same 8 characters meant "this mission"
 *    and "which of these two?" in one turn. The caller decides the words; it
 *    does not get to decide whether the collision is reported.
 *
 * An empty ref matches NOTHING rather than every row: `''.startsWith` is true
 * for every id, and the legacy single `find` therefore resolved an empty id to
 * whichever row a sweep with no claimed ordering returned first.
 */
export function resolveMissionRef(rows: readonly Mission[], ref: string): MissionRefMatch {
  if (!ref) return { kind: 'none' };
  const exact = rows.find((m) => m.id === ref);
  if (exact) return { kind: 'found', mission: exact };
  const prefixed = rows.filter((m) => m.id.startsWith(ref));
  if (prefixed.length === 0) return { kind: 'none' };
  if (prefixed.length > 1) return { kind: 'ambiguous', matches: prefixed };
  return { kind: 'found', mission: prefixed[0] };
}

/**
 * One list row: `[1a2b3c4d] High Open — Ship the reconciler`.
 * NO LEADING `-`: see "THE MARKUP RULE" — a leading dash is the one character
 * each surface's generic markdown pass rewrites differently.
 */
function missionLine(m: Mission): string {
  return `[${missionRef(m.id)}] ${MISSION_PRIORITY_LABEL[m.priority]} ${MISSION_STATUS_LABEL[m.status]} — ${cap(m.title, TITLE_MAX)}`;
}

/**
 * The board as chat text. `status` is the filter the caller applied, echoed
 * back so "nothing here" is never ambiguous about WHAT is not here.
 */
export function formatMissionList(
  rows: readonly Mission[],
  opts: { owner: string; status: MissionStatus | 'all' },
): string {
  const label = opts.status === 'all' ? '' : `${MISSION_STATUS_LABEL[opts.status]} `;
  if (rows.length === 0) return `No ${label}missions for ${cap(opts.owner, 64)}.`;
  const noun = rows.length === 1 ? 'mission' : 'missions';
  return clamp(
    [
      `${rows.length} ${label}${noun} for ${cap(opts.owner, 64)}:`,
      ...rows.map(missionLine),
    ].join('\n'),
  );
}

/**
 * One mission in full. `assignmentReason` is omitted rather than rendered
 * empty when it is absent.
 */
export function formatMissionCard(m: Mission): string {
  const lines = [
    `[${missionRef(m.id)}] ${cap(m.title, TITLE_MAX)}`,
    `${MISSION_STATUS_LABEL[m.status]} · ${MISSION_PRIORITY_LABEL[m.priority]} priority · owner ${cap(m.ownerAgent, 64)}`,
  ];
  if (m.assignmentReason) lines.push(`Assigned because: ${cap(m.assignmentReason, REASON_MAX)}`);
  if (m.body) lines.push('', capBody(m.body, BODY_MAX));
  return clamp(lines.join('\n'));
}

/**
 * A ref that matched more than one mission. The REFUSAL is the point, and the
 * REMEDY IS IN THE MESSAGE: it names the collision, then lists the FULL ids so
 * the user can copy one. Listing 8-char refs — which the previous round did —
 * printed the same eight characters the sentence had just called insufficient.
 *
 * Takes ids rather than rows because both callers have ids and only one has
 * rows: the chat router resolves against `Mission[]`, while the ACL raises
 * `AmbiguousMissionPrefixError`, which carries `matches: string[]` and crosses
 * a route boundary. One shape, one spelling, both paths.
 */
export function formatAmbiguousRef(opts: {
  owner: string;
  ref: string;
  ids: readonly string[];
}): string {
  return clamp(
    [
      `Mission id '${cap(opts.ref, 64)}' matches ${opts.ids.length} of ${cap(opts.owner, 64)}'s missions; pass one of these full ids:`,
      ...opts.ids.map((id) => cap(id, 64)),
    ].join('\n'),
  );
}

/**
 * A ref that matched nothing on this owner's board. ONE spelling: the chat
 * router's read and mutation paths, `update_mission` and `paperclip_add_comment`
 * all say this sentence, and the previous round had four sites saying it two
 * ways (quoted and unquoted). It names the OWNER because the commonest cause is
 * a real ref typed at the wrong agent.
 */
export function formatNoMatch(opts: { owner: string; ref: string }): string {
  return clamp(`No mission matches '${cap(opts.ref, 64)}' for ${cap(opts.owner, 64)}.`);
}

/** A status word that is not one of the six columns (plus `all`). */
export function formatUnknownStatus(raw: string): string {
  return clamp(`Unknown status '${cap(raw, 64)}'. Use: ${MISSION_STATUS_WORDS.join(', ')}.`);
}

/**
 * A completed transition, spoken in the column's own word ("Done", not "done"),
 * and echoing the ref the user typed so they can see what was acted on.
 */
export function formatStatusChanged(opts: { ref: string; status: MissionStatus }): string {
  return clamp(`Mission ${cap(opts.ref, 64)} → ${MISSION_STATUS_LABEL[opts.status]}.`);
}

/**
 * The `/mission` usage lines. `verb` narrows it to the sub-command that failed.
 * Backticked placeholders, for the reason spelled out at `MISSION_HELP_LINES`:
 * the angle-bracket idiom renders as NOTHING on the dashboard.
 */
export function formatMissionUsage(verb?: 'new' | 'done'): string {
  if (verb === 'new') return 'Usage: /mission new `title`';
  if (verb === 'done') return 'Usage: /mission done `id`';
  return 'Usage: /mission `id` | /mission new `title` | /mission done `id`';
}

/**
 * The remote board threw. The words for the swallowing catches in
 * `missionCommand()` and in the assignment push — an OUTAGE, said plainly, so a
 * user can tell it from an empty board and from a ref that matched nothing.
 * Those two are different answers and the previous round gave the outage
 * sentence for an ambiguous prefix, which is a user error wearing an outage's
 * clothes.
 */
export function formatBoardError(err: unknown): string {
  // `cap`, not `slice`: a thrown message is as free-form as a mission title —
  // a stack fragment or a wrapped remote body carries newlines, and one of them
  // beginning `- ` breaks the line-start rule the same way a payload title did.
  const msg = err instanceof Error ? err.message : String(err);
  return clamp(`Mission board unavailable: ${cap(msg, ERROR_MAX)}`);
}

/**
 * THE WRONG SUBSTRATE, which is NOT an outage and must not borrow the outage's
 * words. `formatBoardError` says the board could not be reached;
 * this says the board is fine and the VERB does not exist on the substrate this
 * install runs — the legacy DynamoDB board has no comment thread to write to.
 * Different condition, different remedy, different sentence, same rule as the
 * ambiguous-ref/outage split above.
 */
export function formatWrongSubstrate(): string {
  return clamp(
    'Mission comments need the Paperclip work engine, which is not the active mission substrate on this install.',
  );
}

/**
 * A tool call that arrived without a required argument. It is copy like
 * everything else here — `ToolResult.text` is relayed to the user by the model
 * — and it was hand-typed six times across the two tool files. The argument
 * name is backticked for the same reason the usage lines are: it is a literal
 * the caller has to type back, and the dashboard eats an un-backticked one.
 */
export function formatMissingArgument(name: string): string {
  return clamp(`\`${cap(name, 64)}\` is required`);
}

/**
 * The `paperclip_add_comment` acknowledgement. Here rather than in the tool for the
 * same reason as the create receipt: it names a mission, so it must name it the
 * way every other mission sentence does — by `missionRef`, at the one width a
 * user is ever shown or asked to type.
 */
export function formatCommentPosted(missionId: string): string {
  return clamp(`Comment posted on mission ${missionRef(missionId)}.`);
}

/** Shared receipt for the Paperclip-native single-child delegation verb. */
export function formatSubtaskCreated(opts: {
  parentMissionId: string;
  missionId: string;
  ownerAgent: string;
}): string {
  return clamp(
    `Subtask ${missionRef(opts.missionId)} created under mission ${missionRef(opts.parentMissionId)}. Owner: ${cap(opts.ownerAgent, 64)}.`,
  );
}

/**
 * The create receipt. `create_mission` returns this as `ToolResult.text`, so it
 * is the model's account of what just happened and the model relays it - same
 * audience as everything else here, one layer removed. It speaks the same ref,
 * the same four-band priority and owner-and-reason pair the dashboard card shows.
 *
 * NOTE FOR ANY FUTURE EDIT: this is the RESULT text, not the toolSpec. The
 * `create_mission` toolSpec JSON is frozen byte-for-byte (pinned by
 * `mission-toolspec.test.ts`); the sentence below is not part of it.
 */
export function formatMissionCreated(opts: {
  mission: Mission;
  reason: string;
  /**
   * The assignment push did not reach the chat — either the surface has no
   * out-of-band channel or the send was refused. WHY THE RECEIPT SAYS SO: the
   * model relays this text, so a receipt that reads the same either way tells
   * the room "everyone has been told" when nobody has. It names the inbox
   * because that is the fallback that DID happen — assignment is push AND pull,
   * and only the push half can fail here.
   */
  pushFailed?: boolean;
}): string {
  const { mission: m, reason, pushFailed } = opts;
  const owner = cap(m.ownerAgent, 64);
  const undelivered = pushFailed
    ? ` This chat was not notified; ${owner} still has it in their inbox.`
    : '';
  return clamp(
    `Mission ${missionRef(m.id)} created. Owner: ${owner} (${cap(reason, REASON_MAX)}). Priority ${MISSION_PRIORITY_LABEL[m.priority].toLowerCase()}.${undelivered}`,
  );
}

/**
 * THE ASSIGNMENT PUSH (A3-12). What a chat is told when a mission is handed to
 * a DIFFERENT agent than the one in the room.
 *
 * Why this copy exists at all: the handover note `create_mission` writes with
 * `sendInterAgent` lands in the owner's INBOX, which nobody reads until the
 * owner's next turn — assignment was pull-only. This is the push half, and it
 * is one sentence rather than a card because it interrupts a conversation that
 * was about something else.
 *
 * It is `\n`-free on purpose: the surfaces post it as a standalone message and
 * a one-line notice reads the same in a Telegram bubble, a Slack thread and a
 * per-agent app post.
 */
export function formatAssignmentPush(opts: {
  mission: Mission;
  byAgent: string;
}): string {
  const { mission: m, byAgent } = opts;
  return clamp(
    `Mission [${missionRef(m.id)}] "${cap(m.title, TITLE_MAX)}" assigned to ${cap(m.ownerAgent, 64)} by ${cap(byAgent, 64)} (${MISSION_PRIORITY_LABEL[m.priority].toLowerCase()} priority).`,
  );
}
