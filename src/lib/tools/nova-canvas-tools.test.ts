import { describe, it, expect } from 'vitest';
import { buildNovaBody } from './nova-canvas-tools.js';

describe('buildNovaBody', () => {
  it('produces the TEXT_IMAGE shape with no source image', () => {
    const body = buildNovaBody({
      mode: 'TEXT_IMAGE',
      prompt: 'a cat',
      width: 1024,
      height: 1024,
    });
    expect(body.taskType).toBe('TEXT_IMAGE');
    expect((body.textToImageParams as { text: string }).text).toBe('a cat');
  });

  it('forwards negative prompts', () => {
    const body = buildNovaBody({
      mode: 'TEXT_IMAGE',
      prompt: 'a cat',
      negative: 'no text',
      width: 1024,
      height: 1024,
    });
    expect((body.textToImageParams as { negativeText: string }).negativeText).toBe('no text');
  });

  it('INPAINTING includes source image and mask prompt', () => {
    const body = buildNovaBody({
      mode: 'INPAINTING',
      prompt: 'change the sky to night',
      width: 1024,
      height: 1024,
      sourceImageB64: 'abc',
      maskPrompt: 'the sky',
    });
    expect(body.taskType).toBe('INPAINTING');
    const params = body.inPaintingParams as { image: string; maskPrompt: string };
    expect(params.image).toBe('abc');
    expect(params.maskPrompt).toBe('the sky');
  });

  it('INPAINTING prefers maskImage when both are present', () => {
    const body = buildNovaBody({
      mode: 'INPAINTING',
      prompt: 'change region',
      width: 1024,
      height: 1024,
      sourceImageB64: 'abc',
      maskPrompt: 'the sky',
      maskImageB64: 'mask',
    });
    const params = body.inPaintingParams as { maskImage?: string; maskPrompt?: string };
    expect(params.maskImage).toBe('mask');
    expect(params.maskPrompt).toBeUndefined();
  });

  it('OUTPAINTING uses outPaintingMode DEFAULT', () => {
    const body = buildNovaBody({
      mode: 'OUTPAINTING',
      prompt: 'extend left',
      width: 1024,
      height: 1024,
      sourceImageB64: 'abc',
      maskPrompt: 'left edge',
    });
    expect(
      (body.outPaintingParams as { outPaintingMode: string }).outPaintingMode,
    ).toBe('DEFAULT');
  });

  it('IMAGE_VARIATION wraps source in an images array', () => {
    const body = buildNovaBody({
      mode: 'IMAGE_VARIATION',
      width: 1024,
      height: 1024,
      sourceImageB64: 'abc',
    });
    const params = body.imageVariationParams as { images: string[] };
    expect(params.images).toEqual(['abc']);
  });

  it('BACKGROUND_REMOVAL takes only the source image', () => {
    const body = buildNovaBody({
      mode: 'BACKGROUND_REMOVAL',
      width: 1024,
      height: 1024,
      sourceImageB64: 'abc',
    });
    expect(body.taskType).toBe('BACKGROUND_REMOVAL');
    expect((body.backgroundRemovalParams as { image: string }).image).toBe('abc');
    expect(body.imageGenerationConfig).toBeUndefined();
  });
});

describe('stability support (Nova Canvas went provider-legacy June 2026)', () => {
  it('maps width/height to the nearest stability aspect ratio', async () => {
    const { aspectRatioFor } = await import('./nova-canvas-tools.js');
    expect(aspectRatioFor(1024, 1024)).toBe('1:1');
    expect(aspectRatioFor(1024, 576)).toBe('16:9');
    expect(aspectRatioFor(576, 1024)).toBe('9:16');
    // 0.75 has no exact Stability ratio; 4:5 (0.8) is nearest by log distance
    expect(aspectRatioFor(768, 1024)).toBe('4:5');
  });

  it('builds the stability text-to-image body', async () => {
    const { buildStabilityBody } = await import('./nova-canvas-tools.js');
    const body = buildStabilityBody({ prompt: 'a phone', negative: 'no text', width: 1024, height: 1024 });
    expect(body).toEqual({
      prompt: 'a phone',
      negative_prompt: 'no text',
      aspect_ratio: '1:1',
      output_format: 'png',
    });
  });
});
