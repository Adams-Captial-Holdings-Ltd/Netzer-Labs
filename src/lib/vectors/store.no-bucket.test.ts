import { describe, it, expect, vi } from 'vitest';

// NZR-6: with VECTORS_BUCKET unset, the quarantine script's --apply/--verify
// must fail loudly, not report "0 left" over a bucket it never read.
vi.hoisted(() => {
  delete process.env.VECTORS_BUCKET;
});
import { listScopePrefixes } from './store.js';

describe('listScopePrefixes without a bucket', () => {
  it('throws instead of returning an empty list', async () => {
    await expect(listScopePrefixes()).rejects.toThrow('VECTORS_BUCKET env var not set');
  });
});
