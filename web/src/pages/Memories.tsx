import { useState, useEffect } from 'preact/hooks';
import { api } from '../lib/api';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { EmptyBrain } from '../components/Icons';
import { Select } from '../components/Select';
import { Skeleton } from '../components/Skeleton';
import { Badge } from '../components/Badge';
import { DataMeta } from '../components/DataMeta';
import { formatSessionId, formatRelativeTime } from '../lib/format';
import { useAgentNames } from '../lib/useAgentNames';

// GET /memories caps a conversation's memories at this many rows and returns NO
// true total, so the page can only honestly say "first N". Keep in sync with
// handler.ts listMemoriesForChat(agentId, chatId, 50).
const MEMORIES_CAP = 50;

interface Memory {
  agentId: string;
  chatId: string;
  content: string;
  importance?: number;
  createdAt?: string;
}

interface SessionSummary {
  agentId: string;
  chatId: string;
  updatedAt: number;
  surface: string | null;
  firstMessage: string | null;
}

interface AgentSummary { id: string; displayName: string }

export function Memories() {
  const [memories, setMemories] = useState<Memory[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [agentId, setAgentId] = useState('main');
  const [chatId, setChatId] = useState('');
  const [loading, setLoading] = useState(false);
  // Distinct error state for the per-session memories fetch so a 403/500/network
  // failure shows ErrorState instead of collapsing into "No memories found".
  const [loadError, setLoadError] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const { nameFor } = useAgentNames();

  useEffect(() => {
    Promise.all([
      api.get<{ agents: AgentSummary[] }>('/agents'),
      api.get<{ sessions: SessionSummary[] }>('/sessions'),
    ]).then(([a, s]) => {
      setAgents(a.agents);
      setSessions(s.sessions);
    }).catch(() => {});
  }, []);

  function load(cid?: string) {
    const target = cid ?? chatId;
    if (!target) return;
    setChatId(target);
    setLoading(true);
    setLoadError(false);
    api.get<{ memories: Memory[] }>(`/memories?agentId=${agentId}&chatId=${encodeURIComponent(target)}`)
      .then((d) => { setMemories(d.memories); setUpdatedAt(Date.now()); })
      .catch(() => {
        setMemories([]);
        setLoadError(true);
      })
      .finally(() => setLoading(false));
  }

  const recentSessions = sessions
    .filter((s) => !agentId || s.agentId === agentId)
    .slice(0, 12);

  return (
    <div>
      <div class="mb-6">
        <h1 data-tour="memories-title" class="text-display-sm text-primary font-bold">Memory Browser (Admin)</h1>
        <p class="text-body-sm text-secondary mt-1">Browse agent memory entries across all conversations. All dashboard operators have admin read access.</p>
      </div>

      <div data-tour="memories-agent-select" class="flex gap-3 mb-6">
        <Select
          value={agentId}
          onChange={setAgentId}
          options={agents.map((a) => ({ value: a.id, label: a.displayName }))}
        />
      </div>

      {!chatId && !loading && (
        <div data-tour="memories-sessions" class="mb-6">
          <div class="flex items-center justify-between mb-3">
            <h2 class="text-heading-sm font-semibold text-primary">Select a session</h2>
            <button
              onClick={() => setShowManual(!showManual)}
              class="text-caption text-accent hover:underline"
            >
              {showManual ? 'Hide' : 'Search by ID'}
            </button>
          </div>
          {showManual && (
            <div class="flex gap-3 mb-4">
              <input
                value={chatId}
                onInput={(e) => setChatId((e.target as HTMLInputElement).value)}
                placeholder="Enter chat ID..."
                class="flex-1 bg-surface border border-border rounded-lg px-3 py-1.5 text-body-sm focus:ring-2 focus:ring-primary/50 outline-none placeholder:text-muted"
              />
              <button
                onClick={() => load()}
                disabled={!chatId || loading}
                class="px-4 py-1.5 bg-primary text-inverse rounded-lg text-body-sm font-medium hover:bg-primary-hover disabled:opacity-50 transition-colors"
              >
                Search
              </button>
            </div>
          )}
          <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {recentSessions.map((s) => (
              <button
                key={`${s.agentId}:${s.chatId}`}
                onClick={() => load(s.chatId)}
                class="text-left bg-surface border border-border rounded-xl p-4 hover:border-accent transition-colors"
              >
                <div class="flex items-center gap-2 mb-1">
                  <Badge variant={s.surface === 'telegram' ? 'info' : s.surface === 'slack' ? 'warning' : 'default'}>
                    {s.surface ?? 'unknown'}
                  </Badge>
                  <span class="text-caption text-muted">{formatRelativeTime(s.updatedAt)}</span>
                </div>
                <p class="text-body-sm font-medium text-primary truncate">
                  {s.firstMessage ? s.firstMessage.slice(0, 60) : formatSessionId(s.chatId, s.surface)}
                </p>
                <p class="text-overline text-muted mt-0.5" title={s.agentId}>{nameFor(s.agentId)}</p>
              </button>
            ))}
          </div>
          {recentSessions.length === 0 && (
            <EmptyState icon={<EmptyBrain />} title="No sessions" description="Sessions will appear here when agents are used." />
          )}
        </div>
      )}

      {chatId && (
        <div class="mb-4 flex items-center gap-3">
          <button onClick={() => { setChatId(''); setMemories([]); setLoadError(false); }} class="text-caption text-accent hover:underline">
            Back to sessions
          </button>
          <span class="text-caption text-muted font-mono">{chatId}</span>
          {!loading && !loadError && memories.length > 0 && (
            <div class="ml-auto">
              <DataMeta
                updatedAt={updatedAt ?? undefined}
                // No true total from the backend; capped at 50, so "first 50"
                // only once the cap is hit.
                note={memories.length >= MEMORIES_CAP ? `Showing first ${MEMORIES_CAP}` : undefined}
                onRefresh={() => load(chatId)}
              />
            </div>
          )}
        </div>
      )}

      {loading ? (
        <div class="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} class="bg-surface border border-border rounded-xl p-5">
              <Skeleton height="14px" width="60%" class="mb-2" />
              <Skeleton height="40px" />
            </div>
          ))}
        </div>
      ) : chatId && loadError ? (
        <ErrorState
          title="Could not load memories"
          message="The memories for this conversation failed to load. This is an error, not an empty result. Check your connection or permissions and try again."
          onRetry={() => load(chatId)}
        />
      ) : chatId && memories.length > 0 ? (
        <div data-tour="memories-list" class="space-y-3">
          {memories.map((m, i) => (
            <div key={i} class="bg-surface border border-border rounded-xl p-5">
              <div class="flex items-center gap-2 mb-2">
                <span title={m.agentId}>
                  <Badge variant="info">{nameFor(m.agentId)}</Badge>
                </span>
                {m.importance != null && <Badge variant="warning">importance: {m.importance}</Badge>}
                {m.createdAt && <span class="text-caption text-muted">{new Date(m.createdAt).toLocaleString()}</span>}
              </div>
              <pre class="text-body-sm text-primary whitespace-pre-wrap font-sans break-words">{m.content}</pre>
            </div>
          ))}
        </div>
      ) : chatId ? (
        <EmptyState icon={<EmptyBrain />} title="No memories found" description="No memories exist for this conversation." />
      ) : null}
    </div>
  );
}
