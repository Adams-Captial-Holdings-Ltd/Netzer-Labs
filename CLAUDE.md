# Netzar OS Enterprise — working conventions

Project instructions for anyone (human or agent) making changes in this repo.
The README explains *what the system is*; this file is *how we work in it*.

## Chat surface parity (Telegram ↔ Slack ↔ dashboard)

**When you change the chat UX on one surface, mirror it on the others.** The
agent loop (`src/agent/agent-loop.ts`) is surface-agnostic; each surface adapter
renders the same turn. A UX improvement made in only one adapter silently
degrades the others.

Surfaces and their handlers:
- Telegram — `src/adapters/telegram/handler.ts`
- Slack — `src/adapters/slack/handler.ts` (note: TWO send paths, the main bot
  and per-agent apps — update both)
- Dashboard chat — the SPA Chat tab + `/api/test-turn[/stream]`

What "mirror it" covers: streaming/placeholder behavior, live tool-call status
(`onToolEvent`), footers, error rendering, voice/attachment handling, retry and
throttle logic. If a surface genuinely can't support a feature, say so in the PR
and leave a code comment at the skipped call site rather than silently omitting.

> Reference example: live tool status (`onToolEvent`) is implemented on all
> three surfaces and is a good template for the parity pattern — Telegram and
> Slack edit their placeholder message; dashboard chat emits a `tool` SSE event
> that the Chat tab renders. Match this shape when adding the next cross-surface
> feature.

## Agent tool servers (MCP)

- MCP server config lives in the `runtime-config` table (`category: mcp`,
  `key: servers`), not in code or CDK. Edits propagate in seconds; no redeploy.
- AgentCore gateways and their IAM grants are created out-of-band (CLI), NOT in
  CDK, so arming a tool never risks unrelated stack drift. `cdk diff` will not
  know about them. See `docs/mcp/README.md`.
- New tools are namespaced `mcp__<server>__<tool>` and ride the `tool_use` kill
  switch like built-ins.

## Deploy

- `npm run deploy:cloud` is image-only (no CDK) — safe for app changes, won't
  touch infra like the daily cost cap. Use it for normal feature work.
- A full `cdk deploy` can shift env-backed tunables (e.g. the cost cap); don't
  run it to ship app code.
- Because it is image-only, `deploy:cloud` returns **before** deploy phase a —
  so it rebuilds the orchestrator image and nothing else. A change under
  `vendor/paperclip` (the Paperclip work-engine image, ADR 0010) needs a full
  `npm run deploy`, or a CI deploy at a tier/environment that provisions Paperclip.
- Always run the FULL `npm test` before pushing, not a scoped run.

## Agent prompts

- Per-agent system prompts live in the S3 config bucket at
  `agents/<id>/CLAUDE.md` (5-minute cache), NOT in this repo or DDB. Editing one
  is an S3 upload, no deploy.

## Feature docs and session handoffs

- Feature docs live in `docs/features/<slug>/`; the spec is
  [`docs/features/README.md`](docs/features/README.md).
- **Every session writes its own handoff**: copy
  `docs/features/HANDOFF-TEMPLATE.md` to
  `docs/features/<slug>/handoffs/YYYY-MM-DD-<session-slug>.md`, keep its
  numbered sections 1–9, and carry section 5 forward verbatim.
- That is the only template. Ignore any `HANDOFF-TEMPLATE.md` under
  `.worktrees/` or a nested checkout — those are other branches.
