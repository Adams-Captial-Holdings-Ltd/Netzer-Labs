/**
 * The two Paperclip-native agent verbs and the properties that make them safe.
 *
 * The flag is a MOCK SEAM (`loadEnv`), the same seam `mission-tools.authz.test.ts`
 * and `mission-acl.test.ts` use, so every case below asserts the same thing in
 * BOTH configurations: `npx vitest run src/` and
 * `CCE_PAPERCLIP_ENABLED=1 npx vitest run src/`. A test that read the ambient
 * env would pass in one lane and silently skip its point in the other.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { flag, writeAudit } = vi.hoisted(() => ({
  flag: { value: undefined as string | undefined },
  writeAudit: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../config/env.js', () => ({
  loadEnv: () => ({ CCE_PAPERCLIP_ENABLED: flag.value }),
}));
vi.mock('../state/mission-provenance-repo.js', () => ({
  getMissionProvenance: vi.fn(() => Promise.resolve(new Map())),
  putMissionProvenance: vi.fn(() => Promise.resolve()),
  listProvenanceForChat: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../audit/audit-writer.js', () => ({ writeAudit }));

import type { MissionEngine } from '../paperclip/mission-engine.js';
import type { ProjectedMission } from '../paperclip/mission-projection.js';
import { __setMissionEngineForTest } from '../missions/mission-acl.js';
import { PaperclipDisabledError } from '../paperclip/error.js';
import { listAddons } from '../addons/registry.js';
import './paperclip-tools.js'; // side-effect registration, exactly as server.ts does it
import { tools } from './registry.js';

const MISSION_ID = 'abc12345-1111-4111-8111-111111111111';
const SIBLING_ID = 'abc12345-2222-4222-8222-222222222222';
const RUN_ID = 'paperclip-minted-run-id';
const ctx = { agentId: 'research', chatId: 'owner:emmanuel' };

function projected(id: string): ProjectedMission {
  return {
    id,
    ownerAgent: 'research',
    createdByAgent: 'paperclip',
    createdByChat: 'paperclip',
    title: 'Ship the reconciler',
    body: 'With a watermark overlap.',
    priority: 'high',
    status: 'open',
    createdAt: '2026-08-20T10:00:00.000Z',
    updatedAt: '2026-08-20T10:00:00.000Z',
    identifier: 'NZR-42',
    bodyTruncated: false,
  } as ProjectedMission;
}

/** Injects an engine and hands back the `comment` spy. */
type CommentSpy = (id: string, body: string, opts?: Record<string, unknown>) => Promise<void>;
type CreateSubtaskSpy = (
  parentId: string,
  mission: Record<string, unknown>,
  opts?: Record<string, unknown>,
) => Promise<ProjectedMission>;
const createSubtask = vi.fn<CreateSubtaskSpy>(() => Promise.resolve(projected(SIBLING_ID)));
function injectEngine(
  rows: ProjectedMission[],
  comment = vi.fn<CommentSpy>(() => Promise.resolve()),
) {
  __setMissionEngineForTest({
    listMissions: vi.fn(() => Promise.resolve(rows)),
    getMission: vi.fn(),
    createMission: vi.fn(),
    createSubtask,
    setStatus: vi.fn(),
    reassign: vi.fn(),
    comment,
  } as unknown as MissionEngine);
  return comment;
}

beforeEach(() => {
  vi.clearAllMocks();
  flag.value = '1';
  createSubtask.mockResolvedValue(projected(SIBLING_ID));
  __setMissionEngineForTest(undefined);
});

describe('the addon is inventory, and the tool is registered unconditionally', () => {
  it('surfaces on GET /api/addons with the kill switch the route projects', () => {
    // The route projects id/title/category/description/required/killSwitch and
    // computes killSwitchActive + active. If the record is missing, /api/addons
    // simply never mentions Paperclip and nothing errors.
    const addon = listAddons().find((a) => a.id === 'paperclip');
    expect(addon).toBeDefined();
    expect(addon?.killSwitch).toBe('paperclip_disabled');
    expect(addon?.defaultOn).toBe(true);
    expect(addon?.category).toBe('integration');
  });

  it('advertises the verb even with the integration switched OFF (gate is at invoke)', () => {
    // THE REGRESSION THIS GUARDS: gating at registration. `paperclip_disabled`
    // is a DynamoDB flag with a 30-second cache that an operator flips live,
    // and registration happens once at process start — a registration-time gate
    // would need a redeploy to undo and would be wrong in both directions.
    flag.value = undefined;
    const names = tools.listFor('research').map((t) => t.toolSpec?.name);
    expect(names.filter((name) => name?.startsWith('paperclip_')).sort()).toEqual([
      'paperclip_add_comment',
      'paperclip_create_subtask',
    ]);
  });
});

describe('paperclip_add_comment refuses at invoke', () => {
  it('refuses when the legacy DynamoDB board is the active substrate', async () => {
    flag.value = undefined;
    const comment = injectEngine([projected(MISSION_ID)]);
    const out = await tools.invoke(
      'paperclip_add_comment',
      { mission_id: 'abc12345', body: 'progress' },
      ctx,
    );
    expect(out.isError).toBe(true);
    expect(out.text).toContain('not the active mission substrate');
    expect(comment).not.toHaveBeenCalled();
  });

  it('rewrites PaperclipDisabledError instead of leaking the operator remediation', async () => {
    // The registry's generic catch would splice the raw message into
    // model-visible text as "Tool 'x' failed: <message>", carrying an
    // operator-authored remediation string into the model's context. The 503
    // body in dashboard/missions.ts spreads `reason` conditionally for the same
    // reason; a tool has no capability ladder, so it rewrites instead.
    const comment = vi.fn(() => {
      throw new PaperclipDisabledError({
        message: 'disabled',
        remediation: 'clear paperclip_disabled from the dashboard Kill switches tab',
      } as never);
    });
    injectEngine([projected(MISSION_ID)], comment);
    const out = await tools.invoke(
      'paperclip_add_comment',
      { mission_id: MISSION_ID, body: 'progress' },
      ctx,
    );
    expect(out.isError).toBe(true);
    expect(out.text).toContain('paperclip_disabled');
    expect(out.text).not.toContain('dashboard Kill switches tab');
  });

  it('refuses an ambiguous 8-char prefix rather than commenting on the wrong mission', async () => {
    const comment = injectEngine([projected(MISSION_ID), projected(SIBLING_ID)]);
    const out = await tools.invoke(
      'paperclip_add_comment',
      { mission_id: 'abc12345', body: 'progress' },
      ctx,
    );
    expect(out.isError).toBe(true);
    expect(out.text).toContain('pass one of these full ids');
    expect(comment).not.toHaveBeenCalled();
  });

  it('refuses a mission that is not on THIS agent\'s board', async () => {
    // Chat surfaces have no capability model, so authorization stays at the
    // tool — the same pull-based owner scoping list_missions and update_mission
    // apply. The board read is already owner-scoped, so an id an agent
    // overheard simply is not in `rows`.
    const comment = injectEngine([projected(MISSION_ID)]);
    const out = await tools.invoke(
      'paperclip_add_comment',
      { mission_id: 'deadbeef', body: 'progress' },
      ctx,
    );
    expect(out.isError).toBe(true);
    expect(out.text).toContain('No mission matches');
    expect(comment).not.toHaveBeenCalled();
  });
});

describe('run provenance', () => {
  it('never sends a runId — a chat turn holds none and one is never synthesized', async () => {
    // acquireRunId's contract: the only legitimate source of a run id is
    // inbound dispatch. This ordinary chat context carries no run id, so an
    // `opts` that grew one here would be a synthesized run id on the wire.
    const comment = injectEngine([projected(MISSION_ID)]);
    const out = await tools.invoke(
      'paperclip_add_comment',
      { mission_id: 'abc12345', body: 'watermark overlap landed' },
      ctx,
    );
    expect(out.isError).toBeUndefined();
    expect(comment).toHaveBeenCalledWith(MISSION_ID, 'watermark overlap landed', {
      actor: 'research',
    });
    const opts = comment.mock.calls[0]?.[2] as Record<string, unknown>;
    expect(Object.keys(opts)).toEqual(['actor']);
    expect(opts).not.toHaveProperty('runId');
  });

  it('ships no verb that would 401 without a run id', async () => {
    // checkout and release answer 401 'Agent run id required' without one
    // (C-3), and work-products does too while the issue has a live execution
    // run. A verb that burns one of the 8 tool rounds to earn a guaranteed 401
    // is worse than an absent verb, so no checkout is even attempted.
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('src/lib/tools/paperclip-tools.ts', 'utf8');
    const registered = src.match(/tools\.register\('([^']+)'/g) ?? [];
    expect(registered.sort()).toEqual([
      "tools.register('paperclip_add_comment'",
      "tools.register('paperclip_create_subtask'",
    ]);
    expect(src).not.toMatch(/\bcheckout\(|\brelease\(|addWorkProduct\(/);
  });
});

describe('paperclip_create_subtask', () => {
  it('creates one assigned child through the engine and forwards a genuine dispatch run id', async () => {
    injectEngine([projected(MISSION_ID)]);
    const out = await tools.invoke(
      'paperclip_create_subtask',
      {
        mission_id: 'abc12345',
        title: 'Verify the rollout',
        body: 'Run the staged smoke checks.',
        owner: 'analyst',
        priority: 'high',
      },
      { ...ctx, surface: 'system', runId: RUN_ID },
    );

    expect(out.isError).toBeUndefined();
    expect(createSubtask).toHaveBeenCalledWith(
      MISSION_ID,
      expect.objectContaining({
        id: expect.any(String),
        ownerAgent: 'analyst',
        createdByAgent: 'research',
        createdByChat: 'owner:emmanuel',
        title: 'Verify the rollout',
        body: 'Run the staged smoke checks.',
        priority: 'high',
        status: 'open',
      }),
      { actor: 'research', runId: RUN_ID },
    );
    expect(out.text).toContain(SIBLING_ID.slice(0, 8));
  });

  it('refuses a nested delegation before any mutation', async () => {
    injectEngine([projected(MISSION_ID)]);
    const out = await tools.invoke(
      'paperclip_create_subtask',
      { mission_id: MISSION_ID, title: 'Loop', body: 'Do not recurse.', owner: 'analyst' },
      { ...ctx, delegationDepth: 1 },
    );
    expect(out.isError).toBe(true);
    expect(out.text).toContain('Delegation depth limit reached');
    expect(createSubtask).not.toHaveBeenCalled();
    expect(writeAudit).not.toHaveBeenCalled();
  });
});

describe('successful Paperclip mutations are audited exactly once', () => {
  it('records comment actor, action, issue, chat, and run-less provenance', async () => {
    injectEngine([projected(MISSION_ID)]);
    await tools.invoke(
      'paperclip_add_comment',
      { mission_id: MISSION_ID, body: 'progress' },
      { ...ctx, surface: 'slack' },
    );
    expect(writeAudit).toHaveBeenCalledTimes(1);
    expect(writeAudit).toHaveBeenCalledWith({
      action: 'tool_invoke',
      agentId: 'research',
      chatId: 'owner:emmanuel',
      surface: 'slack',
      toolName: 'paperclip_add_comment',
      detail: { action: 'add_comment', issueId: MISSION_ID, runId: null },
      result: 'ok',
    });
  });

  it('records child and parent issue ids with dispatched run provenance', async () => {
    injectEngine([projected(MISSION_ID)]);
    await tools.invoke(
      'paperclip_create_subtask',
      { mission_id: MISSION_ID, title: 'Child', body: 'Do it.', owner: 'analyst' },
      { ...ctx, surface: 'system', runId: RUN_ID },
    );
    expect(writeAudit).toHaveBeenCalledTimes(1);
    expect(writeAudit).toHaveBeenCalledWith({
      action: 'tool_invoke',
      agentId: 'research',
      chatId: 'owner:emmanuel',
      surface: 'system',
      toolName: 'paperclip_create_subtask',
      detail: {
        action: 'create_subtask',
        issueId: SIBLING_ID,
        parentIssueId: MISSION_ID,
        runId: RUN_ID,
      },
      result: 'ok',
    });
  });
});

describe('ToolResult.text', () => {
  it('carries no URL on the success path — a signed one dies on the model round trip', async () => {
    // registry.ts's ToolMedia comment records the observed production failure:
    // a presigned S3 URL reproduced by the model lost its X-Amz-* query string
    // and returned AccessDenied. This verb produces no artifact, so it produces
    // no URL.
    injectEngine([projected(MISSION_ID)]);
    const out = await tools.invoke(
      'paperclip_add_comment',
      { mission_id: 'abc12345', body: 'progress' },
      ctx,
    );
    expect(out.text).toBe('Comment posted on mission abc12345.');
    expect(out.text).not.toMatch(/https?:\/\//);
    expect(out.text).not.toContain('X-Amz-');
  });
});

/**
 * The side-effect import is the whole registration. A tools module absent from
 * `src/server.ts`'s block registers nothing, throws nothing and logs nothing.
 */
describe('server.ts imports this module for its side effects', () => {
  it('lists it in the side-effect block with a bare .js specifier', async () => {
    const { readFile } = await import('node:fs/promises');
    const src = await readFile('src/server.ts', 'utf8');
    expect(src).toContain("import './lib/tools/paperclip-tools.js';");
  });
});
