/*
 * Copied from danny-avila/LibreChat (MIT), pinned at commit
 * 6d499ba3ce17f906a7762429c61018f230ecd64e -- donor path
 * `client/src/components/Chat/Messages/styles.ts`, lines 3-51.
 *
 * Byte-for-byte, no edits. Line 1 is `import { cn } from '~/utils'`, dropped
 * because lines 53-85 (`hoverButtonClasses`, the only consumer of `cn` in the
 * file) are not copied: that helper composes six more donor-only markers
 * (`hover-button-active`, `final-completion`) which have no counterpart here.
 *
 * AssistantMessage.tsx already carried `revealOnRowHoverClasses` transcribed by
 * hand into its author line; it now imports the string from here instead, so
 * there is one copy and the comment explaining WHY it is shaped this way lives
 * next to it.
 */

/**
 * Reveal-on-hover for a control that shares the message footer with the hover actions.
 *
 * Pointer devices fade it out until the row is hovered or keyboard focus lands inside
 * it. Touch devices, which cannot hover, keep it visible.
 *
 * The focus half is `:focus-visible`, not `:focus-within`: clicking a tool card or an
 * expand toggle in the message body leaves focus parked there, and `:focus-within`
 * would hold the whole footer open with the pointer nowhere near the row. An action
 * that opens a surface keeps the toolbar up through `hover-button-active` instead.
 *
 * That focus half reads
 * `:is(:focus-visible, :has(:focus-visible:not(:is(input, textarea, [contenteditable]))))`
 * on the row, and both halves earn their keep:
 *
 * - The row itself has to be tested, not only its descendants. `MessageNav` moves the
 *   reader by setting `tabindex="-1"` on the row and focusing it, and `:has()` never
 *   matches its own subject, so a plain `:has(:focus-visible)` leaves a focused row
 *   showing its focus ring with its metadata and its actions still hidden.
 * - Text-entry controls are excluded from the descendant half, because they match
 *   `:focus-visible` even when a mouse clicks them. `ToolApproval` and
 *   `AskUserQuestion` both render textareas inside a row, and without the exclusion
 *   clicking one pins the row open with the pointer somewhere else entirely. Every
 *   toolbar action is a button, so a keyboard user still never focuses a hidden one.
 *
 * The two halves stay two variants on purpose. Folding them into a single
 * `group-[&:is(...)]` makes Tailwind emit a bare `.group$ { opacity: 1 }` rule, which
 * lightningcss rejects and which fails the production CSS build while leaving `jest`
 * and `tsc` perfectly green.
 *
 * The transition names `color` and `background-color` alongside `opacity` rather than
 * naming opacity alone: `cn` merges the whole `transition-*` group, so a bare
 * `transition-opacity` here would replace the `transition-colors` a `Button` brings and
 * the hover tint would snap instead of fading.
 */
export const revealOnRowHoverClasses =
  'transition-[opacity,color,background-color] duration-theme-normal ease-out group-hover:opacity-100 group-focus-visible:opacity-100 group-has-[:focus-visible:not(:is(input,textarea,[contenteditable]))]:opacity-100 motion-reduce:transition-none [@media(hover:hover)]:opacity-0';

/**
 * The message footer, holding the height of its action row.
 *
 * While an answer streams, every action is withheld and a lone sibling counter
 * renders nothing, so the row measures zero and then springs to the height of the
 * buttons the moment the answer lands. Holding that height from the start is what
 * keeps the transcript from stepping upward under the reader as a response
 * completes. The value is the height of a hover button, `p-1.5` either side of a
 * 19px icon.
 */
export const messageFooterClasses = 'min-h-[31px] text-xs';
