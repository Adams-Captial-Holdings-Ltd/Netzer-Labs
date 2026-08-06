/**
 * Exa neural search adapter. https://exa.ai
 */

import type { SearchAdapter, SearchHit, SearchRequest } from './types.js';

interface ExaResponse {
  results?: Array<{
    title?: string;
    url?: string;
    text?: string;
    score?: number;
  }>;
}

export const exaAdapter: SearchAdapter = {
  name: 'exa',
  envVar: 'EXA_API_KEY',
  configured() {
    return Boolean(process.env.EXA_API_KEY);
  },
  async search(req: SearchRequest): Promise<SearchHit[]> {
    const resp = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.EXA_API_KEY ?? '',
      },
      body: JSON.stringify({
        query: req.query,
        numResults: req.topK,
        contents: { text: true },
        ...(req.recencyDays
          ? { startPublishedDate: new Date(Date.now() - req.recencyDays * 86400_000).toISOString() }
          : {}),
      }),
    });
    if (!resp.ok) {
      throw new Error(`exa HTTP ${resp.status}: ${await resp.text().catch(() => '')}`);
    }
    const body = (await resp.json()) as ExaResponse;
    return (body.results ?? []).slice(0, req.topK).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: (r.text ?? '').slice(0, 600),
      ...(r.score !== undefined ? { score: r.score } : {}),
    }));
  },
};
