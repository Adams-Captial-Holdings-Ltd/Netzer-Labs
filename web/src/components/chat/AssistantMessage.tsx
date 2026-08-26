/*
 * Structure ported from danny-avila/LibreChat (MIT), pinned at commit
 * 6d499ba3ce17f906a7762429c61018f230ecd64e — donor paths
 * `client/src/components/Chat/Messages/ui/MessageRow.tsx` (author header),
 * `client/src/components/Chat/Messages/ui/MessageTimestamp.tsx`,
 * `client/src/components/Chat/Messages/SubRow.tsx` (the quiet footer row) and
 * `client/src/components/Chat/Messages/styles.ts` (reveal-on-row-hover).
 *
 * ── The author line replaces the card ──────────────────────────────────────
 *
 * Because an assistant turn has no box (see MessageRow), something else has to
 * mark where one reply ends and the next begins. The donor's answer, ported
 * here: a short line above the body carrying a mark, the name of whoever is
 * speaking, and the time. On this product that line does more work than it does
 * on the donor, because WHICH of the seventeen agents answered is a governance
 * fact, not decoration.
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
import type { Message, TurnMeta } from '../../lib/chat/types';
import { renderMarkdown } from '../../lib/chat/markdown';
import { MessageRow } from './MessageRow';
import { ToolCallsSection } from './ToolCallsSection';

/** Up to two initials for the agent mark ("Netzar Prime" → "NP"). */
function agentInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return `${words[0][0]}${words[1][0]}`.toUpperCase();
}

function turnTime(ts: number): string {
  // `ts` is epoch SECONDS (the transcript and the send path both mint it as
  // Date.now()/1000). Guard anyway: a bad value must not throw inside a row.
  const d = new Date(ts * 1000);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

interface AuthorLineProps {
  agentName: string;
  /** Epoch seconds. Omitted on the live row, which has not landed a time yet. */
  ts?: number;
}

/**
 * Mark · name · time. Shared with StreamingRow so the live turn is introduced
 * by exactly the line the settled turn keeps — nothing moves when the stream
 * ends and the message is committed.
 */
export function AuthorLine({ agentName, ts }: AuthorLineProps) {
  const time = ts === undefined ? '' : turnTime(ts);
  return (
    <h3 class="mb-1.5 flex min-h-6 w-full select-none items-center gap-2 text-caption font-semibold text-primary">
      <span
        aria-hidden="true"
        class="flex size-6 shrink-0 items-center justify-center rounded-md border border-primary-a/25
          bg-primary-a/10 text-[10px] font-bold leading-none tracking-tight text-primary-a"
      >
        {agentInitials(agentName)}
      </span>
      <span class="min-w-0 truncate">{agentName}</span>
      {time && (
        // Reveal-on-hover, ported from the donor's `revealOnRowHoverClasses`:
        // hidden until the row is hovered or something inside it takes keyboard
        // focus. The `[@media(hover:hover)]` guard is the point — a touch
        // device cannot hover, so it keeps the time permanently visible rather
        // than making it unreachable.
        <span
          class="ml-auto shrink-0 font-mono text-overline font-normal text-muted
            transition-opacity duration-normal [@media(hover:hover)]:opacity-0
            group-hover:opacity-100 group-focus-within:opacity-100"
        >
          {time}
        </span>
      )}
    </h3>
  );
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
  const model = meta.modelId ? meta.modelId.split('.').pop() : '';
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
 * is no modelId, no latency and no metered cost to report. Printing the numbers
 * we happen to have (or worse, zeros) in the audit row would be a lie in the
 * one place on this page that must not lie, so the slot says plainly what
 * happened and stops there. Same type and same sub-row as RunFooter, so the
 * transcript's rhythm is unbroken.
 */
function StoppedFooter() {
  return (
    <div class="flex items-center gap-2 pt-0.5 font-mono text-caption text-secondary">
      {/* `bg-border-strong`, NOT `bg-muted`: `muted` is a textColor-only key in
          tailwind.config.ts, so `bg-muted` compiles to nothing and the dot
          renders invisible. */}
      <span aria-hidden="true" class="size-1.5 shrink-0 rounded-full bg-border-strong" />
      <span>stopped — partial reply, no run recorded</span>
    </div>
  );
}

interface AssistantMessageProps {
  message: Message;
  agentName: string;
}

export function AssistantMessage({ message, agentName }: AssistantMessageProps) {
  const tools = message.tools ?? [];

  return (
    <MessageRow
      role="assistant"
      header={<AuthorLine agentName={agentName} ts={message.ts} />}
      footer={
        message.meta ? (
          <RunFooter meta={message.meta} showToolCount={tools.length === 0} />
        ) : message.stopped ? (
          <StoppedFooter />
        ) : null
      }
    >
      {/* Above the prose, as in the donor: what the agent did to get the answer
          precedes the answer. Live turns only — a reloaded transcript carries
          no tool array, and the footer's count stands in for it. */}
      {tools.length > 0 && <ToolCallsSection tools={tools} />}

      {message.error ? (
        // The one assistant turn that IS boxed. A failure has to be visibly a
        // failure and not mistakable for a short answer, so it keeps the
        // donor's bordered danger panel — and stays a `<pre>`, because the text
        // is a sanitized error string, never markdown.
        <div class="rounded-xl border border-danger-a/40 bg-danger-a/10 px-4 py-3">
          <pre class="whitespace-pre-wrap break-words font-sans text-body-sm text-danger">
            {message.text}
          </pre>
        </div>
      ) : (
        // DOMPurify runs inside renderMarkdown, last, immediately before this
        // is handed to dangerouslySetInnerHTML (web/src/lib/chat/markdown.ts).
        <div class="chat-md break-words" dangerouslySetInnerHTML={{ __html: renderMarkdown(message.text) }} />
      )}

      <MessageAttachments message={message} />
    </MessageRow>
  );
}

/**
 * Generated images, artifact download cards and knowledge-base confirmations.
 * Shared with StreamingRow's settled sibling shape and kept out of the prose
 * container so they sit on the page ground at the column's full width, the way
 * the donor's attachment group does.
 */
function MessageAttachments({ message }: { message: Message }) {
  const images = message.images ?? [];
  const artifacts = message.artifacts ?? [];
  const kb = message.kb ?? [];
  if (images.length === 0 && artifacts.length === 0 && kb.length === 0) return null;

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
          {im.caption && <span class="mt-1 block text-caption text-muted">{im.caption}</span>}
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
