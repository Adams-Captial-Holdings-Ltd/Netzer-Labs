/**
 * Vector-search tools. Replaces the s3_vectors_search stub.
 *
 * Two tools:
 *   s3_vectors_search   — semantic retrieval, returns top passages with
 *                          citations and similarity scores.
 *   ingest_document     — admin tool exposed for the model to file new
 *                          notes the user dictates ("remember this whole
 *                          spec"). Most ingest still happens via the
 *                          dashboard /api/ingest endpoint.
 */

import type { Tool as BedrockTool } from '@aws-sdk/client-bedrock-runtime';

/** NZR-5: chat_* is the per-chat namespace (NZR-6); no agent knowledgeScope may sit in it. */
function isReservedScope(scope: string): boolean {
  return normalizeScope(scope).startsWith(RESERVED_SCOPE_PREFIX);
}
import { tools } from './registry.js';
import { embedOne } from '../vectors/embedder.js';
import { search, type QueryHit } from '../vectors/store.js';
import { logger } from '../../observability/logger.js';
import { ingestDocument } from '../vectors/ingest.js';
import { normalizeScope, RESERVED_SCOPE_PREFIX } from '../vectors/scope-access.js';
import {
  loadAgent,
  DEFAULT_KNOWLEDGE_SCOPE,
  SHARED_KNOWLEDGE_SCOPE,
} from '../config/agent-loader.js';

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

// Replace the stubbed entry with the real implementation. The registry
// lets us re-register; the most recent call wins.
tools.register('s3_vectors_search', {
  readOnly: true,
  spec: spec(
    's3_vectors_search',
    'Semantic search across documents the user has ingested. Returns top-K passages ordered by cosine similarity, each with a citation (doc title, source, chunk index). Use when the user asks about something specific they may have uploaded earlier, or when their question references a previously-shared document.',
    {
      type: 'object',
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description: 'The natural-language query to search for.',
        },
        top_k: {
          type: 'integer',
          minimum: 1,
          maximum: 20,
          description: 'Maximum number of passages to return. Defaults to 5.',
        },
        scope: {
          type: 'string',
          description:
            "Optional narrowing override. When omitted, this agent searches all three corpora it can read: its own knowledge scope, the default corpus, and the shared corpus. Naming one of those three narrows the search to just it; other agents' scopes are not searchable.",
        },
        tag_filter: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tag allowlist; only chunks with at least one matching tag are returned.',
        },
        min_score: {
          type: 'number',
          description: 'Minimum cosine score to surface. Defaults to 0.2.',
        },
      },
    },
  ),
  async invoke(args, ctx) {
    const query = String(args.query ?? '').trim();
    if (!query) return { text: 'query is required', isError: true };
    const topK = Number.isFinite(args.top_k) ? Number(args.top_k) : 5;
    const tagFilter = Array.isArray(args.tag_filter)
      ? (args.tag_filter as string[])
      : undefined;
    const scoreFloor = Number.isFinite(args.min_score) ? Number(args.min_score) : 0.2;

    // Resolve the agent's own knowledge scope first. A model-supplied `scope`
    // may only narrow the search to a corpus this agent is already entitled
    // to (one of the three corpora in the list below); accepting arbitrary names here
    // would let a prompted agent read another agent's private corpus.
    let ownScope = DEFAULT_KNOWLEDGE_SCOPE;
    if (ctx.agentId) {
      try {
        const agent = await loadAgent(ctx.agentId);
        ownScope = agent.knowledgeScope || DEFAULT_KNOWLEDGE_SCOPE;
      } catch (err) {
        return {
          text: `Could not load agent config for scope resolution: ${(err as Error).message}`,
          isError: true,
        };
      }
    }
    if (isReservedScope(ownScope)) return { text: 'invalid knowledge scope', isError: true };
    // One list is both the fan-out and the read allowlist, so the two cannot
    // drift. The Set de-dups when the agent's own scope is itself the default
    // or the shared corpus, so no corpus is ever scanned twice.
    let scopes = [...new Set([ownScope, DEFAULT_KNOWLEDGE_SCOPE, SHARED_KNOWLEDGE_SCOPE])];
    if (typeof args.scope === 'string' && args.scope) {
      if (!scopes.includes(args.scope)) {
        return {
          text: `Scope '${args.scope}' is not searchable from this agent. Allowed: ${scopes.map((s) => `'${s}'`).join(', ')}.`,
          isError: true,
        };
      }
      scopes = [args.scope];
    }

    let queryEmbedding: number[];
    try {
      queryEmbedding = await embedOne(query);
    } catch (err) {
      return {
        text: `Embedding failed: ${(err as Error).message}`,
        isError: true,
      };
    }
    const perScope = await Promise.all(
      scopes.map((scope) =>
        search({
          scope,
          queryEmbedding,
          topK,
          ...(tagFilter && tagFilter.length > 0 ? { tagFilter } : {}),
          scoreFloor,
        }),
      ),
    );
    // Merge scopes, drop duplicate chunks (same doc+chunk can't appear across
    // scopes today, but guard anyway), keep highest score, then take top-K.
    const merged = new Map<string, QueryHit>();
    for (const hits of perScope) {
      for (const h of hits) {
        const key = h.row.chunkId;
        const existing = merged.get(key);
        if (!existing || h.score > existing.score) merged.set(key, h);
      }
    }
    const hits = Array.from(merged.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    // Report what each corpus OFFERED and what SURVIVED the merge. One blended
    // ranking lets a large corpus take every slot, so `0/4` (had matches, lost
    // the ranking) and `0/0` (empty or misresolved corpus) are different facts.
    // A single count collapses them, reinstating one layer up the silent-corpus
    // defect this fan-out exists to kill.
    //
    // Counted by chunkId, never by comparing scope strings: `scopes` holds raw
    // agent.yaml values ('agent:ops') while metadata.scope holds the folded form
    // ('agent_ops'), because ingest.ts normalizes before putDocument stamps it.
    // A string compare would print 0 directly above passages visibly tagged with
    // that very scope.
    const keptIds = new Set(hits.map((h) => h.row.chunkId));
    const contrib = scopes.map((scope, i) => ({
      scope,
      found: perScope[i].length,
      kept: perScope[i].filter((h) => keptIds.has(h.row.chunkId)).length,
    }));
    logger.info(
      { agentId: ctx.agentId, ownScope, topK, scoreFloor, contrib },
      'vector search fan-out',
    );

    if (hits.length === 0) {
      // Name the filters that were in force; do not assert a cause. The old
      // message blamed the user's phrasing for what may be an unread corpus.
      const tags =
        tagFilter && tagFilter.length > 0 ? ` and tags ${tagFilter.join(', ')}` : '';
      return {
        text: `No passages scored at or above ${scoreFloor}${tags} in ${scopes
          .map((s) => `'${s}'`)
          .join(', ')}.`,
      };
    }
    const tally = contrib.map((c) => `${c.scope} ${c.kept}/${c.found}`).join(', ');
    const lines = hits.map((h, idx) => {
      const m = h.row.metadata;
      const cite = m.docTitle ?? m.source ?? m.docId;
      const loc = m.page ? ` p.${m.page}` : '';
      return `[${idx + 1}] (${h.score.toFixed(3)}) ${cite}${loc} #${m.chunkIndex} <${m.scope}>\n${h.row.text.trim()}`;
    });
    return {
      text: `${hits.length} passages, kept/found per corpus: ${tally}\n\n${lines.join('\n\n')}`,
    };
  },
});

tools.register('ingest_document', {
  spec: spec(
    'ingest_document',
    'Add a document to the long-term vector index so future search_vectors queries can find it. Use sparingly — the dashboard /api/ingest is the preferred path. Trigger this when the user explicitly says "save this document" or "remember this whole thing".',
    {
      type: 'object',
      required: ['content'],
      properties: {
        content: {
          type: 'string',
          description: 'The document body. Plain text, markdown, or HTML.',
        },
        format: {
          type: 'string',
          enum: ['text', 'markdown', 'html', 'pdf', 'docx'],
          description: 'Format hint. Auto-detected from source filename otherwise. pdf/docx require contentBase64 instead of content.',
        },
        doc_title: {
          type: 'string',
          description: 'Human-readable title for citations.',
        },
        source: {
          type: 'string',
          description: 'Provenance string (URL, filename, etc.).',
        },
        scope: {
          type: 'string',
          description:
            "Corpus partition. Must be this agent's own knowledge scope (which is also the default when omitted); other scopes, including 'shared', are only writable via the dashboard ingest.",
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags for filtering at retrieval time.',
        },
      },
    },
  ),
  async invoke(args, ctx) {
    const content = String(args.content ?? '').trim();
    if (!content) return { text: 'content is required', isError: true };
    // Writes always land in this agent's own corpus, resolved server-side.
    // Trusting a model-supplied scope would let a prompt-injected agent
    // poison the shared corpus (searched by every agent on every turn) or
    // write into another agent's private one.
    let scope = DEFAULT_KNOWLEDGE_SCOPE;
    if (ctx.agentId) {
      try {
        const agent = await loadAgent(ctx.agentId);
        scope = agent.knowledgeScope || DEFAULT_KNOWLEDGE_SCOPE;
      } catch (err) {
        return {
          text: `Could not load agent config for scope resolution: ${(err as Error).message}`,
          isError: true,
        };
      }
    }
    if (isReservedScope(scope)) return { text: 'invalid knowledge scope', isError: true };
    if (typeof args.scope === 'string' && args.scope && args.scope !== scope) {
      return {
        text: `This tool can only ingest into this agent's own scope ('${scope}'). Other scopes are writable only via the dashboard ingest.`,
        isError: true,
      };
    }
    const result = await ingestDocument({
      content,
      scope,
      ...(typeof args.format === 'string' && args.format
        ? { format: args.format as 'text' | 'markdown' | 'html' }
        : {}),
      ...(typeof args.doc_title === 'string' && args.doc_title
        ? { docTitle: args.doc_title }
        : {}),
      ...(typeof args.source === 'string' && args.source
        ? { source: args.source }
        : {}),
      ...(Array.isArray(args.tags) ? { tags: args.tags as string[] } : {}),
    });
    const note =
      result.failed > 0
        ? ` (${result.failed} chunk${result.failed === 1 ? '' : 's'} failed to embed and were NOT indexed — re-run to capture them)`
        : '';
    return {
      text: `Ingested ${result.chunks} chunks as doc ${result.docId} in scope '${result.scope}'${note}.`,
    };
  },
});
