/*
 * Structure ported from danny-avila/LibreChat (MIT), pinned at commit
 * 6d499ba3ce17f906a7762429c61018f230ecd64e — donor paths
 * `client/src/components/Chat/Messages/Content/ToolCallGroup.tsx` and
 * `client/src/components/Chat/Messages/Content/ToolOutput/{StackedToolIcons,
 * ToolIcon}.tsx`.
 *
 * The collapsed summary expands to the ordered calls with their inputs and
 * results. P2 carries inputs live (never stored) and results capped at 2 KB
 * (stored with the assistant turn), so both panels now have their data.
 * Reopened turns show results only; stopped turns may include unfinished calls.
 *
 * Categories still come from humanized labels.
 *
 * The donor keys its glyphs off raw tool NAMES (`web_search`,
 * `mcp__slack__…`). By the time a label reaches this client the backend has
 * already humanized it — `humanizeToolName()` in src/lib/tools/humanize.ts
 * turns `mcp__slack__slack_search_public` into "Slack: search public" — so the
 * mangled form is gone and the classifier has to read the human string. That is
 * why the rules below match words rather than identifiers, and why the last
 * rule before the fallback is "has a `Server: tool` colon", which is precisely
 * the shape humanizeToolName gives every MCP connector call.
 */
import { useState, useId } from 'preact/hooks';
import type { ToolCall } from '../../lib/chat/types';
import useExpandCollapse from './lc/hooks/Messages/useExpandCollapse';
import {
  ChevronDown,
  FileSearch,
  FileText,
  Globe,
  Image as ImageIcon,
  Terminal,
  Wrench,
} from 'lucide-preact';

// The capped boxes scroll on their own, so each is a tab stop (with the page's
// focus ring) and carries a name — a screen reader hears which payload it is on.
const TOOL_PAYLOAD_CLASS =
  'max-h-48 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-surface-elevated p-2 font-mono text-caption text-secondary ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary';

type ToolKind = 'web' | 'knowledge' | 'code' | 'image' | 'document' | 'connector' | 'generic';

const KIND_ICON: Record<ToolKind, typeof Globe> = {
  web: Globe,
  knowledge: FileSearch,
  code: Terminal,
  image: ImageIcon,
  document: FileText,
  connector: Wrench,
  generic: Wrench,
};

/**
 * Classify a humanized tool label into a glyph category.
 *
 * Order matters: the topic rules run BEFORE the connector rule, so
 * "Knowledge: search" is filed as knowledge rather than as a generic connector
 * call, while "Slack: search public" — which matches no topic — falls through
 * to the connector shape that its `Server: tool` colon identifies.
 */
export function toolKind(label: string): ToolKind {
  const n = label.toLowerCase();
  if (/\bweb\b|browser|fetch|http|url|crawl/.test(n)) return 'web';
  if (/knowledge|vector|embed|index|recall|memory|retriev/.test(n)) return 'knowledge';
  if (/code|bash|shell|terminal|execute|script|interpreter/.test(n)) return 'code';
  if (/image|photo|picture|diagram|chart|render/.test(n)) return 'image';
  if (/document|report|file|pdf|docx|slide|artifact/.test(n)) return 'document';
  if (n.includes(':')) return 'connector';
  return 'generic';
}

/**
 * The donor's overlapping glyph stack: one disc per DISTINCT category, capped,
 * with a `+N` disc for the rest. Distinct rather than per-call on purpose — a
 * turn that hits the same connector six times should read as one kind of work,
 * not as six identical wrenches.
 */
function StackedToolIcons({ kinds }: { kinds: ToolKind[] }) {
  const unique: ToolKind[] = [];
  for (const k of kinds) if (!unique.includes(k)) unique.push(k);
  const visible = unique.slice(0, 3);
  const overflow = unique.length - visible.length;

  return (
    <span class="flex shrink-0 items-center" aria-hidden="true">
      {visible.map((kind, i) => {
        const Icon = KIND_ICON[kind];
        return (
          <span
            key={kind}
            class={`relative flex h-[22px] w-[22px] items-center justify-center rounded-full
              border border-border bg-surface text-secondary ${i > 0 ? '-ml-2' : ''}`}
            style={`z-index:${visible.length - i}`}
          >
            <Icon size={12} />
          </span>
        );
      })}
      {overflow > 0 && (
        // TOPMOST, not bottom-most. The icon discs descend in z-order so each
        // one tucks under the one before it, but this disc carries TEXT, and at
        // the bottom of that stack the preceding disc covered its "+" — the
        // badge read as "›2". A glyph losing 8px is decoration degrading; a
        // count losing its sign is information degrading, so the count wins the
        // top of the stack (which is also how every +N avatar pile is drawn).
        <span
          class="relative -ml-2 flex h-[22px] w-[22px] items-center justify-center rounded-full
            border border-border bg-surface-elevated text-overline text-secondary"
          style={`z-index:${visible.length + 1}`}
        >
          +{overflow}
        </span>
      )}
    </span>
  );
}

interface ToolCallsSectionProps {
  tools: ToolCall[];
}

export function ToolCallsSection({ tools }: ToolCallsSectionProps) {
  // Collapsed by default under a settled or stopped reply: the answer comes
  // first, and one click reveals the calls, including any interrupted ones.
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const { style, ref: expandRef } = useExpandCollapse(open);

  const kinds = tools.map((t) => toolKind(t.label));
  // Deduplicated, order-preserving name summary, three then "+N" — the donor's
  // header hint, which is what makes the collapsed line worth reading at all.
  const names: string[] = [];
  for (const t of tools) if (t.label && !names.includes(t.label)) names.push(t.label);
  const summary =
    names.length <= 3 ? names.join(', ') : `${names.slice(0, 3).join(', ')}, +${names.length - 3}`;
  const heading = `Used ${tools.length} tool${tools.length === 1 ? '' : 's'}`;

  return (
    <div class="mb-2" data-chat-tools={tools.length}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        // Stable hook for the capture harness and browser QA: this section is
        // the whole of Phase 3b, and evidence that it rendered must not depend
        // on a class list that Phases 4-7 are free to restyle.
        data-chat-tools-toggle
        class="flex w-full min-w-0 items-center gap-2 rounded-lg py-1 pr-1 text-left text-caption
          text-secondary transition-colors duration-fast hover:text-primary
          focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <StackedToolIcons kinds={kinds} />
        <span class="shrink-0 font-medium">{heading}</span>
        {summary && (
          // Caps at 40% of the row so a chatty connector name can never push
          // the chevron off the end; the full list is one click away anyway.
          <span class="min-w-0 max-w-[40%] truncate font-normal text-muted" title={summary}>
            · {summary}
          </span>
        )}
        <ChevronDown
          size={14}
          class={`ml-auto shrink-0 transition-transform duration-normal ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {/* ── ANIMATED DISCLOSURE (donor useExpandCollapse.ts, 55 lines) ─────
          This used to be `{open && <ol>}` — unmounted on collapse, which is
          why it could not animate at all: there is nothing to transition from
          when the subtree does not exist. The donor's hook is the grid trick:
          the wrapper is `display: grid` and its `grid-template-rows` goes
          `0fr` → `1fr`, which is the one way to transition to a height the
          content decides rather than to a magic pixel number.

          Two things it does that a hand-rolled version reliably forgets, and
          the reason to take the file rather than write four lines:

            1. `inert` is set on the collapsed subtree, imperatively, in a
               LAYOUT effect. A `0fr` grid row is visually clipped but its
               children are still focusable — without this, tabbing through a
               finished reply lands inside a closed tool list.
            2. `prefers-reduced-motion` SHORTENS the transition to 0.01ms
               instead of removing it. `transition: none` emits no
               `transitionend`, and any consumer waiting on that event to
               unmount would leave every closed panel mounted for exactly the
               readers who asked for less motion.

          `overflow-hidden` on the inner element is what the grid row clips
          against; it is ours, not the hook's, because the hook styles only the
          wrapper. */}
      <div style={style} ref={expandRef}>
        <div class="overflow-hidden">
        <ol
          id={panelId}
          data-chat-tools-list
          class="mt-1 space-y-px border-l border-border pl-3 text-caption"
        >
          {tools.map((t, i) => {
            const Icon = KIND_ICON[kinds[i]];
            return (
              <li key={`${t.step}-${i}`} class="min-w-0 py-1">
                <div class="flex min-w-0 items-center gap-2">
                  {/* The step number IS the governance datum: it is the ordinal
                      the agent loop stamped on the call, and it is what a run in
                      the audit log is reconciled against. Monospace and fixed
                      width so the column of numbers stays a column. */}
                  <span class="w-6 shrink-0 text-right font-mono text-muted tabular-nums">
                    {t.step}
                  </span>
                  <Icon size={13} class="shrink-0 text-muted" />
                  <span class="min-w-0 truncate text-secondary" title={t.label}>
                    {t.label}
                  </span>
                </div>
                <div class="ml-8 min-w-0 space-y-1">
                  {t.input !== undefined && (
                    <>
                      <div class="text-caption text-muted">Input</div>
                      <pre class={TOOL_PAYLOAD_CLASS} tabIndex={0} aria-label="Tool input">{t.input}</pre>
                      {t.inputTruncated && <div class="text-caption text-muted">Input shortened</div>}
                    </>
                  )}
                  {t.output !== undefined && (
                    <>
                      <div class="text-caption text-muted">Output</div>
                      <pre class={TOOL_PAYLOAD_CLASS} tabIndex={0} aria-label="Tool output">{t.output}</pre>
                    </>
                  )}
                  {/* A call that started but has no result: the Stop interrupted it. */}
                  {t.toolUseId !== undefined && t.output === undefined && (
                    <div class="text-caption text-muted">No result</div>
                  )}
                  {t.truncated && <div class="text-caption text-muted">Output shortened</div>}
                  {t.isError && (
                    <span class="inline-flex rounded border border-danger-a/40 bg-danger-a/10 px-1.5 py-0.5 text-caption text-danger">
                      Failed
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
        </div>
      </div>
    </div>
  );
}
