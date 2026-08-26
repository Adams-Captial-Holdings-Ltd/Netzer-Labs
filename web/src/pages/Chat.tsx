import { useState, useEffect, useRef } from 'preact/hooks';
import { useRoute } from 'wouter-preact';
import { Trash2 } from 'lucide-preact';
import { api, getToken, clearApiCache } from '../lib/api';
import type { Agent, Conversation, Message, Model } from '../lib/chat/types';
import {
  MODEL_NAMES,
  freshChatId,
  storedChatId,
  rememberChatId,
  conversationTitle,
  relativeAge,
  friendlyStreamError,
} from '../lib/chat/helpers';
import { installChatCodeCopy } from '../lib/chat/code-block';
import { streamTurn } from '../lib/chat/stream';
import { stageAttachments } from '../lib/chat/uploads';
import { Button } from '../components/Button';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { toast } from '../components/Toast';
import { ChatCanvas } from '../components/chat/ChatCanvas';
import { ChatHeader } from '../components/chat/ChatHeader';
import { ChatLanding } from '../components/chat/ChatLanding';
import { MessagesView } from '../components/chat/MessagesView';
import { ScrollToBottom } from '../components/chat/ScrollToBottom';
import { useChatScroll } from '../components/chat/useChatScroll';

// The chat data/transport layer lives in ../lib/chat (types, helpers,
// markdown, stream, uploads) — extracted verbatim from this file in Phase 0 of
// the chat UI port. This page owns state and composition only; the shell it
// composes (overlay header, scrolling column, landing) lives in
// ../components/chat (Phase 2), and the transcript itself — turn rendering,
// the live row, the tool timeline, scroll behaviour — lives there too as of
// Phase 3 (CHATUI-003).

// What <Button variant="secondary" size="md"> emits, verbatim (see
// ../components/Button.tsx). The two composer controls that need an
// `aria-label` or a QA hook render as native <button>s — the shared component
// forwards neither — and this constant is what keeps them pixel-identical to
// every other secondary button in the app.
const COMPOSER_BTN =
  'inline-flex items-center justify-center font-medium rounded-lg transition-all duration-normal ' +
  'bg-surface border border-border text-primary hover:bg-surface-hover ' +
  'px-4 py-2 text-body-sm gap-2 ' +
  'disabled:opacity-50 disabled:cursor-not-allowed ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2';

export function Chat() {
  const [, params] = useRoute('/chat/:agentId');
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentId, setAgentId] = useState(params?.agentId ?? '');
  const [models, setModels] = useState<Model[]>([]);
  // '' = let the agent use its own configured model. A non-empty value is a
  // per-turn modelOverride sent with each send (the agent gains access to
  // every model the platform is configured for).
  const [modelId, setModelId] = useState('');
  const [chatId, setChatId] = useState(freshChatId);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  // Epoch ms the in-flight turn was dispatched. The live row counts up from it,
  // which is the difference between "something is happening" and "this has been
  // running for 40 seconds" — the caret alone cannot say which.
  const [streamStartedAt, setStreamStartedAt] = useState(0);
  // The cumulative text as of the LAST chunk, readable synchronously. `send()`
  // closes over `streamText` at the value it had when the turn started (''), so
  // the state is useless to the abort path — and the abort path is precisely
  // where the partial answer has to be recovered and kept.
  const streamTextRef = useRef('');
  // Aborts the in-flight turn (the composer's Stop control). Null when idle.
  const abortRef = useRef<AbortController | null>(null);
  // Live tool-call status, mirroring Telegram/Slack (CLAUDE.md "Chat surface
  // parity"). Shown while the agent works a tool; cleared when text resumes.
  const [toolStatus, setToolStatus] = useState('');
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  // The conversation the delete dialog is armed for (null = dialog closed).
  const [pendingDelete, setPendingDelete] = useState<Conversation | null>(null);
  // `deleting` drives the button label; `deletingRef` is what actually guards
  // against duplicate requests. State is NOT enough on its own: setDeleting(true)
  // does not apply until the next render, so a fast double-click runs both
  // handlers against the same stale `deleting === false` closure and fires two
  // DELETEs. Verified: three synchronous clicks produced three requests (one
  // 200 plus two 404s, so the user saw a success toast and two error toasts for
  // one action). A ref updates synchronously, which closes that window.
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  // Files staged for the next send (uploaded via presigned PUT on send, which
  // bypasses the CloudFront WAF 8KB body cap — same pattern as Knowledge).
  const [files, setFiles] = useState<File[]>([]);
  // Set when the initial /agents load fails, so the tab shows WHY it's empty
  // instead of a silently dead chat (send() early-returns without an agent).
  const [loadError, setLoadError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Focused after a landing starter chip drops its text into the composer, so
  // the caret is already where the user will keep typing.
  const inputRef = useRef<HTMLInputElement>(null);

  // Stick to the end of a streaming answer, let go the moment the reader
  // scrolls away, and offer them a way back. The rules (and why the attach and
  // detach thresholds differ) are documented in the hook.
  const { scrollRef, endRef, showJump, jumpToBottom } = useChatScroll({
    // Every value that changes the transcript's height, in one string: a turn
    // committed, another cumulative chunk, a tool status appearing or clearing.
    revision: `${messages.length}:${streamText.length}:${toolStatus.length}`,
    streaming,
  });

  useEffect(() => {
    // Code blocks are injected as sanitized HTML, so their copy buttons cannot
    // carry a Preact handler. One delegated document listener serves every
    // block on the page; the call is idempotent.
    installChatCodeCopy();
    api.get<{ agents: Agent[] }>('/agents').then((d) => {
      const active = d.agents.filter((a) => a.status === 'active');
      setAgents(active);
      // Default to (and recover to) an ACTIVE agent — the only ones in the
      // dropdown. The old code used d.agents[0], which could be inactive and
      // absent from the options, leaving the selector blank while send() still
      // routed messages to that inactive agent.
      if (active.length > 0 && !active.some((a) => a.id === agentId)) {
        setAgentId(active[0].id);
      }
    }).catch((e) => {
      // Don't fail silently: a swallowed /agents error left the tab dead (empty
      // dropdown, send() early-returns) with no explanation. Log + surface it.
      console.error('Chat: failed to load agents', e);
      setLoadError('Could not load agents. Refresh the page to try again.');
    });
    api.get<{ models: Model[] }>('/models')
      .then((d) => setModels(d.models ?? []))
      // A models failure degrades gracefully (the picker just hides), but still
      // log it so it isn't invisible when debugging.
      .catch((e) => { console.error('Chat: failed to load models', e); });
  }, []);

  // Conversation sidebar. /sessions with an agentId is a single Query on
  // PK=AGENT#<id> (without it the route Scans the whole table), so always
  // scope it. Newest first.
  async function refreshConversations(forAgent: string) {
    if (!forAgent) return;
    setHistoryLoading(true);
    try {
      const d = await api.get<{ sessions: Conversation[] }>(
        `/sessions?agentId=${encodeURIComponent(forAgent)}`,
      );
      const rows = (d.sessions ?? [])
        // Only dashboard chats are browsable here; Telegram/Slack rows share
        // the table but have no UI to reopen them, and still expire.
        .filter((s) => s.chatId.startsWith('dashboard:'))
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      setConversations(rows);
    } catch (e) {
      // Non-fatal: the sidebar is an aid, not a prerequisite for chatting.
      console.error('Chat: failed to load conversations', e);
    }
    setHistoryLoading(false);
  }

  // Load the sidebar whenever the agent changes, and restore the conversation
  // that was open before a reload.
  useEffect(() => {
    if (!agentId) return;
    void refreshConversations(agentId);
    const remembered = storedChatId(agentId);
    if (remembered && remembered !== chatId) void openConversation(remembered);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  // Reopen a stored conversation: point at its chatId and replay its turns.
  // The transcript endpoint returns the real turn array (Sessions.tsx uses the
  // same one). Only the last 20 turns exist server-side — the window cap.
  async function openConversation(id: string) {
    if (streaming) return;
    setChatId(id);
    rememberChatId(agentId, id);
    setStreamText('');
    setMessages([]);
    try {
      const d = await api.get<{ turns?: Array<{ role: string; text: string; ts: number }> }>(
        `/sessions/transcript?agentId=${encodeURIComponent(agentId)}&chatId=${encodeURIComponent(id)}`,
      );
      setMessages(
        (d.turns ?? []).map((t) => ({
          role: t.role === 'user' ? 'user' : 'assistant',
          text: t.text,
          ts: t.ts,
        })),
      );
    } catch (e) {
      console.error('Chat: failed to load transcript', e);
      setLoadError('Could not load that conversation. It may have been deleted.');
    }
  }

  // Start a brand-new conversation: fresh server-side chatId + cleared UI.
  function startNewChat() {
    const id = freshChatId();
    setChatId(id);
    rememberChatId(agentId, id);
    setMessages([]);
    setStreamText('');
  }

  // Permanently delete a conversation. The row IS the conversation (turns are an
  // attribute array on it), so the single DELETE removes the chat and its
  // messages together — there is nothing to clean up client-side beyond state.
  //
  // Optimistic: the row leaves the sidebar immediately, and is put back if the
  // server refuses. Ownership is NOT checked here — the server is the only
  // authority on that (a client-side check would be advisory at best).
  async function confirmDelete() {
    const target = pendingDelete;
    // Ref first, and set synchronously: this is the guard that actually holds
    // against a double-click (see deletingRef above).
    if (!target || deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);

    // Snapshot INSIDE the updater rather than reading `conversations` from the
    // enclosing closure: a refreshConversations() landing between opening the
    // dialog and confirming would otherwise make the rollback restore a stale
    // list and resurrect rows that are legitimately gone.
    let snapshot: Conversation[] = [];
    setConversations((prev) => {
      snapshot = prev;
      return prev.filter((x) => x.chatId !== target.chatId);
    });

    try {
      await api.del(
        `/sessions?agentId=${encodeURIComponent(target.agentId)}` +
          `&chatId=${encodeURIComponent(target.chatId)}`,
      );
      // Only once the server has confirmed: if the deleted chat was the one on
      // screen, fall back to the same empty state "New chat" produces, which
      // also rewrites the sessionStorage pointer so a reload cannot restore a
      // deleted chatId.
      if (target.chatId === chatId) startNewChat();
      clearApiCache(); // /sessions is cached for 60s; a stale list would re-show it
      setPendingDelete(null);
      toast('Chat deleted', 'success');
    } catch (e) {
      // Never navigate and never leave the row hidden on failure. Restore the
      // snapshot, then reconcile against the server: a 404 means EITHER already
      // deleted OR not owned by this principal, and only the server can say
      // which — so refetch rather than guess.
      console.error('Chat: delete failed', e);
      setConversations(snapshot);
      clearApiCache();
      void refreshConversations(target.agentId);
      toast('Could not delete that chat. Please try again.', 'error');
    }
    deletingRef.current = false;
    setDeleting(false);
  }

  // Switching the selected agent must NOT carry the previous agent's chatId.
  // Mint a new one so the next turn starts clean (see freshChatId rationale).
  function selectAgent(id: string) {
    if (id === agentId) return;
    setAgentId(id);
    startNewChat();
  }

  async function send() {
    const text = input.trim();
    const sendFiles = files;
    if ((!text && sendFiles.length === 0) || streaming || !agentId) return;
    setInput('');
    setFiles([]);
    const fileNote = sendFiles.length > 0
      ? sendFiles.map((f) => `📎 ${f.name}`).join('\n')
      : '';
    const userMsg: Message = {
      role: 'user',
      text: text ? (fileNote ? `${text}\n${fileNote}` : text) : fileNote,
      ts: Date.now() / 1000,
    };
    setMessages((prev) => [...prev, userMsg]);
    setStreaming(true);
    setStreamText('');
    streamTextRef.current = '';
    setToolStatus('');
    setStreamStartedAt(Date.now());
    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const token = getToken();
      // Stage each file straight to S3 via a presigned PUT (see
      // ../lib/chat/uploads.ts; the JSON body to the stream endpoint then
      // carries only small s3Key references, far under the WAF 8KB cap).
      const attachments = await stageAttachments(sendFiles, token, setToolStatus);
      setToolStatus('');
      // The SSE parser lives in streamTurn (../lib/chat/stream.ts). Its chunk
      // callback both updates the live preview and clears the tool status —
      // exactly the pre-extraction behavior.
      const outcome = await streamTurn(
        {
          text,
          agentId,
          chatId,
          ...(modelId ? { modelOverride: modelId } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        },
        token,
        {
          onChunk: (t) => { streamTextRef.current = t; setStreamText(t); },
          onToolStatus: setToolStatus,
        },
        // Stop is the only thing this signal does; every other exit path from
        // streamTurn is unchanged.
        { signal: abort.signal },
      );

      if (outcome.errorText) {
        // Mid-stream failure. If text had already streamed, keep it and append a
        // clear error suffix; otherwise show the error on its own. Either way it
        // renders in a red bubble, never as a silent blank reply.
        const msg = friendlyStreamError(outcome.errorText);
        const partial = (!outcome.isReply && outcome.text) ? `${outcome.text}\n\n${msg}` : msg;
        setMessages((prev) => [...prev, { role: 'assistant', text: partial, ts: Date.now() / 1000, error: true }]);
        setStreamText('');
        streamTextRef.current = '';
        setToolStatus('');
        setStreaming(false);
        abortRef.current = null;
        return;
      }

      setMessages((prev) => [...prev, {
        role: 'assistant',
        text: outcome.text,
        ts: Date.now() / 1000,
        ...(outcome.kb.length > 0 ? { kb: outcome.kb } : {}),
        ...(outcome.images.length > 0 ? { images: outcome.images } : {}),
        ...(outcome.artifacts.length > 0 ? { artifacts: outcome.artifacts } : {}),
        ...(outcome.meta ? { meta: outcome.meta } : {}),
        ...(outcome.tools.length > 0 ? { tools: outcome.tools } : {}),
      }]);
    } catch (e) {
      // Stop, not a failure. streamTurn rejects with an AbortError the moment
      // the reader hits Stop, and the partial answer is theirs to keep: commit
      // whatever text had arrived as a settled turn instead of throwing it away
      // (and instead of dressing a deliberate cancel up as a red error bubble).
      //
      // No `tools` on a stopped turn: streamTurn's accumulator is local to the
      // call that just rejected, and reaching into lib/chat to hand it out
      // early would change a module pinned by the golden tests. No `meta`
      // either — the run never reached `final`, so AssistantMessage renders the
      // StoppedFooter in the footer slot rather than inventing numbers.
      if ((e as { name?: string } | null)?.name === 'AbortError') {
        setMessages((prev) => [...prev, {
          role: 'assistant',
          text: streamTextRef.current,
          ts: Date.now() / 1000,
          stopped: true,
        }]);
        setStreamText('');
        streamTextRef.current = '';
        setToolStatus('');
        setStreaming(false);
        abortRef.current = null;
        clearApiCache();
        void refreshConversations(agentId);
        return;
      }
      // Log the raw cause for debugging, but render only sanitized copy: the
      // transcript must never show raw exception text (backend response bodies,
      // URLs). friendlyStreamError is the same sanitizer the mid-stream SSE
      // error path uses, so both failure paths speak with one voice — short
      // clean causes still surface ("Something went wrong: Upload failed"),
      // anything long or token-like collapses to the generic line.
      console.error('Chat: send failed', e);
      const msg = friendlyStreamError(e instanceof Error && e.message ? e.message : '');
      setMessages((prev) => [...prev, { role: 'assistant', text: msg, ts: Date.now() / 1000, error: true }]);
    }
    setStreamText('');
    streamTextRef.current = '';
    setToolStatus('');
    setStreaming(false);
    abortRef.current = null;
    // Surface the conversation in the sidebar (and refresh its preview/age).
    // send() uses a raw fetch rather than the api wrapper, so nothing has
    // invalidated the 60s GET cache — clear it or /sessions returns a stale
    // list that omits the conversation just created.
    clearApiCache();
    void refreshConversations(agentId);
  }

  // Cancel the turn in flight. The abort travels through streamTurn's optional
  // signal to the underlying fetch, which rejects the read; send()'s catch
  // recognises the AbortError and commits the partial answer instead of
  // discarding it. Idempotent — a second click on an already-aborted controller
  // is a no-op, and `abortRef` is nulled on every exit path.
  function stopStreaming() {
    abortRef.current?.abort();
  }

  // Phase 6 (CHATUI-006) restyles this into the donor's date-grouped sidebar.
  // Phase 2 only re-seats it in the full-bleed canvas: the page padding it used
  // to sit inside is gone, so the panel now carries its own.
  const historyPanel = (
    <aside
      class="hidden lg:flex lg:flex-col w-64 shrink-0 border-r border-border px-3 py-4 overflow-y-auto"
      aria-label="Conversation history"
    >
      <div class="flex items-center justify-between mb-2">
        <h2 class="text-overline uppercase tracking-wider text-muted">Conversations</h2>
        {historyLoading && <span class="text-caption text-muted">…</span>}
      </div>
      {conversations.length === 0 && !historyLoading && (
        <p class="text-caption text-muted py-2">
          No past conversations yet. They appear here once you send a message.
        </p>
      )}
      <ul class="space-y-1">
        {conversations.map((c) => {
          const active = c.chatId === chatId;
          return (
            <li key={c.chatId} class="group relative">
              <button
                type="button"
                disabled={streaming}
                onClick={() => void openConversation(c.chatId)}
                aria-current={active ? 'true' : undefined}
                class={`w-full text-left rounded-lg pl-2 pr-9 py-2 transition-colors duration-fast disabled:opacity-50 ${
                  active ? 'bg-surface-hover border border-border' : 'hover:bg-surface-hover border border-transparent'
                }`}
              >
                <span class="block text-body-sm text-primary truncate">{conversationTitle(c)}</span>
                <span class="block text-caption text-muted">
                  {relativeAge(c.updatedAt)}
                  {c.messageCount ? ` · ${c.messageCount} msg` : ''}
                </span>
              </button>
              {/* A SIBLING of the row button, never nested inside it: a <button>
                  within a <button> is invalid HTML, and nesting would make one
                  click both open and delete the conversation. Hidden until
                  hover/focus so the sidebar stays uncluttered, but always
                  reachable by keyboard. */}
              <button
                type="button"
                disabled={streaming || deleting}
                onClick={(e) => { e.stopPropagation(); setPendingDelete(c); }}
                aria-label={`Delete chat: ${conversationTitle(c)}`}
                title="Delete chat"
                class="absolute right-1 top-2 p-1 rounded text-muted opacity-0
                  group-hover:opacity-100 focus-visible:opacity-100 hover:text-danger
                  focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger
                  disabled:opacity-0 disabled:pointer-events-none transition-colors duration-fast"
              >
                <Trash2 size={14} />
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );

  const agentName = agents.find((a) => a.id === agentId)?.displayName ?? 'agent';
  const activeModel = models.find((m) => m.id === modelId);
  const modelLabel = activeModel
    ? (MODEL_NAMES[activeModel.label] ?? activeModel.label)
    : 'the agent default';

  // Header title: the sidebar's label for this conversation once the server
  // knows it, else the opening line already on screen, else "New chat".
  // conversationTitle() falls back to the raw chatId — fine as a sidebar
  // label, wrong as a heading, so that case falls through too.
  const activeConversation = conversations.find((c) => c.chatId === chatId);
  const sidebarTitle = activeConversation ? conversationTitle(activeConversation) : '';
  const firstUserLine = messages.find((m) => m.role === 'user')?.text.split('\n')[0]?.trim();
  const headerTitle =
    (sidebarTitle && sidebarTitle !== chatId ? sidebarTitle : firstUserLine) || 'New chat';

  // No turns and nothing in flight: the deliberate landing state.
  const isLanding = messages.length === 0 && !streaming;

  // Composer CONTENT only. It declares no width, no centring and no padding of
  // its own: ChatCanvas parents it into the shared content column beside the
  // transcript, which is what makes the two share one left and one right edge
  // at every viewport (see ChatCanvas). Phase 4 (CHATUI-004) restyles the
  // controls themselves into the donor's autosize card.
  const composer = (
    <>
      {files.length > 0 && (
        <div class="mb-2 flex flex-wrap gap-2">
          {files.map((f, i) => (
            <span key={i} class="inline-flex items-center gap-1.5 text-caption bg-surface border border-border rounded-lg px-2 py-1">
              📎 {f.name}
              <button
                type="button"
                class="text-muted hover:text-danger transition-colors"
                aria-label={`Remove ${f.name}`}
                onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <form
        onSubmit={(e) => { e.preventDefault(); send(); }}
        class="flex gap-3"
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept="image/*,video/*,audio/*,.pdf,.docx,.pptx,.txt,.md,.csv"
          class="hidden"
          onChange={(e) => {
            const list = (e.target as HTMLInputElement).files;
            if (list) setFiles((prev) => [...prev, ...Array.from(list)].slice(0, 3));
            (e.target as HTMLInputElement).value = '';
          }}
        />
        {/* Native <button>, not <Button>: the shared component renders only the
            props it declares, so an `aria-label` handed to it is dropped on the
            floor — which is how this control ended up shipping as an unlabelled
            "📎" that a screen reader announces as "paperclip emoji, button". A
            local element keeps the label (and the Stop control's capture hook)
            without changing a component every page depends on. The classes are
            exactly what <Button variant="secondary" size="md"> emits, so the
            pixels are unchanged; Phase 4 (CHATUI-004) replaces both with the
            donor's composer controls. */}
        <button
          type="button"
          disabled={streaming}
          onClick={() => fileInputRef.current?.click()}
          aria-label="Attach files"
          class={COMPOSER_BTN}
        >
          📎
        </button>
        <input
          ref={inputRef}
          data-tour="chat-input"
          value={input}
          onInput={(e) => setInput((e.target as HTMLInputElement).value)}
          placeholder={`Message ${agentName}...`}
          disabled={streaming}
          class="flex-1 min-w-0 bg-surface border border-border rounded-xl px-4 py-3 text-body-sm
            shadow-sm focus:ring-2 focus:ring-primary-a/50 focus:border-primary outline-none
            placeholder:text-muted disabled:opacity-50 transition-colors"
          autoFocus
        />
        {/* Send BECOMES Stop while a turn is in flight — the donor's own
            behaviour, and the difference between a live turn you can end and a
            greyed-out button with a spinner in it that leaves the reader
            waiting on a run they cannot stop paying for. The glyph is a solid
            square (universal stop), not a spinner: a spinner says "wait", and
            this control says "you don't have to". */}
        {streaming ? (
          <button
            type="button"
            onClick={stopStreaming}
            aria-label="Stop generating"
            data-chat-stop
            class={COMPOSER_BTN}
          >
            <span aria-hidden="true" class="size-3 shrink-0 rounded-[2px] bg-current" />
            Stop
          </button>
        ) : (
          <Button type="submit" disabled={!input.trim() && files.length === 0}>
            Send
          </Button>
        )}
      </form>
    </>
  );

  return (
    // Full-bleed canvas: cancel the app shell's page padding (App.tsx
    // `main p-4 sm:p-6 lg:p-8`) so the transcript runs edge to edge under its
    // own overlay header, the way the donor's does, instead of sitting in a
    // boxed panel inside a padded page.
    <div class="-m-4 sm:-m-6 lg:-m-8 flex h-[calc(100vh-var(--header-height))] overflow-hidden bg-bg">
      {historyPanel}
      {/* This page carries NO layout contract of its own — no measured header
          height, no custom property, no reading measure. ChatCanvas declares
          the one content column and parents the header, the transcript and the
          composer into it, so all three share a left and a right edge by
          construction rather than by three components agreeing about a number.
          The `--chat-header-h` property that used to live here (measured by a
          ResizeObserver in ChatHeader, with two breakpointed fallbacks for the
          frames before the first measurement) is gone: a sticky header takes
          its own height in the flow, so there is nothing left to measure. */}
      <div class="relative flex flex-col flex-1 min-w-0">
        <ChatCanvas
          header={
            <ChatHeader
              title={headerTitle}
              agents={agents}
              agentId={agentId}
              onSelectAgent={selectAgent}
              models={models}
              modelId={modelId}
              onSelectModel={setModelId}
              chatId={chatId}
              streaming={streaming}
              onNewChat={() => { if (messages.length > 0) setNewChatOpen(true); else startNewChat(); }}
            />
          }
          composer={composer}
          scrollRef={scrollRef}
          affordance={<ScrollToBottom visible={showJump} onClick={jumpToBottom} />}
        >
          <MessagesView
            messages={messages}
            agentName={agentName}
            landing={isLanding}
            streaming={streaming}
            streamText={streamText}
            toolStatus={toolStatus}
            streamStartedAt={streamStartedAt}
            endRef={endRef}
          >
            {loadError && agents.length === 0 && (
              <div class="text-caption text-danger bg-danger-a/10 border border-danger-a/40 rounded-lg px-3 py-2">
                {loadError}
              </div>
            )}
            {isLanding && (
              <ChatLanding
                agentName={agentName}
                modelLabel={modelLabel}
                onStarter={(text) => { setInput(text); inputRef.current?.focus(); }}
              />
            )}
          </MessagesView>
        </ChatCanvas>

        <ConfirmDialog
          open={newChatOpen}
          title="Start a new chat"
          message="This starts a fresh chat session. The current conversation stays in the sidebar and can be reopened."
          confirmPhrase="NEW CHAT"
          confirmLabel="Start new chat"
          onConfirm={() => { startNewChat(); setNewChatOpen(false); }}
          onCancel={() => setNewChatOpen(false)}
        />

        <ConfirmDialog
          open={pendingDelete !== null}
          title="Delete chat?"
          message="This will permanently delete this chat and its messages. This action cannot be undone."
          confirmPhrase="DELETE"
          confirmLabel={deleting ? 'Deleting…' : 'Delete'}
          danger
          onConfirm={() => { void confirmDelete(); }}
          // Ignore Cancel/Escape/overlay while a delete is in flight, so the
          // dialog cannot be dismissed out from under a request that is still
          // deciding whether to roll back.
          onCancel={() => { if (!deletingRef.current) setPendingDelete(null); }}
        />
      </div>
    </div>
  );
}
