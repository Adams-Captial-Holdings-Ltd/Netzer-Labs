// NZR-3: runs each case of the bash suite so vitest (and the G2 gate) sees them.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SUITE = join(__dirname, 'test-netzar-clone.sh');

const CASES: Record<string, string> = {
  t_check_clean: 'check passes on a fresh clone and ignores tracked env templates',
  t_check_dirty: 'check fails on an untracked .env, key file or nvapi- string without echoing the value',
  t_check_scanner: 'check fails closed when the repo scanner is missing, crashes, or hits a path with spaces',
  t_hook_stable: 'pre-push hook is installed outside the repo tree and check fails when it is missing',
  t_fetch:'fetch reports the new origin sha and refuses a dirty tree',
  t_install_serial: 'install runs the three commands serially and in order',
  t_install_drift: 'install fails on lockfile drift',
  t_install_lowmem: 'install aborts below 250 MB available',
  t_push_refused: 'push is refused without an approval record and logged',
  t_push_approved: 'approved push is allowed once, only for its sha and ref',
  t_hook_single_use: 'the hook consumes an approval atomically, so a direct-URL push cannot reuse it',
  t_push_no_creds: 'the clone holds no push credentials and check fails if that block is missing',
  t_install_lock: 'a second install is refused while one runs, including the playwright step',
};

describe('netzar-clone.sh', () => {
  for (const [fn, title] of Object.entries(CASES)) {
    it(title, () => {
      const r = spawnSync('bash', [SUITE, fn], { encoding: 'utf8' });
      expect(r.stderr + r.stdout).toBe('');
      expect(r.status).toBe(0);
    }, 30_000);
  }
});
