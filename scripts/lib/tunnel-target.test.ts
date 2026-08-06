import { describe, it, expect } from 'vitest';
import { ecsExecTarget, taskIdFromArn } from './tunnel-target.js';

describe('taskIdFromArn', () => {
  it('parses the new (cluster-scoped) task ARN format', () => {
    expect(
      taskIdFromArn(
        'arn:aws:ecs:us-east-1:111122223333:task/claudeclaw-cluster/0f9de4c2b53c4ad5a2f3b1c9d8e7f6a5',
      ),
    ).toBe('0f9de4c2b53c4ad5a2f3b1c9d8e7f6a5');
  });

  it('parses the old (un-scoped) task ARN format', () => {
    expect(
      taskIdFromArn('arn:aws:ecs:us-east-1:111122223333:task/0f9de4c2b53c4ad5a2f3b1c9d8e7f6a5'),
    ).toBe('0f9de4c2b53c4ad5a2f3b1c9d8e7f6a5');
  });

  it('passes a bare task id through unchanged', () => {
    expect(taskIdFromArn('0f9de4c2b53c4ad5a2f3b1c9d8e7f6a5')).toBe(
      '0f9de4c2b53c4ad5a2f3b1c9d8e7f6a5',
    );
  });

  it('rejects empty input and ARNs with a trailing slash', () => {
    expect(() => taskIdFromArn('')).toThrow(/empty/);
    expect(() => taskIdFromArn('   ')).toThrow(/empty/);
    expect(() => taskIdFromArn('arn:aws:ecs:us-east-1:111122223333:task/cluster/')).toThrow(
      /could not parse/,
    );
  });
});

describe('ecsExecTarget', () => {
  it('composes the ecs:<cluster>_<taskId>_<runtimeId> SSM target', () => {
    expect(
      ecsExecTarget(
        'claudeclaw-cluster',
        '0f9de4c2b53c4ad5a2f3b1c9d8e7f6a5',
        '0f9de4c2b53c4ad5a2f3b1c9d8e7f6a5-2531612879',
      ),
    ).toBe(
      'ecs:claudeclaw-cluster_0f9de4c2b53c4ad5a2f3b1c9d8e7f6a5_0f9de4c2b53c4ad5a2f3b1c9d8e7f6a5-2531612879',
    );
  });

  it('honors suffixed cluster names (CCE_NAME_SUFFIX)', () => {
    expect(ecsExecTarget('claudeclaw-staging-cluster', 'task1', 'rt1')).toBe(
      'ecs:claudeclaw-staging-cluster_task1_rt1',
    );
  });

  it('rejects any empty component', () => {
    expect(() => ecsExecTarget('', 't', 'r')).toThrow(/cluster is empty/);
    expect(() => ecsExecTarget('c', '', 'r')).toThrow(/taskId is empty/);
    expect(() => ecsExecTarget('c', 't', ' ')).toThrow(/runtimeId is empty/);
  });
});
