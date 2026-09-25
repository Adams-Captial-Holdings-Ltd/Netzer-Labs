/** P4 WI-4.1: donor parser behavior, frozen gate G-1 and G-2. */
import { expect, it } from 'vitest';

const vendorPath = './vendor/librechat-update.js';

it('P4 grammar preserves nested code fences and repeated markers', async () => {
  const parser = await import(vendorPath).catch(() => null);
  expect(parser, 'the pinned artifact parser must be present').not.toBeNull();
  const text = [
    'before',
    ':::artifact{identifier="first" type="text/markdown" title="First"}',
    '```md',
    'line one',
    '::: inside the code fence',
    'line two',
    '```',
    ':::',
    'between',
    ':::artifact{identifier="second" type="text/plain" title="Second"}',
    'second body',
    ':::',
    'after',
  ].join('\n');
  const found = parser!.findAllArtifacts({ text });
  expect(found, 'two complete artifacts, with the inner marker kept inside the first').toHaveLength(2);
  expect(text.slice(found[0].start, found[0].end)).toContain('line two\n```\n:::');
  expect(text.slice(found[1].start, found[1].end)).toContain('second body\n:::');
});

it('P4 parser replacement handles adversarial whitespace in bounded time', async () => {
  const parser = await import(vendorPath).catch(() => null);
  expect(parser, 'the pinned parser must be present').not.toBeNull();
  const text = [
    ':::artifact{identifier="one" type="text/markdown" title="One"}',
    '```md',
    'ORIGINAL',
    '```',
    ':::',
  ].join('\n');
  const [artifact] = parser!.findAllArtifacts({ text });
  expect(artifact, 'the complete artifact must be found').toBeDefined();
  const adversarial = `UPDATED\n\`\`\`${' \n'.repeat(100_000)}X`;
  const updated = parser!.replaceArtifactContent(text, artifact, 'ORIGINAL', adversarial);
  expect(updated, 'replacement must finish and keep the near miss unchanged').toContain(adversarial);
}, 2_500);
