/**
 * Local docker-harness bootstrap for the pinned Paperclip artifact.
 *
 * The PROTOCOL half — board session, company, agents, API keys — lives in
 * `scripts/lib/paperclip/bootstrap-core.ts` and is shared byte-for-byte with
 * the deployed bootstrap (`scripts/paperclip-bootstrap.ts`), so the harness
 * and production cannot drift apart on how Paperclip is actually called.
 *
 * What stays HERE is everything that is true only of a DISPOSABLE stack: the
 * docker-exec onboarding, the in-container credential cache, and the strict
 * "exactly two agents, exactly these keys, nothing else active" assertions.
 * Those would be wrong on a real tenant, which is why they are not in the
 * shared module.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  CookieJar,
  RECONCILER_KEY_NAME,
  agentKeyName,
  createKey,
  ensureAgents,
  ensureCompany,
  jsonResponse,
  listActiveKeys,
  listAgents,
  makeBoardRequest,
  netzarAgentId,
  revokeKey,
  signUpOrSignIn,
  type AgentKeyRecord,
  type AgentRecord,
  type AgentSpec,
  type CompanyRecord,
  type PaperclipRequest,
} from '../../scripts/lib/paperclip/bootstrap-core.js';

const execFileAsync = promisify(execFile);
const BASE_URL = process.env.PAPERCLIP_TEST_BASE_URL ?? 'http://127.0.0.1:3100';
const COMPOSE_FILE = 'docker-compose.paperclip.yml';
const ADMIN_EMAIL = 'netzar-paperclip-integration@example.invalid';
const ADMIN_PASSWORD = 'Netzar-Paperclip-Integration-2026!';
const CONFIG_PATH = '/paperclip/instances/default/config.json';
const CREDENTIAL_CACHE_PATH = '/dev/shm/netzar-paperclip-integration-credentials.json';

interface DockerResult {
  stdout: string;
  stderr: string;
}

/** The two Netzar agents the harness provisions, in creation order. */
const HARNESS_AGENTS: AgentSpec[] = [
  {
    slug: 'main',
    name: 'Netzar Main',
    role: 'ceo',
    reportsToSlug: null,
    adapterConfig: {
      url: 'http://127.0.0.1:9/api/paperclip/dispatch',
      method: 'POST',
      headers: { authorization: 'Bearer paperclip-integration-test' },
      payloadTemplate: { netzarAgentId: 'main' },
      timeoutMs: 1_000,
    },
  },
  {
    slug: 'research',
    name: 'Netzar Research',
    role: 'general',
    reportsToSlug: 'main',
    adapterConfig: {
      url: 'http://127.0.0.1:9/api/paperclip/dispatch',
      method: 'POST',
      headers: { authorization: 'Bearer paperclip-integration-test' },
      payloadTemplate: { netzarAgentId: 'research' },
      timeoutMs: 1_000,
    },
  },
];

export interface PaperclipBootstrapAgent {
  id: string;
  key: string;
}

export interface PaperclipBootstrap {
  baseUrl: string;
  companyId: string;
  reconcilerKey: string;
  agents: {
    main: PaperclipBootstrapAgent;
    research: PaperclipBootstrapAgent;
  };
}

interface CachedPaperclipCredentials {
  companyId: string;
  reconciler: { keyId: string; token: string };
  main: { agentId: string; keyId: string; token: string };
  research: { agentId: string; keyId: string; token: string };
}

function dockerExecutable(): string {
  if (process.env.DOCKER_BIN) return process.env.DOCKER_BIN;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const dockerDesktop = path.join(
      process.env.LOCALAPPDATA,
      'Programs',
      'DockerDesktop',
      'resources',
      'bin',
      'docker.exe',
    );
    if (existsSync(dockerDesktop)) return dockerDesktop;
  }
  return 'docker';
}

async function runDocker(args: string[], acceptedExitCodes: number[] = [0]): Promise<DockerResult> {
  try {
    const result = await execFileAsync(dockerExecutable(), args, {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    return { stdout: String(result.stdout), stderr: String(result.stderr) };
  } catch (error) {
    const commandError = error as Error & { code?: number | string; stdout?: string; stderr?: string };
    const exitCode = typeof commandError.code === 'number' ? commandError.code : Number.NaN;
    if (acceptedExitCodes.includes(exitCode)) {
      return {
        stdout: commandError.stdout ?? '',
        stderr: commandError.stderr ?? '',
      };
    }
    throw new Error(`Docker command failed${Number.isNaN(exitCode) ? '' : ` with exit code ${exitCode}`}`);
  }
}

async function runDockerWithInput(args: string[], input: string): Promise<DockerResult> {
  return await new Promise((resolve, reject) => {
    const child = execFile(dockerExecutable(), args, {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error('Docker command failed'));
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
    child.stdin?.end(input);
  });
}

let containerIdPromise: Promise<string> | undefined;
let databaseContainerIdPromise: Promise<string> | undefined;

async function paperclipContainerId(): Promise<string> {
  containerIdPromise ??= runDocker([
    'compose',
    '-f',
    COMPOSE_FILE,
    'ps',
    '-q',
    'paperclip',
  ]).then(({ stdout }) => {
    const ids = stdout.trim().split(/\s+/).filter(Boolean);
    if (ids.length !== 1) throw new Error('Expected exactly one running Paperclip test container');
    return ids[0];
  });
  return containerIdPromise;
}

async function readCredentialCache(): Promise<CachedPaperclipCredentials | null> {
  const containerId = await paperclipContainerId();
  const { stdout } = await runDocker([
    'exec',
    containerId,
    'sh',
    '-lc',
    `if [ -f ${CREDENTIAL_CACHE_PATH} ]; then cat ${CREDENTIAL_CACHE_PATH}; fi`,
  ]);
  if (!stdout.trim()) return null;
  try {
    return JSON.parse(stdout) as CachedPaperclipCredentials;
  } catch {
    throw new Error('Paperclip integration credential cache is invalid');
  }
}

async function writeCredentialCache(credentials: CachedPaperclipCredentials): Promise<void> {
  const containerId = await paperclipContainerId();
  await runDockerWithInput([
    'exec',
    '-i',
    containerId,
    'sh',
    '-lc',
    `umask 077; cache_tmp=${CREDENTIAL_CACHE_PATH}.tmp; cat > "$cache_tmp" && mv "$cache_tmp" ${CREDENTIAL_CACHE_PATH}`,
  ], JSON.stringify(credentials));
}

async function databaseContainerId(): Promise<string> {
  databaseContainerIdPromise ??= runDocker([
    'compose',
    '-f',
    COMPOSE_FILE,
    'ps',
    '-q',
    'paperclip-db',
  ]).then(({ stdout }) => {
    const ids = stdout.trim().split(/\s+/).filter(Boolean);
    if (ids.length !== 1) throw new Error('Expected exactly one running Paperclip database test container');
    return ids[0];
  });
  return databaseContainerIdPromise;
}

async function enableSqlStateLogging(): Promise<void> {
  const databaseId = await databaseContainerId();
  const psql = ['exec', databaseId, 'psql', '-v', 'ON_ERROR_STOP=1', '-U', 'paperclip', '-d', 'paperclip', '-c'];
  await runDocker([...psql, "ALTER SYSTEM SET log_error_verbosity = 'verbose'"]);
  await runDocker([...psql, 'SELECT pg_reload_conf()']);
}

async function createBootstrapInvite(containerId: string): Promise<string> {
  // Onboard writes the config, then tries to start a server and may exit 1 as
  // root at v2026.916.1 (decision-signing ownership check) or when :3100 is
  // taken; the next step reads the config and fails loudly if it was not
  // written.
  const onboard = await runDocker([
    'exec',
    containerId,
    'sh',
    '-lc',
    `test -f ${CONFIG_PATH} || timeout 12s node --import ./server/node_modules/tsx/dist/loader.mjs cli/src/index.ts onboard --yes`,
  ], [0, 1, 124]);
  void onboard;

  const configure = [
    "const fs=require('node:fs')",
    `const p='${CONFIG_PATH}'`,
    "const c=JSON.parse(fs.readFileSync(p,'utf8'))",
    "c.server.deploymentMode='authenticated'",
    "fs.writeFileSync(p,JSON.stringify(c,null,2)+'\\n')",
  ].join(';');
  await runDocker(['exec', containerId, 'node', '-e', configure]);

  const bootstrap = await runDocker([
    'exec',
    containerId,
    'sh',
    '-lc',
    `timeout 20s node --import ./server/node_modules/tsx/dist/loader.mjs cli/src/index.ts auth bootstrap-ceo --config ${CONFIG_PATH} --base-url http://127.0.0.1:3100 --force`,
  ], [0, 124]);
  const match = `${bootstrap.stdout}\n${bootstrap.stderr}`.match(/\/invite\/(pcp_bootstrap_[A-Za-z0-9]+)/);
  if (!match) throw new Error('Paperclip bootstrap command did not yield an invite token');
  return match[1];
}

async function establishAdminSession(request: PaperclipRequest): Promise<void> {
  const authRequest: PaperclipRequest = async (pathname, init) => {
    let response: Response;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      response = await request(pathname, init);
      if (response.status !== 429 || attempt === 3) return response;
      const retryAfter = Number(response.headers.get('retry-after') ?? response.headers.get('x-retry-after'));
      await new Promise((resolve) => setTimeout(resolve, (Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 11) * 1_000));
    }
    throw new Error('Paperclip auth retry exhausted');
  };
  await signUpOrSignIn(authRequest, {
    name: 'Netzar Paperclip Integration',
    email: ADMIN_EMAIL,
    password: ADMIN_PASSWORD,
  });
  const health = await fetch(`${BASE_URL}/api/health`);
  const healthBody = health.ok
    ? await health.json().catch(() => null) as { bootstrapStatus?: unknown } | null
    : null;
  if (healthBody?.bootstrapStatus === 'ready') {
    const companies = await request('/api/companies');
    if (companies.ok) return;
  }

  const token = await createBootstrapInvite(await paperclipContainerId());
  const accept = await request(`/api/invites/${encodeURIComponent(token)}/accept`, {
    method: 'POST',
    body: JSON.stringify({ requestType: 'human' }),
  });
  if (!accept.ok) {
    const detail = await accept.json().catch(() => null) as { error?: unknown } | null;
    const safeDetail = typeof detail?.error === 'string' ? `: ${detail.error}` : '';
    throw new Error(`Paperclip bootstrap invite acceptance returned HTTP ${accept.status}${safeDetail}`);
  }

  const session = await request('/api/auth/get-session');
  const sessionBody = await jsonResponse<unknown>(session, 'Paperclip session verification');
  if (!JSON.stringify(sessionBody).includes('userId')) {
    throw new Error('Paperclip session verification did not return a user id');
  }
}

async function provisionCompany(request: PaperclipRequest): Promise<CompanyRecord> {
  const company = await ensureCompany(request, {
    // The issue prefix is derived from the FIRST name and survives the
    // rename, which is why the two differ.
    createName: 'NZR Netzar OS',
    displayName: 'Netzar OS',
  });
  if (company.issuePrefix !== 'NZR') throw new Error('Paperclip company did not retain the NZR issue prefix');
  return company;
}

async function provisionAgents(
  request: PaperclipRequest,
  companyId: string,
): Promise<{ main: AgentRecord; research: AgentRecord }> {
  await ensureAgents(request, companyId, HARNESS_AGENTS);

  const listed = await listAgents(request, companyId);
  let main = listed.find((agent) => netzarAgentId(agent) === 'main');
  let research = listed.find((agent) => netzarAgentId(agent) === 'research');
  const netzarAgents = listed.filter((agent) => netzarAgentId(agent) !== undefined);
  if (netzarAgents.length !== 2) {
    throw new Error('Paperclip integration fixture requires exactly two Netzar HTTP agents');
  }
  const allowedSystemAgents = new Map([
    ['Reflection Coach', 'claude_local:paused'],
    ['Summarizer', 'claude_local:paused'],
  ]);
  for (const agent of listed.filter((candidate) => netzarAgentId(candidate) === undefined)) {
    if (allowedSystemAgents.get(agent.name) !== `${agent.adapterType}:${agent.status}`) {
      throw new Error(`Unexpected unmapped Paperclip agent: ${agent.name}`);
    }
  }
  main = listed.find((agent) => netzarAgentId(agent) === 'main');
  research = listed.find((agent) => netzarAgentId(agent) === 'research');
  const mainSlug = main?.adapterConfig?.payloadTemplate?.netzarAgentId;
  const researchSlug = research?.adapterConfig?.payloadTemplate?.netzarAgentId;
  if (
    !main
    || !research
    || main.role !== 'ceo'
    || main.reportsTo !== null
    || research.reportsTo !== main.id
    || main.adapterType !== 'http'
    || research.adapterType !== 'http'
    || mainSlug !== 'main'
    || researchSlug !== 'research'
  ) {
    throw new Error('Paperclip integration agents do not match the required Netzar org chart');
  }
  return { main, research };
}

async function assertActiveKeys(
  request: PaperclipRequest,
  agentId: string,
  expectedNames: string[],
): Promise<Map<string, AgentKeyRecord>> {
  const active = await listActiveKeys(request, agentId);
  const actualNames = active.map((key) => key.name).sort();
  const requiredNames = [...expectedNames].sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(requiredNames)) {
    throw new Error('Paperclip integration fixture did not provision the exact required active key set');
  }
  if (active.some((key) => key.scope?.kind !== 'standard' || !key.responsibleUserId)) {
    throw new Error('Paperclip integration keys require standard scope and a responsible user');
  }
  return new Map(active.map((key) => [key.name, key]));
}

async function provisionKeys(
  request: PaperclipRequest,
  companyId: string,
  agents: { main: AgentRecord; research: AgentRecord },
): Promise<{ reconcilerKey: string; mainKey: string; researchKey: string }> {
  const cached = await readCredentialCache();
  if (cached) {
    const mainKeys = await assertActiveKeys(request, agents.main.id, [RECONCILER_KEY_NAME, agentKeyName('main')]);
    const researchKeys = await assertActiveKeys(request, agents.research.id, [agentKeyName('research')]);
    const validCache = cached.companyId === companyId
      && cached.main.agentId === agents.main.id
      && cached.research.agentId === agents.research.id
      && mainKeys.get(RECONCILER_KEY_NAME)?.id === cached.reconciler.keyId
      && mainKeys.get(agentKeyName('main'))?.id === cached.main.keyId
      && researchKeys.get(agentKeyName('research'))?.id === cached.research.keyId
      && cached.reconciler.token.startsWith('pcp_')
      && cached.main.token.startsWith('pcp_')
      && cached.research.token.startsWith('pcp_');
    if (!validCache) throw new Error('Paperclip integration credential cache does not match active keys');
    return {
      reconcilerKey: cached.reconciler.token,
      mainKey: cached.main.token,
      researchKey: cached.research.token,
    };
  }

  const existing = [
    ...(await listActiveKeys(request, agents.main.id)),
    ...(await listActiveKeys(request, agents.research.id)),
  ];
  if (existing.length > 0) {
    throw new Error('Active Paperclip integration keys exist without the in-memory credential cache; reset the disposable stack');
  }

  const created: Array<{ agentId: string; keyId: string }> = [];
  try {
    const reconciler = await createKey(request, agents.main.id, RECONCILER_KEY_NAME);
    created.push({ agentId: agents.main.id, keyId: reconciler.id });
    const main = await createKey(request, agents.main.id, agentKeyName('main'));
    created.push({ agentId: agents.main.id, keyId: main.id });
    const research = await createKey(request, agents.research.id, agentKeyName('research'));
    created.push({ agentId: agents.research.id, keyId: research.id });
    await assertActiveKeys(request, agents.main.id, [RECONCILER_KEY_NAME, agentKeyName('main')]);
    await assertActiveKeys(request, agents.research.id, [agentKeyName('research')]);
    await writeCredentialCache({
      companyId,
      reconciler: { keyId: reconciler.id, token: reconciler.token },
      main: { agentId: agents.main.id, keyId: main.id, token: main.token },
      research: { agentId: agents.research.id, keyId: research.id, token: research.token },
    });
    return {
      reconcilerKey: reconciler.token,
      mainKey: main.token,
      researchKey: research.token,
    };
  } catch (error) {
    await Promise.allSettled(created.map(async ({ agentId, keyId }) => {
      await revokeKey(request, agentId, keyId);
    }));
    throw error;
  }
}

let adminRequest: PaperclipRequest | undefined;

async function bootstrap(): Promise<PaperclipBootstrap> {
  const request = makeBoardRequest(BASE_URL, new CookieJar());
  await enableSqlStateLogging();
  await establishAdminSession(request);
  adminRequest = request;
  const company = await provisionCompany(request);
  const agents = await provisionAgents(request, company.id);
  const keys = await provisionKeys(request, company.id, agents);

  return {
    baseUrl: BASE_URL,
    companyId: company.id,
    reconcilerKey: keys.reconcilerKey,
    agents: {
      main: { id: agents.main.id, key: keys.mainKey },
      research: { id: agents.research.id, key: keys.researchKey },
    },
  };
}

let bootstrapPromise: Promise<PaperclipBootstrap> | undefined;

export function bootstrapPaperclip(): Promise<PaperclipBootstrap> {
  bootstrapPromise ??= bootstrap();
  return bootstrapPromise;
}

/**
 * Issue a request as the bootstrapped board admin, reusing this fixture's own
 * authenticated session rather than establishing a second one.
 *
 * Only key administration needs this: minting an API key is a board-session
 * operation, and no agent key can mint another. The A1-9 contract probe uses it
 * to create a task_bridge-scoped key, which `provisionKeys` deliberately cannot
 * make (it asserts every provisioned key is standard scope). A caller that
 * creates a key MUST revoke it again, because `assertActiveKeys` fails the next
 * bootstrap if an unexpected active key survives.
 */
export async function paperclipAdminRequest(pathname: string, init: RequestInit = {}): Promise<Response> {
  await bootstrapPaperclip();
  if (!adminRequest) throw new Error('Paperclip admin session is not established');
  return await adminRequest(pathname, init);
}

export async function readPaperclipLogsSince(since: string): Promise<string> {
  const [app, database] = await Promise.all([
    runDocker(['logs', '--since', since, await paperclipContainerId()]),
    runDocker(['logs', '--since', since, await databaseContainerId()]),
  ]);
  return `${app.stdout}\n${app.stderr}\n${database.stdout}\n${database.stderr}`;
}
