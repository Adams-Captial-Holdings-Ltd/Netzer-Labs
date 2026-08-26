// Scripted SSE fixtures for the dev-only mock stream (see
// mock-stream-plugin.ts). Pure data, no I/O: each fixture is the ordered list
// of SSE events the mock server plays back. Chunk events carry CUMULATIVE
// text (the real backend replaces, never appends) — see
// web/src/lib/chat/stream.ts. Select one from the Chat tab by sending
// "/fixture <name>"; anything else plays "default".

export interface MockSseEvent {
  event: string;
  data: string;
}

export type Fixture = MockSseEvent[];

const MODEL_ID = 'us.anthropic.claude-sonnet-4-5';

/** The realistic `final` payload the backend ends a turn with. */
function finalEvent(text: string, opts: { latencyMs: number; costUsd: number; toolCallCount: number }): MockSseEvent {
  return {
    event: 'final',
    data: JSON.stringify({ text, modelId: MODEL_ID, ...opts }),
  };
}

/** Slice `full` into `count` cumulative chunk events. */
function cumulativeChunks(full: string, count: number): MockSseEvent[] {
  const events: MockSseEvent[] = [];
  for (let i = 1; i <= count; i++) {
    const end = Math.ceil((full.length * i) / count);
    events.push({ event: 'chunk', data: full.slice(0, end) });
  }
  return events;
}

// ── default: rich markdown exercising the whole prose surface ────────────────

const defaultText = `# Quarterly posture review

Here is the summary you asked for, pulled from the last **90 days** of audit
data. Three findings stand out:

1. Kill-switch drills ran *on schedule* every week.
2. The \`tool_use\` switch was tripped twice, both times deliberately.
3. Cost stayed under the daily cap on **89 of 90 days**.

## Notable numbers

| Metric | Value | Trend |
| --- | --- | --- |
| Turns served | 12,408 | up |
| Median latency | 1.9s | flat |
| Cost per turn | $0.0113 | down |

The full methodology is in the [runbook](https://example.com/runbook), and the
raw export is one click away. Inline code like \`clearApiCache()\` renders in
monospace.

### Reproduce it

\`\`\`ts
const rows = await api.get<{ sessions: Conversation[] }>('/sessions?agentId=main');
console.log(rows.sessions.length);
\`\`\`

\`\`\`bash
curl -s http://127.0.0.1:3000/health | jq .status
\`\`\`

> Nothing in this report leaves the account boundary. Ask me to drill into any
> row and I will pull the underlying audit events.`;

const defaultFixture: Fixture = [
  ...cumulativeChunks(defaultText, 28),
  finalEvent(defaultText, { latencyMs: 2140, costUsd: 0.0117, toolCallCount: 0 }),
];

// ── tools: five tool events interleaved with streaming text ──────────────────

const toolsText = `Searching across the workspace and the web, one moment.

Found it: the deploy failed because the image tag was stale. The fix landed in
\`scripts/deploy.ts\` and the follow-up is tracked in the missions board.`;

const toolsFixture: Fixture = [
  { event: 'tool', data: JSON.stringify({ label: 'web search', step: 1 }) },
  { event: 'tool', data: JSON.stringify({ label: 'web fetch', step: 2 }) },
  ...cumulativeChunks(toolsText.slice(0, 52), 3),
  { event: 'tool', data: JSON.stringify({ label: 'Slack: search public', step: 3 }) },
  { event: 'tool', data: JSON.stringify({ label: 'Knowledge: search', step: 4 }) },
  { event: 'tool', data: JSON.stringify({ label: 'document generator', step: 5 }) },
  ...cumulativeChunks(toolsText, 10).slice(4),
  finalEvent(toolsText, { latencyMs: 8320, costUsd: 0.0409, toolCallCount: 5 }),
];

// ── error-mid: the turn dies before any text streams ─────────────────────────

const errorMidFixture: Fixture = [
  { event: 'error', data: 'kill_switch_active: tool_use' },
];

// ── error-partial: three chunks, then a mid-stream failure ───────────────────

const errorPartialText = `The report covers three regions. Region one is healthy, region two is
degraded, and region three`;

const errorPartialFixture: Fixture = [
  ...cumulativeChunks(errorPartialText, 3),
  { event: 'error', data: 'daily cost cap exceeded: $1.52 >= $1.50' },
];

// ── media: media/kb/image/artifact events around a short reply ───────────────

// A tiny inline SVG so the image renders with no network at all.
const svgDataUri =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='180'%3E" +
  "%3Crect width='320' height='180' rx='12' fill='%236366f1'/%3E" +
  "%3Ctext x='160' y='96' fill='white' text-anchor='middle' font-family='sans-serif' font-size='16'%3EMock image%3C/text%3E" +
  '%3C/svg%3E';

const mediaText = `Transcribed the voice note and indexed the deck. The chart you asked for is
below, and the summary document is attached.`;

const mediaFixture: Fixture = [
  { event: 'media', data: JSON.stringify({ fileName: 'standup.m4a', stage: 'transcribe', label: 'Transcribing standup.m4a…' }) },
  { event: 'media', data: JSON.stringify({ fileName: 'deck.pdf', stage: 'indexing' }) },
  { event: 'kb', data: JSON.stringify({ text: 'Indexed deck.pdf into the knowledge base' }) },
  ...cumulativeChunks(mediaText, 6),
  { event: 'image', data: JSON.stringify({ url: svgDataUri, caption: 'Cost per turn, last 30 days' }) },
  { event: 'artifact', data: JSON.stringify({ url: 'data:text/plain,Mock%20artifact%20body', name: 'q3-summary.pdf' }) },
  finalEvent(mediaText, { latencyMs: 5470, costUsd: 0.0288, toolCallCount: 2 }),
];

// ── reply: a slash-command answer (plain text, no model turn) ────────────────

const replyFixture: Fixture = [
  { event: 'reply', data: 'pong — mock harness is alive (CCE_CHAT_MOCK=1)' },
  { event: 'done', data: '{}' },
];

// ── longstream: 200 cumulative chunks for scroll testing ─────────────────────

const longstreamFixture: Fixture = (() => {
  let acc = '# Long stream\n';
  const events: MockSseEvent[] = [];
  for (let i = 1; i <= 200; i++) {
    acc += `\nLine ${i}: the quick brown fox jumps over the lazy dog.`;
    events.push({ event: 'chunk', data: acc });
  }
  events.push(finalEvent(acc, { latencyMs: 14200, costUsd: 0.0733, toolCallCount: 0 }));
  return events;
})();

export const fixtures: Record<string, Fixture> = {
  default: defaultFixture,
  tools: toolsFixture,
  'error-mid': errorMidFixture,
  'error-partial': errorPartialFixture,
  media: mediaFixture,
  reply: replyFixture,
  longstream: longstreamFixture,
};
