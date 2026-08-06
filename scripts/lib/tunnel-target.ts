/**
 * Pure helpers for `npm run dashboard:tunnel` (scripts/dashboard-tunnel.ts).
 *
 * Split out so the target-string composition and ARN parsing are unit-
 * testable without any AWS calls (see tunnel-target.test.ts).
 */

/**
 * Extract the task ID from an ECS task ARN.
 *
 * Handles both ARN formats:
 *   - new:  arn:aws:ecs:us-east-1:111122223333:task/my-cluster/<taskId>
 *   - old:  arn:aws:ecs:us-east-1:111122223333:task/<taskId>
 *
 * A bare task ID passes through unchanged, so callers can be lenient about
 * what the AWS CLI handed them.
 */
export function taskIdFromArn(taskArnOrId: string): string {
  const trimmed = taskArnOrId.trim();
  if (!trimmed) {
    throw new Error('empty task ARN');
  }
  const slash = trimmed.lastIndexOf('/');
  const id = slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
  if (!id) {
    throw new Error(`could not parse a task id out of "${taskArnOrId}"`);
  }
  return id;
}

/**
 * Compose the SSM session target for an ECS Exec-managed container:
 * `ecs:<cluster>_<taskId>_<runtimeId>`. This is the `--target` that
 * `aws ssm start-session` accepts for Fargate port-forwarding.
 */
export function ecsExecTarget(cluster: string, taskId: string, runtimeId: string): string {
  for (const [name, value] of Object.entries({ cluster, taskId, runtimeId })) {
    if (!value || !value.trim()) {
      throw new Error(`ecsExecTarget: ${name} is empty`);
    }
  }
  return `ecs:${cluster}_${taskId}_${runtimeId}`;
}
