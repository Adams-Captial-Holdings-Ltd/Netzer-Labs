/**
 * Tests for the Bedrock hard-stop guard, in two parts:
 *   1. Behaviour — the guard throws/short-circuits when bedrock_global is active.
 *   2. Enforcement — NO source file may construct a Bedrock Runtime command
 *      without a guard call within reach. This is the invariant that makes the
 *      pause feature trustworthy: scaling tasks to 0 is not enough on its own, so
 *      every paid model entrypoint must honour the global kill switch.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockIsKill } = vi.hoisted(() => ({ mockIsKill: vi.fn() }));
vi.mock('../state/kill-switches-repo.js', async (importActual) => {
  const actual = await importActual<typeof import('../state/kill-switches-repo.js')>();
  return { ...actual, isKillSwitchActive: mockIsKill };
});

import { assertBedrockAllowed, guardedBedrockSend } from './guard.js';
import { KillSwitchActiveError } from '../state/kill-switches-repo.js';

describe('bedrock guard — behaviour', () => {
  beforeEach(() => mockIsKill.mockReset());

  it('assertBedrockAllowed throws KillSwitchActiveError when bedrock_global is active', async () => {
    mockIsKill.mockResolvedValue({ active: true, reason: 'demo pause' });
    await expect(assertBedrockAllowed()).rejects.toBeInstanceOf(KillSwitchActiveError);
    expect(mockIsKill).toHaveBeenCalledWith('bedrock_global');
  });

  it('assertBedrockAllowed resolves when the switch is inactive', async () => {
    mockIsKill.mockResolvedValue({ active: false });
    await expect(assertBedrockAllowed()).resolves.toBeUndefined();
  });

  it('guardedBedrockSend does NOT call the send when the switch is active', async () => {
    mockIsKill.mockResolvedValue({ active: true, reason: 'paused' });
    const send = vi.fn().mockResolvedValue('result');
    await expect(guardedBedrockSend(send)).rejects.toBeInstanceOf(KillSwitchActiveError);
    expect(send).not.toHaveBeenCalled();
  });

  it('guardedBedrockSend runs the send and returns its value when inactive', async () => {
    mockIsKill.mockResolvedValue({ active: false });
    const send = vi.fn().mockResolvedValue('ok');
    await expect(guardedBedrockSend(send)).resolves.toBe('ok');
    expect(send).toHaveBeenCalledOnce();
  });

  it('fails open: a switch-store read that reports inactive lets the call through', async () => {
    // isKillSwitchActive already swallows store errors and returns {active:false};
    // the guard must not add its own throw on top of that.
    mockIsKill.mockResolvedValue({ active: false });
    await expect(assertBedrockAllowed()).resolves.toBeUndefined();
  });
});

describe('bedrock guard — enforcement (no unguarded paid Bedrock send)', () => {
  // Every construction of one of these commands is a paid Bedrock Runtime call.
  const COMMAND = /new\s+(ConverseCommand|ConverseStreamCommand|InvokeModelCommand|InvokeModelWithBidirectionalStreamCommand|InvokeModelWithResponseStreamCommand)\s*\(/;
  // A send is "guarded" if one of these sits within reach above it:
  //   - guardedBedrockSend(...) / assertBedrockAllowed()  — the shared guard, or
  //   - an inline bedrock_global kill-switch check, e.g. the Jarvis text turn's
  //     modelStop() (which reads isKillSwitchActive('bedrock_global') and breaks
  //     before the send). Jarvis owns a richer per-call gate (cap + audit), so it
  //     is not forced to also call the shared helper.
  const GUARD = /guardedBedrockSend|assertBedrockAllowed|modelStop\(|isKillSwitchActive\([^)]*bedrock_global/;
  const LOOKBACK = 45; // lines above the construction a guard call may live in

  const srcRoot = fileURLToPath(new URL('../../', import.meta.url));

  function tsFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...tsFiles(p));
      else if (
        entry.name.endsWith('.ts') &&
        !entry.name.endsWith('.test.ts') &&
        !entry.name.endsWith('.d.ts')
      ) {
        out.push(p);
      }
    }
    return out;
  }

  it('every Bedrock command construction has a guard call within reach', () => {
    const violations: string[] = [];
    for (const file of tsFiles(srcRoot)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!COMMAND.test(lines[i])) continue;
        const window = lines.slice(Math.max(0, i - LOOKBACK), i + 1).join('\n');
        if (!GUARD.test(window)) {
          violations.push(`${file.replace(srcRoot, 'src/')}:${i + 1}  ${lines[i].trim()}`);
        }
      }
    }
    expect(
      violations,
      `Unguarded paid Bedrock send(s) found. Wrap them in guardedBedrockSend(() => ...) ` +
        `or call assertBedrockAllowed() right before, so bedrock_global is a true hard stop:\n` +
        violations.join('\n'),
    ).toEqual([]);
  });

  it('the enforcement scan actually sees the known send sites (guards against a broken regex)', () => {
    let count = 0;
    for (const file of tsFiles(srcRoot)) {
      const lines = readFileSync(file, 'utf8');
      const matches = lines.match(new RegExp(COMMAND, 'g'));
      if (matches) count += matches.length;
    }
    // 10 known sites today (client x4, agent-loop x2, jarvis, embedder, nova-canvas,
    // nova-sonic). If this ever reads 0 the regex broke and the test above is moot.
    expect(count).toBeGreaterThanOrEqual(10);
  });
});
