/**
 * Async cost-report jobs — the background path behind the Settings "async cost
 * report" toggle.
 *
 * The synchronous POST /api/cost/report must finish inside CloudFront's 60s
 * origin-read timeout, which forces a trimmed report. When the operator turns
 * async on, the dashboard instead "starts" a job (returns immediately) and polls
 * for the result, so the generation can take as long as it needs and produce the
 * full, untrimmed report.
 *
 * State lives in ONE overwritten DynamoDB row (PK=COSTREPORTJOB, SK=current) in
 * the runtime-config table — not per-job rows — so it never accumulates (the
 * table has no TTL) and any of the N Fargate tasks can read it (the poll may hit
 * a different task than the one generating). A jobId guards against a slow old
 * generation clobbering a newer one (compare-and-set on write), and a pending
 * job older than STALE_MS is treated as failed so a recycled task can't wedge it
 * "pending" forever.
 */

import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb } from '../state/ddb.js';
import { logger } from '../../observability/logger.js';
import { generateCostReport, type GenerateCostReportInput, type CostReport } from './cost-analyst.js';

const TABLE = process.env.TABLE_RUNTIME_CONFIG ?? 'claudeclaw-runtime-config';
const PK = 'COSTREPORTJOB';
const SK = 'current';
// A rich report runs ~75-120s; treat a pending job older than this as a dead
// worker (task recycled mid-generation) so the UI surfaces a retry instead of
// spinning forever.
const STALE_MS = 4 * 60 * 1000;

type JobStatus = 'pending' | 'done' | 'error';

interface JobRow {
  PK: string;
  SK: string;
  jobId: string;
  status: JobStatus;
  startedAt: number;
  report?: string; // JSON-encoded CostReport
  error?: string;
}

export interface ReportJobStart {
  jobId: string;
  status: 'pending';
}

export interface ReportJobResult {
  status: 'idle' | 'pending' | 'done' | 'error';
  report?: CostReport;
  error?: string;
}

async function readRow(): Promise<JobRow | null> {
  const out = await ddb().send(new GetCommand({ TableName: TABLE, Key: { PK, SK } }));
  return (out.Item as JobRow | undefined) ?? null;
}

async function writeRow(row: JobRow): Promise<void> {
  await ddb().send(new PutCommand({ TableName: TABLE, Item: row }));
}

/**
 * Write a terminal result only if `jobId` is still the active job — so a slow
 * generation that was superseded by a newer "start" does not overwrite the newer
 * job's state.
 */
async function finishIfCurrent(jobId: string, patch: Partial<JobRow>): Promise<void> {
  const cur = await readRow().catch(() => null);
  if (!cur || cur.jobId !== jobId) return; // superseded — drop our result
  await writeRow({ ...cur, ...patch, PK, SK, jobId, startedAt: cur.startedAt }).catch((err) =>
    logger.warn({ errMessage: err instanceof Error ? err.message : String(err) }, 'cost-report-job: finish write failed'),
  );
}

function newJobId(): string {
  return `${Date.now()}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/**
 * Start (or join) an async report generation. If a fresh pending job already
 * exists, returns it (single-flight, so concurrent clicks / multiple operators
 * share one paid model call). Otherwise marks a new pending job and kicks off
 * the RICH generation in the background (not awaited), returning immediately.
 */
export async function startReportJob(input: GenerateCostReportInput): Promise<ReportJobStart> {
  const now = Date.now();
  const cur = await readRow().catch(() => null);
  if (cur && cur.status === 'pending' && now - cur.startedAt < STALE_MS) {
    return { jobId: cur.jobId, status: 'pending' };
  }

  const jobId = newJobId();
  await writeRow({ PK, SK, jobId, status: 'pending', startedAt: now });

  // Fire-and-forget: the HTTP response returns now; this keeps running on the
  // event loop and writes the result back to the row when done.
  void (async () => {
    try {
      const report = await generateCostReport({ ...input, rich: true });
      await finishIfCurrent(jobId, { status: 'done', report: JSON.stringify(report) });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn({ errMessage: msg, jobId }, 'cost-report-job: generation failed');
      await finishIfCurrent(jobId, { status: 'error', error: msg });
    }
  })();

  return { jobId, status: 'pending' };
}

/** Read the current job's state for polling. */
export async function getReportJob(): Promise<ReportJobResult> {
  const cur = await readRow().catch((err) => {
    logger.warn({ errMessage: err instanceof Error ? err.message : String(err) }, 'cost-report-job: read failed');
    return null;
  });
  if (!cur) return { status: 'idle' };

  if (cur.status === 'pending' && Date.now() - cur.startedAt > STALE_MS) {
    return { status: 'error', error: 'Report generation timed out (the worker may have restarted). Try again.' };
  }
  if (cur.status === 'done' && cur.report) {
    try {
      return { status: 'done', report: JSON.parse(cur.report) as CostReport };
    } catch {
      return { status: 'error', error: 'Stored report was unreadable. Try again.' };
    }
  }
  if (cur.status === 'error') return { status: 'error', error: cur.error ?? 'Report generation failed.' };
  return { status: 'pending' };
}
