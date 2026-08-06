import { describe, it, expect } from 'vitest';
import { parseMentions, buildContextPrompt } from './orchestrator.js';
import type { Meeting, WarroomTurn } from './types.js';

const meeting = (title: string): Meeting => ({
  meetingId: 'm1',
  createdBy: 'dashboard',
  title,
  status: 'active',
  participants: ['main', 'research'],
  membershipVersion: 1,
  createdAt: '2026-06-08T00:00:00.000Z',
});

const turn = (speaker: string, type: WarroomTurn['type'], content: string, seq: number, agentId?: string): WarroomTurn => ({
  meetingId: 'm1',
  seq,
  speaker,
  type,
  content,
  ts: `2026-06-08T00:00:0${seq}.000Z`,
  ...(agentId ? { agentId } : {}),
});

describe('parseMentions (War Room @mention targeting)', () => {
  const room = ['main', 'ops', 'research'];

  it('returns [] when no agent is tagged (everyone answers)', () => {
    expect(parseMentions('what is the rollback plan?', room)).toEqual([]);
  });

  it('matches a single tagged participant', () => {
    expect(parseMentions('@ops what is the deploy plan?', room)).toEqual(['ops']);
  });

  it('matches multiple tags, returned in participant order', () => {
    expect(parseMentions('hey @research and @ops thoughts?', room)).toEqual(['ops', 'research']);
  });

  it('@all / @everyone / @room target the whole room', () => {
    expect(parseMentions('@everyone status check', room)).toEqual(room);
    expect(parseMentions('@all status', room)).toEqual(room);
    expect(parseMentions('@room ship it?', room)).toEqual(room);
  });

  it('ignores tags for agents that are not in the room', () => {
    expect(parseMentions('@billing where are you', room)).toEqual([]);
  });

  it('is case-insensitive', () => {
    expect(parseMentions('@OPS hi', room)).toEqual(['ops']);
  });

  it('does not match an @ glued to a word (e.g. an email address)', () => {
    expect(parseMentions('mail it to ops@example.com', room)).toEqual([]);
    expect(parseMentions('handle user@research', room)).toEqual([]);
  });

  it('is word-bounded so a longer id is not matched by a shorter tag', () => {
    expect(parseMentions('@research please', ['ops', 'research'])).toEqual(['research']);
  });

  it('does not over-match a hyphen-delimited prefix of another id', () => {
    const r = ['research', 'research-ops'];
    expect(parseMentions('@research-ops can you dig in?', r)).toEqual(['research-ops']);
    expect(parseMentions('@research can you dig in?', r)).toEqual(['research']);
  });

  it('does not treat @all-hands as @all', () => {
    expect(parseMentions('@all-hands meeting notes', room)).toEqual([]);
  });

  it('handles empty input', () => {
    expect(parseMentions('', room)).toEqual([]);
  });
});

// These lock the framing shape validated against the live Bedrock guardrail's
// PROMPT_ATTACK filter (see buildContextPrompt's header comment). The OLD
// "<title> — working session notes." header, above a multi-speaker bulleted
// transcript ending in an imperative, blocked every responder after the first.
// If any of these fail, re-validate candidate strings through ApplyGuardrail
// BEFORE changing the assertions — do not just edit them to match.
describe('buildContextPrompt (War Room guardrail-safe framing)', () => {
  const history: WarroomTurn[] = [
    turn('dashboard', 'user', '@main @research hi', 1),
    turn('main', 'agent', "Hey! Both @main and @research are here. What's up?", 2, 'main'),
  ];

  it('uses a plain "Topic:" header, never the "working session notes" pattern that trips PROMPT_ATTACK', () => {
    const prompt = buildContextPrompt(meeting('Launch room'), history, 'research', true);
    expect(prompt).toMatch(/^Topic: Launch room\n/);
    expect(prompt).not.toContain('working session notes');
  });

  it('still includes the transcript and the directed/undirected instruction', () => {
    const directed = buildContextPrompt(meeting('War Room'), history, 'research', true);
    expect(directed).toContain('- main: ');
    expect(directed).toContain('Answer the latest question in a few sentences.');

    const undirected = buildContextPrompt(meeting('War Room'), history, 'research', false);
    expect(undirected).toContain('Add your perspective in a few sentences');
  });

  it('falls back to "War Room" when the meeting has no title', () => {
    expect(buildContextPrompt(meeting(''), [], 'main', true)).toMatch(/^Topic: War Room\n/);
  });
});
