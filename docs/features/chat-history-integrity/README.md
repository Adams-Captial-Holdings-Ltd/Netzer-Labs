---
feature: chat-history-integrity
document_role: index
status: current
observed_at: 2026-09-19
as_of_commit: e036f7a18854aa53abed12fe227f503d816fda12
implemented_by:
  - src/lib/state/sessions-repo.ts
  - src/agent/agent-loop.ts
  - src/lib/documents/pdf.ts
  - src/adapters/dashboard/handler.ts
tested_by:
  - src/lib/state/sessions-repo.persistence.test.ts
  - src/agent/agent-loop.history.test.ts
  - src/adapters/dashboard/warroom-transcript.test.ts
  - src/agent/agent-loop.max-tokens.test.ts
  - src/lib/state/sessions-repo.byte-budget.test.ts
---

# Chat history integrity

## 1. Start Here

A chat must never be able to kill itself permanently. This folder covers the
invariants that keep a stored transcript replayable to Bedrock, and the two
bugs that have broken them so far.

Bedrock's Converse API rejects a request outright — not the offending message,
the **whole request** — when the transcript contains a content block it will
not accept. Because every turn replays the full history, one bad stored turn
does not fail once: it fails every later turn in that chat, forever, until the
history is repaired or the chat is abandoned.

Two triggers have produced such a turn:

| Trigger | Bad turn | Guard |
|---|---|---|
| Bedrock guardrail intervened | The canned block notice, persisted as an assistant turn, re-tripped the guardrail every turn | `stripBlockedTurns` (`src/agent/agent-loop.ts`) |
| Reply truncated at `max_tokens` | An **empty** assistant turn, which Bedrock rejects as `messages: text content blocks must be non-empty` | `repairEmptyTurns` (`src/lib/state/sessions-repo.ts`) |

The second is the one this folder was opened for, and it is documented below.

## 2. Verified behavior

### 2.1 `repairEmptyTurns` — empty turns cannot reach Bedrock

`getSession` in [`src/lib/state/sessions-repo.ts`](../../../src/lib/state/sessions-repo.ts)
passes every stored transcript through `repairEmptyTurns` before returning it.
A turn whose text is empty, whitespace-only, or absent gets
`NO_RESPONSE_NOTICE` substituted for its text.

Two properties of that placement are deliberate and load-bearing:

- **It repairs on read, not on write.** Every path that replays a stored chat
  transcript to Bedrock as conversation turns reads it through `getSession`, so
  one guard covers all of them: the dashboard, Slack and Telegram adapters, the
  two scheduled-task runners and the Paperclip dispatch worker each load the
  session with `getSession` and pass its turns to the agent loop as `history`.
  It also means chats poisoned *before* this fix recover on their own, with no
  migration.

  Jarvis is not one of these paths. It replays its own turns from
  `src/lib/state/jarvis-memory-repo.ts`, whose `appendTurn` refuses empty text
  on write, so an empty Jarvis turn is never stored. The dashboard TLDR bar
  replays no transcript: it summarizes the tab data the browser posts.
- **It replaces the text rather than dropping the turn.** Bedrock also requires
  roles to alternate. Removing a lone empty assistant turn would leave two user
  turns adjacent, trading one rejection for another.

### 2.2 `truncatedNotice` — the turn that produced nothing says so

The non-tool return path in [`src/agent/agent-loop.ts`](../../../src/agent/agent-loop.ts)
can no longer return empty text. When the stop reason is `max_tokens` it
returns a message telling the person their reply was cut off and to ask for
something smaller; otherwise it falls back to `NO_RESPONSE_NOTICE`.

This closes the hole at its source, while `repairEmptyTurns` remains the
backstop for anything already stored or written by a path not yet audited.

### 2.3 `TURN_MAX_TOKENS` — documents fit in a reply again

Every model call in a turn carried a hard-coded `maxTokens: 1024`. That is not
enough to emit a document: `generate_document` requires the entire spec inline
as tool-call JSON, so any real report ran past the ceiling and came back
`stopReason: max_tokens` with no text and no usable tool call.

The ceiling is resolved per turn from runtime-config `agent/max_output_tokens`,
with `TURN_MAX_TOKENS` as the default (`8192`) and a 1024-32768 clamp. The
admin-only `/config` write changes it without a deploy, and the resolved value
is applied at all three model calls: the initial streamed call, each tool-loop
round, and the post-loop synthesis call.

The initial call matters and was missed on the first attempt. It passes its
input straight to `converseStreamTurnWithFallback`, which without an explicit
`maxTokens` falls through to `?? 1024` in
[`src/lib/bedrock/client.ts`](../../../src/lib/bedrock/client.ts) — and for a
turn that never reaches tool use, that is the only call there is. On
2026-08-24, raising only the tool loop left production still returning
`outputTokens: 1024` after deploying. `src/agent/agent-loop.max-tokens.test.ts`
pins the initial call specifically, and was verified to fail when the fix is
reverted.

Spend remains bounded by the daily cost cap, which is the control that actually
stops runaway cost.

A larger ceiling makes every stored reply larger, so the stored window is bounded
by bytes as well as by count. `trimTurnsToBudget`, called from `appendTurns`,
keeps it at or under `MAX_TURN_WINDOW_BYTES` (300,000 bytes, text plus 64 per
turn) whatever the ceiling, which leaves the session item under DynamoDB's 400KB
limit. It drops the oldest exchanges first and cuts only at a user turn, so a
stored history never starts with a reply, and the kept window may be empty.
Dropped turns still reach memory ingest.

**This does not make documents unbounded.** At 8192 tokens, after JSON
structural overhead, a document is roughly 4,500–5,000 words — about 10–12
pages. Anything larger still truncates. It now truncates *cleanly*, leaving the
chat alive and telling the person to ask for a smaller piece, but an RFP-scale
document needs an incremental tool, not a higher ceiling.

### 2.5 Corrupt-but-successful builds now fail cleanly

An adversarial pass over the builders found four cases where a build returned
bytes, `isError` was never set, S3 accepted them, and the person received a
presigned URL to a **broken file**. That is worse than a refusal, and it is
precisely what the isolation bar exists to prevent — a clean tool error was
always the required outcome. All four were confirmed by measurement before
being fixed, and each now throws.

| Case | What it produced | Now |
|---|---|---|
| Any codepoint outside WinAnsi in a **PDF** — Greek, Cyrillic, CJK, emoji, even a check mark | A structurally perfect PDF that opens anywhere and displays garbage | `assertPdfRenderable` throws and points at DOCX, which handles the full range |
| C0 control characters in a **DOCX** | Correct PK magic, all 18 OPC parts, and a `word/document.xml` that is not well-formed XML | Stripped in `cellText`, matching what exceljs already did for XLSX — the two builders had disagreed on the same input |
| A cell over 32,767 characters in an **XLSX** | A file real Excel refuses to open | `MAX_CELL_LEN` rejects it; verified at the exact boundary |
| `rows` emitted as objects rather than arrays | Every row silently discarded, and a valid but completely **empty** workbook reported as a success | Throws, rather than `continue` |

Object and array cells are also rejected instead of being coerced to the
literal text `"[object Object]"` or `"1,2"`.

The PDF limitation is worth stating plainly: `src/lib/documents/pdf.ts` uses
pdfkit's built-in Helvetica, a Type1 font declared `/Encoding
/WinAnsiEncoding`. Latin-1 plus the WinAnsi punctuation block renders; nothing
else does. The real fix is embedding a Unicode TTF, which means shipping a font
binary — a deliberate decision, not something to fold into a bug fix. Until
then, DOCX is the answer for non-Latin content, and the error says so.

The War Room transcript export is the one caller that must not be refused:
its text is whatever the agents said, which nobody controls. So
`GET /api/warroom-transcripts/:id` (`src/adapters/dashboard/handler.ts`)
passes the title, the participants line and every turn through
`toPdfSafeText`, which shares `renderable` with `assertPdfRenderable` and
writes `?` for anything outside WinAnsi. A build that still throws returns
`422 {error: 'pdf_render_failed'}` rather than a 500. Before this, the route
returned 200 with unrenderable text written as garbage (`Ship it Ø=Þ€ done '`),
and a status-only test cannot see that: `warroom-transcript.test.ts` pins the
`?` substitution. Observed 2026-09-18 on `fix/backmerge-production-hotfixes`
(`6d43213`); it reached `development` with PR #176 (`264d024`, 2026-09-19).

## 3. Why all three document formats failed together

This is worth stating plainly, because it misled the original investigation.

PDF, DOCX and XLSX appeared to fail as a group, which pointed at something
shared — the container, or the delivery path. It was neither. The shared thing
is that **every format makes the model emit one large inline spec**, and that
is what trips the output ceiling. The three builders
(`src/lib/documents/{pdf,docx,xlsx}.ts`) were never implicated, and
`generate_document`'s own error handling was never at fault: the tool never
executed at all.

## 3a. What the history actually shows

This is recorded because it corrected the premise of the investigation.

CloudWatch metrics outlive log retention. As of 2026-08-24, over **450 days**, the entire life of
the metric, `generate_document` was invoked **5 times**, all by agent `main`,
with **zero errors**:

| Date | Calls | What it was |
|---|---|---|
| 2026-08-12 | 1 | "PGN Test Workbook" |
| 2026-08-15 | 1 | "PGN Consulting - Sample Report" |
| 2026-08-24 | 3 | Including the first PDF ever generated in production |

`maxTokens: 1024` dates to `355c397`, the initial release, and never held
another value. **There was no regression.** Two toy spreadsheets fit under the
ceiling and made the feature look shipped; every real document since exceeded
it, truncated mid-tool-call, and destroyed its own conversation before the tool
could run.

Zero errors across 450 days is not a health signal here. It is the signature of
a feature that was never exercised, because the failure killed the chat before
it could reach the tool's error path.

### 2.4 `MAX_TOTAL_CELLS` — a build cannot kill the process

The per-dimension bounds in `src/lib/documents/types.ts` do not bound their
product, and there was no column bound at all, so `MAX_SHEETS x MAX_SHEET_ROWS
x 20 columns` passed every check and then killed the process.

Measured on Node v24 at a production-equivalent heap: **4,000,000 cells OOMs**,
and **2,000,000 cells peaks at 1,870 MB RSS** against a 4 GB task shared with
two sidecars. An OOM is a SIGKILL, not a catchable error — the tool's own
try/catch cannot turn it into a tool error, and the whole chat process goes
with it. That is precisely the outcome the isolation bar forbids.

`MAX_TOTAL_CELLS` (200,000) bounds the whole spec, tables and sheets alike,
checked as each sheet or table is accepted. Verified under a 1,592 MB heap
ceiling that the unguarded build did not survive: the same spec now throws in
6 ms at 106 MB with `spec exceeds 200,000 total cells ... Split it into several
smaller documents.`

**Nothing a model can currently emit comes close.** `TURN_MAX_TOKENS` (8192)
caps a tool-call spec near 24 KB, which measures at roughly 160 MB. This bound
exists so that raising the token ceiling later — the obvious next step for
larger documents — cannot quietly turn a document request into a process kill.
The configurable maximum allows a spec about four times larger; that case is
unmeasured, and `MAX_TOTAL_CELLS` remains the bound regardless.

## 4. What is NOT covered here

- **`generate_document` itself.** Its kill switch, cost-cap re-check and S3
  handling are unchanged since this folder opened on 2026-08-24, and were not
  defective. Its spec validation did change: sections 2.4 and 2.5 cover that.
- **PDF and DOCX in production.** As of 2026-08-24, neither format has ever
  been generated in production — 90 days of logs (the full retention window)
  contain exactly two `generate_document` invocations, both `xlsx`, both
  successful. Those two code paths remain unproven outside unit tests.
- **Tool selection.** Whether the model reliably *chooses* `generate_document`
  when asked for a document is a separate open question. See the
  [HANDOFF](HANDOFF.md).

## 4a. Checking a branch for these fixes: by content, never by ancestry

Cherry-picked commits never become ancestors. After the back-merge lands,
`git merge-base --is-ancestor` and `git cherry` still report these fixes as
missing. Check by content instead. On the tree in question:

- `git grep -n TOOL_LOOP_MAX_TOKENS -- src infra` prints nothing and exits 1.
  Keep the path scope: docs mention the old name even on production;
- `src/agent/agent-loop.ts` has either `maxTokens: TURN_MAX_TOKENS` five times,
  or, once WI-0.2 lands, `maxTokens: turnMaxTokens` five times fed by one
  `await resolveTurnMaxTokens()` in `runAdmittedTurn`, covering all three model
  calls in `runAgentTurn`;
- `infra/lib/constants.ts` has `claude-haiku-4-5-20251001-v1:0`;
- `src/lib/documents/pdf.ts` exports `assertPdfRenderable` and `toPdfSafeText`;
- exactly one `function repairEmptyTurns` exists (`src/lib/state/sessions-repo.ts`);
- these five test files pass: `src/agent/agent-loop.max-tokens.test.ts`,
  `src/agent/agent-loop.history.test.ts`,
  `src/lib/state/sessions-repo.persistence.test.ts`,
  `src/lib/documents/builders.test.ts` and
  `src/adapters/dashboard/warroom-transcript.test.ts`.

On `development` at `9e8e42b`, every code check fails except the single
`repairEmptyTurns` definition. On `fix/backmerge-production-hotfixes` at
`6d43213`, every check passes (both observed 2026-09-18).

## 5. Authorities

Source and tests are declared in this document's frontmatter and are the
ultimate truth for present behavior. Session history lives in
[`handoffs/`](handoffs/); current volatile state lives in [`HANDOFF.md`](HANDOFF.md).

The rules this folder follows are specified in exactly one place, the
[feature knowledge framework](../README.md). Branch and environment reality is
owned by [`development.md`](../../../development.md).
