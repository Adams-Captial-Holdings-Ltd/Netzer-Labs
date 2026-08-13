/**
 * Netzar OS Enterprise — Operator handover (IaC readiness plan, item 45).
 *
 *   npm run handover               # full locked handover (interactive)
 *   npm run handover -- --dry-run  # full inventory + checklist, ZERO mutations
 *   npm run handover -- --answers=handover-answers.json
 *   npm run handover -- --env=staging
 *
 * What this does, in order:
 *   1. Prints the COMPLETE state inventory an incoming operator needs
 *      (account/region/tier/mode, deployed version, stacks, domain,
 *      surfaces, feature flags, the six secret paths, state bucket,
 *      intentional residuals, out-of-band catalog).
 *   2. Prints the ACCESS-TRANSFER checklist; API-checks Route 53
 *      nameserver authority, SES identities, and SNS subscriptions
 *      (pending confirmations go to the OLD operator).
 *   3. CREDENTIAL CLASSIFICATION: rotates what it OWNS (dashboard
 *      token/PIN/kill phrase; access keys of IAM users tagged
 *      app=claudeclaw) and BLOCKS completion until EXTERNAL reissues
 *      (Telegram BotFather token, Slack app credentials) are supplied
 *      and verified live — it never pretends to rotate what it cannot
 *      reach.
 *   4. Forces an ECS redeploy so rotated values inject, verifies the
 *      owner-only Telegram path reaches the INCOMING operator (SNS is a
 *      printed manual step), and only then stamps the CONFIG EPOCH in
 *      the state bucket + journals it. doctor/deploy FAIL on any machine
 *      whose .env disagrees with that epoch from then on.
 *
 * Runbook: docs/handover.md. Logic lives in
 * scripts/lib/lifecycle/handover-plan.ts (injected clients, unit-tested
 * on fakes); this file is orchestration only.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { SecretsManager } from '@aws-sdk/client-secrets-manager';
import { IAM } from '@aws-sdk/client-iam';
import { ECS } from '@aws-sdk/client-ecs';
import { SNS } from '@aws-sdk/client-sns';
import { SESv2 } from '@aws-sdk/client-sesv2';
import { STS } from '@aws-sdk/client-sts';
import { bold, dim, fail, gray, info, ok, warn } from './lib/ansi.js';
import { ask, closePrompt, confirm } from './lib/prompt.js';
import { capture } from './lib/shell.js';
import { envFileNameFor, parseEnvFile, resolveEnvFlag } from './lib/env-file.js';
import { resolveStateNames, STATE_META_KEY, type StateMeta } from './lib/lifecycle/bootstrap-state.js';
import { acquireLock, releaseLock, startHeartbeat, type AwsClientLike, type LockHandle } from './lib/lifecycle/lock.js';
import { appendJournal, readLatestManifest, s3BodyToString } from './lib/lifecycle/journal.js';
import { newDeployId } from './lib/lifecycle/ids.js';
import { createRunner, parseCatalog, type StepRunner } from './lib/lifecycle/teardown-plan.js';
import {
  ACCESS_TRANSFER_CHECKLIST,
  EXTERNAL_REISSUE_CHECKLIST,
  forceServiceRedeploy,
  generateDashboardSecretValues,
  hashOwnerIdentity,
  inventorySecrets,
  classifyIamUsers,
  listIamUsersWithTags,
  ownerIdentityNotes,
  renderInventory,
  rotateAppOwnedAccessKeys,
  rotateDashboardSecret,
  route53NameserverReport,
  runExternalCredentialGate,
  sesIdentityReport,
  snsSubscriptionReport,
  stampConfigEpoch,
  verifyOwnerPaths,
  type ExternalCredentialSpec,
  type Route53HandoverClientLike,
  type SecretsHandoverClientLike,
  type SesHandoverClientLike,
} from './lib/lifecycle/handover-plan.js';
import { validateTelegramToken } from './lib/telegram-check.js';
import { validateSlackToken, validateSlackSigningSecret } from './lib/slack-check.js';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = dirname(dirname(__filename));

const log = (msg = ''): void => {
  // eslint-disable-next-line no-console
  console.log(msg);
};

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

function isPlaceholder(v: string | undefined): boolean {
  return !v || v.trim() === '' || /replace_me/i.test(v) || (v.startsWith('<') && v.endsWith('>'));
}

/** Upsert KEY=VALUE lines in the local env file, preserving everything else. */
function upsertEnvKeys(path: string, updates: Record<string, string>): void {
  const pending = new Map(Object.entries(updates));
  const lines = existsSync(path) ? readFileSync(path, 'utf-8').split(/\r?\n/) : [];
  const out = lines.map((line) => {
    const eq = line.indexOf('=');
    if (eq < 0 || line.trim().startsWith('#')) return line;
    const key = line.slice(0, eq).trim();
    if (!pending.has(key)) return line;
    const value = pending.get(key) as string;
    pending.delete(key);
    return `${key}=${value}`;
  });
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  for (const [key, value] of pending) out.push(`${key}=${value}`);
  writeFileSync(path, out.join('\n') + '\n');
}

/** Read-only `aws route53` CLI adapter (the Route 53 SDK is not a dependency). */
function route53CliClient(): Route53HandoverClientLike {
  const call = async (action: string, args: string[]): Promise<unknown> => {
    const { code, stdout, stderr } = await capture('aws', ['route53', action, ...args, '--output', 'json']);
    if (code !== 0) throw new Error(stderr.trim() || `aws route53 ${action} exited ${code}`);
    return stdout.trim() ? (JSON.parse(stdout) as unknown) : {};
  };
  return {
    listHostedZonesByName: (input) =>
      call('list-hosted-zones-by-name', ['--dns-name', input.DNSName]) as never,
    getHostedZone: (input) => call('get-hosted-zone', ['--id', input.Id]) as never,
  };
}

async function telegramSend(
  token: string,
  chatId: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    const data = (await resp.json()) as { ok: boolean; description?: string };
    return data.ok ? { ok: true } : { ok: false, error: data.description ?? 'unknown telegram error' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function telegramSetWebhook(
  token: string,
  url: string,
  secretToken: string | undefined,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, ...(secretToken ? { secret_token: secretToken } : {}) }),
    });
    const data = (await resp.json()) as { ok: boolean; description?: string };
    return data.ok ? { ok: true } : { ok: false, error: data.description ?? 'unknown telegram error' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

interface Answers {
  [key: string]: string | undefined;
}

async function answerOr(
  answers: Answers,
  key: string,
  question: string,
  defaultValue?: string,
): Promise<string> {
  const fromFile = (answers[key] ?? '').trim();
  if (fromFile !== '') return fromFile;
  return ask(question, defaultValue);
}

// ─────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const envFlag = resolveEnvFlag(args);
  const envPath = join(repoRoot, envFileNameFor(envFlag));
  const answersArg = args.find((a) => a.startsWith('--answers='))?.split('=')[1];
  const answers: Answers = answersArg
    ? (JSON.parse(readFileSync(join(repoRoot, answersArg), 'utf-8')) as Answers)
    : {};

  if (!existsSync(envPath)) {
    log(fail(`No env file at ${envPath}. Run \`npm run setup\` first.`));
    process.exitCode = 1;
    return;
  }
  const env = parseEnvFile(readFileSync(envPath, 'utf-8'));
  const region = env.AWS_REGION || 'us-east-1';

  log('\n' + bold(`Netzar OS Enterprise · Operator handover (${envFlag})${dryRun ? ' — DRY RUN' : ''}`));
  log(gray('─'.repeat(60)));
  if (dryRun) log(dim('dry run: full inventory + checklist, ZERO mutations\n'));

  // ── Identity + names ───────────────────────────────────────────────
  const sts = new STS({ region });
  const identity = await sts.getCallerIdentity({});
  const account = identity.Account ?? '';
  if (!account) {
    log(fail('could not resolve the AWS account from STS — check credentials'));
    process.exitCode = 1;
    return;
  }
  env.AWS_ACCOUNT_ID = env.AWS_ACCOUNT_ID || account;
  if (env.AWS_ACCOUNT_ID !== account) {
    log(fail(`credentials resolve to account ${account} but .env says ${env.AWS_ACCOUNT_ID} — wrong-account protection`));
    process.exitCode = 1;
    return;
  }
  const names = resolveStateNames(env);
  const sfx = env.CCE_NAME_SUFFIX ? `-${env.CCE_NAME_SUFFIX}` : '';
  const appName = `claudeclaw${sfx}`;
  const secretBase = `/${appName}`;
  log(info(`account ${bold(account)} · region ${region} · caller ${identity.Arn ?? 'unknown'}`));

  // ── Clients ────────────────────────────────────────────────────────
  const s3 = new S3Client({ region }) as unknown as AwsClientLike;
  const ddb = new DynamoDBClient({ region }) as unknown as AwsClientLike;
  const secretsSdk = new SecretsManager({ region });
  const secrets: SecretsHandoverClientLike = {
    describeSecret: (input) => secretsSdk.describeSecret(input),
    putSecretValue: (input) => secretsSdk.putSecretValue(input),
  };
  const iamSdk = new IAM({ region });
  const ecsSdk = new ECS({ region });
  const snsSdk = new SNS({ region });
  const sesSdk = new SESv2({ region });

  // ── 1. State inventory ─────────────────────────────────────────────
  let meta: StateMeta | null = null;
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: names.stateBucket, Key: STATE_META_KEY }));
    meta = JSON.parse(await s3BodyToString((res as { Body?: unknown }).Body)) as StateMeta;
  } catch {
    /* fresh or unreachable state bucket; the manifest read below reports it */
  }
  let manifest = null;
  try {
    manifest = await readLatestManifest(s3, names.stateBucket);
  } catch (err) {
    log(warn(`state bucket ${names.stateBucket} unreadable (${err instanceof Error ? err.message : String(err)}) — inventory degrades`));
  }
  const catalogPath = join(repoRoot, 'docs', 'out-of-band-catalog.json');
  const catalog = parseCatalog(readFileSync(catalogPath, 'utf-8'));
  const secretRows = await inventorySecrets(secrets, secretBase);
  const tier = meta?.tier ?? manifest?.tier ?? 0;
  for (const line of renderInventory({
    meta,
    manifest,
    stateBucket: names.stateBucket,
    domain: env.DOMAIN_NAME ?? '',
    secretBase,
    secrets: secretRows,
    catalog,
    ...(tier >= 2 ? { wormBucket: `${appName}-audit-lock-${account}` } : {}),
  })) {
    log(line);
  }

  // ── 2. Access transfer: checklist + the three API checks ──────────
  log('\n' + bold('ACCESS TRANSFER (work every line; no API can do these for you)'));
  for (const item of ACCESS_TRANSFER_CHECKLIST) log(`  [ ] ${item}`);

  log('\n' + bold('API-checked account-level state'));
  try {
    for (const line of await route53NameserverReport(route53CliClient(), env.DOMAIN_NAME ?? '')) log(`  ${line}`);
  } catch (err) {
    log(warn(`  Route 53: could not check (${err instanceof Error ? err.message : String(err)})`));
  }
  try {
    const ses: SesHandoverClientLike = {
      listIdentities: async () => {
        const out = await sesSdk.listEmailIdentities({});
        return { Identities: (out.EmailIdentities ?? []).map((i) => i.IdentityName ?? '').filter((n) => n !== '') };
      },
      getIdentityVerificationAttributes: async ({ Identities }) => {
        const out = await sesSdk.listEmailIdentities({});
        const attrs: Record<string, { VerificationStatus?: string }> = {};
        for (const id of Identities) {
          const found = (out.EmailIdentities ?? []).find((i) => i.IdentityName === id);
          attrs[id] = { VerificationStatus: found?.VerificationStatus ?? (found?.SendingEnabled ? 'Success' : 'Unknown') };
        }
        return { VerificationAttributes: attrs };
      },
    };
    for (const line of await sesIdentityReport(ses)) log(`  ${line}`);
  } catch (err) {
    log(warn(`  SES: could not check (${err instanceof Error ? err.message : String(err)})`));
  }
  try {
    const topicArn = env.CCE_ALERT_TOPIC_ARN ?? '';
    for (const line of await snsSubscriptionReport(
      { listSubscriptionsByTopic: (input) => snsSdk.listSubscriptionsByTopic(input) },
      topicArn,
    )) {
      log(`  ${line}`);
    }
  } catch (err) {
    log(warn(`  SNS: could not check (${err instanceof Error ? err.message : String(err)})`));
  }

  // ── 3. Credential classification ───────────────────────────────────
  log('\n' + bold('CREDENTIAL CLASSIFICATION'));
  log(dim('COMMAND-OWNED (this tool rotates them now): dashboard token + PIN + kill phrase; access keys of IAM users tagged app=claudeclaw.'));
  log(dim('EXTERNAL (only a human can reissue; completion BLOCKS until supplied + verified live):'));
  for (const item of EXTERNAL_REISSUE_CHECKLIST) log(`  [ ] ${item}`);

  const iamUsers = await listIamUsersWithTags({
    listUsers: (input) => iamSdk.listUsers(input),
    listUserTags: (input) => iamSdk.listUserTags(input),
    listAccessKeys: (input) => iamSdk.listAccessKeys(input),
    createAccessKey: (input) => iamSdk.createAccessKey(input),
    deleteAccessKey: (input) => iamSdk.deleteAccessKey(input),
  });
  const classification = classifyIamUsers(iamUsers);
  log(`\n  IAM users tagged app=claudeclaw (keys WILL be rotated): ${classification.appOwned.join(', ') || '(none)'}`);
  log(`  IAM users NOT touched (human/SSO/untagged — checklist only): ${classification.checklistOnly.join(', ') || '(none)'}`);

  for (const line of ownerIdentityNotes({ githubOwner: env.CCE_GITHUB_OWNER, githubRepo: env.CCE_GITHUB_REPO })) log(line);

  // ── Dry run stops here: plan printed, nothing mutated ──────────────
  if (dryRun) {
    const planRunner = createRunner(false);
    planRunner.note('acquire lifecycle lock (operation: handover) + heartbeat');
    planRunner.note(`secretsmanager:PutSecretValue ${secretBase}/dashboard (new token + kill phrase + PIN hash)`);
    for (const u of classification.appOwned) planRunner.note(`iam: rotate access keys for ${u} (create new, delete old)`);
    planRunner.note('BLOCKING GATE: collect + live-verify newly issued external credentials (Telegram getMe, Slack auth.test)');
    planRunner.note(`secretsmanager:PutSecretValue ${secretBase}/telegram + ${secretBase}/slack (newly issued tokens)`);
    planRunner.note(`ecs:UpdateService ${appName}-cluster/${appName}-service forceNewDeployment`);
    planRunner.note('verify owner paths: Telegram sendMessage to the NEW owner chats; SNS = printed manual step');
    planRunner.note(`s3:PutObject state/config-epoch.json (epoch n+1) + journal config-epoch event`);
    planRunner.note(`write CCE_CONFIG_EPOCH + new owner ids into ${envFileNameFor(envFlag)}`);
    log('\n' + bold('PLAN (dry run — nothing was executed)'));
    for (const a of planRunner.actions) log(`  ${a}`);
    log('\n' + ok('dry run complete — zero mutations'));
    closePrompt();
    return;
  }

  // ── Locked mutating phase ──────────────────────────────────────────
  const proceed = await confirm('\nProceed with the LOCKED mutating handover (rotations + redeploy + epoch stamp)?', false);
  if (!proceed) {
    log(info('aborted before any mutation'));
    closePrompt();
    return;
  }

  const owner = `${userInfo().username}@${hostname()}#${process.pid}`;
  let lock: LockHandle;
  try {
    lock = await acquireLock(ddb, names.lockTable, { owner, operation: 'handover', leaseMs: 15 * 60_000 });
  } catch (err) {
    log(fail(err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
    closePrompt();
    return;
  }
  log(ok(`lifecycle lock acquired (operation: handover, fencing token ${lock.fencingToken})`));
  let lockLost = false;
  const stopHeartbeat = startHeartbeat(ddb, names.lockTable, lock, 60_000, (err) => {
    lockLost = true;
    log(fail(`LOCK LOST mid-handover: ${err instanceof Error ? err.message : String(err)} — aborting all further mutations`));
  });

  const runner: StepRunner = createRunner(true);
  const gitSha = manifest?.gitSha ?? 'ffffffffffff';
  const handoverId = newDeployId(gitSha);
  let seq = 0;
  const journal = async (event: string, data?: Record<string, unknown>): Promise<void> => {
    await appendJournal(s3, names.stateBucket, {
      deployId: handoverId,
      seq: seq++,
      event,
      at: new Date().toISOString(),
      fencingToken: lock.fencingToken,
      data,
    });
  };

  try {
    await journal('handover-start', { account, region, operator: owner });

    // ── New owner identity ───────────────────────────────────────────
    const newOwnerTelegram = await answerOr(answers, 'owner-telegram-chats',
      'Incoming operator Telegram chat id(s), CSV (CCE_OWNER_TELEGRAM_CHATS):', env.CCE_OWNER_TELEGRAM_CHATS);
    const newOwnerSlack = await answerOr(answers, 'owner-slack-users',
      'Incoming operator Slack user id(s), CSV (CCE_OWNER_SLACK_USERS):', env.CCE_OWNER_SLACK_USERS ?? '');
    const newOperatorChat = await answerOr(answers, 'operator-telegram-chat',
      'Incoming operator chat id for webhook-monitor alerts (CCE_OPERATOR_TELEGRAM_CHAT_ID):', newOwnerTelegram.split(',')[0] ?? '');
    const ownerChats = newOwnerTelegram.split(',').map((c) => c.trim()).filter((c) => c !== '');

    // ── COMMAND-OWNED rotations ──────────────────────────────────────
    const dashboardValues = generateDashboardSecretValues();
    await rotateDashboardSecret(secrets, `${secretBase}/dashboard`, dashboardValues, runner);
    await journal('dashboard-secret-rotated', { secretId: `${secretBase}/dashboard` });
    const rotatedKeys = await rotateAppOwnedAccessKeys(
      {
        listUsers: (input) => iamSdk.listUsers(input),
        listUserTags: (input) => iamSdk.listUserTags(input),
        listAccessKeys: (input) => iamSdk.listAccessKeys(input),
        createAccessKey: (input) => iamSdk.createAccessKey(input),
        deleteAccessKey: (input) => iamSdk.deleteAccessKey(input),
      },
      classification,
      runner,
    );
    if (rotatedKeys.length > 0) await journal('iam-keys-rotated', { users: rotatedKeys.map((r) => r.userName) });

    // ── EXTERNAL reissues: the blocking gate ─────────────────────────
    const telegramConfigured = secretRows.find((r) => r.secretId.endsWith('/telegram'))?.population === 'populated';
    const slackConfigured = secretRows.find((r) => r.secretId.endsWith('/slack'))?.population === 'populated';
    const specs: ExternalCredentialSpec[] = [];
    if (telegramConfigured || ownerChats.length > 0) {
      specs.push({
        id: 'telegram-bot-token',
        label: 'NEW Telegram bot token (reissued via @BotFather)',
        required: true,
        verify: async (v) => {
          const r = await validateTelegramToken(v);
          return r.ok ? { ok: true, detail: `@${r.username}` } : { ok: false, error: r.error };
        },
      });
    }
    if (slackConfigured) {
      specs.push({
        id: 'slack-bot-token',
        label: 'NEW Slack bot token (reissued app credentials)',
        required: true,
        verify: async (v) => {
          const r = await validateSlackToken(v);
          return r.ok ? { ok: true, detail: `${r.team} as ${r.user}` } : { ok: false, error: r.error };
        },
      });
      specs.push({
        id: 'slack-signing-secret',
        label: 'NEW Slack signing secret',
        required: true,
        verify: async (v) =>
          validateSlackSigningSecret(v)
            ? { ok: true, detail: 'format ok (32-hex)' }
            : { ok: false, error: 'not a 32-char hex Slack signing secret' },
      });
    }

    log('\n' + bold('EXTERNAL CREDENTIAL GATE — completion BLOCKS until every value below verifies live'));
    const supplied: Answers = { ...answers };
    let gate = await runExternalCredentialGate(specs, supplied);
    while (!gate.complete) {
      for (const m of gate.missing) log(warn(`  missing: ${m}`));
      for (const f of gate.failed) log(fail(`  failed verification: ${f.id} (${f.error})`));
      if (answersArg) {
        throw new Error(
          'external-credential gate is incomplete and --answers mode is non-interactive. ' +
            'Handover CANNOT complete until the newly issued external values are supplied and verified.',
        );
      }
      for (const spec of specs) {
        const current = (supplied[spec.id] ?? '').trim();
        const alreadyOk = gate.verified.some((v) => v.id === spec.id);
        if (alreadyOk && current !== '') continue;
        supplied[spec.id] = await ask(`  ${spec.label}:`);
      }
      gate = await runExternalCredentialGate(specs, supplied);
    }
    for (const v of gate.verified) log(ok(`  verified live: ${v.id}${v.detail ? ` (${v.detail})` : ''}`));
    await journal('external-credentials-verified', { ids: gate.verified.map((v) => v.id) });

    if (lockLost) throw new Error('lock lost — refusing to continue');

    // ── Write the newly issued surface secrets ───────────────────────
    const newTelegramToken = (supplied['telegram-bot-token'] ?? '').trim();
    if (newTelegramToken !== '') {
      // Preserve the multi-agent token map + webhook secret; swap `main`.
      let tokens: Record<string, string> = { main: newTelegramToken };
      let webhookSecret: string | undefined;
      try {
        const current = await secretsSdk.getSecretValue({ SecretId: `${secretBase}/telegram` });
        const parsed = JSON.parse(current.SecretString ?? '{}') as { tokens?: string; webhook_secret?: string };
        const map = JSON.parse(parsed.tokens ?? '{}') as Record<string, string>;
        tokens = { ...map, main: newTelegramToken };
        webhookSecret = isPlaceholder(parsed.webhook_secret) ? undefined : parsed.webhook_secret;
      } catch {
        /* unreadable/unpopulated: write a fresh map */
      }
      await runner.mutate(`secretsmanager:PutSecretValue ${secretBase}/telegram (new main bot token)`, () =>
        secretsSdk.putSecretValue({
          SecretId: `${secretBase}/telegram`,
          SecretString: JSON.stringify({ tokens: JSON.stringify(tokens), webhook_secret: webhookSecret ?? 'REPLACE_ME' }),
        }),
      );
      if (env.DOMAIN_NAME) {
        const hook = await telegramSetWebhook(newTelegramToken, `https://${env.DOMAIN_NAME}/telegram`, webhookSecret);
        log(hook.ok ? ok(`  telegram setWebhook → https://${env.DOMAIN_NAME}/telegram`) : warn(`  telegram setWebhook failed: ${hook.error} — run it manually before relying on inbound Telegram`));
      } else {
        log(warn('  no DOMAIN_NAME — register the new bot\'s webhook yourself (see docs/handover.md)'));
      }
    }
    const newSlackToken = (supplied['slack-bot-token'] ?? '').trim();
    if (newSlackToken !== '') {
      // Preserve the app_token field; only the reissued values change.
      let appToken = 'REPLACE_ME';
      try {
        const current = await secretsSdk.getSecretValue({ SecretId: `${secretBase}/slack` });
        const parsed = JSON.parse(current.SecretString ?? '{}') as { app_token?: string };
        if (!isPlaceholder(parsed.app_token)) appToken = parsed.app_token as string;
      } catch {
        /* unreadable/unpopulated: write fresh */
      }
      await runner.mutate(`secretsmanager:PutSecretValue ${secretBase}/slack (new bot token + signing secret)`, () =>
        secretsSdk.putSecretValue({
          SecretId: `${secretBase}/slack`,
          SecretString: JSON.stringify({
            bot_token: newSlackToken,
            signing_secret: (supplied['slack-signing-secret'] ?? '').trim() || 'REPLACE_ME',
            app_token: appToken,
          }),
        }),
      );
    }
    await journal('surface-secrets-updated', {
      telegram: newTelegramToken !== '',
      slack: newSlackToken !== '',
    });

    // ── Forced redeploy so injected values change ────────────────────
    await forceServiceRedeploy(
      { updateService: (input) => ecsSdk.updateService(input) },
      `${appName}-cluster`,
      `${appName}-service`,
      runner,
    );
    await journal('redeploy-forced', { cluster: `${appName}-cluster`, service: `${appName}-service` });

    // ── Verify owner paths reach the INCOMING operator ───────────────
    const verification = await verifyOwnerPaths({
      newTelegramToken: newTelegramToken || undefined,
      newOwnerChatIds: ownerChats,
      send: telegramSend,
      alertTopicArn: env.CCE_ALERT_TOPIC_ARN,
    });
    log('\n' + bold('OWNER-PATH VERIFICATION'));
    for (const line of verification.lines) log(`  ${line}`);
    if (!verification.ok) {
      throw new Error(
        'owner-path verification FAILED — the incoming operator did not verifiably receive owner ' +
          'traffic, so the config epoch was NOT stamped. Fix the owner chat ids / bot token and re-run.',
      );
    }
    await journal('owner-paths-verified', { chats: ownerChats.length });

    if (lockLost) throw new Error('lock lost — refusing to stamp the config epoch');

    // ── Stamp the config epoch (the "handover complete" record) ──────
    const record = await stampConfigEpoch(s3, names.stateBucket, {
      lock,
      ownerPathsVerified: verification.ok,
      handoverId,
      seq: seq++,
      newOwnerLabelHash: hashOwnerIdentity([...ownerChats, ...newOwnerSlack.split(',')]),
      runner,
    });

    // ── Re-point the LOCAL .env (this is the NEW operator's machine) ─
    upsertEnvKeys(envPath, {
      CCE_CONFIG_EPOCH: String(record.epoch),
      CCE_OWNER_TELEGRAM_CHATS: newOwnerTelegram,
      ...(newOwnerSlack ? { CCE_OWNER_SLACK_USERS: newOwnerSlack } : {}),
      ...(newOperatorChat ? { CCE_OPERATOR_TELEGRAM_CHAT_ID: newOperatorChat } : {}),
    });
    log(ok(`local ${envFileNameFor(envFlag)} updated: CCE_CONFIG_EPOCH=${record.epoch} + new owner ids`));
    log(dim('  (CCE_OWNER_LABEL was left unchanged on purpose — the owner-aliased memory history follows the ROLE, not the person)'));

    // ── Completion summary (the only place the new values are shown) ─
    log('\n' + bold(`HANDOVER COMPLETE — config epoch ${record.epoch} stamped at ${record.completedAt}`));
    log(bold('Hand these to the incoming operator over a secure channel; they are shown ONCE:'));
    log(`  dashboard token: ${dashboardValues.token}`);
    log(`  dashboard PIN:   ${dashboardValues.pin}`);
    log(`  kill phrase:     ${dashboardValues.killPhrase}`);
    for (const k of rotatedKeys) {
      log(`  IAM ${k.userName}: ${k.newAccessKeyId} / ${k.newSecretAccessKey} (deleted: ${k.deletedKeyIds.join(', ') || 'none'})`);
    }
    log('\nRemaining MANUAL steps (handover is complete only when these are done too):');
    log('  - SNS alert subscriptions: subscribe + confirm from the incoming operator\'s inbox, then test-publish.');
    log('  - Work every unchecked ACCESS TRANSFER line above (root/billing contacts, GitHub, registrar, ...).');
    log(`  - Any other machine with an old .env will now FAIL doctor/deploy until it re-runs setup (epoch ${record.epoch}).`);
  } catch (err) {
    log(fail(`handover aborted: ${err instanceof Error ? err.message : String(err)}`));
    log(info('No config epoch was stamped unless the COMPLETE line printed above. Re-run after fixing the cause; completed rotations are idempotent to repeat.'));
    process.exitCode = 1;
  } finally {
    stopHeartbeat();
    const released = await releaseLock(ddb, names.lockTable, lock).catch(() => false);
    if (released) log(dim('lifecycle lock released'));
    closePrompt();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(fail(`fatal error during handover: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});
