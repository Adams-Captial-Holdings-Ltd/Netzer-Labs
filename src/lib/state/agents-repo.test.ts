import { describe, it, expect, vi, beforeEach } from 'vitest';

const send = vi.fn();
vi.mock('./ddb.js', () => ({ ddb: () => ({ send }) }));
vi.mock('../../observability/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { updateAgent, listAgents } from './agents-repo.js';

beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue({});
});

describe('agents-repo listAgents', () => {
  it('pages through ALL Scan pages (does not stop at the first LastEvaluatedKey)', async () => {
    // First Scan page returns one agent plus a LastEvaluatedKey; the second page
    // returns another agent and no cursor. Both must come back, and the second
    // Scan must carry the first page's ExclusiveStartKey.
    send
      .mockResolvedValueOnce({
        Items: [{ PK: 'AGENT#main', SK: 'META', agentId: 'main' }],
        LastEvaluatedKey: { PK: 'AGENT#main', SK: 'META' },
      })
      .mockResolvedValueOnce({
        Items: [{ PK: 'AGENT#late', SK: 'META', agentId: 'late' }],
      });

    const agents = await listAgents();

    expect(agents.map((a) => a.agentId)).toEqual(['main', 'late']);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].input.ExclusiveStartKey).toEqual({ PK: 'AGENT#main', SK: 'META' });
  });
});

describe('agents-repo updateAgent', () => {
  it('SETs defined fields and always bumps updatedAt', async () => {
    await updateAgent('main', { telegramBotToken: 'abc', telegramBotId: 42 });
    const input = send.mock.calls[0][0].input;
    expect(input.UpdateExpression).toMatch(/^SET /);
    // every defined field plus updatedAt is present as a value
    const valueKeys = Object.keys(input.ExpressionAttributeValues);
    expect(valueKeys.length).toBe(3); // telegramBotToken, telegramBotId, updatedAt
    expect(input.UpdateExpression).not.toContain('REMOVE');
  });

  it('REMOVEs fields cleared with undefined instead of leaving a dangling SET alias (Disconnect fix)', async () => {
    await updateAgent('main', {
      telegramBotToken: undefined,
      telegramBotUsername: undefined,
      telegramBotId: undefined,
    });
    const input = send.mock.calls[0][0].input;
    // updatedAt is still SET; the three cleared fields are REMOVEd.
    expect(input.UpdateExpression).toMatch(/^SET /);
    expect(input.UpdateExpression).toContain('REMOVE');
    // updatedAt is always written (as a SET value).
    expect(Object.values(input.ExpressionAttributeNames as Record<string, string>)).toContain('updatedAt');
    // Critical regression guard: no ExpressionAttributeValues alias may be
    // undefined (that is what triggered the DynamoDB ValidationException because
    // the doc client strips undefined values, leaving a dangling :v alias).
    for (const v of Object.values(input.ExpressionAttributeValues ?? {})) {
      expect(v).not.toBeUndefined();
    }
    // The three cleared fields must NOT appear as SET values.
    const setClause = input.UpdateExpression.split('REMOVE')[0];
    expect(setClause).not.toMatch(/telegramBotToken|telegramBotUsername|telegramBotId/);
  });

  it('mixes SET (defined) and REMOVE (undefined) in one update', async () => {
    await updateAgent('main', { status: 'active', slackBotToken: undefined });
    const input = send.mock.calls[0][0].input;
    expect(input.UpdateExpression).toMatch(/SET /);
    expect(input.UpdateExpression).toMatch(/REMOVE /);
    // The undefined field never becomes a value.
    const names = input.ExpressionAttributeNames as Record<string, string>;
    const removedAlias = Object.entries(names).find(([, n]) => n === 'slackBotToken')?.[0];
    expect(removedAlias).toBeTruthy();
    expect(input.UpdateExpression).toContain(`REMOVE`);
  });
});
