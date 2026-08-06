/**
 * Shared shape every search adapter returns. Lets the agent get the
 * same passage format regardless of vendor.
 */

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  /** Optional. Some vendors include a per-hit confidence score. */
  score?: number;
}

export interface SearchRequest {
  query: string;
  topK: number;
  /** Optional time bias. Adapters that don't support it just ignore. */
  recencyDays?: number;
}

export interface SearchAdapter {
  /** Stable identifier. */
  name: string;
  /** Env var that must be set for this adapter to be usable. */
  envVar: string;
  /** Whether this adapter has its key configured. */
  configured(): boolean;
  search(req: SearchRequest): Promise<SearchHit[]>;
}
