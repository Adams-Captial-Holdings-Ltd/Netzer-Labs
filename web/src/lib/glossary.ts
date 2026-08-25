/**
 * Plain-language glossary for the Netzar OS Enterprise dashboard.
 *
 * The owner of a deployment is not necessarily an ops engineer. This maps the
 * jargon that shows up across the dashboard (panic semantics, kill-switch
 * names, audit actions, identity formats) to one-sentence definitions a
 * non-technical operator can act on.
 *
 * Each entry is a `GlossaryEntry`:
 *   - `term`       the canonical key (matches the on-screen token where possible)
 *   - `label`      a human-friendly display name
 *   - `definition` plain-language explanation, no jargon, no acronyms unexpanded
 *
 * Keys are normalized on lookup (lower-cased, trimmed) so callers can pass the
 * raw on-screen string. Use `getDefinition(term)` to read a definition, or
 * `getEntry(term)` for the full record. Both return `undefined` for unknown
 * terms so callers can fall back to showing the raw value.
 */

export interface GlossaryEntry {
  /** Canonical lookup key (already normalized: lower-case, no surrounding space). */
  term: string;
  /** Friendly display name for the term. */
  label: string;
  /** One-sentence, plain-language definition for a non-technical owner. */
  definition: string;
}

/**
 * Normalize a term for lookup. Lower-cases and trims so `"Bedrock_Global"`,
 * `" bedrock_global "`, and `"bedrock_global"` all resolve to one entry.
 */
function normalize(term: string): string {
  return term.trim().toLowerCase();
}

const ENTRIES: GlossaryEntry[] = [
  // ── Core ops verbs / states ──────────────────────────────────────────────
  {
    term: 'trip',
    label: 'Trip',
    definition:
      'To turn a safety switch ON so it actively blocks the behavior it guards. A "tripped" switch is engaged and stopping something from happening.',
  },
  {
    term: 'engage',
    label: 'Engage',
    definition:
      'To activate a control. Engaging panic, for example, turns on every safety switch at once and halts all agent activity.',
  },
  {
    term: 'panic',
    label: 'Panic',
    definition:
      'The emergency all-stop. Engaging panic saves a snapshot of the current switch settings, then trips every kill switch so the system stops doing work until you release it.',
  },
  {
    term: 'snapshot',
    label: 'Snapshot',
    definition:
      'A saved copy of every safety switch setting taken at the moment panic was engaged, so the exact prior state can be restored afterward.',
  },
  {
    term: 'generation',
    label: 'Generation',
    definition:
      'A version counter for the panic state. It goes up by one each time panic is engaged, and it stops an old, stale restore from undoing a newer panic.',
  },
  {
    term: 'restore',
    label: 'Restore',
    definition:
      'To release panic by putting every safety switch back to the settings captured in the snapshot taken when panic was engaged.',
  },
  {
    term: 'force release',
    label: 'Force release',
    definition:
      'To clear panic by turning every safety switch OFF and ignoring the snapshot. Use only if the snapshot is known bad; any switch that should stay on must be re-armed by hand.',
  },
  {
    term: 'kill switch',
    label: 'Kill switch',
    definition:
      'A single on/off toggle that disables one risky behavior across the whole system within seconds. ON means the behavior is blocked.',
  },
  {
    term: 'disarm',
    label: 'Disarm',
    definition:
      'To turn a safety switch OFF so the behavior it guards is allowed to run again. The opposite of tripping a switch.',
  },
  {
    term: 'warn',
    label: 'Warn',
    definition:
      'A non-blocking heads-up. The system flags something worth attention but still lets the action proceed.',
  },
  {
    term: 'block',
    label: 'Block',
    definition:
      'A hard stop. The system refuses the action outright instead of just flagging it.',
  },
  {
    term: 'fail open',
    label: 'Fail open',
    definition:
      'If a check cannot be completed (for example a database is briefly unreachable), the system errs toward letting work continue rather than halting everything.',
  },
  {
    term: 'fail closed',
    label: 'Fail closed',
    definition:
      'If a check cannot be completed, the system errs toward blocking the action. Used for the most sensitive gates where unsure means no.',
  },
  {
    term: 'canary',
    label: 'Canary',
    definition:
      'A small automated probe that runs the system end to end on a schedule to confirm it still works. A failed canary is an early warning of an outage.',
  },

  // ── Kill-switch names ─────────────────────────────────────────────────────
  {
    term: 'bedrock_global',
    label: 'Bedrock global',
    definition:
      'The master AI off switch. When ON, the system makes no AI model calls at all, so every agent stops responding.',
  },
  {
    term: 'tool_use',
    label: 'Tool use',
    definition:
      'Blocks agents from using their tools (sending email, searching the web, writing files, and so on). The agent can still chat, but it cannot take actions.',
  },
  {
    term: 'memory_writes',
    label: 'Memory writes',
    definition:
      'Stops agents from saving new long-term memories. Existing memories still work; nothing new gets written.',
  },
  {
    term: 'cost_cap_per_day',
    label: 'Daily cost cap',
    definition:
      'Blocks AI calls once the day’s spend passes your configured dollar limit, so a runaway loop cannot rack up an unbounded bill.',
  },
  {
    term: 'email_send_disabled',
    label: 'Email sending disabled',
    definition:
      'Stops agents from sending any outbound email while it is ON.',
  },
  {
    term: 'telegram_posting',
    label: 'Telegram posting',
    definition:
      'Stops agents from sending any outbound Telegram messages while it is ON.',
  },
  {
    term: 'slack_posting',
    label: 'Slack posting',
    definition:
      'Stops agents from sending any outbound Slack messages while it is ON.',
  },
  {
    term: 'audit_log_disabled',
    label: 'Audit log disabled',
    definition:
      'Stops the system from recording audit-log entries. Leave this OFF in normal operation so you keep a record of what happened.',
  },
  {
    term: 'slack_signature_check_disabled',
    label: 'Slack signature check disabled',
    definition:
      'Skips the security check that confirms inbound Slack requests are genuinely from Slack. Break-glass only; it weakens protection against spoofed requests.',
  },
  {
    term: 'telegram_signature_check_disabled',
    label: 'Telegram signature check disabled',
    definition:
      'Skips the security check that confirms inbound Telegram requests are genuine. Break-glass only; it weakens protection against spoofed requests.',
  },
  {
    term: 'memory_ingest_disabled',
    label: 'Memory ingest disabled',
    definition:
      'Skips the background step that distills a finished conversation into saved memory.',
  },
  {
    term: 'tool_dispatch_disabled',
    label: 'Tool dispatch disabled',
    definition:
      'A more granular version of the tool-use switch that blocks tools from actually running.',
  },
  {
    term: 'guardrail_disabled',
    label: 'Guardrail disabled',
    definition:
      'Bypasses the built-in content safety guardrail on AI calls. Leave OFF unless you have a specific reason.',
  },
  {
    term: 'dashboard_read_disabled',
    label: 'Dashboard read disabled',
    definition:
      'Makes the dashboard’s read endpoints return an error, effectively taking the dashboard data offline.',
  },
  {
    term: 'media_upload_disabled',
    label: 'Media upload disabled',
    definition:
      'Refuses to download media (images, files) sent into the system from chat surfaces.',
  },
  {
    term: 'image_gen_disabled',
    label: 'Image generation disabled',
    definition:
      'Stops agents from generating images while it is ON.',
  },
  {
    term: 'tts_disabled',
    label: 'Text-to-speech disabled',
    definition:
      'Stops agents from turning text into spoken audio while it is ON.',
  },
  {
    term: 'web_search_disabled',
    label: 'Web search disabled',
    definition:
      'Stops agents from searching the web while it is ON.',
  },
  {
    term: 'document_gen_disabled',
    label: 'Document generation disabled',
    definition:
      'Stops agents from generating documents (PDFs, slides, spreadsheets) while it is ON.',
  },
  {
    term: 'pii_redaction_enabled',
    label: 'PII redaction enabled',
    definition:
      'When ON, the system scrubs personal information from content before it is stored or sent.',
  },
  {
    term: 'memory_consolidation_disabled',
    label: 'Memory consolidation disabled',
    definition:
      'Skips the nightly job that merges and tidies up saved memories.',
  },
  {
    term: 'memory_context_v2_disabled',
    label: 'Memory context v2 disabled',
    definition:
      'Falls back to the older way of loading memory into a conversation instead of the newer one.',
  },
  {
    term: 'exfil_guard_disabled',
    label: 'Data-leak guard disabled',
    definition:
      'Turns off the scan that watches for sensitive data leaving the system. Leave OFF in normal operation.',
  },
  {
    term: 'exfil_custom_patterns_disabled',
    label: 'Custom data-leak patterns disabled',
    definition:
      'Ignores any custom rules you added to the data-leak scanner, leaving only the built-in rules active.',
  },
  {
    term: 'warroom_disabled',
    label: 'War room disabled',
    definition:
      'Rejects all war-room (live incident workspace) requests while it is ON.',
  },
  {
    term: 'warroom_router_disabled',
    label: 'War room router disabled',
    definition:
      'Skips the automatic step that reads a war-room message and decides what it is asking for.',
  },
  {
    term: 'warroom_intervention_disabled',
    label: 'War room intervention disabled',
    definition:
      'Turns off the war-room safeguard that can pause or override an in-progress action.',
  },
  {
    term: 'hooks_disabled',
    label: 'Hooks disabled',
    definition:
      'Skips all custom automation hooks that would normally run around agent activity.',
  },
  {
    term: 'skills_disabled',
    label: 'Skills disabled',
    definition:
      'Stops agents from invoking any installed skills (packaged capabilities) while it is ON.',
  },
  {
    term: 'extension_deployer_disabled',
    label: 'Extension deployer disabled',
    definition:
      'Rejects requests to deploy new extensions while it is ON.',
  },
  {
    term: 'chaos_bedrock_throttle_opus',
    label: 'Chaos: throttle Opus',
    definition:
      'A testing switch that fakes a rate-limit on the Opus model to rehearse how the system handles being throttled. Leave OFF in production.',
  },
  {
    term: 'chaos_bedrock_throttle_sonnet',
    label: 'Chaos: throttle Sonnet',
    definition:
      'A testing switch that fakes a rate-limit on the Sonnet model to rehearse failure handling. Leave OFF in production.',
  },
  {
    term: 'chaos_bedrock_throttle_haiku',
    label: 'Chaos: throttle Haiku',
    definition:
      'A testing switch that fakes a rate-limit on the Haiku model to rehearse failure handling. Leave OFF in production.',
  },
  {
    term: 'chaos_secrets_throttle',
    label: 'Chaos: throttle secrets',
    definition:
      'A testing switch that fakes a rate-limit when reading stored secrets, to rehearse failure handling. Leave OFF in production.',
  },
  {
    term: 'sessions_frozen',
    label: 'Sessions frozen',
    definition:
      'Stops the system from picking up any new agent turns. In-flight work finishes, but nothing new starts.',
  },
  {
    term: 'jarvis_disabled',
    label: 'Jarvis disabled',
    definition:
      'The emergency off switch for the Jarvis voice co-pilot. When ON it denies everyone and tears down any live voice sessions.',
  },
  {
    term: 'jarvis_voice_disabled',
    label: 'Jarvis voice disabled',
    definition:
      'Drops Jarvis down to text only by turning off its audio, while leaving the assistant otherwise usable.',
  },
  {
    term: 'jarvis_canary_mode',
    label: 'Jarvis canary mode',
    definition:
      'A staged-rollout mode that lets only approved testers reach Jarvis while everyone else is held back.',
  },

  // ── Audit actions ─────────────────────────────────────────────────────────
  {
    term: 'canary_fired',
    label: 'Canary fired',
    definition:
      'An audit entry recording that the scheduled health probe ran. It confirms the end-to-end check executed.',
  },
  {
    term: 'agent_turn',
    label: 'Agent turn',
    definition:
      'An audit entry for one complete request-and-response cycle handled by an agent, including which model ran and what it cost.',
  },
  {
    term: 'agent_turn_error',
    label: 'Agent turn error',
    definition:
      'An audit entry for an agent turn that failed before it could finish.',
  },
  {
    term: 'cost_cap_updated',
    label: 'Cost cap updated',
    definition:
      'An audit entry recording that someone changed the daily spending limit, including the old and new values.',
  },
  {
    term: 'iam_apply',
    label: 'IAM apply',
    definition:
      'An audit entry recording that an AWS permissions (IAM) change was applied to your account through the dashboard.',
  },
  {
    term: 'kill_switch_set',
    label: 'Kill switch set',
    definition:
      'An audit entry recording that someone turned a safety switch on or off, and the reason they gave.',
  },
  {
    term: 'kill_switch_blocked',
    label: 'Kill switch blocked',
    definition:
      'An audit entry recording that an action was stopped because a safety switch was tripped at the time.',
  },
  {
    term: 'tool_invoke',
    label: 'Tool invoke',
    definition:
      'An audit entry recording that an agent used one of its tools, such as sending an email or searching the web.',
  },
  {
    term: 'memory_write',
    label: 'Memory write',
    definition:
      'An audit entry recording that an agent saved a new long-term memory.',
  },
  {
    term: 'data_purged',
    label: 'Data purged',
    definition:
      'An audit entry recording that stored data was permanently deleted, usually in response to a privacy or retention request.',
  },
  {
    term: 'agent_file',
    label: 'Agent file edit',
    definition:
      'An audit entry recording that an agent’s configuration file was changed.',
  },
  {
    term: 'exfil_blocked',
    label: 'Data leak blocked',
    definition:
      'An audit entry recording that the data-leak guard stopped sensitive content from leaving the system.',
  },

  // ── Identity / session formats ────────────────────────────────────────────
  {
    term: 'dashboard:anonymous',
    label: 'Dashboard (anonymous)',
    definition:
      'An action taken from the dashboard by a session that was not tied to a named operator. It means "someone using the dashboard," with no identified person attached.',
  },
  {
    term: 'dashboard:',
    label: 'Dashboard identity',
    definition:
      'An identifier that starts with "dashboard:" marks an action taken through the web dashboard. The part after the colon identifies the specific session.',
  },
  {
    term: 'slack:',
    label: 'Slack identity',
    definition:
      'An identifier that starts with "slack:" marks an action that came in through Slack. The part after the colon is the Slack conversation.',
  },
  {
    term: 'telegram:',
    label: 'Telegram identity',
    definition:
      'An identifier made of digits, or starting with "telegram:", marks an action that came in through Telegram. The value identifies the Telegram chat.',
  },
  {
    term: 'surface',
    label: 'Surface',
    definition:
      'Where an interaction came from, such as the dashboard, Slack, or Telegram.',
  },
  {
    term: 'operator',
    label: 'Operator',
    definition:
      'The named person who performed an action in the dashboard, as opposed to an anonymous or automated session.',
  },

  // ── Knowledge / retrieval jargon ──────────────────────────────────────────
  {
    term: 'rag',
    label: 'RAG',
    definition:
      'Retrieval-augmented generation. Before the AI answers, the system looks up the most relevant snippets from your uploaded documents and hands them to the model, so answers are grounded in your own content instead of guesswork.',
  },
  {
    term: 'chunks',
    label: 'Chunks',
    definition:
      'Each uploaded document is split into small passages, called chunks, so the system can search and retrieve just the relevant parts rather than a whole file at once.',
  },
  {
    term: 'cosine',
    label: 'Cosine similarity',
    definition:
      'The math used to score how closely a passage matches the question. A higher score means a closer match; it is what ranks the results you see in a retrieval test.',
  },
  {
    term: 'scope',
    label: 'Scope',
    definition:
      'Which knowledge collection a document belongs to and which agents can read it. An agent searches its own scope plus the shared scope, so scope decides who sees what.',
  },

  // ── Cost / spend jargon ───────────────────────────────────────────────────
  {
    term: 'cap',
    label: 'Cap',
    definition:
      'A spending limit. The daily cap hard-stops AI spend once the day passes the dollar amount you set, so a runaway loop cannot rack up an unbounded bill.',
  },

  // ── Security posture jargon ───────────────────────────────────────────────
  {
    term: 'pitr',
    label: 'PITR',
    definition:
      'Point-in-time recovery. A backup setting that lets the database be restored to any moment in the recent past, so an accidental delete or corruption can be rolled back.',
  },
  {
    term: 'waf',
    label: 'WAF',
    definition:
      'Web application firewall. A filter in front of the dashboard that blocks common web attacks and abusive traffic before they reach the application.',
  },
  {
    term: 'cmk',
    label: 'CMK',
    definition:
      'Customer-managed key. An encryption key that you control (rather than the cloud provider managing it for you), used to encrypt stored data so you can rotate or revoke it on your terms.',
  },
];

/** Lookup map keyed by normalized term for O(1) reads. */
const BY_TERM: Record<string, GlossaryEntry> = Object.fromEntries(
  ENTRIES.map((e) => [e.term, e]),
);

/** All glossary entries, in display order. */
export const glossary: readonly GlossaryEntry[] = ENTRIES;

/** Lookup the full entry for a term. Returns undefined for unknown terms. */
export function getEntry(term: string | null | undefined): GlossaryEntry | undefined {
  if (!term) return undefined;
  return BY_TERM[normalize(term)];
}

/**
 * Lookup just the plain-language definition for a term. Returns undefined for
 * unknown terms so callers can fall back to showing the raw value.
 */
export function getDefinition(term: string | null | undefined): string | undefined {
  return getEntry(term)?.definition;
}

/** True when the glossary has a definition for the given term. */
export function hasDefinition(term: string | null | undefined): boolean {
  return getEntry(term) !== undefined;
}

/**
 * Plain-English labels for the snake_case / lower-case status enums that show up
 * on the dashboard's status badges. A leader should read "In Progress", not
 * "in_progress".
 *
 * Covers the mission statuses (open | in_progress | blocked | in_review | done
 * | cancelled) plus the other status tokens seen on the covered tabs. Keys are
 * normalized on lookup, so callers can pass the raw on-screen value.
 *
 * THE SIX MISSION LABELS ARE A THIRD COPY, and they carry the pointer both
 * other copies carry: `COLUMNS` in `web/src/pages/Missions.tsx` (the kanban
 * column headers) and `MISSION_STATUS_LABEL` in `src/lib/missions/format.ts`
 * (what every chat surface says). Change one, change all three in the same PR —
 * the way `humanize.ts` and `Chat.tsx` point at each other for the turn footer.
 * This copy is the one that had drifted: it spelled `in_progress` "In progress"
 * while the column header beside it said "In Progress", and `Missions.tsx`
 * renders BOTH on one screen (the card badge and the detail drawer call
 * `statusLabel()`, the column header reads `COLUMNS`). Same board, same status,
 * two spellings, and the chat copy's own header asserted this function agreed
 * with it.
 */
const STATUS_LABELS: Record<string, string> = {
  // Mission statuses, in the board's lane order (the repository owner's
  // decision: the story of a task). `blocked` and `in_review`
  // arrived with Phase 9, when the projection stopped collapsing them into
  // `open` and `in_progress`. Nothing in web/ type-checks this list against
  // the server's MissionStatus - a source scan in `src/lib/missions/
  // format.test.ts` does, and it fails if this copy is the one left behind.
  open: 'Open',
  in_progress: 'In Progress',
  blocked: 'Blocked',
  in_review: 'In Review',
  done: 'Done',
  cancelled: 'Cancelled',
  // Generic states that appear on status-style badges elsewhere.
  pending: 'Pending',
  active: 'Active',
  inactive: 'Inactive',
  failed: 'Failed',
  error: 'Error',
  ok: 'OK',
};

/**
 * Turn a raw status enum into a Title Case, plain-English label. Falls back to
 * a sensible humanization (snake_case -> "Snake case") for any status not in
 * the map, so an unmapped value still reads cleanly instead of leaking the
 * underscores. Returns '' for null/undefined.
 */
export function statusLabel(status: string | null | undefined): string {
  if (!status) return '';
  const key = normalize(status);
  const mapped = STATUS_LABELS[key];
  if (mapped) return mapped;
  // Generic fallback: split on underscores/dashes, capitalize the first word.
  const words = key.replace(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}
