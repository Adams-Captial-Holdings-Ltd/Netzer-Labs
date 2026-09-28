// Shared chat data types, moved verbatim from web/src/pages/Chat.tsx (Phase 0
// of the chat UI port — zero behavior change). NOTE: this module is imported
// by tests under src/, so it enters the ROOT tsc program: keep it DOM-free and
// keep relative imports `.js`-suffixed (NodeNext).

// `description` is additive (Phase 5, CHATUI-005) and OPTIONAL: /agents has
// always returned it — handler.ts builds it from the agent's DDB row or from
// its system prompt — this type simply never declared it. Declaring it changes
// no behaviour: nothing reads it except the agent picker, which renders it as
// the row's descriptor and matches it when searching.
export interface Agent { id: string; displayName: string; status: string; description?: string }
// `error` marks an assistant turn the stream failed mid-flight; `failure`
// carries its alert separately from any partial reply in `text`.
// `kb` carries knowledge-base confirmations
// ("Indexed report.pdf…") rendered as chips under the assistant bubble. `meta`
// is the run footer (model · latency · cost · tools) — parity with the
// Telegram/Slack footers, which surface the same numbers when enabled.
export interface TurnMeta { modelId: string; latencyMs: number; costUsd: number; toolCallCount: number }
export interface ToolCall {
  label: string;
  step: number;
  toolUseId?: string;
  input?: string;
  inputTruncated?: boolean;
  output?: string;
  isError?: boolean;
  truncated?: boolean;
}
// `tools` (additive, Phase 0) records the tool events observed during the turn
// (live inputs and stored results); ToolCallsSection renders the per-turn
// tool timeline under the reply. `stopped` (additive, Phase 3) marks a
// turn the reader cancelled with the composer's Stop control: the partial text
// is kept and committed, but there is no `meta`, because the run never reached
// its `final` event — so the footer says so instead of inventing numbers.
// `notSaved` (P2) marks a reply that arrived but the server could not store
// (`done: not_saved`): it is on screen now and gone after a reload, and the
// reply says so.
export interface MessageAttachment { id: string; name: string; type: string; size: number }
export interface ArtifactRef { artifactId: string; version: number; fileName: string; contentType: string; createdAt: string }
export interface Message { role: 'user' | 'assistant'; text: string; ts: number; requestId?: string; attachments?: MessageAttachment[]; error?: boolean; failure?: string; stopped?: boolean; isReply?: boolean; notSaved?: true; kb?: string[]; images?: Array<{ url: string; caption: string }>; artifacts?: Array<{ url: string; name: string }>; artifactRefs?: ArtifactRef[]; meta?: TurnMeta; tools?: ToolCall[] }
export interface Model { label: string; id: string; contextWindow: number; family: string; isDefault: boolean }

// One row of the conversation sidebar. Mirrors the shape /sessions already
// returns (same as Sessions.tsx) — this feature adds no new endpoint.
export interface Conversation {
  agentId: string;
  chatId: string;
  updatedAt: number;
  messageCount: number | null;
  firstMessage: string | null;
  title?: string | null;
  pinned?: boolean;
}
