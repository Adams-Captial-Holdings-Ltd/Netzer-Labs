/*
 * Composed from files copied out of danny-avila/LibreChat (MIT), pinned at
 * commit 6d499ba3ce17f906a7762429c61018f230ecd64e — donor paths
 * `client/src/components/Chat/Messages/ui/MessageRow.tsx` (the row and the
 * author header it now builds itself),
 * `client/src/components/Chat/Messages/ui/HeaderLabel.tsx`,
 * `client/src/components/Chat/Messages/ui/MessageTimestamp.tsx`,
 * `client/src/components/Chat/Messages/SubRow.tsx` (the quiet footer row),
 * `client/src/components/Chat/Messages/MinimalHoverButtons.tsx` (the copy
 * action) and `client/src/components/Chat/Messages/Content/CancelledIcon.tsx`.
 * The copies themselves live under ./lc/, each with its own provenance header
 * and its own edit list; this file is the composition.
 *
 * ── The author line is no longer written here ─────────────────────────────
 *
 * `AuthorLine` used to live in this file: a hand-written transcription of the
 * donor's header (mark, name, time) plus a hand-transcribed copy of its
 * `revealOnRowHoverClasses` variant chain. All of it is gone. The donor's own
 * row now builds the header from `icon` / `label` / `hoverLabel` / `timestamp`
 * (see ./MessageRow.tsx and ./lc/components/Chat/Messages/ui/), and the reveal
 * is the donor's stylesheet rule, copied verbatim into index.css.
 *
 * What that bought, beyond deleting the transcription: `hoverLabel` shows the
 * MODEL that answered, crossfading from the agent name on hover or keyboard
 * focus. The run footer below reports the model too, but as an audit figure in
 * mono alongside latency and cost — and only on turns that reached `final`. A
 * historical turn reloaded from `/sessions/transcript` has no `meta` at all, so
 * `hoverLabel` is null there and HeaderLabel falls to its plain-span branch.
 * Two registers, one datum, neither redundant with the other.
 *
 * Because an assistant turn has no box (see MessageRow), the author line is
 * what marks where one reply ends and the next begins. On this product it does
 * more work than it does on the donor, because WHICH of the seventeen agents
 * answered is a governance fact, not decoration.
 *
 * ── The run footer is the product, not chrome ──────────────────────────────
 *
 * Model, latency and metered cost under every reply is the visible edge of the
 * cost ledger the buyer is paying for, so it is rendered to be READ:
 *
 *   - `text-secondary`, not `text-muted`. Muted is #9898b0, which on the light
 *     ground (#fafafa) is roughly 2.6:1 — under the 4.5:1 floor for body text
 *     and genuinely hard to read. Secondary clears it in both themes.
 *   - never revealed on hover. Hover-gating is right for a timestamp and wrong
 *     for an audit figure; a number you have to go looking for is a number
 *     nobody checks.
 *   - each segment carries an `sr-only` name, so a screen reader hears
 *     "Model claude-sonnet-4-5, latency 3180 milliseconds, cost $0.0164"
 *     instead of three bare tokens separated by middots.
 *
 * The FORMAT is deliberately identical to `formatTurnFooter()` in
 * src/lib/tools/humanize.ts, which renders the same fields on Telegram and both
 * Slack send paths — same model shortening, same `ms`, same 4-decimal dollars,
 * same `N tool(s)`. CLAUDE.md's chat-surface parity rule makes that a contract:
 * change the copy here and the other surfaces have to move with it.
 */
import type { ArtifactRef, Message, TurnMeta } from '../../lib/chat/types';
import { renderMarkdown } from '../../lib/chat/markdown';
import { ArtifactCard } from './ArtifactCard';
import { AgentMark, MessageRow, isoFromEpochSeconds } from './MessageRow';
import { ToolCallsSection } from './ToolCallsSection';
import { Button } from '../Button';
import CancelledIcon from './lc/components/Chat/Messages/Content/CancelledIcon';
import MinimalHoverButtons from './lc/components/Chat/Messages/MinimalHoverButtons';

/**
 * The model that answered, shortened the way the run footer shortens it, or
 * null when this turn carries no run metadata (every historical turn). Feeds
 * the donor header's `hoverLabel`.
 */
export function modelLabel(meta: TurnMeta | undefined): string | null {
  const id = meta?.modelId;
  if (!id) return null;
  return id.split('.').pop() ?? null;
}

function Sep() {
  return (
    <span aria-hidden="true" class="text-muted">
      ·
    </span>
  );
}

interface RunFooterProps {
  meta: TurnMeta;
  /**
   * False when a ToolCallsSection is already rendering the per-call list above
   * — the count would then say twice, less precisely, what the section says
   * once. Historical turns (no `tools` array on the message) pass true and keep
   * the count as their only record of tool activity.
   */
  showToolCount: boolean;
}

export function RunFooter({ meta, showToolCount }: RunFooterProps) {
  // One shortening, shared with the author line's `hoverLabel`, so the header
  // and the footer can never disagree about what answered.
  const model = modelLabel(meta) ?? '';
  const tools = showToolCount && meta.toolCallCount > 0 ? meta.toolCallCount : 0;

  return (
    <div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 pt-0.5 font-mono text-caption text-secondary">
      {model && (
        <span>
          <span class="sr-only">Model </span>
          {model}
        </span>
      )}
      {model && <Sep />}
      <span>
        <span class="sr-only">Latency </span>
        {Math.round(meta.latencyMs)}ms
      </span>
      <Sep />
      <span>
        <span class="sr-only">Metered cost </span>${meta.costUsd.toFixed(4)}
      </span>
      {tools > 0 && (
        <>
          <Sep />
          <span>
            {tools} tool{tools === 1 ? '' : 's'}
          </span>
        </>
      )}
    </div>
  );
}

/**
 * What a turn the reader cancelled has instead of a run footer.
 *
 * It cannot have one: a stopped turn never reaches its `final` event, so there
 * is no modelId, no latency and no metered cost to report here. Since P2 the
 * turn's usage IS recorded — the server settles it from an estimate that errs
 * on the safe side — so the footer says the cost was estimated rather than that
 * no run was recorded, and still shows no numbers: printing the ones we happen
 * to have (or worse, zeros) in the audit row would be a lie in the one place on
 * this page that must not lie. Same type and same sub-row as RunFooter, so the
 * transcript's rhythm is unbroken.
 */
function StoppedFooter() {
  return (
    <div class="flex items-center gap-2 pt-0.5 font-mono text-caption text-secondary">
      {/* The donor's CancelledIcon (9 lines, copied), replacing a grey dot that
          shared its shape with the streaming pulse and said nothing on its own.
          An X reads as "this was stopped" without a legend. The wrapper gives
          it a box to fill, because the donor's own icon is `h-full w-full` — it
          is drawn to sit in a run-step slot, not to size itself. */}
      <span aria-hidden="true" class="size-4 shrink-0">
        <CancelledIcon />
      </span>
      <span>stopped — partial reply, cost estimated</span>
    </div>
  );
}

interface AssistantMessageProps {
  message: Message;
  agentName: string;
  agentId: string;
  chatId: string;
  onOpenArtifact: (ref: ArtifactRef, opener: HTMLButtonElement) => void;
  canRetry: boolean;
  needsAttachments: boolean;
  onRetry: () => void;
  canRegenerate: boolean;
  onRegenerate: () => void;
}

export function AssistantMessage({ message, agentName, agentId, chatId, onOpenArtifact, canRetry, needsAttachments, onRetry, canRegenerate, onRegenerate }: AssistantMessageProps) {
  const tools = message.tools ?? [];

  return (
    <MessageRow
      isCreatedByUser={false}
      icon={<AgentMark name={agentName} />}
      label={agentName}
      hoverLabel={modelLabel(message.meta)}
      headerPrefix="Assistant: "
      ariaLabel="Assistant message"
      timestamp={isoFromEpochSeconds(message.ts)}
      footer={
        // `items-center gap-3` rather than SubRow's own `gap-3` alone: the run
        // footer is a 13px mono line and the copy control is a 31px button, so
        // the two need a shared baseline or the reading sits on the button's
        // ascender. Everything in here is ONE row on purpose — the footer slot
        // is the same slot the live row's elapsed readout occupies, and it must
        // not grow a second line when a turn settles.
        <div class="flex items-center gap-3">
          {message.meta ? (
            <RunFooter meta={message.meta} showToolCount={tools.length === 0} />
          ) : message.stopped ? (
            <StoppedFooter />
          ) : null}
          {/* The action row: Copy on replies, Regenerate on the last saved reply.

              ── ROUND 3: `chat-row-actions` IS WHAT MAKES IT EXIST ON TOUCH ──

              The donor hides this button until the row is hovered, via
              `revealOnRowHoverClasses`, whose escape hatch is
              `[@media(hover:hover)]:opacity-0` — hover-gated only where hover
              is possible. That is the right instinct and it is not sufficient,
              because "the browser reports a hoverable pointer" is not the same
              question as "this reader can hover". Measured on the settled
              `code` fixture at 375x812: computed opacity `0`, i.e. the one
              action this harvest added is invisible on a phone-width window
              that still reports `(hover: hover)` — a narrow desktop window, a
              hybrid laptop, and every mobile frame in the screenshot bar. On
              the same viewport with touch emulation on it computes `1`, so the
              donor's rule was doing its job and the job was too narrow.

              So the width joins the pointer: below `lg` — this product's own
              definition of the compact layout, the breakpoint where the
              conversation rail becomes a drawer — the action is simply THERE.
              That is what a real phone already shows, so the narrow window now
              agrees with the phone instead of inventing a third state, and it
              is what the donor's own mobile frames show. The rule is one
              additive block in index.css keyed on this class; the copied file
              is untouched by it, which is why the hook is here on the wrapper
              and not a fifth edit inside the copy.

              A metadata readout may be hover-gated; an ACTION may not. The
              timestamp is covered by the same block for the same reason — not
              because it is an action, but because it is already visible on a
              phone and there is no reason for a 900px window to disagree. */}
          <div class="chat-row-actions">
            <MinimalHoverButtons message={message} onRegenerate={canRegenerate ? onRegenerate : undefined} />
          </div>
        </div>
      }
    >
      {/* Above the prose, as in the donor: what the agent did to get the answer
          precedes the answer. Live turns only — a reloaded transcript carries
          no tool array, and the footer's count stands in for it. */}
      {tools.length > 0 && <ToolCallsSection tools={tools} />}

      {message.text && (!message.error || message.failure) && (
        // DOMPurify runs inside renderMarkdown, last, immediately before this
        // is handed to dangerouslySetInnerHTML (web/src/lib/chat/markdown.ts).
        <div class="chat-md break-words" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.text) }} />
      )}
      {message.error && (
        // Only the failure sentence belongs in the alert; any partial answer
        // above uses the same markdown treatment as a complete reply.
        <div role="alert" class={`chat-error-panel rounded-xl border border-danger-a/40 bg-danger-a/10 px-4 py-3 ${message.text && message.failure ? 'mt-3' : ''}`}>
          <pre class="whitespace-pre-wrap break-words font-sans text-body-sm">
            {message.failure ?? message.text}
          </pre>
          {canRetry ? <Button variant="secondary" size="sm" onClick={onRetry} class="mt-2">Try again</Button>
            : needsAttachments ? <p class="mt-2 text-body-sm">Please attach the files again.</p> : null}
        </div>
      )}

      <MessageAttachments message={message} agentId={agentId} chatId={chatId} onOpenArtifact={onOpenArtifact} />

      {/* The answer arrived but the server could not store it (`done:
          not_saved`): one caption, so the reader knows it is theirs to copy now
          and will not be here after a reload. */}
      {message.notSaved && (
        <p class="mt-2 text-caption text-secondary">This reply wasn't saved, so it won't be here after a reload.</p>
      )}
    </MessageRow>
  );
}

/**
 * Generated images, artifact download cards and knowledge-base confirmations.
 * Shared with StreamingRow's settled sibling shape and kept out of the prose
 * container so they sit on the page ground at the column's full width, the way
 * the donor's attachment group does.
 */
function MessageAttachments({ message, agentId, chatId, onOpenArtifact }: {
  message: Message;
  agentId: string;
  chatId: string;
  onOpenArtifact: (ref: ArtifactRef, opener: HTMLButtonElement) => void;
}) {
  const images = message.images ?? [];
  const artifacts = message.artifacts ?? [];
  const artifactRefs = message.artifactRefs ?? [];
  const kb = message.kb ?? [];
  if (images.length === 0 && artifacts.length === 0 && artifactRefs.length === 0 && kb.length === 0) return null;

  return (
    <div class="mt-3 space-y-2">
      {images.map((im, j) => (
        <a key={`i${j}`} href={im.url} target="_blank" rel="noopener noreferrer" class="block w-fit">
          <img
            src={im.url}
            alt={im.caption || 'generated image'}
            class="max-h-96 max-w-full rounded-xl border border-border"
            loading="lazy"
          />
          {im.caption && <span class="mt-1 block text-caption text-secondary">{im.caption}</span>}
        </a>
      ))}

      {artifacts.map((a, j) => (
        // `download` plus the tool-issued URL: this href comes straight off the
        // tool result, so its signature is intact — unlike a link the model
        // retypes into its own reply.
        <a
          key={`a${j}`}
          href={a.url}
          download={a.name}
          target="_blank"
          rel="noopener noreferrer"
          class="flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2
            transition-colors duration-fast hover:border-border-strong hover:bg-surface-hover"
        >
          <span class="shrink-0 rounded-md bg-surface-elevated px-1.5 py-1 text-overline uppercase tracking-wider text-secondary">
            {(a.name.split('.').pop() || 'file').slice(0, 4)}
          </span>
          <span class="min-w-0 flex-1 truncate text-body-sm text-primary">{a.name}</span>
          <span class="shrink-0 text-caption text-secondary">Download</span>
        </a>
      ))}

      {artifactRefs.map((artifact) => (
        <ArtifactCard key={`${artifact.artifactId}:${artifact.version}`} artifact={artifact}
          agentId={agentId} chatId={chatId} onOpenArtifact={onOpenArtifact} />
      ))}

      {kb.map((k, j) => (
        <div
          key={`k${j}`}
          class="flex w-fit max-w-full items-center gap-2 rounded-lg border border-border bg-bg-sunken px-2.5 py-1.5 text-caption text-secondary"
        >
          <span aria-hidden="true" class="size-1.5 shrink-0 rounded-full bg-success" />
          <span class="min-w-0 truncate" title={k}>
            {k}
          </span>
        </div>
      ))}
    </div>
  );
}
