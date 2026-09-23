import { describe, it, expect, vi, beforeEach } from 'vitest';

const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn() }));
vi.mock('../state/ddb.js', () => ({ ddb: () => ({ send: sendMock }) }));

import './dynamodb-tools.js'; // side-effect registration
import { tools } from './registry.js';

const ctx = { agentId: 'research', chatId: 'dashboard:1' };

beforeEach(() => {
  vi.clearAllMocks();
  sendMock.mockResolvedValue({ Items: [{ PK: 'x', SK: 'y', note: 'row' }] });
});

describe('dynamodb_query authorization', () => {
  it('lets an agent read its OWN partition on an agent-scoped table', async () => {
    const out = await tools.invoke(
      'dynamodb_query',
      { table: 'memories', pk: 'AGENT#research' },
      ctx,
    );
    expect(out.isError).toBeFalsy();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('allows composite own-partition keys (token_usage AGENT#<id>#DAY#...)', async () => {
    const out = await tools.invoke(
      'dynamodb_query',
      { table: 'token_usage', pk: 'AGENT#research#DAY#2026-07-03' },
      ctx,
    );
    expect(out.isError).toBeFalsy();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("blocks reading ANOTHER agent's partition, without touching DDB", async () => {
    const out = await tools.invoke(
      'dynamodb_query',
      { table: 'memories', pk: 'AGENT#main' },
      ctx,
    );
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/not authorized/i);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('rejects prefix-collision partitions (AGENT#researchEVIL)', async () => {
    const out = await tools.invoke(
      'dynamodb_query',
      { table: 'memories', pk: 'AGENT#researchEVIL' },
      ctx,
    );
    expect(out.isError).toBe(true);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('no longer exposes the deployment audit_log table', async () => {
    const out = await tools.invoke(
      'dynamodb_query',
      { table: 'audit_log', pk: 'DAY#2026-07-03' },
      ctx,
    );
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/unknown table/i);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('leaves the shared hive_mind table open (no agent-scope constraint)', async () => {
    const out = await tools.invoke(
      'dynamodb_query',
      { table: 'hive_mind', pk: 'DATE#20260703' },
      ctx,
    );
    expect(out.isError).toBeFalsy();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});

// These try to BREAK the pk binding rather than confirm the happy path. The
// prefix rule (AGENT#<id># is allowed so token_usage's composite key works) is
// only safe because agent ids cannot contain '#' — enforced by AGENT_ID_RE
// (/^[a-z][a-z0-9_-]{0,29}$/) in agent-manager.ts. If that ever loosens, the
// "another agent whose id starts with mine" cases below are the canary.
describe('dynamodb_query authorization — bypass attempts', () => {
  it('a sort-key prefix cannot smuggle a cross-agent partition read', async () => {
    const out = await tools.invoke(
      'dynamodb_query',
      { table: 'memories', pk: 'AGENT#main', sk_prefix: 'MEM#' },
      ctx,
    );
    expect(out.isError).toBe(true);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("blocks another agent's composite (token_usage) partition", async () => {
    const out = await tools.invoke(
      'dynamodb_query',
      { table: 'token_usage', pk: 'AGENT#main#DAY#2026-07-03' },
      ctx,
    );
    expect(out.isError).toBe(true);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('an agent cannot read a peer whose id is a superstring of its own', async () => {
    // caller 'research' must NOT reach 'research2' (no bare-prefix bypass).
    const out = await tools.invoke(
      'dynamodb_query',
      { table: 'memories', pk: 'AGENT#research2' },
      ctx,
    );
    expect(out.isError).toBe(true);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('an agent cannot read a peer whose id is a prefix of its own', async () => {
    // caller 'research2' must NOT reach 'research'.
    const out = await tools.invoke(
      'dynamodb_query',
      { table: 'memories', pk: 'AGENT#research' },
      { agentId: 'research2', chatId: 'c' },
    );
    expect(out.isError).toBe(true);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('still allows the caller OWN composite partition with a sort-key prefix', async () => {
    const out = await tools.invoke(
      'dynamodb_query',
      { table: 'token_usage', pk: 'AGENT#research#DAY#2026-07-03', sk_prefix: '2026-' },
      ctx,
    );
    expect(out.isError).toBeFalsy();
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});

describe('dynamodb_query — a conversation\'s messages stay out of the model\'s reach (decision 1)', () => {
  it('returns the sessions table\'s conversation rows, never the per-message records P1 stores beside them', async () => {
    // An agent's partition holds every person's conversations with it. Since P1
    // each message is also a row there, so this tool would have read other
    // people's transcripts to anyone chatting with the agent, one message at a
    // time (the first critic's A1). Conversation rows it returned before P1 are
    // unchanged.
    sendMock.mockResolvedValue({
      Items: [
        { PK: 'AGENT#research', SK: 'CHAT#dashboard:1', firstMessage: 'a conversation row' },
        { PK: 'AGENT#research', SK: 'CHAT#dashboard:1#MSG#0000000000', text: 'somebody else wrote this' },
        { PK: 'AGENT#research', SK: 'CHAT#dashboard:1#SRC', legacyOwner: 'dashboard:x' },
      ],
    });

    const out = await tools.invoke('dynamodb_query', { table: 'sessions', pk: 'AGENT#research' }, ctx);

    expect(out.isError).toBeFalsy();
    expect(out.text).toMatch(/^1 rows from sessions/);
    expect(out.text).toContain('a conversation row');
    expect(out.text).not.toContain('somebody else');
    expect(out.text).not.toContain('legacyOwner');
  });
});
