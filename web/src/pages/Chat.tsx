import { useState, useEffect, useRef } from 'preact/hooks';
import { useRoute } from 'wouter-preact';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { Trash2 } from 'lucide-preact';
import { api, getToken, clearApiCache } from '../lib/api';
import { Button } from '../components/Button';
import { Select } from '../components/Select';
import { EmptyState } from '../components/EmptyState';
import { EmptyChat } from '../components/Icons';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { InfoTooltip } from '../components/InfoTooltip';
import { toast } from '../components/Toast';

interface Agent { id: string; displayName: string; status: string }
// `error` marks an assistant turn the stream failed mid-flight. It renders in a
// red bubble (and as a " [error: ...]" suffix when text had already streamed)
// instead of a silent blank reply. `kb` carries knowledge-base confirmations
// ("Indexed report.pdf…") rendered as chips under the assistant bubble. `meta`
// is the run footer (model · latency · cost · tools) — parity with the
// Telegram/Slack footers, which surface the same numbers when enabled.
interface TurnMeta { modelId: string; latencyMs: number; costUsd: number; toolCallCount: number }
interface Message { role: 'user' | 'assistant'; text: string; ts: number; error?: boolean; kb?: string[]; images?: Array<{ url: string; caption: string }>; artifacts?: Array<{ url: string; name: string }>; meta?: TurnMeta }
interface Model { label: string; id: string; contextWindow: number; family: string; isDefault: boolean }

// Friendly names for the env-driven model labels the backend returns.
const MODEL_NAMES: Record<string, string> = {
  opus: 'Opus',
  'opus-1m': 'Opus 1M',
  sonnet: 'Sonnet',
  'sonnet-1m': 'Sonnet 1M',
  haiku: 'Haiku',
  default: 'Default',
};

// "Sonnet 1M · 1M ctx" — name plus a compact context-window hint so the picker
// conveys why you'd reach for one model over another.
function modelOptionLabel(m: Model): string {
  const name = MODEL_NAMES[m.label] ?? m.label;
  const ctx = m.contextWindow >= 1_000_000
    ? '1M ctx'
    : `${Math.round(m.contextWindow / 1000)}K ctx`;
  return `${name} · ${ctx}`;
}

// Each conversation gets its own chatId. Reusing a single id across agent
// switches let one agent's accumulated context leak into the next turn, which
// tripped Bedrock guardrails on later turns (the multi-turn false-positive).
// A fresh id per agent (and per explicit "new chat") keeps server-side history
// scoped to the conversation actually on screen.
function freshChatId(): string {
  return `dashboard:${Date.now()}`;
}

// One row of the conversation sidebar. Mirrors the shape /sessions already
// returns (same as Sessions.tsx) — this feature adds no new endpoint.
interface Conversation {
  agentId: string;
  chatId: string;
  updatedAt: number;
  messageCount: number | null;
  firstMessage: string | null;
}

// The active conversation survives a reload. Without this the Chat tab minted a
// fresh chatId on every mount and silently abandoned the previous conversation
// — which is what made history feel non-existent even though it was stored.
const ACTIVE_CHAT_KEY = 'cce_chat_active';

function storedChatId(agentId: string): string | null {
  try {
    const raw = sessionStorage.getItem(ACTIVE_CHAT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { agentId?: string; chatId?: string };
    return parsed.agentId === agentId && parsed.chatId ? parsed.chatId : null;
  } catch {
    return null;
  }
}

function rememberChatId(agentId: string, chatId: string): void {
  try {
    sessionStorage.setItem(ACTIVE_CHAT_KEY, JSON.stringify({ agentId, chatId }));
  } catch {
    /* private mode or quota — the sidebar still works, only resume-on-reload is lost */
  }
}

/** Sidebar label for a conversation: its opening message, else the raw id. */
function conversationTitle(c: Conversation): string {
  const first = (c.firstMessage ?? '').trim();
  return first.length > 0 ? first : c.chatId;
}

/** Compact relative age for the sidebar ("3m", "5h", "2d"). */
function relativeAge(epochSeconds: number, nowMs = Date.now()): string {
  const secs = Math.max(0, Math.floor(nowMs / 1000) - epochSeconds);
  if (secs < 60) return 'now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

// Render assistant markdown to sanitized HTML. marked emits <strong>, <em>,
// <pre><code> (monospaced via prose styling below); DOMPurify strips anything
// unsafe so dangerouslySetInnerHTML can't inject script. Synchronous parse
// (async:false) keeps the return type a plain string.
function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false, gfm: true, breaks: true });
  return DOMPurify.sanitize(html);
}

// Turn the stream's `event: error` payload into a plain-English sentence. The
// backend emits either a code-prefixed string (e.g. "kill_switch_active: ...")
// or a raw Error message (e.g. "daily cost cap exceeded: $1.50 >= $1.00", "No
// Bedrock model configured"). A CISO should never see the raw token or a dollar
// dump, so match known codes first, then substrings of the raw message.
function friendlyStreamError(raw: string): string {
  const code = raw.trim();
  const n = code.toLowerCase();
  if (/kill.?switch|killed\b/.test(n)) return 'This was blocked by an active kill switch.';
  if (/cost.?cap|daily cost|spend cap|spending limit/.test(n)) return 'The daily spending limit has been reached. Raise it in Cost or try again tomorrow.';
  if (/rate.?limit|too many requests/.test(n)) return 'Too many requests right now. Wait a moment and try again.';
  if (/sessions?.?frozen/.test(n)) return 'New messages are paused by a kill switch (sessions frozen).';
  if (/guardrail|blocked by/.test(n)) return 'The response was blocked by a safety guardrail.';
  if (/no .*model|model .*config|model.?error|no bedrock/.test(n)) return 'No model is configured for this agent, or the model failed. Try a different model.';
  // Unknown: a clean fallback, never a raw token or a long dump.
  return code && code.length < 140 && !/[{}$]/.test(code)
    ? `Something went wrong: ${code}`
    : 'The agent could not finish this response. Please try again.';
}

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
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
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

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamText]);

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
    setToolStatus('');

    try {
      const token = getToken();
      // Stage each file straight to S3 via a presigned PUT (the JSON body to
      // the stream endpoint then carries only small s3Key references, far
      // under the WAF 8KB cap).
      const attachments: Array<{ s3Key: string; fileName: string; mimeType?: string }> = [];
      for (const f of sendFiles) {
        setToolStatus(`Uploading ${f.name}…`);
        const presign = await fetch('/api/vectors/upload-url', {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: f.name }),
        });
        if (!presign.ok) throw new Error('Upload failed');
        const { url, key } = await presign.json();
        const put = await fetch(url, { method: 'PUT', body: f });
        if (!put.ok) throw new Error('Upload failed');
        attachments.push({ s3Key: key, fileName: f.name, ...(f.type ? { mimeType: f.type } : {}) });
      }
      setToolStatus('');
      const res = await fetch('/api/test-turn/stream', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          agentId,
          chatId,
          ...(modelId ? { modelOverride: modelId } : {}),
          ...(attachments.length > 0 ? { attachments } : {}),
        }),
      });
      if (!res.ok || !res.body) throw new Error('Stream failed');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '';
      let isReply = false;
      // The backend emits `event: error` with the message string as `data` when a
      // turn fails mid-stream. We capture it here and surface it as a red bubble
      // after the loop instead of pushing an empty assistant reply.
      let errorText = '';
      const kbChips: string[] = [];
      const images: Array<{ url: string; caption: string }> = [];
      const artifacts: Array<{ url: string; name: string }> = [];
      let curEvent = 'chunk'; // SSE without an event: line defaults to "message"; we treat bare data as a chunk
      let curData = '';
      let buffer = '';

      // Flush one fully-received SSE event (event + its accumulated data lines).
      const flushEvent = () => {
        if (curData === '') return;
        if (curEvent === 'reply') {
          // Slash-command reply: plain text, surfaced directly (not JSON).
          fullText = curData;
          isReply = true;
          setStreamText(curData);
        } else if (curEvent === 'final') {
          fullText = curData; // JSON; parsed after the loop
        } else if (curEvent === 'chunk') {
          fullText = curData; // cumulative plain text for the live preview
          setStreamText(curData);
          setToolStatus(''); // text resumed; drop the tool-status line
        } else if (curEvent === 'tool') {
          // { label, step } — show what the agent is doing during tool dispatch.
          try {
            const t = JSON.parse(curData);
            setToolStatus(t.step > 1 ? `${t.label}… (step ${t.step})` : `${t.label}…`);
          } catch { /* ignore malformed tool event */ }
        } else if (curEvent === 'media') {
          // { fileName, stage, label } — media pipeline progress (transcribe,
          // frames, indexing). Rides the same status row as tool events.
          try {
            const m = JSON.parse(curData);
            setToolStatus(m.label ?? `Processing ${m.fileName}…`);
          } catch { /* ignore malformed media event */ }
        } else if (curEvent === 'kb') {
          // { text } — knowledge-base confirmation chip for the final bubble.
          try {
            const k = JSON.parse(curData);
            if (k.text) kbChips.push(k.text);
          } catch { /* ignore malformed kb event */ }
        } else if (curEvent === 'image') {
          // { url, caption } — generated image, rendered inline under the reply.
          try {
            const im = JSON.parse(curData);
            if (im.url) images.push({ url: im.url, caption: im.caption ?? '' });
          } catch { /* ignore malformed image event */ }
        } else if (curEvent === 'artifact') {
          // { url, name } — generated document, rendered as a download card.
          // This URL comes straight off the tool result, so unlike a link the
          // model retypes into its reply, its signature is intact.
          try {
            const a = JSON.parse(curData);
            if (a.url) artifacts.push({ url: a.url, name: a.name || a.caption || 'document' });
          } catch { /* ignore malformed artifact event */ }
        } else if (curEvent === 'error') {
          // Plain-text error message from the SSE writer; surfaced as an error bubble.
          errorText = curData;
        }
        // done / unknown events carry no assistant text we surface here.
        curData = '';
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line === '') {
            // Blank line terminates an SSE event.
            flushEvent();
            curEvent = 'chunk';
          } else if (line.startsWith('event: ')) {
            curEvent = line.slice(7).trim();
          } else if (line.startsWith('data: ')) {
            // Multiline data arrives as repeated "data: " lines; rejoin them.
            curData = curData === '' ? line.slice(6) : `${curData}\n${line.slice(6)}`;
          }
        }
      }
      flushEvent();

      if (errorText) {
        // Mid-stream failure. If text had already streamed, keep it and append a
        // clear error suffix; otherwise show the error on its own. Either way it
        // renders in a red bubble, never as a silent blank reply.
        const msg = friendlyStreamError(errorText);
        const partial = (!isReply && fullText) ? `${fullText}\n\n${msg}` : msg;
        setMessages((prev) => [...prev, { role: 'assistant', text: partial, ts: Date.now() / 1000, error: true }]);
        setStreamText('');
        setToolStatus('');
        setStreaming(false);
        return;
      }

      let meta: TurnMeta | undefined;
      if (fullText && !isReply) {
        // chunk/final payloads carry the assistant turn as JSON {text,...}. The
        // `final` event also carries the run metadata for the footer.
        try {
          const parsed = JSON.parse(fullText);
          fullText = parsed.text ?? fullText;
          if (typeof parsed.costUsd === 'number') {
            meta = {
              modelId: parsed.modelId ?? '',
              latencyMs: parsed.latencyMs ?? 0,
              costUsd: parsed.costUsd,
              toolCallCount: parsed.toolCallCount ?? 0,
            };
          }
        } catch { /* not JSON (e.g. a raw chunk); use raw text */ }
      }
      setMessages((prev) => [...prev, {
        role: 'assistant',
        text: fullText,
        ts: Date.now() / 1000,
        ...(kbChips.length > 0 ? { kb: kbChips } : {}),
        ...(images.length > 0 ? { images } : {}),
        ...(artifacts.length > 0 ? { artifacts } : {}),
        ...(meta ? { meta } : {}),
      }]);
    } catch (e) {
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
    setToolStatus('');
    setStreaming(false);
    // Surface the conversation in the sidebar (and refresh its preview/age).
    // send() uses a raw fetch rather than the api wrapper, so nothing has
    // invalidated the 60s GET cache — clear it or /sessions returns a stale
    // list that omits the conversation just created.
    clearApiCache();
    void refreshConversations(agentId);
  }

  const historyPanel = (
    <aside
      class="hidden lg:flex lg:flex-col w-64 shrink-0 border-r border-border pr-3 mr-4 overflow-y-auto"
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

  return (
    <div class="flex h-[calc(100vh-var(--header-height)-3rem)]">
      {historyPanel}
      <div class="flex flex-col flex-1 min-w-0">
      <div class="flex items-center gap-3 mb-4 flex-wrap">
        <h1 class="text-display-sm text-primary font-bold" data-tour="chat-title">Chat</h1>
        <span data-tour="chat-agent-picker">
          <Select
            value={agentId}
            onChange={selectAgent}
            options={agents.map((a) => ({ value: a.id, label: a.displayName }))}
          />
        </span>
        {models.length > 0 && (
          <span data-tour="chat-model-picker">
            <Select
              value={modelId}
              onChange={setModelId}
              options={[
                { value: '', label: 'Agent default' },
                ...models.map((m) => ({ value: m.id, label: modelOptionLabel(m) })),
              ]}
            />
          </span>
        )}
        <div class="ml-auto flex items-center gap-2" data-tour="chat-new-chat">
          <span class="hidden sm:inline-flex items-center gap-1 text-caption text-muted font-mono">
            {chatId}
            <InfoTooltip term="dashboard:" />
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={streaming}
            onClick={() => { if (messages.length > 0) setNewChatOpen(true); else startNewChat(); }}
          >
            New chat
          </Button>
        </div>
      </div>

      {loadError && agents.length === 0 && (
        <div class="mb-3 text-caption text-danger bg-danger/10 border border-danger/40 rounded-lg px-3 py-2">
          {loadError}
        </div>
      )}

      <div class="flex-1 overflow-y-auto bg-bg-sunken rounded-xl border border-border p-4 space-y-4" data-tour="chat-messages">
        {messages.length === 0 && !streaming && (
          <EmptyState
            icon={<EmptyChat />}
            title="Start a conversation"
            description="Send a message to test your agent's behavior."
          />
        )}
        {messages.map((m, i) => (
          <div key={i} class={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div class={`max-w-[75%] rounded-xl px-4 py-3 text-body-sm
              ${m.role === 'user'
                ? 'bg-primary text-inverse rounded-br-sm'
                : m.error
                  ? 'bg-danger/10 border border-danger/40 text-danger rounded-bl-sm'
                  : 'bg-surface border border-border text-primary rounded-bl-sm'}`}>
              {m.role === 'assistant'
                ? (m.error
                    ? <pre class="whitespace-pre-wrap font-sans break-words">{m.text}</pre>
                    : <div class="chat-md break-words" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text) }} />)
                : <pre class="whitespace-pre-wrap font-sans break-words">{m.text}</pre>}
              {m.images && m.images.length > 0 && (
                <div class="mt-2 space-y-2">
                  {m.images.map((im, j) => (
                    <a key={j} href={im.url} target="_blank" rel="noopener noreferrer" class="block">
                      <img
                        src={im.url}
                        alt={im.caption || 'generated image'}
                        class="rounded-lg border border-border max-w-full max-h-96"
                        loading="lazy"
                      />
                    </a>
                  ))}
                </div>
              )}
              {m.artifacts && m.artifacts.length > 0 && (
                <div class="mt-2 space-y-2">
                  {m.artifacts.map((a, j) => (
                    <a
                      key={j}
                      href={a.url}
                      download={a.name}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2 hover:bg-surface-hover transition-colors duration-fast"
                    >
                      <span class="text-overline uppercase tracking-wider text-muted shrink-0">
                        {(a.name.split('.').pop() || 'file').slice(0, 4)}
                      </span>
                      <span class="text-body-sm text-primary truncate">{a.name}</span>
                      <span class="text-caption text-secondary ml-auto shrink-0">Download</span>
                    </a>
                  ))}
                </div>
              )}
              {m.kb && m.kb.length > 0 && (
                <div class="mt-2 space-y-1">
                  {m.kb.map((k, j) => (
                    <div key={j} class="text-caption text-secondary bg-bg-sunken border border-border rounded-lg px-2 py-1">
                      {k}
                    </div>
                  ))}
                </div>
              )}
              {m.meta && (
                // Run footer: model · latency · cost · tools. Same metadata the
                // Telegram/Slack footers show (CLAUDE.md "Chat surface parity").
                <div class="mt-2 text-caption text-muted font-mono">
                  {[
                    m.meta.modelId ? m.meta.modelId.split('.').pop() : null,
                    `${Math.round(m.meta.latencyMs)}ms`,
                    `$${m.meta.costUsd.toFixed(4)}`,
                    m.meta.toolCallCount > 0
                      ? `${m.meta.toolCallCount} tool${m.meta.toolCallCount === 1 ? '' : 's'}`
                      : null,
                  ].filter(Boolean).join(' · ')}
                </div>
              )}
            </div>
          </div>
        ))}
        {streaming && streamText && (
          <div class="flex justify-start">
            <div class="max-w-[75%] rounded-xl rounded-bl-sm px-4 py-3 bg-surface border border-border text-body-sm">
              <div class="chat-md break-words text-primary" dangerouslySetInnerHTML={{ __html: renderMarkdown(streamText) }} />
              <span class="inline-block w-2 h-4 bg-primary/50 animate-pulse ml-0.5" />
            </div>
          </div>
        )}
        {streaming && !streamText && toolStatus && (
          <div class="flex justify-start">
            <div class="rounded-xl rounded-bl-sm px-4 py-3 bg-surface border border-border text-body-sm text-secondary flex items-center gap-2">
              <span>⚙️</span>
              <span>{toolStatus}</span>
              <span class="inline-block w-2 h-4 bg-primary/40 animate-pulse" />
            </div>
          </div>
        )}
        {streaming && !streamText && !toolStatus && (
          <div class="flex justify-start">
            <div class="rounded-xl rounded-bl-sm px-4 py-3 bg-surface border border-border">
              <div class="flex gap-1">
                <span class="w-2 h-2 bg-muted rounded-full animate-bounce" style="animation-delay: 0ms" />
                <span class="w-2 h-2 bg-muted rounded-full animate-bounce" style="animation-delay: 150ms" />
                <span class="w-2 h-2 bg-muted rounded-full animate-bounce" style="animation-delay: 300ms" />
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {files.length > 0 && (
        <div class="mt-3 flex flex-wrap gap-2">
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
        class="mt-4 flex gap-3"
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
        <Button
          type="button"
          variant="secondary"
          disabled={streaming}
          onClick={() => fileInputRef.current?.click()}
          aria-label="Attach files"
        >
          📎
        </Button>
        <input
          data-tour="chat-input"
          value={input}
          onInput={(e) => setInput((e.target as HTMLInputElement).value)}
          placeholder={`Message ${agents.find((a) => a.id === agentId)?.displayName ?? 'agent'}...`}
          disabled={streaming}
          class="flex-1 bg-surface border border-border rounded-xl px-4 py-3 text-body-sm
            focus:ring-2 focus:ring-primary/50 focus:border-primary outline-none
            placeholder:text-muted disabled:opacity-50 transition-colors"
          autoFocus
        />
        <Button type="submit" loading={streaming} disabled={!input.trim() && files.length === 0}>
          Send
        </Button>
      </form>

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
