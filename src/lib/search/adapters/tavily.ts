/**
 * Tavily search adapter — AI-friendly search with free tier.
 * https://tavily.com (1000 free queries/mo on the basic plan).
 */

import type { SearchAdapter, SearchHit, SearchRequest } from './types.js';

interface TavilyResponse {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    score?: number;
  }>;
}

export const tavilyAdapter: SearchAdapter = {
  name: 'tavily',
  envVar: 'TAVILY_API_KEY',
  configured() {
    return Boolean(process.env.TAVILY_API_KEY);
  },
  async search(req: SearchRequest): Promise<SearchHit[]> {
    const resp = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query: req.query,
        max_results: req.topK,
        search_depth: 'basic',
        include_answer: false,
        ...(req.recencyDays ? { days: req.recencyDays } : {}),
      }),
    });
    if (!resp.ok) {
      throw new Error(`tavily HTTP ${resp.status}: ${await resp.text().catch(() => '')}`);
    }
    const body = (await resp.json()) as TavilyResponse;
    return (body.results ?? []).slice(0, req.topK).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: r.content ?? '',
      ...(r.score !== undefined ? { score: r.score } : {}),
    }));
  },
};
