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
  /**
   * Did the person ADDRESS this agent, or was the agent's name merely
   * somewhere in the words?
   *
   * `reason` alone cannot tell those apart. Rule 1 is anchored at `^`, so a
   * slash pick is always an addressee. Rule 2 is not: it matches `@agent`
   * ANYWHERE, which is right for "hey @ops, can you look" and wrong for
   * `/mission new Ask @main to review the ACL`, where `@main` is a word inside
   * the payload of a command the user typed at some other bot.
   *
   * That distinction did not matter while every command's arguments were
   * enumerated tokens ("all", "done abc12345"). `/mission new <free prose>` is
   * the first command whose argument is whatever the user felt like writing, so
   * an `@agent` inside it is now ordinary content — and treating it as routing
   * put the mission on the wrong board and deleted the word from the title.
   *
   * True only when the routing marker LEADS the message, which is what "I am
   * talking to you" looks like. Callers that route a COMMAND should scope on
   * this; `agentId`/`reason` still answer "who should talk" for ordinary chat,
   * unchanged.
   */
  addressed: boolean;
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
      return { agentId: cmd, cleanText: rest.trim(), reason: 'slash', addressed: true };
    }
  }

  // Rule 2: @mention anywhere in the message
  const mentionRegex = /@(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = mentionRegex.exec(trimmed)) !== null) {
    const candidate = m[1].toLowerCase();
    if (agents.has(candidate)) {
      const cleanText = trimmed.replace(m[0], '').replace(/\s+/g, ' ').trim();
      // `m.index === 0` is the whole distinction: the mention LEADS the
      // message (an addressee) rather than sitting inside it (content).
      return { agentId: candidate, cleanText, reason: 'mention', addressed: m.index === 0 };
    }
  }

  // Rule 3: thread / session sticky
  if (stickyAgentId && agents.has(stickyAgentId)) {
    return { agentId: stickyAgentId, cleanText: trimmed, reason: 'sticky', addressed: false };
  }

  // Rule 4: default
  return { agentId: 'main', cleanText: trimmed, reason: 'default', addressed: false };
}
