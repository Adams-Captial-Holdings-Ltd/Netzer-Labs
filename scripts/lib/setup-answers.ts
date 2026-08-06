/**
 * Noninteractive setup answers (IaC readiness item 38).
 *
 * `npm run setup -- --answers <file.json>` loads a JSON file keyed by STABLE
 * ids and runs the wizard without a single prompt — this is what makes docs
 * quickstart blocks executable by the release-time canary (a canary cannot
 * drive a wizard). Wizard-only SIDE EFFECTS still run in this mode: the STS
 * identity check, Bedrock InvokeModel probe, Docker daemon check, Slack
 * auth.test, and Telegram getMe all execute exactly as they do interactively.
 *
 * Contract: a validation failure in the answers file (or any value a question
 * would have rejected) is a HARD EXIT — never a fallback prompt. Optional
 * keys take the same defaults the wizard would show as the bracketed
 * suggestion. The answer schema is documented for operators in
 * docs/runnable-blocks.md and the canonical example fixture lives at
 * tests/fixtures/setup-answers.example.json.
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';

export const setupAnswersSchema = z
  .object({
    /** Q2 — AWS region (validated against the region shape, hard exit on mismatch). */
    awsRegion: z.string().min(1),
    /** Q6 — stack name prefix. Default: CCE. */
    cdkStackName: z.string().regex(/^[a-zA-Z][a-zA-Z0-9-]{0,127}$/).optional(),
    /** Q6 — deployment tier 0..3. */
    deployTier: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    /** Q6 — daily Bedrock cost cap (USD). Default: the tier default (5/50/200/1000). */
    dailyCostCapUsd: z.number().nonnegative().optional(),
    /** Q6 — enforce the cap from the first deploy (cost/cap_enabled seeded
     * 'true'; blocks paid turns past the cap, fail-closed). Default: true. */
    enforceDailyCostCap: z.boolean().optional(),
    /** Q8b — deployment mode. */
    deployMode: z.enum(['chat', 'infra-only']),
    /** Q8b — required when deployMode=chat; optional public HTTPS otherwise. */
    domainName: z.string().min(1).optional(),
    /** Q7 — optional; when present the signing secret is required too and auth.test runs. */
    slackBotToken: z.string().min(1).optional(),
    slackSigningSecret: z.string().min(1).optional(),
    /** Q8 — optional; when present getMe runs. */
    telegramToken: z.string().min(1).optional(),
    /** Q9 — dashboard credentials. Noninteractive mode auto-generates; `false`
     * only makes sense when an existing .env already carries a token. */
    dashboard: z
      .object({
        autoGenerate: z.boolean().default(true),
      })
      .default({ autoGenerate: true }),
    /** Q11b — capability add-ons. */
    addons: z
      .object({
        imageGen: z.boolean().optional(),
        tts: z.boolean().optional(),
        knowledge: z.boolean().optional(),
        jarvisVoice: z.boolean().optional(),
        webSearchVendor: z.enum(['tavily', 'brave', 'exa', 'serper', 'skip']).default('skip'),
        webSearchApiKey: z.string().min(1).optional(),
        emailFrom: z.string().min(1).optional(),
      })
      .default({ webSearchVendor: 'skip' }),
    /** Q11c — CI deploys. */
    ciMode: z.enum(['none', 'actions', 'codebuild']).default('none'),
    github: z
      .object({
        owner: z.string().min(1),
        repo: z.string().min(1),
        branch: z.string().min(1).optional(),
        deployRefs: z.string().min(1).optional(),
      })
      .optional(),
    /** Q11 — agent config directory. Default: ~/.claudeclaw-enterprise. */
    configDir: z.string().min(1).optional(),
    /** Q10 — manifest/state bucket. Default: claudeclaw-deploy-<account>-<region>. */
    manifestBucket: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((a, ctx) => {
    if (a.deployMode === 'chat' && !a.domainName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['domainName'],
        message: 'deployMode "chat" requires domainName (webhooks and dashboard auth need HTTPS)',
      });
    }
    if (a.deployMode === 'chat' && !a.slackBotToken && !a.telegramToken) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['deployMode'],
        message: 'deployMode "chat" requires at least one surface (slackBotToken or telegramToken)',
      });
    }
    if (a.slackBotToken && !a.slackSigningSecret) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['slackSigningSecret'],
        message: 'slackBotToken requires slackSigningSecret',
      });
    }
    if (a.ciMode !== 'none' && !a.github) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['github'],
        message: `ciMode "${a.ciMode}" requires github { owner, repo }`,
      });
    }
    if (
      a.addons.webSearchVendor !== 'skip' &&
      !a.addons.webSearchApiKey
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['addons', 'webSearchApiKey'],
        message: `webSearchVendor "${a.addons.webSearchVendor}" requires addons.webSearchApiKey`,
      });
    }
  });

export type SetupAnswers = z.infer<typeof setupAnswersSchema>;

/**
 * Load and validate an answers file. Throws with a readable multi-line
 * message on ANY problem — the caller hard-exits; there is no prompt
 * fallback in noninteractive mode.
 */
export function loadSetupAnswers(path: string): SetupAnswers {
  let text: string;
  try {
    text = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new Error(`cannot read answers file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new Error(`answers file ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = setupAnswersSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`answers file ${path} failed validation:\n${issues}`);
  }
  return parsed.data;
}

/** Extract the `--answers <file>` / `--answers=<file>` flag, if present. */
export function resolveAnswersFlag(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--answers') {
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        throw new Error('--answers requires a file path');
      }
      return next;
    }
    if (a.startsWith('--answers=')) {
      const v = a.slice('--answers='.length);
      if (!v) throw new Error('--answers requires a file path');
      return v;
    }
  }
  return null;
}
