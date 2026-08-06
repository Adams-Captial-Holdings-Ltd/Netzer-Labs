/**
 * Built-in tools available to every agent.
 *
 * These are deliberately tiny — the point is to prove the tool-use loop
 * works end-to-end. Real knowledge tools (s3_vectors_search,
 * dynamodb_query) land once the ingest pipeline is up.
 */

import { tools } from './registry.js';
import { listKnownAgents } from '../config/agent-loader.js';

// ── get_time ────────────────────────────────────────────────────────
tools.register('get_time', {
  spec: {
    toolSpec: {
      name: 'get_time',
      description:
        "Returns the current UTC date and time. Use when the user asks 'what time is it', 'what's today's date', or anything where the answer depends on the current moment.",
      inputSchema: {
        json: {
          type: 'object',
          properties: {
            timezone: {
              type: 'string',
              description:
                "Optional IANA timezone (e.g., 'America/New_York'). If omitted, UTC is returned.",
            },
          },
        },
      },
    },
  },
  invoke: async (args) => {
    const tz = (args.timezone as string | undefined) ?? 'UTC';
    try {
      const now = new Date();
      const formatted = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        dateStyle: 'full',
        timeStyle: 'long',
      }).format(now);
      return { text: `${formatted} (${tz}). ISO UTC: ${now.toISOString()}` };
    } catch {
      return {
        text: `Invalid timezone '${tz}'. UTC now: ${new Date().toISOString()}`,
      };
    }
  },
});

// ── list_agents ─────────────────────────────────────────────────────
tools.register('list_agents', {
  spec: {
    toolSpec: {
      name: 'list_agents',
      description:
        'Lists the agents available in this ClaudeClaw Enterprise deployment. Each agent has a different role and system prompt.',
      inputSchema: {
        json: { type: 'object', properties: {} },
      },
    },
  },
  invoke: async () => {
    const list = listKnownAgents();
    return {
      text:
        `Available agents: ${list.join(', ')}.\n` +
        'Talk to a specific one by mentioning it (e.g., "@ops what was last week\'s revenue") ' +
        'or with a slash prefix ("/research deep dive on X").',
    };
  },
});

// s3_vectors_search is now implemented in src/lib/tools/vector-tools.ts,
// which is side-effect imported from server.ts alongside this file.
