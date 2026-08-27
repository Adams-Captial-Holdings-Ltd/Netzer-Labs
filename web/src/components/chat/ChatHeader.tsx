/*
 * Structure ported from danny-avila/LibreChat (MIT), pinned at commit
 * 6d499ba3ce17f906a7762429c61018f230ecd64e — donor path
 * `client/src/components/Chat/Header.tsx`.
 *
 * What is ported: the header floats over the top of the conversation rather
 * than being a chrome bar bolted to the app frame, so the transcript scrolls
 * *under* it, and its controls read as free-standing pills rather than as a
 * toolbar. Donor tokens are translated per docs/features/netzar-chat/README.md;
 * no donor colour survives.
 *
 * What is NOT ported: the donor's preset, bookmark and multi-convo menus. This
 * product's header carries the governance controls instead — which agent,
 * which model, and the conversation id the audit trail keys on. The donor's
 * endpoint menu IS ported, as of Phase 5 (CHATUI-005): its structure is what
 * AgentMenu and ModelMenu are built on (see CommandMenu), because a roster of
 * seventeen agent templates and a multi-family model catalog are exactly the
 * problem that menu was shaped to solve.
 *
 * ── It is a FLOATING OVERLAY, and it declares that ─────────────────────────
 *
 * Two earlier cuts each failed in the same way from opposite ends, so the
 * treatment is now committed to explicitly rather than left implied:
 *
 *   1. A single `bg-gradient-to-b from-bg-a … to-transparent` band. Every
 *      pixel of it was partly transparent, so a message scrolled under it
 *      composited THROUGH the title — running body copy drew straight into the
 *      conversation name and produced smears like "/fixturthecoideb", and word
 *      fragments leaked out of the gaps between the pills. A gradient can fade
 *      glyphs; it can never occlude them.
 *   2. An opaque plate with no edge of any kind — no border, no radius, no
 *      shadow, and no bar rule either. That reads as nothing at all: the
 *      controls simply hang in space over the conversation, and the only thing
 *      separating them from the first message is luck.
 *
 * So this header commits to ONE treatment and states it in the class list: an
 * opaque floating panel, hung from the top of the reading column, with a
 * hairline on the three edges it actually has and a soft shadow lifting it off
 * the ground. `bg-surface` (not the canvas's `bg-bg`) is what makes it read as
 * a panel rather than as a hole in the page, and being fully opaque is what
 * makes text passing underneath DISAPPEAR instead of smearing — in both
 * themes, with no blur to depend on.
 *
 * ── It declares no measure of its own ──────────────────────────────────────
 *
 * The header is a child of the shared content column (see ChatCanvas), stuck
 * to its top edge. It is therefore laid out by the same containing block as
 * every message under it, which is the only way its edges can be guaranteed to
 * match theirs. It used to be an `absolute` overlay on the pane instead, with
 * its own `px-3 sm:px-4`; measured at 1280 that left its content box at
 * 532…1264 against a column at 542…1254 — 10px proud on both sides, because a
 * box outside the scrollport cannot see the `scrollbar-gutter` reservation
 * that narrows the boxes inside it. No padding value fixes that; only being in
 * the same containing block does.
 *
 * `COLUMN_BLEED_X` / `COLUMN_PX` are the one padding value, exported as a pair
 * from ChatCanvas: the first bleeds the plate out over the column's padding so
 * the panel spans the scrollport, the second puts the controls back exactly on
 * the column's edges.
 *
 * A sticky element occupies its own height in the flow, so nothing has to
 * measure this header and pad the transcript by it — which is why the
 * `--chat-header-h` custom property, its ResizeObserver and its two fallback
 * breakpoints are gone rather than merely retuned.
 *
 * ── ROUND 3: THE PLATE NOW OWNS ITS BOTTOM BOUNDARY, RAMP INCLUDED ────────
 *
 * The reservation above is real and was measured again: at `scrollTop: 0` on a
 * 375x812 viewport the plate ended at y=157.4 and the first row started at
 * y=173.4 — a 16px gap, nothing underneath. (Round 4 collapsed the mobile plate
 * to one bar, so those two numbers are now y=109 and y=133; the 24px ramp
 * between them is unchanged, and so is everything this section says about it.)
 * But that is only the geometry AT REST, and a transcript spends most of its
 * life scrolled. Mid-scroll, running
 * text passes under an opaque plate that terminated in a 1px rule and NOTHING
 * else: probed at 55% scroll on the `code` fixture, `elementFromPoint` returned
 * `code.hljs` at every one of the first 32px below the plate's bottom edge,
 * the first of them 1px under the rule. Wherever that landed mid-line it cut a
 * line of code in half — roughly 10px of a 14px line left showing, with no ramp
 * to explain the cut.
 *
 * The composer had solved this at the other end of the same scroller from the
 * start: a 24px `bg-gradient-to-t from-bg-a` above its plate, so the transcript
 * DISSOLVES into it instead of being cut by it (ChatCanvas). The conversation
 * list solves it too, at the foot of its own overflow. The header was the one
 * boundary on the surface with an occluder and no ramp; the strip below is that
 * same treatment, mirrored, and it makes the plate's bottom edge the plate's
 * own business rather than something the transcript has to leave room for.
 *
 * Three details, each of which is the difference between a ramp and a bug:
 *
 *   - It is IN THE FLOW, not `absolute`. It therefore occupies its 24px the
 *     way the plate occupies its height, so at rest it can never wash over the
 *     first row — no clearance to publish, nothing to keep in sync. That is
 *     also why `MessagesView`'s `pt-4` went away in the same change: the gap it
 *     provided is now this ramp, and two elements declaring the same clearance
 *     is how the header/`--chat-header-h` mess started.
 *   - The band belongs to the MESSAGE under it, and that takes two
 *     declarations, not one. `pointer-events-none` on the ramp alone is not
 *     enough: the ramp is in the flow, so the sticky wrapper's own box grows to
 *     contain it, and the wrapper is what `elementFromPoint` then returns
 *     across the whole 24px strip — probed and confirmed, on the composer's
 *     ramp as much as this one. The wrapper is therefore `pointer-events-none`
 *     and the plate `pointer-events-auto`, which puts the strip back on the
 *     message (clicks select its text) while leaving every control on the plate
 *     exactly as clickable as before.
 *   - The plate is `relative z-10` so it, and its shadow, paint ON TOP of the
 *     ramp. Without it the ramp's opaque top edge is drawn after the plate in
 *     DOM order and erases the `shadow-sm` that lifts the panel off the ground
 *     — a fix for the boundary that quietly deletes the boundary's edge.
 */
import { Menu, Plus } from 'lucide-preact';
import type { Agent, Model } from '../../lib/chat/types';
import { Button } from '../Button';
import { InfoTooltip } from '../InfoTooltip';
import { AgentMenu } from './AgentMenu';
import { ModelMenu } from './ModelMenu';
import { OpenSidebarButton } from './ConversationSidebar';
import { APP_NAV_DRAWER_ID } from '../Sidebar';
import { COLUMN_BLEED_X, COLUMN_PX } from './ChatCanvas';

interface ChatHeaderProps {
  /** Conversation title — the opening user line, or "New chat". */
  title: string;
  agents: Agent[];
  agentId: string;
  onSelectAgent: (id: string) => void;
  models: Model[];
  modelId: string;
  onSelectModel: (id: string) => void;
  /** The `dashboard:<epoch-ms>` id this turn is filed under. */
  chatId: string;
  streaming: boolean;
  onNewChat: () => void;
  /** Opens the conversation drawer. Rendered only below `lg`, where the
   *  conversation rail is off-canvas and has no control of its own on screen
   *  (donor `Chat/Menus/OpenSidebar.tsx`). Omit it and no button appears. */
  onOpenSidebar?: () => void;
  /** Opens the PRODUCT's navigation drawer (the app shell's nav). Rendered only
   *  below `lg`, where the house header stands down and this bar is the app bar
   *  — donor `Chat/Header.tsx`, whose mobile row likewise carries the controls
   *  that have nowhere else to be. Omit it and no button appears. */
  onOpenAppNav?: () => void;
}

export function ChatHeader({
  title,
  agents,
  agentId,
  onSelectAgent,
  models,
  modelId,
  onSelectModel,
  chatId,
  streaming,
  onNewChat,
  onOpenSidebar,
  onOpenAppNav,
}: ChatHeaderProps) {
  return (
    // The bleed layer: no paint of its own, it only cancels the column's
    // padding so the panel below can span the scrollport.
    <div class={`pointer-events-none sticky top-0 z-20 ${COLUMN_BLEED_X}`}>
      {/* THE PANEL. Opaque, so nothing composites through it; a hairline on the
          bottom, a radius and a soft shadow, so it is unambiguously an object
          sitting over the conversation rather than an undeclared band of
          colour.

          The hairline is `border-b` ONLY, and that is a layout decision, not a
          taste one. Tailwind's box model is `border-box`, so a border down the
          left and right sides eats 1px out of the padding box at each end and
          lands the controls at 543…1253 against a column at 542…1254 — the
          same near-miss, one tenth the size, reintroduced by the fix for it.
          The alternatives were a second declaration of the column's padding
          (`px-[calc(1rem-1px)]`) or a bleed that knows about the border
          (`-mx-[17px]`); both re-state a constant this file is not allowed to
          own. `bg-surface` against the canvas's `bg-bg`, plus the shadow, is
          what declares the sides. */}
      <div
        class={`pointer-events-auto relative z-10 rounded-b-xl border-b border-border bg-surface
          shadow-sm ${COLUMN_PX}`}
      >
        {/* ── MOBILE IS ONE BAR, AND THAT IS THE DONOR'S ANSWER (round 4) ──
            Round 2 shaved padding off a TWO-ROW plate and got it to ~100px.
            Measured again at 375x812 that is still 101px of plate under a 56px
            house bar, with a 24px ramp under it: 181px, 22.3% of the viewport,
            before the first word of an answer. The donor spends ONE 52px bar
            (`Chat/Header.tsx`: `flex h-[52px] w-full items-center gap-2 p-2`).

            So the shape is COPIED from that file rather than tuned again. Its
            mobile row is four targets in one line —

              <div className="flex flex-shrink-0 items-center md:hidden">
                <OpenSidebar … />
              </div>
              <div className="flex min-w-0 flex-1 items-center gap-2 …">
                <ModelSelector … />
              </div>
              <div className="flex flex-shrink-0 items-center gap-2 …">
                {!isNewChat && <NewChat className="md:hidden" />}
                <HeaderMenu … className="md:hidden" />
              </div>

            — and the three properties that make it fit are the ones taken
            here: the picker group is the ONLY flexible child (`min-w-0
            flex-1`), everything else is `flex-shrink-0`, and THERE IS NO
            CONVERSATION TITLE on the mobile row at all. `py-1` + the 44px
            drawer toggle puts this plate at 53px against the donor's 52 — the
            extra pixel is this plate's bottom hairline, which the donor's
            gradient bar does not have and this one is not giving up (see the
            note above it). Measured after: plate 101px -> 53px, and the first
            line of an answer moves from y=181 to y=133.

            ── ROUND 5: AND THE SECOND BAR IS GONE TOO ───────────────────
            Round 4 called the 56px house bar "not this file's to spend" and
            left it, which bought 19px of a 108px problem: 133 = 56 (shell) + 53
            (this plate) + 24 (ramp). But the donor does not merely keep its
            chat bar small — it has NO OTHER BAR. `Chat/Header.tsx` is the app
            bar: one 52px row, `absolute top-0`, with the whole surface under it.
            Two bars is the defect; a thinner second bar is still two bars.

            So below `lg` the house header now stands down on this route
            (Header.tsx / `pageOwnsTopBar`) and THIS is the app bar. Measured at
            375x812: chrome 109px -> 53px, first ink y=133 -> y=77, of which 24
            is the ramp (unchanged and deliberately so — steepening it is how a
            fade starts slicing glyphs). The donor lands its first line at y=48
            under a 52px bar because its bar floats and its text runs beneath a
            gradient; ours is opaque and in the flow, which is the fix for the
            smearing this file's opening note describes, and the 24px it costs
            is the ramp that fix requires. 53 + 24 against the donor's 48 is the
            whole remaining difference.

            Nothing was removed to get it. What the house bar carried below `lg`
            moved: its nav toggle onto this row (see the trailing group), its
            account controls — notifications, theme, sign out — into the nav
            drawer that toggle opens, which is where the donor keeps them too
            (`UnifiedSidebar/mobile/Header.tsx` renders `AccountSettings` inside
            the drawer). Above `lg` the house header is untouched.

            WHAT MOVED, AND WHAT DID NOT:
              - the title is `hidden sm:block`. It is still in the DOM, still
                carries `data-tour="chat-title"`, and is still the first thing
                on the row from `sm` up; the donor's mobile header simply has
                no title, and a 323px column cannot carry one plus four
                controls. No tour step targets it.
              - BOTH pickers stay on the bar, and as of ROUND 6 they stay on
                it READABLE. Side by side they had 82.5px of pill and 45px of
                label each: the bar read "Netz…" and "Agen…" and no longer
                named the agent or the model, which is the governance fact this
                header exists to publish, where the donor's single selector
                reads "mock-sonnet" in full. That is not a truncation to shrug
                at — it is the control failing to state its value.

                It is arithmetic, not taste, and the arithmetic has no side-by
                -side answer. The bar's content box at 375 is 327px; three
                44x44 touch targets and four gaps take 156 of it; 171 is left,
                so two pills are 82.5px each and a pill spends 38px on its
                border, padding and icon before a glyph. "Netzar Prime" is 80px
                of text and "Agent default" is 84px. Two values cannot both be
                read on one 375px line with three touch targets on it, whatever
                is shaved.

                So the flexible slot — the ONE slot the donor lets flex — turns
                the column instead of the row below `sm`. Each picker then gets
                the whole 171px, which is 113px of label after its chrome, and
                both values render WHOLE in both themes. The cost is vertical
                and it is stated rather than hidden: the pills go to `py-1`, the
                stack's gap is 2px, and the plate grows from 53px to ~72px, so
                the first line of an answer moves from y=77 to about y=96
                against the donor's 48. It is still ONE bar — one plate, one
                hairline, one shadow — and it is still less than half the 152px
                E1 was written about.

                The caret comes back with the room. It was dropped below `sm`
                because "the caret and its gap are 22px out of a 112px control,
                which is a third of the label"; on a 171px control it is 13% and
                both labels still fit whole, so the affordance that says the
                pill opens is affordable again. The note's own arithmetic turned
                over, so the decision does.

                Neither picker is hidden, neither moves behind a menu, and both
                keep their tour anchors — the roll-call still enumerates every
                agent and every model through them, and the full value is still
                in each trigger's `title` and `aria-label` for a name longer
                than any bar.
              - the 44px drawer toggle stays 44px (touch minimum), and New chat
                becomes an icon button below `sm`. Round 4's note claimed 44x44
                for it and shipped `max-sm:size-9`, which is 36 — measured at
                36x36 on the delivered frame, on the same bar whose other two
                icon controls are 44 and in the same file that calls 44 the
                touch minimum. It is `max-sm:size-11` now, so all three icon
                targets on the mobile row are 44x44 and the claim and the class
                agree. It costs the pickers 4px each; they truncate one
                character sooner. Its label is `hidden sm:inline` and the button
                carries the same words as its accessible name, so nothing is
                lost to a screen reader.

            ── E2: ONE BAR, ONE OBVIOUS OPENER ───────────────────────────────
            The two openers used to be a bare 32x32 hamburger at x=24…56, y=12…44
            in the house header and a bordered 44x44 pill at x=24…68, y=68…112
            here — same edge, 24px apart, opening different panels, with the
            visually weaker one on top. Round 4 pushed this pill to the trailing
            group, which separated them by 245px but left both bars standing and
            still gave the top-left corner to the control that opens the WRONG
            drawer for someone reading a conversation.

            Now there is one bar. The conversation opener leads it, in the
            donor's own slot; the house nav toggle ends it. They are on opposite
            edges, they are different chrome (bordered pill vs ghost), and they
            are different glyphs (`PanelLeftOpen` vs the product-wide hamburger)
            — see the note at each. This pill is otherwise untouched: 44x44,
            `aria-expanded`, `aria-controls`, and the focus handoff in both
            directions. */}
        <div
          /* `py-1` below `sm`, `py-2` from there up. The `sm:py-3` this shipped
             with cost a 1280px reader 8px of plate for nothing the controls
             needed — measured, plate 65.4px -> 57.4px against the donor's 52px
             bar, first content y 89.4 -> 81.4 against the donor's 57.0. It is
             the last of the vertical economy this file owns; what is left is
             the 40px trigger and the 24px ramp, and both are load-bearing. */
          class="flex flex-wrap items-center gap-1.5 py-1 sm:gap-2 sm:py-2"
        >
          {/* THE LEFTMOST SLOT, which is the donor's slot for it:

                <div className="flex flex-shrink-0 items-center md:hidden">
                  <OpenSidebar testId="header-open-sidebar-button" />
                </div>

              Round 4 moved this to the trailing group because the house header
              owned the top-left corner with a bare 32x32 hamburger and two
              openers could not share one edge. The corner is no longer taken —
              below `lg` the house header stands down and THIS bar is the app bar
              — so the control that reveals the conversation history is back
              where the donor puts it and where a thumb reaches for it. No order
              class: it is first in the DOM and `order: 0`, so it leads the row
              at every width it exists at (it is `lg:hidden`). */}
          {onOpenSidebar && <OpenSidebarButton onClick={onOpenSidebar} />}

          <h1
            data-tour="chat-title"
            title={title}
            class="hidden min-w-0 flex-1 truncate text-heading-sm font-semibold text-primary
              sm:block sm:order-1 sm:flex-none sm:max-w-[14rem] lg:max-w-[22rem]"
          >
            {title}
          </h1>

          {/* The one flexible child on the mobile row (donor: the slot its
              ModelSelector sits in). `sm:` hands the flex back to the title and
              lets these size to their content again.

              Below `sm` it is a COLUMN: two full-width lines rather than two
              half-width pills, which is the only shape in which both governance
              values are legible on a 375px bar (see the round-6 note above).
              `items-stretch` is what makes each line the full slot width, and
              there is NO gap between them — the two triggers meet on one
              shared hairline (each menu asks for that in its `triggerClass`),
              so the pair reads as ONE governance readout with two rows rather
              than as two controls that happen to be stacked. It also buys back
              3px of every screen: the gap and the second border were 3 of the
              23px this stack costs the transcript. From `sm` up this is exactly
              the row it always was, gap and all four corners included. */}
          <div
            class="flex min-w-0 flex-1 flex-col items-stretch sm:order-2 sm:w-auto
              sm:flex-none sm:flex-row sm:items-center sm:gap-2"
          >
            {/* The two pickers are searchable command menus as of Phase 5
                (CHATUI-005); the tour anchors stay on the wrappers, which is
                where they have always been, so the anchor does not depend on
                which control is inside. `min-w-0 flex-1` below `sm` is what
                lets both share one bar instead of claiming a row each. */}
            <span data-tour="chat-agent-picker" class="min-w-0 sm:flex-none">
              <AgentMenu
                agents={agents}
                agentId={agentId}
                onSelect={onSelectAgent}
                disabled={streaming}
              />
            </span>
            {/* Rendered unconditionally. The old `models.length > 0` guard made
                the model picker — and its tour anchor — disappear entirely
                whenever /models failed or a deployment configured no catalog,
                which is exactly when an operator most needs to see that the
                turn is running on the agent's own model. With no catalog the
                menu still offers "Agent default", which is the honest state. */}
            <span data-tour="chat-model-picker" class="min-w-0 sm:flex-none">
              <ModelMenu
                models={models}
                modelId={modelId}
                onSelect={onSelectModel}
                disabled={streaming}
              />
            </span>
          </div>

          <div
            data-tour="chat-new-chat"
            class="flex shrink-0 items-center gap-2 sm:order-4 sm:ml-auto"
          >
            {/* Which conversation the transcript, cost ledger and audit rows are
                filed under. Governance detail, deliberately visible — it just
                stands down to a quiet monospace chip once the canvas gets narrow.
                `bg-bg` rather than `bg-surface`: the panel is now surface, so a
                surface chip on it would have no edge of its own. */}
            <span
              class="hidden items-center gap-1 rounded-lg border border-border bg-bg px-2 py-1
                font-mono text-caption text-muted xl:inline-flex"
            >
              {chatId}
              <InfoTooltip term="dashboard:" />
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={streaming}
              icon={<Plus size={14} />}
              aria-label="New chat"
              title="New chat"
              class="max-sm:size-11 max-sm:px-0"
              onClick={onNewChat}
            >
              <span class="hidden sm:inline">New chat</span>
            </Button>
          </div>

          {/* THE HOUSE'S NAV TOGGLE, folded into this bar.

              Below `lg` the app shell's header is not on screen (Header.tsx,
              `pageOwnsTopBar`), so its hamburger has to be somewhere, and the
              donor's answer is the chat header's trailing group — the slot its
              `HeaderMenu className="md:hidden"` sits in. Two openers on one bar
              is only a defect when they are indistinguishable; these differ on
              all three axes a person actually uses:

                POSITION  conversation history leads the row; this one ends it,
                          on the opposite edge of the bar.
                CHROME    that one is a bordered pill on `bg-surface` with a
                          shadow — the header's control set. This one is a plain
                          ghost button with no edge and no ground: house chrome,
                          not chat chrome.
                GLYPH     `PanelLeftOpen` (a panel sliding in from the left) vs
                          the product-wide hamburger, which is the SAME glyph
                          the house header draws above `lg` — a person who
                          learned it on any other page finds it here unchanged.

              44x44 like everything else on this row, `aria-controls` naming the
              drawer it opens, and `sm:order-5` so it stays at the end once the
              row spreads out. It is NOT inside the `chat-new-chat` tour anchor:
              that anchor points at the new-chat control, and growing it to
              cover an unrelated button would move the spotlight. */}
          {onOpenAppNav && (
            <button
              type="button"
              onClick={onOpenAppNav}
              aria-label="Open main navigation"
              aria-controls={APP_NAV_DRAWER_ID}
              aria-expanded={false}
              title="Main navigation"
              class="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted
                transition-colors duration-fast hover:bg-surface-hover hover:text-primary
                focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary
                lg:hidden sm:order-5"
            >
              <Menu size={20} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {/* THE RAMP. The mirror of the composer's `h-6 bg-gradient-to-t from-bg-a`
          (ChatCanvas), pointing the other way: opaque page ground at the rule,
          fading to nothing 24px down, so a line of text approaching the header
          fades out over most of its own height instead of being sliced by the
          rule. `from-bg-a` is the alpha-capable canvas ground — the SAME hue
          the transcript sits on, in both themes — so the ramp is invisible
          where nothing is under it, which is exactly what the at-rest frame
          shows. */}
      <div class="pointer-events-none h-6 bg-gradient-to-b from-bg-a" aria-hidden="true" />
    </div>
  );
}
