/**
 * Executable specification for the live model catalog (WI-1).
 *
 * Covers AM-01 (catalog contents and invocation ids), AM-02 (failure modes and
 * the Claude-only flag), the catalog half of AM-30 (provider approval) and the
 * catalog half of AM-37 (geo derivation). No AWS, no network: the control plane
 * and the runtime-config reader are injected, the SDK client is faked where the
 * default control plane is under test, and the clock is faked.
 *
 * The blocks at the end (WI-1 correction 1) pin the discovery deadline and page
 * cap, the failure backoff, fail-closed config reads and dated-id folding.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../observability/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../state/runtime-config-repo.js', () => ({
  getConfig: vi.fn(async () => undefined),
}));

// The default control plane runs against a fake BedrockClient that records each
// client config and routes send() to a per-test mock. The real command classes
// stay, so the catalog still builds genuine commands.
const sdk = vi.hoisted(() => ({
  configs: [] as Array<Record<string, unknown>>,
  failConstruct: false,
  send: vi.fn(async (_command: { input: Record<string, unknown> }): Promise<unknown> => ({})),
}));
vi.mock('@aws-sdk/client-bedrock', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-bedrock')>();
  class BedrockClient {
    constructor(config: Record<string, unknown>) {
      if (sdk.failConstruct) throw new Error('fixture: client construction failed');
      sdk.configs.push(config);
    }
    send(command: { input: Record<string, unknown> }): Promise<unknown> {
      return sdk.send(command);
    }
  }
  return { ...actual, BedrockClient };
});

import { UNKNOWN_MODEL_DEFAULTS, canonicalModelId, type ModelCapabilities } from './capabilities.js';
import {
  CATALOG_DISCOVERY_TIMEOUT_MS,
  CATALOG_MAX_PROFILE_PAGES,
  CATALOG_RETRY_AFTER_MS,
  CATALOG_TTL_MS,
  DEFAULT_APPROVED_PROVIDERS,
  NON_CONVERSE_MODELS,
  geoPrefixForRegion,
  getModelCatalog,
  resetModelCatalogCache,
  type GetModelCatalogOptions,
  type ModelCatalog,
} from './catalog.js';

const SONNET = 'us.anthropic.claude-sonnet-4-6';
const SONNET_1M = 'us.anthropic.claude-sonnet-4-6-1m';
const ENV: NodeJS.ProcessEnv = {
  AWS_REGION: 'us-east-1',
  BEDROCK_SONNET_MODEL: SONNET,
  BEDROCK_SONNET_1M_MODEL: SONNET_1M,
};

// ── Control-plane fixtures ──────────────────────────────────────────
// Structural look-alikes of the SDK's FoundationModelSummary and
// InferenceProfileSummary; the catalog must accept plain-string rows.
interface FmRow {
  modelId: string;
  modelName: string;
  providerName: string;
  outputModalities: string[];
  inferenceTypesSupported: string[];
  modelLifecycle: { status: string };
}
interface ProfileRow {
  inferenceProfileId: string;
  inferenceProfileName: string;
  status: string;
  type: string;
  models: Array<{ modelArn: string }>;
}

function fm(modelId: string, over: Partial<FmRow> = {}): FmRow {
  return {
    modelId,
    modelName: `Fixture ${modelId}`,
    providerName: 'Fixture',
    outputModalities: ['TEXT'],
    inferenceTypesSupported: ['INFERENCE_PROFILE'],
    modelLifecycle: { status: 'ACTIVE' },
    ...over,
  };
}
const onDemand = (modelId: string, over: Partial<FmRow> = {}): FmRow =>
  fm(modelId, { inferenceTypesSupported: ['ON_DEMAND'], ...over });

function profile(inferenceProfileId: string): ProfileRow {
  const base = inferenceProfileId.replace(/^[a-z]+\./, '');
  return {
    inferenceProfileId,
    inferenceProfileName: inferenceProfileId,
    status: 'ACTIVE',
    type: 'SYSTEM_DEFINED',
    models: [{ modelArn: `arn:aws:bedrock:us-east-1::foundation-model/${base}` }],
  };
}

/** ListFoundationModels returns one page; ListInferenceProfiles paginates with nextToken. */
function fakeControlPlane(models: FmRow[], profilePages: ProfileRow[][] = [[]]) {
  return {
    listFoundationModels: vi.fn(async (_input?: { byOutputModality?: string }) => ({
      modelSummaries: models,
    })),
    listInferenceProfiles: vi.fn(
      async (input?: { typeEquals?: string; maxResults?: number; nextToken?: string }) => {
        const page = input?.nextToken ? Number(input.nextToken) : 0;
        const nextToken = page + 1 < profilePages.length ? String(page + 1) : undefined;
        return {
          inferenceProfileSummaries: profilePages[page] ?? [],
          ...(nextToken ? { nextToken } : {}),
        };
      },
    ),
  };
}

// Synthetic but plausible ids. Every row fails at most one filter so the
// tests pin reasons, not precedence — except the two rows marked "wins".
const NO_GUARD = 'amazon.nova-fixture-noguard-v1:0';
const FM_ROWS: FmRow[] = [
  fm('anthropic.claude-sonnet-4-6'), // profile-only; env already lists it → deduped
  fm('anthropic.claude-haiku-4-5'), // profile-only → us. profile (on page 2)
  onDemand('openai.gpt-oss-120b-1:0'), // in-region → base id
  fm('deepseek.v3-fixture', { inferenceTypesSupported: ['ON_DEMAND', 'INFERENCE_PROFILE'] }), // both → base id
  onDemand(NO_GUARD), // approved, in-region; guardrail tests mark it 'no'
  fm('amazon.nova-fixture-global-v1:0'), // only a global. profile → no-geo-path
  fm('amazon.nova-fixture-noprofile-v1:0'), // no profile at all → no-geo-path
  onDemand('meta.llama-fixture-v1:0'), // unapproved provider
  fm('meta.llama-fixture-noprofile-v1:0'), // unapproved AND unreachable → no-geo-path wins
  onDemand('amazon.titan-embed-fixture-v2:0', { outputModalities: ['EMBEDDING'] }), // not-text
  onDemand('amazon.nova-fixture-legacy-v1:0', { modelLifecycle: { status: 'LEGACY' } }), // not-active
];
const PROFILE_PAGES: ProfileRow[][] = [
  [
    profile('us.anthropic.claude-sonnet-4-6'),
    profile('global.anthropic.claude-sonnet-4-6'),
    profile('us.deepseek.v3-fixture'),
  ],
  [
    profile('us.anthropic.claude-haiku-4-5'),
    profile('eu.anthropic.claude-haiku-4-5'),
    profile('global.amazon.nova-fixture-global-v1:0'),
  ],
];

function configReader(values: Record<string, string | undefined> = {}) {
  return vi.fn(async (category: string, key: string) => values[`${category}/${key}`]);
}

function baseOpts(over: Partial<GetModelCatalogOptions> = {}): GetModelCatalogOptions {
  return {
    env: ENV,
    controlPlane: fakeControlPlane(FM_ROWS, PROFILE_PAGES),
    readConfig: configReader(),
    guardrailConfigured: false,
    ...over,
  };
}
const ids = (cat: ModelCatalog): string[] => cat.models.map((m) => m.id);
const reasonOf = (cat: ModelCatalog, modelId: string) =>
  cat.excluded.find((e) => e.modelId === modelId)?.reason;

beforeEach(() => {
  resetModelCatalogCache();
});
afterEach(() => {
  vi.useRealTimers();
});

// ── Pure helpers and constants ──────────────────────────────────────

describe('geoPrefixForRegion (AM-37)', () => {
  it('maps us-*, eu-* and ap-* to the Bedrock geo profile prefixes', () => {
    expect(geoPrefixForRegion('us-east-1')).toBe('us');
    expect(geoPrefixForRegion('us-west-2')).toBe('us');
    expect(geoPrefixForRegion('eu-west-1')).toBe('eu');
    expect(geoPrefixForRegion('eu-central-1')).toBe('eu');
    expect(geoPrefixForRegion('ap-southeast-2')).toBe('apac');
    expect(geoPrefixForRegion('ap-northeast-1')).toBe('apac');
  });

  it('returns null for every other region (in-region only)', () => {
    for (const region of ['ca-central-1', 'sa-east-1', 'me-central-1', 'af-south-1', '']) {
      expect(geoPrefixForRegion(region), region).toBeNull();
    }
  });
});

describe('catalog constants (AM-30)', () => {
  it('approves exactly the four reachable providers by default', () => {
    expect(DEFAULT_APPROVED_PROVIDERS).toEqual(['anthropic.', 'amazon.', 'openai.gpt-oss', 'deepseek.']);
  });

  it('names the non-Converse models by exact canonical id, never by a prefix that swallows a neighbour', () => {
    expect(NON_CONVERSE_MODELS.length).toBeGreaterThanOrEqual(7);
    expect(new Set(NON_CONVERSE_MODELS).size).toBe(NON_CONVERSE_MODELS.length);
    for (const id of NON_CONVERSE_MODELS) {
      expect(canonicalModelId(id), id).toBe(id);
    }
    expect(NON_CONVERSE_MODELS.filter((id) => /mythos/.test(id)).length).toBeGreaterThanOrEqual(2);
    expect(NON_CONVERSE_MODELS.some((id) => /gpt-5[.-]5/.test(id))).toBe(true);
    expect(NON_CONVERSE_MODELS.some((id) => /gpt-5[.-]4/.test(id))).toBe(true);
    expect(NON_CONVERSE_MODELS.some((id) => /grok-4[.-]3/.test(id))).toBe(true);
    // Converse-capable neighbours (per the AWS model-card inventory and the
    // plan's verified facts) that a bare "mythos-5" / "gpt-5" prefix would hide.
    expect(NON_CONVERSE_MODELS).not.toContain('anthropic.claude-mythos-5-1');
    expect(NON_CONVERSE_MODELS).not.toContain('openai.gpt-5.6-sol');
  });
});

// ── Discovery ───────────────────────────────────────────────────────

describe('getModelCatalog: discovery (AM-01)', () => {
  it('lists the env Claude entries first, with their labels unchanged', async () => {
    const cat = await getModelCatalog(baseOpts());
    expect(cat.source).toBe('discovered');
    expect(cat.models.slice(0, 2)).toMatchObject([
      { id: SONNET, canonicalId: 'anthropic.claude-sonnet-4-6', provider: 'anthropic', label: 'sonnet', source: 'env' },
      { id: SONNET_1M, canonicalId: 'anthropic.claude-sonnet-4-6', provider: 'anthropic', label: 'sonnet-1m', source: 'env' },
    ]);
    for (const m of cat.models.slice(0, 2)) expect(m.name.trim().length).toBeGreaterThan(0);
  });

  it('dedupes discovered models against env by canonical id, preferring the env entries', async () => {
    const cat = await getModelCatalog(baseOpts());
    const sonnets = cat.models.filter((m) => m.canonicalId === 'anthropic.claude-sonnet-4-6');
    // Both env selections survive (they are distinct invocation ids); the
    // discovered base model is folded into them, not listed a third time and
    // not reported as an exclusion.
    expect(sonnets.map((m) => m.id)).toEqual([SONNET, SONNET_1M]);
    expect(sonnets.every((m) => m.source === 'env')).toBe(true);
    expect(cat.excluded.find((e) => e.modelId === 'anthropic.claude-sonnet-4-6')).toBeUndefined();
  });

  it('uses the base id for an ACTIVE TEXT model that supports ON_DEMAND', async () => {
    const cat = await getModelCatalog(baseOpts());
    const entry = cat.models.find((m) => m.canonicalId === 'openai.gpt-oss-120b-1:0');
    expect(entry).toMatchObject({
      id: 'openai.gpt-oss-120b-1:0',
      canonicalId: 'openai.gpt-oss-120b-1:0',
      provider: 'openai',
      name: 'Fixture openai.gpt-oss-120b-1:0',
      source: 'discovered',
    });
    expect(entry?.label).toBeUndefined();
  });

  it('prefers in-region over the geo profile when a model offers both', async () => {
    const cat = await getModelCatalog(baseOpts());
    expect(ids(cat)).toContain('deepseek.v3-fixture');
    expect(ids(cat)).not.toContain('us.deepseek.v3-fixture');
  });

  it('routes a profile-only model through its <geo>. SYSTEM_DEFINED profile, paginating the profile list', async () => {
    const cp = fakeControlPlane(FM_ROWS, PROFILE_PAGES);
    const cat = await getModelCatalog(baseOpts({ controlPlane: cp }));
    const haiku = cat.models.find((m) => m.canonicalId === 'anthropic.claude-haiku-4-5');
    expect(haiku).toMatchObject({
      id: 'us.anthropic.claude-haiku-4-5',
      provider: 'anthropic',
      source: 'discovered',
    });
    expect(cp.listFoundationModels).toHaveBeenCalledTimes(1);
    expect(cp.listInferenceProfiles).toHaveBeenCalledTimes(2);
    expect(cp.listInferenceProfiles.mock.calls[0]?.[0]).toMatchObject({ typeEquals: 'SYSTEM_DEFINED' });
    expect(cp.listInferenceProfiles.mock.calls[1]?.[0]).toMatchObject({ nextToken: '1' });
  });

  it('excludes global-only and profile-less models as no-geo-path', async () => {
    const cat = await getModelCatalog(baseOpts());
    expect(reasonOf(cat, 'amazon.nova-fixture-global-v1:0')).toBe('no-geo-path');
    expect(reasonOf(cat, 'amazon.nova-fixture-noprofile-v1:0')).toBe('no-geo-path');
    expect(ids(cat).some((id) => id.startsWith('global.'))).toBe(false);
  });

  it('excludes non-TEXT and non-ACTIVE models with their reasons', async () => {
    const cat = await getModelCatalog(baseOpts());
    expect(reasonOf(cat, 'amazon.titan-embed-fixture-v2:0')).toBe('not-text');
    expect(reasonOf(cat, 'amazon.nova-fixture-legacy-v1:0')).toBe('not-active');
    expect(ids(cat)).not.toContain('amazon.titan-embed-fixture-v2:0');
    expect(ids(cat)).not.toContain('amazon.nova-fixture-legacy-v1:0');
  });

  it('reports each excluded model once, and never lists an excluded id', async () => {
    const cat = await getModelCatalog(baseOpts());
    const excludedIds = cat.excluded.map((e) => e.modelId);
    expect(new Set(excludedIds).size).toBe(excludedIds.length);
    const canonicals = new Set(cat.models.map((m) => m.canonicalId));
    for (const id of excludedIds) expect(canonicals.has(canonicalModelId(id)), id).toBe(false);
  });

  it('attaches capabilities resolved from the canonical id, for env and discovered entries alike', async () => {
    const capabilities = vi.fn(
      (canonicalId: string): ModelCapabilities => ({ ...UNKNOWN_MODEL_DEFAULTS, maxOutputTokens: canonicalId.length }),
    );
    const cat = await getModelCatalog(baseOpts({ capabilities }));
    const env = cat.models.find((m) => m.id === SONNET_1M);
    const gpt = cat.models.find((m) => m.id === 'openai.gpt-oss-120b-1:0');
    expect(env?.capabilities.maxOutputTokens).toBe('anthropic.claude-sonnet-4-6'.length);
    expect(gpt?.capabilities.maxOutputTokens).toBe('openai.gpt-oss-120b-1:0'.length);
    expect(capabilities).toHaveBeenCalledWith('anthropic.claude-sonnet-4-6');
    expect(capabilities).not.toHaveBeenCalledWith(SONNET_1M);
  });
});

describe('getModelCatalog: non-Converse models (AM-01)', () => {
  it('excludes every NON_CONVERSE_MODELS id as non-converse, whatever its provider', async () => {
    const rows = [
      ...NON_CONVERSE_MODELS.map((id) => onDemand(id)),
      onDemand('anthropic.claude-mythos-5-1'), // Converse-capable neighbour
      onDemand('openai.gpt-5.6-sol'), // Converse-capable, but outside openai.gpt-oss
    ];
    const cat = await getModelCatalog(baseOpts({ controlPlane: fakeControlPlane(rows) }));
    for (const id of NON_CONVERSE_MODELS) {
      expect(reasonOf(cat, id), id).toBe('non-converse');
      expect(ids(cat), id).not.toContain(id);
    }
    expect(ids(cat)).toContain('anthropic.claude-mythos-5-1');
    expect(reasonOf(cat, 'openai.gpt-5.6-sol')).toBe('provider-not-approved');
  });
});

describe('getModelCatalog: provider approval (AM-30 catalog half)', () => {
  it('excludes unapproved providers by default and reads models/approved_providers', async () => {
    const readConfig = configReader();
    const cat = await getModelCatalog(baseOpts({ readConfig }));
    expect(reasonOf(cat, 'meta.llama-fixture-v1:0')).toBe('provider-not-approved');
    expect(ids(cat)).not.toContain('meta.llama-fixture-v1:0');
    expect(ids(cat)).toContain('openai.gpt-oss-120b-1:0');
    expect(ids(cat)).toContain('deepseek.v3-fixture');
    expect(readConfig).toHaveBeenCalledWith('models', 'approved_providers');
  });

  it('reports an unreachable unapproved model as no-geo-path (reachability before policy)', async () => {
    const cat = await getModelCatalog(baseOpts());
    expect(reasonOf(cat, 'meta.llama-fixture-noprofile-v1:0')).toBe('no-geo-path');
  });

  it('a JSON array in models/approved_providers replaces the default list', async () => {
    const cat = await getModelCatalog(
      baseOpts({ readConfig: configReader({ 'models/approved_providers': '["meta."]' }) }),
    );
    expect(ids(cat)).toContain('meta.llama-fixture-v1:0');
    expect(ids(cat)).toEqual(expect.arrayContaining([SONNET, SONNET_1M])); // env entries are never filtered
    expect(reasonOf(cat, 'openai.gpt-oss-120b-1:0')).toBe('provider-not-approved');
    expect(reasonOf(cat, 'anthropic.claude-haiku-4-5')).toBe('provider-not-approved');
  });

  it('a malformed models/approved_providers value fails closed to the default list', async () => {
    for (const bad of ['not json', '{"a":1}', '["meta.", 3]', '"meta."', '']) {
      resetModelCatalogCache();
      const cat = await getModelCatalog(
        baseOpts({ readConfig: configReader({ 'models/approved_providers': bad }) }),
      );
      expect(reasonOf(cat, 'meta.llama-fixture-v1:0'), JSON.stringify(bad)).toBe('provider-not-approved');
      expect(ids(cat), JSON.stringify(bad)).toContain('openai.gpt-oss-120b-1:0');
    }
  });

  it('an empty approved list approves no discovered provider; env entries stay', async () => {
    const cat = await getModelCatalog(
      baseOpts({ readConfig: configReader({ 'models/approved_providers': '[]' }) }),
    );
    expect(ids(cat)).toEqual([SONNET, SONNET_1M]);
    expect(reasonOf(cat, 'openai.gpt-oss-120b-1:0')).toBe('provider-not-approved');
    expect(reasonOf(cat, 'anthropic.claude-haiku-4-5')).toBe('provider-not-approved');
  });

  it("models/non_anthropic_enabled === '0' keeps only Anthropic (AM-02)", async () => {
    const cat = await getModelCatalog(
      baseOpts({ readConfig: configReader({ 'models/non_anthropic_enabled': '0' }) }),
    );
    expect(cat.models.length).toBeGreaterThan(0);
    expect(cat.models.every((m) => m.canonicalId.startsWith('anthropic.'))).toBe(true);
    expect(ids(cat)).toContain('us.anthropic.claude-haiku-4-5');
    expect(reasonOf(cat, 'openai.gpt-oss-120b-1:0')).toBe('provider-not-approved');
    expect(reasonOf(cat, 'deepseek.v3-fixture')).toBe('provider-not-approved');
  });

  it('applies the runtime-config filters on every call, over the cached discovery', async () => {
    const values: Record<string, string | undefined> = {};
    const readConfig = vi.fn(async (category: string, key: string) => values[`${category}/${key}`]);
    const cp = fakeControlPlane(FM_ROWS, PROFILE_PAGES);
    const first = await getModelCatalog(baseOpts({ controlPlane: cp, readConfig }));
    expect(ids(first)).toContain('openai.gpt-oss-120b-1:0');

    values['models/approved_providers'] = '["anthropic."]';
    const second = await getModelCatalog(baseOpts({ controlPlane: cp, readConfig }));
    expect(ids(second)).not.toContain('openai.gpt-oss-120b-1:0');
    expect(reasonOf(second, 'openai.gpt-oss-120b-1:0')).toBe('provider-not-approved');
    expect(cp.listFoundationModels).toHaveBeenCalledTimes(1);
  });
});

describe('getModelCatalog: guardrails fail closed', () => {
  const caps = (canonicalId: string): ModelCapabilities =>
    canonicalId === NO_GUARD ? { ...UNKNOWN_MODEL_DEFAULTS, guardrails: 'no' } : UNKNOWN_MODEL_DEFAULTS;

  it("excludes guardrails:'no' models when a guardrail is configured, keeps 'unknown'", async () => {
    const cat = await getModelCatalog(baseOpts({ capabilities: caps, guardrailConfigured: true }));
    expect(reasonOf(cat, NO_GUARD)).toBe('guardrail-unsupported');
    expect(ids(cat)).not.toContain(NO_GUARD);
    expect(ids(cat)).toContain('openai.gpt-oss-120b-1:0');
  });

  it("keeps guardrails:'no' models when no guardrail is configured", async () => {
    const cat = await getModelCatalog(baseOpts({ capabilities: caps, guardrailConfigured: false }));
    expect(ids(cat)).toContain(NO_GUARD);
  });

  it('derives guardrailConfigured from BEDROCK_GUARDRAIL_ID when it is not injected', async () => {
    const cat = await getModelCatalog({
      env: { ...ENV, BEDROCK_GUARDRAIL_ID: 'gr-fixture' },
      controlPlane: fakeControlPlane(FM_ROWS, PROFILE_PAGES),
      readConfig: configReader(),
      capabilities: caps,
    });
    expect(reasonOf(cat, NO_GUARD)).toBe('guardrail-unsupported');
  });
});

describe('getModelCatalog: geography (AM-37 catalog half)', () => {
  it('derives the geo prefix from AWS_REGION', async () => {
    const eu = await getModelCatalog(baseOpts({ env: { ...ENV, AWS_REGION: 'eu-west-1' } }));
    expect(ids(eu)).toContain('eu.anthropic.claude-haiku-4-5');
    expect(ids(eu)).not.toContain('us.anthropic.claude-haiku-4-5');
    expect(ids(eu)).toContain('openai.gpt-oss-120b-1:0'); // ON_DEMAND is in-region wherever we run
    expect(ids(eu)).toEqual(expect.arrayContaining([SONNET, SONNET_1M])); // env entries are verbatim
  });

  it('unknown regions get in-region only', async () => {
    const ca = await getModelCatalog(baseOpts({ env: { ...ENV, AWS_REGION: 'ca-central-1' } }));
    expect(ids(ca)).toContain('openai.gpt-oss-120b-1:0');
    expect(ids(ca)).toContain('deepseek.v3-fixture');
    expect(reasonOf(ca, 'anthropic.claude-haiku-4-5')).toBe('no-geo-path');
    const discovered = ca.models.filter((m) => m.source === 'discovered');
    expect(discovered.some((m) => /^(us|eu|apac|global)\./.test(m.id))).toBe(false);
  });

  it('defaults to us-east-1 when AWS_REGION is absent', async () => {
    const noRegion: NodeJS.ProcessEnv = { BEDROCK_SONNET_MODEL: SONNET, BEDROCK_SONNET_1M_MODEL: SONNET_1M };
    const cat = await getModelCatalog(baseOpts({ env: noRegion }));
    expect(ids(cat)).toContain('us.anthropic.claude-haiku-4-5');
  });
});

// ── Failure modes ───────────────────────────────────────────────────

describe('getModelCatalog: failure modes (AM-02)', () => {
  it('a discovery error (AccessDenied) yields env-fallback and never throws', async () => {
    const cp = fakeControlPlane(FM_ROWS, PROFILE_PAGES);
    cp.listFoundationModels.mockRejectedValue(
      Object.assign(new Error('not authorized to perform: bedrock:ListFoundationModels'), {
        name: 'AccessDeniedException',
      }),
    );
    const cat = await getModelCatalog(baseOpts({ controlPlane: cp }));
    expect(cat.source).toBe('env-fallback');
    expect(ids(cat)).toEqual([SONNET, SONNET_1M]);
    expect(cat.models.every((m) => m.source === 'env')).toBe(true);
    expect(cat.excluded).toEqual([]);
  });

  it('a profile-listing error also yields env-fallback', async () => {
    const cp = fakeControlPlane(FM_ROWS, PROFILE_PAGES);
    cp.listInferenceProfiles.mockRejectedValue(new Error('boom'));
    const cat = await getModelCatalog(baseOpts({ controlPlane: cp }));
    expect(cat.source).toBe('env-fallback');
    expect(ids(cat)).toEqual([SONNET, SONNET_1M]);
  });

  it('makes zero control-plane calls when AWS_ENDPOINT_URL is set', async () => {
    const cp = fakeControlPlane(FM_ROWS, PROFILE_PAGES);
    const cat = await getModelCatalog(
      baseOpts({ controlPlane: cp, env: { ...ENV, AWS_ENDPOINT_URL: 'http://localhost:4566' } }),
    );
    expect(cp.listFoundationModels).not.toHaveBeenCalled();
    expect(cp.listInferenceProfiles).not.toHaveBeenCalled();
    expect(cat.source).toBe('env-fallback');
    expect(ids(cat)).toEqual([SONNET, SONNET_1M]);
  });
});

// ── Cache ───────────────────────────────────────────────────────────

describe('getModelCatalog: cache', () => {
  it('caches discovery for 6 hours on the default clock', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-14T00:00:00Z') });
    const cp = fakeControlPlane(FM_ROWS, PROFILE_PAGES);
    await getModelCatalog(baseOpts({ controlPlane: cp }));
    expect(cp.listFoundationModels).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(6 * 60 * 60 * 1000 - 1000);
    await getModelCatalog(baseOpts({ controlPlane: cp }));
    expect(cp.listFoundationModels).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(2000);
    await getModelCatalog(baseOpts({ controlPlane: cp }));
    expect(cp.listFoundationModels).toHaveBeenCalledTimes(2);
  });

  it('single-flight: concurrent callers share one discovery', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cp = fakeControlPlane(FM_ROWS, PROFILE_PAGES);
    cp.listFoundationModels.mockImplementation(async () => {
      await gate;
      return { modelSummaries: FM_ROWS };
    });
    const p1 = getModelCatalog(baseOpts({ controlPlane: cp }));
    const p2 = getModelCatalog(baseOpts({ controlPlane: cp }));
    release();
    const [a, b] = await Promise.all([p1, p2]);
    expect(cp.listFoundationModels).toHaveBeenCalledTimes(1);
    expect(a.source).toBe('discovered');
    expect(ids(a)).toEqual(ids(b));
  });

  it('keeps the last good result when a refresh fails (injected clock)', async () => {
    let t = 1_700_000_000_000;
    const cp = fakeControlPlane(FM_ROWS, PROFILE_PAGES);
    const first = await getModelCatalog(baseOpts({ controlPlane: cp, now: () => t }));
    expect(first.source).toBe('discovered');

    t += 7 * 60 * 60 * 1000;
    cp.listFoundationModels.mockRejectedValueOnce(
      Object.assign(new Error('boom'), { name: 'InternalServerException' }),
    );
    const second = await getModelCatalog(baseOpts({ controlPlane: cp, now: () => t }));
    expect(cp.listFoundationModels).toHaveBeenCalledTimes(2);
    expect(second.source).toBe('discovered');
    expect(ids(second)).toEqual(ids(first));
  });

  it('resetModelCatalogCache forces a fresh discovery', async () => {
    const cp = fakeControlPlane(FM_ROWS, PROFILE_PAGES);
    await getModelCatalog(baseOpts({ controlPlane: cp }));
    resetModelCatalogCache();
    await getModelCatalog(baseOpts({ controlPlane: cp }));
    expect(cp.listFoundationModels).toHaveBeenCalledTimes(2);
  });
});

// ── Discovery bounds, backoff and fail-closed reads (WI-1 correction 1) ──

const T0 = 1_700_000_000_000;

/** Starts a catalog call without awaiting it, so a hung discovery cannot hang the test. */
function track(pending: Promise<ModelCatalog>): { catalog?: ModelCatalog; error?: unknown } {
  const state: { catalog?: ModelCatalog; error?: unknown } = {};
  pending.then(
    (catalog) => {
      state.catalog = catalog;
    },
    (error: unknown) => {
      state.error = error;
    },
  );
  return state;
}

describe('getModelCatalog: discovery bounds (F1)', () => {
  it('bounds discovery with a 15 s deadline, a 60 s retry window and a 50-page profile cap', () => {
    expect(CATALOG_DISCOVERY_TIMEOUT_MS).toBe(15_000);
    expect(CATALOG_RETRY_AFTER_MS).toBe(60_000);
    expect(CATALOG_MAX_PROFILE_PAGES).toBe(50);
  });

  it('a discovery call that never settles yields env-fallback at the deadline', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-14T00:00:00Z') });
    const cp = fakeControlPlane(FM_ROWS, PROFILE_PAGES);
    cp.listFoundationModels.mockImplementation(() => new Promise<never>(() => {}));
    const call = track(getModelCatalog(baseOpts({ controlPlane: cp })));

    await vi.advanceTimersByTimeAsync(CATALOG_DISCOVERY_TIMEOUT_MS);
    expect(call.error).toBeUndefined();
    expect(call.catalog?.source).toBe('env-fallback');
    expect(call.catalog?.models.map((m) => m.id)).toEqual([SONNET, SONNET_1M]);
  });

  it('a refresh that never settles yields the last good discovery at the deadline', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-14T00:00:00Z') });
    const cp = fakeControlPlane(FM_ROWS, PROFILE_PAGES);
    const first = await getModelCatalog(baseOpts({ controlPlane: cp }));
    expect(first.source).toBe('discovered');

    vi.setSystemTime(Date.now() + CATALOG_TTL_MS);
    cp.listInferenceProfiles.mockImplementation(() => new Promise<never>(() => {}));
    const call = track(getModelCatalog(baseOpts({ controlPlane: cp })));

    await vi.advanceTimersByTimeAsync(CATALOG_DISCOVERY_TIMEOUT_MS);
    expect(call.error).toBeUndefined();
    expect(call.catalog?.source).toBe('discovered');
    expect(call.catalog?.models.map((m) => m.id)).toEqual(ids(first));
  });

  it('stops listing profiles when the next token repeats, and treats the discovery as failed', async () => {
    const cp = fakeControlPlane(FM_ROWS, PROFILE_PAGES);
    let calls = 0;
    // The fixture ends on its own after 1000 pages, so a missing guard fails instead of hanging.
    cp.listInferenceProfiles.mockImplementation(async () => ({
      inferenceProfileSummaries: [],
      ...(++calls < 1000 ? { nextToken: 'same-token' } : {}),
    }));
    const cat = await getModelCatalog(baseOpts({ controlPlane: cp }));
    expect(cp.listInferenceProfiles).toHaveBeenCalledTimes(2);
    expect(cat.source).toBe('env-fallback');
  });

  it('stops at CATALOG_MAX_PROFILE_PAGES when tokens never end, and treats the discovery as failed', async () => {
    const cp = fakeControlPlane(FM_ROWS, PROFILE_PAGES);
    let calls = 0;
    cp.listInferenceProfiles.mockImplementation(async () => ({
      inferenceProfileSummaries: [],
      ...(++calls < 1000 ? { nextToken: `page-${calls}` } : {}),
    }));
    const cat = await getModelCatalog(baseOpts({ controlPlane: cp }));
    expect(cp.listInferenceProfiles).toHaveBeenCalledTimes(CATALOG_MAX_PROFILE_PAGES);
    expect(cat.source).toBe('env-fallback');
  });
});

describe('getModelCatalog: failure backoff (F2)', () => {
  it('after a failed discovery, calls inside the retry window make no control-plane call; the next one retries', async () => {
    let t = T0;
    const cp = fakeControlPlane(FM_ROWS, PROFILE_PAGES);
    cp.listFoundationModels.mockRejectedValueOnce(
      Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' }),
    );
    const opts = baseOpts({ controlPlane: cp, now: () => t });
    expect((await getModelCatalog(opts)).source).toBe('env-fallback');

    for (let i = 0; i < 5; i += 1) {
      t += 10_000; // at most 50 s after the failure: inside the window
      const cat = await getModelCatalog(opts);
      expect(cat.source).toBe('env-fallback');
      expect(ids(cat)).toEqual([SONNET, SONNET_1M]);
    }
    expect(cp.listFoundationModels).toHaveBeenCalledTimes(1);
    expect(cp.listInferenceProfiles).not.toHaveBeenCalled();

    t = T0 + CATALOG_RETRY_AFTER_MS;
    const recovered = await getModelCatalog(opts);
    expect(cp.listFoundationModels).toHaveBeenCalledTimes(2);
    expect(recovered.source).toBe('discovered');
  });

  it('after a failed refresh, calls inside the retry window serve the last good discovery without a control-plane call', async () => {
    let t = T0;
    const cp = fakeControlPlane(FM_ROWS, PROFILE_PAGES);
    const opts = baseOpts({ controlPlane: cp, now: () => t });
    const first = await getModelCatalog(opts);

    t += CATALOG_TTL_MS;
    cp.listFoundationModels.mockRejectedValueOnce(new Error('boom'));
    expect((await getModelCatalog(opts)).source).toBe('discovered');
    expect(cp.listFoundationModels).toHaveBeenCalledTimes(2);

    for (let i = 0; i < 5; i += 1) {
      t += 10_000;
      const cat = await getModelCatalog(opts);
      expect(cat.source).toBe('discovered');
      expect(ids(cat)).toEqual(ids(first));
    }
    expect(cp.listFoundationModels).toHaveBeenCalledTimes(2);
  });
});

describe('getModelCatalog: default control plane (F1, F2, F4)', () => {
  beforeEach(() => {
    sdk.configs.length = 0;
    sdk.failConstruct = false;
    sdk.send.mockReset();
  });

  const defaultOpts = (now: () => number): GetModelCatalogOptions => ({
    env: ENV,
    readConfig: configReader(),
    guardrailConfigured: false,
    now,
  });

  it('builds one BedrockClient per region with a throwing request timeout, and reuses it for the retry', async () => {
    let t = T0;
    sdk.send.mockRejectedValueOnce(Object.assign(new Error('socket hang up'), { name: 'TimeoutError' }));
    sdk.send.mockImplementation(async (command) =>
      'typeEquals' in command.input
        ? { inferenceProfileSummaries: PROFILE_PAGES.flat() }
        : { modelSummaries: FM_ROWS },
    );

    expect((await getModelCatalog(defaultOpts(() => t))).source).toBe('env-fallback');
    t += CATALOG_RETRY_AFTER_MS;
    expect((await getModelCatalog(defaultOpts(() => t))).source).toBe('discovered');

    expect(sdk.configs).toHaveLength(1);
    expect(sdk.configs[0]).toMatchObject({
      region: 'us-east-1',
      requestHandler: { throwOnRequestTimeout: true },
    });
    const handler = (sdk.configs[0]?.requestHandler ?? {}) as { requestTimeout?: unknown };
    expect(handler.requestTimeout).toEqual(expect.any(Number));
    expect(handler.requestTimeout as number).toBeGreaterThan(0);
    expect(handler.requestTimeout as number).toBeLessThanOrEqual(CATALOG_DISCOVERY_TIMEOUT_MS);
  });

  it('a BedrockClient that cannot be constructed yields env-fallback and never rejects', async () => {
    sdk.failConstruct = true;
    const call = getModelCatalog(defaultOpts(() => T0));
    await expect(call).resolves.toMatchObject({ source: 'env-fallback' });
    expect(ids(await call)).toEqual([SONNET, SONNET_1M]);
  });
});

describe('getModelCatalog: a failing runtime-config reader fails closed (F4)', () => {
  it('a reader that rejects or throws keeps only Anthropic models and never rejects', async () => {
    const readers = {
      rejects: vi.fn(async (): Promise<string | undefined> => {
        throw new Error('fixture: runtime-config table unreachable');
      }),
      throws: vi.fn((): Promise<string | undefined> => {
        throw new Error('fixture: reader threw synchronously');
      }),
    };
    for (const [label, readConfig] of Object.entries(readers)) {
      resetModelCatalogCache();
      const call = getModelCatalog(baseOpts({ readConfig }));
      await expect(call, label).resolves.toMatchObject({ source: 'discovered' });
      const cat = await call;
      expect(cat.models.every((m) => m.canonicalId.startsWith('anthropic.')), label).toBe(true);
      expect(ids(cat), label).toContain('us.anthropic.claude-haiku-4-5');
      expect(reasonOf(cat, 'openai.gpt-oss-120b-1:0'), label).toBe('provider-not-approved');
    }
  });
});

describe('getModelCatalog: dated Anthropic ids fold into undated env ids (F6)', () => {
  it('lists Haiku 4.5 once when env holds the undated id and discovery returns the dated one', async () => {
    const env: NodeJS.ProcessEnv = { AWS_REGION: 'us-east-1', BEDROCK_HAIKU_MODEL: 'us.anthropic.claude-haiku-4-5' };
    const dated = 'anthropic.claude-haiku-4-5-20251001-v1:0';
    const cat = await getModelCatalog(
      baseOpts({ env, controlPlane: fakeControlPlane([fm(dated)], [[profile(`us.${dated}`)]]) }),
    );
    expect(cat.source).toBe('discovered');
    expect(ids(cat)).toEqual(['us.anthropic.claude-haiku-4-5']);
    expect(cat.models[0]?.source).toBe('env');
    expect(cat.excluded).toEqual([]);
  });

  it('folds only the exact dated form of an env id, never a longer model name', async () => {
    const env: NodeJS.ProcessEnv = { AWS_REGION: 'us-east-1', BEDROCK_SONNET_MODEL: 'us.anthropic.claude-sonnet-4' };
    const sonnet4 = 'anthropic.claude-sonnet-4-20250514-v1:0';
    const sonnet45 = 'anthropic.claude-sonnet-4-5-20250929-v1:0';
    const cat = await getModelCatalog(
      baseOpts({
        env,
        controlPlane: fakeControlPlane(
          [fm(sonnet4), fm(sonnet45)],
          [[profile(`us.${sonnet4}`), profile(`us.${sonnet45}`)]],
        ),
      }),
    );
    expect(ids(cat)).toEqual(['us.anthropic.claude-sonnet-4', `us.${sonnet45}`]);
    expect(cat.excluded).toEqual([]);
  });
});
