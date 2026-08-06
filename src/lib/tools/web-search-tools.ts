/**
 * web_search tool. Adapter-backed; picks the first vendor with a
 * configured API key (Tavily → Brave → Exa → Serper).
 *
 * The fetch happens from the vendor's network, not ours, so this tool
 * does not create an SSRF surface inside our VPC.
 */

import type { Tool as BedrockTool } from '@aws-sdk/client-bedrock-runtime';
import { tools } from './registry.js';
import { registerAddon, registerIfConfigured } from '../addons/registry.js';
import { isKillSwitchActive } from '../state/kill-switches-repo.js';
import { writeAudit } from '../audit/audit-writer.js';
import { logger } from '../../observability/logger.js';
import { listSearchAdapters, pickSearchAdapter } from '../search/dispatch.js';
import { detectPii, redactPiiUnconditional } from '../pii/redact.js';
import { resolveWebSearchPiiPolicy } from '../pii/web-search-policy.js';

function spec(name: string, description: string, schema: unknown): BedrockTool {
  return {
    toolSpec: {
      name,
      description,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inputSchema: { json: schema as any },
    },
  };
}

// Register one umbrella add-on, plus one per vendor so the SPA shows
// which ones could be plugged in.
registerAddon({
  id: 'web_search',
  title: 'Web search',
  category: 'tool',
  description: 'Live internet search via Tavily / Brave / Exa / Serper. Whichever vendor key is configured wins.',
  required: [
    { description: 'At least one of TAVILY_API_KEY, BRAVE_SEARCH_API_KEY, EXA_API_KEY, SERPER_API_KEY' },
  ],
  envVarAnyOf: [
    'TAVILY_API_KEY',
    'BRAVE_SEARCH_API_KEY',
    'EXA_API_KEY',
    'SERPER_API_KEY',
  ],
  killSwitch: 'web_search_disabled',
  defaultOn: false,
});

const hasAnyAdapter = listSearchAdapters().some((a) => a.configured);

registerIfConfigured(
  {
    id: 'web_search_registration',
    title: 'Web search (active)',
    category: 'tool',
    description: 'web_search tool registration check',
    required: hasAnyAdapter
      ? [{ description: 'at-least-one search vendor configured' }]
      : [{ envVar: 'TAVILY_API_KEY', description: 'preferred default' }],
    killSwitch: 'web_search_disabled',
    defaultOn: false,
  },
  () => {
    tools.register('web_search', {
      spec: spec(
        'web_search',
        'Live web search. Returns top-K results (title, URL, snippet). Use when the user asks about current events, news, or anything that may have changed since your training cutoff. Cite the URLs you used in your reply.',
        {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string', description: 'Search query.' },
            top_k: {
              type: 'integer',
              minimum: 1,
              maximum: 10,
              description: 'Max results. Defaults to 5.',
            },
            recency_days: {
              type: 'integer',
              minimum: 1,
              maximum: 365,
              description: 'Optional recency bias in days.',
            },
          },
        },
      ),
      async invoke(args, ctx) {
        const killed = await isKillSwitchActive('web_search_disabled');
        if (killed.active) {
          return {
            text: `Web search disabled: ${killed.reason ?? 'no reason given'}`,
            isError: true,
          };
        }
        const adapter = pickSearchAdapter();
        if (!adapter) {
          return {
            text: 'No search adapter configured. Set TAVILY_API_KEY (free tier), BRAVE_SEARCH_API_KEY, EXA_API_KEY, or SERPER_API_KEY.',
            isError: true,
          };
        }
        const rawQuery = String(args.query ?? '').trim();
        if (!rawQuery) return { text: 'query is required', isError: true };

        // B3: outbound PII gate. The query about to leave our network
        // goes to a third-party vendor (Tavily/Brave/Exa/Serper).
        // CCE_WEB_SEARCH_PII_POLICY = refuse | redact (default) | allow.
        const policy = resolveWebSearchPiiPolicy();
        const detected = detectPii(rawQuery);
        let query = rawQuery;
        if (detected.found) {
          if (policy === 'refuse') {
            logger.warn(
              {
                agentId: ctx.agentId,
                chatId: ctx.chatId,
                vendor: adapter.name,
                types: detected.types,
              },
              'web search refused: outbound PII detected',
            );
            void writeAudit({
              action: 'tool_invoke',
              agentId: ctx.agentId,
              chatId: ctx.chatId,
              toolName: 'web_search',
              detail: {
                vendor: adapter.name,
                refused: true,
                piiTypes: detected.types,
                queryRedacted: redactPiiUnconditional(rawQuery).slice(0, 200),
              },
              result: 'error',
            });
            return {
              text: `Refused: query contains PII (${detected.types.join(', ')}). Rephrase without personal data, or set CCE_WEB_SEARCH_PII_POLICY=redact|allow to change policy.`,
              isError: true,
            };
          }
          if (policy === 'redact') {
            query = redactPiiUnconditional(rawQuery);
            logger.warn(
              {
                agentId: ctx.agentId,
                chatId: ctx.chatId,
                vendor: adapter.name,
                types: detected.types,
              },
              'web search query redacted before vendor call',
            );
          }
          // policy === 'allow' -> fall through with raw query
        }

        const topK = Number.isFinite(args.top_k) ? Number(args.top_k) : 5;
        const recency = Number.isFinite(args.recency_days)
          ? Number(args.recency_days)
          : undefined;
        try {
          const hits = await adapter.search({
            query,
            topK,
            ...(recency ? { recencyDays: recency } : {}),
          });
          if (hits.length === 0) {
            return { text: `No results (vendor: ${adapter.name}).` };
          }
          const lines = hits.map(
            (h, i) =>
              `[${i + 1}] ${h.title}\n${h.url}\n${h.snippet.slice(0, 300)}`,
          );
          logger.info(
            {
              agentId: ctx.agentId,
              chatId: ctx.chatId,
              vendor: adapter.name,
              hits: hits.length,
            },
            'web search complete',
          );
          void writeAudit({
            action: 'tool_invoke',
            agentId: ctx.agentId,
            chatId: ctx.chatId,
            toolName: 'web_search',
            detail: { vendor: adapter.name, hits: hits.length, query: query.slice(0, 200) },
            result: 'ok',
          });
          return {
            text: `${hits.length} results via ${adapter.name}:\n\n${lines.join('\n\n')}`,
          };
        } catch (err) {
          return {
            text: `Search failed (${adapter.name}): ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    });
  },
);
