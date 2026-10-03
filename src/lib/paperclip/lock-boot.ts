import { loadEnv } from '../../config/env.js';
import { paperclipRoutingEnabled } from '../missions/mission-acl.js';
import { loadPaperclipConfig } from './config.js';
import { readConfiguredLockVerdict, startPaperclipLock } from './runtime-lock.js';

export async function bootPaperclipLock(deps: {
  loadConfig?: typeof loadPaperclipConfig;
  fetchFn?: typeof fetch;
} = {}): Promise<{ stop: () => void }> {
  const loadConfig = deps.loadConfig ?? loadPaperclipConfig;
  const fetchFn = deps.fetchFn ?? fetch;
  return startPaperclipLock({
    enabled: paperclipRoutingEnabled(),
    read: () => readConfiguredLockVerdict({
      loadConfig,
      fetchFn,
      auditorKey: loadEnv().PAPERCLIP_LOCK_AUDITOR_KEY,
    }),
  });
}
