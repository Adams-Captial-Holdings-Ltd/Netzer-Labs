/**
 * Agent picker. Rules in priority order:
 *   1. Explicit slash command prefix (/ops, /research, /main)
 *   2. @-mention of a known agent id (e.g., "hey @ops, ...")
 *   3. Thread / session continuation (sticky)
 *   4. Default to 'main'
 *
 * Haiku classifier fallback (when no rules match) lands later.
 */

import { listKnownAgents } from '../lib/config/agent-loader.js';

export interface PickerResult {
  agentId: string;
  /** Cleaned text with the routing marker stripped. */
  cleanText: string;
  reason: 'mention' | 'slash' | 'sticky' | 'default';
}

const SYSTEM_AGENT_IDS = new Set(['main', 'ops', 'research']);

function knownAgentSet(): Set<string> {
  return new Set([...listKnownAgents(), ...SYSTEM_AGENT_IDS]);
}

/**
 * Determine which agent should respond. `stickyAgentId` is what the
 * previous turn in this chat used (passed in by the caller from the
 * sessions table).
 */
export function pickAgent(text: string, stickyAgentId?: string): PickerResult {
  const trimmed = text.trim();
  const agents = knownAgentSet();

  // Rule 1: slash agent (/ops something)
  const slashMatch = trimmed.match(/^\/(\w+)(?:\s+(.*))?$/s);
  if (slashMatch) {
    const cmd = slashMatch[1].toLowerCase();
    const rest = slashMatch[2] ?? '';
    if (agents.has(cmd)) {
      return { agentId: cmd, cleanText: rest.trim(), reason: 'slash' };
    }
  }

  // Rule 2: @mention anywhere in the message
  const mentionRegex = /@(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = mentionRegex.exec(trimmed)) !== null) {
    const candidate = m[1].toLowerCase();
    if (agents.has(candidate)) {
      const cleanText = trimmed.replace(m[0], '').replace(/\s+/g, ' ').trim();
      return { agentId: candidate, cleanText, reason: 'mention' };
    }
  }

  // Rule 3: thread / session sticky
  if (stickyAgentId && agents.has(stickyAgentId)) {
    return { agentId: stickyAgentId, cleanText: trimmed, reason: 'sticky' };
  }

  // Rule 4: default
  return { agentId: 'main', cleanText: trimmed, reason: 'default' };
}
