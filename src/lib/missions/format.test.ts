/**
 * The Missions chat vocabulary, and the parity properties that hold it in one
 * place. Pure unit test in the `humanize.test.ts` shape: NO mocks, NO adapter
 * imports, no I/O. Every case is named for the REGRESSION it catches, not for
 * the behaviour it exercises.
 *
 * The source scans at the bottom are the `kill-phrase.test.ts` pattern: a
 * property of the form "N surfaces do X" that no behavioural test can state,
 * asserted by counting call sites per file.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { Mission } from '../state/mission-tasks-repo.js';
import {
  MISSION_HELP_LINES,
  MISSION_LIST_LIMIT,
  MISSION_PRIORITY_LABEL,
  MISSION_REF_LENGTH,
  MISSION_REPLY_MAX_CHARS,
  MISSION_RESOLVE_WINDOW,
  MISSION_STATUS_LABEL,
  formatAmbiguousRef,
  formatAssignmentPush,
  formatBoardError,
  formatCommentPosted,
  formatMissionCard,
  formatMissionCreated,
  formatMissionList,
  formatMissionUsage,
  formatMissingArgument,
  formatNoMatch,
  formatStatusChanged,
  formatUnknownStatus,
  formatWrongSubstrate,
  missionRef,
  resolveMissionRef,
} from './format.js';
// The two surface renderers, imported for ONE test at the bottom. Both are
// pure string -> string functions; nothing here mocks or drives an adapter.
import { toTelegramHtml } from '../../adapters/telegram/format.js';
import { markdownToMrkdwn } from '../../adapters/slack/mrkdwn.js';

const ROW: Mission = {
  id: 'abc12345-1111-4111-8111-111111111111',
  ownerAgent: 'research',
  createdByAgent: 'research',
  createdByChat: 'owner:emmanuel',
  title: 'Ship the reconciler',
  body: 'With a watermark overlap.',
  priority: 'high',
  status: 'open',
  createdAt: '2026-08-20T10:00:00.000Z',
  updatedAt: '2026-08-20T10:00:00.000Z',
};

/** A twin sharing ROW's 8-char prefix — the C-16 collision, reachable by hand. */
const TWIN: Mission = { ...ROW, id: 'abc12345-2222-4222-8222-222222222222' };

describe('missionRef', () => {
  it('prints exactly the 8 characters the ACL resolves back (A3-4 round trip)', () => {
    // The regression this guards: a ref shown at one width and resolved at
    // another. `list_missions`, `/missions` and `paperclip_comment` all print
    // and accept THIS prefix, and resolveMissionRef matches it with startsWith.
    // Change the width here and every id a user types stops resolving, on every
    // surface at once.
    expect(missionRef(ROW.id)).toBe('abc12345');
    expect(missionRef(ROW.id)).toHaveLength(MISSION_REF_LENGTH);
    expect(ROW.id.startsWith(missionRef(ROW.id))).toBe(true);
  });

  it('never leaks the Paperclip human identifier, which toWireMission drops (C-16)', () => {
    // Mission carries no `identifier` field at all; a formatter that grew one
    // would be showing a NZR-42 nobody can resolve back.
    expect(missionRef(ROW.id)).not.toContain('NZR');
    expect(Object.keys(ROW)).not.toContain('identifier');
  });
});

/**
 * A3-4 IS "EVERY USER-VISIBLE STRING **AND NUMBERING RULE**". These are the
 * numbering-rule cases. The shipped defect they close: the one 8-char ref this
 * phase teaches users to copy between surfaces was resolved at THREE widths by
 * THREE hand-rolled matchers — 15 rows in `/mission <ref>`, 100 in
 * `paperclip_comment`, 200 in the ACL — so the same characters meant different
 * things depending on which one you typed them into.
 */
describe('resolveMissionRef', () => {
  it('resolves a full id even when an earlier row merely shares its prefix', () => {
    // The regression: a single `find` testing `id === ref || id.startsWith(ref)`
    // per row returns the FIRST row that satisfies EITHER arm, so a full id
    // loses to a twin that sorts earlier. TWIN is deliberately first here.
    const match = resolveMissionRef([TWIN, ROW], ROW.id);
    expect(match).toEqual({ kind: 'found', mission: ROW });
  });

  it('REFUSES a prefix matching two missions on a READ, not just on a mutation', () => {
    // The shipped bug, exactly: `/mission abc12345` rendered one card for the
    // nearest twin and never said the prefix was ambiguous, while
    // `setBoardMissionStatus` on the identical input raised
    // AmbiguousMissionPrefixError. One ref, one turn, two answers.
    const match = resolveMissionRef([ROW, TWIN], 'abc12345');
    expect(match.kind).toBe('ambiguous');
    expect(match.kind === 'ambiguous' && match.matches).toHaveLength(2);
  });

  it('matches NOTHING for an empty ref rather than the whole board', () => {
    // `''.startsWith` is true for every id, so the legacy single `find`
    // resolved an empty id to whichever row a sweep with no claimed ordering
    // happened to return first — a mutation on an arbitrary mission.
    expect(resolveMissionRef([ROW, TWIN], '')).toEqual({ kind: 'none' });
  });

  it('says none rather than throwing when the board has no match', () => {
    expect(resolveMissionRef([ROW], 'ffffffff')).toEqual({ kind: 'none' });
    expect(resolveMissionRef([], 'abc12345')).toEqual({ kind: 'none' });
  });

  it('resolves against a WIDER window than a chat reply shows', () => {
    // The other half of the shipped bug: `/mission <ref>` read
    // MISSION_LIST_LIMIT rows and resolved against those, so on a 40-row board
    // it answered "no mission matches" for a mission `/mission done <ref>`
    // transitioned in the same turn. Reading fewer rows than you resolve
    // against is the defect; these two numbers must never converge by accident.
    expect(MISSION_RESOLVE_WINDOW).toBeGreaterThan(MISSION_LIST_LIMIT);
    expect(MISSION_RESOLVE_WINDOW).toBe(200);
  });
});

describe('formatMissionList', () => {
  it('says the board is empty instead of returning an empty string', () => {
    // The regression this guards: '' is indistinguishable from a failed read at
    // the surface — Telegram would edit the placeholder to nothing. The
    // dashboard already settled this with an explicit ErrorState.
    expect(formatMissionList([], { owner: 'research', status: 'open' })).toBe(
      'No Open missions for research.',
    );
    expect(formatMissionList([], { owner: 'research', status: 'all' })).toBe(
      'No missions for research.',
    );
  });

  it("speaks the dashboard kanban's six column labels, not the raw enum", async () => {
    // The regression this guards: chat saying "in_progress" while the board the
    // same user is looking at says "In Progress".
    //
    // SIX since Phase 9. `blocked` and `in_review` are Paperclip statuses the
    // projection used to collapse into `open` and `in_progress`, so a stalled
    // mission read as merely un-started on every surface at once. The KEY
    // ORDER is the lane order and it is asserted with the labels, because the
    // `/missions [...]` help line and the `invalid_status` 400 both serialise
    // MISSION_STATUSES verbatim.
    expect(MISSION_STATUS_LABEL).toEqual({
      open: 'Open',
      in_progress: 'In Progress',
      blocked: 'Blocked',
      in_review: 'In Review',
      done: 'Done',
      cancelled: 'Cancelled',
    });
    expect(Object.keys(MISSION_STATUS_LABEL)).toEqual([
      'open', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled',
    ]);
    const line = formatMissionList([{ ...ROW, status: 'in_progress' }], {
      owner: 'research',
      status: 'all',
    });
    expect(line).toContain('In Progress');
    expect(line).not.toContain('in_progress');

    // SOURCE SCAN (A3-8): there are THREE copies of these four words, not two,
    // and the third had already drifted before anything scanned for it —
    // `statusLabel()` said "In progress" while the column header beside it said
    // "In Progress", and `Missions.tsx` renders BOTH on one screen (the badge
    // and the drawer call statusLabel(), the header reads COLUMNS). A test that
    // only checks the server-side constant cannot see that; this one fails in
    // the pure unit test rather than on a screen. It also asserts the pointers,
    // because A3-8 names an unmarked duplicate as the defect in its own right.
    const columns = await readFile('web/src/pages/Missions.tsx', 'utf8');
    const glossary = await readFile('web/src/lib/glossary.ts', 'utf8');
    const shippedDashboard = await readFile('src/adapters/dashboard/public/app.js', 'utf8');
    for (const [key, label] of Object.entries(MISSION_STATUS_LABEL)) {
      expect(columns).toContain(`{ key: '${key}', label: '${label}',`);
      expect(glossary).toContain(`${key}: '${label}',`);
    }
    expect(columns).toContain('glossary.ts');
    expect(columns).toContain('src/lib/missions/format.ts');
    expect(glossary).toContain('MISSION_STATUS_LABEL');
    expect(glossary).toContain('COLUMNS');
    expect(shippedDashboard).toContain(
      "const STATUSES = ['open', 'in_progress', 'blocked', 'in_review', 'done', 'cancelled'];",
    );
    expect(shippedDashboard).toContain('${escapeHtml(m.priority)} priority');
    expect(shippedDashboard).not.toContain('p${m.priority}');

    // AND THE ORDER, not just the membership. The loop above is `toContain`
    // per key, so it is satisfied by all six words being PRESENT in any
    // arrangement — which is exactly how the two web copies drifted out of lane
    // order while this scan stayed green: `COLUMNS` still read
    // open/blocked/in_progress while the server constant read
    // open/in_progress/blocked, so the board rendered its lanes in one order
    // and every chat surface spoke them in another. The lane order is the
    // repository owner's decision (the story of a task: started, worked,
    // stuck, reviewed, landed) and MISSION_STATUSES calls it contract, so the
    // copies the compiler cannot reach get it asserted here by POSITION.
    const entries = Object.entries(MISSION_STATUS_LABEL);
    const positions = (src: string, marker: (k: string, label: string) => string): number[] =>
      entries.map(([key, label]) => src.indexOf(marker(key, label)));
    for (const found of [
      positions(columns, (k) => `{ key: '${k}',`),
      positions(glossary, (k, label) => `${k}: '${label}',`),
    ]) {
      expect(found).not.toContain(-1);
      expect([...found].sort((a, b) => a - b)).toEqual(found);
    }
  });

  it('speaks the exact four-band priority the board renders', () => {
    expect(MISSION_PRIORITY_LABEL).toEqual({
      critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low',
    });
    expect(formatMissionList([ROW], { owner: 'research', status: 'open' })).toBe(
      '1 Open mission for research:\n[abc12345] High Open — Ship the reconciler',
    );
  });

  it('pluralizes the count ("1 mission", "2 missions")', () => {
    // The regression this guards is the one formatTurnFooter already shipped
    // once ("· 3 tool" on every surface at once): a shared formatter's grammar
    // bug is a bug on Telegram, both Slack paths and the dashboard together.
    expect(formatMissionList([ROW], { owner: 'a', status: 'all' })).toContain('1 mission for a:');
    expect(formatMissionList([ROW, ROW], { owner: 'a', status: 'all' })).toContain(
      '2 missions for a:',
    );
  });

});

describe('formatMissionCard', () => {
  it('omits assignmentReason rather than printing it empty', () => {
    const card = formatMissionCard(ROW);
    expect(card).not.toContain('undefined');
    expect(card).not.toContain('Due:');
    expect(card).not.toContain('Assigned because:');
    expect(card).toBe(
      '[abc12345] Ship the reconciler\nOpen · High priority · owner research\n\nWith a watermark overlap.',
    );
  });

  it('renders the optional assignment reason when provenance supplied it', () => {
    const card = formatMissionCard({
      ...ROW,
      assignmentReason: 'closest to the watermark work',
    });
    expect(card).toContain('Assigned because: closest to the watermark work');
  });
});

describe('formatAmbiguousRef', () => {
  it('names the collision BEFORE listing candidates, so a card is never mistaken for the answer', () => {
    const out = formatAmbiguousRef({ owner: 'research', ref: 'abc12345', ids: [ROW.id, TWIN.id] });
    expect(out.split('\n')[0]).toBe(
      "Mission id 'abc12345' matches 2 of research's missions; pass one of these full ids:",
    );
  });

  it('LISTS THE FULL IDS, because the remedy it names must be in the message', () => {
    // The regression, and it made the refusal undeliverable from itself: the
    // candidate lines used to print `missionRef(id)` - the SAME eight
    // characters the sentence above had just called insufficient - so "pass a
    // full mission id" could not be obeyed from the message that said it. Every
    // candidate line must differ from the ref that collided.
    const out = formatAmbiguousRef({ owner: 'research', ref: 'abc12345', ids: [ROW.id, TWIN.id] });
    const candidates = out.split('\n').slice(1);
    expect(candidates).toEqual([ROW.id, TWIN.id]);
    for (const line of candidates) expect(line).not.toBe(missionRef(ROW.id));
    // And a candidate, pasted straight back, resolves to exactly one mission.
    expect(resolveMissionRef([ROW, TWIN], candidates[0])).toEqual({ kind: 'found', mission: ROW });
  });
});

/**
 * A3-4 IN FULL: the refusals and acknowledgements are copy too. The previous
 * round shipped the board and the card here and left four spellings of the
 * no-match refusal, two `Usage:` lines, the status acknowledgement and the
 * outage sentence hand-typed across three other files. The strings a user
 * actually hits are the unhappy ones.
 */
describe('the unhappy strings are shared too', () => {
  it('speaks ONE board vocabulary to a tool and to a chat command alike', () => {
    // The regression: `list_missions` rendered its own rows and `/missions`
    // rendered the shared ones, so the SAME board came back as
    // `- [abc12345] high open | Ship the reconciler` through a tool and
    // `[abc12345] High Open — Ship the reconciler` through a command, in one
    // conversation. `ToolResult.text` is relayed to the user by the model, so
    // both are the user's vocabulary and there can only be one.
    const board = formatMissionList([ROW], { owner: 'research', status: 'open' });
    expect(board).toContain('High Open');
    expect(board).not.toContain('| Ship');
  });

  it('names the create receipt in the same ref, badge and owner the card uses', () => {
    expect(formatMissionCreated({ mission: ROW, reason: 'closest to the work' })).toBe(
      'Mission abc12345 created. Owner: research (closest to the work). Priority high.',
    );
  });

  it('and the receipt says so when the chat was NOT told, in the same vocabulary', () => {
    // A3-12's honest half: `create_mission` relays this text to the room
    // through the model, so a receipt that reads identically whether the
    // assignment push arrived or was refused announces a notice nobody got.
    // It names the inbox because that is the fallback that DID happen —
    // assignment is push AND pull, and only the push can fail here.
    expect(
      formatMissionCreated({ mission: ROW, reason: 'closest to the work', pushFailed: true }),
    ).toBe(
      'Mission abc12345 created. Owner: research (closest to the work). Priority high. ' +
        'This chat was not notified; research still has it in their inbox.',
    );
    // And nothing is added on the happy path — the receipt is not a delivery
    // report, it just stops lying when there is something to report.
    expect(formatMissionCreated({ mission: ROW, reason: 'closest to the work' })).not.toContain(
      'not notified',
    );
  });

  it('has ONE spelling of the no-match refusal, and it names the owner', () => {
    // The two shipped spellings differed by quoting alone - `'deadbeef'` in the
    // chat router and `deadbeef` in update_mission - which is exactly the drift
    // that survives every behavioural test.
    expect(formatNoMatch({ owner: 'research', ref: 'deadbeef' })).toBe(
      "No mission matches 'deadbeef' for research.",
    );
  });

  it('says the column word on a transition, not the raw enum', () => {
    expect(formatStatusChanged({ ref: 'abc12345', status: 'done' })).toBe(
      'Mission abc12345 → Done.',
    );
    expect(formatStatusChanged({ ref: 'abc12345', status: 'in_progress' })).toContain('In Progress');
  });

  it('lists the accepted status words when one is rejected', () => {
    expect(formatUnknownStatus('in-review')).toBe(
      "Unknown status 'in-review'. Use: open, in_progress, blocked, in_review, done, cancelled, all.",
    );
  });

  it('distinguishes an OUTAGE from a user error, in words', () => {
    // The regression: an ambiguous prefix on `/mission done` was answered with
    // the outage sentence, telling the user their board was down when the board
    // was fine and their ref was short.
    const outage = formatBoardError(new Error('paperclip unavailable'));
    expect(outage).toBe('Mission board unavailable: paperclip unavailable');
    expect(formatAmbiguousRef({ owner: 'a', ref: 'x', ids: ['1', '2'] })).not.toContain(
      'unavailable',
    );
    expect(formatNoMatch({ owner: 'a', ref: 'x' })).not.toContain('unavailable');
  });

  it("bounds a hostile error message at the surfaces' own 300 chars", () => {
    expect(formatBoardError(new Error('e'.repeat(5000))).length).toBeLessThan(340);
  });

  it('owns the /help lines, so the advertisement cannot outlive the behaviour', () => {
    expect(MISSION_HELP_LINES).toHaveLength(2);
    expect(MISSION_HELP_LINES[0]).toContain(
      '/missions [open|in_progress|blocked|in_review|done|cancelled|all]',
    );
    expect(MISSION_HELP_LINES[1]).toContain('/mission `id`');
  });

  it('narrows the usage line to the sub-command that failed', () => {
    expect(formatMissionUsage('new')).toBe('Usage: /mission new `title`');
    expect(formatMissionUsage('done')).toBe('Usage: /mission done `id`');
    expect(formatMissionUsage()).toContain('/mission `id`');
  });

  it('refuses a missing tool argument in the shared words, not the tool’s own', () => {
    // The regression: `mission_id is required` was hand-typed six times across
    // the two tool files while this module's header claimed every user-visible
    // mission string lived here. `ToolResult.text` is relayed by the model, so
    // a tool's argument refusal is copy a person reads.
    expect(formatMissingArgument('mission_id')).toBe('`mission_id` is required');
  });

  it('says a wrong SUBSTRATE is not an outage, in different words', () => {
    // Both are "you cannot do that right now" and they are not the same
    // condition: the board is up, the verb does not exist on this substrate.
    // Same split as ambiguous-ref versus outage above.
    expect(formatWrongSubstrate()).toContain('Paperclip work engine');
    expect(formatWrongSubstrate()).not.toContain('unavailable');
  });
});

describe('formatAssignmentPush', () => {
  it('is ONE line, because it interrupts a conversation about something else', () => {
    // The regression: rendering a full card here. The push lands unprompted in
    // a Telegram bubble / Slack thread; a multi-line card reads as the answer
    // to the message the user just sent, which it is not.
    const out = formatAssignmentPush({ mission: { ...ROW, ownerAgent: 'ops' }, byAgent: 'research' });
    expect(out).not.toContain('\n');
    expect(out).toBe(
      'Mission [abc12345] "Ship the reconciler" assigned to ops by research (high priority).',
    );
  });

  it('carries the ref a human can type back, at the same 8-char width', () => {
    const out = formatAssignmentPush({ mission: ROW, byAgent: 'main' });
    expect(out).toContain(`[${missionRef(ROW.id)}]`);
  });

});

/**
 * A3-10, THE OVERSIZE HALF. The error path was mirrored from the start; this is
 * the path that was not. Bounding here rather than in four adapters is what
 * makes it mirrored BY CONSTRUCTION — there is only one string, so there is
 * only one length.
 */
describe('every returned string is bounded, for every input', () => {
  const HUGE = 'x'.repeat(20_000);
  const BOARD: Mission[] = Array.from({ length: 400 }, (_, i) => ({
    ...ROW,
    id: `${String(i).padStart(8, '0')}-1111-4111-8111-111111111111`,
    title: HUGE,
  }));

  it.each([
    ['a full board of 400 rows with 20k-char titles', () => formatMissionList(BOARD, { owner: HUGE, status: 'all' })],
    ['a card with a 20k-char body, title and reason', () => formatMissionCard({ ...ROW, title: HUGE, body: HUGE, assignmentReason: HUGE })],
    ['an ambiguous ref over the whole board', () => formatAmbiguousRef({ owner: HUGE, ref: HUGE, ids: BOARD.map((m) => m.id) })],
    ['a board error carrying a 20k-char message', () => formatBoardError(new Error(HUGE))],
    ['a no-match refusal for a 20k-char ref', () => formatNoMatch({ owner: HUGE, ref: HUGE })],
    ['a create receipt with a 20k-char reason', () => formatMissionCreated({ mission: { ...ROW, title: HUGE }, reason: HUGE })],
    ['an undelivered-push receipt with a 20k-char owner', () => formatMissionCreated({ mission: { ...ROW, ownerAgent: HUGE }, reason: HUGE, pushFailed: true })],
    ['a push for a 20k-char title', () => formatAssignmentPush({ mission: { ...ROW, title: HUGE }, byAgent: HUGE })],
  ])('%s still fits MISSION_REPLY_MAX_CHARS', (_name, render) => {
    // The regression, and it is silent in the direction that matters: 15 rows
    // of 255-char titles is 4225 characters, past Telegram's 4096 hard cap.
    // Unbounded, that board posts fine on Slack (35000) and VANISHES on
    // Telegram, whose handler discards sendMessage's result — the same board,
    // two different outcomes, no error anywhere.
    const out = render();
    expect(out.length).toBeLessThanOrEqual(MISSION_REPLY_MAX_CHARS);
  });

  it('stays under Telegram\'s hard cap with room to spare, and says so in one number', () => {
    // 4096 is the cap; 3000 is what Telegram's own prose path already splits
    // at, so a mission reply is never larger than a piece that path ships.
    expect(MISSION_REPLY_MAX_CHARS).toBeLessThan(4096);
    expect(MISSION_REPLY_MAX_CHARS).toBe(3000);
  });

  it('a truncated reply SAYS it was truncated instead of ending mid-word', () => {
    const out = formatMissionList(BOARD, { owner: 'research', status: 'all' });
    expect(out.endsWith('… (truncated)')).toBe(true);
  });

  it('leaves an ordinary board completely untouched', () => {
    // The bound must not be reachable in normal use — a truncated 3-row board
    // would mean the caps are wrong, not that the guard works.
    const normal = formatMissionList([ROW, TWIN], { owner: 'research', status: 'all' });
    expect(normal).not.toContain('truncated');
    expect(normal.length).toBeLessThan(200);
  });
});

/**
 * A3-10 / A3-5, THE PART THAT IS NOT ABOUT LENGTH: the same string must LOOK
 * the same on every surface, and each surface runs its own markdown pass over a
 * command reply before posting it. So the test is not "does the template avoid
 * markup" - it is "does the template survive both passes", asserted by running
 * the two real converters. Both are pure string -> string functions; nothing
 * here mocks or drives an adapter.
 *
 * Two families, because they have different jobs:
 *   BOARD COPY carries board data and must come out BYTE-IDENTICAL.
 *   HELP COPY has to print the literals a user types back - `<id>` (this repo's
 *     help idiom, used by /agent and /warroom too) and the raw `in_progress`
 *     enum - so it is asserted to be ESCAPED AND NOT RESTRUCTURED: Telegram
 *     HTML-escapes the angle brackets and shows them, Slack leaves them alone.
 */
describe('the copy renders identically on every surface', () => {
  const BOARD_COPY: [string, string][] = [
    ['list', formatMissionList([ROW, { ...ROW, status: 'blocked' }], { owner: 'a', status: 'all' })],
    ['card', formatMissionCard({ ...ROW, assignmentReason: 'because' })],
    ['ambiguous', formatAmbiguousRef({ owner: 'a', ref: 'abc12345', ids: [ROW.id, TWIN.id] })],
    ['no-match', formatNoMatch({ owner: 'a', ref: 'abc12345' })],
    ['status changed', formatStatusChanged({ ref: 'abc12345', status: 'done' })],
    ['board error', formatBoardError(new Error('paperclip unavailable'))],
    ['wrong substrate', formatWrongSubstrate()],
    ['assignment push', formatAssignmentPush({ mission: ROW, byAgent: 'main' })],
    ['create receipt', formatMissionCreated({ mission: ROW, reason: 'closest to the work' })],
    ['comment posted', formatCommentPosted(ROW.id)],
  ];

  const HELP_COPY: [string, string][] = [
    ['usage', formatMissionUsage()],
    ['usage new', formatMissionUsage('new')],
    ['unknown status', formatUnknownStatus('in-review')],
    ['missing argument', formatMissingArgument('mission_id')],
    ...MISSION_HELP_LINES.map((l, i) => [`help line ${i}`, l] as [string, string]),
  ];

  /**
   * THE PAYLOAD IS HOSTILE, because in production it is free text: a Paperclip
   * title this repo has no probe bounding, or a `create_mission` body the MODEL
   * wrote, where markdown bullets are the house style. The friendly rows above
   * only ever exercised the TEMPLATE, so four guarantees this module states —
   * "one line per mission", the push being newline-free, no line starting with
   * a marker, and both converters agreeing — were true of the template and
   * false of the string a user would actually see.
   */
  // `#` and `*` are here because the strip class OMITTED them while this
  // module's header promised the payload could not restructure a line: a body
  // of `ok\n# injected heading\n* bullet star` came out with both markers
  // intact, and Telegram rendered `<b>injected heading</b>` and a bullet.
  const HOSTILE_TEXT = 'ok\n- injected\n> quote\n# heading\n* star\n   indented';
  const HOSTILE_ROW: Mission = {
    ...ROW,
    title: HOSTILE_TEXT,
    body: HOSTILE_TEXT,
    assignmentReason: HOSTILE_TEXT,
  };
  const HOSTILE_COPY: [string, string][] = [
    ['hostile list', formatMissionList([HOSTILE_ROW], { owner: 'a', status: 'all' })],
    ['hostile card', formatMissionCard(HOSTILE_ROW)],
    ['hostile push', formatAssignmentPush({ mission: HOSTILE_ROW, byAgent: 'main' })],
    ['hostile no-match', formatNoMatch({ owner: 'a', ref: HOSTILE_TEXT })],
    ['hostile board error', formatBoardError(new Error(HOSTILE_TEXT))],
  ];

  it.each([...BOARD_COPY, ...HELP_COPY, ...HOSTILE_COPY])(
    'the %s template starts no line with a markdown marker',
    (_name, out) => {
      // THE REGRESSION, and it is the one the previous round shipped: every
      // list row opened `- `, and a leading dash is rewritten by each surface's
      // OWN markdown pass - Telegram's toTelegramHtml to a bullet, Slack to a
      // literal dash, the dashboard's marked to <ul><li>. Three different first
      // characters out of one shared string. The old regex only looked for
      // [*_`#<>] and could not see it.
      for (const line of out.split('\n')) expect(line).not.toMatch(/^[-+*#>\s]/);
    },
  );

  it.each(BOARD_COPY)('the %s template survives BOTH markdown passes byte-identical', (_name, out) => {
    expect(toTelegramHtml(out)).toBe(out);
    expect(markdownToMrkdwn(out)).toBe(out);
    // Belt and braces: no inline markup character at all in board copy.
    expect(out).not.toMatch(/[*_`#<>|]/);
  });

  it.each(HELP_COPY)('the %s line keeps its placeholders VISIBLE everywhere', (_name, out) => {
    // THE REGRESSION, and it was invisible copy on a whole surface: the idiom
    // used to be `<id>`, which survives Telegram (HTML-escaped and shown) and
    // Slack (untouched) but is DELETED by the dashboard's `marked` + DOMPurify
    // pass - marked emits <id> and <title> as HTML elements, neither is in
    // DOMPurify's default allowlist, and the user read "Usage: /mission  |
    // /mission new  | /mission done " with three blanks. A backtick is the one
    // placeholder idiom all three renderers SHOW.
    //
    // The dashboard's own renderer is deliberately NOT imported here: it lives
    // in `web/`, needs a DOM for DOMPurify, and asserting the absence of an
    // angle bracket is the same guarantee without dragging jsdom into a pure
    // unit test. (The rest of HELP_TEXT still uses `<id>` and is broken the
    // same way; that idiom is inherited and not this module's to fix.)
    expect(out).not.toMatch(/[<>]/);
    const tg = toTelegramHtml(out);
    expect(tg).not.toContain('&lt;');
    for (const span of out.match(/`([^`]+)`/g) ?? []) {
      expect(tg).toContain(`<code>${span.slice(1, -1)}</code>`);
    }
    expect(markdownToMrkdwn(out)).toBe(out);
    // And the one inline character that could still pair into markup: Slack
    // italicises `_x_` only at WORD BOUNDARIES, so what makes `in_progress`
    // safe is that its underscore is surrounded by word characters, not that
    // there is exactly one of them. This used to be asserted as a count of 1,
    // which was a coincidence of the four-word vocabulary and went red the
    // moment `in_review` joined it - two mid-word underscores are no more
    // markup than one. The property is the position, so assert the position.
    expect(out).not.toMatch(/(^|\W)_|_(\W|$)/);
  });

  it('a hostile payload cannot add a line to a one-line string', () => {
    // The four guarantees, checked against the payload rather than the
    // template. `cap()` flattens every single-line field; `capBody()` applies
    // the line-start rule per line to the one field that keeps its breaks.
    const [, list] = HOSTILE_COPY[0];
    expect(list.split('\n')).toHaveLength(2); // header + ONE line per mission
    const [, push] = HOSTILE_COPY[2];
    expect(push).not.toContain('\n'); // newline-free on purpose
    const [, card] = HOSTILE_COPY[1];
    // The card's body keeps its breaks and loses its markers, so the injected
    // bullet, quote and indent are all still READABLE - they just cannot open
    // a line any more.
    expect(card).toContain('\ninjected\nquote\nheading\nstar\nindented');
    expect(card).not.toContain('\n- ');
    expect(card).not.toContain('\n> ');
    expect(card).not.toContain('\n# ');
    expect(card).not.toContain('\n* ');
    // And the surface that PROVED it: an unstripped `#`/`*` came out of
    // `toTelegramHtml` as a bold heading and a bullet - the line structure
    // this header says the payload cannot choose.
    expect(toTelegramHtml(card)).not.toContain('<b>heading</b>');
    expect(toTelegramHtml(card)).not.toContain('• star');
  });

  it.each(HOSTILE_COPY)('neither converter restructures the %s', (_name, out) => {
    // The honest form of the byte-identical claim once a payload is in play: a
    // hostile title can still contribute INLINE characters (that is the
    // documented caveat - a mission title renders like any other agent prose),
    // but it can never change how many lines there are or what one starts with,
    // which is the property that made three surfaces disagree.
    const lines = out.split('\n').length;
    expect(toTelegramHtml(out).split('\n')).toHaveLength(lines);
    expect(markdownToMrkdwn(out).split('\n')).toHaveLength(lines);
    for (const line of markdownToMrkdwn(out).split('\n'))
      expect(line).not.toMatch(/^[-+*#>\s]/);
  });

  it('never emits a URL - a signed one would not survive a model round trip', () => {
    // registry.ts's ToolMedia comment records the production failure: a
    // presigned S3 URL retyped by the model lost its X-Amz-* query string and
    // returned AccessDenied. Missions carry no artifacts, so the correct amount
    // of URL handling in this module is none.
    const out = [...BOARD_COPY, ...HELP_COPY].map(([, v]) => v).join('\n');
    expect(out).not.toMatch(/https?:\/\//);
    expect(out).not.toContain('X-Amz-');
  });
});

/**
 * SOURCE SCAN 1 (A3-1): the shared piece lives in `src/lib/`, and the four chat
 * code paths never render mission copy themselves.
 */
/**
 * The phrases that ARE the mission vocabulary. The scan below looks for these
 * rather than for `format*` identifiers, because a name scan is what let four
 * spellings of the no-match refusal and a whole second board format survive the
 * last round: none of them mentioned a formatter, so none of them matched.
 */
const MISSION_PHRASES = [
  'No mission matches',
  'Mission board unavailable',
  'Usage: /mission',
  'Unknown status',
  'pass one of these full ids',
  'missions for ',
  'created. Owner:',
  'Comment posted on mission',
  'updated to',
  // The three sentences the tool files were still hand-typing while this
  // module's header claimed every user-visible mission string lived in it. The
  // scan matches a phrase at the START of a literal, which is why the argument
  // refusals are listed in full rather than as 'is required'.
  'Mission comments need',
  // Backticked, because that is what `formatMissingArgument` SHIPS (the
  // argument name is a literal the caller types back, and the dashboard eats an
  // un-backticked one). The scan matches at the START of a literal, so while
  // these carried the PRE-remediation un-backticked spellings a call site could
  // re-type today's sentence verbatim and pass the guard.
  '`mission_id` is required',
  '`body` is required',
  '`title` is required',
];

/** Strip comment lines: a scan for CODE must not be fooled by prose about it. */
async function codeOnly(file: string): Promise<string> {
  const src = await readFile(file, 'utf8');
  return src
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\/?\*)/.test(l))
    .join('\n');
}

describe('mission copy is produced in exactly one place', () => {
  const RENDERERS =
    /formatMissionList|formatMissionCard|formatAmbiguousRef|formatAssignmentPush|MISSION_STATUS_LABEL/g;

  it.each([
    'src/adapters/telegram/handler.ts',
    'src/adapters/slack/handler.ts',
    'src/adapters/dashboard/handler.ts',
  ])('%s calls no mission formatter of its own', async (file) => {
    const src = await readFile(file, 'utf8');
    expect(src.match(RENDERERS) ?? []).toHaveLength(0);
  });

  it('and the only production caller of the chat copy is the surface-agnostic command router', async () => {
    const router = await readFile('src/agent/commands.ts', 'utf8');
    expect(router).toContain("from '../lib/missions/format.js'");
    // One list render for the board, one card for a resolved ref, one card for
    // a freshly created mission, one refusal for an ambiguous ref.
    expect(router.match(/formatMissionList\(/g) ?? []).toHaveLength(1);
    expect(router.match(/formatMissionCard\(/g) ?? []).toHaveLength(2);
    // Two: the read path's `ambiguous` branch, and the catch that unwraps the
    // ACL's AmbiguousMissionPrefixError from the mutation path - the same
    // sentence for the same condition, which is why it is one function.
    expect(router.match(/formatAmbiguousRef\(/g) ?? []).toHaveLength(2);
    // And the router types NO mission string of its own (A3-4). Anything in
    // quotes here that reads like copy is a second spelling waiting to drift.
    const missionBody = router.slice(router.indexOf('async function missionCommand('));
    for (const phrase of MISSION_PHRASES) {
      expect(missionBody).not.toContain(`'${phrase}`);
      expect(missionBody).not.toContain(`\`${phrase}`);
    }
  });

  it.each([
    'src/lib/tools/mission-tools.ts',
    'src/lib/tools/paperclip-tools.ts',
    'src/lib/missions/mission-acl.ts',
    'src/adapters/telegram/handler.ts',
    'src/adapters/slack/handler.ts',
    'src/adapters/dashboard/handler.ts',
  ])('%s types no mission sentence of its own', async (file) => {
    // The scan that would have caught the shipped defect. `ToolResult.text` is
    // relayed to the user by the model, so a tool that hand-types a board line
    // is a second user-visible vocabulary, not an internal detail.
    const code = await codeOnly(file);
    for (const phrase of MISSION_PHRASES) {
      expect(code).not.toContain(`'${phrase}`);
      expect(code).not.toContain(`\`${phrase}`);
      expect(code).not.toContain(`"${phrase}`);
    }
  });

  it('and the assignment push has exactly ONE emission site, in src/lib/ (A3-3)', async () => {
    // If a feature fires from several places the shared piece is in the wrong
    // layer. `deliverToReplyChat` is the push primitive; only create_mission
    // may call it, and no adapter may. Comments are stripped first - an adapter
    // is allowed to NAME the primitive when explaining why it stamps an app
    // identity into replyChatId; it is not allowed to call it.
    for (const file of [
      'src/adapters/telegram/handler.ts',
      'src/adapters/slack/handler.ts',
      'src/adapters/dashboard/handler.ts',
    ]) {
      const code = await codeOnly(file);
      expect(code).not.toContain('formatAssignmentPush');
      expect(code).not.toContain('deliverToReplyChat');
    }
    const tool = await readFile('src/lib/tools/mission-tools.ts', 'utf8');
    expect(tool.match(/formatAssignmentPush\(/g) ?? []).toHaveLength(1);
    expect(tool.match(/await deliverToReplyChat\(/g) ?? []).toHaveLength(1);
  });
});

/**
 * SOURCE SCAN 2 (A3-4, the numbering rule): the ref is resolved by the shared
 * matcher over the shared window, at EVERY call site. This is the scan that
 * would have caught the shipped defect — all three call sites grepped
 * identically for `formatMission*`, because the divergence was in code none of
 * them shared.
 */
describe('one ref, one window, one matcher', () => {
  const CONSUMERS = [
    'src/agent/commands.ts',
    'src/lib/tools/paperclip-tools.ts',
    'src/lib/missions/mission-acl.ts',
  ];

  /** Comments describe the OLD matcher on purpose; only code is scanned. */
  const codeOf = codeOnly;

  it.each(CONSUMERS)('%s resolves through resolveMissionRef, not its own startsWith', async (file) => {
    const code = await codeOf(file);
    expect(code).toContain('resolveMissionRef(');
    // A hand-rolled prefix match on a mission id is the exact shape of the bug:
    // it grep-matches nothing shared, so three copies drift silently.
    expect(code).not.toMatch(/\.startsWith\(\s*(ref|verb|missionId|prefix)\b/);
  });

  it.each(CONSUMERS)('%s reads MISSION_RESOLVE_WINDOW rows, never a private number', async (file) => {
    const code = await codeOf(file);
    expect(code).toContain('MISSION_RESOLVE_WINDOW');
    // The three shipped literals were bare second arguments: 15 in the chat
    // router, 100 in paperclip_comment, 200 in the ACL.
    expect(code).not.toMatch(/listBoardMissions\([^,)]*,\s*\d+\s*\)/);
  });
});

/**
 * SOURCE SCAN 3 (A3-5, and the reason this phase exists): FOUR CODE PATHS, NOT
 * THREE SURFACES. Slack has TWO send paths — the main bot and the per-agent
 * apps — and the per-agent one is the classic omission. Every mission command
 * reaches a surface only because that surface renders `cmd.reply`, so counting
 * those renders per file is the only way to state the parity property.
 */
describe('every chat code path renders a slash-command reply', () => {
  it.each([
    // file, runCommand call sites, `cmd.reply` renders
    // 3 `cmd.reply` occurrences: the guard, the send, and — since A3-10 — the
    // size of a reply the send could NOT deliver. That third one is why the
    // result is no longer discarded: an undelivered command reply used to leave
    // no trace anywhere, so a vanished board looked exactly like a quiet one.
    ['src/adapters/telegram/handler.ts', 1, 3],
    // 3 call sites: the /slack/commands endpoint (which reads `result?.reply`),
    // the MAIN BOT message path, and the PER-AGENT APP path. 6 `cmd.reply`
    // occurrences = THREE per event path, the same three Telegram has: the
    // guard, the send, and — since A3-10 was mirrored here — the size of a
    // reply the send could not deliver. `postMessage` never throws (a missing
    // token and the `slack_posting` kill switch both come back `{ok:false}`),
    // so before that third one an undelivered board vanished on Slack alone.
    ['src/adapters/slack/handler.ts', 3, 6],
    ['src/adapters/dashboard/handler.ts', 2, 2],
  ] as const)('%s: %i entry points, %i reply renders', async (file, calls, renders) => {
    const src = await readFile(file, 'utf8');
    expect(src.split('runCommand(').length - 1).toBe(calls);
    expect(src.match(/cmd\.reply/g) ?? []).toHaveLength(renders);
  });

  it('and BOTH Slack send paths post it — the per-agent path is the forgotten one', async () => {
    const src = await readFile('src/adapters/slack/handler.ts', 'utf8');
    // The per-agent app resolves its own credentials, so its send carries a
    // tokenOverride the main bot's does not. Requiring both spellings is what
    // makes "we wired Slack" mean two paths instead of one.
    expect(src).toContain('await postMessage(channel, cmd.reply, { threadTs: ev.thread_ts });');
    expect(src).toMatch(/postMessage\(channel, cmd\.reply, \{[\s\S]{0,200}tokenOverride: botToken/);
  });
});

/**
 * SOURCE SCAN 4 (A3-11 / CLAUDE.md): a genuine gap is MARKED, not omitted.
 * There were zero such comments for Missions before this phase; this phase adds
 * exactly two, and each names the missing PRIMITIVE and the FALLBACK — the
 * shape the four pre-existing exemplars use.
 */
describe('every genuine parity gap is marked, each naming CLAUDE.md', () => {
  it("names CLAUDE.md at Slack's slash-command endpoint, the site with the hardcoded agent", async () => {
    const src = await readFile('src/adapters/slack/handler.ts', 'utf8');
    const gap = src.slice(
      src.indexOf('Parity gap, deliberate (see CLAUDE.md, "chat surface parity")'),
      src.indexOf("const result = await runCommand('main'"),
    );
    expect(gap).not.toBe('');
    // A justified skip names the missing primitive and the fallback - and the
    // justification must be TRUE. The previous round claimed Slack "gives us
    // nothing to build from", which is false: the message path resolves an
    // agent from the message text. So the comment now names the resolver it
    // cannot use and why the payload starves it.
    expect(gap).toContain('pickAgent');
    expect(gap).toContain('ARGUMENTS');
    expect(gap).toContain('channel-or-user');
    expect(gap).toContain('fallback');
  });

  it('and the per-agent Slack push identity is FIXED, not marked - so it needs no comment', async () => {
    // This is the third gap the previous round left unmarked AND unfixed:
    // both Slack paths built replyChatId from the channel alone, so a push
    // delivered from it went out with the workspace token on a per-agent app.
    // It is closed rather than declared, which is why there is no CLAUDE.md
    // comment for it - only these two facts, one per send path.
    const code = await codeOnly('src/adapters/slack/handler.ts');
    const ids = code.match(/replyChatId: `slack:[^`]*`/g) ?? [];
    expect(ids).toHaveLength(2);
    expect(ids.filter((i) => i.includes('app-'))).toHaveLength(1);
    expect(ids.filter((i) => !i.includes('app-'))).toHaveLength(1);
  });

  it("and Telegram's BOARD scope is FIXED, with the session scope marked as a gap", async () => {
    // The severe gap of the previous round, and the one it left unmarked: the
    // Telegram handler ran EVERY command as `main` because `pickAgent` answers
    // "who should talk" and both of its fallbacks are blind to which bot token
    // answered. A `/mission new` at the research bot therefore opened a mission
    // on main's board — the same command Slack's per-agent app got right.
    //
    // The BOARD half is CLOSED, not declared, so there is no parity-gap comment
    // for it. The SESSION half is the opposite and this is the assertion that
    // keeps the two apart: `runCommand`'s first argument stays `targetAgentId`,
    // because /newchat, /status, /context, /warroom, /endroom and /model write
    // the records ordinary chat reads, and moving THEM to the bot identity was
    // measured to make each one report success against a row nothing reads.
    const code = await codeOnly('src/adapters/telegram/handler.ts');
    expect(code).toContain('runCommand(sessionAgentId, chatId, commandText, { boardAgentId })');
    expect(code).toContain('const sessionAgentId = targetAgentId;');
    // The bot identity is what the BOARD scopes to, and an explicit /agent or
    // @mention still out-ranks it.
    expect(code).toMatch(/boardAgentId\s*=[\s\S]{0,160}botAgentId/);

    const src = await readFile('src/adapters/telegram/handler.ts', 'utf8');
    const board = src.slice(
      src.indexOf('A MISSION COMMAND ACTS ON THE BOARD OF THE BOT THAT RECEIVED IT'),
      src.indexOf('const boardAgentId'),
    );
    expect(board).not.toBe('');
    expect(board).toContain('CLAUDE.md');

    // The session scope is a GENUINE skipped scope, so it carries the same
    // shape every other marked gap in this repo does: CLAUDE.md, the missing
    // primitive, the fallback.
    const gap = src.slice(
      src.indexOf('PARITY GAP, DELIBERATE (see CLAUDE.md, "chat surface parity"). ONLY the'),
      src.indexOf('const sessionAgentId'),
    );
    expect(gap).not.toBe('');
    expect(gap).toContain('CANNOT BE SEPARATED');
    expect(gap).toContain('THE MISSING PRIMITIVE');
    expect(gap).toContain('per-bot sessions');
    expect(gap).toContain('FALLBACK');
  });

  it('names CLAUDE.md where the dashboard cannot receive the assignment push', async () => {
    const src = await readFile('src/lib/tools/mission-tools.ts', 'utf8');
    const marker = 'PARITY GAP, DELIBERATE (see CLAUDE.md, "chat surface parity")';
    expect(src).toContain(marker);
    const gap = src.slice(src.indexOf(marker), src.indexOf('if (owner !== self && ctx.replyChatId)'));
    // The missing primitive: an out-of-band channel into dashboard chat.
    expect(gap).toContain('out-of-band');
    expect(gap).toContain('request/response');
    // The fallback: the Missions tab, which the chat surfaces do not have.
    expect(gap).toContain('fallback');
    expect(gap).toContain('Missions tab');
  });

  it('and marks it AT THE DASHBOARD CALL SITE that skips it, both routes', async () => {
    // A3-11's four exemplars all sit at the ADAPTER call site that skips the
    // feature, not at the emission site that offers it. The note above is at
    // the emission site, where a dashboard maintainer reading their own handler
    // never sees it - and "no replyChatId" is an ABSENT line of code, the one
    // kind of gap that is invisible without a comment. Both routes, because the
    // streamed and non-streamed chat consoles construct the request separately.
    const src = await readFile('src/adapters/dashboard/handler.ts', 'utf8');
    const marks = src.match(/PARITY GAP, DELIBERATE \(see CLAUDE\.md, "chat surface parity"\)/g) ?? [];
    expect(marks).toHaveLength(2);
    // Each names the missing primitive and points at the long note.
    expect(src).toContain('out-of-band channel');
    expect(src.match(/src\/lib\/tools\/mission-tools\.ts/g) ?? []).toHaveLength(2);
    // And the gap is real: the handler passes no replyChatId anywhere.
    const code = await codeOnly('src/adapters/dashboard/handler.ts');
    expect(code).not.toContain('replyChatId');
  });
});
