/**
 * `create_mission`'s toolSpec is MODEL-FACING CONTRACT and must stay
 * byte-identical across the Paperclip migration. Until now nothing pinned it —
 * `grep -rl create_mission src tests web` found only the tool itself, the War
 * Room policy, the orchestrator and one comment, so byte-identity was enforced
 * by review alone. Phase 8 adds a sibling tools module and a new verb beside
 * these, which is exactly the change that quietly reflows a schema.
 *
 * This pins the SERIALISED spec, not the source text: key order included,
 * because `JSON.stringify` walks insertion order and a reordered `properties`
 * block is a different prompt.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../config/env.js', () => ({ loadEnv: () => ({}) }));
vi.mock('../state/mission-provenance-repo.js', () => ({
  getMissionProvenance: vi.fn(() => Promise.resolve(new Map())),
  putMissionProvenance: vi.fn(() => Promise.resolve()),
  listProvenanceForChat: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../state/inter-agent-tasks-repo.js', () => ({ sendInterAgent: vi.fn() }));
vi.mock('../config/agent-loader.js', () => ({
  listKnownAgents: vi.fn(() => ['main', 'research']),
  loadAgent: vi.fn(),
}));
vi.mock('../bedrock/client.js', () => ({ converseTurn: vi.fn() }));

import './mission-tools.js'; // side-effect registration
import { tools } from './registry.js';

function specOf(name: string): unknown {
  const found = tools.listFor('research').find((t) => t.toolSpec?.name === name);
  expect(found, `${name} is not registered`).toBeDefined();
  return JSON.parse(JSON.stringify(found));
}

describe('create_mission', () => {
  it('is byte-identical to the shipped contract, key order included', () => {
    expect(JSON.stringify(specOf('create_mission'))).toBe(
      JSON.stringify({
        toolSpec: {
          name: 'create_mission',
          description:
            'Create a tracked mission task. If `owner` is omitted, Haiku 4.5 picks the best agent based on the title and body. Use this when the user asks you to "open a ticket", "track this work", "follow up on X next week", or any persistent multi-step item that should outlive this conversation.',
          inputSchema: {
            json: {
              type: 'object',
              required: ['title', 'body'],
              properties: {
                title: { type: 'string', description: 'Short headline (under 80 chars).' },
                body: {
                  type: 'string',
                  description: 'Full task description with acceptance criteria.',
                },
                owner: {
                  type: 'string',
                  description: 'Optional explicit owner agent id. Skip to let Haiku auto-assign.',
                },
                priority: {
                  type: 'integer',
                  minimum: 0,
                  maximum: 100,
                  description: '0-100, default 50.',
                },
                due_at: { type: 'string', description: 'Optional ISO 8601 deadline.' },
              },
            },
          },
        },
      }),
    );
  });
});

describe('the mission verb budget', () => {
  it('stays at four: TOOL_TURN_LIMIT is 8 rounds and 31 built-ins already compete', async () => {
    // The regression this guards is verb creep. Every added tool is charged
    // against the same 8-round budget as web_search, the MCP set and the rest,
    // so a phase that ships four mission verbs where three were enough has
    // spent budget it cannot get back. Phase 8 adds exactly ONE.
    const { readFile } = await import('node:fs/promises');
    const missions = await readFile('src/lib/tools/mission-tools.ts', 'utf8');
    const paperclip = await readFile('src/lib/tools/paperclip-tools.ts', 'utf8');
    const names = [...missions.matchAll(/tools\.register\('([^']+)'/g)].map((m) => m[1]);
    const added = [...paperclip.matchAll(/tools\.register\('([^']+)'/g)].map((m) => m[1]);
    expect(names).toEqual(['create_mission', 'list_missions', 'update_mission']);
    expect(added.sort()).toEqual(['paperclip_add_comment', 'paperclip_create_subtask']);
  });
});
