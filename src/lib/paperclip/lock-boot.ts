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
      const configPromise = loadConfig();
      const configLoader = () => configPromise;
      const env = loadEnv();
      const runtimeVerdict = await readConfiguredLockVerdict({
        loadConfig: configLoader,
        fetchFn,
        auditorKey: env.PAPERCLIP_LOCK_AUDITOR_KEY,
      });
      let probeVerdict: LockVerdict = { verdict: 'unknown', reason: 'paperclip_config_unavailable' };
      try {
        const config = await configPromise;
        if (config.baseUrl) {
          probeVerdict = await readSignUpProbe({
            fetchFn,
            baseUrl: config.baseUrl,
            probeEmail: env.PAPERCLIP_SIGNUP_PROBE_EMAIL,
            windowOpen: env.PAPERCLIP_SIGNUP_WINDOW === 'open',
          });
        }
      } catch { /* an unavailable config cannot support the probe */ }
      return combineLockVerdicts(runtimeVerdict, probeVerdict);
    },
  });
}
