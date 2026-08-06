/**
 * Serper Google-Search-as-API adapter. https://serper.dev
 */

import type { SearchAdapter, SearchHit, SearchRequest } from './types.js';

interface SerperResponse {
  organic?: Array<{
    title?: string;
    link?: string;
    snippet?: string;
  }>;
}

export const serperAdapter: SearchAdapter = {
  name: 'serper',
  envVar: 'SERPER_API_KEY',
  configured() {
    return Boolean(process.env.SERPER_API_KEY);
  },
  async search(req: SearchRequest): Promise<SearchHit[]> {
    const resp = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-KEY': process.env.SERPER_API_KEY ?? '',
      },
      body: JSON.stringify({
        q: req.query,
        num: req.topK,
        ...(req.recencyDays
          ? {
              tbs:
                req.recencyDays <= 1
                  ? 'qdr:d'
                  : req.recencyDays <= 7
                    ? 'qdr:w'
                    : 'qdr:m',
            }
          : {}),
      }),
    });
    if (!resp.ok) {
      throw new Error(`serper HTTP ${resp.status}: ${await resp.text().catch(() => '')}`);
    }
    const body = (await resp.json()) as SerperResponse;
    return (body.organic ?? []).slice(0, req.topK).map((r) => ({
      title: r.title ?? '',
      url: r.link ?? '',
      snippet: r.snippet ?? '',
    }));
  },
};
