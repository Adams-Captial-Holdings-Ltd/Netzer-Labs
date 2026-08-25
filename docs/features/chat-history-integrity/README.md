---
feature: chat-history-integrity
document_role: index
status: current
observed_at: 2026-08-24
as_of_commit: f64d1e04b2d85853752e393b310ef243460958dd
implemented_by:
  - src/lib/state/sessions-repo.ts
  - src/agent/agent-loop.ts
tested_by:
  - src/lib/state/sessions-repo.persistence.test.ts
  - src/agent/agent-loop.history.test.ts
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

- **It repairs on read, not on write.** Every consumer that converts stored
  turns into Bedrock messages — the agent loop, the dashboard TLDR path, Jarvis
  — reads through `getSession`, so one guard covers all of them. It also means
  chats poisoned *before* this fix recover on their own, with no migration.
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

The ceiling is now the named constant `TURN_MAX_TOKENS`, set to `8192`, and it
is applied at **all four** model call sites — the initial streamed call and each
tool-loop round.

The initial call matters and was missed on the first attempt. It passes its
input straight to `converseStreamTurnWithFallback`, which without an explicit
`maxTokens` falls through to `?? 1024` in
[`src/lib/bedrock/client.ts`](../../../src/lib/bedrock/client.ts) — and for a
turn that never reaches tool use, that is the only call there is. Raising only
the tool loop left production still returning `outputTokens: 1024` after
deploying. `src/agent/agent-loop.max-tokens.test.ts` pins the initial call
specifically, and was verified to fail when the fix is reverted.

Spend remains bounded by the daily cost cap, which is the control that actually
stops runaway cost.

**This does not make documents unbounded.** At 8192 tokens, after JSON
structural overhead, a document is roughly 4,500–5,000 words — about 10–12
pages. Anything larger still truncates. It now truncates *cleanly*, leaving the
chat alive and telling the person to ask for a smaller piece, but an RFP-scale
document needs an incremental tool, not a higher ceiling.

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

CloudWatch metrics outlive log retention. Over **450 days**, the entire life of
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

## 4. What is NOT covered here

- **`generate_document` itself.** Its kill switch, cost-cap re-check, spec
  validation and S3 handling are unchanged and were not defective.
- **PDF and DOCX in production.** As of `observed_at`, neither format has ever
  been generated in production — 90 days of logs (the full retention window)
  contain exactly two `generate_document` invocations, both `xlsx`, both
  successful. Those two code paths remain unproven outside unit tests.
- **Tool selection.** Whether the model reliably *chooses* `generate_document`
  when asked for a document is a separate open question. See the
  [HANDOFF](HANDOFF.md).

## 5. Authorities

Source and tests are declared in this document's frontmatter and are the
ultimate truth for present behavior. Session history lives in
[`handoffs/`](handoffs/); current volatile state lives in [`HANDOFF.md`](HANDOFF.md).

The rules this folder follows are specified in exactly one place, the
[feature knowledge framework](../README.md). Branch and environment reality is
owned by [`development.md`](../../../development.md).
