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
import { tools } from './registry.js';
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
          'Returns a presigned URL the user can click. URL is valid 24h.',
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
          return {
            text: `${format.toUpperCase()} generated (${bytes.length.toLocaleString()} bytes). URL valid 24h:\n${url}`,
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ errMessage: msg }, 'document generation failed');
          return { text: `Document storage failed: ${msg}`, isError: true };
        }
      },
    });
  },
);
