/**
 * Bedrock Titan Embed Text v2 wrapper.
 *
 * Titan v2 supports 256, 512, and 1024 dims. We use 1024 for max recall.
 * The model accepts up to ~8000 tokens per call; chunks should be much
 * smaller (we aim for ~500 tokens to leave room for re-ranking later).
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import { logger } from '../../observability/logger.js';
import { guardedBedrockSend } from '../bedrock/guard.js';

const region = process.env.AWS_REGION ?? 'us-east-1';
const MODEL_ID =
  process.env.BEDROCK_EMBED_MODEL ?? 'amazon.titan-embed-text-v2:0';
const EMBED_DIM = 1024;
const MAX_BATCH = 25;
const CONCURRENCY = 4;

let _client: BedrockRuntimeClient | null = null;
function client(): BedrockRuntimeClient {
  if (!_client) _client = new BedrockRuntimeClient({ region });
  return _client;
}

interface TitanEmbedResponse {
  embedding?: number[];
  inputTextTokenCount?: number;
}

export async function embedOne(text: string): Promise<number[]> {
  if (!text.trim()) return new Array(EMBED_DIM).fill(0);
  const resp = await guardedBedrockSend(() =>
    client().send(
      new InvokeModelCommand({
        modelId: MODEL_ID,
        contentType: 'application/json',
        accept: 'application/json',
        body: JSON.stringify({
          inputText: text,
          dimensions: EMBED_DIM,
          normalize: true,
        }),
      }),
    ),
  );
  const body = JSON.parse(new TextDecoder().decode(resp.body)) as TitanEmbedResponse;
  if (!body.embedding) {
    throw new Error('Titan returned no embedding');
  }
  return body.embedding;
}

/**
 * Embed each input text. A FAILED embedding is returned as `null`, never a
 * zero vector. Writing a zero vector to the index would silently corrupt the
 * corpus: cosineSimilarity() returns 0 against a zero vector regardless of the
 * query, so the chunk is permanently unretrievable yet still counted as
 * indexed. The ingest pipeline drops null slots and reports the true searchable
 * count plus how many failed, so a partial Bedrock outage surfaces honestly
 * instead of masquerading as a clean ingest.
 */
export async function embedMany(
  texts: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<(number[] | null)[]> {
  if (texts.length === 0) return [];
  // Titan doesn't expose a true batch endpoint; we parallelize calls
  // up to CONCURRENCY to avoid throttling. Chunks of MAX_BATCH let us
  // surface progress and bound memory. onProgress fires after each chunk
  // resolves (JS is single-threaded so the counter is race-free), which is
  // what drives the live "Embedding i/N" pipeline UI.
  const results: (number[] | null)[] = new Array(texts.length).fill(null);
  let done = 0;
  for (let offset = 0; offset < texts.length; offset += MAX_BATCH) {
    const slice = texts.slice(offset, offset + MAX_BATCH);
    let index = 0;
    async function worker(): Promise<void> {
      while (true) {
        const i = index++;
        if (i >= slice.length) return;
        try {
          results[offset + i] = await embedOne(slice[i]);
        } catch (err) {
          logger.warn(
            {
              errMessage: err instanceof Error ? err.message : String(err),
              i: offset + i,
            },
            'embed failure; chunk dropped (not indexed)',
          );
          // Leave the slot null so the ingest pipeline skips it. Never write a
          // zero vector here — that would index an unsearchable chunk.
          results[offset + i] = null;
        }
        done++;
        onProgress?.(done, texts.length);
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, slice.length) }, () => worker()),
    );
  }
  return results;
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export const EMBED_DIMS = EMBED_DIM;
