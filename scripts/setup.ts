/**
 * Netzar OS Enterprise — Setup Wizard
 *
 * Twelve-question interactive setup. Each question must enable the next.
 * Hard gates exit non-zero so CI can detect a broken bootstrap.
 *
 *   Q1  AWS credentials check (passive, hard gate)
 *   Q2  AWS region confirmation
 *   Q3  Bedrock model access verification (real InvokeModel call)
 *   Q4  Docker daemon check (informational; without Docker, deploys build in CodeBuild)
 *   Q5  ECR repository name
 *   Q6  CDK stack name + deployment tier
 *   Q7  Slack bot token + signing secret (optional)
 *   Q8  Telegram bot token (optional, but at least one of Slack/Telegram required)
 *   Q9  Dashboard token + optional PIN + kill phrase
 *   Q10 S3 deployment manifest bucket
 *   Q11 Config directory
 *   Q12 Write .env and claudeclaw.config.yaml
 */

import { writeFileSync, existsSync, readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { ask, confirm, spinner, closePrompt } from './lib/prompt.js';
import { bold, cyan, dim, fail, info, ok, red, section, warn } from './lib/ansi.js';
import { maybePrintHelp } from './lib/help.js';
import {
  getCallerIdentity,
  listClaudeInferenceProfiles,
  pingBedrockModel,
  classifyBedrockError,
} from './lib/aws-checks.js';
import { checkDocker } from './lib/docker-check.js';
import { validateSlackToken, validateSlackSigningSecret } from './lib/slack-check.js';
import { validateTelegramToken } from './lib/telegram-check.js';
import { generateHexToken, generateKillPhrase, hashPin } from './lib/crypto.js';
import { renderConfigYaml, type ClaudeClawConfig } from './lib/config-yaml.js';
import {
  loadSetupAnswers,
  resolveAnswersFlag,
  type SetupAnswers,
} from './lib/setup-answers.js';

/**
 * Noninteractive mode (IaC readiness item 38):
 * `npm run setup -- --answers <file.json>` supplies every answer by stable
 * key; each qN function consults `answers` BEFORE prompting and never falls
 * back to a prompt. Validation failures (in the file, or any value a
 * question would reject) hard-exit. Wizard-only side effects — the STS
 * identity check, Bedrock InvokeModel probe, Docker check, Slack auth.test,
 * Telegram getMe — still run. Schema docs: docs/runnable-blocks.md; example:
 * tests/fixtures/setup-answers.example.json.
 */
let answers: SetupAnswers | null = null;

const __filename = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(__filename));
const envPath = join(repoRoot, '.env');
const configYamlPath = join(repoRoot, 'claudeclaw.config.yaml');

interface SetupState {
  awsAccountId?: string;
  awsRegion?: string;
  callerArn?: string;
  bedrockOpusModel?: string;
  bedrockSonnetModel?: string;
  bedrockHaikuModel?: string;
  dockerVersion?: string;
  ecrRepoName?: string;
  cdkStackName?: string;
  deployTier?: 0 | 1 | 2 | 3;
  /** Daily Bedrock cost cap in USD. Defaults pulled from TIERS[tier]. */
  dailyCostCapUsd?: number;
  costCapEnforced?: boolean;
  /** Optional add-on vendor keys collected in Q11b. */
  tavilyApiKey?: string;
  braveSearchApiKey?: string;
  exaApiKey?: string;
  serperApiKey?: string;
  emailFromAddress?: string;
  imageGenEnabled?: boolean;
  ttsEnabled?: boolean;
  slackBotToken?: string;
  slackSigningSecret?: string;
  slackTeam?: string;
  telegramTokensJson?: string;
  telegramBotUsername?: string;
  dashboardToken?: string;
  securityPinHash?: string;
  emergencyKillPhrase?: string;
  manifestBucket?: string;
  configDir?: string;
  appEncryptionKey?: string;
  paperclipBetterAuthSecret?: string;
  telegramWebhookSecret?: string;
  /** Deployment mode (IaC readiness item 12). */
  deployMode?: 'chat' | 'infra-only';
  domainName?: string;
  knowledgeEnabled?: boolean;
  jarvisVoiceEnabled?: boolean;
  /** CI deploy path (Q11c). Both flags default OFF; never both at once. */
  ciMode?: 'none' | 'actions' | 'codebuild';
  githubOwner?: string;
  githubRepo?: string;
  githubBranch?: string;
  githubDeployRefs?: string;
}

const banner = `
${cyan('   ████████  ██')}
${cyan('  ██░░░░░░  ██░░██  ')}${bold('Netzar OS Enterprise')}
${cyan('  ██   ██  ████░░  ')}${dim('Bedrock-native AI orchestrator')}
${cyan('   ████████  ██░░')}
`;

async function main(): Promise<void> {
  if (
    maybePrintHelp(process.argv.slice(2), {
      command: 'npm run setup',
      oneLiner: 'interactive config wizard (12 questions); merges into an existing .env',
      flags: [['--answers <file>', 'noninteractive: every answer from a JSON file (see examples/answers/)']],
      contract: 'Writes .env and claudeclaw.config.yaml; creates nothing in AWS.',
      docs: 'AGENTS.md · examples/answers/README.md',
    })
  ) {
    return;
  }
  // eslint-disable-next-line no-console
  console.log(banner);

  const answersPath = resolveAnswersFlag(process.argv.slice(2));
  // Internal: the up conductor passes --from-up so the wizard does not print
  // "Next steps" homework that contradicts the conductor, which continues
  // into doctor on its own the moment setup returns.
  const fromUp = process.argv.includes('--from-up');
  if (answersPath) {
    try {
      answers = loadSetupAnswers(answersPath);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(fail(err instanceof Error ? err.message : String(err)));
      process.exit(1);
    }
    // eslint-disable-next-line no-console
    console.log(info(`noninteractive mode; answers from ${dim(answersPath)}`));
  }

  if (existsSync(envPath)) {
    // eslint-disable-next-line no-console
    console.log(warn(`Found existing .env at ${dim(envPath)}`));
    // Noninteractive runs always merge; interactive runs get the choice.
    const cont = answers ? true : await confirm('Continue setup and merge into existing .env?', true);
    if (!cont) {
      // eslint-disable-next-line no-console
      console.log(info('Setup cancelled. No changes made.'));
      closePrompt();
      return;
    }
  }

  const state: SetupState = loadStateFromEnv();

  await q1AwsCreds(state);
  await q2Region(state);
  await q3BedrockAccess(state);
  await q4Docker(state);
  await q5EcrRepo(state);
  await q6StackAndTier(state);
  await q7Slack(state);
  await q8Telegram(state);
  await q8bDeployMode(state);
  await q9Dashboard(state);
  await q10ManifestBucket(state);
  await q11ConfigDir(state);
  await q11bAddons(state);
  await q11cCi(state);
  await q12WriteArtifacts(state);

  // eslint-disable-next-line no-console
  console.log('\n' + bold('Setup complete.'));
  // eslint-disable-next-line no-console
  console.log('  ' + ok(`.env written to ${dim(envPath)}`));
  // eslint-disable-next-line no-console
  console.log('  ' + ok(`claudeclaw.config.yaml written to ${dim(configYamlPath)}`));
  if (!fromUp) {
    // The old copy said "npm run status — confirm health" first, but status
    // is a post-deploy command; on a fresh account it can only fail. Lead
    // with the conductor, keep the by-hand pair in the right order, and only
    // mention Slack when THIS run actually configured it.
    // eslint-disable-next-line no-console
    console.log('\nNext steps:');
    // eslint-disable-next-line no-console
    console.log('  ' + info('npm run up       recommended: doctor, model probe, deploy, verify, conducted from here'));
    // eslint-disable-next-line no-console
    console.log('  ' + info('npm run doctor   or drive it by hand: free read-only preflight, then npm run deploy'));
    if (state.slackBotToken) {
      // eslint-disable-next-line no-console
      console.log(
        '  ' +
          info(
            'After deploy: paste the printed /slack/events URL into your Slack app (Event Subscriptions).',
          ),
      );
    }
  }

  closePrompt();
}

function loadStateFromEnv(): SetupState {
  if (!existsSync(envPath)) return {};
  const text = readFileSync(envPath, 'utf-8');
  const env: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return {
    awsAccountId: env.AWS_ACCOUNT_ID,
    awsRegion: env.AWS_REGION,
    bedrockOpusModel: env.BEDROCK_OPUS_MODEL,
    bedrockSonnetModel: env.BEDROCK_SONNET_MODEL,
    bedrockHaikuModel: env.BEDROCK_HAIKU_MODEL,
    ecrRepoName: env.ECR_REPO_NAME,
    cdkStackName: env.CDK_STACK_NAME,
    deployTier: env.CCE_TIER
      ? (Number(env.CCE_TIER) as 0 | 1 | 2 | 3)
      : env.DEPLOY_TIER
        ? (Number(env.DEPLOY_TIER) as 0 | 1 | 2 | 3)
        : undefined,
    costCapEnforced: env.CCE_COST_CAP_ENFORCED
      ? ['1', 'true'].includes(env.CCE_COST_CAP_ENFORCED.trim().toLowerCase())
      : undefined,
    dailyCostCapUsd: env.CCE_DAILY_COST_CAP_USD
      ? Number(env.CCE_DAILY_COST_CAP_USD)
      : undefined,
    tavilyApiKey: env.TAVILY_API_KEY,
    braveSearchApiKey: env.BRAVE_SEARCH_API_KEY,
    exaApiKey: env.EXA_API_KEY,
    serperApiKey: env.SERPER_API_KEY,
    emailFromAddress: env.CCE_EMAIL_FROM,
    imageGenEnabled: env.CCE_IMAGE_GEN_ENABLED !== '0',
    ttsEnabled: env.CCE_TTS_ENABLED !== '0',
    slackBotToken: env.SLACK_BOT_TOKEN,
    slackSigningSecret: env.SLACK_SIGNING_SECRET,
    telegramTokensJson: env.TELEGRAM_TOKENS_JSON,
    dashboardToken: env.DASHBOARD_TOKEN,
    securityPinHash: env.SECURITY_PIN_HASH,
    emergencyKillPhrase: env.EMERGENCY_KILL_PHRASE,
    manifestBucket: env.DEPLOY_MANIFEST_BUCKET,
    configDir: env.CLAUDECLAW_CONFIG,
    appEncryptionKey: env.APP_ENCRYPTION_KEY,
    paperclipBetterAuthSecret: env.PAPERCLIP_BETTER_AUTH_SECRET,
    telegramWebhookSecret: env.TELEGRAM_WEBHOOK_SECRET,
    deployMode:
      env.CCE_DEPLOY_MODE === 'infra-only' ? 'infra-only' : env.CCE_DEPLOY_MODE === 'chat' ? 'chat' : undefined,
    domainName: env.DOMAIN_NAME,
    knowledgeEnabled: env.CCE_KNOWLEDGE_ENABLED !== '0',
    jarvisVoiceEnabled:
      env.JARVIS_LAUNCH_ENABLED === 'true' || env.JARVIS_LAUNCH_ENABLED === '1'
        ? true
        : env.JARVIS_LAUNCH_ENABLED === 'false' || env.JARVIS_LAUNCH_ENABLED === '0'
          ? false
          : undefined,
    ciMode:
      env.CCE_CICD_ENABLED === '1'
        ? 'actions'
        : env.CCE_CODEBUILD_ENABLED === '1'
          ? 'codebuild'
          : 'none',
    githubOwner: env.CCE_GITHUB_OWNER,
    githubRepo: env.CCE_GITHUB_REPO,
    githubBranch: env.CCE_GITHUB_BRANCH,
    githubDeployRefs: env.CCE_GITHUB_DEPLOY_REFS,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Q1
// ─────────────────────────────────────────────────────────────────────
async function q1AwsCreds(state: SetupState): Promise<void> {
  section('Q1 / 12 · AWS credentials');
  const stop = spinner('detecting AWS identity');
  try {
    const probeRegion = state.awsRegion ?? process.env.AWS_REGION ?? 'us-east-1';
    const identity = await getCallerIdentity(probeRegion);
    stop(ok(`account ${bold(identity.account)} · ${dim(identity.arn)}`));
    state.awsAccountId = identity.account;
    state.callerArn = identity.arn;
    if (identity.arn.endsWith(':root')) {
      // eslint-disable-next-line no-console
      console.log(
        warn(
          'You are using the AWS root account. Consider creating an IAM user with AdministratorAccess.',
        ),
      );
    }
  } catch (err) {
    stop(fail('AWS credentials not configured or invalid'));
    const e = err as { message?: string };
    // eslint-disable-next-line no-console
    console.log(dim(`  ${e.message ?? String(err)}`));
    // eslint-disable-next-line no-console
    console.log(info('Fix: run `aws configure` and re-run setup.'));
    closePrompt();
    process.exit(1);
  }
}

// ─────────────────────────────────────────────────────────────────────
// Q2
// ─────────────────────────────────────────────────────────────────────
async function q2Region(state: SetupState): Promise<void> {
  section('Q2 / 12 · AWS region');
  const detected = state.awsRegion ?? process.env.AWS_REGION ?? 'us-east-1';
  const region = answers ? answers.awsRegion : await ask('Region?', detected);
  if (!/^[a-z]{2}-[a-z]+-\d$/.test(region)) {
    // eslint-disable-next-line no-console
    console.log(fail(`'${region}' does not look like a valid AWS region.`));
    closePrompt();
    process.exit(1);
  }
  state.awsRegion = region;
  const supported = ['us-east-1', 'us-west-2', 'eu-west-1', 'eu-central-1', 'ap-northeast-1'];
  if (!supported.includes(region)) {
    // eslint-disable-next-line no-console
    console.log(warn('Bedrock coverage outside common regions is sparser. Verify model availability.'));
  }
  // eslint-disable-next-line no-console
  console.log(ok(`region ${bold(region)}`));
}

// ─────────────────────────────────────────────────────────────────────
// Q3
// ─────────────────────────────────────────────────────────────────────
async function q3BedrockAccess(state: SetupState): Promise<void> {
  section('Q3 / 12 · Bedrock model access');
  const region = state.awsRegion!;
  const listStop = spinner(`listing Claude inference profiles in ${region}`);
  let profiles;
  try {
    profiles = await listClaudeInferenceProfiles(region);
  } catch (err) {
    listStop(fail('failed to list inference profiles'));
    const cls = classifyBedrockError(err);
    // eslint-disable-next-line no-console
    console.log(dim(`  ${cls.code}: ${cls.raw}`));
    // eslint-disable-next-line no-console
    console.log(info(`Fix: ${cls.remedy}`));
    closePrompt();
    process.exit(1);
  }
  listStop(ok(`found ${profiles.all.length} Claude inference profile(s)`));

  if (!profiles.haiku) {
    // eslint-disable-next-line no-console
    console.log(fail('No Claude Haiku profile found in this region.'));
    // eslint-disable-next-line no-console
    console.log(
      info('Enable model access: ') + cyan('https://console.aws.amazon.com/bedrock/home#/model-catalog'),
    );
    closePrompt();
    process.exit(1);
  }

  const haikuId = profiles.haiku.inferenceProfileId ?? profiles.haiku.inferenceProfileArn ?? '';
  const pingStop = spinner(`invoking ${profiles.haiku.inferenceProfileName} to confirm access`);
  try {
    const { outputText, latencyMs } = await pingBedrockModel(region, haikuId);
    pingStop(ok(`model access confirmed · ${dim(`${latencyMs}ms · "${outputText.slice(0, 40)}"`)}`));
  } catch (err) {
    pingStop(fail('InvokeModel failed'));
    const cls = classifyBedrockError(err);
    // eslint-disable-next-line no-console
    console.log(dim(`  ${cls.code}: ${cls.raw}`));
    // eslint-disable-next-line no-console
    console.log(info(`Fix: ${cls.remedy}`));
    closePrompt();
    process.exit(1);
  }
  state.bedrockHaikuModel = haikuId;
  state.bedrockSonnetModel =
    profiles.sonnet?.inferenceProfileId ?? profiles.sonnet?.inferenceProfileArn;
  state.bedrockOpusModel =
    profiles.opus?.inferenceProfileId ?? profiles.opus?.inferenceProfileArn;

  const lines = [
    profiles.opus
      ? ok(`Opus  · ${profiles.opus.inferenceProfileName}`)
      : warn('Opus  · not available (request access)'),
    profiles.sonnet
      ? ok(`Sonnet · ${profiles.sonnet.inferenceProfileName}`)
      : warn('Sonnet · not available (request access)'),
    ok(`Haiku · ${profiles.haiku.inferenceProfileName}`),
  ];
  lines.forEach((l) => {
    // eslint-disable-next-line no-console
    console.log('  ' + l);
  });
}

// ─────────────────────────────────────────────────────────────────────
// Q4
// ─────────────────────────────────────────────────────────────────────
async function q4Docker(state: SetupState): Promise<void> {
  section('Q4 / 12 · Docker (optional)');
  const stop = spinner('checking docker daemon');
  const status = await checkDocker();
  if (!status.installed || !status.running) {
    // Docker is NOT a requirement. Without a local daemon, deploy builds
    // the image with AWS CodeBuild inside the operator's own account (a
    // few cents and roughly 10 extra minutes per deploy). Never a hard
    // gate; the message just sets expectations.
    stop(ok('no running Docker found, and that is fine'));
    // eslint-disable-next-line no-console
    console.log(
      info(
        'Deploys will build the app image with AWS CodeBuild inside your account (a few cents, ~10 min per deploy).',
      ),
    );
    // eslint-disable-next-line no-console
    console.log(
      dim(
        '  Prefer faster local builds? Install and start Docker Desktop anytime: https://docs.docker.com/get-docker/',
      ),
    );
    return;
  }
  stop(ok(`docker engine ${bold(status.version ?? 'unknown')} · image builds will run locally`));
  state.dockerVersion = status.version;
}

// ─────────────────────────────────────────────────────────────────────
// Q5
// ─────────────────────────────────────────────────────────────────────
async function q5EcrRepo(state: SetupState): Promise<void> {
  section('Q5 / 12 · ECR repository name');
  // The CDK compute stack imports the repo by a fixed name. We do not
  // let the user customize this; mismatch would push images to one repo
  // and have Fargate pull from another. Documented in BUILD_LOG.
  state.ecrRepoName = 'claudeclaw-orchestrator';
  // eslint-disable-next-line no-console
  console.log(ok(`ECR repository ${bold(state.ecrRepoName)} (fixed)`));
}

// ─────────────────────────────────────────────────────────────────────
// Q6
// ─────────────────────────────────────────────────────────────────────
async function q6StackAndTier(state: SetupState): Promise<void> {
  section('Q6 / 12 · CDK stack and tier');
  const stackName = answers
    ? (answers.cdkStackName ?? state.cdkStackName ?? 'CCE')
    : await ask('CDK stack name prefix?', state.cdkStackName ?? 'CCE');
  if (!/^[a-zA-Z][a-zA-Z0-9-]{0,127}$/.test(stackName)) {
    // eslint-disable-next-line no-console
    console.log(fail('Stack name must match CloudFormation rules.'));
    closePrompt();
    process.exit(1);
  }
  state.cdkStackName = stackName;

  // eslint-disable-next-line no-console
  console.log('\n  Deployment tiers:');
  // eslint-disable-next-line no-console
  console.log('    ' + dim('0  Hobby       1x Fargate, 1 NAT, 7d logs                      ~$50/mo'));
  // eslint-disable-next-line no-console
  console.log('    ' + dim('1  Standard    2x HA, 30d logs, Flow Logs ON                  ~$140/mo'));
  // eslint-disable-next-line no-console
  console.log('    ' + dim('2  Pro         autoscale, WAF, X-Ray, 90d logs                ~$350/mo'));
  // eslint-disable-next-line no-console
  console.log('    ' + dim('3  Enterprise  + CloudFront, daily DDB export, 365d logs      ~$800/mo'));
  // eslint-disable-next-line no-console
  console.log('    ' + dim('Prices are INFRASTRUCTURE only; Bedrock token spend is separate and usage-based.'));

  const raw = answers
    ? String(answers.deployTier)
    : await ask('Tier?', String(state.deployTier ?? 1));
  const tier = Number(raw);
  if (![0, 1, 2, 3].includes(tier)) {
    // eslint-disable-next-line no-console
    console.log(fail('Tier must be 0, 1, 2, or 3.'));
    closePrompt();
    process.exit(1);
  }
  state.deployTier = tier as 0 | 1 | 2 | 3;

  // Daily cost cap. Defaults per tier (5 / 50 / 200 / 1000) but the
  // operator can override. Enforcement is decided at runtime by
  // src/lib/cost/ledger-gate.ts, and fresh installs seed cost/cap_enabled
  // and cost/ledger_enabled to 'false': the value is SAVED but nothing
  // blocks spend until the operator turns enforcement on. The prompt says
  // so; the wizard must not promise a limit the install does not enforce.
  const tierDefaults = [5, 50, 200, 1000];
  const defaultCap = state.dailyCostCapUsd ?? tierDefaults[tier];
  // eslint-disable-next-line no-console
  console.log(dim('  Daily Bedrock spend cap (USD). Saved to .env and seeded into runtime-config.'));
  const capRaw = answers
    ? String(answers.dailyCostCapUsd ?? defaultCap)
    : await ask('Daily cap USD?', String(defaultCap));
  const cap = Number(capRaw);
  if (!Number.isFinite(cap) || cap < 0) {
    // eslint-disable-next-line no-console
    console.log(fail('Cap must be a non-negative number.'));
    closePrompt();
    process.exit(1);
  }
  state.dailyCostCapUsd = cap;

  // Day-one enforcement (default YES). Writing CCE_COST_CAP_ENFORCED=1 makes
  // applyEnvOverrides seed cost/cap_enabled 'true' on the FIRST deploy, so
  // the cap the operator just chose actually blocks paid turns (fail-closed,
  // ledger-gate regime 2). Declining keeps the old saved-but-off behavior.
  const enforce = answers
    ? (answers.enforceDailyCostCap ?? true)
    : await confirm(
        `Enforce the $${cap}/day cap from the first deploy (blocks paid turns past it)?`,
        state.costCapEnforced ?? true,
      );
  state.costCapEnforced = enforce;
  // eslint-disable-next-line no-console
  console.log(
    enforce
      ? ok(`cap $${cap}/day will be ENFORCED from the first deploy (fail-closed)`)
      : dim(
          '  cap saved but NOT enforced; turn it on later in the dashboard Cost tab (runtime-config cost/cap_enabled=true).',
        ),
  );

  // eslint-disable-next-line no-console
  console.log(ok(`stack prefix ${bold(stackName)}, tier ${bold(String(tier))}, cap $${bold(String(cap))}/day`));
}

// ─────────────────────────────────────────────────────────────────────
// Q7
// ─────────────────────────────────────────────────────────────────────
async function q7Slack(state: SetupState): Promise<void> {
  section('Q7 / 12 · Slack');
  const wantSlack = answers ? Boolean(answers.slackBotToken) : await confirm('Configure Slack now?', true);
  if (!wantSlack) {
    // eslint-disable-next-line no-console
    console.log(dim('  skipped'));
    return;
  }
  const token = answers
    ? answers.slackBotToken!.trim()
    : (await ask('Slack Bot User OAuth Token (xoxb-...)?', state.slackBotToken ?? '')).trim();
  if (!token) {
    // eslint-disable-next-line no-console
    console.log(dim('  skipped'));
    return;
  }
  const stop = spinner('validating bot token via auth.test');
  const result = await validateSlackToken(token);
  if (!result.ok) {
    stop(fail(`Slack validation failed: ${result.error ?? 'unknown'}`));
    closePrompt();
    process.exit(1);
  }
  stop(ok(`token belongs to ${bold(result.user ?? 'bot')} in ${bold(result.team ?? 'workspace')}`));
  state.slackBotToken = token;
  state.slackTeam = result.team;

  const secret = answers
    ? (answers.slackSigningSecret ?? '').trim()
    : (await ask('Slack Signing Secret?', state.slackSigningSecret ?? '')).trim();
  if (!validateSlackSigningSecret(secret)) {
    // eslint-disable-next-line no-console
    console.log(fail('Signing secret must be a 32-char hex string.'));
    closePrompt();
    process.exit(1);
  }
  state.slackSigningSecret = secret;
  // eslint-disable-next-line no-console
  console.log(ok('signing secret saved'));
}

// ─────────────────────────────────────────────────────────────────────
// Q8
// ─────────────────────────────────────────────────────────────────────
async function q8Telegram(state: SetupState): Promise<void> {
  section('Q8 / 12 · Telegram');
  const wantTg = answers ? Boolean(answers.telegramToken) : await confirm('Configure Telegram now?', true);
  if (!wantTg) {
    // eslint-disable-next-line no-console
    console.log(dim('  skipped'));
    return;
  }
  // eslint-disable-next-line no-console
  console.log(
    dim(
      '  Telegram identity is per-bot-token. Each agent can have its own @BotFather bot.\n  For now we collect one "main" token; add more agents later via the CLI.',
    ),
  );
  const token = answers
    ? answers.telegramToken!.trim()
    : (await ask('Telegram Bot Token (main agent)?', '')).trim();
  if (!token) {
    // eslint-disable-next-line no-console
    console.log(dim('  skipped'));
    return;
  }
  const stop = spinner('validating token via getMe');
  const result = await validateTelegramToken(token);
  if (!result.ok) {
    stop(fail(`Telegram validation failed: ${result.error ?? 'unknown'}`));
    closePrompt();
    process.exit(1);
  }
  stop(ok(`bot ${bold('@' + (result.username ?? '?'))} · "${result.firstName ?? ''}"`));
  state.telegramTokensJson = JSON.stringify({ main: token });
  state.telegramBotUsername = result.username;
  state.telegramWebhookSecret = state.telegramWebhookSecret ?? generateHexToken(32);
}

// ─────────────────────────────────────────────────────────────────────
// Q8b · Deployment mode (IaC readiness item 12 — replaces the old
// Slack-or-Telegram hard stop)
// ─────────────────────────────────────────────────────────────────────
async function q8bDeployMode(state: SetupState): Promise<void> {
  section('Q8b · Deployment mode');
  const hasSurface = Boolean(state.slackBotToken || state.telegramTokensJson);
  // eslint-disable-next-line no-console
  console.log('    ' + dim('chat        Slack/Telegram surfaces are first-class (REQUIRES a public domain + HTTPS)'));
  // eslint-disable-next-line no-console
  console.log('    ' + dim('infra-only  dashboard only, no chat surfaces (no domain needed; private'));
  // eslint-disable-next-line no-console
  console.log('    ' + dim('            access via SSM port-forward unless a domain is configured)'));
  const suggested = state.deployMode ?? (hasSurface ? 'chat' : 'infra-only');
  const mode = answers
    ? answers.deployMode
    : (await ask('Deployment mode? (chat|infra-only)', suggested)).trim().toLowerCase();
  state.deployMode = mode === 'infra-only' ? 'infra-only' : 'chat';

  if (state.deployMode === 'chat') {
    if (!hasSurface) {
      // eslint-disable-next-line no-console
      console.log(fail('chat mode requires at least one surface (Slack or Telegram).'));
      // eslint-disable-next-line no-console
      console.log(info('Re-run setup and configure a surface, or choose infra-only.'));
      closePrompt();
      process.exit(1);
    }
    const domain = answers
      ? (answers.domainName ?? '').trim()
      : (await ask(
          'Public domain for webhooks/dashboard (e.g. cce.example.com)?',
          state.domainName ?? '',
        )).trim();
    if (!domain) {
      // eslint-disable-next-line no-console
      console.log(fail('chat mode requires a domain: webhook surfaces and dashboard auth need HTTPS.'));
      // eslint-disable-next-line no-console
      console.log(info('Choose infra-only if you have no domain yet; you can re-run setup later.'));
      closePrompt();
      process.exit(1);
    }
    state.domainName = domain;
  } else if (answers?.domainName) {
    // infra-only WITH a domain: public HTTPS dashboard.
    state.domainName = answers.domainName;
  } else if (!state.domainName) {
    // eslint-disable-next-line no-console
    console.log(
      info('infra-only without a domain: the dashboard will be PRIVATE-access only via'),
    );
    // eslint-disable-next-line no-console
    console.log(info('`npm run dashboard:tunnel` (SSM port-forward). Public HTTPS needs a domain.'));
  }
}

// ─────────────────────────────────────────────────────────────────────
// Q9
// ─────────────────────────────────────────────────────────────────────
async function q9Dashboard(state: SetupState): Promise<void> {
  section('Q9 / 12 · Dashboard token + kill phrase');

  if (answers && answers.dashboard.autoGenerate === false && !state.dashboardToken) {
    // eslint-disable-next-line no-console
    console.log(fail('answers set dashboard.autoGenerate=false but no existing token is present in .env.'));
    closePrompt();
    process.exit(1);
  }
  const token = state.dashboardToken ?? generateHexToken(32);
  state.dashboardToken = token;
  // eslint-disable-next-line no-console
  console.log(ok(`dashboard token (save this once):`));
  // eslint-disable-next-line no-console
  console.log('  ' + bold(token));

  // Noninteractive runs never set a PIN (a PIN in a JSON answers file would
  // be a credential at rest); set one later via the dashboard if wanted.
  const pinInput = answers ? '' : (await ask('Optional PIN (4+ chars, Enter to skip)?', '')).trim();
  if (pinInput) {
    if (pinInput.length < 4) {
      // eslint-disable-next-line no-console
      console.log(fail('PIN must be at least 4 characters.'));
      closePrompt();
      process.exit(1);
    }
    state.securityPinHash = hashPin(pinInput);
    // eslint-disable-next-line no-console
    console.log(ok('PIN hashed and saved'));
  } else {
    // eslint-disable-next-line no-console
    console.log(dim('  no PIN set'));
  }

  const killPhrase = state.emergencyKillPhrase ?? generateKillPhrase();
  state.emergencyKillPhrase = killPhrase;
  // Wired in src/agent/agent-loop.ts (matchesKillPhrase -> tryAcquirePanic):
  // a chat message containing the phrase trips the same panic freeze as the
  // dashboard panic button, on every chat surface.
  // eslint-disable-next-line no-console
  console.log(
    info(
      `emergency kill phrase (type it in any chat to freeze ALL agents; restore from the dashboard panic controls): ${bold(killPhrase)}`,
    ),
  );

  state.appEncryptionKey = state.appEncryptionKey ?? generateHexToken(32);
  // Paperclip work engine (ADR 0010). Generated ONCE and kept in .env, the
  // same generate-if-absent shape as the encryption key above, because
  // deploy phase b rewrites this secret on EVERY deploy: minting it there
  // would rotate it every deploy and invalidate every Paperclip session.
  // Written whether or not Paperclip is armed, so arming it later needs no
  // second setup run. Harmless when unused.
  state.paperclipBetterAuthSecret = state.paperclipBetterAuthSecret ?? generateHexToken(32);
  // eslint-disable-next-line no-console
  console.log(ok('application encryption key generated'));
}

// ─────────────────────────────────────────────────────────────────────
// Q10
// ─────────────────────────────────────────────────────────────────────
async function q10ManifestBucket(state: SetupState): Promise<void> {
  section('Q10 / 12 · Deployment manifest bucket');
  const defaultName =
    state.manifestBucket ?? `claudeclaw-deploy-${state.awsAccountId}-${state.awsRegion}`;
  const name = answers
    ? (answers.manifestBucket ?? defaultName)
    : await ask('S3 bucket name for deployment manifests?', defaultName);
  if (!/^[a-z0-9.][a-z0-9.\-]{1,61}[a-z0-9]$/.test(name)) {
    // eslint-disable-next-line no-console
    console.log(fail('Invalid S3 bucket name. Use lowercase alphanumerics, dots, dashes.'));
    closePrompt();
    process.exit(1);
  }
  state.manifestBucket = name;
  // eslint-disable-next-line no-console
  console.log(ok(`will create or reuse bucket ${bold(name)} on first deploy`));
}

// ─────────────────────────────────────────────────────────────────────
// Q11
// ─────────────────────────────────────────────────────────────────────
async function q11ConfigDir(state: SetupState): Promise<void> {
  section('Q11 / 12 · Config directory');
  const defaultDir =
    state.configDir ?? join(homedir(), '.claudeclaw-enterprise');
  const dir = answers
    ? (answers.configDir ?? defaultDir).trim()
    : (await ask('Where should agent definitions live locally (each agent = a CLAUDE.md prompt + agent.yaml)?', defaultDir)).trim();
  if (!dir.startsWith('/') && !dir.startsWith('~') && !dir.startsWith('.')) {
    // eslint-disable-next-line no-console
    console.log(fail('Path must be absolute, home-relative (~), or repo-relative (.).'));
    closePrompt();
    process.exit(1);
  }
  const expanded = dir.startsWith('~') ? join(homedir(), dir.slice(1)) : dir;
  if (!existsSync(expanded)) {
    mkdirSync(expanded, { recursive: true });
    // eslint-disable-next-line no-console
    console.log(ok(`created ${bold(expanded)}`));
  } else {
    // eslint-disable-next-line no-console
    console.log(ok(`using existing ${bold(expanded)}`));
  }
  state.configDir = expanded;
}

// ─────────────────────────────────────────────────────────────────────
// Q11b · Add-ons
// ─────────────────────────────────────────────────────────────────────
async function q11bAddons(state: SetupState): Promise<void> {
  section('Q11b · Capability add-ons');
  // eslint-disable-next-line no-console
  console.log(dim('  Each add-on is opt-in. Press Enter for the suggested default, or type y/n.'));
  // eslint-disable-next-line no-console
  console.log(dim('  Re-running setup can change any of these later.'));
  // Console-grant-heavy features default OFF at T0/T1 (IaC readiness
  // item 12): a newcomer's first deploy then needs only the Claude grant
  // (+Titan when knowledge stays on). Each enabled feature's extra
  // Bedrock grant is checked by `npm run doctor` before deploy.
  const tierDefault = (state.deployTier ?? 1) >= 2;

  // Image generation (Nova Canvas — needs the Nova Canvas model grant)
  const wantImage = answers
    ? (answers.addons.imageGen ?? state.imageGenEnabled ?? tierDefault)
    : await confirm(
        'Enable image generation (Nova Canvas; needs that model granted in the Bedrock console)?',
        state.imageGenEnabled ?? tierDefault,
      );
  state.imageGenEnabled = wantImage;
  if (wantImage) {
    // eslint-disable-next-line no-console
    console.log(ok('  Requires the amazon.nova-canvas model grant (doctor will check it).'));
  }

  // TTS (Polly, no Bedrock grant needed)
  const wantTts = answers
    ? (answers.addons.tts ?? state.ttsEnabled ?? true)
    : await confirm('Enable voice replies (Polly TTS)?', state.ttsEnabled ?? true);
  state.ttsEnabled = wantTts;

  // Knowledge ingestion / embeddings (Titan embed grant)
  const wantKnowledge = answers
    ? (answers.addons.knowledge ?? state.knowledgeEnabled ?? true)
    : await confirm(
        'Enable knowledge ingestion (Titan embeddings grant)?',
        state.knowledgeEnabled ?? true,
      );
  state.knowledgeEnabled = wantKnowledge;

  // Jarvis voice co-pilot (Nova Sonic — console-grant-heavy)
  const wantJarvisVoice = answers
    ? (answers.addons.jarvisVoice ?? state.jarvisVoiceEnabled ?? tierDefault)
    : await confirm(
        'Enable Jarvis voice (Nova Sonic; needs that model granted in the Bedrock console)?',
        state.jarvisVoiceEnabled ?? tierDefault,
      );
  state.jarvisVoiceEnabled = wantJarvisVoice;

  // Email via SES
  const wantEmail = answers
    ? Boolean(answers.addons.emailFrom)
    : await confirm('Enable send_email (SES)?', Boolean(state.emailFromAddress));
  if (wantEmail) {
    const from = answers
      ? answers.addons.emailFrom!.trim()
      : (await ask(
          'Verified SES sender (e.g. "ClaudeClaw <claw@example.com>")?',
          state.emailFromAddress ?? '',
        )).trim();
    if (from) state.emailFromAddress = from;
    // eslint-disable-next-line no-console
    console.log(dim('  Reminder: verify the sender domain in SES before sending.'));
  }

  // Web search — pick one vendor
  // eslint-disable-next-line no-console
  console.log('\n  Web search vendor (pick at most one):');
  // eslint-disable-next-line no-console
  console.log('    ' + dim('tavily   free 1000 q/mo, AI-friendly'));
  // eslint-disable-next-line no-console
  console.log('    ' + dim('brave    $3/mo for 2000 q, privacy-respecting'));
  // eslint-disable-next-line no-console
  console.log('    ' + dim('exa      neural search, best for research-quality content'));
  // eslint-disable-next-line no-console
  console.log('    ' + dim('serper   plain Google results, $50/mo for 2500'));
  const vendor = answers
    ? answers.addons.webSearchVendor
    : (await ask('Web search vendor? (tavily|brave|exa|serper|skip)', 'skip')).trim().toLowerCase();
  const answersKey = answers?.addons.webSearchApiKey ?? '';
  if (vendor === 'tavily') {
    const k = answers
      ? answersKey
      : (await ask('Tavily API key (https://tavily.com)?', state.tavilyApiKey ?? '')).trim();
    if (k) state.tavilyApiKey = k;
  } else if (vendor === 'brave') {
    const k = answers
      ? answersKey
      : (await ask('Brave Search API key (https://brave.com/search/api)?', state.braveSearchApiKey ?? '')).trim();
    if (k) state.braveSearchApiKey = k;
  } else if (vendor === 'exa') {
    const k = answers
      ? answersKey
      : (await ask('Exa API key (https://exa.ai)?', state.exaApiKey ?? '')).trim();
    if (k) state.exaApiKey = k;
  } else if (vendor === 'serper') {
    const k = answers
      ? answersKey
      : (await ask('Serper API key (https://serper.dev)?', state.serperApiKey ?? '')).trim();
    if (k) state.serperApiKey = k;
  } else {
    // eslint-disable-next-line no-console
    console.log(dim('  no web search vendor configured; web_search tool will be skipped at boot.'));
  }
}

// ─────────────────────────────────────────────────────────────────────
// Q11c · CI deploys (one question, two independent opt-in paths)
// ─────────────────────────────────────────────────────────────────────
async function q11cCi(state: SetupState): Promise<void> {
  section('Q11c · CI deploys (optional)');
  // eslint-disable-next-line no-console
  console.log(dim('  Default is NONE: you deploy from this machine with `npm run deploy`.'));
  // eslint-disable-next-line no-console
  console.log('    ' + dim('none      no CI; laptop deploys only (recommended to start)'));
  // eslint-disable-next-line no-console
  console.log('    ' + dim('actions   GitHub Actions OIDC deploys (needs the OIDC provider + repo trust)'));
  // eslint-disable-next-line no-console
  console.log('    ' + dim('codebuild AWS CodeBuild tag-triggered deploys (needs a GitHub PAT imported'));
  // eslint-disable-next-line no-console
  console.log('    ' + dim('          via `aws codebuild import-source-credentials` BEFORE enabling)'));
  const mode = answers
    ? answers.ciMode
    : (await ask('CI deploys? (none|actions|codebuild)', state.ciMode ?? 'none'))
        .trim()
        .toLowerCase();
  if (mode !== 'actions' && mode !== 'codebuild') {
    state.ciMode = 'none';
    return;
  }
  state.ciMode = mode;

  const owner = answers
    ? answers.github!.owner.trim()
    : (await ask('GitHub owner/org of YOUR repo?', state.githubOwner ?? '')).trim();
  const repo = answers
    ? answers.github!.repo.trim()
    : (await ask('GitHub repository name?', state.githubRepo ?? '')).trim();
  if (!owner || !repo) {
    // eslint-disable-next-line no-console
    console.log(fail('CI requires an explicit GitHub owner + repo (no default). Skipping CI.'));
    state.ciMode = 'none';
    return;
  }
  state.githubOwner = owner;
  state.githubRepo = repo;

  if (mode === 'actions') {
    const refs = answers
      ? (answers.github!.deployRefs ?? 'refs/heads/main').trim()
      : (await ask(
          'Deploy refs (CSV of fully-qualified refs trusted to deploy)?',
          state.githubDeployRefs ?? 'refs/heads/main',
        )).trim();
    state.githubDeployRefs = refs;
    // eslint-disable-next-line no-console
    console.log(info('Prerequisite: create the GitHub OIDC provider once per account:'));
    // eslint-disable-next-line no-console
    console.log(dim('    bash scripts/oidc-provider.sh'));
  } else {
    const branch = answers
      ? (answers.github!.branch ?? 'main').trim()
      : (await ask('Deploy branch?', state.githubBranch ?? 'main')).trim();
    state.githubBranch = branch || 'main';
    // eslint-disable-next-line no-console
    console.log(info('Prerequisite: import a GitHub PAT (repo + admin:repo_hook scopes) once per account:'));
    // eslint-disable-next-line no-console
    console.log(dim('    aws codebuild import-source-credentials --auth-type PERSONAL_ACCESS_TOKEN \\'));
    // eslint-disable-next-line no-console
    console.log(dim('      --server-type GITHUB --token <your-pat>'));
  }
}

// ─────────────────────────────────────────────────────────────────────
// Q12
// ─────────────────────────────────────────────────────────────────────
async function q12WriteArtifacts(state: SetupState): Promise<void> {
  section('Q12 / 12 · Writing artifacts');

  // .env
  const existing: Record<string, string> = existsSync(envPath)
    ? parseEnvFile(readFileSync(envPath, 'utf-8'))
    : {};
  const updated: Record<string, string> = {
    ...existing,
    AWS_ACCOUNT_ID: state.awsAccountId ?? '',
    AWS_REGION: state.awsRegion ?? '',
    BEDROCK_OPUS_MODEL: state.bedrockOpusModel ?? '',
    BEDROCK_SONNET_MODEL: state.bedrockSonnetModel ?? '',
    BEDROCK_DEFAULT_MODEL: state.bedrockSonnetModel ?? '',
    BEDROCK_HAIKU_MODEL: state.bedrockHaikuModel ?? '',
    ECR_REPO_NAME: state.ecrRepoName ?? '',
    CDK_STACK_NAME: state.cdkStackName ?? '',
    DEPLOY_TIER: String(state.deployTier ?? 1),
    CCE_TIER: String(state.deployTier ?? 1),
    CCE_DAILY_COST_CAP_USD: String(state.dailyCostCapUsd ?? 50),
    CCE_COST_CAP_ENFORCED: state.costCapEnforced === false ? '0' : '1',
    DEPLOY_MANIFEST_BUCKET: state.manifestBucket ?? '',
    CLAUDECLAW_CONFIG: state.configDir ?? '',
    DASHBOARD_TOKEN: state.dashboardToken ?? '',
    APP_ENCRYPTION_KEY: state.appEncryptionKey ?? '',
    PAPERCLIP_BETTER_AUTH_SECRET: state.paperclipBetterAuthSecret ?? '',
    EMERGENCY_KILL_PHRASE: state.emergencyKillPhrase ?? '',
  };
  if (state.securityPinHash) updated.SECURITY_PIN_HASH = state.securityPinHash;
  if (state.slackBotToken) updated.SLACK_BOT_TOKEN = state.slackBotToken;
  if (state.slackSigningSecret) updated.SLACK_SIGNING_SECRET = state.slackSigningSecret;
  if (state.telegramTokensJson) updated.TELEGRAM_TOKENS_JSON = state.telegramTokensJson;
  if (state.telegramWebhookSecret) updated.TELEGRAM_WEBHOOK_SECRET = state.telegramWebhookSecret;
  if (state.tavilyApiKey) updated.TAVILY_API_KEY = state.tavilyApiKey;
  if (state.braveSearchApiKey) updated.BRAVE_SEARCH_API_KEY = state.braveSearchApiKey;
  if (state.exaApiKey) updated.EXA_API_KEY = state.exaApiKey;
  if (state.serperApiKey) updated.SERPER_API_KEY = state.serperApiKey;
  if (state.emailFromAddress) updated.CCE_EMAIL_FROM = state.emailFromAddress;
  updated.CCE_IMAGE_GEN_ENABLED = state.imageGenEnabled === false ? '0' : '1';
  updated.CCE_TTS_ENABLED = state.ttsEnabled === false ? '0' : '1';
  updated.CCE_KNOWLEDGE_ENABLED = state.knowledgeEnabled === false ? '0' : '1';
  if (state.jarvisVoiceEnabled != null) {
    updated.JARVIS_LAUNCH_ENABLED = state.jarvisVoiceEnabled ? 'true' : 'false';
  }
  updated.CCE_DEPLOY_MODE = state.deployMode ?? 'chat';
  if (state.domainName) updated.DOMAIN_NAME = state.domainName;
  // CI flags are coherent by construction: at most one path enabled, and
  // any enabled path carries an explicit owner/repo (synth fails closed
  // without them). 'none' leaves both flags unset.
  if (state.ciMode === 'actions') {
    updated.CCE_CICD_ENABLED = '1';
    updated.CCE_CODEBUILD_ENABLED = '';
    updated.CCE_GITHUB_OWNER = state.githubOwner ?? '';
    updated.CCE_GITHUB_REPO = state.githubRepo ?? '';
    updated.CCE_GITHUB_DEPLOY_REFS = state.githubDeployRefs ?? 'refs/heads/main';
  } else if (state.ciMode === 'codebuild') {
    updated.CCE_CICD_ENABLED = '';
    updated.CCE_CODEBUILD_ENABLED = '1';
    updated.CCE_GITHUB_OWNER = state.githubOwner ?? '';
    updated.CCE_GITHUB_REPO = state.githubRepo ?? '';
    updated.CCE_GITHUB_BRANCH = state.githubBranch ?? 'main';
  } else if (state.ciMode === 'none') {
    updated.CCE_CICD_ENABLED = '';
    updated.CCE_CODEBUILD_ENABLED = '';
  }

  const envLines = [
    '# Netzar OS Enterprise · generated by `npm run setup`',
    `# Last updated: ${new Date().toISOString()}`,
    '# DO NOT COMMIT. .env is in .gitignore.',
    '',
  ];
  Object.entries(updated).forEach(([k, v]) => {
    if (v != null && v !== '') envLines.push(`${k}=${v}`);
  });
  writeFileSync(envPath, envLines.join('\n') + '\n', { mode: 0o600 });
  chmodSync(envPath, 0o600);

  // claudeclaw.config.yaml
  const cfg: ClaudeClawConfig = {
    version: 1,
    stack: state.cdkStackName!,
    region: state.awsRegion!,
    account: state.awsAccountId!,
    tier: state.deployTier ?? 1,
    ecr: { repo: state.ecrRepoName! },
    bedrock: {
      opus: state.bedrockOpusModel,
      sonnet: state.bedrockSonnetModel!,
      haiku: state.bedrockHaikuModel!,
    },
    adapters: {
      slack: Boolean(state.slackBotToken),
      telegram: Boolean(state.telegramTokensJson),
    },
    dashboard: {
      token_hint: state.dashboardToken!.slice(0, 8) + '…',
    },
    config_dir: state.configDir!,
    agents: [],
  };
  writeFileSync(configYamlPath, renderConfigYaml(cfg));

  // eslint-disable-next-line no-console
  console.log(ok('artifacts written'));
}

function parseEnvFile(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[line.slice(0, eq).trim()] = value;
  }
  return out;
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(red('\nfatal error during setup:'));
  // eslint-disable-next-line no-console
  console.error(err);
  closePrompt();
  process.exit(1);
});
