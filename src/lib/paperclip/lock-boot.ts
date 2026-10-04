import { loadEnv } from '../../config/env.js';
import { paperclipRoutingEnabled } from '../missions/mission-acl.js';
import { loadPaperclipConfig } from './config.js';
import { readConfiguredLockVerdict, startPaperclipLock } from './runtime-lock.js';
import type { LockVerdict } from './runtime-lock.js';
import { combineLockVerdicts, readSignUpProbe } from './sign-up-probe.js';

export async function bootPaperclipLock(deps: {
  loadConfig?: typeof loadPaperclipConfig;
  fetchFn?: typeof fetch;
} = {}): Promise<{ stop: () => void }> {
  const loadConfig = deps.loadConfig ?? loadPaperclipConfig;
  const fetchFn = deps.fetchFn ?? fetch;
  return startPaperclipLock({
    enabled: paperclipRoutingEnabled(),
    read: async () => {
      const env = loadEnv();
      let config: Awaited<ReturnType<typeof loadConfig>>;
      try { config = await loadConfig(); }
      catch { return { verdict: 'unknown', reason: 'paperclip_config_unavailable' }; }
      const runtimeVerdict = await readConfiguredLockVerdict({
        loadConfig: async () => config,
        fetchFn,
        auditorKey: env.PAPERCLIP_LOCK_AUDITOR_KEY,
      });
      const probeVerdict: LockVerdict = config.baseUrl
        ? await readSignUpProbe({ fetchFn, baseUrl: config.baseUrl, probeEmail: env.PAPERCLIP_SIGNUP_PROBE_EMAIL,
          windowOpen: env.PAPERCLIP_SIGNUP_WINDOW === 'open' })
        : { verdict: 'unknown', reason: 'paperclip_config_missing' };
      return combineLockVerdicts(runtimeVerdict, probeVerdict);
    },
  });
}
