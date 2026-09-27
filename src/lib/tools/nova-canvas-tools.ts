/**
 * Nova Canvas image generation + editing tool (C6).
 *
 * Single Bedrock-native image tool that supports five modes:
 *
 *   - TEXT_IMAGE         generate from a prompt (default; the model
 *                        picks this when the user has no source image)
 *   - INPAINTING         edit a masked region of an existing image
 *   - OUTPAINTING        extend an image beyond its frame
 *   - IMAGE_VARIATION    generate variations of a source image
 *   - BACKGROUND_REMOVAL strip background to transparent
 *
 * Source images come in as a base64 PNG or an S3 URI inside our raw
 * bucket; we never let the model pass arbitrary http URLs to keep
 * Bedrock invocations to our own data.
 *
 * Bot outputs land in the raw bucket under `generations/<chat>/<ulid>.png`
 * and are returned as a presigned URL. Dashboard outputs use durable,
 * owner-scoped artifact storage and never expose a storage URL to the model.
 *
 * Cost: ~$0.06 per 1024x1024 image. Gated by:
 *   - tool kill switch `image_gen_disabled`
 *   - per-turn limit (1 image per agent turn)
 *   - daily cost cap kill switch (existing)
 */

import type { Tool as BedrockTool } from '@aws-sdk/client-bedrock-runtime';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import {
  PutObjectCommand,
  S3Client,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import { tools } from './registry.js';
import { registerIfConfigured } from '../addons/registry.js';
import { isKillSwitchActive } from '../state/kill-switches-repo.js';
import { guardedBedrockSend } from '../bedrock/guard.js';
import { writeAudit } from '../audit/audit-writer.js';
import { logger } from '../../observability/logger.js';
import { getDailyCostUsd, SpendIndeterminateError } from '../usage/token-tracker.js';
import { getEffectiveCostCap, isCostCapEnforced } from '../state/cost-cap-repo.js';
import { getConfig } from '../state/runtime-config-repo.js';
import { checkAndConsumeStrict } from '../state/rate-limits-repo.js';
import { captureAwsClient } from '../observability/xray.js';
import { saveArtifact } from '../chat/artifacts-repo.js';
import type { ToolContext, ToolResult } from './registry.js';

const region = process.env.AWS_REGION ?? 'us-east-1';
// June 2026: Amazon flagged nova-canvas-v1 (and titan-image v2) LEGACY and
// Bedrock refuses invocation for accounts not already using them ("Access
// denied. This Model is marked by provider as Legacy"). The ACTIVE
// text-to-image generators live under the stability.* namespace — and only
// in us-west-2 — so the default moved there. BEDROCK_IMAGE_MODEL overrides
// (BEDROCK_NOVA_CANVAS_MODEL kept as a back-compat alias); installs that
// still have Canvas access can pin it back and keep the editing modes.
const MODEL_ID =
  process.env.BEDROCK_IMAGE_MODEL ??
  process.env.BEDROCK_NOVA_CANVAS_MODEL ??
  'stability.stable-image-core-v1:1';
const IS_STABILITY = MODEL_ID.startsWith('stability.');
// Stability generators are us-west-2-only; Nova/Titan ride the deploy region.
const IMAGE_REGION =
  process.env.BEDROCK_IMAGE_REGION ?? (IS_STABILITY ? 'us-west-2' : region);
const RAW_BUCKET = process.env.RAW_BUCKET ?? '';
const PRESIGN_TTL_SEC = 60 * 60 * 24; // 24h

let _bedrock: BedrockRuntimeClient | null = null;
function bedrock(): BedrockRuntimeClient {
  if (!_bedrock) _bedrock = captureAwsClient(new BedrockRuntimeClient({ region: IMAGE_REGION }));
  return _bedrock;
}
let _s3: S3Client | null = null;
function s3(): S3Client {
  if (!_s3) _s3 = captureAwsClient(new S3Client({ region }));
  return _s3;
}

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

function isDashboardContext(ctx: ToolContext): boolean {
  return ctx.surface === 'dashboard' || ctx.chatId.startsWith('dashboard:');
}

function hasStableDashboardOwner(ctx: ToolContext): boolean {
  return ctx.surface === 'dashboard' &&
    typeof ctx.userId === 'string' && ctx.userId.startsWith('dashboard:user:') &&
    ctx.chatId.startsWith('dashboard:');
}

function abortedResult(): ToolResult {
  return { text: 'Image generation was stopped before storage.', isError: true };
}

interface NovaCanvasResponse {
  images?: string[];
  error?: string;
}

/**
 * Fetch a source image as base64. Accepts:
 *   - `s3://<bucket>/<key>` inside the deploy's raw bucket
 *   - bare base64 PNG/JPEG (the model can paste the bytes back in)
 *
 * Foreign HTTP URLs are intentionally not supported. The model should
 * receive an S3 URI we minted (e.g., from generate_image's previous
 * call) or a base64 blob the human attached.
 *
 * Throws on validation errors so the caller can map them to an
 * isError ToolResult.
 */
async function loadSourceImage(input: string): Promise<string> {
  const value = input.trim();
  if (value.startsWith('s3://')) {
    const without = value.slice('s3://'.length);
    const slash = without.indexOf('/');
    if (slash <= 0) {
      throw new Error('source image S3 URI must be s3://<bucket>/<key>');
    }
    const bucket = without.slice(0, slash);
    const key = without.slice(slash + 1);
    if (bucket !== RAW_BUCKET) {
      throw new Error(
        `source image S3 bucket must be the deploy raw bucket (${RAW_BUCKET}); got ${bucket}`,
      );
    }
    const obj = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!obj.Body) throw new Error(`source image not found: s3://${bucket}/${key}`);
    const buf = Buffer.from(await obj.Body.transformToByteArray());
    return buf.toString('base64');
  }
  // Strip a `data:image/...;base64,` prefix if the model echoed one.
  const prefixMatch = /^data:image\/[a-z]+;base64,(.*)$/.exec(value);
  const raw = prefixMatch ? prefixMatch[1] : value;
  // Basic sanity check — base64 PNGs are >=100 chars in practice; any
  // shorter and the SDK will throw anyway, but our error is clearer.
  if (raw.length < 100) {
    throw new Error('source image base64 looks empty or malformed');
  }
  return raw;
}

type NovaMode =
  | 'TEXT_IMAGE'
  | 'INPAINTING'
  | 'OUTPAINTING'
  | 'IMAGE_VARIATION'
  | 'BACKGROUND_REMOVAL';

const VALID_MODES: readonly NovaMode[] = [
  'TEXT_IMAGE',
  'INPAINTING',
  'OUTPAINTING',
  'IMAGE_VARIATION',
  'BACKGROUND_REMOVAL',
] as const;

/** Build the per-mode Nova Canvas request body. */
export function buildNovaBody(args: {
  mode: NovaMode;
  prompt?: string;
  negative?: string;
  width: number;
  height: number;
  sourceImageB64?: string;
  maskImageB64?: string;
  maskPrompt?: string;
}): Record<string, unknown> {
  const config = {
    numberOfImages: 1,
    width: args.width,
    height: args.height,
    cfgScale: 7.5,
    quality: 'standard',
  };
  switch (args.mode) {
    case 'TEXT_IMAGE':
      return {
        taskType: 'TEXT_IMAGE',
        textToImageParams: {
          text: args.prompt ?? '',
          ...(args.negative ? { negativeText: args.negative } : {}),
        },
        imageGenerationConfig: config,
      };
    case 'INPAINTING':
      return {
        taskType: 'INPAINTING',
        inPaintingParams: {
          text: args.prompt ?? '',
          ...(args.negative ? { negativeText: args.negative } : {}),
          image: args.sourceImageB64,
          ...(args.maskImageB64
            ? { maskImage: args.maskImageB64 }
            : args.maskPrompt
              ? { maskPrompt: args.maskPrompt }
              : {}),
        },
        imageGenerationConfig: config,
      };
    case 'OUTPAINTING':
      return {
        taskType: 'OUTPAINTING',
        outPaintingParams: {
          text: args.prompt ?? '',
          ...(args.negative ? { negativeText: args.negative } : {}),
          image: args.sourceImageB64,
          ...(args.maskImageB64
            ? { maskImage: args.maskImageB64 }
            : args.maskPrompt
              ? { maskPrompt: args.maskPrompt }
              : {}),
          outPaintingMode: 'DEFAULT',
        },
        imageGenerationConfig: config,
      };
    case 'IMAGE_VARIATION':
      return {
        taskType: 'IMAGE_VARIATION',
        imageVariationParams: {
          images: [args.sourceImageB64],
          ...(args.prompt ? { text: args.prompt } : {}),
          ...(args.negative ? { negativeText: args.negative } : {}),
          similarityStrength: 0.7,
        },
        imageGenerationConfig: config,
      };
    case 'BACKGROUND_REMOVAL':
      return {
        taskType: 'BACKGROUND_REMOVAL',
        backgroundRemovalParams: {
          image: args.sourceImageB64,
        },
      };
  }
}

/** Stability generators take an aspect ratio, not pixel dims — map the
 * tool's width/height enums to the nearest supported ratio. */
export function aspectRatioFor(width: number, height: number): string {
  const ratio = width / height;
  const options: Array<[string, number]> = [
    ['1:1', 1],
    ['16:9', 16 / 9],
    ['9:16', 9 / 16],
    ['3:2', 3 / 2],
    ['2:3', 2 / 3],
    ['5:4', 5 / 4],
    ['4:5', 4 / 5],
    ['21:9', 21 / 9],
    ['9:21', 9 / 21],
  ];
  let best = '1:1';
  let bestDist = Number.POSITIVE_INFINITY;
  for (const [label, r] of options) {
    const dist = Math.abs(Math.log(ratio / r));
    if (dist < bestDist) {
      bestDist = dist;
      best = label;
    }
  }
  return best;
}

/** Request body for stability.* text-to-image (stable-image-core/ultra, sd3.5). */
export function buildStabilityBody(args: {
  prompt: string;
  negative?: string;
  width: number;
  height: number;
}): Record<string, unknown> {
  return {
    prompt: args.prompt,
    ...(args.negative ? { negative_prompt: args.negative } : {}),
    aspect_ratio: aspectRatioFor(args.width, args.height),
    output_format: 'png',
  };
}

registerIfConfigured(
  {
    id: 'image_gen_nova',
    title: 'Image generation (Nova Canvas)',
    category: 'tool',
    description: 'Bedrock-native image generation. No external vendor key.',
    required: [
      { envVar: 'RAW_BUCKET', description: 'S3 raw bucket for generated images' },
      { envVar: 'CCE_IMAGE_GEN_ENABLED', description: 'Tier-level enable flag (defaults on)' },
    ],
    killSwitch: 'image_gen_disabled',
    defaultOn: true,
  },
  () => {
    tools.register('generate_image', {
      spec: spec(
        'generate_image',
        IS_STABILITY
          ? 'Generate an image from a text prompt (Bedrock Stability model). Only TEXT_IMAGE mode is available. The image is delivered to the chat and a presigned S3 URL (valid 24h) is returned.'
          : 'Generate or edit an image via Amazon Nova Canvas. Modes: TEXT_IMAGE (default, generate from prompt), INPAINTING (edit a region described by mask_prompt), OUTPAINTING (extend an image beyond its frame), IMAGE_VARIATION (variations of an existing image), BACKGROUND_REMOVAL (transparent background). Returns a presigned S3 URL valid 24h.',
        {
          type: 'object',
          required: ['prompt'],
          properties: {
            mode: {
              type: 'string',
              enum: [
                'TEXT_IMAGE',
                'INPAINTING',
                'OUTPAINTING',
                'IMAGE_VARIATION',
                'BACKGROUND_REMOVAL',
              ],
              description:
                'Editing mode. Defaults TEXT_IMAGE. Modes other than TEXT_IMAGE require source_image.',
            },
            prompt: {
              type: 'string',
              description:
                'For TEXT_IMAGE/INPAINTING/OUTPAINTING: what to draw. For IMAGE_VARIATION: optional steering. Ignored for BACKGROUND_REMOVAL.',
            },
            negative_prompt: {
              type: 'string',
              description: 'Things to exclude (text artifacts, extra limbs, etc.).',
            },
            width: {
              type: 'integer',
              enum: [512, 768, 1024],
              description: 'Width in px. Defaults 1024.',
            },
            height: {
              type: 'integer',
              enum: [512, 768, 1024],
              description: 'Height in px. Defaults 1024.',
            },
            source_image: {
              type: 'string',
              description:
                'Required for INPAINTING / OUTPAINTING / IMAGE_VARIATION / BACKGROUND_REMOVAL. Accept either an s3://<deploy-raw-bucket>/<key> URI or base64 PNG bytes (with or without data: prefix). External HTTP URLs are not supported.',
            },
            mask_prompt: {
              type: 'string',
              description:
                'For INPAINTING / OUTPAINTING: natural-language description of the region to edit (e.g., "the sky", "the chair on the left"). Either mask_prompt or mask_image is required for those modes.',
            },
            mask_image: {
              type: 'string',
              description:
                'Optional explicit mask: base64 black/white PNG where white = edit region. Overrides mask_prompt when both are provided.',
            },
          },
        },
      ),
      async invoke(args, ctx) {
        const isDashboard = isDashboardContext(ctx);
        if (isDashboard && !hasStableDashboardOwner(ctx)) {
          return {
            text: 'Image generation requires a stable, person-owned dashboard conversation.',
            isError: true,
          };
        }
        const killed = await isKillSwitchActive('image_gen_disabled');
        if (killed.active) {
          return {
            text: `Image generation is disabled: ${killed.reason ?? 'no reason given'}`,
            isError: true,
          };
        }
        const enabled = (await getConfig('images', 'enabled')) ?? '1';
        if (enabled === '0') {
          return { text: 'Image generation is switched off (images/enabled).', isError: true };
        }
        // Global per-day count guard, independent of the dollar cap: images
        // are the easiest tool to burn money with, so a flat daily ceiling
        // backstops runaway loops. Operator-tunable via images/daily_limit
        // and the Rate Limits page (scope image_gen_daily).
        const dailyLimit = Math.max(
          1,
          Number((await getConfig('images', 'daily_limit')) ?? 25),
        );
        const quota = await checkAndConsumeStrict('global', 'image_gen_daily', {
          limit: dailyLimit,
          windowSec: 86_400,
        });
        if (!quota.allowed) {
          return {
            text: `Daily image budget reached (${dailyLimit}/day). Try again tomorrow or raise images/daily_limit.`,
            isError: true,
          };
        }
        // Image generation is ~30-100x the cost of a text turn, so the
        // cost cap is re-checked here even though the agent loop already
        // checks it once per turn. A long-running tool chain shouldn't be
        // able to burn through the daily cap on image calls between
        // turn-level checks. Honors the kill switch AND the cap_enabled flag.
        if (await isCostCapEnforced()) {
          const capUsd = await getEffectiveCostCap();
          if (Number.isFinite(capUsd)) {
            // Strict read: an indeterminate spend total fails CLOSED (refuse the
            // image call) instead of running on an understated partial total.
            let spend: number;
            try {
              spend = await getDailyCostUsd({ strict: true });
            } catch (err) {
              if (err instanceof SpendIndeterminateError) {
                return {
                  text: 'Daily cost cap could not be verified (spend total is indeterminate). Image generation refused.',
                  isError: true,
                };
              }
              throw err;
            }
            if (spend >= capUsd) {
              return {
                text: `Daily cost cap exceeded ($${spend.toFixed(4)} >= $${capUsd}). Image generation refused.`,
                isError: true,
              };
            }
          }
        }
        const rawMode = String(args.mode ?? 'TEXT_IMAGE').toUpperCase() as NovaMode;
        if (!VALID_MODES.includes(rawMode)) {
          return { text: `Unknown mode ${rawMode}`, isError: true };
        }
        const mode: NovaMode = rawMode;
        const prompt = String(args.prompt ?? '').trim();
        if (mode === 'TEXT_IMAGE' && !prompt) {
          return { text: 'prompt is required for TEXT_IMAGE', isError: true };
        }
        const needsSource =
          mode === 'INPAINTING' ||
          mode === 'OUTPAINTING' ||
          mode === 'IMAGE_VARIATION' ||
          mode === 'BACKGROUND_REMOVAL';
        if (IS_STABILITY && mode !== 'TEXT_IMAGE') {
          // Stability splits editing into separate per-operation model ids;
          // only generation is wired. Editing modes return when an install
          // pins a Nova Canvas-capable model via BEDROCK_IMAGE_MODEL.
          return {
            text: `${mode} is not available with the current image model (${MODEL_ID}); only TEXT_IMAGE generation is supported.`,
            isError: true,
          };
        }
        let sourceImageB64: string | undefined;
        if (needsSource) {
          const src = String(args.source_image ?? '').trim();
          if (!src) {
            return {
              text: `source_image is required for ${mode}`,
              isError: true,
            };
          }
          try {
            sourceImageB64 = await loadSourceImage(src);
          } catch (err) {
            return {
              text: isDashboard
                ? 'Source image could not be loaded or validated.'
                : err instanceof Error ? err.message : String(err),
              isError: true,
            };
          }
        }
        const maskPrompt =
          typeof args.mask_prompt === 'string' && args.mask_prompt
            ? args.mask_prompt
            : undefined;
        const maskImageB64 =
          typeof args.mask_image === 'string' && args.mask_image
            ? args.mask_image
            : undefined;
        if (
          (mode === 'INPAINTING' || mode === 'OUTPAINTING') &&
          !maskPrompt &&
          !maskImageB64
        ) {
          return {
            text: `${mode} requires mask_prompt or mask_image`,
            isError: true,
          };
        }
        const negative =
          typeof args.negative_prompt === 'string' ? args.negative_prompt : undefined;
        const width = Number.isFinite(args.width) ? Number(args.width) : 1024;
        const height = Number.isFinite(args.height) ? Number(args.height) : 1024;
        if (ctx.abortSignal?.aborted) return abortedResult();
        const t0 = Date.now();
        try {
          const requestBody = IS_STABILITY
            ? buildStabilityBody({ prompt, negative, width, height })
            : buildNovaBody({
                mode,
                prompt,
                negative,
                width,
                height,
                sourceImageB64,
                maskImageB64,
                maskPrompt,
              });
          const resp = await guardedBedrockSend(() =>
            bedrock().send(
              new InvokeModelCommand({
                modelId: MODEL_ID,
                contentType: 'application/json',
                accept: 'application/json',
                body: JSON.stringify(requestBody),
              }),
            ),
          );
          const body = JSON.parse(new TextDecoder().decode(resp.body)) as NovaCanvasResponse & {
            errors?: string[];
            finish_reasons?: Array<string | null>;
          };
          if (body.error) {
            return {
              text: isDashboard ? 'Image generation failed in the image model.' : `Image model error: ${body.error}`,
              isError: true,
            };
          }
          if (body.errors?.length) {
            return {
              text: isDashboard ? 'Image generation failed in the image model.' : `Image model error: ${body.errors.join('; ')}`,
              isError: true,
            };
          }
          // Stability signals a content-filter hit via a non-null finish reason.
          const filtered = body.finish_reasons?.find((r) => r);
          if (filtered) {
            return { text: `Image request was filtered by the model (${filtered}). Rephrase the prompt.`, isError: true };
          }
          const base64 = body.images?.[0];
          if (!base64) {
            return { text: 'Image model returned no image', isError: true };
          }
          const bytes = Buffer.from(base64, 'base64');
          if (ctx.abortSignal?.aborted) return abortedResult();
          if (isDashboard) {
            try {
              const descriptor = await saveArtifact({
                agentId: ctx.agentId,
                chatId: ctx.chatId,
                ownerId: ctx.userId!,
                fileName: `image-${mode.toLowerCase()}.png`,
                contentType: 'image/png',
                body: bytes,
                source: { kind: 'generated', mode, prompt: prompt.slice(0, 200), width, height },
              });
              const latencyMs = Date.now() - t0;
              logger.info(
                { agentId: ctx.agentId, chatId: ctx.chatId, mode, width, height, latencyMs },
                'dashboard image generated',
              );
              void writeAudit({
                action: 'tool_invoke',
                agentId: ctx.agentId,
                chatId: ctx.chatId,
                toolName: 'generate_image',
                detail: { mode, width, height, latencyMs,
                  artifactId: descriptor.artifactId, version: descriptor.version },
                result: 'ok',
              });
              return {
                text: `Image (${mode}, ${width}x${height}) generated and saved to this conversation's artifacts.`,
                artifacts: [descriptor],
              };
            } catch {
              logger.warn({ agentId: ctx.agentId, chatId: ctx.chatId, mode }, 'dashboard image storage failed');
              void writeAudit({
                action: 'tool_invoke',
                agentId: ctx.agentId,
                chatId: ctx.chatId,
                toolName: 'generate_image',
                detail: { mode },
                result: 'error',
              });
              return { text: 'Image could not be saved to this conversation. Please try again.', isError: true };
            }
          }
          const id = randomUUID();
          const key = `generations/${ctx.chatId.replace(/[^A-Za-z0-9_-]/g, '_')}/${id}.png`;
          await s3().send(
            new PutObjectCommand({
              Bucket: RAW_BUCKET,
              Key: key,
              Body: bytes,
              ContentType: 'image/png',
              Metadata: {
                'agent-id': ctx.agentId,
                'chat-id': ctx.chatId,
                prompt: prompt.slice(0, 200),
              },
            }),
          );
          const url = await getSignedUrl(
            s3(),
            new GetObjectCommand({ Bucket: RAW_BUCKET, Key: key }),
            { expiresIn: PRESIGN_TTL_SEC },
          );
          const latencyMs = Date.now() - t0;
          logger.info(
            { agentId: ctx.agentId, chatId: ctx.chatId, key, latencyMs, width, height },
            'image generated',
          );
          void writeAudit({
            action: 'tool_invoke',
            agentId: ctx.agentId,
            chatId: ctx.chatId,
            toolName: 'generate_image',
            detail: { key, width, height, latencyMs, mode },
            result: 'ok',
          });
          return {
            text: `Image (${mode}, ${width}x${height}). URL valid 24h:\n${url}`,
            // The surface delivers the actual image (Telegram photo, Slack
            // file upload, dashboard <img>) after the turn — the URL in the
            // text is just the fallback.
            media: [
              {
                kind: 'image',
                s3Bucket: RAW_BUCKET,
                s3Key: key,
                contentType: 'image/png',
                presignedUrl: url,
                caption: prompt.slice(0, 200) || mode,
              },
            ],
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (isDashboard) {
            logger.warn({ agentId: ctx.agentId, chatId: ctx.chatId, mode }, 'dashboard image generation failed');
            void writeAudit({
              action: 'tool_invoke',
              agentId: ctx.agentId,
              chatId: ctx.chatId,
              toolName: 'generate_image',
              detail: { mode },
              result: 'error',
            });
            return { text: 'Image generation failed. Please try again.', isError: true };
          }
          logger.warn({ errMessage: msg }, 'image generation failed');
          return { text: `Image generation failed: ${msg}`, isError: true };
        }
      },
    });
  },
);
