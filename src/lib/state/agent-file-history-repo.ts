/**
 * Agent file history repo — every save of an agent's CLAUDE.md gets a
 * new row so we can diff and roll back.
 *
 * Schema:
 *   PK = AGENT#<agentId>
 *   SK = REV#<isoTime>#<revId>
 *   filename = "CLAUDE.md" | "agent.yaml"
 *   body = <full file contents>
 *   editedBy = "dashboard" | <user identifier>
 *   note = optional change description
 */

import { randomUUID, createHash } from 'node:crypto';
import {
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  PutObjectCommand as S3PutObject,
  S3Client,
} from '@aws-sdk/client-s3';
import { ddb } from './ddb.js';
import { invalidateAgentCache } from '../config/agent-loader.js';
import { logger } from '../../observability/logger.js';
import { writeAudit } from '../audit/audit-writer.js';
import { captureAwsClient } from '../observability/xray.js';

const TABLE =
  process.env.TABLE_AGENT_FILE_HISTORY ?? 'claudeclaw-agent-file-history';
const region = process.env.AWS_REGION ?? 'us-east-1';
const CONFIG_BUCKET = process.env.CONFIG_BUCKET ?? '';

let _s3: S3Client | null = null;
function s3(): S3Client {
  if (!_s3) _s3 = captureAwsClient(new S3Client({ region }));
  return _s3;
}

export type AgentFileName = 'CLAUDE.md' | 'agent.yaml';

export interface AgentFileRevision {
  revId: string;
  agentId: string;
  filename: AgentFileName;
  body: string;
  /** Hash to detect no-op saves. */
  bodyHash: string;
  editedBy: string;
  note?: string;
  createdAt: string;
}

export async function saveAgentFile(args: {
  agentId: string;
  filename: AgentFileName;
  body: string;
  editedBy: string;
  note?: string;
}): Promise<AgentFileRevision> {
  const revId = randomUUID();
  const createdAt = new Date().toISOString();
  const bodyHash = createHash('sha256').update(args.body).digest('hex');
  const rev: AgentFileRevision = {
    revId,
    agentId: args.agentId,
    filename: args.filename,
    body: args.body,
    bodyHash,
    editedBy: args.editedBy,
    ...(args.note ? { note: args.note } : {}),
    createdAt,
  };

  // 1) Append to history table.
  await ddb().send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: `AGENT#${args.agentId}`,
        SK: `REV#${createdAt}#${revId}`,
        ...rev,
      },
    }),
  );

  // 2) Write the file to the config bucket so loadAgent can pick it up.
  //    Falls through silently if no bucket configured (dev mode).
  if (CONFIG_BUCKET) {
    await s3().send(
      new S3PutObject({
        Bucket: CONFIG_BUCKET,
        Key: `agents/${args.agentId}/${args.filename}`,
        Body: args.body,
        ContentType:
          args.filename.endsWith('.yaml') || args.filename.endsWith('.yml')
            ? 'text/yaml; charset=utf-8'
            : 'text/markdown; charset=utf-8',
        Metadata: {
          'agent-id': args.agentId,
          'rev-id': revId,
          'edited-by': args.editedBy,
        },
      }),
    );
  }

  // 3) Bust the in-memory agent loader cache so the next turn sees it.
  invalidateAgentCache(args.agentId);

  // 4) Audit.
  void writeAudit({
    action: 'agent_file_edited',
    agentId: args.agentId,
    detail: {
      filename: args.filename,
      revId,
      bodyHash,
      editedBy: args.editedBy,
      ...(args.note ? { note: args.note } : {}),
    },
    result: 'ok',
  });

  logger.info(
    {
      agentId: args.agentId,
      filename: args.filename,
      revId,
      editedBy: args.editedBy,
      chars: args.body.length,
    },
    'agent file saved',
  );
  return rev;
}

export async function listRevisions(
  agentId: string,
  limit = 50,
): Promise<AgentFileRevision[]> {
  const out = await ddb().send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': `AGENT#${agentId}` },
      ScanIndexForward: false,
      Limit: limit,
    }),
  );
  return (out.Items ?? []).map((i) => toRev(i as Record<string, unknown>));
}

function toRev(i: Record<string, unknown>): AgentFileRevision {
  return {
    revId: String(i.revId ?? ''),
    agentId: String(i.agentId ?? ''),
    filename: (i.filename as AgentFileName | undefined) ?? 'CLAUDE.md',
    body: String(i.body ?? ''),
    bodyHash: String(i.bodyHash ?? ''),
    editedBy: String(i.editedBy ?? 'unknown'),
    ...(i.note ? { note: String(i.note) } : {}),
    createdAt: String(i.createdAt ?? ''),
  };
}
