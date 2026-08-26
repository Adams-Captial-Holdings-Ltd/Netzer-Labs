/*
 * Structure ported from danny-avila/LibreChat (MIT), pinned at commit
 * 6d499ba3ce17f906a7762429c61018f230ecd64e — donor paths
 * `client/src/components/Chat/Messages/Content/ToolCallGroup.tsx` and
 * `client/src/components/Chat/Messages/Content/ToolOutput/{StackedToolIcons,
 * ToolIcon}.tsx`.
 *
 * ── What this is, and the one thing it deliberately is NOT ─────────────────
 *
 * The buyer is paying for a governed agent platform, and the single most
 * legible proof of that is being able to see what the agent actually DID before
 * it answered. This is that record: a collapsed one-line summary under the
 * reply ("Used 5 tools · web search, Slack: search public, +2"), expanding to
 * the ordered list of calls.
 *
 * It is NOT the donor's tool inspector. The donor renders an Input panel and an
 * Output panel per call because its wire carries `args` and `output` on every
 * tool_call content part. Ours does not: `POST /api/test-turn/stream` emits
 * `event: tool` with `{label, step}` and nothing else (see
 * web/src/lib/chat/stream.ts). Rendering empty Input/Output shells for payloads
 * that do not exist would be a UI that lies about the system behind it, so this
 * phase ports the SHAPE of the group — stacked category glyphs, count verb,
 * deduplicated name summary, collapse — and stops exactly where the data stops.
 * Widening the wire is a backend change and is out of scope here.
 *
 * ── Live turns only ────────────────────────────────────────────────────────
 *
 * `Message.tools` is accumulated by streamTurn during a turn this tab actually
 * watched. A conversation reloaded from `/sessions/transcript` returns role and
 * text only, so historical turns have no `tools` array and keep the run
 * footer's `N tools` count instead. AssistantMessage owns that switch; this
 * component is only ever handed a non-empty list.
 *
 * ── Categories from labels, because labels are all the wire sends ──────────
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
import {
  ChevronDown,
  FileSearch,
  FileText,
  Globe,
  Image as ImageIcon,
  Terminal,
  Wrench,
} from 'lucide-preact';

export interface ToolCall {
  label: string;
  step: number;
}

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
  // Collapsed by default. Every call in this list has already returned (the
  // section only renders under a settled reply), and the answer is what the
  // reader came for — the donor auto-collapses a completed group for the same
  // reason. One click, and it is a full audit row.
  const [open, setOpen] = useState(false);
  const panelId = useId();

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

      {/* Unmounted rather than hidden when collapsed: there is no enter/exit
          animation to preserve here, and a collapsed section holds no state a
          reader could lose (no inputs, no scroll position, nothing editable). */}
      {open && (
        <ol
          id={panelId}
          data-chat-tools-list
          class="mt-1 space-y-px border-l border-border pl-3 text-caption"
        >
          {tools.map((t, i) => {
            const Icon = KIND_ICON[kinds[i]];
            return (
              <li key={`${t.step}-${i}`} class="flex min-w-0 items-center gap-2 py-1">
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
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
