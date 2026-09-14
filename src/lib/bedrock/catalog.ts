import {
  BedrockClient,
  ListFoundationModelsCommand,
  ListInferenceProfilesCommand,
  type ListFoundationModelsCommandInput,
  type ListInferenceProfilesCommandInput,
} from '@aws-sdk/client-bedrock';
import { logger } from '../../observability/logger.js';
import { getConfig } from '../state/runtime-config-repo.js';
import {
  canonicalModelId,
  resolveCapabilities,
  type ModelCapabilities,
} from './capabilities.js';
import { listAvailableModels } from './models.js';

export interface FoundationModelSummaryLike {
  modelId?: string;
  modelName?: string;
  providerName?: string;
  outputModalities?: string[];
  inferenceTypesSupported?: string[];
  modelLifecycle?: { status?: string };
}

export interface InferenceProfileSummaryLike {
  inferenceProfileId?: string;
  inferenceProfileName?: string;
  status?: string;
  type?: string;
  models?: Array<{ modelArn?: string }>;
}

export interface CatalogControlPlane {
  listFoundationModels(input: { byOutputModality?: string }): Promise<{
    modelSummaries?: FoundationModelSummaryLike[];
  }>;
  listInferenceProfiles(input: {
    typeEquals?: string;
    maxResults?: number;
    nextToken?: string;
  }): Promise<{
    inferenceProfileSummaries?: InferenceProfileSummaryLike[];
    nextToken?: string;
  }>;
}

export interface CatalogEntry {
  id: string;
  canonicalId: string;
  provider: string;
  name: string;
  label?: string;
  source: 'env' | 'discovered';
  capabilities: ModelCapabilities;
}

export type CatalogExclusionReason =
  | 'non-converse'
  | 'not-active'
  | 'not-text'
  | 'no-geo-path'
  | 'guardrail-unsupported'
  | 'provider-not-approved';

export interface CatalogExclusion {
  modelId: string;
  reason: CatalogExclusionReason;
}

export interface ModelCatalog {
  source: 'discovered' | 'env-fallback';
  models: CatalogEntry[];
  excluded: CatalogExclusion[];
}

export interface GetModelCatalogOptions {
  env?: NodeJS.ProcessEnv;
  controlPlane?: CatalogControlPlane;
  now?: () => number;
  readConfig?: (category: string, key: string) => Promise<string | undefined>;
  guardrailConfigured?: boolean;
  capabilities?: (canonicalId: string) => ModelCapabilities;
}

export const DEFAULT_APPROVED_PROVIDERS: readonly string[] = [
  'anthropic.',
  'amazon.',
  'openai.gpt-oss',
  'deepseek.',
];

// Exact ids from the AWS API-compatibility page and model cards; the
// coordinator's seed generator re-confirms them.
export const NON_CONVERSE_MODELS: readonly string[] = [
  'anthropic.claude-mythos-5',
  'anthropic.claude-mythos-preview',
  'openai.gpt-daybreak-blue-5.6-sol',
  'openai.gpt-5.6-cyber',
  'openai.gpt-5.4',
  'openai.gpt-5.5',
  'xai.grok-4.3',
  'google.gemma-4-26b-a4b',
  'google.gemma-4-31b',
  'google.gemma-4-e2b',
  'twelvelabs.pegasus-1-2-v1:0',
];

export const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

interface RawDiscovery {
  models: FoundationModelSummaryLike[];
  profiles: InferenceProfileSummaryLike[];
}

let cachedDiscovery: RawDiscovery | undefined;
let cachedAt = 0;
let inFlightDiscovery: Promise<RawDiscovery | undefined> | undefined;
let cacheGeneration = 0;

export function geoPrefixForRegion(region: string): 'us' | 'eu' | 'apac' | null {
  if (region.startsWith('us-')) return 'us';
  if (region.startsWith('eu-')) return 'eu';
  if (region.startsWith('ap-')) return 'apac';
  return null;
}

function providerOf(canonicalId: string): string {
  return canonicalId.split('.', 1)[0] ?? canonicalId;
}

function createControlPlane(region: string): CatalogControlPlane {
  const client = new BedrockClient({ region });
  return {
    async listFoundationModels(input) {
      const output = await client.send(
        new ListFoundationModelsCommand(input as ListFoundationModelsCommandInput),
      );
      return { modelSummaries: output.modelSummaries as FoundationModelSummaryLike[] | undefined };
    },
    async listInferenceProfiles(input) {
      const output = await client.send(
        new ListInferenceProfilesCommand(input as ListInferenceProfilesCommandInput),
      );
      return {
        inferenceProfileSummaries: output.inferenceProfileSummaries as
          | InferenceProfileSummaryLike[]
          | undefined,
        nextToken: output.nextToken,
      };
    },
  };
}

async function discover(controlPlane: CatalogControlPlane): Promise<RawDiscovery> {
  const foundations = await controlPlane.listFoundationModels({ byOutputModality: 'TEXT' });
  const profiles: InferenceProfileSummaryLike[] = [];
  let nextToken: string | undefined;
  do {
    const page = await controlPlane.listInferenceProfiles({
      typeEquals: 'SYSTEM_DEFINED',
      ...(nextToken === undefined ? {} : { nextToken }),
    });
    profiles.push(...(page.inferenceProfileSummaries ?? []));
    nextToken = page.nextToken;
  } while (nextToken !== undefined);
  return { models: foundations.modelSummaries ?? [], profiles };
}

async function rawDiscovery(
  region: string,
  suppliedControlPlane: CatalogControlPlane | undefined,
  now: () => number,
): Promise<RawDiscovery | undefined> {
  const currentTime = now();
  if (cachedDiscovery && currentTime - cachedAt < CATALOG_TTL_MS) return cachedDiscovery;
  if (inFlightDiscovery) return inFlightDiscovery;

  const previous = cachedDiscovery;
  const generation = cacheGeneration;
  const controlPlane = suppliedControlPlane ?? createControlPlane(region);
  let pending: Promise<RawDiscovery | undefined> | undefined;
  pending = (async (): Promise<RawDiscovery | undefined> => {
    try {
      const result = await discover(controlPlane);
      if (generation === cacheGeneration) {
        cachedDiscovery = result;
        cachedAt = now();
      }
      return result;
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'Bedrock model discovery failed; using the last available catalog',
      );
      return previous;
    } finally {
      if (inFlightDiscovery === pending) inFlightDiscovery = undefined;
    }
  })();
  inFlightDiscovery = pending;
  return pending;
}

function approvedProviders(value: string | undefined): readonly string[] {
  if (value === undefined) return DEFAULT_APPROVED_PROVIDERS;
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every((item): item is string => typeof item === 'string')) {
      return parsed;
    }
  } catch {
    // Invalid runtime config falls back to the reviewed provider list.
  }
  return DEFAULT_APPROVED_PROVIDERS;
}

export async function getModelCatalog(opts: GetModelCatalogOptions = {}): Promise<ModelCatalog> {
  const env = opts.env ?? process.env;
  const capabilities = opts.capabilities ?? resolveCapabilities;
  const envEntries: CatalogEntry[] = listAvailableModels(env).map((model) => {
    const canonicalId = canonicalModelId(model.id);
    return {
      id: model.id,
      canonicalId,
      provider: providerOf(canonicalId),
      name: model.label || canonicalId,
      label: model.label,
      source: 'env',
      capabilities: capabilities(canonicalId),
    };
  });

  if (env.AWS_ENDPOINT_URL) {
    return { source: 'env-fallback', models: envEntries, excluded: [] };
  }

  const region = env.AWS_REGION ?? 'us-east-1';
  const raw = await rawDiscovery(region, opts.controlPlane, opts.now ?? Date.now);
  if (!raw) return { source: 'env-fallback', models: envEntries, excluded: [] };

  const readConfig = opts.readConfig ?? getConfig;
  const [approvedValue, nonAnthropicEnabled] = await Promise.all([
    readConfig('models', 'approved_providers'),
    readConfig('models', 'non_anthropic_enabled'),
  ]);
  const approved = nonAnthropicEnabled === '0' ? ['anthropic.'] : approvedProviders(approvedValue);
  const guardrailConfigured = opts.guardrailConfigured ?? Boolean(env.BEDROCK_GUARDRAIL_ID);
  const geo = geoPrefixForRegion(region);
  const profileIds = new Set(
    raw.profiles
      .map((profile) => profile.inferenceProfileId)
      .filter((id): id is string => typeof id === 'string'),
  );
  const envCanonicals = new Set(envEntries.map((entry) => entry.canonicalId));
  const acceptedCanonicals = new Set<string>();
  const discovered: CatalogEntry[] = [];
  const excluded: CatalogExclusion[] = [];

  const exclude = (modelId: string, reason: CatalogExclusionReason): void => {
    if (!excluded.some((entry) => entry.modelId === modelId)) excluded.push({ modelId, reason });
  };

  for (const row of raw.models) {
    const modelId = row.modelId;
    if (!modelId) continue;
    const canonicalId = canonicalModelId(modelId);
    if (envCanonicals.has(canonicalId)) continue;
    if (row.modelLifecycle?.status !== 'ACTIVE') {
      exclude(modelId, 'not-active');
      continue;
    }
    if (!row.outputModalities?.includes('TEXT')) {
      exclude(modelId, 'not-text');
      continue;
    }
    if (NON_CONVERSE_MODELS.includes(canonicalId)) {
      exclude(modelId, 'non-converse');
      continue;
    }

    let invocationId: string | undefined;
    if (row.inferenceTypesSupported?.includes('ON_DEMAND')) {
      invocationId = modelId;
    } else if (geo) {
      const profileId = `${geo}.${modelId}`;
      if (profileIds.has(profileId)) invocationId = profileId;
    }
    if (!invocationId) {
      exclude(modelId, 'no-geo-path');
      continue;
    }
    if (!approved.some((prefix) => canonicalId.startsWith(prefix))) {
      exclude(modelId, 'provider-not-approved');
      continue;
    }

    const modelCapabilities = capabilities(canonicalId);
    if (guardrailConfigured && modelCapabilities.guardrails === 'no') {
      exclude(modelId, 'guardrail-unsupported');
      continue;
    }
    if (acceptedCanonicals.has(canonicalId)) continue;
    acceptedCanonicals.add(canonicalId);
    discovered.push({
      id: invocationId,
      canonicalId,
      provider: providerOf(canonicalId),
      name: row.modelName ?? modelId,
      label: undefined,
      source: 'discovered',
      capabilities: modelCapabilities,
    });
  }

  return { source: 'discovered', models: [...envEntries, ...discovered], excluded };
}

export function resetModelCatalogCache(): void {
  cachedDiscovery = undefined;
  cachedAt = 0;
  inFlightDiscovery = undefined;
  cacheGeneration += 1;
}
