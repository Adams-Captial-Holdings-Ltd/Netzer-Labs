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

const grammarPath = './artifact-grammar.js';

it('P4 extraction accepts supported complete blocks with safe names', async () => {
  const grammar = await import(grammarPath).catch(() => null);
  expect(grammar, 'the dashboard artifact extraction seam must exist').not.toBeNull();
  const text = [
    'Here is the file.',
    ':::artifact{identifier="launch-notes" type="text/markdown" title="Launch Notes"}',
    '# Launch\nReady to review.',
    ':::',
    'End of reply.',
  ].join('\n');
  const result = grammar!.extractArtifactBlocks(text);
  expect(result.artifacts).toEqual([{
    identifier: 'launch-notes', title: 'Launch Notes', mimeType: 'text/markdown',
    body: '# Launch\nReady to review.',
  }]);
  expect(result.text).toContain('Here is the file.');
  expect(result.text).toContain('End of reply.');
  expect(result.text).not.toContain(':::artifact');
});

it('P4 extraction leaves malformed incomplete and unsupported blocks as text', async () => {
  const grammar = await import(grammarPath).catch(() => null);
  expect(grammar, 'the dashboard artifact extraction seam must exist').not.toBeNull();
  for (const source of [
    ':::artifact{identifier="a" type="text/markdown" title="A"}\nunfinished',
    ':::artifact{identifier="../escape" type="text/markdown" title="A"}\nbody\n:::',
    ':::artifact{identifier="a" type="application/x-sh" title="A"}\nbody\n:::',
    ':::artifact{identifier="a" type="text/markdown" title="bad\\r\\nname"}\nbody\n:::',
  ]) {
    expect(grammar!.extractArtifactBlocks(source), source).toEqual({ text: source, artifacts: [] });
  }
});

it('P4 extraction enforces text bytes and per turn artifact bounds', async () => {
  const grammar = await import(grammarPath).catch(() => null);
  expect(grammar, 'the dashboard artifact extraction seam must exist').not.toBeNull();
  const block = (id: string, body: string) =>
    `:::artifact{identifier="${id}" type="text/plain" title="${id}"}\n${body}\n:::`;
  expect(() => grammar!.extractArtifactBlocks(block('large', 'x'.repeat(1024 * 1024 + 1))))
    .toThrow(/size|large|limit|bytes/i);
  expect(() => grammar!.extractArtifactBlocks(Array.from({ length: 9 }, (_, i) => block(`a${i}`, 'ok')).join('\n')))
    .toThrow(/count|many|limit|artifacts/i);
});
