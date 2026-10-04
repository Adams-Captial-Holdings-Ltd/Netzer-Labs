# Design System — Netzar OS Enterprise web app

> Source of truth for visual and interaction decisions. Product context lives in [PRODUCT.md](PRODUCT.md); names and voice in [BRAND.md](BRAND.md).
> Last reviewed: 2026-10-04 · Register: product · Preset: enterprise platform, with internal-operations density for lists
> Tokens live in `web/src/index.css` and `web/tailwind.config.ts`. This file records decisions; it does not restate token values.
> **Status: locked for roadmap step 7 only** (owner, 2026-10-04, after a trial of this file). It becomes the rulebook for steps 9 to 12 once the owner has tried the built decide flow on a phone and the result is recorded here; a first-customer approver repeats that trial after go-live. Until then, later steps treat it as a draft. Changes need a recorded decision.

## 1. Product Design Philosophy

Precise, quiet, dense, trustworthy, plain-spoken. People come here to decide something and leave. The content of a case or an approval is the most important thing on the screen; the interface around it stays calm and predictable. Density: a list shows at least 10 rows at 1280 by 720 without scrolling.

## 2. Core Design Principles

1. Type and position carry hierarchy before containers do.
2. A list of work is rows, not cards.
3. One primary action per ordinary page (lists, detail pages, forms, settings). It is the only filled button. Canvas tools such as the workflow designer: not yet decided (step 9).
4. Colour means status or the primary action. Nothing else is coloured.
5. The thing being approved is shown in full, above the buttons that approve it.
6. Every screen has a loading, empty, error and partial state, and they look different from each other.
7. Identifiers and hashes are monospace and secondary. Names and titles are sans and primary.
8. Every new screen passes the design gates in light at 375, 768 and 1280, and at 1280 again in dark and with a non-default brand colour.
9. Case content stays inside the page. Toasts, the browser tab title, URLs and notifications carry generic words, the decision label and ids only: never a case title, a name or payload content.

## 3. Visual Hierarchy

In order of preference: position (top and left first), type size and weight, spacing, text colour level (primary, secondary, muted), then a border. A background fill or a card comes last. A page has one `heading-lg` title. Section titles are `heading-sm`. Row titles are `body-sm` at weight 500; row metadata is `caption` in `text-secondary`.

## 4. Typography

- Families: `font-sans` (system stack with Inter) for everything; `font-mono` only for case keys, ids, hashes and JSON.
- Scale: use the named sizes in `web/tailwind.config.ts` (`heading-lg`, `heading-sm`, `body`, `body-sm`, `caption`, `overline`). `display-*` is not used inside the app shell.
- Lists and tables use `body-sm`. Long-form case content (a draft, a comment) uses `body` with a line length of at most 75 characters.
- Numbers in columns, counts and times use `tabular-nums`.
- `overline` is for sidebar section labels only. Do not put an overline above a page or section heading.

## 5. Color System

- Surfaces: `bg` for the page, `surface` for panels, `bg-sunken` for wells such as a code or payload block.
- Text: `text-primary`, `text-secondary`, `text-muted`. Muted text is never used for something the user must read to act.
- Borders: `border`; `border-strong` only to separate a sticky bar from scrolling content.
- Primary (`primary`, `primary-hover`): the one primary action, links, the current-place marker. It is the customer's colour under white-label, so it never carries status. Text on a primary fill always meets 4.5:1: `applyBrand()` in `web/src/lib/theme.ts` picks light or dark text for the customer's colour; nobody has to choose a compliant colour.
- Status: `success` (approved, done), `warning` (waiting on a person, changes requested), `danger` (rejected, blocked, failed), `info` is not used for status. Each status also has a word, and an icon or dot. Status backgrounds use the `*-dim` tokens, never a full-strength fill.
- Rows: `row-hover` for hover, `row-active` for the current row, `focus-bar` for the keyboard position.
- Do not introduce a hex value in a component. A missing colour is a missing token: add it to `index.css` for light and dark together.

## 6. Spacing and Layout

- Spacing uses the 4 px scale (`--space-1` to `--space-12`). Inside a row: 12 px vertical, 16 px horizontal. Between a heading and its content: 12 px. Between sections: 32 px, and more space above a heading than below it.
- Page gutter: 24 px at 768 and up, 16 px below.
- Lists span the content width. Detail pages use one main column (at most 760 px of text) and, at 1024 and up, a facts column of 280 px on the right.
- The app shell (sidebar 260 px, header 56 px) is fixed; pages do not draw their own chrome.

## 7. Surfaces and Containers

In order: no container; grouping by whitespace; a hairline divider between rows; one bordered panel around a list or a well. A card is used only for an object that stands alone and can be acted on as a whole. Never a card inside a card. No gradient fills, glass, glow or coloured side stripes on Work screens. Shadows are for overlays (menus, dialogs, toasts) only.

## 8. Components

Reuse what exists in `web/src/components/`; do not fork a variant for one screen.

- **Button** (`Button.tsx`): one filled button per page, the primary action; secondary and ghost for the rest. Reject and other destructive actions are an outlined danger button (danger text and border, no fill), so the page never shows two filled buttons side by side. The outlined danger style is a shared variant of `Button.tsx`, added once (step 7), not a one-screen fork. The `lg` size is the 44 px touch size.
- **Status** (`Badge.tsx`, `StatusDot.tsx`): a dot plus a word in lists; a badge in a detail header. At most one badge per row.
- **Lists**: a bordered panel of rows. Each row is one link target (the whole row), 44 px tall at minimum, title first. No per-row action buttons in Work lists.
- **Filters**: native `<select>` (`Select.tsx`) in one row above the list; they wrap at small sizes.
- **Empty, error, loading**: `EmptyState.tsx`, `ErrorState.tsx`, `Skeleton.tsx`. Skeletons copy the shape of the content they replace.
- **Payload block**: a `bg-sunken` well. A flat object renders as a definition list (label left, value right; stacked at small sizes). Anything else renders as formatted JSON in `font-mono` (`RawJsonBlock.tsx`). The sha256 sits under the block in `caption` mono.
- **Decide form**: the comment box, one sentence naming what is being decided and that it cannot be undone, then Approve (primary), Request changes (secondary), Reject (outlined danger), with at least 24 px between any two of them at every size. It sits below the content it decides and is never sticky: the person passes what they approve to reach the buttons.
- **Dialogs** (`Modal.tsx`, `ConfirmDialog.tsx`): only for a task that needs protected focus. An approval is read and decided in the page; the one dialog in that flow is the confirm that Approve opens (section 9).
- **Toast** (`Toast.tsx`): confirmation after a decision. Never the only place an error appears.

## 9. Interaction Design

- Hover is a hint, never the only way to find something.
- Focus is always visible: the ring on controls, `focus-bar` on rows.
- A control that cannot be used yet says why in text next to it (for example "Add a comment to reject or request changes"). It uses `aria-disabled` and stays in the Tab order, so keyboard and screen-reader users find the reason.
- A decision cannot be undone (the work engine has no way to reverse one), and the page says so before it is made. Approve is the only decision one tap could send, so at every screen size it opens a confirm (`ConfirmDialog.tsx`) that names the decision label and the case key and repeats "This cannot be undone"; the confirm's own primary button sends it. Reject and Request changes need a typed comment and no confirm. A decision is sent once: the buttons disable while sending.
- After a decision the page stays and shows the result in place ("You approved this", the time, the comment); a toast is a second confirmation, never the only one.
- An unknown outcome is said plainly ("We could not confirm the decision was recorded. Reload to check.") and never shown as a failure.

## 10. Motion

Motion shows a change of state or place and nothing else. 100 to 200 ms (`duration-fast`, `duration-normal`), `ease-out`, on opacity, colour or transform of the changed element. Never `transition: all`. No bounce, no looping animation, no entrance animation for page content. Skeletons may pulse. All of it stops under `prefers-reduced-motion`.

## 11. Responsive Design

- 1024 and up: sidebar open; detail pages show the facts column.
- 768 to 1023: the facts column moves above the main column as a two-column definition grid.
- Below 768: the sidebar is a drawer; list rows stack to two lines (title; then metadata); filters wrap; the decide buttons stack full width, Approve first, each at least 44 px tall, with at least 24 px between them.
- No horizontal page scroll at 375. A payload block may scroll sideways inside itself.

## 12. Accessibility

WCAG 2.2 AA. Text contrast at least 4.5:1 (3:1 for large text and for the boundary of a control). Targets at least 24 by 24 px; the decide buttons use the large button size (at least 44 px tall) below 768. Lists are real lists or tables; rows are links; the decide controls are buttons in a form with a labelled textarea. Status has a text name. Live results (toast, error) are announced with `role="status"` or `role="alert"`. Keyboard order follows reading order, and the primary action is reachable without a pointer.

Case fields show plainly to people the customer has given access. Masking sensitive fields: not yet decided (step 8, when a pack can mark which fields are sensitive).

## 13. Data Visualization

Work screens have no charts and no metric tiles. Elsewhere, charts use `BarChart.tsx` and `Sparkline.tsx` and the status colours above. Rules for dashboards, new charts and numbers shown as tiles: not yet decided (step 10).

## 14. Iconography

`lucide-preact` only, 16 px in rows and buttons, 20 px in the sidebar, the library's default stroke. An icon accompanies a label; it replaces one only for a universal action with an `aria-label`. No emoji and no coloured icon tiles on Work screens.

## 15. Anti-Patterns

Not on Work screens, and not in new screens elsewhere:

- A grid of same-size cards for a list of work (the Agents grid is the older pattern; found 2026-10-04).
- Coloured bars or stripes on the edge of a card or row to carry status.
- A card inside a card; a bordered box around every section.
- Big-number metric tiles on Work screens; decorative sparklines anywhere.
- More than one badge on a row; a badge for something that is not a status.
- An empty list shown when the data failed to load.
- A raw error code as the only message.
- A modal for a task that does not need protected focus.
- Gradient text, glass, glow, bounce.
- A one-off hex, px size or shadow in a component.

## 16. Reference Components

Known drift in older components (found 2026-10-04; fix when a step touches them, not before): `Badge.tsx` uses the `overline` size and `/10` alpha fills where section 5 asks for the `*-dim` tokens; `Toast.tsx` uses text glyphs as icons; the Agents grid uses cards with coloured top bars. New screens follow this file, not those. Two gaps are closed in step 7 because the Work screens need them: `Button.tsx` has no outlined danger variant, and `applyBrand()` does not check the contrast of a customer's colour.

- `web/src/pages/Sessions.tsx`: copy how it handles loading, empty and error and where it puts filters. Do not copy its page-title size or its table header style; sections 3 and 4 govern new screens.
- `web/src/pages/AgentDetail.tsx`: a detail page reached by a route, with a back link.
- `web/src/components/ErrorState.tsx` and `EmptyState.tsx`: the wording pattern (what happened, what to do).
- The row tokens (`row-hover`, `row-active`, `focus-bar`) in `web/src/index.css`, with the reasoning in the comments there.
- After step 7: `web/src/pages/work/` is the reference for lists of work and for a decide flow.
