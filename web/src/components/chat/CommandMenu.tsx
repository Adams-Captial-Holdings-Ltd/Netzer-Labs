/*
 * Structure ported from danny-avila/LibreChat (MIT), pinned at commit
 * 6d499ba3ce17f906a7762429c61018f230ecd64e — donor paths
 * `client/src/components/Chat/Menus/Endpoints/CustomMenu.tsx`,
 * `client/src/components/Chat/Menus/Endpoints/ModelSelector.tsx` and
 * `client/src/components/Chat/Menus/Endpoints/components/EndpointItem.tsx`.
 *
 * What is ported: the SHAPE of the donor's endpoint→model picker. A pill
 * trigger opens a popover whose first element is a search field; below it a
 * grouped list; a group row opens a submenu that carries a search field of its
 * own; the current choice is marked with a check on both levels; and typing at
 * the top level abandons the grouping and shows flat results across every
 * group (the donor's `searchResults ? renderSearchResults(...) : <groups>`).
 * Donor tokens are translated onto this app's own; no donor colour survives.
 *
 * What is NOT ported: Ariakit. The donor gets its popover, its combobox, its
 * roving focus and its nested menu stores from `@ariakit/react`, and this app
 * runs Preact with no react/compat alias and exactly one new runtime
 * dependency. Everything below — placement, keyboard model, focus return — is
 * written against the DOM directly.
 *
 * ── Why a search field on a picker at all ──────────────────────────────────
 *
 * Because the roster is not three items. The platform ships seventeen agent
 * templates and a deployment adds its own on top, so the agent picker is a
 * list that has to stay usable at a length no dropdown survives by scrolling.
 * A search field is the difference between "pick your agent" and "scroll until
 * you find it", and it is the reason this control is a menu rather than a
 * <select>.
 *
 * ── Why the popover is `position: fixed` ───────────────────────────────────
 *
 * The header this menu hangs from is a sticky child of the transcript's
 * scrollport, and that scrollport is `overflow-x-hidden` (ChatCanvas). An
 * absolutely-positioned popover is laid out inside that box, so a submenu
 * flying out to the right is clipped at the column edge — silently, and only
 * at some viewport widths. A fixed element is positioned against the viewport
 * and is not clipped by an ancestor's overflow (no ancestor here establishes a
 * containing block for it), so the menu is measured from the trigger's rect
 * and placed in viewport coordinates instead. That also buys the vertical flip
 * for free: up when there is no room below.
 *
 * ── The submenu is anchored to its ROW, and its room is RESERVED ───────────
 *
 * A flyout has to say which row it came from. Two rules do that, and each one
 * replaces an earlier cut that broke the link:
 *
 *   1. When it opens at all, it opens to the RIGHT — because `place()` has
 *      already reserved the second column BEFORE anything opened, clamping the
 *      root panel's left edge to `vw - GAP - (2·width + GAP)`. The previous cut
 *      aligned the root to its trigger and then flipped the submenu LEFT when
 *      the flyout no longer fit, which threw it back across the full width of
 *      its own parent and onto the conversation rail behind it — a panel that
 *      covers the page instead of extending the menu. Reserving up front costs
 *      the root panel some trigger alignment, and that cost is CAPPED at
 *      `TRIGGER_KEEP`: a menu whose flyout cannot be bought without dragging
 *      the root off its own trigger has no honest place for a second column at
 *      that size, and becomes a drill-down instead (which is also, not
 *      coincidentally, exactly the case where the shifted panel would have
 *      landed on the conversation rail itself). So there is no horizontal flip
 *      case left in this file to get wrong: the flyout is placed where it was
 *      already known to fit, or it is not placed.
 *
 *   2. It is centred on the branch ROW that opened it — not on the panel that
 *      contains that row — measured from the live row rect and the submenu's
 *      own height, then clamped into the viewport. Inheriting the root panel's
 *      `top` is what the previous cut did: with a family row two thirds of the
 *      way down the list, the submenu's bottom edge finished 142px ABOVE its
 *      own trigger row with page background showing between the two panels.
 *      Centring is re-run on scroll and resize because the row moves under it —
 *      the root list scrolls, and the capture-phase scroll listener sees that
 *      (a scroll event does not bubble, but it does capture).
 *
 * When neither rule can be satisfied — a narrow window, or a trigger too far
 * right to pay for the reservation — the submenu covers the root panel instead
 * and the menu becomes a drill-down, with its own Back control. That is a
 * measured outcome of the geometry rather than a viewport breakpoint, so it
 * cannot disagree with what actually fits.
 *
 * ── A list that scrolls has to SAY it scrolls ──────────────────────────────
 *
 * The agent roster is eighteen rows on this deployment and the panel is capped
 * at 60% of the viewport, so eight of them are on screen. Until this cut,
 * nothing said so. Chromium's overlay scrollbar — which the global
 * `* { scrollbar-width: thin }` in index.css forces on every scroller in the
 * app — paints NOTHING at rest and takes 0px of layout, so the eighth row was
 * sliced at a hard horizontal seam against the panel's own border and the
 * correct reading of that frame was "eighteen agents exist, here are the eight
 * you get". On the surface whose acceptance test is *every agent is reachable*,
 * that is the whole product failing in a still frame.
 *
 * Three affordances, because each one alone can be missed:
 *
 *   1. A REAL SCROLLBAR — `.chat-menu-list` in index.css hands the standard
 *      properties back to `auto` so the styled `::-webkit-scrollbar` rules are
 *      obeyed again. Always painted, always 10px of layout, and its thumb is
 *      proportional: a thumb covering 44% of the track states the ratio.
 *   2. A BOTTOM RAMP, so the seam becomes a fade rather than a cut, and a TOP
 *      ramp once the list has been scrolled off its first row (which is the
 *      only cue that the top is not the top).
 *   3. THE COUNT OF WHAT IS BELOW, measured — not "there is more" but "10
 *      more", so the reader knows whether to scroll or to type.
 *
 * All three are driven from one measurement of the live scroller
 * (`useListOverflow`), re-run on scroll, on every keystroke that changes the
 * row set, and whenever the panel is re-sized by `place()`. The state is
 * published on the listbox as `data-overflow` so the roll-call harness asserts
 * the affordance instead of trusting it.
 *
 * ── The keyboard model is a combobox, not a roving tabstop ─────────────────
 *
 * Focus stays in the search input for the whole interaction and the active row
 * is published with `aria-activedescendant`. The alternative — moving DOM
 * focus onto each row — means every arrow key press steals focus from the
 * field you are typing into, so type-to-filter and arrow-to-move cannot both
 * work. Trigger is `aria-haspopup="listbox"`; each panel's field is a
 * `role="combobox"` pointing at that panel's own list; rows are
 * `role="option"`; a section is a real `role="group"` with its own label; and
 * a row that opens a submenu is an option carrying `aria-haspopup="listbox"`
 * plus `aria-expanded`.
 *
 * The two panels are two listboxes, each with its own ids, and only the panel
 * whose field has focus publishes an active descendant. Sharing one id space
 * across both would put two `data-active` rows and two copies of every option
 * id in the document the moment a submenu opened.
 *
 * Escape unwinds one level at a time (submenu → root → closed) and the last
 * Escape puts focus back on the trigger, which is the only place it can go
 * that does not lose the user's position on the page.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { ArrowLeft, Check, ChevronDown, ChevronRight, Search } from 'lucide-preact';
import type { JSX, RefObject } from 'preact';

/** A non-interactive section label. Becomes a real `role="group"` wrapper. */
export interface MenuGroupRow {
  type: 'group';
  key: string;
  label: string;
}

/** A selectable row. Choosing it runs `onSelect` and closes the menu. */
export interface MenuOptionRow {
  type: 'option';
  key: string;
  label: string;
  /** Right-aligned secondary text — a model's context window, an agent id. */
  hint?: string;
  /** Second line under the label. Truncated to one line by default. */
  description?: string;
  /**
   * Let the description run to two lines instead of truncating at one.
   *
   * Off by default because a long list of rows that each wrap is a list you
   * cannot scan. It is opt-in for the rows whose description is not a nicety
   * but the POINT of the row — the model picker's two default choices read
   * identically until their descriptions diverge, and truncating them at one
   * line cut the sentence exactly where the difference was stated.
   */
  wrapDescription?: boolean;
  /** Small pill after the label (e.g. "Platform default"). */
  badge?: string;
  selected?: boolean;
  onSelect: () => void;
}

/** A row that opens a submenu. Never selects anything by itself. */
export interface MenuBranchRow {
  type: 'branch';
  key: string;
  label: string;
  hint?: string;
  description?: string;
  wrapDescription?: boolean;
  badge?: string;
  /** True when the current selection lives inside this branch. */
  selected?: boolean;
}

export type MenuRow = MenuGroupRow | MenuOptionRow | MenuBranchRow;

export interface MenuPanel {
  /** Heading above a submenu's search field. Unused on the root panel. */
  title?: string;
  /** Placeholder AND accessible name for this panel's search field. */
  searchLabel: string;
  /** Accessible name for this panel's listbox. */
  listLabel: string;
  /** Already filtered against this panel's own query by the caller. */
  rows: MenuRow[];
  /** Shown when `rows` holds no selectable row. */
  emptyLabel: string;
}

export interface CommandMenuProps {
  /** Visible text on the trigger — the current selection. */
  triggerLabel: string;
  /** Accessible name for the trigger (the label alone reads as a bare value). */
  triggerAriaLabel: string;
  /** `title` attribute, for the truncated case. */
  triggerTitle?: string;
  triggerIcon?: JSX.Element;
  /** Extra classes for the trigger, e.g. its max width. */
  triggerClass?: string;
  disabled?: boolean;
  /** Root panel, rebuilt on every keystroke of the root search field. */
  panel: (query: string) => MenuPanel;
  /** Submenu panel for a branch key, rebuilt on every keystroke of its field. */
  branchPanel?: (branchKey: string, query: string) => MenuPanel;
  /** Stable hook for tests and capture scripts; also lands on the popovers. */
  menuName: string;
}

/** Popover width, and the gap between the root panel and a submenu. */
const PANEL_W = 352;
const GAP = 8;
/**
 * How much of its trigger the root panel must still cover after being shifted
 * left to make room for a flyout.
 *
 * This is the price cap on the reservation. A popover that no longer touches
 * the control that opened it has stopped reading as that control's popover,
 * and a panel dragged that far left is also a panel dragged out over whatever
 * sits behind the menu — at 1024 the reservation, left uncapped, put the root
 * panel at x=304…656 against a trigger at x=776…931: zero overlap, and square
 * on top of the conversation rail. When the flyout cannot be bought for less
 * than this, the menu drills down instead of buying it anyway.
 */
const TRIGGER_KEEP = 96;

interface Box {
  left: number;
  width: number;
  maxHeight: number;
  /** Ceiling for the submenu, which is centred on a row rather than hung off
   *  the trigger, so the space on one side of the trigger does not bound it. */
  subMaxHeight: number;
  top?: number;
  bottom?: number;
}

type ActionableRow = MenuOptionRow | MenuBranchRow;

function selectableRows(rows: MenuRow[]): ActionableRow[] {
  return rows.filter((r): r is ActionableRow => r.type !== 'group');
}

/** What a list's scroll position leaves out of view, measured not assumed. */
interface Overflow {
  /** Rows exist above the visible slice. */
  up: boolean;
  /** Rows exist below it. */
  down: boolean;
  /** How many option rows are not fully visible below the fold. */
  more: number;
}

const NO_OVERFLOW: Overflow = { up: false, down: false, more: 0 };

function overflowState(o: Overflow): 'none' | 'up' | 'down' | 'both' {
  if (o.up && o.down) return 'both';
  if (o.up) return 'up';
  if (o.down) return 'down';
  return 'none';
}

/**
 * Measure what a scrollable list is hiding.
 *
 * `signal` is a string the caller rebuilds whenever the row set or the panel
 * box changes; it is what re-runs the measurement after a keystroke filters the
 * list or `place()` re-caps its height. A ResizeObserver covers the rest (the
 * window resizing under an open menu), and the list's own `onScroll` covers
 * scrolling. There is no polling and no interval.
 *
 * The 1px tolerances are not decoration: `scrollHeight`, `clientHeight` and
 * `scrollTop` are fractional on a zoomed or fractionally-scaled display, and a
 * 0.5px residue at the end of a scroll would otherwise keep claiming there is
 * "more" below with nothing left to show.
 */
function useListOverflow(ref: RefObject<HTMLDivElement>, signal: string) {
  const [edges, setEdges] = useState<Overflow>(NO_OVERFLOW);

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) {
      setEdges((prev) => (prev === NO_OVERFLOW ? prev : NO_OVERFLOW));
      return;
    }
    const up = el.scrollTop > 1;
    const down = el.scrollHeight - el.clientHeight - el.scrollTop > 1;
    // Counted from live rects rather than from row heights, because rows are
    // not a uniform height here — a row with a wrapped description is taller
    // than one without, so "how many fit" cannot be divided out.
    let more = 0;
    if (down) {
      const cut = el.getBoundingClientRect().bottom;
      for (const row of el.querySelectorAll('[role="option"]')) {
        if (row.getBoundingClientRect().bottom > cut + 1) more += 1;
      }
    }
    setEdges((prev) =>
      prev.up === up && prev.down === down && prev.more === more ? prev : { up, down, more },
    );
  }, [ref]);

  useLayoutEffect(() => {
    measure();
  }, [measure, signal]);

  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref, measure, signal]);

  return { edges, measure };
}

/**
 * Split a flat row list into segments so the rows under a `group` row can be
 * wrapped in a real `role="group"`. Rows before the first group row form an
 * unlabelled leading segment.
 */
function segment(rows: MenuRow[]): Array<{ label?: string; key: string; rows: ActionableRow[] }> {
  const out: Array<{ label?: string; key: string; rows: ActionableRow[] }> = [];
  let current: { label?: string; key: string; rows: ActionableRow[] } = { key: '__lead__', rows: [] };
  for (const row of rows) {
    if (row.type === 'group') {
      if (current.rows.length > 0) out.push(current);
      current = { label: row.label, key: row.key, rows: [] };
    } else {
      current.rows.push(row);
    }
  }
  if (current.rows.length > 0) out.push(current);
  return out;
}

export function CommandMenu({
  triggerLabel,
  triggerAriaLabel,
  triggerTitle,
  triggerIcon,
  triggerClass = '',
  disabled = false,
  panel,
  branchPanel,
  menuName,
}: CommandMenuProps) {
  const [open, setOpen] = useState(false);
  const [rootQuery, setRootQuery] = useState('');
  const [branchKey, setBranchKey] = useState<string | null>(null);
  const [branchQuery, setBranchQuery] = useState('');
  const [active, setActiveState] = useState(0);
  // The active index is ALSO held in a ref, and the ref is what the key
  // handler reads. Preact batches state, so two key presses inside one frame
  // both run against the state the last render closed over: ArrowDown followed
  // immediately by ArrowRight saw the row BEFORE the ArrowDown and refused to
  // open the submenu (reproduced by the roll-call script, which types faster
  // than a frame). Writing the ref synchronously makes each press act on the
  // result of the one before it, whether or not a render has happened yet.
  const activeRef = useRef(0);
  const setActive = useCallback((next: number | ((prev: number) => number)) => {
    const value = typeof next === 'function' ? next(activeRef.current) : next;
    activeRef.current = value;
    setActiveState(value);
  }, []);
  const [box, setBox] = useState<Box | null>(null);
  const [subSide, setSubSide] = useState<'right' | 'over'>('right');
  /** Viewport `top` for the flyout, measured against its own trigger row. */
  const [subTop, setSubTop] = useState<number | null>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const rootInputRef = useRef<HTMLInputElement>(null);
  const subInputRef = useRef<HTMLInputElement>(null);
  const rootListRef = useRef<HTMLDivElement>(null);
  const subListRef = useRef<HTMLDivElement>(null);

  const uid = useId();
  const listIdOf = (kind: 'root' | 'sub') => `${uid}-${kind}-list`;
  const optionIdOf = (kind: 'root' | 'sub', i: number) => `${uid}-${kind}-opt-${i}`;

  const rootPanel = panel(rootQuery);
  const subPanel = branchKey !== null && branchPanel ? branchPanel(branchKey, branchQuery) : null;
  const subPanelOpen = subPanel !== null;
  const activeKind: 'root' | 'sub' = subPanelOpen ? 'sub' : 'root';
  /**
   * Narrow viewport: the submenu REPLACES the root panel rather than flying
   * out beside it, so only one of the two listboxes is mounted at a time.
   */
  const drillDown = subPanel !== null && subSide === 'over';
  const activeRows = selectableRows(subPanel !== null ? subPanel.rows : rootPanel.rows);
  // Clamped at render rather than corrected by an effect: the row count changes
  // on every keystroke, and an effect that fixes it renders the out-of-range
  // frame first — aria-activedescendant pointing at an id not in the document.
  const activeIdx = activeRows.length > 0 ? Math.min(active, activeRows.length - 1) : -1;

  // ── Overflow affordances ─────────────────────────────────────────────────
  // Two independent measurements because the two listboxes scroll separately
  // and are on screen at the same time in the flyout case.
  const rootOverflow = useListOverflow(
    rootListRef,
    `${open ? 'o' : 'c'}|${drillDown ? 'd' : 'r'}|${rootQuery}|${rootPanel.rows.length}|${box?.maxHeight ?? 0}`,
  );
  const subOverflow = useListOverflow(
    subListRef,
    `${open ? 'o' : 'c'}|${branchKey ?? ''}|${branchQuery}|${subPanel?.rows.length ?? 0}|${
      box?.subMaxHeight ?? 0
    }|${subSide}|${subTop ?? 0}`,
  );

  // ── Placement ────────────────────────────────────────────────────────────
  const hasBranches = branchPanel !== undefined;

  const place = useCallback(() => {
    const t = triggerRef.current;
    if (!t) return;
    const r = t.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const width = Math.min(PANEL_W, vw - 2 * GAP);
    let left = r.left;
    if (left + width > vw - GAP) left = vw - GAP - width;
    if (left < GAP) left = GAP;

    // Reserve the flyout column while the menu is still CLOSED — that is the
    // whole point of doing it here. The root panel never moves out from under
    // the pointer, and the submenu never has to flip back across its own
    // parent to find room. The reservation is granted only if the root panel
    // can pay for it and still cover TRIGGER_KEEP of its own trigger; if it
    // cannot, there is no honest place for a second column at this size and
    // the menu becomes a drill-down.
    let flyout = false;
    if (hasBranches) {
      const wanted = Math.min(left, vw - GAP - (2 * width + GAP));
      const floor = Math.max(GAP, r.left + Math.min(r.width, TRIGGER_KEEP) - width);
      if (wanted >= floor) {
        left = wanted;
        flyout = true;
      }
    }

    const below = vh - r.bottom - 2 * GAP;
    const above = r.top - 2 * GAP;
    const flipUp = below < 220 && above > below;
    // The ceiling is a share of the viewport, not a constant. It used to be a
    // flat 440px, which on a 900px-tall window left the model menu's list 18px
    // short of its own content: the last family sat half-cut at the panel edge
    // with 350px of unused space underneath it. An 18px overflow does not read
    // as "this list scrolls", it reads as a broken panel. Tying the cap to the
    // window means the menu takes the room it needs where the room exists, and
    // a genuinely long list (a big agent roster) still scrolls rather than
    // growing into a full-height sheet.
    const ceiling = Math.max(280, Math.round(vh * 0.6));
    const maxHeight = Math.max(160, Math.min(ceiling, flipUp ? above : below));
    const subMaxHeight = Math.max(160, Math.min(ceiling, vh - 2 * GAP));
    setBox(
      flipUp
        ? { left, width, maxHeight, subMaxHeight, bottom: vh - r.top + 6 }
        : { left, width, maxHeight, subMaxHeight, top: r.bottom + 6 },
    );
    setSubSide(flyout ? 'right' : 'over');
  }, [hasBranches]);

  /**
   * Centre the flyout on the branch row that opened it, clamped into the
   * viewport. Runs from a layout effect because it needs the panel's real
   * height, which only exists once the panel is in the DOM — the corrected top
   * lands in the same frame, so nothing is painted at the provisional one.
   */
  const placeSub = useCallback(() => {
    const p = subRef.current;
    const row = rootRef.current?.querySelector<HTMLElement>('[data-branch-open="true"]');
    if (!p || !row) return;
    const rect = row.getBoundingClientRect();
    const height = p.offsetHeight;
    const vh = window.innerHeight;
    const centred = rect.top + rect.height / 2 - height / 2;
    setSubTop(Math.max(GAP, Math.min(centred, vh - GAP - height)));
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  // After `place`, because the row this measures against sits in the panel
  // `place` positions. `box` in the deps is what sequences the two.
  useLayoutEffect(() => {
    if (open && subPanelOpen && subSide === 'right') placeSub();
  }, [open, subPanelOpen, subSide, branchKey, branchQuery, box, placeSub]);

  useEffect(() => {
    if (!open) return undefined;
    const onMove = () => {
      place();
      placeSub();
    };
    window.addEventListener('resize', onMove);
    // Capture phase: the transcript scrollport is what actually scrolls, and a
    // scroll event on an element does not bubble to window.
    window.addEventListener('scroll', onMove, true);
    return () => {
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, place, placeSub]);

  // ── Open / close ─────────────────────────────────────────────────────────
  const closeMenu = useCallback(
    (returnFocus: boolean) => {
      setOpen(false);
      setBranchKey(null);
      setRootQuery('');
      setBranchQuery('');
      setActive(0);
      // Dropped rather than kept: the next branch opens against a different
      // row, and a stale top would place the first frame at the old one.
      setSubTop(null);
      if (returnFocus) triggerRef.current?.focus();
    },
    [],
  );

  function openMenu() {
    const fresh = selectableRows(panel('').rows);
    const i = fresh.findIndex((r) => r.selected === true);
    setRootQuery('');
    setBranchQuery('');
    setBranchKey(null);
    setActive(i >= 0 ? i : 0);
    setOpen(true);
  }

  function enterBranch(key: string) {
    if (!branchPanel) return;
    const fresh = selectableRows(branchPanel(key, '').rows);
    const i = fresh.findIndex((r) => r.selected === true);
    setBranchKey(key);
    setBranchQuery('');
    setActive(i >= 0 ? i : 0);
  }

  function leaveBranch() {
    const key = branchKey;
    setBranchKey(null);
    setBranchQuery('');
    setSubTop(null);
    const back = selectableRows(rootPanel.rows).findIndex((r) => r.key === key);
    setActive(back >= 0 ? back : 0);
  }

  // Dismiss on a click that lands outside the trigger and both panels.
  useEffect(() => {
    if (!open) return undefined;
    function onDown(e: MouseEvent) {
      const t = e.target as Node | null;
      if (t === null) return;
      if (triggerRef.current?.contains(t) === true) return;
      if (rootRef.current?.contains(t) === true) return;
      if (subRef.current?.contains(t) === true) return;
      closeMenu(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, closeMenu]);

  // Focus follows the level: opening focuses the root field, entering a
  // submenu focuses its field, leaving one hands focus back to the root field.
  useEffect(() => {
    if (!open) return;
    const el = branchKey !== null ? subInputRef.current : rootInputRef.current;
    el?.focus();
  }, [open, branchKey]);

  // Keep the active row in view — it moves by keyboard, and the list scrolls.
  useEffect(() => {
    if (!open) return;
    const list = activeKind === 'sub' ? subListRef.current : rootListRef.current;
    const el = list?.querySelector('[data-active="true"]');
    if (el) (el as HTMLElement).scrollIntoView({ block: 'nearest' });
  }, [open, active, activeKind, branchKey, rootQuery, branchQuery]);

  function activate(row: ActionableRow) {
    if (row.type === 'branch') enterBranch(row.key);
    else {
      row.onSelect();
      closeMenu(true);
    }
  }

  function onKeyDown(e: JSX.TargetedKeyboardEvent<HTMLInputElement>) {
    const n = activeRows.length;
    // Read through the ref, never the render-time index — see setActive.
    const cursor = n > 0 ? Math.min(activeRef.current, n - 1) : -1;
    const input = e.currentTarget;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (n > 0) setActive((a) => (Math.min(a, n - 1) + 1) % n);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (n > 0) setActive((a) => (Math.min(a, n - 1) - 1 + n) % n);
        break;
      case 'Home':
        e.preventDefault();
        setActive(0);
        break;
      case 'End':
        e.preventDefault();
        setActive(Math.max(0, n - 1));
        break;
      case 'Enter': {
        e.preventDefault();
        const row = cursor >= 0 ? activeRows[cursor] : undefined;
        if (row) activate(row);
        break;
      }
      case 'ArrowRight': {
        // Only when the caret is already at the end — otherwise this key is the
        // user moving through what they have typed.
        const atEnd =
          input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
        const row = cursor >= 0 ? activeRows[cursor] : undefined;
        if (atEnd && row?.type === 'branch') {
          e.preventDefault();
          enterBranch(row.key);
        }
        break;
      }
      case 'ArrowLeft': {
        const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
        if (atStart && branchKey !== null) {
          e.preventDefault();
          leaveBranch();
        }
        break;
      }
      case 'Escape':
        e.preventDefault();
        // One press unwinds exactly one level of THIS menu; nothing further up
        // the page gets to also treat it as a dismiss.
        e.stopPropagation();
        if (branchKey !== null) leaveBranch();
        else closeMenu(true);
        break;
      case 'Tab':
        // Let focus leave normally, but never leave an orphaned popover behind.
        closeMenu(false);
        break;
      default:
        break;
    }
  }

  function renderRows(kind: 'root' | 'sub', panelRows: MenuRow[]) {
    const segments = segment(panelRows);
    let i = -1;
    return segments.map((seg) => {
      const body = seg.rows.map((row) => {
        i += 1;
        const index = i;
        const isActive = kind === activeKind && index === activeIdx;
        const branchOpen = row.type === 'branch' && branchKey === row.key;
        return (
          <div
            key={row.key}
            id={optionIdOf(kind, index)}
            role="option"
            aria-selected={row.selected === true}
            {...(row.type === 'branch'
              ? { 'aria-haspopup': 'listbox' as const, 'aria-expanded': branchOpen }
              : {})}
            data-active={isActive}
            data-kind={row.type}
            data-key={row.key}
            // The anchor the flyout is centred on. An attribute rather than a
            // ref because the row that owns the open submenu is found from the
            // panel on resize and scroll, long after the click that opened it.
            {...(branchOpen ? { 'data-branch-open': 'true' } : {})}
            onMouseEnter={() => {
              if (kind === activeKind) setActive(index);
            }}
            onClick={() => activate(row)}
            class={`flex cursor-pointer items-start gap-2 rounded-lg px-2 py-1.5 transition-colors duration-fast
              ${isActive || branchOpen ? 'bg-surface-hover' : ''}`}
          >
            {/* Check column, reserved on every row so labels line up whether or
                not anything in this list is selected. */}
            <span class="mt-0.5 w-4 shrink-0 text-primary" aria-hidden="true">
              {row.selected === true && <Check size={14} />}
            </span>
            <span class="min-w-0 flex-1">
              <span class="flex items-center gap-1.5">
                <span
                  class={`min-w-0 flex-1 truncate text-body-sm ${
                    row.selected === true ? 'font-semibold text-primary' : 'text-primary'
                  }`}
                >
                  {row.label}
                </span>
                {row.badge !== undefined && (
                  <span class="shrink-0 rounded-full border border-border bg-bg px-1.5 py-px text-overline uppercase tracking-wide text-secondary">
                    {row.badge}
                  </span>
                )}
                {row.hint !== undefined && (
                  <span class="shrink-0 font-mono text-caption text-muted">{row.hint}</span>
                )}
                {row.type === 'branch' && (
                  <ChevronRight size={14} class="shrink-0 text-muted" aria-hidden="true" />
                )}
              </span>
              {row.description !== undefined && row.description !== '' && (
                <span
                  // Stable hook so the roll-call harness can measure whether a
                  // description is actually FULLY on screen (scrollHeight vs
                  // clientHeight) rather than trusting that it is.
                  data-desc={row.key}
                  class={`mt-0.5 block text-caption text-muted ${
                    row.wrapDescription === true ? 'line-clamp-2' : 'truncate'
                  }`}
                >
                  {row.description}
                </span>
              )}
            </span>
          </div>
        );
      });
      if (seg.label === undefined) return <div key={seg.key}>{body}</div>;
      return (
        <div key={seg.key} role="group" aria-label={seg.label}>
          <div role="presentation" class="px-2 pb-1 pt-2 text-overline uppercase tracking-wider text-muted">
            {seg.label}
          </div>
          {body}
        </div>
      );
    });
  }

  function searchField(
    kind: 'root' | 'sub',
    p: MenuPanel,
    value: string,
    onValue: (v: string) => void,
    ref: RefObject<HTMLInputElement>,
  ) {
    return (
      <div class="relative border-b border-border px-2 py-2">
        <Search
          size={14}
          class="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted"
          aria-hidden="true"
        />
        <input
          ref={ref}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={listIdOf(kind)}
          aria-autocomplete="list"
          aria-activedescendant={
            kind === activeKind && activeIdx >= 0 ? optionIdOf(kind, activeIdx) : undefined
          }
          aria-label={p.searchLabel}
          placeholder={p.searchLabel}
          value={value}
          spellcheck={false}
          autocomplete="off"
          data-menu-search={kind === 'root' ? menuName : `${menuName}-submenu`}
          onInput={(e) => {
            onValue((e.currentTarget as HTMLInputElement).value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          class="w-full rounded-md bg-transparent py-1 pl-6 pr-2 text-body-sm text-primary
            outline-none placeholder:text-muted focus-visible:ring-2 focus-visible:ring-primary-a/60"
        />
      </div>
    );
  }

  /**
   * The listbox plus its overflow chrome.
   *
   * The scroller is wrapped in a `relative` box so the ramps can sit over it
   * without being scrolled BY it, and — the part that matters — without taking
   * any layout: an affordance that shortened the list would change what
   * overflows, which is a loop that settles on the wrong answer or does not
   * settle. `pointer-events: none` (in index.css) keeps the row underneath
   * clickable, so nothing is made unreachable by the thing announcing that
   * more is reachable.
   */
  function listBox(
    kind: 'root' | 'sub',
    p: MenuPanel,
    listRef: RefObject<HTMLDivElement>,
    over: { edges: Overflow; measure: () => void },
  ) {
    return (
      <div class="relative min-h-0 flex-1">
        <div
          ref={listRef}
          id={listIdOf(kind)}
          role="listbox"
          aria-label={p.listLabel}
          // Read by the roll-call harness: the affordance is asserted against
          // the same measurement that draws it.
          data-overflow={overflowState(over.edges)}
          onScroll={over.measure}
          class="chat-menu-list h-full overflow-y-auto p-1"
        >
          {selectableRows(p.rows).length === 0 ? (
            <p class="px-2 py-3 text-caption text-muted">{p.emptyLabel}</p>
          ) : (
            renderRows(kind, p.rows)
          )}
        </div>
        {over.edges.up && <div class="chat-menu-edge chat-menu-edge--top" aria-hidden="true" />}
        {over.edges.down && (
          <div class="chat-menu-edge chat-menu-edge--bottom" aria-hidden="true">
            {/* Not "there is more" but how much more, so the reader can decide
                between scrolling and typing. Hidden from assistive tech
                because the same count is already the group heading above the
                first row ("18 agents"), where it is announced on entry. */}
            <span class="chat-menu-more" data-more={over.edges.more}>
              <ChevronDown size={11} aria-hidden="true" />
              {over.edges.more} more
            </span>
          </div>
        )}
      </div>
    );
  }

  const panelChrome =
    'fixed z-50 flex flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-lg page-enter';

  function panelStyle(left: number): JSX.CSSProperties {
    const b = box as Box;
    return {
      left: `${left}px`,
      width: `${b.width}px`,
      maxHeight: `${b.maxHeight}px`,
      ...(b.top !== undefined ? { top: `${b.top}px` } : {}),
      ...(b.bottom !== undefined ? { bottom: `${b.bottom}px` } : {}),
    };
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => (open ? closeMenu(true) : openMenu())}
        aria-haspopup="listbox"
        aria-expanded={open}
        // Points at the list that is actually in the document: in drill-down
        // the root listbox is unmounted, and aria-controls must not name an id
        // that no longer exists.
        aria-controls={open ? listIdOf(drillDown ? 'sub' : 'root') : undefined}
        aria-label={triggerAriaLabel}
        title={triggerTitle ?? triggerLabel}
        data-menu={menuName}
        class={`flex min-w-0 items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2
          text-body-sm text-primary transition-colors duration-fast hover:border-border-strong
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-a/60
          disabled:cursor-not-allowed disabled:opacity-60 ${triggerClass}`}
      >
        {triggerIcon !== undefined && (
          <span class="shrink-0 text-muted" aria-hidden="true">
            {triggerIcon}
          </span>
        )}
        <span class="min-w-0 truncate">{triggerLabel}</span>
        <ChevronDown
          size={14}
          class={`shrink-0 text-muted transition-transform duration-fast ${open ? 'rotate-180' : ''}`}
          aria-hidden="true"
        />
      </button>

      {open && box !== null && (
        <>
          {/* In drill-down mode the root panel is UNMOUNTED, not merely
              overlaid. Rendering it underneath was the bug the `subSide ===
              'over'` branch was supposed to prevent: the two panels share a
              left edge and a width, but a submenu holding two models is far
              shorter than a root holding a policy, a default and every family,
              so the root's lower half went on showing below the submenu and
              the "drill-down" read as two cards stacked at an angle. The
              submenu carries its own Back control and its own title, so
              nothing is lost by taking the root away while it is open. */}
          {!drillDown && (
          <div ref={rootRef} data-menu-panel={menuName} style={panelStyle(box.left)} class={panelChrome}>
            {searchField('root', rootPanel, rootQuery, setRootQuery, rootInputRef)}
            {listBox('root', rootPanel, rootListRef, rootOverflow)}
          </div>
          )}

          {subPanel !== null && (
            <div
              ref={subRef}
              data-menu-panel={`${menuName}-submenu`}
              data-sub-side={subSide}
              style={
                subSide === 'right'
                  ? {
                      left: `${box.left + box.width + GAP}px`,
                      width: `${box.width}px`,
                      maxHeight: `${box.subMaxHeight}px`,
                      // `subTop` is null only for the render that mounts this
                      // panel; the layout effect above measures it and replaces
                      // this value before the frame is painted.
                      top: `${subTop ?? box.top ?? GAP}px`,
                    }
                  : // Drill-down: this panel stands exactly where the root
                    // panel it replaced stood.
                    panelStyle(box.left)
              }
              class={panelChrome}
            >
              <div class="flex items-center gap-2 border-b border-border px-2 py-1.5">
                <button
                  type="button"
                  onClick={() => leaveBranch()}
                  aria-label="Back to all model families"
                  class="rounded-md p-1 text-muted transition-colors duration-fast hover:bg-surface-hover
                    hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-a/60"
                >
                  <ArrowLeft size={14} />
                </button>
                <span class="min-w-0 truncate text-caption font-semibold text-primary">{subPanel.title}</span>
              </div>
              {searchField('sub', subPanel, branchQuery, setBranchQuery, subInputRef)}
              {listBox('sub', subPanel, subListRef, subOverflow)}
            </div>
          )}
        </>
      )}
    </>
  );
}
