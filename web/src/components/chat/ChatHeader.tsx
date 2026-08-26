/*
 * Structure ported from danny-avila/LibreChat (MIT), pinned at commit
 * 6d499ba3ce17f906a7762429c61018f230ecd64e — donor path
 * `client/src/components/Chat/Header.tsx`.
 *
 * What is ported: the header is an OVERLAY, not a bar in the flow. It floats
 * over the top of the canvas at `absolute inset-x-0 top-0` so the conversation
 * scrolls *under* it and fades out instead of stopping at a hard edge, and its
 * controls read as free-standing pills rather than a toolbar. Donor tokens are
 * translated per docs/features/netzar-chat/README.md; no donor colour survives.
 *
 * What is NOT ported: the donor's endpoint/preset/bookmark/multi-convo menus.
 * This product's header carries the governance controls instead — which agent,
 * which model, and the conversation id the audit trail keys on.
 *
 * ── Why the overlay is two layers, not one gradient ────────────────────────
 * The first cut was a single `bg-gradient-to-b from-bg-a … to-transparent`
 * band. That is unreadable: every pixel of the band is partly transparent, so
 * a message scrolled under it composites *through* the title and between the
 * pills — the conversation title drew straight on top of running body copy at
 * the same size and weight, and word fragments leaked out of the gaps between
 * the agent and model pills. A gradient can only ever fade glyphs; it can
 * never occlude them.
 *
 * So the overlay is split:
 *
 *   1. THE PLATE — the strip the controls actually sit on, painted with the
 *      canvas colour at full opacity. Because it is `bg-bg`, the same ground
 *      the transcript is on, it still reads as pills floating on the page (no
 *      border, no shadow, no visible bar) while occluding completely. Text
 *      passing under it disappears rather than smearing into the title.
 *   2. THE MASK-FADE — a short band immediately below the plate that ramps
 *      that same colour to zero alpha. This is what keeps the donor's soft
 *      overlay feel: content approaching the plate dissolves into it instead
 *      of being guillotined by a hard edge.
 *
 * The scroll container is then padded by the overlay's FULL height (plate +
 * fade), so at rest no message ever begins underneath bare glyphs. That height
 * is measured rather than hard-coded — this header wraps to two rows on a
 * phone, and the agent/model pills grow with their longest label, so any
 * constant is wrong on some viewport. `onHeight` reports it; the page turns it
 * into the `--chat-header-h` custom property that MessagesView pads by.
 */
import { useLayoutEffect, useRef } from 'preact/hooks';
import { Plus } from 'lucide-preact';
import type { Agent, Model } from '../../lib/chat/types';
import { modelOptionLabel } from '../../lib/chat/helpers';
import { Button } from '../Button';
import { Select } from '../Select';
import { InfoTooltip } from '../InfoTooltip';

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
  /**
   * Reports the overlay's painted height (opaque plate + mask-fade) in CSS
   * pixels, on mount and on every resize. The page feeds it back as the
   * transcript's top padding so nothing is ever laid out under the plate.
   */
  onHeight?: (px: number) => void;
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
  onHeight,
}: ChatHeaderProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  // Layout effect, not a plain effect: the measurement has to land before the
  // browser paints, or the first frame shows the transcript sitting under the
  // plate and then jumping down.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || !onHeight) return;
    const report = () => onHeight(el.getBoundingClientRect().height);
    report();
    // Fonts landing, a longer agent label, or a viewport crossing the `sm`
    // breakpoint (where the row stops wrapping) all change this height without
    // any state change here — so observe the element rather than re-deriving.
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [onHeight]);

  return (
    // pointer-events-none on the overlay root, re-enabled on the plate: the
    // mask-fade must not swallow clicks or wheel events aimed at the message
    // scrolling underneath it.
    <div ref={rootRef} class="pointer-events-none absolute inset-x-0 top-0 z-20">
      {/* 1. The plate — opaque, so nothing composites through the controls. */}
      <div class="pointer-events-auto bg-bg">
        <div class="flex flex-wrap items-center gap-2 px-3 py-3 sm:flex-nowrap sm:px-4">
          {/* Mobile falls back to DOM order (title + New chat, then the pickers
              on their own line because that group is w-full); sm+ reorders to
              title · pickers · New chat on a single row. */}
          <h1
            data-tour="chat-title"
            title={title}
            class="min-w-0 flex-1 truncate text-heading-sm font-semibold text-primary
              sm:order-1 sm:flex-none sm:max-w-[14rem] lg:max-w-[22rem]"
          >
            {title}
          </h1>

          <div
            data-tour="chat-new-chat"
            class="flex shrink-0 items-center gap-2 sm:order-3 sm:ml-auto"
          >
            {/* Which conversation the transcript, cost ledger and audit rows are
                filed under. Governance detail, deliberately visible — it just
                stands down to a quiet monospace chip once the canvas gets narrow. */}
            <span
              class="hidden items-center gap-1 rounded-lg border border-border bg-surface px-2 py-1
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
              onClick={onNewChat}
            >
              New chat
            </Button>
          </div>

          {/* w-full on mobile forces the pickers onto their own line; sm:w-auto
              folds them back inline. */}
          <div class="flex w-full min-w-0 items-center gap-2 sm:order-2 sm:w-auto">
            <span data-tour="chat-agent-picker" class="min-w-0">
              <Select
                size="md"
                value={agentId}
                onChange={onSelectAgent}
                options={agents.map((a) => ({ value: a.id, label: a.displayName }))}
              />
            </span>
            {models.length > 0 && (
              <span data-tour="chat-model-picker" class="min-w-0">
                <Select
                  size="md"
                  value={modelId}
                  onChange={onSelectModel}
                  options={[
                    { value: '', label: 'Agent default' },
                    ...models.map((m) => ({ value: m.id, label: modelOptionLabel(m) })),
                  ]}
                />
              </span>
            )}
          </div>
        </div>
      </div>

      {/* 2. The mask-fade — the plate's colour ramped to zero alpha, so the
          transcript dissolves into the header instead of being cut by it.
          `from-bg-a` is the alpha-capable triplet key (README token map); its
          implicit `to` stop is the same colour at alpha 0, which keeps the ramp
          in one hue and avoids the grey cast a fade to `transparent` can leave.
          Not focusable, not hit-testable — purely a scrim. */}
      <div class="h-7 bg-gradient-to-b from-bg-a" aria-hidden="true" />
    </div>
  );
}
