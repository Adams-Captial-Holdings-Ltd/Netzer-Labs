/**
 * generate_document tool — produces a PDF / DOCX / XLSX, stores the
 * bytes in S3 raw under `generations/<chat>/<ulid>.<ext>`, returns a
 * presigned URL.
 *
 * Gated on:
 *   - `RAW_BUCKET` env var (set by compute-stack at deploy time)
 *   - `document_gen_disabled` kill switch
 *   - daily cost cap (re-checked here even though the agent loop also
 *     checks once per turn, mirroring the nova-canvas pattern)
 *
 * The actual cost per call is essentially the S3 PUT — fractions of a
 * cent. The cost-cap re-check is there to stop a runaway tool-call
 * chain from accumulating PUTs while a turn is mid-loop.
 */

import type { Tool as BedrockTool } from '@aws-sdk/client-bedrock-runtime';
import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import { tools, type ToolResult } from './registry.js';
import { registerIfConfigured } from '../addons/registry.js';
import { isKillSwitchActive } from '../state/kill-switches-repo.js';
import { writeAudit } from '../audit/audit-writer.js';
import { logger } from '../../observability/logger.js';
import { getDailyCostUsd, SpendIndeterminateError } from '../usage/token-tracker.js';
import { getEffectiveCostCap, isCostCapEnforced } from '../state/cost-cap-repo.js';
import { captureAwsClient } from '../observability/xray.js';
import {
  validateDocumentSpec,
  validateSpreadsheetSpec,
  type GenerateFormat,
} from '../documents/types.js';
import { buildPdf } from '../documents/pdf.js';
import { buildDocx } from '../documents/docx.js';
import { buildXlsx } from '../documents/xlsx.js';
import { saveArtifact } from '../chat/artifacts-repo.js';

const region = process.env.AWS_REGION ?? 'us-east-1';
const RAW_BUCKET = process.env.RAW_BUCKET ?? '';
const PRESIGN_TTL_SEC = 60 * 60 * 24;

let _s3: S3Client | null = null;
function s3(): S3Client {
  if (!_s3) _s3 = captureAwsClient(new S3Client({ region }));
  return _s3;
}

function spec(name: string, description: string, schema: unknown): BedrockTool {
  return {
    toolSpec: {
      name,
      description,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inputSchema: { json: schema as any },
    },
  };
}

const CONTENT_TYPES: Record<GenerateFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function isStableDashboardContext(ctx: { surface?: string; userId?: string; chatId: string }): boolean {
  return ctx.surface === 'dashboard' &&
    typeof ctx.userId === 'string' && ctx.userId.startsWith('dashboard:user:') &&
    ctx.chatId.startsWith('dashboard:');
}

function abortedResult(): ToolResult {
  return { text: 'Document generation was stopped before storage.', isError: true };
}

/**
 * Display filename for a generated document, taken from the spec's own title.
 *
 * Sanitized and length-capped because it reaches a Content-Disposition header
 * and a Telegram/Slack upload filename. It is deliberately NOT used to build
 * the S3 key — the key stays server-derived from ctx, so a model-supplied
 * title can never influence where bytes land.
 */
export function documentFileName(spec: unknown, format: GenerateFormat): string {
  const title =
    spec && typeof spec === 'object' && typeof (spec as { title?: unknown }).title === 'string'
      ? (spec as { title: string }).title
      : '';
  const safe = title.trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);
  return `${safe || 'document'}.${format}`;
}

/**
 * Build the tool result for a stored document.
 *
 * The document rides on `media` so each surface can deliver the real file
 * without the URL passing through the model — the same contract
 * `generate_image` has always used. Returning the link only as text is what
 * broke downloads: the model reproduces the text in its own reply, and a
 * signed S3 URL loses its X-Amz-* query string in transit, which S3 then
 * correctly rejects with AccessDenied.
 *
 * The URL is still in `text` on purpose. Telegram and Slack have no document
 * delivery path yet (neither has a sendDocument helper), so that fallback is
 * currently their only link. Drop it once bot delivery lands.
 *
 * Pure so it is testable without S3 — matches the buildNovaBody pattern.
 */
export function buildDocumentResult(a: {
  format: GenerateFormat;
  fileName: string;
  bytes: number;
  bucket: string;
  key: string;
  url: string;
}): ToolResult {
  return {
    text: [
      `${a.format.toUpperCase()} generated: ${a.fileName} (${a.bytes.toLocaleString()} bytes).`,
      `It is attached for download. Direct link, valid 24h:`,
      a.url,
    ].join('\n'),
    media: [
      {
        kind: 'artifact',
        s3Bucket: a.bucket,
        s3Key: a.key,
        contentType: CONTENT_TYPES[a.format],
        presignedUrl: a.url,
        caption: a.fileName,
      },
    ],
  };
}

registerIfConfigured(
  {
    id: 'document_gen',
    title: 'Document generation (PDF / DOCX / XLSX)',
    category: 'tool',
    description:
      'Generate documents the user can download. PDF + DOCX for narrative, XLSX for tabular data. Output stored in S3 raw with a 24h presigned URL.',
    required: [
      { envVar: 'RAW_BUCKET', description: 'S3 raw bucket for generated documents' },
    ],
    killSwitch: 'document_gen_disabled',
    defaultOn: true,
  },
  () => {
    tools.register('generate_document', {
      spec: spec(
        'generate_document',
        [
          'Generate a downloadable document. Choose format:',
          '  - "pdf"  — printable PDF, good for reports + memos + receipts',
          '  - "docx" — editable Word doc, good for drafts the user will revise',
          '  - "xlsx" — Excel workbook with one or more sheets, good for tabular data',
          'On Telegram and Slack, returns a presigned URL valid 24h. In dashboard chat, saves an owner-scoped artifact and returns a URL-free artifact reference.',
          'To revise a saved dashboard artifact, provide both artifactId and its current expectedVersion.',
          'Use when the user asks for a report, a spreadsheet, a table they can download, or anything they want to keep as a file.',
        ].join('\n'),
        {
          type: 'object',
          required: ['format', 'spec'],
          properties: {
            format: {
              type: 'string',
              enum: ['pdf', 'docx', 'xlsx'],
              description: 'Output file format.',
            },
            spec: {
              type: 'object',
              description:
                'For pdf/docx: { title, sections: [{ heading?, body?, table?: { rows: string[][] } }] }. For xlsx: { title, sheets: [{ name, rows: cell[][] }] } where cell can be string|number|boolean|null.',
            },
            artifactId: {
              type: 'string',
              description: 'Existing dashboard artifact id to revise. Requires expectedVersion.',
            },
            expectedVersion: {
              type: 'integer',
              minimum: 1,
              description: 'Current artifact version; the revision is refused if the head has changed.',
            },
          },
        },
      ),
      async invoke(args, ctx) {
        const killed = await isKillSwitchActive('document_gen_disabled');
        if (killed.active) {
          return {
            text: `Document generation disabled: ${killed.reason ?? 'no reason given'}`,
            isError: true,
          };
        }

        // Re-check daily cost cap inside the tool. Same rationale as
        // nova-canvas-tools: a long tool-call chain shouldn't be able
        // to walk past the cap between turn-level checks. Honors the kill
        // switch AND the cap_enabled flag.
        if (await isCostCapEnforced()) {
          const capUsd = await getEffectiveCostCap();
          if (Number.isFinite(capUsd)) {
            // Strict read: an indeterminate spend total fails CLOSED (refuse the
            // document call) instead of running on an understated partial total.
            let spend: number;
            try {
              spend = await getDailyCostUsd({ strict: true });
            } catch (err) {
              if (err instanceof SpendIndeterminateError) {
                return {
                  text: 'Daily cost cap could not be verified (spend total is indeterminate). Document generation refused.',
                  isError: true,
                };
              }
              throw err;
            }
            if (spend >= capUsd) {
              return {
                text: `Daily cost cap exceeded ($${spend.toFixed(4)} >= $${capUsd}). Document generation refused.`,
                isError: true,
              };
            }
          }
        }

        if (!RAW_BUCKET) {
          return {
            text: 'Document generation not configured (no RAW_BUCKET).',
            isError: true,
          };
        }

        const format = (args.format ?? '') as GenerateFormat;
        if (!['pdf', 'docx', 'xlsx'].includes(format)) {
          return {
            text: 'format must be one of: pdf, docx, xlsx',
            isError: true,
          };
        }
        const isDashboard = ctx.surface === 'dashboard' || ctx.chatId.startsWith('dashboard:');
        if (isDashboard && !isStableDashboardContext(ctx)) {
          return {
            text: 'Document generation requires a stable, person-owned dashboard conversation.',
            isError: true,
          };
        }

        const artifactId = args.artifactId;
        const expectedVersion = args.expectedVersion;
        if (artifactId !== undefined && (
          typeof artifactId !== 'string' || artifactId.length === 0 ||
          !Number.isInteger(expectedVersion) || (expectedVersion as number) < 1
        )) {
          return { text: 'A document revision requires a valid expectedVersion.', isError: true };
        }
        if (artifactId === undefined && expectedVersion !== undefined) {
          return { text: 'expectedVersion requires an artifactId.', isError: true };
        }
        if (ctx.abortSignal?.aborted) return abortedResult();

        const t0 = Date.now();
        let bytes: Buffer;
        try {
          if (format === 'xlsx') {
            bytes = await buildXlsx(validateSpreadsheetSpec(args.spec));
          } else if (format === 'pdf') {
            bytes = await buildPdf(validateDocumentSpec(args.spec));
          } else {
            bytes = await buildDocx(validateDocumentSpec(args.spec));
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return { text: `spec invalid or build failed: ${msg}`, isError: true };
        }

        const id = randomUUID();
        const safeChat = ctx.chatId.replace(/[^A-Za-z0-9_-]/g, '_');
        const key = `generations/${safeChat}/${id}.${format}`;
        // Display name only — never part of the storage key, which stays
        // server-derived so a model-supplied title cannot steer the S3 path.
        const fileName = documentFileName(args.spec, format);

        if (isDashboard) {
          // saveArtifact owns DLP scanning, CURATED storage, version rows and
          // the conditional head fence. Do not create a second RAW copy here.
          if (ctx.abortSignal?.aborted) return abortedResult();
          try {
            const descriptor = await saveArtifact({
              agentId: ctx.agentId,
              chatId: ctx.chatId,
              ownerId: ctx.userId!,
              fileName,
              contentType: CONTENT_TYPES[format],
              body: bytes,
              source: artifactId === undefined
                ? { kind: 'generated', format, spec: args.spec }
                : { kind: 'revision', fromVersion: expectedVersion, format, spec: args.spec },
              ...(artifactId !== undefined ? { artifactId, expectedVersion: expectedVersion as number } : {}),
            });
            const latencyMs = Date.now() - t0;
            logger.info({ agentId: ctx.agentId, chatId: ctx.chatId, format, bytes: bytes.length, latencyMs },
              'dashboard document generated');
            void writeAudit({
              action: 'tool_invoke',
              agentId: ctx.agentId,
              chatId: ctx.chatId,
              toolName: 'generate_document',
              detail: { format, artifactId: descriptor.artifactId, version: descriptor.version, bytes: bytes.length, latencyMs },
              result: 'ok',
            });
            return {
              text: `${format.toUpperCase()} generated: ${fileName} (${bytes.length.toLocaleString()} bytes). It is saved to this conversation's artifacts.`,
              artifacts: [descriptor],
            };
          } catch {
            // Repository failures can contain storage keys or DLP details;
            // keep all failure channels free of that data and source content.
            logger.warn({ agentId: ctx.agentId, chatId: ctx.chatId, format }, 'dashboard document storage failed');
            void writeAudit({
              action: 'tool_invoke',
              agentId: ctx.agentId,
              chatId: ctx.chatId,
              toolName: 'generate_document',
              detail: { format },
              result: 'error',
            });
            return { text: 'Document could not be saved to this conversation. Please try again.', isError: true };
          }
        }

        if (ctx.abortSignal?.aborted) return abortedResult();
        try {
          await s3().send(
            new PutObjectCommand({
              Bucket: RAW_BUCKET,
              Key: key,
              Body: bytes,
              ContentType: CONTENT_TYPES[format],
              Metadata: {
                'agent-id': ctx.agentId,
                'chat-id': ctx.chatId,
                format,
              },
            }),
          );
          const url = await getSignedUrl(
            s3(),
            new GetObjectCommand({ Bucket: RAW_BUCKET, Key: key }),
            { expiresIn: PRESIGN_TTL_SEC },
          );
          const latencyMs = Date.now() - t0;
          logger.info(
            {
              agentId: ctx.agentId,
              chatId: ctx.chatId,
              format,
              bytes: bytes.length,
              key,
              latencyMs,
            },
            'document generated',
          );
          void writeAudit({
            action: 'tool_invoke',
            agentId: ctx.agentId,
            chatId: ctx.chatId,
            toolName: 'generate_document',
            detail: { format, key, bytes: bytes.length, latencyMs },
            result: 'ok',
          });
          return buildDocumentResult({
            format,
            fileName,
            bytes: bytes.length,
            bucket: RAW_BUCKET,
            key,
            url,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ errMessage: msg }, 'document generation failed');
          return { text: `Document storage failed: ${msg}`, isError: true };
        }
      },
    });
  },
);
