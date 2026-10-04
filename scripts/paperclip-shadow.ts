import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GetSecretValueCommand, PutSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { envFileNameFor, parseEnvFile, resolveEnvFlag } from './lib/env-file.js';
import { CookieJar, makeBoardRequest } from './lib/paperclip/bootstrap-core.js';
import { loadBootstrapSecretFields } from './lib/paperclip/bootstrap-secret.js';
import { createShadowCore } from './lib/paperclip/shadow-core.js';
import { dynamoShadowRows } from '../src/lib/paperclip/shadow-rows-dynamo.js';
import { getUser } from '../src/lib/state/users-repo.js';
import { writeAuditOrThrow } from '../src/lib/audit/audit-writer.js';

const usage = 'Usage: npm run paperclip:shadow -- [--env=<name>] pool [--size 1..99] | assign --user <id> --name <name> --classes <a,b> | rotate --user <id> | retire --user <id> | check | probe | list';
function options(argv: string[]): { command: string; user?: string; name?: string; classes?: string[]; size?: number } {
  const args = argv.filter((arg) => !arg.startsWith('--env='));
  const command = args.shift() ?? '';
  if (command === 'pool' && (args.length === 0 || args.length === 2 && args[0] === '--size' && /^(?:[1-9]|[1-9][0-9])$/.test(args[1] ?? ''))) return { command, size: args[1] ? Number(args[1]) : 25 };
  if (['check', 'probe', 'list'].includes(command) && !args.length) return { command };
  if (['rotate', 'retire'].includes(command) && args.length === 2 && args[0] === '--user' && args[1]) return { command, user: args[1] };
  if (command === 'assign' && args.length === 6 && args[0] === '--user' && args[1] && args[2] === '--name' && args[3] && args[4] === '--classes' && args[5]) return { command, user: args[1], name: args[3], classes: args[5].split(',') };
  throw new Error(usage);
}
function loadEnv(argv: string[]): Record<string, string> {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const file = join(root, envFileNameFor(resolveEnvFlag(argv)));
  return { ...(existsSync(file) ? parseEnvFile(readFileSync(file, 'utf8')) : {}), ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)) };
}
function required(env: Record<string, string>, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}
export async function runShadowCli(argv: string[], out: (line: string) => void): Promise<number> {
  let input: ReturnType<typeof options>;
  try { input = options(argv); } catch { out(usage); return 2; }
  try {
    const env = loadEnv(argv); const baseUrl = required(env, 'PAPERCLIP_BASE_URL').replace(/\/+$/, '');
    const suffix = env.CCE_NAME_SUFFIX?.trim(); const prefix = `/claudeclaw${suffix ? `-${suffix}` : ''}`;
    const secrets = new SecretsManagerClient({ region: env.AWS_REGION?.trim() || 'us-east-1' });
    const store = (id: string) => ({
      read: async () => {
        const value = await secrets.send(new GetSecretValueCommand({ SecretId: id }));
        if (!value.SecretString) throw new Error('Secret is empty');
        return value.SecretString;
      },
      write: async (value: string) => { await secrets.send(new PutSecretValueCommand({ SecretId: id, SecretString: value })); },
    });
    const paperclipSecret = store(`${prefix}/paperclip`);
    const fields = await loadBootstrapSecretFields({ secretId: `${prefix}/paperclip`, read: paperclipSecret.read });
    const companyId = fields.company_id;
    if (!companyId) throw new Error('Paperclip company id is missing');
    const admin = makeBoardRequest(baseUrl, new CookieJar());
    const signin = await admin('/api/auth/sign-in/email', { method: 'POST', body: JSON.stringify({ email: required(env, 'CCE_PAPERCLIP_ADMIN_EMAIL'), password: required(env, 'PAPERCLIP_ADMIN_PASSWORD') }) });
    if (!signin.ok) throw new Error(`Admin sign-in returned HTTP ${signin.status}`);
    const core = createShadowCore({ fetchFn: fetch, baseUrl, companyId, admin, secret: store(`${prefix}/shadow-approvers`), paperclipSecret,
      rows: dynamoShadowRows(), users: { get: getUser }, audit: writeAuditOrThrow, now: Date.now,
      randomHex: (bytes) => randomBytes(bytes).toString('hex'), out });
    switch (input.command) {
      case 'pool': await core.pool(input.size); return 0;
      case 'assign': await core.assign(input.user!, input.name!, input.classes!); return 0;
      case 'rotate': await core.rotate(input.user!); return 0;
      case 'retire': await core.retire(input.user!); return 0;
      case 'check': return await core.check() ? 0 : 1;
      case 'probe': return await core.probe() ? 0 : 1;
      case 'list': await core.list(); return 0;
      default: return 2;
    }
  } catch (error) {
    out(error instanceof Error && /^(Slot \d\d:|Pool can|No free|Netzer user|Active shadow|assign requires|Shadow approver secret|Paperclip company|Admin sign-in|[A-Z_]+ is required)/.test(error.message) ? error.message : 'Shadow command failed');
    return 1;
  }
}

void runShadowCli(process.argv.slice(2), console.log).then((code) => { process.exitCode = code; });
