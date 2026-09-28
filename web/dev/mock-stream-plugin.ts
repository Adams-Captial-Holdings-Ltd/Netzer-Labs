// Dev-only mock of the chat turn stream. When the dev server is started with
// CCE_CHAT_MOCK=1, POST /api/test-turn/stream is answered locally with
// scripted SSE fixtures at a realistic cadence instead of being proxied to the
// orchestrator — the only way to see true token-by-token streaming and tool
// events on a developer machine, where the Floci Bedrock stub emits a single
// chunk and can never reach tool dispatch (development.md, known limitations).
//
// It ALSO answers the three chat-page reads that cannot work on a developer
// machine: /agents, /sessions and /sessions/transcript are DynamoDB-backed and
// return `{"error":"internal_error"}` against a local orchestrator with no
// table. Chat.tsx treats an /agents failure as fatal (it sets loadError and
// send() early-returns without an agent), so without these the chat surface
// can never be driven or screenshotted locally — which is exactly how a
// capture run ends up with no pixels of the chat. /whoami and /models are NOT
// mocked: they work locally, and leaving them real keeps the captured surface
// talking to the actual dashboard API for identity and the model picker.
//
// Never part of a production build: `apply: 'serve'` restricts the plugin to
// the dev server, and vite.config.ts additionally only registers it when the
// env var is set. Middleware is registered in the configureServer hook BODY,
// which runs BEFORE Vite's internal middlewares — including the /api proxy —
// so the mock wins the route while the rest of /api still proxies normally.

import type { ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { fixtures } from './fixtures';
import { artifactFixtures, mockArtifacts } from './artifact-fixtures';
import type { ToolCall } from '../src/lib/chat/types';

/**
 * 30-80ms between events: fast enough to feel live, slow enough to watch. An
 * event may override it with `delayMs` — tool dispatch on the real backend
 * costs hundreds of milliseconds per call, and a fixture that fires tool events
 * at token cadence makes the live status line unobservable (see fixtures.ts).
 */
function cadence(res: ServerResponse, delayMs?: number): Promise<void> {
  const ms = delayMs ?? 30 + Math.random() * 50;
  return new Promise((resolve) => {
    // Record a stopped turn immediately, before a reload can read its transcript.
    const finish = () => {
      clearTimeout(timer);
      res.off('close', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    res.once('close', finish);
    if (res.destroyed) finish();
  });
}

/** Frame one SSE event; multi-line data becomes repeated `data:` lines. */
function sseWrite(res: ServerResponse, event: string, data: string): void {
  const lines = data.split('\n').map((l) => `data: ${l}`).join('\n');
  res.write(`event: ${event}\n${lines}\n\n`);
}

/**
 * The turn request the SPA posts (`web/src/lib/chat/stream.ts`). Parsed in one
 * place because two things now need it — the fixture choice and the transcript
 * record — and a missing or unparseable body is still a valid request that
 * plays "default".
 */
function parseTurn(rawBody: string): {
  text: string; chatId: string; attachmentKeys: string[]; regenerate: boolean;
  clientMessageId?: string; replyTo?: unknown;
} {
  try {
    const body = JSON.parse(rawBody) as {
      text?: unknown; chatId?: unknown; attachments?: unknown; regenerate?: unknown;
      clientMessageId?: unknown; replyTo?: unknown;
    };
    const attachmentKeys = Array.isArray(body.attachments)
      ? body.attachments.map((a) => String((a as { s3Key?: unknown }).s3Key ?? ''))
      : [];
    return {
      text: String(body.text ?? ''), chatId: String(body.chatId ?? ''), attachmentKeys,
      regenerate: body.regenerate === true,
      ...(typeof body.clientMessageId === 'string' ? { clientMessageId: body.clientMessageId } : {}),
      ...(Object.prototype.hasOwnProperty.call(body, 'replyTo') ? { replyTo: body.replyTo } : {}),
    };
  } catch {
    return { text: '', chatId: '', attachmentKeys: [], regenerate: false };
  }
}

// ── P3: uploads (written with the P3 bar, netzar-chat-plan/p3-proof.sh E-rows) ──
// The real route signs a presigned S3 PUT (POST /api/chat/uploads) and the browser
// PUTs the file straight to S3. Here the "S3" is this dev server, under /__mock-s3,
// holding the bytes in memory. It refuses what real S3 would: a PUT whose
// Content-Type is not the one that was signed. An upload whose name contains
// "slow" answers its PUT after 1.5 s, so a browser test can see the progress bar.
// The transcript records ONLY what the page actually sent with its message, so a
// file-only message reloads with its chips if, and only if, the page sent them.
const MOCK_S3 = '/__mock-s3/';
const MOCK_ARTIFACTS = '/__mock-artifacts/';
let mints = 0;
const UPLOAD_MAX_BYTES = 30 * 1024 * 1024; // the real route's ceiling (owner decision 29)
interface MockUpload { id: string; name: string; type: string; size: number; bytes?: Buffer }
const uploads = new Map<string, MockUpload>(); // by key
let uploadSeq = 0;

function readBody(req: import('node:http').IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function jsonStatus(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** What a stored message says about its files: never the storage key (the real transcript's rule). */
function describeUploads(keys: string[]): Array<{ id: string; name: string; type: string; size: number }> {
  return keys.flatMap((k) => {
    const u = uploads.get(k);
    return u ? [{ id: u.id, name: u.name, type: u.type, size: u.size }] : [];
  });
}

interface PlayedTurn { text: string; tools: ToolCall[]; stopped: boolean; artifacts: unknown[]; failed: boolean; dropped?: true; saveLate?: boolean }

// P7 (A240): how long after the drop the `drop-late` fixture saves its stopped reply.
const LATE_SAVE_MS = 700;

/** Accumulate only the fields the real transcript stores, never arguments. */
function recordToolEvent(tools: ToolCall[], event: string, data: string): void {
  if (event === 'tool') {
    const { label, step, toolUseId } = JSON.parse(data) as ToolCall;
    tools.push({ label, step, ...(toolUseId !== undefined ? { toolUseId } : {}) });
  } else if (event === 'tool_result') {
    const { toolUseId, output, isError, truncated } = JSON.parse(data) as ToolCall;
    const index = tools.findIndex((tool) => tool.toolUseId !== undefined && tool.toolUseId === toolUseId);
    if (index !== -1) tools[index] = { ...tools[index], output, isError, truncated };
  }
}

/**
 * Play one fixture, and return the assistant text that actually reached the
 * client. Fixture `chunk` and `reply` events carry the reply CUMULATIVELY, so
 * the last one written is the whole reply. The page reads only protocol 2
 * (P7, WIRE), so each `chunk` goes out as a `delta` at position 0, which
 * replaces the text (web/src/lib/chat/stream.ts). A client that leaves
 * mid-stream is returned what it had received, which is then exactly what its
 * transcript replays.
 */
async function play(text: string, res: ServerResponse): Promise<PlayedTurn> {
  // Fixture selection: "/fixture <name>" picks one by name, anything else
  // (including an unknown name) plays "default".
  const name = text.startsWith('/fixture ') ? text.slice('/fixture '.length).trim() : 'default';
  const fixture = fixtures[name] ?? artifactFixtures[name] ?? fixtures.default;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  let streamed = '';
  const tools: ToolCall[] = [];
  // P5: the URL-free references a turn published, kept on its stored turn as the real route does.
  const artifacts: unknown[] = [];
  let failed = false;
  for (const ev of fixture) {
    await cadence(res, ev.delayMs);
    if (res.destroyed || res.writableEnded) return { text: streamed, tools, stopped: res.destroyed, artifacts, failed };
    // P7 (A240): the `drop` fixture's marker. Left open: the caller records the reply, then drops the connection.
    if (ev.event === 'drop') return { text: streamed, tools, stopped: true, artifacts, failed, dropped: true, saveLate: ev.data === 'late' };
    // The real route publishes at most eight references a turn (MAX_DASHBOARD_ARTIFACT_REFS).
    if (ev.event === 'artifact_ref' && artifacts.length >= 8) continue;
    if (ev.event === 'chunk') sseWrite(res, 'delta', JSON.stringify({ i: 0, t: ev.data }));
    else sseWrite(res, ev.event, ev.data);
    if (ev.event === 'chunk' || ev.event === 'reply') streamed = ev.data;
    if (ev.event === 'artifact_ref') artifacts.push(JSON.parse(ev.data));
    if (ev.event === 'error') failed = true;
    recordToolEvent(tools, ev.event, ev.data);
  }
  res.end();
  return { text: streamed, tools, stopped: false, artifacts, failed };
}

/** Send a JSON body with the shape the real route returns. */
function json(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

// The roster the chat page reads on mount. `status` matters: Chat.tsx filters
// to active only, so the inactive row here is a live check that the filter
// still holds (it must never appear in the picker).
//
// The roster is DELIBERATELY long. It is the platform's own seventeen agent
// templates (verbatim from GET /agents/templates — same ids, display names and
// descriptions) standing in as deployed agents, plus the house agent and one
// retired row. A four-row fixture cannot tell you whether the agent picker is
// usable, because at four rows every picker is: the search field, the
// scrolling list and the descriptor line only start earning their place at the
// length a real deployment actually reaches. `description` is a field /agents
// has always returned; the old fixture just omitted it, so the picker had
// nothing to render and no second search axis to match on.
const mockAgents = {
  agents: [
    { id: 'main', displayName: 'Netzar Prime', status: 'active', description: 'The house agent — general work, full tool access, every kill switch honoured.' },
    { id: 'blank', displayName: 'Blank Agent', status: 'active', description: 'Minimal agent with no specialized behavior.' },
    { id: 'comms', displayName: 'Communications', status: 'active', description: 'Email, messaging, and stakeholder communication.' },
    { id: 'content', displayName: 'Content Creator', status: 'active', description: 'Writing, editing, and content strategy.' },
    { id: 'ops', displayName: 'Operations', status: 'active', description: 'Scheduling, billing, and operational tasks.' },
    { id: 'research', displayName: 'Research', status: 'active', description: 'Deep research, analysis, and synthesis.' },
    { id: 'due-diligence', displayName: 'Due Diligence Analyst', status: 'active', description: 'Deal screening, document review, and risk surfacing for investment teams.' },
    { id: 'lp-update', displayName: 'LP Update Drafter', status: 'active', description: 'Investor letters, quarterly updates, and capital-call notices in your voice.' },
    { id: 'deal-memo', displayName: 'Deal Memo Summarizer', status: 'active', description: 'Turn meeting notes, transcripts, and data rooms into tight IC-ready memos.' },
    { id: 'grant-writer', displayName: 'Grant Writer', status: 'active', description: 'Proposals, LOIs, and funder reports for nonprofits, grounded in your documents.' },
    { id: 'compliance-reviewer', displayName: 'Compliance Reviewer', status: 'active', description: 'Policy checks, document review, and audit-prep against your indexed policies.' },
    { id: 'exec-assistant', displayName: 'Executive Assistant', status: 'active', description: 'Inbox triage, briefings, scheduling, and follow-up tracking for a busy principal.' },
    { id: 'support', displayName: 'Customer Support', status: 'active', description: 'Front-line customer support grounded in your help docs, with clean human handoff.' },
    { id: 'sdr', displayName: 'Sales Development Rep', status: 'active', description: 'Qualify inbound leads, draft outreach, and book the calls worth taking.' },
    { id: 'social', displayName: 'Social Media Manager', status: 'active', description: 'Plan the calendar and repurpose one idea across every platform.' },
    { id: 'marketing-strategist', displayName: 'Marketing Strategist', status: 'active', description: 'Positioning, offers, and launch plans that brief the rest of the fleet.' },
    { id: 'community-manager', displayName: 'Community Manager', status: 'active', description: 'Welcome members, answer recurring questions, and surface who is at risk of churning.' },
    { id: 'bookkeeper', displayName: 'Bookkeeper', status: 'active', description: 'Categorize transactions, chase invoices, and explain the numbers in plain English.' },
    { id: 'legacy', displayName: 'Retired Assistant', status: 'inactive', description: 'Decommissioned. Must never appear in the picker.' },
  ],
};

// Sidebar rows. Only `dashboard:`-prefixed chats are browsable (Chat.tsx
// filters on the prefix), so one non-dashboard row is included to prove the
// filter.
//
// UNITS: `updatedAt` is EPOCH SECONDS. That is what the real route returns —
// `src/lib/state/sessions-repo.ts` documents the field as "epoch seconds" and
// writes it that way — and it is what `relativeAge()` reads. This fixture used
// to emit `Date.now()` milliseconds, which made every row's age arithmetic go
// negative and clamp to "now": three rows an hour, a day and four days apart
// all rendered identically, and the date grouping this phase adds would have
// filed every one of them under a year ~55,000 years hence. The `chatId`
// suffix stays in MILLISECONDS, because that is what `freshChatId()` mints
// (`dashboard:${Date.now()}`) and the two fields genuinely differ.
//
// The spread is deliberate: enough rows on both sides of every boundary the
// grouping ladder tests — today, yesterday, inside seven days, inside thirty,
// and earlier than that — so a screenshot of the sidebar shows real groups
// rather than one heading with everything under it.
//
// IDENTITY: `chatId` is a FIXED string per row, not derived from `Date.now()`.
// It used to be `dashboard:${now - hoursAgo * hour}`, which minted a different
// id on every request — so the row you had open stopped existing the moment
// anything called GET /sessions again (send() and the delete path both do,
// right after `clearApiCache()`), the sidebar's active marker went out, and
// reopening it 404'd. `updatedAt` stays relative to the live clock, because
// that is what has to keep moving for the date groups to mean anything.
const SESSION_ID_BASE = 1_750_000_000_000;
const sessionMeta = new Map<string, { title: string | null; pinned: boolean }>();

function mockSessions(q = ''): unknown {
  const hourMs = 3_600_000;
  const nowMs = Date.now();
  // hours ago, messageCount, opening line
  const rows: Array<[number, number, string]> = [
    [1, 6, 'Wiring the turn stream'],
    [4, 18, 'Draft the incident note for the cost-cap trip'],
    [9, 2, 'Which model is the LP update agent on?'],
    [26, 4, 'Quarterly posture review'],
    [30, 7, 'Kill-switch audit rows from yesterday'],
    [72, 11, 'Why did the deploy fail?'],
    [96, 12, 'Compare Opus 1M and Sonnet 1M on the diligence pack'],
    [24 * 12, 5, 'Grant narrative for the Q3 renewal'],
    [24 * 21, 9, 'Reconcile the August invoice exceptions'],
    [24 * 64, 3, 'First pass at the compliance control catalogue'],
  ];
  const sessions = [
      ...rows.map(([hoursAgo, messageCount, firstMessage], i) => ({
        agentId: 'main',
        chatId: `dashboard:${SESSION_ID_BASE + i}`,
        updatedAt: Math.floor((nowMs - hoursAgo * hourMs) / 1000),
        messageCount,
        firstMessage,
        title: sessionMeta.get(`dashboard:${SESSION_ID_BASE + i}`)?.title ?? null,
        pinned: sessionMeta.get(`dashboard:${SESSION_ID_BASE + i}`)?.pinned ?? false,
      })),
      {
        agentId: 'main',
        chatId: 'telegram:2201',
        updatedAt: Math.floor((nowMs - 2 * hourMs) / 1000),
        messageCount: 3,
        firstMessage: 'not browsable here',
        title: null,
        pinned: false,
      },
      ...[...transcripts].filter(([chatId]) => !rows.some((_, i) => chatId === `dashboard:${SESSION_ID_BASE + i}`))
        .map(([chatId, turns]) => ({ agentId: 'main', chatId, updatedAt: turns.at(-1)?.ts ?? nowMs / 1000,
          messageCount: turns.length, firstMessage: turns.find((t) => t.role === 'user')?.text ?? null,
          title: sessionMeta.get(chatId)?.title ?? null, pinned: sessionMeta.get(chatId)?.pinned ?? false })),
    ];
  return { sessions: sessions.filter((s) => !q || (s.title ?? '').toLowerCase().includes(q) ||
    (s.firstMessage ?? '').toLowerCase().includes(q))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt) };
}

// Turns this dev server actually streamed, keyed by `chatId`, so REOPENING a
// conversation replays it instead of coming back empty. In memory and per
// process: a dev-server restart forgets every conversation, which is the same
// lifetime the fixtures have and the same clean slate Floci gives on restart
// (development.md, Floci integration → Startup, persistence and reset).
//
// UNITS: `ts` is EPOCH SECONDS, fractional — what `Chat.tsx` stamps its own
// messages with (`Date.now() / 1000`) and what the real route's stored turns
// carry. The milliseconds mistake this file made once for `updatedAt` is
// written up above the sidebar fixture; it is not repeated here.
const transcripts = new Map<string, Array<{
  role: string; text: string; ts: number; requestId?: string; status?: string; tools?: ToolCall[];
  attachments?: Array<{ id: string; name: string; type: string; size: number }>;
  artifacts?: unknown[];
}>>();

// The one bound on that Map. A dev server left running all day accumulates a
// conversation per "New chat" click and never released one, which both reviews
// raised. 200 is far above any real session (the sidebar fixture has 11 rows)
// and still finite. A Map iterates in INSERTION order and `set` on an existing
// key does not reorder it, so this evicts the oldest conversation created, not
// the least recently used — good enough here, and LRU is the upgrade if a
// session ever hits the cap for real.
const MAX_CONVERSATIONS = 200;

/** Append one exchange. A turn with no chatId cannot be addressed, so it is dropped — loudly. */
function recordedReply(reply: PlayedTurn, ts: number, requestId?: string) {
  return {
    role: 'assistant', text: reply.text || (reply.stopped ? '(Stopped before a reply.)' : ''), ts,
    ...(typeof requestId === 'string' ? { requestId } : {}),
    ...(reply.stopped ? { status: 'stopped' } : {}),
    ...(reply.tools.length ? {
      tools: reply.tools.map(({ input: _input, inputTruncated: _inputTruncated, ...tool }) => tool),
    } : {}),
    ...(reply.artifacts.length ? { artifacts: reply.artifacts } : {}),
  };
}

function recordTurn(
  chatId: string, userText: string, reply: PlayedTurn, attachmentKeys: string[] = [], requestId?: string, notice = false,
): void {
  if (!chatId) {
    // The chat page always sends one (web/src/lib/chat/stream.ts), so this is
    // either an unparseable body or a caller that is not the chat page.
    // Dropping it in silence would present later as the transcript route
    // losing turns, which is a much harder thing to work out from the outside.
    console.warn('[chat-mock] turn carried no chatId: not recorded, so a reload will not replay it');
    return;
  }
  const ts = Date.now() / 1000;
  const files = describeUploads(attachmentKeys);
  transcripts.set(chatId, [
    ...(transcripts.get(chatId) ?? []),
    { role: 'user', text: userText, ts, ...(files.length ? { attachments: files } : {}) },
    ...(reply.text || reply.stopped || reply.tools.length || reply.artifacts.length
      ? [{ ...recordedReply(reply, ts, requestId), ...(notice ? { status: 'notice' } : {}) }]
      : []),
  ]);
  // Evicting in silence would be worse than not evicting at all: reopening a
  // dropped conversation returns an empty transcript, which is exactly what the
  // hard-coded `{ turns: [] }` this route replaced used to do. Say it happened.
  while (transcripts.size > MAX_CONVERSATIONS) {
    const oldest = transcripts.keys().next().value as string;
    transcripts.delete(oldest);
    console.warn(`[chat-mock] ${MAX_CONVERSATIONS} conversations held; forgetting the oldest (${oldest}). Reopening it will come back empty. Restart the dev server for a clean slate.`);
  }
}

export function mockStreamPlugin(): Plugin {
  return {
    name: 'cce-chat-mock-stream',
    apply: 'serve', // dev server only — this plugin cannot enter a build
    configureServer(server) {
      server.middlewares.use('/api/test-turn/stream', (req, res, next) => {
        if (req.method !== 'POST') return next();
        let raw = '';
        req.on('data', (c: Buffer) => { raw += c; });
        req.on('end', () => {
          const turn = parseTurn(raw);
          // P7 (A241): a file-only send with no caption has nothing the model can
          // see, so the real route answers with a canned "stored but not read"
          // acknowledgement (event: reply, done: media_only) instead of a model
          // turn (handler.ts's media-only branch). The stored turn is a notice,
          // so it remains non-regenerable after a reload.
          if (!turn.regenerate && !turn.text && turn.attachmentKeys.length > 0) {
            const note = 'Stored the file.';
            res.writeHead(200, {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
            });
            sseWrite(res, 'reply', note);
            recordTurn(turn.chatId, turn.text, { text: note, tools: [], stopped: false, artifacts: [], failed: false }, turn.attachmentKeys, turn.clientMessageId, true);
            sseWrite(res, 'done', 'media_only');
            res.end();
            return;
          }
          if (turn.regenerate) {
            if (turn.text || turn.attachmentKeys.length ||
              (turn.replyTo !== undefined && turn.replyTo !== null && typeof turn.replyTo !== 'string')) {
              jsonStatus(res, 400, { error: 'invalid_regenerate' });
              return;
            }
            const known = transcripts.has(turn.chatId) ||
              [...Array(10).keys()].some((i) => turn.chatId === `dashboard:${SESSION_ID_BASE + i}`);
            if (!known) {
              jsonStatus(res, 404, { error: 'not_found' });
              return;
            }
            const stored = transcripts.get(turn.chatId);
            if (!stored?.length || stored.at(-1)?.role !== 'assistant' || stored.at(-1)?.status === 'notice') {
              jsonStatus(res, 409, { error: 'nothing_to_regenerate' });
              return;
            }
            if (turn.replyTo !== undefined && (stored.at(-1)?.requestId ?? null) !== turn.replyTo) {
              jsonStatus(res, 409, { error: 'reply_changed' });
              return;
            }
          }
          // The record lands in the microtask after `res.end()`, and node runs
          // one thread, so it always completes before this server can accept
          // the next request — including the reload's transcript read. There is
          // no race to guard against here.
          const previousQuestion = turn.regenerate ? transcripts.get(turn.chatId)?.at(-2)?.text ?? '' : '';
          const fixtureText = turn.regenerate
            ? previousQuestion.startsWith('/fixture ') ? previousQuestion : '/fixture regen'
            : turn.text;
          void play(fixtureText, res)
            .then((reply) => {
              if (reply.failed) return;
              // A cut stream records what the client actually received, which is
              // the honest transcript — but a mysteriously short reply on replay
              // is worth a word here rather than a puzzle later.
              if (reply.stopped && !reply.dropped) {
                console.warn(`[chat-mock] stream cut mid-turn: recording the partial reply (${reply.text.length} chars)`);
              }
              const record = () => {
                if (turn.regenerate) {
                  const stored = transcripts.get(turn.chatId)!;
                  transcripts.set(turn.chatId, [...stored.slice(0, -1), recordedReply(reply, Date.now() / 1000, turn.clientMessageId)]);
                } else recordTurn(turn.chatId, turn.text, reply, turn.attachmentKeys, turn.clientMessageId);
              };
              // P7 (A240): the real route saves a dropped reply only after its outbound scan, so that save can
              // land after the page has already seen the drop. `drop-late` plays that order.
              if (reply.saveLate) {
                res.destroy();
                setTimeout(record, LATE_SAVE_MS);
                return;
              }
              record();
              // P7 (A240): saved as stopped first, as the real route saves a reply whose connection dropped;
              // then the connection drops with the body unfinished, which the page reads as a network failure.
              if (reply.dropped) res.destroy();
            })
            // Without this, a throw anywhere above becomes an unhandled
            // rejection that takes the whole dev server down and blames
            // whatever ran next. Nothing is recorded, and it says so.
            .catch((err: unknown) => {
              console.error('[chat-mock] turn failed, nothing recorded:', err);
            });
        });
      });

      // P3: sign an upload the way POST /api/chat/uploads does.
      server.middlewares.use('/api/chat/uploads', (req, res, next) => {
        if (req.method !== 'POST') return next();
        void readBody(req).then((raw) => {
          let body: { fileName?: unknown; mimeType?: unknown; size?: unknown } = {};
          try { body = JSON.parse(raw.toString('utf8')); } catch { /* an empty body is refused below */ }
          const name = String(body.fileName ?? '');
          const size = Number(body.size);
          if (!name || !Number.isInteger(size) || size < 1) return jsonStatus(res, 400, { error: 'invalid_upload' });
          if (size > UPLOAD_MAX_BYTES) return jsonStatus(res, 413, { error: 'file_too_large', maxBytes: UPLOAD_MAX_BYTES });
          const id = `mock-upload-${++uploadSeq}`;
          const key = `uploads/chat/mock/${id}/${name.replace(/[^A-Za-z0-9._-]/g, '_').slice(-120)}`;
          const type = String(body.mimeType || 'application/octet-stream');
          uploads.set(key, { id, name, type, size });
          json(res, { url: `${MOCK_S3}${key}`, key, id, headers: { 'Content-Type': type } });
        }).catch((err: unknown) => {
          console.error('[chat-mock] upload sign failed:', err);
          jsonStatus(res, 500, { error: 'mock_failed' });
        });
      });

      // P3: the pretend S3 bucket the signed PUT and the download link point at.
      server.middlewares.use(MOCK_S3.slice(0, -1), (req, res, next) => {
        const key = decodeURIComponent((req.url ?? '/').split('?')[0].slice(1));
        const upload = uploads.get(key);
        if (req.method === 'PUT') {
          if (!upload) return jsonStatus(res, 403, { error: 'no such signed upload' });
          if (req.headers['content-type'] !== upload.type) {
            // Real S3 refuses a PUT whose signed header differs.
            return jsonStatus(res, 403, { error: 'SignatureDoesNotMatch: Content-Type' });
          }
          void readBody(req).then((bytes) => {
            upload.bytes = bytes;
            const done = () => { res.writeHead(200); res.end(); };
            if (key.includes('slow')) setTimeout(done, 1500);
            else done();
          }).catch((err: unknown) => {
            console.error('[chat-mock] upload PUT failed:', err);
            jsonStatus(res, 500, { error: 'mock_failed' });
          });
          return;
        }
        if (req.method === 'GET') {
          if (!upload?.bytes) return jsonStatus(res, 404, { error: 'NoSuchKey' });
          res.writeHead(200, {
            'Content-Type': upload.type,
            'Content-Disposition': `attachment; filename="${upload.name.replace(/"/g, '')}"`,
          });
          res.end(upload.bytes);
          return;
        }
        next();
      });

      // P5: the three artifact reads the panel makes, with the real routes' response
      // shapes and the not-found / view refusals the panel meets
      // (src/adapters/dashboard/handler.ts /artifacts/versions, /download, /content).
      // Ownership, scope, capability and version-format checks are not modelled here —
      // the route tests prove them (src/adapters/dashboard/artifacts.p5.test.ts).
      const artifactVersion = (req: import('node:http').IncomingMessage) => {
        const q = new URL(req.url ?? '/', 'http://localhost').searchParams;
        const artifactId = q.get('artifactId') ?? '';
        const version = Number(q.get('version'));
        return { q, artifactId, found: mockArtifacts.get(artifactId)?.find((v) => v.version === version) };
      };
      server.middlewares.use('/api/artifacts/versions', (req, res, next) => {
        if (req.method !== 'GET') return next();
        const artifactId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('artifactId') ?? '';
        const versions = mockArtifacts.get(artifactId);
        if (!versions) return jsonStatus(res, 404, { error: 'not_found' });
        json(res, { versions: versions.map(({ version, fileName, contentType, createdAt }) =>
          ({ artifactId, version, fileName, contentType, createdAt })) });
      });
      server.middlewares.use('/api/artifacts/download', (req, res, next) => {
        if (req.method !== 'GET') return next();
        const { artifactId, found } = artifactVersion(req);
        if (!found) return jsonStatus(res, 404, { error: 'not_found' });
        // Each mint is a new link, as a fresh presign is: `mint` tells two apart.
        json(res, { url: `${MOCK_ARTIFACTS}${artifactId}/v${found.version}?mint=${++mints}`, fileName: found.downloadName, version: found.version });
      });
      server.middlewares.use('/api/artifacts/content', (req, res, next) => {
        if (req.method !== 'GET') return next();
        const { q, found } = artifactVersion(req);
        const view = q.get('view');
        if (view !== null && view !== 'outline') return jsonStatus(res, 400, { error: 'invalid_view' });
        if (!found) return jsonStatus(res, 404, { error: 'not_found' });
        if (view === 'outline') {
          if (!found.outline) return jsonStatus(res, 400, { error: 'outline_unsupported' });
          return jsonStatus(res, found.outline.status, found.outline.body);
        }
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${found.downloadName.replace(/"/g, '')}"`,
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "sandbox; default-src 'none'",
          'Cache-Control': 'no-store',
        });
        res.end(found.bytes);
      });
      // The pretend CURATED bucket a minted download link points at.
      server.middlewares.use(MOCK_ARTIFACTS.slice(0, -1), (req, res, next) => {
        if (req.method !== 'GET') return next();
        const [, artifactId, v] = /^\/([^/]+)\/v(\d+)$/.exec((req.url ?? '/').split('?')[0]) ?? [];
        const found = mockArtifacts.get(artifactId ?? '')?.find((x) => x.version === Number(v));
        if (!found) return jsonStatus(res, 404, { error: 'NoSuchKey' });
        res.writeHead(200, {
          'Content-Type': found.contentType,
          'Content-Disposition': `attachment; filename="${found.downloadName.replace(/"/g, '')}"`,
        });
        res.end(found.bytes);
      });

      // P3: the owner's download link for one stored file (GET /api/sessions/attachment).
      // Mounted BEFORE '/api/sessions' for the reason given below.
      server.middlewares.use('/api/sessions/attachment', (req, res, next) => {
        if (req.method !== 'GET') return next();
        const q = new URL(req.url ?? '/', 'http://localhost').searchParams;
        const sent = (transcripts.get(q.get('chatId') ?? '') ?? []).flatMap((t) => t.attachments ?? []);
        const file = sent.find((a) => a.id === q.get('id'));
        const key = file ? [...uploads.entries()].find(([, u]) => u.id === file.id)?.[0] : undefined;
        if (!file || !key) return jsonStatus(res, 404, { error: 'not_found' });
        json(res, { url: `${MOCK_S3}${key}?download=1`, name: file.name });
      });

      // Mounted BEFORE '/api/sessions' — connect matches on prefix, so the
      // longer path has to be registered first or the list route swallows it.
      server.middlewares.use('/api/sessions/transcript', (req, res, next) => {
        if (req.method !== 'GET') return next();
        // Reopening a stored conversation replays the turns this process
        // streamed for it. Same shape as the real route, which answers
        // `{ turns: session?.turns ?? [] }` (handler.ts `/sessions/transcript`),
        // so a chat this process never streamed is still an empty array — the
        // honest answer, just no longer the ONLY answer.
        // connect strips the mount path, so req.url is '/?agentId=…&chatId=…'.
        const chatId = new URL(req.url ?? '/', 'http://localhost').searchParams.get('chatId') ?? '';
        json(res, { turns: transcripts.get(chatId) ?? [] });
      });

      server.middlewares.use('/api/sessions', (req, res, next) => {
        if (req.method === 'PATCH') {
          void readBody(req).then((raw) => {
            let body: Record<string, unknown>;
            try { body = JSON.parse(raw.toString()) as Record<string, unknown>; }
            catch { jsonStatus(res, 400, { error: 'invalid_json' }); return; }
            const chatId = body.chatId;
            if (typeof chatId !== 'string' || !chatId) { jsonStatus(res, 400, { error: 'chatId_required' }); return; }
            if (body.title === undefined && body.pinned === undefined) { jsonStatus(res, 400, { error: 'nothing_to_update' }); return; }
            if (body.title !== undefined && body.title !== null && (typeof body.title !== 'string' ||
              /[\x00-\x1f\x7f]/.test(body.title) || body.title.trim().length > 120)) {
              jsonStatus(res, 400, { error: 'invalid_title' }); return;
            }
            if (body.pinned !== undefined && typeof body.pinned !== 'boolean') { jsonStatus(res, 400, { error: 'invalid_pinned' }); return; }
            const known = (body.agentId === undefined || body.agentId === 'main') &&
              ((chatId.startsWith('dashboard:') && Number(chatId.slice(10)) >= SESSION_ID_BASE &&
              Number(chatId.slice(10)) < SESSION_ID_BASE + 10) || transcripts.has(chatId));
            if (!known) { jsonStatus(res, 404, { error: 'not_found' }); return; }
            const old = sessionMeta.get(chatId) ?? { title: null, pinned: false };
            const title = body.title !== undefined ? (typeof body.title === 'string' ? body.title.trim() || null : null) : old.title;
            const pinned = body.pinned !== undefined ? body.pinned as boolean : old.pinned;
            sessionMeta.set(chatId, { title, pinned });
            json(res, { agentId: body.agentId ?? 'main', chatId, title, pinned });
          });
          return;
        }
        if (req.method !== 'GET') return next();
        const q = new URL(req.url ?? '/', 'http://localhost').searchParams.get('q')?.trim() ?? '';
        if (q.length > 100) { jsonStatus(res, 400, { error: 'invalid_query' }); return; }
        json(res, mockSessions(q.toLowerCase()));
      });

      server.middlewares.use('/api/agents', (req, res, next) => {
        // connect strips the mount path, so the roster read arrives as '/'.
        // Anything deeper is an agent-detail route — let it proxy through.
        const path = (req.url ?? '/').split('?')[0];
        if (req.method !== 'GET' || path !== '/') return next();
        json(res, mockAgents);
      });
    },
  };
}
