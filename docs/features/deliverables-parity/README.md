---
feature: deliverables-parity
document_role: index
status: current
observed_at: 2026-09-13
as_of_commit: de244e6387efdba177d550d1fb82a6d60291309e
implemented_by:
  - src/agent/agent-loop.ts
  - src/lib/bedrock/client.ts
  - src/lib/tools/document-generation-tools.ts
  - src/lib/documents/types.ts
---

# Deliverables parity

## 1. Start Here

This folder holds a measurement campaign, not a product feature. It asks why
Netzar OS (Claude on Amazon Bedrock) produces weaker PDF, DOCX, XLSX and PPTX
deliverables than the Claude app, handles uploads badly, cannot edit files, and
reports "context limits". It answers with measurements rather than prompt
tuning, and nothing in it changes product behaviour.

Read in this order:

1. [HANDOFF](HANDOFF.md): where the work is and the next action.
2. The newest session log it indexes: what the last session did and what bit it.
3. [2026-09-10 diagnosis](handoffs/2026-09-10-deliverables-gap-diagnosis.md):
   the root causes, the experiment design and its acceptance criteria.
4. This page: what the measured code verifiably does today.

Source code is the ultimate truth for present behaviour. Production and
development diverge on exactly the code this campaign measures, so every claim
below names the tree it was read from.

## 2. What deliverables parity does today

**The campaign.** Round 1, work item W1: read-only production telemetry (Step 0),
then an output-budget ablation (E1) that replays production's own request
against Bedrock at three output budgets. The harness lives in
`scripts/diagnostics/deliverables/` and `npm test` never collects it.

**The product behaviour under measurement**, verified from source on 2026-09-13:

- Production (`de244e6`) sends `maxTokens: 8192` on every model call in a turn.
  Development (`271339b`) sends no ceiling on the first call, which falls to
  1024, and 8192 on its tool-loop rounds.
- A document leaves the model only as one `generate_document` tool call whose
  JSON carries the whole spec, so the spec must fit in a single call's output.
- When the first, streamed call stops on `tool_use`, its output is not used: the
  tool loop re-sends the same messages non-streaming and the model generates the
  tool call a second time.
- `generate_document` produces PDF, DOCX or XLSX from a flat spec: a title with
  sections of heading, body and a string table, or sheets of rows. There is no
  PPTX path, no code execution and no way to edit an existing file.
- Production's PDF builder refuses text outside the WinAnsi character set.
  Development lacks that check (`d828124` is production-only); the commit that
  added it measured such PDFs rendering as garbled symbols.

**What it is not yet.** No runtime evidence exists: Step 0 needs an AWS sign-in
and approval. The replay is specified but not implemented, and has never run.
There is no judge result, and nothing has been fixed.

## 3. Current status and current source commit

Source evidence only; no deployment evidence.

| Tree | Commit | Checked |
|---|---|---|
| `origin/production` | `de244e6387efdba177d550d1fb82a6d60291309e`, merge of #170, 2026-09-09 | 2026-09-13, fetched from GitHub |
| `origin/development` | `271339bc8b2feea85e6c31b115fdd34e757a72e2`, merge of #165, 2026-09-07 | 2026-09-13, fetched from GitHub |

The four production-only hotfixes, `1abba67`, `d828124`, `1124118` and
`8c14b3f`, were still absent from `origin/development` on 2026-09-13. That
`de244e6` is what production runs was reported by the approved plan and was not
re-verified here. The harness state is in the [HANDOFF](HANDOFF.md).

## 4. Source of truth

| Concern | Authority | Use it for |
|---|---|---|
| Present runtime behaviour | [`agent-loop.ts`](../../../src/agent/agent-loop.ts), [`client.ts`](../../../src/lib/bedrock/client.ts), [`document-generation-tools.ts`](../../../src/lib/tools/document-generation-tools.ts), [`types.ts`](../../../src/lib/documents/types.ts), read from the tree being measured | What the code does |
| Experiment design and acceptance criteria | [2026-09-10 diagnosis](handoffs/2026-09-10-deliverables-gap-diagnosis.md), back-filled from the approved round-1 plan | Root causes, E1 profiles, H1–H5 |
| Harness contract | `scripts/diagnostics/deliverables/*.diag.ts` | What the capture and the replay must do |
| Volatile state | [HANDOFF](HANDOFF.md) | Branch, commands, next action |

## 5. Implementation map

| Area | Verified location | Present behaviour |
|---|---|---|
| Output ceiling, production | `src/agent/agent-loop.ts:79`, passed at `:819`, `:965-967`, `:1101-1103` | 8192 on the first call and on every tool-loop round |
| Output ceiling, development | `src/agent/agent-loop.ts:73`; `src/lib/bedrock/client.ts:273` | The first call falls to `maxTokens ?? 1024`; tool-loop rounds send 8192 |
| First call | `src/lib/bedrock/client.ts`, `buildParams` and `converseStreamTurn` | ConverseStream; system text then a cache point; tool specs then a cache point; temperature 0.7; a guardrail only when `BEDROCK_GUARDRAIL_ID` is set |
| Fallback chain | `src/lib/bedrock/client.ts`, `buildFallbackChain` | Opus, Sonnet, Haiku from the environment; only throttling or unavailability moves down it |
| Tool registration | Production `src/server.ts:46-59`; development `:47-61` | Side-effect imports: 14 modules on production, 15 on development (adds `paperclip-tools`). Document generation, email, Nova Canvas and web search register only when their environment is set |
| Document tool | Production `src/lib/tools/document-generation-tools.ts:129-143` | pdf, docx or xlsx; validates, builds, stores under `generations/` in `RAW_BUCKET`, returns a 24-hour presigned URL |
| Builders | `src/lib/documents/types.ts` (`validateDocumentSpec`, `validateSpreadsheetSpec`), `pdf.ts`, `docx.ts`, `xlsx.ts` | Production `pdf.ts:63` rejects non-WinAnsi text; development has no such check |
| Agent prompt | `src/lib/config/agent-loader.ts:34` | `agents/<id>/CLAUDE.md` from the config bucket when present, otherwise a built-in prompt defaulting to "one or two short paragraphs" |

## 6. Current business/state rules

- Spend is bounded by the daily cost cap, not by the output ceiling (the comment
  above production `agent-loop.ts:79`).
- A deliverable's entire spec is emitted inside one tool call. Nothing splits a
  spec across calls.
- A first streamed call that stops on `tool_use` is paid for and then generated
  again without streaming.
- The tool loop stops after 8 rounds (`TOOL_TURN_LIMIT`); if the model produced
  no text by then, one final call without tools asks it to answer in words.
- Only `pdf`, `docx` and `xlsx` are accepted formats.

## 7. Known runtime risks and approved next work

| Risk | Evidence | Approved next work |
|---|---|---|
| RC1′: 8192 still binds in production, and truncation can be silent | Source; H1 and H4 unmeasured | W1, E1 (approved 2026-09-10) |
| RC1: the 1024 first-call ceiling explains the failures before 2026-08-24 and still applies on development | `1abba67` commit message; source | W1, E1 profile S. The back-merge runs in a separate session |
| RC2: no execution environment or render loop; flat builders; no PPTX | Source | Not approved; E3 proposed |
| RC3: uploads lose the instruction on Telegram and both Slack paths; XLSX never parsed; PDFs sent without citations | [2026-09-10 diagnosis](handoffs/2026-09-10-deliverables-gap-diagnosis.md), from source | Not approved |
| RC4: documents forgotten between turns | [2026-09-10 diagnosis](handoffs/2026-09-10-deliverables-gap-diagnosis.md), from source | Not approved |
| RC5: Sonnet 4.6, no thinking, temperature 0.7, brevity default | Source | Not approved; E2 proposed |
| RC6 and RC7: a guardrail or data-loss scan changes output; fallback pins chats to a weaker model | Unmeasured | W1, Step 0 |
| Capture fidelity: production agents carry their own `CLAUDE.md` (all seven did on 2026-08-26), so a capture without `DIAG_AGENT_PROMPT_FILE` uses the wrong system prompt | [knowledge-scope-fanout HANDOFF](../knowledge-scope-fanout/HANDOFF.md) | W1, Step 0 fetches the real prompt before any replay |

## 8. Exact focused and full validation commands

The harness, from the repository root:

```bash
npx vitest run --config scripts/diagnostics/deliverables/vitest.diag.config.ts
```

Captures go to `DIAG_OUT_DIR`, by default `netzer-deliverables-diag` under the
operating system's temp directory; the harness refuses a directory inside the
repository. Run it on production's tree for production numbers; the HANDOFF
names the local branch that carries that tree.

Documentation gates and the full suite:

```bash
node scripts/ci/feature-knowledge.mjs
node scripts/ci/docs-links.mjs
npm run typecheck
npm test
```

`npm test` at `271339b` is red on five known files before any change here; the
baseline is in the newest session log.

## 9. Related documents

- [Operational HANDOFF](HANDOFF.md)
- [Feature knowledge framework](../README.md)
- [Documentation index](../../README.md)
- [Repository development guidance](../../../development.md)
- [Chat history integrity](../chat-history-integrity/README.md): the 2026-08-24 truncation incident and the empty-turn repair
- [Knowledge scope fan-out HANDOFF](../knowledge-scope-fanout/HANDOFF.md): production agent prompts as measured on 2026-08-26
