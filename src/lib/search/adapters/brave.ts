/**
 * Brave Search adapter. https://brave.com/search/api
 * Free tier: 2000 queries/mo.
 */

import type { SearchAdapter, SearchHit, SearchRequest } from './types.js';

interface BraveResponse {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
    }>;
  };
}

export const braveAdapter: SearchAdapter = {
  name: 'brave',
  envVar: 'BRAVE_SEARCH_API_KEY',
  configured() {
    return Boolean(process.env.BRAVE_SEARCH_API_KEY);
  },
  async search(req: SearchRequest): Promise<SearchHit[]> {
    const url = new URL('https://api.search.brave.com/res/v1/web/search');
    url.searchParams.set('q', req.query);
    url.searchParams.set('count', String(req.topK));
    if (req.recencyDays) {
      const freshness =
        req.recencyDays <= 1 ? 'pd' : req.recencyDays <= 7 ? 'pw' : 'pm';
      url.searchParams.set('freshness', freshness);
    }
    const resp = await fetch(url, {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY ?? '',
      },
    });
    if (!resp.ok) {
      throw new Error(`brave HTTP ${resp.status}: ${await resp.text().catch(() => '')}`);
    }
    const body = (await resp.json()) as BraveResponse;
    return (body.web?.results ?? []).slice(0, req.topK).map((r) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      snippet: r.description ?? '',
    }));
  },
};
