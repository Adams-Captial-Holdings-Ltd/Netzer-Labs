/**
 * Tests for the noninteractive setup answers loader (IaC readiness item 38).
 * Validates the SHIPPED example fixture against the schema so the docs can
 * point at it as the canonical answers file, plus the hard-exit semantics.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadSetupAnswers,
  resolveAnswersFlag,
  setupAnswersSchema,
} from './setup-answers.js';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const examplePath = join(repoRoot, 'tests', 'fixtures', 'setup-answers.example.json');

function writeTmp(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cce-answers-'));
  const p = join(dir, 'answers.json');
  writeFileSync(p, content);
  return p;
}

describe('setup answers', () => {
  it('the shipped example fixture validates', () => {
    const answers = loadSetupAnswers(examplePath);
    expect(answers.awsRegion).toBe('us-east-1');
    expect(answers.deployMode).toBe('infra-only');
    expect(answers.ciMode).toBe('none');
  });

  it('every shipped answers template validates (examples/answers/*.json)', () => {
    // AGENTS.md and the epilogue tell operators to start unattended installs
    // from these templates. A schema change that breaks one must fail HERE,
    // not in a user's terminal mid-install.
    const dir = join(repoRoot, 'examples', 'answers');
    const templates = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(templates.length).toBeGreaterThanOrEqual(3);
    for (const f of templates) {
      expect(() => loadSetupAnswers(join(dir, f)), f).not.toThrow();
    }
  });

  it('chat mode without a domain fails validation (hard exit, never a prompt)', () => {
    const p = writeTmp(
      JSON.stringify({
        awsRegion: 'us-east-1',
        deployTier: 1,
        deployMode: 'chat',
        telegramToken: '123:abc',
      }),
    );
    expect(() => loadSetupAnswers(p)).toThrow(/domainName/);
  });

  it('chat mode without any surface fails validation', () => {
    const p = writeTmp(
      JSON.stringify({
        awsRegion: 'us-east-1',
        deployTier: 1,
        deployMode: 'chat',
        domainName: 'cce.example.com',
      }),
    );
    expect(() => loadSetupAnswers(p)).toThrow(/at least one surface/);
  });

  it('slack token without signing secret fails validation', () => {
    const r = setupAnswersSchema.safeParse({
      awsRegion: 'us-east-1',
      deployTier: 1,
      deployMode: 'chat',
      domainName: 'cce.example.com',
      slackBotToken: 'xoxb-x',
    });
    expect(r.success).toBe(false);
  });

  it('ci mode without github coordinates fails validation', () => {
    const r = setupAnswersSchema.safeParse({
      awsRegion: 'us-east-1',
      deployTier: 1,
      deployMode: 'infra-only',
      ciMode: 'actions',
    });
    expect(r.success).toBe(false);
  });

  it('a web search vendor without a key fails validation', () => {
    const r = setupAnswersSchema.safeParse({
      awsRegion: 'us-east-1',
      deployTier: 1,
      deployMode: 'infra-only',
      addons: { webSearchVendor: 'tavily' },
    });
    expect(r.success).toBe(false);
  });

  it('enforceDailyCostCap accepts booleans and rejects junk', () => {
    const base = { awsRegion: 'us-east-1', deployTier: 1, deployMode: 'infra-only' };
    expect(setupAnswersSchema.safeParse({ ...base, enforceDailyCostCap: false }).success).toBe(true);
    expect(setupAnswersSchema.safeParse({ ...base, enforceDailyCostCap: true }).success).toBe(true);
    expect(setupAnswersSchema.safeParse({ ...base, enforceDailyCostCap: 'yes' }).success).toBe(false);
  });

  it('unknown keys are rejected (catches typos instead of silently ignoring)', () => {
    const r = setupAnswersSchema.safeParse({
      awsRegion: 'us-east-1',
      deployTier: 1,
      deployMode: 'infra-only',
      awsRegoin: 'oops',
    });
    expect(r.success).toBe(false);
  });

  it('invalid JSON throws a readable error', () => {
    const p = writeTmp('{nope');
    expect(() => loadSetupAnswers(p)).toThrow(/not valid JSON/);
  });
});

describe('resolveAnswersFlag', () => {
  it('parses both flag forms', () => {
    expect(resolveAnswersFlag(['--answers', 'a.json'])).toBe('a.json');
    expect(resolveAnswersFlag(['--answers=a.json'])).toBe('a.json');
    expect(resolveAnswersFlag([])).toBeNull();
  });
  it('rejects a missing path', () => {
    expect(() => resolveAnswersFlag(['--answers'])).toThrow();
    expect(() => resolveAnswersFlag(['--answers', '--json'])).toThrow();
  });
});
