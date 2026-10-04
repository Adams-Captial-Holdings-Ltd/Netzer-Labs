import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { buildResourceNames } from '../infra/lib/constants.js';
import { envFileNameFor, parseEnvFile, resolveEnvFlag } from './lib/env-file.js';
import { CookieJar, makeBoardRequest } from './lib/paperclip/bootstrap-core.js';
import { loadBootstrapSecretFields } from './lib/paperclip/bootstrap-secret.js';
import { createShadowCore, ShadowAuditError, ShadowCommandError } from './lib/paperclip/shadow-core.js';

const usage = 'Usage: npm run paperclip:shadow -- [--env=<name>] pool [--size 1..99] | ' +
  'assign --user <id> --name <name> --classes <a,b> | rotate --user <id> | retire --user <id> | check | probe | list';
type Input =
  | { command: 'pool'; size: number }
  | { command: 'assign'; user: string; name: string; classes: string[] }
  | { command: 'rotate' | 'retire'; user: string }
  | { command: 'check' | 'probe' | 'list' };
export function options(argv: string[]): Input {
  const args = argv.filter((arg) => !arg.startsWith('--env='));
  const command = args.shift();
  if (command === 'pool') {
    if (args.length === 0) return { command, size: 25 };
    if (args.length === 2 && args[0] === '--size' && /^(?:[1-9]|[1-9][0-9])$/.test(args[1] ?? '')) {
      return { command, size: Number(args[1]) };
    }
  }
  if ((command === 'check' || command === 'probe' || command === 'list') && args.length === 0) return { command };
  if ((command === 'rotate' || command === 'retire') && args.length === 2 && args[0] === '--user' && args[1]) {
    return { command, user: args[1] };
  }
  if (command === 'assign' && args.length === 6 && args[0] === '--user' && args[1] && args[2] === '--name' &&
    args[3] && args[4] === '--classes' && args[5] && args[5].split(',').every((part) => part.trim())) {
    return { command, user: args[1], name: args[3], classes: args[5].split(',') };
  }
  throw new Error(usage);
}
function loadEnv(argv: string[]): Record<string, string> {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const file = join(root, envFileNameFor(resolveEnvFlag(argv)));
  return { ...(existsSync(file) ? parseEnvFile(readFileSync(file, 'utf8')) : {}),
    ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)) };
}
function required(env: Record<string, string>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new ShadowCommandError(`${key} is required`);
  return value;
}
export function resolveShadowResources(suffix = '') {
  const names = buildResourceNames(suffix);
  return { users: names.ddb.users, audit: names.ddb.auditLog,
    keys: `${names.secrets.shadowApprovers}`, setup: `${names.secrets.shadowApproversSetup}`,
    paperclip: names.secrets.paperclip };
}
type Core = ReturnType<typeof createShadowCore>;
type CliDeps = { env?: Record<string, string>; core?: Core };
async function liveCore(env: Record<string, string>, names: ReturnType<typeof resolveShadowResources>,
  out: (line: string) => void): Promise<Core> {
  const baseUrl = required(env, 'PAPERCLIP_BASE_URL').replace(/\/+$/, '');
  process.env.TABLE_USERS = names.users;
  process.env.TABLE_AUDIT_LOG = names.audit;
  if (!process.env.AWS_REGION && env.AWS_REGION?.trim()) process.env.AWS_REGION = env.AWS_REGION.trim();
  const [{ dynamoShadowRows }, { getUser }, { writeAuditOrThrow }] = await Promise.all([
    import('../src/lib/paperclip/shadow-rows-dynamo.js'), import('../src/lib/state/users-repo.js'),
    import('../src/lib/audit/audit-writer.js'),
  ]);
  const secrets = new SecretsManagerClient({ region: env.AWS_REGION?.trim() || 'us-east-1' });
  const store = (id: string) => ({
    read: async () => {
      const value = await secrets.send(new GetSecretValueCommand({ SecretId: id }));
      if (!value.SecretString) throw new ShadowCommandError('Secret is empty');
      return value.SecretString;
    },
    write: async (value: string) => { await secrets.send(new PutSecretValueCommand({ SecretId: id, SecretString: value })); },
  });
  const paperclipSecret = store(names.paperclip);
  const fields = await loadBootstrapSecretFields({ secretId: names.paperclip, read: paperclipSecret.read });
  const companyId = fields.company_id;
  if (!companyId) throw new ShadowCommandError('Paperclip company id is missing');
  const admin = makeBoardRequest(baseUrl, new CookieJar(),
    (input, init) => fetch(input, { ...init, signal: AbortSignal.timeout(20_000) }));
  const signin = await admin('/api/auth/sign-in/email', { method: 'POST', body: JSON.stringify({
    email: required(env, 'CCE_PAPERCLIP_ADMIN_EMAIL'), password: required(env, 'PAPERCLIP_ADMIN_PASSWORD'),
  }) });
  if (!signin.ok) throw new ShadowCommandError(`Admin sign-in returned HTTP ${signin.status}`);
  return createShadowCore({ fetchFn: fetch, baseUrl, companyId, admin, keys: store(names.keys), setup: store(names.setup),
    paperclipSecret, rows: dynamoShadowRows(names.users), users: { get: getUser }, audit: writeAuditOrThrow,
    now: Date.now, randomHex: (bytes) => randomBytes(bytes).toString('hex'), out, tableName: names.users });
}
function errorLine(command: string, error: unknown): string {
  if (error instanceof ShadowAuditError) return error.message;
  const name = error instanceof Error ? error.name : 'UnknownError';
  if (error instanceof ShadowCommandError) return `${command} ${name}: ${error.message}`;
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : undefined;
  const metadata = record?.$metadata;
  const status = record?.statusCode ?? (metadata && typeof metadata === 'object' &&
    'httpStatusCode' in metadata ? metadata.httpStatusCode : undefined);
  return `${command} ${name}${typeof status === 'number' ? ` HTTP ${status}` : ''}`;
}
export async function runShadowCli(argv: string[], out: (line: string) => void, deps: CliDeps = {}): Promise<number> {
  let input: Input;
  try { input = options(argv); }
  catch {
    out(usage);
    return 2;
  }
  try {
    const env = deps.env ?? loadEnv(argv);
    const names = resolveShadowResources(env.CCE_NAME_SUFFIX?.trim());
    out(`users table ${names.users}; audit table ${names.audit}; secrets ${names.keys}, ${names.setup}, ${names.paperclip}`);
    const core = deps.core ?? await liveCore(env, names, out);
    switch (input.command) {
      case 'pool':
        await core.pool(input.size);
        return 0;
      case 'assign':
        await core.assign(input.user, input.name, input.classes);
        return 0;
      case 'rotate':
        await core.rotate(input.user);
        return 0;
      case 'retire':
        await core.retire(input.user);
        return 0;
      case 'check': return await core.check() ? 0 : 1;
      case 'probe': return await core.probe() ? 0 : 1;
      case 'list':
        await core.list();
        return 0;
    }
  } catch (error) {
    out(errorLine(input.command, error));
    return 1;
  }
}
const entry = process.argv[1] && resolve(process.argv[1]);
const invoked = entry && (existsSync(entry) ? realpathSync(entry)
  : existsSync(`${entry}.ts`) ? realpathSync(`${entry}.ts`) : undefined);
if (invoked && invoked === realpathSync(fileURLToPath(import.meta.url))) {
  void runShadowCli(process.argv.slice(2), console.log).then((code) => { process.exitCode = code; });
}
