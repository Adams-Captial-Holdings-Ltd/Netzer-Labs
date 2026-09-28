import { useState, useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { useRoute } from 'wouter-preact';
import { api, getToken, getDashboardUser, clearApiCache } from '../lib/api';
import type { Agent, ArtifactRef, Conversation, Message, Model, ToolCall } from '../lib/chat/types';
import {
  MODEL_NAMES,
  freshChatId,
  ACTIVE_CHAT_KEY,
  conversationTitle,
  friendlyTurnError,
  newMessageId,
  transcriptToMessages,
} from '../lib/chat/helpers';
import { installChatCodeCopy } from '../lib/chat/code-block';
import { streamTurn } from '../lib/chat/stream';
import type { TurnOutcome } from '../lib/chat/stream';
import { stageAttachment } from '../lib/chat/uploads';
import type { StagedFile } from '../lib/chat/uploads';
import { admitFiles } from '../lib/chat/attachment-rules';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Button } from '../components/Button';
// The shell's mobile nav toggle. Below `lg` this page's own bar is the app bar
// (Header.tsx stands down there), so the page is what hands the house's nav
// toggle to it — see the ChatHeader call below.
import { toggleMobileMenu, mobileMenuOpen } from '../components/Sidebar';
import { loadDraft, saveDraft, clearDraft } from '../lib/chat/drafts';
import { conversationMarkdown, exportFileName } from '../lib/chat/export';
import { toast } from '../components/Toast';
import { ChatCanvas } from '../components/chat/ChatCanvas';
import { ChatHeader } from '../components/chat/ChatHeader';
import { ChatLanding } from '../components/chat/ChatLanding';
import { ArtifactPanel } from '../components/chat/ArtifactPanel';
import { Composer } from '../components/chat/Composer';
import {
  ConversationSidebar,
  readSidebarCollapsed,
  writeSidebarCollapsed,
} from '../components/chat/ConversationSidebar';
import { MessagesView } from '../components/chat/MessagesView';
import { ScrollToBottom } from '../components/chat/ScrollToBottom';
import { useChatScroll } from '../components/chat/useChatScroll';

// The chat data/transport layer lives in ../lib/chat (types, helpers,
// markdown, stream, uploads) — extracted verbatim from this file in Phase 0 of
// the chat UI port. This page owns state and composition only; the shell it
// composes (overlay header, scrolling column, landing) lives in
// ../components/chat (Phase 2), the transcript itself — turn rendering, the
// live row, the tool timeline, scroll behaviour — lives there as of Phase 3
// (CHATUI-003), and the composer — the autosizing card, its attachment chips
// and the Send/Stop control — as of Phase 4 (CHATUI-004).

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
  const [openArtifact, setOpenArtifact] = useState<{ artifact: ArtifactRef; opener: HTMLButtonElement } | null>(null);
  const [input, setInput] = useState('');
  const draftsRef = useRef(new Map<string, string>());
  // True while the chat on screen is a fresh one with nothing sent yet — an id
  // nothing can reopen. Set when one is minted (`startNewChat`, the first
  // mount), cleared by the first send in it or by opening a stored
  // conversation. A ref, like `deletingRef`: handlers read it, nothing renders
  // it. It is NOT `messages.length === 0` — a reopened conversation has no
  // messages on screen until its transcript arrives, and none at all where the
  // transcript is empty, yet its id is one the sidebar can reopen.
  const unsentChatRef = useRef(true);
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
  const streamToolsRef = useRef<ToolCall[]>([]);
  // Aborts the in-flight turn (the composer's Stop control). Null when idle.
  const abortRef = useRef<AbortController | null>(null);
  // Live tool-call status, mirroring Telegram/Slack (CLAUDE.md "Chat surface
  // parity"). Shown while the agent works a tool; cleared when text resumes.
  const [toolStatus, setToolStatus] = useState('');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [historyError, setHistoryError] = useState(false);
  const [search, setSearch] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [transcriptError, setTranscriptError] = useState(false);
  // Desktop conversation rail: collapsed or expanded, remembered across
  // reloads (localStorage, not sessionStorage — a layout preference outlives
  // the tab, unlike `cce_chat_active`, which is deliberately per-tab).
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);
  // Below `lg` the same rail is an off-canvas drawer. Never open on first
  // paint: the reader asked for a conversation, not for a file list.
  const [sidebarOpen, setSidebarOpen] = useState(false);
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
  // Keep a synchronous snapshot so two picks in the same frame still obey the
  // three-file cap. Uploads begin when files arrive, independent of Send.
  const [files, setFiles] = useState<StagedFile[]>([]);
  const filesRef = useRef<StagedFile[]>([]);
  const nextFileId = useRef(0);
  const [attachmentAlert, setAttachmentAlert] = useState('');
  // Set when the initial /agents load fails, so the tab shows WHY it's empty
  // instead of a silently dead chat (send() early-returns without an agent).
  const [loadError, setLoadError] = useState('');
  // Focused after a landing starter chip drops its text into the composer, so
  // the caret is already where the user will keep typing.
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const pageContentRef = useRef<HTMLDivElement>(null);
  const [announcement, setAnnouncement] = useState('');
  const [regenerateError, setRegenerateError] = useState('');
  const shortcutActions = useRef({ newChat: () => {}, focusSearch: () => {}, focusComposer: () => {} });
  const transcriptRequest = useRef(0);
  const historyRequest = useRef(0);
  const scopedAgent = (id: string) => `${encodeURIComponent(getDashboardUser() || 'unknown')}/${id}`;
  const activeKey = () => `${ACTIVE_CHAT_KEY}:${encodeURIComponent(getDashboardUser() || 'unknown')}`;

  function storedScopedChatId(id: string): string | null {
    try {
      const saved = JSON.parse(sessionStorage.getItem(activeKey()) ?? 'null') as
        { owner?: string; agentId?: string; chatId?: string } | null;
      return saved?.owner === (getDashboardUser() || 'unknown') && saved.agentId === id ? saved.chatId ?? null : null;
    } catch { return null; }
  }

  function rememberScopedChatId(id: string, conversationId: string) {
    try {
      const value = JSON.stringify({ owner: getDashboardUser() || 'unknown', agentId: id, chatId: conversationId });
      sessionStorage.setItem(activeKey(), value);
    } catch { /* Resume is best-effort in private storage modes. */ }
  }

  function announce(message: string) {
    setAnnouncement('');
    window.setTimeout(() => setAnnouncement(message), 0);
  }

  useLayoutEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229) return;
      const isShortcut = ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'o') ||
        ((e.ctrlKey || e.metaKey) && e.key === '/') ||
        (e.shiftKey && e.key === 'Escape');
      if (!isShortcut) return;
      if (document.querySelector('[data-artifact-panel][role="dialog"][aria-modal="true"]')) return;
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        shortcutActions.current.newChat();
      } else if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault();
        shortcutActions.current.focusSearch();
      } else if (e.shiftKey && e.key === 'Escape') {
        e.preventDefault();
        shortcutActions.current.focusComposer();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useLayoutEffect(() => {
    const desktop = window.matchMedia('(min-width: 1024px)');
    const onBreakpoint = () => { if (desktop.matches) setSidebarOpen(false); };
    desktop.addEventListener('change', onBreakpoint);
    onBreakpoint();
    return () => desktop.removeEventListener('change', onBreakpoint);
  }, []);

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
  async function refreshConversations(forAgent: string, query = searchQuery) {
    if (!forAgent) return;
    const request = ++historyRequest.current;
    setHistoryLoading(true);
    setHistoryError(false);
    try {
      clearApiCache();
      const d = await api.get<{ sessions: Conversation[] }>(
        `/sessions?agentId=${encodeURIComponent(forAgent)}${query ? `&q=${encodeURIComponent(query)}` : ''}`,
      );
      const rows = (d.sessions ?? [])
        // Only dashboard chats are browsable here; Telegram/Slack rows share
        // the table but have no UI to reopen them, and still expire.
        .filter((s) => s.chatId.startsWith('dashboard:'))
        .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      if (request !== historyRequest.current) return;
      setConversations(rows);
    } catch (e) {
      if (request !== historyRequest.current) return;
      // Non-fatal: the sidebar is an aid, not a prerequisite for chatting.
      console.error('Chat: failed to load conversations', e);
      setHistoryError(true);
      setConversations([]);
    }
    if (request === historyRequest.current) setHistoryLoading(false);
  }

  // Load the sidebar whenever the agent changes, and restore the conversation
  // that was open before a reload.
  useEffect(() => {
    if (!agentId) return;
    void refreshConversations(agentId);
    const remembered = storedScopedChatId(agentId);
    if (remembered && remembered !== chatId) void openConversation(remembered);
    else rememberScopedChatId(agentId, chatId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearchQuery(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    if (agentId) void refreshConversations(agentId, searchQuery);
  }, [searchQuery]);

  // Where the chat on screen files its draft on the way out. A chat with nothing
  // sent yet shares ONE slot: its fresh id is never reopened, so a draft filed
  // under it was lost on New chat or on a look at another conversation. A
  // stored conversation keeps its own.
  const NEW_DRAFT = 'new';
  const currentDraftKey = () => (unsentChatRef.current ? NEW_DRAFT : `${agentId}/${chatId}`);

  function closeArtifact(restoreFocus = true) {
    setOpenArtifact(null);
    if (restoreFocus && openArtifact?.opener.isConnected) openArtifact.opener.focus({ preventScroll: true });
  }

  // `fresh`: a new chat restores the `new` slot and clears it; a stored
  // conversation restores its own draft, or nothing.
  function activateConversation(id: string, forAgent = agentId, fresh = false) {
    closeArtifact(false);
    setRegenerateError('');
    draftsRef.current.set(currentDraftKey(), input);
    const restored = fresh ? draftsRef.current.get(NEW_DRAFT) : draftsRef.current.get(`${forAgent}/${id}`) ?? loadDraft(scopedAgent(forAgent), id);
    if (fresh) draftsRef.current.delete(NEW_DRAFT);
    unsentChatRef.current = fresh;
    setInput(restored ?? '');
    setChatId(id);
    rememberScopedChatId(forAgent, id);
  }

  // Reopen a stored conversation, including tool results and stopped turns.
  async function openConversation(id: string, force = false) {
    if (streaming && !force) return;
    const request = ++transcriptRequest.current;
    activateConversation(id);
    setStreamText('');
    setMessages([]);
    setTranscriptError(false);
    setTranscriptLoading(true);
    try {
      clearApiCache();
      const d = await api.get<{ turns?: Parameters<typeof transcriptToMessages>[0] }>(
        `/sessions/transcript?agentId=${encodeURIComponent(agentId)}&chatId=${encodeURIComponent(id)}`,
      );
      if (request !== transcriptRequest.current) return;
      setMessages(transcriptToMessages(d.turns ?? []));
    } catch (e) {
      if (request !== transcriptRequest.current) return;
      console.error('Chat: failed to load transcript', e);
      setTranscriptError(true);
    } finally {
      if (request === transcriptRequest.current) setTranscriptLoading(false);
    }
  }

  async function reloadIfSaved(requestId: string): Promise<boolean> {
    try {
      clearApiCache();
      const d = await api.get<{ turns?: Parameters<typeof transcriptToMessages>[0] }>(
        `/sessions/transcript?agentId=${encodeURIComponent(agentId)}&chatId=${encodeURIComponent(chatId)}`,
      );
      const turns = d.turns ?? [];
      const last = turns.at(-1);
      if (last?.role !== 'assistant' || last.requestId !== requestId) return false;
      setMessages(transcriptToMessages(turns));
      return true;
    } catch {
      return false;
    }
  }

  // Start a brand-new conversation: fresh server-side chatId + cleared UI.
  function startNewChat(forAgent = agentId) {
    ++transcriptRequest.current;
    const id = freshChatId();
    activateConversation(id, forAgent, true);
    setMessages([]);
    setStreamText('');
    setTranscriptLoading(false);
    setTranscriptError(false);
  }

  async function updateConversation(c: Conversation, patch: { title?: string | null; pinned?: boolean }) {
    try {
      await api.patch('/sessions', { agentId: c.agentId, chatId: c.chatId, ...patch });
      clearApiCache();
      await refreshConversations(c.agentId);
    } catch (e) {
      console.error('Chat: could not update conversation', e);
      toast(e instanceof Error && e.message.startsWith('invalid_title')
        ? 'A title can be up to 120 characters, with no tabs or line breaks.'
        : 'Could not update that chat. Please try again.', 'error');
    }
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
    ++historyRequest.current;
    startNewChat(id);
  }

  function updateFiles(change: (current: StagedFile[]) => StagedFile[]) {
    const next = change(filesRef.current);
    filesRef.current = next;
    setFiles(next);
  }

  function attachFiles(picked: File[]) {
    const { accepted, refused } = admitFiles(filesRef.current.map((f) => f.file), picked);
    setAttachmentAlert(refused.map(({ name, reason }) =>
      reason === 'too_large' ? `${name} exceeds the 30 MB limit.` :
      reason === 'too_many' ? `${name} was left out: attach at most 3 files.` :
      `${name} cannot be attached.`
    ).join(' '));
    const added = (accepted as File[]).map((file): StagedFile => ({
      localId: ++nextFileId.current, file, status: 'uploading', progress: 0, addToKnowledge: false,
    }));
    updateFiles((current) => [...current, ...added]);
    for (const staged of added) {
      void stageAttachment(staged.file, getToken(), (progress) => {
        updateFiles((current) => current.map((f) => f.localId === staged.localId ? { ...f, progress } : f));
      }).then((signed) => {
        updateFiles((current) => current.map((f) => f.localId === staged.localId
          ? { ...f, signed, status: 'ready', progress: 100 } : f));
      }).catch((error: unknown) => {
        updateFiles((current) => current.map((f) => f.localId === staged.localId
          ? { ...f, status: 'failed', error: error instanceof Error ? error.message : 'Upload failed. Please try again.' } : f));
      });
    }
  }

  const replyMessage = (outcome: TurnOutcome, requestId: string): Message => ({
    role: 'assistant',
    text: outcome.text,
    ts: Date.now() / 1000,
    requestId,
    ...(outcome.kb.length > 0 ? { kb: outcome.kb } : {}),
    ...(outcome.images.length > 0 ? { images: outcome.images } : {}),
    ...(outcome.artifacts.length > 0 ? { artifacts: outcome.artifacts } : {}),
    ...(outcome.artifactRefs.length > 0 ? { artifactRefs: outcome.artifactRefs } : {}),
    ...(outcome.meta ? { meta: outcome.meta } : {}),
    ...(outcome.tools.length > 0 ? { tools: outcome.tools } : {}),
    // `done: not_saved`: the answer arrived, the server could not store it.
    ...(outcome.saved === false ? { notSaved: true as const } : {}),
  });

  async function send(retryIndex?: number) {
    const retry = retryIndex !== undefined;
    const text = retry ? messages[retryIndex - 1]?.text ?? '' : input.trim();
    const sendFiles = retry ? [] : filesRef.current;
    if ((!text && sendFiles.length === 0) || streaming || !agentId ||
      sendFiles.some((f) => f.status !== 'ready' || !f.signed)) return;
    const clientMessageId = newMessageId();
    setRegenerateError('');
    if (!retry) clearDraft(scopedAgent(agentId), chatId);
    if (!retry) draftsRef.current.delete(`${agentId}/${chatId}`);
    // The first send in a fresh chat: its draft slot is spent, and from here on
    // the chat has messages and an id the sidebar can reopen.
    if (!retry && unsentChatRef.current) draftsRef.current.delete(NEW_DRAFT);
    unsentChatRef.current = false;
    if (!retry) {
      setInput('');
      updateFiles(() => []);
      setAttachmentAlert('');
    }
    const userMsg: Message = {
      role: 'user',
      text,
      ts: Date.now() / 1000,
      ...(sendFiles.length ? { attachments: sendFiles.map((f) => ({
        id: f.signed!.id, name: f.file.name, type: f.signed!.headers['Content-Type'], size: f.file.size,
      })) } : {}),
    };
    setMessages((prev) => retry ? prev.filter((_, i) => i !== retryIndex) : [...prev, userMsg]);
    setStreaming(true);
    setStreamText('');
    streamTextRef.current = '';
    streamToolsRef.current = [];
    setToolStatus('');
    setStreamStartedAt(Date.now());
    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const token = getToken();
      const attachments = sendFiles.map((f) => ({
        s3Key: f.signed!.key,
        fileName: f.file.name,
        mimeType: f.signed!.headers['Content-Type'],
        ...(f.addToKnowledge ? { addToKnowledge: true as const } : {}),
      }));
      // The SSE parser lives in streamTurn (../lib/chat/stream.ts). Its chunk
      // callback both updates the live preview and clears the tool status —
      // exactly the pre-extraction behavior.
      const outcome = await streamTurn(
        {
          text,
          agentId,
          chatId,
          clientMessageId,
          protocol: 2,
          ...(modelId ? { modelOverride: modelId } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        },
        token,
        {
          onChunk: (t) => { streamTextRef.current = t; setStreamText(t); },
          onToolStatus: setToolStatus,
          onTools: (tools) => { streamToolsRef.current = tools; },
        },
        // Stop travels through the request signal.
        { signal: abort.signal },
      );

      if (outcome.errorText) {
        // Keep any streamed reply separate from the failure notice.
        const msg = friendlyTurnError(outcome.errorText, outcome.errorCode);
        setMessages((prev) => [...prev, { role: 'assistant', text: outcome.text, failure: msg, ts: Date.now() / 1000, error: true }]);
        setStreamText('');
        streamTextRef.current = '';
        setToolStatus('');
        setStreaming(false);
        abortRef.current = null;
        return;
      }

      setMessages((prev) => [...prev, {
        ...replyMessage(outcome, clientMessageId),
        ...(outcome.isReply ? { isReply: true } : {}),
      }]);
      announce('Reply finished.');
    } catch (e) {
      // Stop, not a failure. streamTurn rejects with an AbortError the moment
      // the reader hits Stop, and the partial answer is theirs to keep: commit
      // whatever text had arrived as a settled turn instead of throwing it away
      // (and instead of dressing a deliberate cancel up as a red error bubble).
      //
      // Keep the latest tool snapshot too. No `meta` — the run never reached
      // `final`, so AssistantMessage renders StoppedFooter rather than
      // inventing numbers.
      if ((e as { name?: string } | null)?.name === 'AbortError') {
        setMessages((prev) => [...prev, {
          role: 'assistant',
          text: streamTextRef.current || '(Stopped before a reply.)',
          ts: Date.now() / 1000,
          stopped: true,
          requestId: clientMessageId,
          ...(streamToolsRef.current.length > 0 ? { tools: streamToolsRef.current } : {}),
        }]);
        setStreamText('');
        streamTextRef.current = '';
        setToolStatus('');
        setStreaming(false);
        abortRef.current = null;
        clearApiCache();
        void refreshConversations(agentId);
        announce('Reply stopped.');
        return;
      }
      // Log the raw cause for debugging, but render only sanitized copy: the
      // transcript must never show raw exception text (backend response bodies,
      // URLs). friendlyTurnError is the same sanitizer the mid-stream SSE error
      // path uses, so both failure paths speak with one voice — a refusal
      // before the stream (its `code`) says what to do about it, short clean
      // causes still surface ("Something went wrong: Upload failed"), anything
      // long or token-like collapses to the generic line.
      const code = (e as { code?: string } | null)?.code;
      if (code === 'connection_lost' && await reloadIfSaved(clientMessageId)) {
        // The reply committed before the connection dropped; the transcript is authoritative.
      } else {
        console.error('Chat: send failed', e);
        const msg = friendlyTurnError(e instanceof Error && e.message ? e.message : '', code);
        setMessages((prev) => [...prev, { role: 'assistant', text: streamTextRef.current, failure: msg, ts: Date.now() / 1000, error: true }]);
      }
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

  async function regenerate() {
    if (streaming || messages.at(-1)?.role !== 'assistant') return;
    const old = messages.at(-1)!;
    if (old.error || old.notSaved || old.isReply) return;
    const clientMessageId = newMessageId();
    setRegenerateError('');
    setMessages((prev) => prev.slice(0, -1));
    setStreaming(true);
    setStreamText('');
    streamTextRef.current = '';
    streamToolsRef.current = [];
    setToolStatus('');
    setStreamStartedAt(Date.now());
    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const outcome = await streamTurn({ regenerate: true, agentId, chatId, clientMessageId, replyTo: old.requestId ?? null, protocol: 2,
        ...(modelId ? { modelOverride: modelId } : {}) }, getToken(), {
        onChunk: (t) => { streamTextRef.current = t; setStreamText(t); },
        onToolStatus: setToolStatus,
        onTools: (tools) => { streamToolsRef.current = tools; },
      }, { signal: abort.signal });
      if (outcome.errorText || outcome.saved === false) {
        setMessages((prev) => [...prev, old]);
        setRegenerateError(outcome.errorText
          ? friendlyTurnError(outcome.errorText, outcome.errorCode)
          : `The new reply wasn't saved, so the previous one is kept.${outcome.text ? `\n${outcome.text}` : ''}`);
      } else {
        setMessages((prev) => [...prev, replyMessage(outcome, clientMessageId)]);
        announce('Reply finished.');
      }
    } catch (e) {
      if ((e as { name?: string })?.name === 'AbortError') {
        setMessages((prev) => [...prev, { role: 'assistant', text: streamTextRef.current || '(Stopped before a reply.)', ts: Date.now() / 1000,
          stopped: true, requestId: clientMessageId, ...(streamToolsRef.current.length ? { tools: streamToolsRef.current } : {}) }]);
        announce('Reply stopped.');
      } else if ((e as { code?: string } | null)?.code === 'reply_changed') {
        await openConversation(chatId, true);
        setRegenerateError('This chat changed in another tab, so it was reloaded.');
      } else if ((e as { code?: string } | null)?.code === 'connection_lost' && await reloadIfSaved(clientMessageId)) {
        // The regenerated reply committed before the connection dropped; the transcript is authoritative.
      } else {
        setMessages((prev) => [...prev, old]);
        setRegenerateError(friendlyTurnError(e instanceof Error ? e.message : ''));
      }
    } finally {
      setStreamText('');
      setToolStatus('');
      setStreaming(false);
      abortRef.current = null;
      clearApiCache();
      void refreshConversations(agentId);
    }
  }

  // Cancel the turn in flight. The abort travels through streamTurn's optional
  // signal to the underlying fetch, which rejects the read; send()'s catch
  // recognises the AbortError and commits the partial answer instead of
  // discarding it. Idempotent — a second click on an already-aborted controller
  // is a no-op, and `abortRef` is nulled on every exit path.
  function stopStreaming() {
    abortRef.current?.abort();
  }

  // The conversation rail (Phase 6, CHATUI-006). It is one component across
  // both shells: a collapsible column at `lg` and up, an off-canvas drawer
  // below it. Every row, every group heading and the delete control live in
  // ../components/chat/ConversationSidebar.
  //
  // The delete flow stays here: the sidebar reports the row, and this page
  // owns the confirmation and rollback.
  const sidebar = (
    <ConversationSidebar
      conversations={conversations}
      activeChatId={chatId}
      loading={historyLoading}
      loadError={historyError}
      onRetryLoad={() => void refreshConversations(agentId)}
      search={search}
      onSearch={(value) => {
        setHistoryError(false);
        setHistoryLoading(value.trim() !== searchQuery);
        setSearch(value);
      }}
      onRename={(c, title) => void updateConversation(c, { title })}
      onTogglePin={(c) => void updateConversation(c, { pinned: !c.pinned })}
      streaming={streaming}
      deleting={deleting}
      // Picking a conversation in the drawer closes it — the donor's
      // `toggleNav`, which every row selection funnels through. On desktop
      // there is no drawer and this is a no-op.
      onOpen={(id) => { void openConversation(id); setSidebarOpen(false); }}
      onRequestDelete={(c) => setPendingDelete(c)}
      // The same one-click action the header uses.
      onNewChat={() => startNewChat()}
      collapsed={sidebarCollapsed}
      onToggleCollapse={() => {
        const next = !sidebarCollapsed;
        setSidebarCollapsed(next);
        writeSidebarCollapsed(next);
      }}
      mobileOpen={sidebarOpen}
      pageContentRef={pageContentRef}
      onCloseMobile={() => setSidebarOpen(false)}
    />
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

  shortcutActions.current = {
    newChat: () => { if (!streaming) startNewChat(); },
    focusSearch: () => {
      if (window.innerWidth < 1024) setSidebarOpen(true);
      else if (sidebarCollapsed) { setSidebarCollapsed(false); writeSidebarCollapsed(false); }
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        const fields = [...document.querySelectorAll<HTMLInputElement>('input[aria-label="Search chats"]')];
        fields.find((field) => field.getClientRects().length > 0 && !field.closest('[inert]'))?.focus();
      }));
    },
    focusComposer: () => {
      if (sidebarOpen) setSidebarOpen(false);
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => inputRef.current?.focus()));
    },
  };

  function exportChat() {
    const content = conversationMarkdown({ title: headerTitle, agentName, messages });
    const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = exportFileName(headerTitle);
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  // Composer CONTENT only. It declares no width, no centring and no padding of
  // its own: ChatCanvas parents it into the shared content column beside the
  // transcript, which is what makes the two share one left and one right edge
  // at every viewport (see ChatCanvas). The card, the autosize, Enter/
  // Shift+Enter and the Send/Stop slot live in ../components/chat/Composer.
  //
  // The staging list stays here because send() reads it; the composer renders
  // its progress, refusal and knowledge choice.
  const composer = (
    <Composer
      value={input}
      onInput={(value) => { setInput(value); saveDraft(scopedAgent(agentId), chatId, value); }}
      onSend={() => { void send(); }}
      onStop={stopStreaming}
      streaming={streaming}
      agentReady={agentId !== ''}
      agentName={agentName}
      files={files}
      attachmentAlert={attachmentAlert}
      onAttach={attachFiles}
      onRemoveFile={(id) => updateFiles((current) => current.filter((f) => f.localId !== id))}
      onToggleKnowledge={(id, checked) => updateFiles((current) => current.map((f) =>
        f.localId === id ? { ...f, addToKnowledge: checked } : f))}
      textareaRef={inputRef}
    />
  );

  return (
    // Full-bleed canvas: cancel the app shell's page padding (App.tsx
    // `main p-4 sm:p-6 lg:p-8`) so the transcript runs edge to edge under its
    // own overlay header, the way the donor's does, instead of sitting in a
    // boxed panel inside a padded page.
    // The house header stands down on this route (Header.tsx /
    // `pageOwnsTopBar`) and this page owns the top of the viewport, so the
    // canvas is the WHOLE viewport rather than the viewport minus a header that
    // is not there. Round 5 made that true below `lg` and kept the `lg:`
    // subtraction for a header that was still drawn above it; round 6 stood the
    // header down at every width (a second bar costs a 1280px reader the same
    // 56px it costs a phone — measured, first content y=131.5 against the
    // donor's 57.0), so the subtraction has nothing left to subtract.
    <div class="-m-4 sm:-m-6 lg:-m-8 flex h-screen overflow-hidden bg-bg">
      <div data-chat-announcer role="status" aria-live="polite" class="sr-only">{announcement}</div>
      {sidebar}
      {/* This page carries NO layout contract of its own — no measured header
          height, no custom property, no reading measure. ChatCanvas declares
          the one content column and parents the header, the transcript and the
          composer into it, so all three share a left and a right edge by
          construction rather than by three components agreeing about a number.
          The `--chat-header-h` property that used to live here (measured by a
          ResizeObserver in ChatHeader, with two breakpointed fallbacks for the
          frames before the first measurement) is gone: a sticky header takes
          its own height in the flow, so there is nothing left to measure. */}
      <div ref={pageContentRef} class="relative flex flex-col flex-1 min-w-0">
        <ChatCanvas
          header={
            <ChatHeader
              title={headerTitle}
              // Below `lg` the rail is a drawer, so its open control has to
              // live outside it. Above `lg` the button is hidden and the rail's
              // own collapse toggle governs.
              onOpenSidebar={() => setSidebarOpen(true)}
              sidebarOpen={sidebarOpen}
              // Below `lg` this bar IS the app bar (the house header stands
              // down — Header.tsx), so it carries the house's nav toggle too.
              // The page hands it down rather than the header reaching for the
              // shell itself: ChatHeader stays a component of this surface, not
              // a component that knows about the product's navigation.
              onOpenAppNav={toggleMobileMenu}
              appNavOpen={mobileMenuOpen.value}
              agents={agents}
              agentId={agentId}
              onSelectAgent={selectAgent}
              models={models}
              modelId={modelId}
              onSelectModel={setModelId}
              chatId={chatId}
              streaming={streaming}
              onNewChat={() => startNewChat()}
              onExport={exportChat}
            />
          }
          composer={composer}
          scrollRef={scrollRef}
          affordance={<ScrollToBottom visible={showJump} onClick={jumpToBottom} />}
        >
          <MessagesView
            messages={messages}
            agentName={agentName}
            agentId={agentId}
            chatId={chatId}
            onOpenArtifact={(artifact, opener) => setOpenArtifact({ artifact, opener })}
            onRetry={(i) => void send(i)}
            onRegenerate={() => void regenerate()}
            landing={isLanding && !transcriptLoading && !transcriptError}
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
            {transcriptLoading && <div role="status" class="flex min-h-48 items-center justify-center gap-2 text-secondary"><span class="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary" aria-hidden="true" />Loading conversation…</div>}
            {transcriptError && <div role="alert" class="chat-error-panel flex items-center gap-3 rounded-xl border border-danger-a/40 bg-danger-a/10 px-4 py-3">Could not load this conversation. <Button variant="secondary" size="sm" onClick={() => void openConversation(chatId)}>Try again</Button></div>}
            {regenerateError && <div role="alert" class="chat-error-panel whitespace-pre-line rounded-xl border border-danger-a/40 bg-danger-a/10 px-4 py-3">{regenerateError}</div>}
            {isLanding && !transcriptLoading && !transcriptError && (
              <ChatLanding
                agentName={agentName}
                modelLabel={modelLabel}
                onStarter={(text) => { setInput(text); saveDraft(scopedAgent(agentId), chatId, text); inputRef.current?.focus(); }}
              />
            )}
          </MessagesView>
        </ChatCanvas>

        <ConfirmDialog
          open={pendingDelete !== null}
          title="Delete chat?"
          message={`This will permanently delete "${pendingDelete ? conversationTitle(pendingDelete) : ''}" and its messages. This action cannot be undone.`}
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
      {openArtifact && (
        <ArtifactPanel key={`${openArtifact.artifact.artifactId}:${openArtifact.artifact.version}`}
          agentId={agentId} chatId={chatId} artifact={openArtifact.artifact} onClose={() => closeArtifact()} />
      )}
    </div>
  );
}
