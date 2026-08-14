/**
 * Drift watch — scheduled CloudFormation drift detection across the CCE-*
 * stacks, so out-of-band changes to deployed resources (console/CLI edits)
 * surface within a day instead of going unnoticed for months.
 *
 * This catches the "deployed resource != its CloudFormation template" failure
 * mode (manual changes). The complementary "main has undeployed changes" mode
 * is caught by the CI `cdk diff` gate, not here.
 *
 * Same safety shape as the cost-watch worker:
 *   - OFF by default (runtime-config drift/watch_enabled='true' to arm).
 *   - At most once per UTC day (drift/last_run guard) so the 3 tasks don't all
 *     run it.
 *   - Drift detection is async per stack: start all, then poll to completion
 *     with a bounded total timeout.
 *   - Fail-soft; never crashes the orchestrator. Alerts via the ops-alerts SNS
 *     topic (CCE_ALERT_TOPIC_ARN).
 */

import {
  CloudFormationClient,
  ListStacksCommand,
  DetectStackDriftCommand,
  DescribeStackDriftDetectionStatusCommand,
} from '@aws-sdk/client-cloudformation';
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';
import { getConfig, setConfig } from '../lib/state/runtime-config-repo.js';
import { logger } from '../observability/logger.js';

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const STACK_PREFIX = process.env.CDK_STACK_NAME ?? 'CCE';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // tick 6h; acts once/UTC-day
const BOOT_DELAY_MS = 90_000;
const DETECT_TIMEOUT_MS = 4 * 60 * 1000; // bound the whole detection pass
const POLL_INTERVAL_MS = 5_000;

let timer: ReturnType<typeof setInterval> | null = null;
let _cfn: CloudFormationClient | null = null;
let _sns: SNSClient | null = null;
function cfn(): CloudFormationClient {
  if (!_cfn) _cfn = new CloudFormationClient({ region: REGION });
  return _cfn;
}
function sns(): SNSClient {
  if (!_sns) _sns = new SNSClient({ region: REGION });
  return _sns;
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

async function publishAlert(message: string): Promise<void> {
  const arn = process.env.CCE_ALERT_TOPIC_ARN;
  if (!arn) {
    logger.warn({}, 'drift-watch: CCE_ALERT_TOPIC_ARN unset; alert not sent');
    return;
  }
  await sns().send(
    new PublishCommand({ TopicArn: arn, Subject: 'Netzar OS CDK drift', Message: message }),
  );
}

export interface DriftResult {
  ran: boolean;
  reason?: string;
  drifted: string[];
  checked: number;
}

/** List active CCE-* stacks (skip nested/child stacks). */
async function listStacks(): Promise<string[]> {
  const names: string[] = [];
  let token: string | undefined;
  do {
    const out = await cfn().send(
      new ListStacksCommand({
        NextToken: token,
        StackStatusFilter: ['CREATE_COMPLETE', 'UPDATE_COMPLETE', 'UPDATE_ROLLBACK_COMPLETE', 'IMPORT_COMPLETE'],
      }),
    );
    for (const s of out.StackSummaries ?? []) {
      if (s.StackName?.startsWith(`${STACK_PREFIX}-`) && !s.ParentId && !s.RootId) {
        names.push(s.StackName);
      }
    }
    token = out.NextToken;
  } while (token);
  return names;
}

export async function runDriftCheckOnce(opts: { force?: boolean } = {}): Promise<DriftResult> {
  if (!opts.force) {
    if ((await getConfig('drift', 'watch_enabled')) !== 'true') {
      return { ran: false, reason: 'disabled', drifted: [], checked: 0 };
    }
    const today = todayUtc();
    if ((await getConfig('drift', 'last_run')) === today) {
      return { ran: false, reason: 'already-ran-today', drifted: [], checked: 0 };
    }
    await setConfig('drift', 'last_run', today, { updatedBy: 'drift-watch' });
  }

  // The day was claimed above (cheap lock against the other tasks), but no
  // work has happened yet. If the stack listing fails, release the claim so
  // the next 6-hourly tick retries; otherwise one transient CloudFormation
  // error silently skipped drift detection for the rest of the UTC day.
  // (cost-watch shares this claim-then-work shape but its readers are
  // fail-soft, so only this worker needs the release.)
  let stacks: string[];
  try {
    stacks = await listStacks();
  } catch (err) {
    if (!opts.force) {
      await setConfig('drift', 'last_run', '', { updatedBy: 'drift-watch' }).catch(() => {});
    }
    throw err;
  }
  // Start detection on every stack (best-effort; a throttle/error skips one).
  const detections = new Map<string, string>();
  await Promise.all(
    stacks.map(async (name) => {
      try {
        const out = await cfn().send(new DetectStackDriftCommand({ StackName: name }));
        if (out.StackDriftDetectionId) detections.set(name, out.StackDriftDetectionId);
      } catch (err) {
        logger.warn(
          { stack: name, err: err instanceof Error ? err.message : String(err) },
          'drift-watch: detect start failed',
        );
      }
    }),
  );

  // Poll all detections to completion within the time budget.
  const drifted: string[] = [];
  const deadline = Date.now() + DETECT_TIMEOUT_MS;
  const pending = new Map(detections);
  while (pending.size > 0 && Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    for (const [name, id] of [...pending]) {
      try {
        const st = await cfn().send(
          new DescribeStackDriftDetectionStatusCommand({ StackDriftDetectionId: id }),
        );
        if (st.DetectionStatus === 'DETECTION_COMPLETE') {
          pending.delete(name);
          if (st.StackDriftStatus === 'DRIFTED') {
            drifted.push(`${name} (${st.DriftedStackResourceCount ?? '?'} resources)`);
          }
        } else if (st.DetectionStatus === 'DETECTION_FAILED') {
          pending.delete(name);
        }
      } catch (err) {
        logger.warn(
          { stack: name, err: err instanceof Error ? err.message : String(err) },
          'drift-watch: poll failed',
        );
      }
    }
  }

  if (drifted.length > 0) {
    const body = [
      'Netzar OS CDK drift detected — deployed resources differ from their CloudFormation templates.',
      '',
      ...drifted.map((d) => `• ${d}`),
      '',
      'Investigate with: cdk diff (and CloudFormation > Stacks > Drift). Reconcile by deploying or reverting the out-of-band change.',
    ].join('\n');
    await publishAlert(body);
  }
  logger.info({ checked: detections.size, drifted: drifted.length }, 'drift-watch: pass complete');
  return { ran: true, drifted, checked: detections.size };
}

export function startDriftWatch(): void {
  if (timer) return;
  const jitter = Math.floor(Math.random() * 90_000);
  const kick = (): void => {
    void runDriftCheckOnce().catch((err) =>
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'drift-watch tick failed',
      ),
    );
  };
  setTimeout(() => {
    kick();
    timer = setInterval(kick, CHECK_INTERVAL_MS);
  }, BOOT_DELAY_MS + jitter).unref();
  logger.info({}, 'drift-watch started (gated by runtime-config drift/watch_enabled)');
}

export function stopDriftWatch(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
