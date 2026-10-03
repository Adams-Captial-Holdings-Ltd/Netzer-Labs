import { logger } from '../../observability/logger.js';

const TASK_PROTECTION_TIMEOUT_MS = 2_000;
const TASK_PROTECTION_EXPIRY_MINUTES = 10;

/** Keep ECS from scaling in a task that owns a live dispatch attempt. */
export function createTaskProtection(deps: { agentUri?: string; fetchFn?: typeof fetch } = {}) {
  const agentUri = deps.agentUri ?? process.env.ECS_AGENT_URI;
  const fetchFn = deps.fetchFn ?? fetch;
  let held = 0;

  function send(enabled: boolean): void {
    if (!agentUri) return;
    const controller = new AbortController();
    let timedOut!: () => void;
    const deadline = new Promise<never>((_resolve, reject) => { timedOut = () => reject(new Error('task protection timeout')); });
    const timeout = setTimeout(() => { controller.abort(); timedOut(); }, TASK_PROTECTION_TIMEOUT_MS);
    timeout.unref();
    void Promise.race([deadline, Promise.resolve().then(() => fetchFn(`${agentUri}/task-protection/v1/state`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(enabled ? { ProtectionEnabled: true, ExpiresInMinutes: TASK_PROTECTION_EXPIRY_MINUTES } : { ProtectionEnabled: false }),
      signal: controller.signal,
    }))]).then((response) => {
      if (!response.ok) logger.warn({ reason: 'task_protection_http', status: response.status }, 'ECS task protection update failed');
    }).catch(() => {
      logger.warn({ reason: 'task_protection_request' }, 'ECS task protection update failed');
    }).finally(() => clearTimeout(timeout));
  }

  return {
    hold(): void { if (++held === 1) send(true); },
    release(): void { if (held > 0 && --held === 0) send(false); },
    refresh(): void { if (held > 0) send(true); },
  };
}

export const taskProtection = createTaskProtection();
