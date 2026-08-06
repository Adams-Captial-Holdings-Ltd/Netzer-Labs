# Runnable docs blocks — the contract

> Plain English: some code blocks in these docs are not just illustrations —
> they are EXECUTED by the release-time canary against a scratch AWS account,
> so a quickstart that drifts from reality fails the release instead of
> failing the next newcomer. This page defines the annotation schema those
> blocks carry, and the answers-file format that lets `npm run setup` run
> without a human at the keyboard.

This is IaC readiness item 38. Per-PR docs CI only **validates** the
annotations (`scripts/ci/runnable-blocks.mjs` — hermetic, nothing executes);
**execution** happens at release time in the canary environment contract
(items 30/38: dedicated scratch account, Bedrock models pre-granted,
throwaway domain + cert, synthetic surface fixtures, seeded secrets,
assigned cleanup ownership).

## Annotation schema

A fenced code block becomes runnable when the line immediately above it (blank
lines allowed) is an HTML comment of this exact shape:

```text
<!-- runnable: {"id":"quickstart-setup","mode":"execute","cwd":".","env":["AWS_REGION"],"requires":["docker"],"timeout":120,"asserts":["exit0"]} -->
```

| Field      | Required | Meaning                                                                 |
| ---------- | -------- | ----------------------------------------------------------------------- |
| `id`       | yes      | Lowercase-kebab, unique across ALL docs + README. The canary's log key. |
| `mode`     | yes      | One of `execute`, `validate-prereq`, `manual-external`, `destructive`. |
| `cwd`      | no       | Working directory relative to the repo root. Default `.`.              |
| `env`      | no       | Env var names the block expects to be set (canary verifies presence).  |
| `requires` | no       | Prerequisite ids/tools (e.g. `docker`, another block's `id`).          |
| `timeout`  | no       | Seconds before the canary kills the block. Default 120.                |
| `asserts`  | no       | Post-conditions. Currently: `exit0`.                                   |

### Modes

- **`execute`** — the canary runs the block verbatim. The command MUST be
  noninteractive (flag-driven, no wizard prompts, no editor spawns). A bare
  `npm run setup` in an execute block fails validation; use
  `npm run setup -- --answers <file.json>`.
- **`validate-prereq`** — console-only or external steps the canary cannot
  perform (Bedrock model-access grants in the AWS console, creating a Slack
  app). The block documents the manual step; the canary runs the matching
  CHECK instead (e.g. `npm run doctor` validates the grant exists) and fails
  if the prerequisite is absent.
- **`manual-external`** — steps outside AWS and outside the repo entirely
  (BotFather conversations, registrar DNS). Documented, surfaced in canary
  output as "assumed done", never executed or checked automatically.
- **`destructive`** — teardown-class blocks. They run LAST, opt-in
  (the canary must be invoked with destructive blocks enabled), never in the
  default pass.

### Rules enforced per PR (hermetically)

`node scripts/ci/runnable-blocks.mjs` fails the PR when: the JSON does not
parse, required keys are missing, `mode` is unknown, `id` collides or is
malformed, types are wrong, the annotation has no fenced block attached, or
an `execute`/`destructive` block contains an interactive wizard invocation.

## The setup answers file (noninteractive mode)

`npm run setup -- --answers <file.json>` supplies every wizard answer by
stable key. This exists because **the canary cannot drive a wizard** — and it
doubles as the repeatable-install path for operators. Two properties to know:

1. **Side effects still run.** The STS identity check, the Bedrock
   InvokeModel probe, the Docker daemon check, Slack `auth.test`, and
   Telegram `getMe` all execute exactly as in interactive mode. The answers
   file replaces the *prompts*, not the *verification*.
2. **Validation failures hard-exit.** A malformed file, an unknown key, or a
   value any question would reject exits non-zero immediately. There is never
   a fallback prompt.

Canonical example: [`tests/fixtures/setup-answers.example.json`](../tests/fixtures/setup-answers.example.json).
The schema is enforced by `scripts/lib/setup-answers.ts` (zod, `strict` —
typos in key names are errors, not silently ignored).
Ready-to-edit operator templates (cheapest infra-only install, Telegram
chat install) live in [`examples/answers/`](../examples/answers/README.md);
they are what `npm run up -- --answers <file> --yes` expects.

### Answer keys

| Key                       | Type / values                                  | Required | Notes |
| ------------------------- | ---------------------------------------------- | -------- | ----- |
| `awsRegion`               | string, e.g. `us-east-1`                       | yes      | Same region-shape validation as the wizard. |
| `cdkStackName`            | string                                         | no       | Default `CCE`. CloudFormation name rules. |
| `deployTier`              | `0` \| `1` \| `2` \| `3`                       | yes      | Hobby / Standard / Pro / Enterprise. |
| `dailyCostCapUsd`         | number ≥ 0                                     | no       | Default: tier default (5/50/200/1000). |
| `enforceDailyCostCap`     | boolean                                        | no       | Default: `true`. Seeds `cost/cap_enabled` so the cap blocks paid turns from the first deploy (fail-closed). `false` keeps the cap saved but not enforced. |
| `deployMode`              | `"chat"` \| `"infra-only"`                     | yes      | `chat` requires `domainName` AND at least one surface token. |
| `domainName`              | string                                         | chat: yes | Optional in `infra-only` (enables public HTTPS dashboard). |
| `slackBotToken`           | string (`xoxb-...`)                            | no       | When present, `slackSigningSecret` is required and `auth.test` runs. |
| `slackSigningSecret`      | string (32-char hex)                           | with Slack | |
| `telegramToken`           | string                                         | no       | When present, `getMe` runs. |
| `dashboard.autoGenerate`  | boolean                                        | no (default `true`) | `false` is only valid when an existing `.env` already has a token. PINs are never set noninteractively. |
| `addons.imageGen`         | boolean                                        | no       | Default: tier ≥ 2. Needs the Nova Canvas grant. |
| `addons.tts`              | boolean                                        | no       | Default `true` (Polly). |
| `addons.knowledge`        | boolean                                        | no       | Default `true`. Needs the Titan embeddings grant. |
| `addons.jarvisVoice`      | boolean                                        | no       | Default: tier ≥ 2. Needs the Nova Sonic grant. |
| `addons.webSearchVendor`  | `tavily`\|`brave`\|`exa`\|`serper`\|`skip`     | no (default `skip`) | Non-skip requires `addons.webSearchApiKey`. |
| `addons.webSearchApiKey`  | string                                         | with vendor | |
| `addons.emailFrom`        | string, verified SES sender                    | no       | Presence enables `send_email`. |
| `ciMode`                  | `none` \| `actions` \| `codebuild`             | no (default `none`) | Non-none requires `github`. |
| `github.owner`            | string                                         | with CI  | |
| `github.repo`             | string                                         | with CI  | |
| `github.branch`           | string                                         | no       | codebuild only; default `main`. |
| `github.deployRefs`       | string (CSV of refs)                           | no       | actions only; default `refs/heads/main`. |
| `configDir`               | string path                                    | no       | Default `~/.claudeclaw-enterprise`. |
| `manifestBucket`          | string (S3 bucket name)                        | no       | Default `claudeclaw-deploy-<account>-<region>`. |

Secrets note: an answers file containing tokens is a credential at rest —
give it `.env`-grade handling (never commit it; the repo's `.gitignore` does
not cover arbitrary answer files you create). The canary's fixture answers
use synthetic surface apps.

### Example invocation

The annotated form a quickstart uses:

<!-- runnable: {"id":"setup-noninteractive-example","mode":"execute","cwd":".","requires":["docker"],"timeout":300,"asserts":["exit0"]} -->
```bash
npm run setup -- --answers tests/fixtures/setup-answers.example.json
```

(That example file is `infra-only`, tier 1, no surfaces, no CI — the minimal
shape that can complete without any external accounts.)
