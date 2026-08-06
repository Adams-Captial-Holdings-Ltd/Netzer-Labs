/**
 * Image-generation model + serving-region resolution, mirroring the runtime
 * (src/lib/tools/nova-canvas-tools.ts) EXACTLY: explicit BEDROCK_IMAGE_MODEL,
 * the legacy BEDROCK_NOVA_CANVAS_MODEL alias, else the Stability default.
 * Stability generators exist only in us-west-2; Nova/Titan pins ride the
 * deploy region. BEDROCK_IMAGE_REGION overrides either way.
 *
 * The preflight and verify image checks both build on this so they validate
 * the model the orchestrator will actually invoke, in the region it will
 * invoke it — NOT a hardcoded model family in the deploy region (the drift
 * that made the old nova-canvas checks fail against working installs).
 *
 * Callers pass a `read` accessor so each check module keeps its own
 * placeholder-filtering convention (realValue). The runtime itself does not
 * placeholder-filter, but a literal REPLACE_ME model id is a broken config
 * either way.
 */

export const DEFAULT_IMAGE_MODEL = 'stability.stable-image-core-v1:1';

export interface ResolvedImageModel {
  modelId: string;
  region: string;
}

export function resolveImageModel(
  read: (key: string) => string,
  deployRegion: string,
): ResolvedImageModel {
  const modelId =
    read('BEDROCK_IMAGE_MODEL') || read('BEDROCK_NOVA_CANVAS_MODEL') || DEFAULT_IMAGE_MODEL;
  const isStability = modelId.startsWith('stability.');
  const region = read('BEDROCK_IMAGE_REGION') || (isStability ? 'us-west-2' : deployRegion);
  return { modelId, region };
}
