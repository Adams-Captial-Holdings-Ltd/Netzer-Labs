/**
 * The dashboard's hierarchy derivation (`web/src/lib/missions-hierarchy.ts`),
 * pinned against the wire that was actually MEASURED.
 *
 * WHY THIS FILE LIVES UNDER src/ AND NOT BESIDE THE MODULE IT COVERS. The web
 * tree has no test runner, and the root vitest `include` is
 * `src|infra|scripts` only. A web/ module imported from a test under src/
 * enters the root program anyway — tsconfig `exclude: ["web"]` filters the
 * include globs, not import-reachable files — which is exactly how
 * `chat-stream.test.ts` and `chat-helpers.test.ts` already cover the SPA's
 * chat helpers. Hence the `.js` specifier: the root program is NodeNext.
 * `missions-hierarchy.ts` has zero imports and touches no DOM, so importing it
 * drags in nothing else. The helper shipped with e3174eb proven only by a
 * throwaway harness in a session scratchpad; this file is that proof, kept.
 *
 * WHAT IS BEING PINNED — the 2026-09-06 P1-1 live run, recorded in
 * `docs/features/paperclip/README.md` section 6 ("Issue hierarchy and
 * blocking"), read every route that could plausibly carry hierarchy state:
 *
 *   - `parentId` is `string uuid | null`: an explicit `null` on a root row,
 *     and ABSENT on a legacy DynamoDB-substrate row. Those are different keys,
 *     not different values, and only one of them survives `in`.
 *   - There is NO `children` and NO `childCount` key on Paperclip anywhere —
 *     not on a 201, not on a list row, not on the detail. `childCount` is
 *     NETZAR-derived, by grouping the already-fetched board by `parentId`
 *     (`childCountsByParent` in `src/lib/missions/mission-acl.ts`), and it is
 *     ABSENT — never `0` — for a row that read saw no children for.
 *   - `blockerAttention` is the ONLY blocking-related signal on a LIST row;
 *     the two states that run observed were `none` and `needs_attention`, and
 *     the ACL narrows the eight-key object to the `{state, reason}` pair.
 *   - `blockedBy` is deliberately NOT on the wire (`mission-acl.ts`:176-184):
 *     it exists only on `GET /api/issues/{id}`, and as an array of OBJECTS
 *     rather than the array of ids the P1-2 plan assumed. Nothing here may
 *     read it, so nothing here tests it.
 *   - `status: 'blocked'` is NOT dependency state on this artifact: Paperclip
 *     rewrites status to `blocked` after an `adapter_failed` run. That is why
 *     `isBlocked` reads `blockerAttention` and never `status`.
 *
 * The case that matters most is the last describe: a legacy row carries NONE
 * of these keys, and every helper must degrade to `undefined` / `[]` / `false`
 * for it rather than throwing.
 *
 * `BLOCKER_STATE_CLEAR` is module-private, so it is pinned through `isBlocked`
 * by its literal measured value rather than imported.
 */
import { describe, it, expect } from 'vitest';
import {
  parentOf,
  childrenOf,
  isBlocked,
  rawStatusLabel,
} from '../../../web/src/lib/missions-hierarchy.js';
import type { HierarchyMission } from '../../../web/src/lib/missions-hierarchy.js';

/**
 * A Paperclip-substrate list row. `parentId` is PRESENT on every one of them —
 * `null` when the row is a root — because the projection always has a value
 * for it. Anything the caller does not override is left off the object
 * entirely, the way `toWireMission` spreads each P1-2 field on presence.
 */
function row(overrides: Partial<HierarchyMission> & { id: string }): HierarchyMission {
  return { parentId: null, ...overrides };
}

/**
 * A legacy DynamoDB-substrate row: the ten legacy keys and not one of the four
 * P1-2 additions. The keys are MISSING, not set to `undefined` — an assigned
 * `undefined` is an absent key to `JSON.stringify` but a present one to `in`,
 * and the ACL is asserted with both.
 */
function legacyRow(id: string): HierarchyMission {
  return { id };
}

/** The caller's own row type, which the helpers are generic over. */
interface BoardRow extends HierarchyMission {
  title: string;
}

/**
 * One flattened cross-agent board, in the order `Missions.tsx` concatenated its
 * per-owner fetches: the roots first, then children, then an orphan whose
 * parent lives on a board this SPA never loaded, then a legacy row.
 *
 * `epic` claims `childCount: 1` while the flattened board holds TWO of its
 * children — the documented divergence between the server's single
 * owner-scoped count and the cross-agent board the SPA assembled.
 */
const epic: BoardRow = { ...row({ id: 'e1', childCount: 1 }), title: 'Epic' };
const lonely: BoardRow = { ...row({ id: 'e2' }), title: 'Second root, no children' };
const childB: BoardRow = { ...row({ id: 'c2', parentId: 'e1' }), title: 'Child B' };
const childA: BoardRow = { ...row({ id: 'c1', parentId: 'e1' }), title: 'Child A' };
const orphan: BoardRow = { ...row({ id: 'o1', parentId: 'not-loaded' }), title: 'Orphan' };
const legacy: BoardRow = { ...legacyRow('L1'), title: 'Legacy DynamoDB row' };

/** Deliberately NOT in id order: `filter` and `find` must not reorder it. */
const board: readonly BoardRow[] = [epic, lonely, childB, childA, orphan, legacy];

describe('parentOf — the loaded parent, or nothing to show', () => {
  it("resolves the loaded row whose ID is the mission's parentId", () => {
    expect(parentOf(board, childA)).toBe(epic);
  });

  it('matches on the candidate row\'s ID, so a SIBLING sharing the same parentId is never mistaken for the parent', () => {
    // childA and childB both carry parentId 'e1'. Only the row whose *id* is
    // 'e1' is the parent; reading the wrong field would answer childB here,
    // because childB comes first in board order.
    expect(parentOf(board, childA)).not.toBe(childB);
    expect(parentOf(board, childA)?.id).toBe('e1');
  });

  it('an explicit null parentId is a ROOT row, and a root has no parent to show', () => {
    expect(epic.parentId).toBeNull();
    expect(parentOf(board, epic)).toBeUndefined();
  });

  it('an ABSENT parentId is a legacy row — the key is missing rather than null, and there is still no parent', () => {
    expect('parentId' in legacy).toBe(false);
    expect(parentOf(board, legacy)).toBeUndefined();
  });

  it('a parentId whose row was never loaded answers undefined instead of throwing', () => {
    // The board failed to load, or the parent is owned by an agent outside the
    // current scope, or it fell past the server's 100-row limit.
    expect(orphan.parentId).toBe('not-loaded');
    expect(parentOf(board, orphan)).toBeUndefined();
  });

  it('a blank parentId is treated as no parent at all, never searched for', () => {
    // The row with the BLANK ID is what makes this test able to fail, and so
    // what pins the helper's `if (!parentId) return undefined` guard. Without
    // that guard `rows.find((r) => r.id === '')` MATCHES this row and the modal
    // renders a phantom parent. Searching and finding nothing is not the same
    // as never searching, and only a blank-id row can tell the two apart.
    const blank = row({ id: 'b1', parentId: '' });
    const blankId: BoardRow = { ...row({ id: '' }), title: 'Row whose own id is blank' };
    expect(parentOf([...board, blankId, { ...blank, title: 'Blank' }], blank)).toBeUndefined();
  });

  it("hands back the CALLER'S row type, so the modal can render fields these helpers never read", () => {
    const found = parentOf(board, childB);
    expect(found?.title).toBe('Epic');
  });

  it('finds nothing on an empty board rather than failing', () => {
    expect(parentOf([], childA)).toBeUndefined();
  });
});

describe('childrenOf — the loaded children, in board order', () => {
  it('returns every loaded row naming the mission as its parent, in the order the board flattened them', () => {
    expect(childrenOf(board, epic).map((r) => r.id)).toEqual(['c2', 'c1']);
  });

  it('is derived from parentId alone and never consults childCount, so it can return MORE children than the server counted', () => {
    // The server counted the children of ONE owner-scoped read; the SPA holds
    // the flattened cross-agent board, which can hold children that read never
    // saw. The helper must report what is loaded, not what was counted.
    expect(epic.childCount).toBe(1);
    expect(childrenOf(board, epic)).toHaveLength(2);
  });

  it('a row the server saw no children for OMITS childCount entirely — absent, never 0 — and the derivation agrees', () => {
    // `childCountsByParent` is a Map and `toWireMission` spreads the key only
    // when the lookup hit, so a childless row has no key at all. A helper that
    // rendered `0` here would be inventing a field the wire does not carry.
    expect('childCount' in lonely).toBe(false);
    expect(childrenOf(board, lonely)).toEqual([]);
  });

  it('answers the empty array, never undefined, so the caller can render a list unconditionally', () => {
    const children = childrenOf(board, childA);
    expect(children).toEqual([]);
    expect(Array.isArray(children)).toBe(true);
  });

  it('root rows (parentId null) and legacy rows (parentId absent) are never counted as anyone\'s children', () => {
    // Every id on the board, asked for its children: only the epic has any.
    const withChildren = board.filter((r) => childrenOf(board, r).length > 0).map((r) => r.id);
    expect(withChildren).toEqual(['e1']);
  });

  it('a legacy row has no children even on a board full of Paperclip rows', () => {
    expect(childrenOf(board, legacy)).toEqual([]);
  });

  it('returns the caller\'s own rows, not copies, so identity checks in the modal hold', () => {
    expect(childrenOf(board, epic)).toEqual([childB, childA]);
    expect(childrenOf(board, epic)[0]).toBe(childB);
  });
});

describe('isBlocked — blockerAttention is the whole list-row signal', () => {
  const attention = (state: string, reason: string | null = null): HierarchyMission =>
    row({ id: 'a1', blockerAttention: { state, reason } });

  it("the measured clear state 'none' is not blocking", () => {
    expect(isBlocked(attention('none'))).toBe(false);
  });

  it("the measured attention state 'needs_attention' IS blocking", () => {
    expect(isBlocked(attention('needs_attention'))).toBe(true);
  });

  it('a state this artifact has not shown us yet surfaces as blocking rather than being silently swallowed', () => {
    expect(isBlocked(attention('stalled'))).toBe(true);
    expect(isBlocked(attention('some_future_state'))).toBe(true);
  });

  it('a legacy row, which carries no blockerAttention at all, is not blocking', () => {
    expect('blockerAttention' in legacy).toBe(false);
    expect(isBlocked(legacy)).toBe(false);
  });

  it('an empty or whitespace-only state is not blocking — it is not a state, it is a blank', () => {
    expect(isBlocked(attention(''))).toBe(false);
    expect(isBlocked(attention('   '))).toBe(false);
  });

  it('whitespace around the clear state is still clear', () => {
    expect(isBlocked(attention('  none  '))).toBe(false);
  });

  it('the reason never decides the verdict — only the state does', () => {
    expect(isBlocked(attention('needs_attention', null))).toBe(true);
    expect(isBlocked(attention('none', 'waiting on 2 unresolved blockers'))).toBe(false);
  });

  it("status 'blocked' is NOT the signal: on this artifact it means runs are failing, not that a dependency is unmet", () => {
    // Measured 2026-09-06: Paperclip rewrites status to `blocked` after an
    // `adapter_failed` run on issues with no blockers at all, and left an
    // issue with an unresolved blockedByIssueIds edge sitting at `todo`.
    const failingRuns = row({
      id: 's1',
      paperclipStatus: 'blocked',
      blockerAttention: { state: 'none', reason: null },
    });
    const realDependency = row({
      id: 's2',
      paperclipStatus: 'todo',
      blockerAttention: { state: 'needs_attention', reason: 'blocked by NZ-4' },
    });
    expect(isBlocked(failingRuns)).toBe(false);
    expect(isBlocked(realDependency)).toBe(true);
  });

  it('a blockerAttention whose state is not a string is not blocking — the wire is untyped JSON at runtime', () => {
    const malformed = { id: 'm1', blockerAttention: { state: 7, reason: null } };
    expect(isBlocked(malformed as unknown as HierarchyMission)).toBe(false);
  });
});

describe("rawStatusLabel — Paperclip's own word, verbatim", () => {
  it('returns the raw status UNMAPPED, which is the entire point of showing it beside the humanised one', () => {
    expect(rawStatusLabel(row({ id: 'r1', paperclipStatus: 'in_progress' }))).toBe('in_progress');
    expect(rawStatusLabel(row({ id: 'r2', paperclipStatus: 'blocked' }))).toBe('blocked');
  });

  it('a legacy row has no raw status to show', () => {
    expect('paperclipStatus' in legacy).toBe(false);
    expect(rawStatusLabel(legacy)).toBeUndefined();
  });

  it('a blank or whitespace-only raw status renders nothing, so the caller draws no empty block', () => {
    expect(rawStatusLabel(row({ id: 'r3', paperclipStatus: '' }))).toBeUndefined();
    expect(rawStatusLabel(row({ id: 'r4', paperclipStatus: '   ' }))).toBeUndefined();
  });

  it('does not clean up the value it returns: the guard trims, the label does not', () => {
    // Verbatim is the contract. If this ever needs trimming, that is a
    // rendering decision and belongs to the caller.
    expect(rawStatusLabel(row({ id: 'r5', paperclipStatus: ' in_progress ' }))).toBe(
      ' in_progress ',
    );
  });

  it('a non-string raw status on the untyped wire shows nothing', () => {
    const malformed = { id: 'r6', paperclipStatus: 3 };
    expect(rawStatusLabel(malformed as unknown as HierarchyMission)).toBeUndefined();
  });
});

describe('the legacy DynamoDB row — the degradation that matters most', () => {
  it('carries none of the four P1-2 hierarchy keys, and every helper degrades rather than throwing', () => {
    // The fixture guard and the behaviour it guards belong in ONE test. Alone,
    // the key-absence assertions pin `legacyRow` and cannot fail on any change
    // to `missions-hierarchy.ts` — and if `legacyRow` ever gained one of these
    // keys, the four assertions below would silently stop testing degradation
    // and start exercising the Paperclip path under a legacy name.
    expect(Object.keys(legacyRow('L1'))).toEqual(['id']);
    for (const key of ['parentId', 'paperclipStatus', 'blockerAttention', 'childCount']) {
      expect(key in legacy).toBe(false);
    }
    expect(parentOf(board, legacy)).toBeUndefined();
    expect(childrenOf(board, legacy)).toEqual([]);
    expect(isBlocked(legacy)).toBe(false);
    expect(rawStatusLabel(legacy)).toBeUndefined();
  });

  it('degrades the same way on a board that is ENTIRELY legacy — the pre-flip Missions tab', () => {
    const legacyBoard = [legacyRow('L1'), legacyRow('L2'), legacyRow('L3')];
    for (const mission of legacyBoard) {
      expect(parentOf(legacyBoard, mission)).toBeUndefined();
      expect(childrenOf(legacyBoard, mission)).toEqual([]);
      expect(isBlocked(mission)).toBe(false);
      expect(rawStatusLabel(mission)).toBeUndefined();
    }
  });
});
