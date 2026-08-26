// Shared chat data types, moved verbatim from web/src/pages/Chat.tsx (Phase 0
// of the chat UI port — zero behavior change). NOTE: this module is imported
// by tests under src/, so it enters the ROOT tsc program: keep it DOM-free and
// keep relative imports `.js`-suffixed (NodeNext).

export interface Agent { id: string; displayName: string; status: string }
// `error` marks an assistant turn the stream failed mid-flight. It renders in a
// red bubble (and as a " [error: ...]" suffix when text had already streamed)
// instead of a silent blank reply. `kb` carries knowledge-base confirmations
// ("Indexed report.pdf…") rendered as chips under the assistant bubble. `meta`
// is the run footer (model · latency · cost · tools) — parity with the
// Telegram/Slack footers, which surface the same numbers when enabled.
export interface TurnMeta { modelId: string; latencyMs: number; costUsd: number; toolCallCount: number }
// `tools` (additive, Phase 0) records the tool events observed during the turn
// ({label, step} as streamed); ToolCallsSection renders it as the per-turn tool
// timeline under the reply (Phase 3b). `stopped` (additive, Phase 3) marks a
// turn the reader cancelled with the composer's Stop control: the partial text
// is kept and committed, but there is no `meta`, because the run never reached
// its `final` event — so the footer says so instead of inventing numbers.
export interface Message { role: 'user' | 'assistant'; text: string; ts: number; error?: boolean; stopped?: boolean; kb?: string[]; images?: Array<{ url: string; caption: string }>; artifacts?: Array<{ url: string; name: string }>; meta?: TurnMeta; tools?: Array<{ label: string; step: number }> }
export interface Model { label: string; id: string; contextWindow: number; family: string; isDefault: boolean }

// One row of the conversation sidebar. Mirrors the shape /sessions already
// returns (same as Sessions.tsx) — this feature adds no new endpoint.
export interface Conversation {
  agentId: string;
  chatId: string;
  updatedAt: number;
  messageCount: number | null;
  firstMessage: string | null;
}
