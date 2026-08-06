/**
 * Tests for the runnable-block annotation validator (IaC readiness item 38).
 */

import { describe, expect, it } from 'vitest';
// @ts-expect-error — plain .mjs CI helper, no type declarations on purpose
import { extractBlocks, validateMeta, MODES } from './runnable-blocks.mjs';

const VALID = {
  id: 'quickstart-setup',
  mode: 'execute',
  cwd: '.',
  env: ['AWS_REGION'],
  requires: ['node>=20'],
  timeout: 120,
  asserts: ['exit0'],
};

describe('extractBlocks', () => {
  it('pairs an annotation with the following fenced block', () => {
    const md = [
      'Intro prose.',
      '<!-- runnable: {"id":"a-b","mode":"execute"} -->',
      '```bash',
      'npm run doctor',
      '```',
    ].join('\n');
    const { blocks, errors } = extractBlocks(md);
    expect(errors).toEqual([]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].meta.id).toBe('a-b');
    expect(blocks[0].code).toBe('npm run doctor');
    expect(blocks[0].lang).toBe('bash');
  });

  it('flags an annotation with no fenced block after it', () => {
    const { errors } = extractBlocks('<!-- runnable: {"id":"x","mode":"execute"} -->\njust prose');
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/not followed by a fenced code block/);
  });

  it('flags invalid JSON in the annotation', () => {
    const { errors } = extractBlocks('<!-- runnable: {id: nope} -->\n```\nx\n```');
    expect(errors[0]).toMatch(/not valid JSON/);
  });

  it('ignores ordinary fenced blocks without annotations', () => {
    const { blocks, errors } = extractBlocks('```bash\nnpm test\n```');
    expect(blocks).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe('validateMeta', () => {
  it('accepts the full valid shape and every mode', () => {
    expect(validateMeta(VALID)).toEqual([]);
    for (const mode of MODES as string[]) {
      expect(validateMeta({ id: 'x-1', mode })).toEqual([]);
    }
  });

  it('rejects bad ids, unknown modes, unknown keys, bad types', () => {
    expect(validateMeta({ ...VALID, id: 'Has Spaces' })).toContainEqual(
      expect.stringMatching(/id must be/),
    );
    expect(validateMeta({ ...VALID, mode: 'yolo' })).toContainEqual(
      expect.stringMatching(/mode must be one of/),
    );
    expect(validateMeta({ ...VALID, surprise: 1 })).toContainEqual(
      expect.stringMatching(/unknown key "surprise"/),
    );
    expect(validateMeta({ ...VALID, timeout: -5 })).toContainEqual(
      expect.stringMatching(/timeout/),
    );
    expect(validateMeta({ ...VALID, env: 'AWS_REGION' })).toContainEqual(
      expect.stringMatching(/env must be an array/),
    );
    expect(validateMeta({ ...VALID, asserts: ['exitO'] })).toContainEqual(
      expect.stringMatching(/unknown assert/),
    );
  });

  it('rejects an interactive wizard inside an execute block', () => {
    const errs = validateMeta({ id: 'setup', mode: 'execute' }, 'npm run setup');
    expect(errs).toContainEqual(expect.stringMatching(/--answers/));
    // The noninteractive form is fine.
    expect(
      validateMeta({ id: 'setup-ok', mode: 'execute' }, 'npm run setup -- --answers a.json'),
    ).toEqual([]);
    // And a manual-external block may legitimately MENTION the wizard.
    expect(validateMeta({ id: 'setup-doc', mode: 'manual-external' }, 'npm run setup')).toEqual([]);
  });
});
