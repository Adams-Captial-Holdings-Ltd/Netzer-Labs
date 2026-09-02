/**
 * Netzar OS Enterprise — Paperclip tenant bootstrap
 *
 *   npx tsx scripts/paperclip-bootstrap.ts [--env=staging] [--dry-run]
 *
 * Provisions the deployed Paperclip instance into the shape the ACL, the
 * reconciler and the dispatch route all assume: ONE company, ONE responsible
 * user, N agents wired to `adapterType: "http"` pointing back at Netzar, and
 * N+1 API keys — one per agent plus the company-wide reconciler key — and the
 * company id written into `/claudeclaw[-suffix]/paperclip`.
 *
 * FOUR PROPERTIES THIS SCRIPT IS BUILT AROUND
 *
 *  1. IDEMPOTENT, PROVABLY. A second run performs zero POSTs, PATCHes and
 *     DELETEs, and says so: it prints `created 0 / reused N`. Everything is
 *     recognized by a deterministic identifier — an agent by
 *     `metadata.netzarAgentId`, a key by its name — never by position or by
 *     display name.
 *  2. NO TOKEN IS EVER PRINTED. Paperclip reveals an API token exactly once,
 *     at creation. It goes straight into Secrets Manager and nowhere else: not
 *     stdout, not the journal, not an error message. What is printed is the
 *     key's NAME, its id and its SCOPE.
 *  3. THE SCOPE IS `standard`, AND IT IS PRINTED (A1-9). A `task_bridge`-scoped
 *     key looks more secure and is hard-403'd on the company-wide issue list
 *     with "Task bridge keys cannot use company-wide issue list APIs" — which
 *     silently breaks the reconciler rather than failing it loudly.
 *  4. THE SECRET IS MERGED, NEVER REPLACED. `PutSecretValue` swaps the whole
 *     string, so writing `{reconciler_key}` alone would wipe
 *     `better_auth_secret` (deploy phase b) and `database_url` (phase b.5), and
 *     the Paperclip task would stop starting.
 *
 * The protocol calls live in `scripts/lib/paperclip/bootstrap-core.ts`, shared
 * with the local harness fixture so the two cannot drift apart. All four
 * properties above are asserted there by `bootstrap-core.test.ts`, against an
 * in-memory Paperclip that records every request — which is what makes "a
 * re-run is a no-op" a test rather than a claim. What stays in THIS file is
 * env loading, printing and Secrets Manager: the parts a test would have to
 * mock rather than exercise.
 *
 * REQUIRED ENV (from `.env[.<name>]` or the process env)
 *   PAPERCLIP_BASE_URL        exact origin of the running instance
 *   CCE_PAPERCLIP_ADMIN_EMAIL per-environment responsible user; named, never shared
 *   PAPERCLIP_ADMIN_PASSWORD  its password
 *   PAPERCLIP_DISPATCH_URL    Netzar's inbound dispatch route (Phase 6)
 * OPTIONAL
 *   PAPERCLIP_AGENTS          comma-separated Netzar agent slugs, default
 *                             `main,research`; `main` is the `ceo` and every
 *                             other agent reports to it
 *   PAPERCLIP_BOOTSTRAP_INVITE  one-time invite token from
 *                             `auth bootstrap-ceo`, for a brand-new instance
 *   PAPERCLIP_COMPANY_NAME    display name, default `Netzar OS`
 *
 * REACHING A PRIVATE INSTANCE. The service has no public listener in either
 * real environment, so run this against `http://127.0.0.1:3100` through an SSM
 * port-forward to the Paperclip task. The very first run additionally needs an
 * invite, which is minted inside the container:
 *   aws ecs execute-command --cluster claudeclaw-cluster \
 *     --task <taskArn> --container paperclip-server --interactive \
 *     --command "node --import ./server/node_modules/tsx/dist/loader.mjs \
 *       cli/src/index.ts auth bootstrap-ceo --force"
 * Paste the `/invite/pcp_bootstrap_...` token into PAPERCLIP_BOOTSTRAP_INVITE.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import { bold, cyan, dim, fail, gray, info, ok, section, warn } from './lib/ansi.js';
import { envFileNameFor, parseEnvFile, resolveEnvFlag } from './lib/env-file.js';
import { maybePrintHelp } from './lib/help.js';
import {
  CookieJar,
  RECONCILER_KEY_NAME,
  agentKeyName,
  agentSpecs,
  assertResponsibleUserAuthzUnset,
  ensureAgents,
  ensureCompany,
  jsonResponse,
  listAgents,
  listCompanies,
  netzarAgentId,
  makeBoardRequest,
  reconcileKey,
  signUpOrSignIn,
  type AgentRecord,
  type AgentSpec,
  type KeyOutcome,
  type PaperclipRequest,
} from './lib/paperclip/bootstrap-core.js';
import {
  loadBootstrapSecretFields,
  mergeBootstrapSecretFields,
  parseBootstrapAgentKeys,
  writeBootstrapSecretFields,
} from './lib/paperclip/bootstrap-secret.js';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Merged view of `.env[.<name>]` and the process env; process env wins. */
function loadEnv(argv: string[]): Record<string, string> {
  const file = join(repoRoot, envFileNameFor(resolveEnvFlag(argv)));
  const fromFile = existsSync(file) ? parseEnvFile(readFileSync(file, 'utf-8')) : {};
  const merged: Record<string, string> = { ...fromFile };
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) merged[k] = v;
  return merged;
}

function required(env: Record<string, string>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required (set it in .env or the environment)`);
  return value;
}

/**
 * Resolve the agent slug list from the environment. The chart itself (`main`
 * is the `ceo`, everything else reports to it) and the adapter wiring live in
 * bootstrap-core so a test can name them.
 */
function specsFromEnv(env: Record<string, string>, dispatchSecret: string): AgentSpec[] {
  return agentSpecs({
    slugs: (env.PAPERCLIP_AGENTS ?? 'main,research')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    dispatchUrl: required(env, 'PAPERCLIP_DISPATCH_URL'),
    dispatchSecret,
  });
}

/**
 * Read-only twin of `ensureAgents` for --dry-run: reports which agents WOULD be
 * created without creating any. Kept beside the real call rather than as a flag
 * inside it, so the write path has no dry-run branch to get wrong.
 */
async function previewAgents(
  request: PaperclipRequest,
  companyId: string,
  specs: AgentSpec[],
): Promise<{ agents: Map<string, AgentRecord>; created: string[] }> {
  const bySlug = new Map<string, AgentRecord>();
  for (const agent of await listAgents(request, companyId)) {
    const slug = netzarAgentId(agent);
    if (slug) bySlug.set(slug, agent);
  }
  return { agents: bySlug, created: specs.filter((s) => !bySlug.has(s.slug)).map((s) => s.slug) };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (
    maybePrintHelp(argv, {
      command: 'npx tsx scripts/paperclip-bootstrap.ts',
      oneLiner: 'idempotent Paperclip tenant bootstrap: company, responsible user, agents, keys',
      flags: [
        ['--env=<name>', 'read .env.<name> instead of .env'],
        ['--dry-run', 'report what would change; create nothing, write nothing'],
      ],
      contract:
        'Creates Paperclip records and writes ONE Secrets Manager version; no AWS infrastructure ' +
        'and no cost. A re-run with nothing to do writes nothing at all.',
      docs: 'docs/features/paperclip/bar-and-phases.md (Phase 4)',
    })
  ) {
    return;
  }
  const dryRun = argv.includes('--dry-run');
  const env = loadEnv(argv);

  // Phase 4 acceptance: this must stay UNSET. It relaxes which user a minted
  // key is attributed to, which would make `responsibleUserId` — the only
  // human accountability on an agent key — meaningless.
  assertResponsibleUserAuthzUnset(env);

  const baseUrl = required(env, 'PAPERCLIP_BASE_URL').replace(/\/+$/, '');
  const suffix = env.CCE_NAME_SUFFIX?.trim() ?? '';
  const secretId = suffix ? `/claudeclaw-${suffix}/paperclip` : '/claudeclaw/paperclip';
  const region = env.AWS_REGION?.trim() || 'us-east-1';
  // Fail fast on the one required value agentSpecs() needs, before any call.
  required(env, 'PAPERCLIP_DISPATCH_URL');

  // eslint-disable-next-line no-console
  console.log('\n' + bold('Paperclip tenant bootstrap'));
  // eslint-disable-next-line no-console
  console.log(gray('─'.repeat(36)));
  // eslint-disable-next-line no-console
  console.log(dim(`  instance ${baseUrl}`));
  // eslint-disable-next-line no-console
  console.log(dim(`  secret   ${secretId} (${region})`));
  if (dryRun) {
    // eslint-disable-next-line no-console
    console.log(warn('--dry-run: nothing will be created or written'));
  }

  // ── Board session as the ONE responsible user ─────────────────────
  section('Responsible user');
  const request = makeBoardRequest(baseUrl, new CookieJar());
  await signUpOrSignIn(request, {
    name: env.PAPERCLIP_ADMIN_NAME?.trim() || 'Netzar Operator',
    email: required(env, 'CCE_PAPERCLIP_ADMIN_EMAIL'),
    password: required(env, 'PAPERCLIP_ADMIN_PASSWORD'),
  });
  const invite = env.PAPERCLIP_BOOTSTRAP_INVITE?.trim();
  if (invite) {
    const accept = await request(`/api/invites/${encodeURIComponent(invite)}/accept`, {
      method: 'POST',
      body: JSON.stringify({ requestType: 'human' }),
    });
    if (!accept.ok) {
      const detail = (await accept.json().catch(() => null)) as { error?: unknown } | null;
      throw new Error(
        `bootstrap invite acceptance returned HTTP ${accept.status}` +
          (typeof detail?.error === 'string' ? `: ${detail.error}` : ''),
      );
    }
    // eslint-disable-next-line no-console
    console.log(ok('accepted the one-time bootstrap invite'));
  }
  const session = await jsonResponse<unknown>(
    await request('/api/auth/get-session'),
    'Paperclip session verification',
  );
  if (!JSON.stringify(session).includes('userId')) {
    throw new Error(
      'no board session. A brand-new instance needs PAPERCLIP_BOOTSTRAP_INVITE once ' +
        '(see the header of this file for the ECS Exec command that mints it).',
    );
  }
  // eslint-disable-next-line no-console
  console.log(ok(`signed in as ${env.CCE_PAPERCLIP_ADMIN_EMAIL}`));

  // ── One company ───────────────────────────────────────────────────
  section('Company');
  const listed = await listCompanies(request);
  if (dryRun && listed.length === 0) {
    // eslint-disable-next-line no-console
    console.log(info('would create the company; nothing further can be reported without it'));
    return;
  }
  const company = dryRun
    ? listed[0]
    : await ensureCompany(request, {
    // Paperclip derives the issue prefix from the name it is CREATED with and
    // keeps it across renames, so the create name carries the prefix and the
    // display name is set immediately after.
    createName: `NZR ${env.PAPERCLIP_COMPANY_NAME?.trim() || 'Netzar OS'}`,
    displayName: env.PAPERCLIP_COMPANY_NAME?.trim() || 'Netzar OS',
  });
  // eslint-disable-next-line no-console
  console.log(ok(`company ${company.name} (${company.id}) prefix ${company.issuePrefix}`));

  // ── Existing credentials ──────────────────────────────────────────
  // Read BEFORE the agents are created, because an agent's adapter_config
  // carries the dispatch secret and Paperclip does not interpolate it.
  section('Stored credentials');
  const secretsClient = new SecretsManagerClient({ region });
  // In --dry-run an unreadable secret is reported, not fatal: the whole point
  // of the flag is that an operator can inspect a running instance without AWS
  // credentials in hand. Everything downstream then behaves as if nothing is
  // stored, which is the conservative direction (it over-reports work to do).
  const fields = await loadBootstrapSecretFields({
    secretId,
    dryRun,
    read: async () => {
      const current = await secretsClient.send(
        new GetSecretValueCommand({ SecretId: secretId }),
      );
      return current.SecretString;
    },
    // eslint-disable-next-line no-console
    warn: (message) => console.log(warn(message)),
  });
  const storedAgentKeys = parseBootstrapAgentKeys({
    value: fields.agent_keys,
    secretId,
    dryRun,
    // eslint-disable-next-line no-console
    warn: (message) => console.log(warn(message)),
  });
  const storedReconciler =
    fields.reconciler_key && fields.reconciler_key !== 'REPLACE_ME'
      ? fields.reconciler_key
      : undefined;
  // Minted ONCE and then left alone: re-minting on every run would rotate the
  // secret out from under the adapter_config that carries it.
  const mintedDispatchSecret =
    !fields.dispatch_secret || fields.dispatch_secret === 'REPLACE_ME';
  if (mintedDispatchSecret) {
    const { randomBytes } = await import('node:crypto');
    fields.dispatch_secret = randomBytes(32).toString('hex');
  }
  // eslint-disable-next-line no-console
  console.log(
    mintedDispatchSecret
      ? (dryRun ? info('would mint dispatch_secret') : ok('minted dispatch_secret (value not shown)'))
      : dim('  dispatch_secret already present'),
  );
  const specs = specsFromEnv(env, fields.dispatch_secret);

  // ── N agents ──────────────────────────────────────────────────────
  section('Agents');
  const { agents, created } = dryRun
    ? await previewAgents(request, company.id, specs)
    : await ensureAgents(request, company.id, specs);
  for (const slug of created) {
    // eslint-disable-next-line no-console
    console.log(dryRun ? info(`would create ${slug}`) : ok(`created ${slug}`));
  }
  for (const spec of specs) {
    const agent = agents.get(spec.slug);
    if (!agent) continue;
    if (agent.role !== spec.role) {
      throw new Error(
        `agent ${spec.slug} has role '${agent.role}', expected '${spec.role}'. Fix it in the ` +
          'Paperclip board; this script never re-roles an existing agent.',
      );
    }
    if (agent.adapterType !== 'http') {
      throw new Error(
        `agent ${spec.slug} has adapterType '${agent.adapterType}', expected 'http'. Paperclip ` +
          'must dispatch INTO Netzar, never run the work itself.',
      );
    }
    // eslint-disable-next-line no-console
    console.log(`  ${dim('present')} ${spec.slug} → ${agent.id} (${agent.role})`);
  }

  // ── N+1 keys ──────────────────────────────────────────────────────
  section('API keys');
  const outcomes: KeyOutcome[] = [];
  const mainAgent = agents.get('main');
  if (!dryRun && !mainAgent) throw new Error("the 'main' agent is missing after provisioning");
  if (!mainAgent) {
    // eslint-disable-next-line no-console
    console.log(info("would mint N+1 keys once the 'main' agent exists"));
  }
  if (mainAgent) {
    // ONE company-wide reconciler key, on the ceo actor. Standard scope.
    outcomes.push(
      await reconcileKey(
        request,
        mainAgent,
        RECONCILER_KEY_NAME,
        '(reconciler)',
        storedReconciler,
        dryRun,
      ),
    );
    for (const spec of specs) {
      const agent = agents.get(spec.slug)!;
      outcomes.push(
        await reconcileKey(
          request,
          agent,
          agentKeyName(spec.slug),
          spec.slug,
          storedAgentKeys[spec.slug],
          dryRun,
        ),
      );
    }
  }
  for (const outcome of outcomes) {
    const mark = dryRun
      ? info(outcome.action === 'reused' ? 'is current' : 'would mint')
      : outcome.action === 'reused'
        ? dim('reused  ')
        : outcome.action === 'replaced'
          ? warn('replaced')
          : ok('created ');
    // The SCOPE is printed (A1-9). The token never is.
    // eslint-disable-next-line no-console
    console.log(`  ${mark} ${outcome.keyName} id=${outcome.keyId} scope=${outcome.scope}`);
  }

  // ── Write back, merged ────────────────────────────────────────────
  section('Secrets Manager');
  const nextFields = mergeBootstrapSecretFields({
    current: fields,
    companyId: company.id,
    storedAgentKeys,
    outcomes,
  });
  // C-19: the SHIPPED spellings win — `agent_keys` (a JSON STRING, because an
  // ECS secret injects one field as one env var: PAPERCLIP_AGENT_KEYS_JSON)
  // and `dispatch_secret`. `agent_keys_json` / `dispatch_token` are the plan's
  // wrong variants, and a field mismatch is a task that cannot start.
  // `fields` already carries a freshly minted dispatch_secret when there was
  // none, so compare against what Secrets Manager actually holds.
  const changed = mintedDispatchSecret || JSON.stringify(nextFields) !== JSON.stringify(fields);
  if (dryRun) {
    // eslint-disable-next-line no-console
    console.log(info(changed ? 'would write one new secret version' : 'secret already current'));
  } else if (changed) {
    await writeBootstrapSecretFields({
      fields: nextFields,
      write: async (secretString) => {
        await secretsClient.send(
          new PutSecretValueCommand({
            SecretId: secretId,
            // MERGED: `fields` is the whole current value and only named keys are
            // overwritten, so better_auth_secret (phase b) and database_url
            // (phase b.5) survive.
            SecretString: secretString,
          }),
        );
      },
    });
    // eslint-disable-next-line no-console
    console.log(ok(`wrote ${secretId} (fields: ${Object.keys(nextFields).sort().join(', ')})`));
  } else {
    // eslint-disable-next-line no-console
    console.log(dim('  secret already current; nothing written'));
  }

  // ── The no-op proof ───────────────────────────────────────────────
  const createdKeys = outcomes.filter((o) => o.action !== 'reused').length;
  section('Result');
  // eslint-disable-next-line no-console
  console.log(
    `  agents created ${created.length}, reused ${specs.length - created.length}; ` +
      `keys created ${createdKeys}, reused ${outcomes.length - createdKeys}`,
  );
  if (created.length === 0 && createdKeys === 0 && !changed) {
    // eslint-disable-next-line no-console
    console.log(ok('no-op: this run created nothing and wrote nothing'));
  } else {
    // eslint-disable-next-line no-console
    console.log(info('re-run this command; a correct bootstrap reports a no-op the second time'));
  }
  // eslint-disable-next-line no-console
  console.log(
    dim('  Tokens are never printed. Read them from Secrets Manager, or rotate by revoking\n') +
      dim(`  the named key in the Paperclip board and re-running: ${cyan(secretId)}`),
  );
}

main().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.log(fail(err instanceof Error ? err.message : String(err)));
  process.exitCode = 1;
});
