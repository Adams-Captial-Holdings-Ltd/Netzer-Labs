// Scripted SSE fixtures for the dev-only mock stream (see
// mock-stream-plugin.ts). Pure data, no I/O: each fixture is the ordered list
// of SSE events the mock server plays back. Chunk events carry CUMULATIVE
// text (the real backend replaces, never appends) — see
// web/src/lib/chat/stream.ts. Select one from the Chat tab by sending
// "/fixture <name>"; anything else plays "default".

export interface MockSseEvent {
  event: string;
  data: string;
  /**
   * Milliseconds to wait BEFORE writing this event, overriding the plugin's
   * default 30-80ms jitter. Tool dispatch on the real backend takes hundreds of
   * milliseconds to seconds per call, so a fixture that fires five `tool`
   * events 40ms apart is not a slow-motion version of production — it is a
   * FASTER one, and it makes the live tool-status line physically unobservable
   * (it exists for one frame, which is how a capture run ends up with no
   * evidence that the line is implemented at all). Fixtures that are judged on
   * a live state set this explicitly.
   */
  delayMs?: number;
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
function cumulativeChunks(full: string, count: number, delayMs?: number): MockSseEvent[] {
  const events: MockSseEvent[] = [];
  for (let i = 1; i <= count; i++) {
    const end = Math.ceil((full.length * i) / count);
    events.push({ event: 'chunk', data: full.slice(0, end), ...(delayMs ? { delayMs } : {}) });
  }
  return events;
}

/** Slice a RANGE of `full` into cumulative chunk events (from → to characters). */
function cumulativeRange(full: string, from: number, to: number, steps: number, delayMs: number): MockSseEvent[] {
  const events: MockSseEvent[] = [];
  for (let i = 1; i <= steps; i++) {
    const end = Math.round(from + ((to - from) * i) / steps);
    events.push({ event: 'chunk', data: full.slice(0, end), delayMs });
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

// ── code: the Phase 1 (CHATUI-001) evidence fixture ──────────────────────────
// Deliberately built so ONE assistant turn shows every code deliverable at
// once, which is what the screenshot bar is compared on:
//   (c) fenced blocks with a language tag → header strip, label, copy button,
//       hairline border, corner radius — and a SECOND fence in another
//       language so the label is visibly data, not a constant;
//   (c) one line far wider than the bubble → the horizontal scrollbar must
//       appear INSIDE the <pre>, never on the page;
//   (d) keywords / strings / numbers / comments / class names in the same
//       block, so all six palette groups are on screen together;
//   (e) inline `code` chips in running prose, to read against the block.

const codeText = `## Wiring the turn stream

The client never appends: every \`chunk\` event carries the **cumulative** text, so the reducer assigns rather than concatenates. Call \`clearApiCache()\` after the turn, or the sidebar serves a stale \`/sessions\` read for up to 60s.

\`\`\`ts
// Cumulative chunks: assign, never append (see lib/chat/stream.ts).
export class TurnStream {
  private buffer = '';
  async consume(res: Response, onText: (text: string) => void): Promise<void> {
    const reader = res.body!.getReader(), decoder = new TextDecoder();
    for (let frames = 0; frames < 4096; frames++) {
      const { done, value } = await reader.read();
      if (done) break;
      this.buffer = decoder.decode(value, { stream: true }); // this comment is long on purpose, so the code body has to scroll horizontally inside its own <pre> instead of widening the message bubble or the page
      onText(this.buffer);
    }
  }
}
\`\`\`

The same contract on the wire, as a curl you can paste:

\`\`\`bash
curl -N -X POST "$ORIGIN/api/test-turn/stream" \\
  -H "Authorization: Bearer $DASHBOARD_TOKEN" \\
  -d '{"agentId":"main","text":"status?","chatId":"dashboard:1756180000000"}'
\`\`\`

> Inline chips like \`streamTurn()\`, \`modelOverride\` and \`dashboard:\` should read as chips, not as miniature panels.`;

const codeFixture: Fixture = [
  ...cumulativeChunks(codeText, 24),
  finalEvent(codeText, { latencyMs: 3180, costUsd: 0.0164, toolCallCount: 0 }),
];

// ── tools: the Phase 3b (CHATUI-003) evidence fixture ───────────────────────
// This is the ONLY fixture that drives the two deliverables Phase 3b is judged
// on, so it is built to make both of them observable rather than merely
// present in the DOM for one frame:
//
//   (1) the LIVE tool-status line (StreamingRow → ToolStatusLine), which is the
//       dashboard's half of the cross-surface `onToolEvent` contract in
//       CLAUDE.md — Telegram and Slack edit the same string into their
//       placeholder message;
//   (2) the SETTLED "Used N tools" collapsible (ToolCallsSection), built from
//       the `{label, step}` rows streamTurn accumulated during the turn.
//
// Five calls, five DISTINCT glyph categories (web / knowledge / connector /
// code / document as classified by toolKind()), so the stacked-icon cap and
// its `+N` disc are both exercised, and so is the deduplicated name summary
// ("web search, Knowledge: search, Slack: search public, +2").
//
// Two separate status windows on purpose. The first three calls run before any
// text, which is the common shape; the last two land AFTER prose is already on
// screen, which is the frame worth capturing — reply text, a live status line
// and the caret in one shot, proving the status line is not merely a
// pre-answer placeholder. `delayMs` holds each window ~1s, which is what real
// tool dispatch costs anyway.

const toolsText = `Here is what the failed staging rollout came down to.

**Root cause.** The task definition still pointed at image tag \`sha-4f2a1c\` while the ECR push had already moved to \`sha-9b3e07\`, so every new task started, failed its health check, and rolled straight back.

**Fix.** \`scripts/deploy.ts\` now reads the digest it just pushed instead of resolving the branch tag a second time. I have written the incident note up as a document and posted the summary in \`#deploys\`.`;

// Where the first burst of prose stops — mid-sentence in the root-cause
// paragraph, so the caret is trailing running text rather than sitting after a
// tidy full stop when the second tool window opens over it.
const TOOLS_TEXT_BREAK = 210;

const toolsFixture: Fixture = [
  { event: 'tool', data: JSON.stringify({ label: 'web search', step: 1 }), delayMs: 260 },
  { event: 'tool', data: JSON.stringify({ label: 'Knowledge: search', step: 2 }), delayMs: 1000 },
  { event: 'tool', data: JSON.stringify({ label: 'Slack: search public', step: 3 }), delayMs: 1000 },
  // Text resumes: streamTurn's chunk branch clears the status line.
  ...cumulativeRange(toolsText, 0, TOOLS_TEXT_BREAK, 12, 55),
  // …and a mid-answer tool call brings it back, over prose that is already on
  // screen. This is the captured frame.
  { event: 'tool', data: JSON.stringify({ label: 'code interpreter', step: 4 }), delayMs: 900 },
  { event: 'tool', data: JSON.stringify({ label: 'document generator', step: 5 }), delayMs: 1400 },
  // The tail's FIRST chunk is what closes the second status window (the chunk
  // branch clears the line), so it waits too — otherwise step 5 would flash for
  // 55ms and the window would only ever be step 4's.
  ...cumulativeRange(toolsText, TOOLS_TEXT_BREAK, toolsText.length, 16, 55).map((ev, i) =>
    i === 0 ? { ...ev, delayMs: 1400 } : ev,
  ),
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
  code: codeFixture,
  tools: toolsFixture,
  'error-mid': errorMidFixture,
  'error-partial': errorPartialFixture,
  media: mediaFixture,
  reply: replyFixture,
  longstream: longstreamFixture,
};
