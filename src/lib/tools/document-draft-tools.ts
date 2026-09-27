/** Cross-turn incremental document drafts stored as conversation child rows. */
import type { Tool as BedrockTool } from '@aws-sdk/client-bedrock-runtime';
import { GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { createHash, randomUUID } from 'node:crypto';
import { tools, type ToolContext, type ToolResult } from './registry.js';
import { ddb } from '../state/ddb.js';
import { acquireConversationChildLock, appendTurns, getSession } from '../state/sessions-repo.js';
import { scanForExfil } from '../safety/exfil-guard.js';
import { isKillSwitchActive } from '../state/kill-switches-repo.js';
import { isCostCapEnforced, getEffectiveCostCap } from '../state/cost-cap-repo.js';
import { getDailyCostUsd } from '../usage/token-tracker.js';
import { validateDocumentSpec, validateSpreadsheetSpec, type GenerateFormat } from '../documents/types.js';
import { validatePresentationSpec } from '../documents/pptx.js';
import { buildPdf } from '../documents/pdf.js';
import { buildDocx } from '../documents/docx.js';
import { buildXlsx } from '../documents/xlsx.js';
import { buildPptx } from '../documents/pptx.js';
import { saveArtifact, type ArtifactDescriptor } from '../chat/artifacts-repo.js';

const TABLE = process.env.TABLE_SESSIONS ?? 'claudeclaw-sessions';
const MAX_ROW_BYTES = 128 * 1024;
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_CHILDREN = 200_000;
const CONTENT_TYPES: Record<GenerateFormat, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
type DraftMeta = {
  PK: string; SK: string; kind: 'document-draft'; draftId: string; agentId: string; chatId: string;
  ownerId: string; format: GenerateFormat; title: string; revision: number; sourceBytes: number;
  status: 'open' | 'finalizing' | 'complete'; startOperationId: string; startHash: string;
  finalOperationId?: string; finalHash?: string; artifact?: ArtifactDescriptor;
};
type Segment = { PK: string; SK: string; draftId: string; revision: number; operationId: string; contentHash: string;
  payload: { type: 'section'; section: unknown } | { type: 'slide'; slide: unknown } |
    { type: 'sheet'; name: string; rows: unknown[] } | { type: 'row'; name: string; row: unknown[] } };

function toolSpec(): BedrockTool {
  const schema = {
    type: 'object', required: ['action'], properties: {
      action: { type: 'string', enum: ['start', 'append', 'finalize', 'abandon'] },
      format: { type: 'string', enum: ['pdf', 'docx', 'xlsx', 'pptx'] }, title: { type: 'string' },
      draftId: { type: 'string' }, expectedRevision: { type: 'integer', minimum: 0 }, operationId: { type: 'string' },
      section: { type: 'object' }, slide: { type: 'object' }, sheet: { type: 'object' }, sheetName: { type: 'string' }, row: { type: 'array' },
    },
  };
  return { toolSpec: { name: 'document_draft', description: [
    'Build a document incrementally across turns, then finalize it once as a saved conversation artifact.',
    'Call start with format, title, and operationId. Call append with draftId, expectedRevision, operationId, and one section (PDF/DOCX), one slide (PPTX), or one sheet/row (XLSX).',
    'Call finalize with draftId, current expectedRevision, and operationId. The draft is durable between calls and each append advances revision by one.',
  ].join(' '),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema: { json: schema as any } } };
}
function pk(agentId: string): string { return `AGENT#${agentId}`; }
function base(chatId: string): string { return `CHAT#${chatId.replace(/#/g, '_')}#`; }
function metaSk(chatId: string, draftId: string): string { return `${base(chatId)}DRAFT#${draftId}#META`; }
function segmentPrefix(chatId: string, draftId: string): string { return `${base(chatId)}DRAFT#${draftId}#SEG#`; }
function segmentSk(chatId: string, draftId: string, revision: number): string {
  return `${segmentPrefix(chatId, draftId)}${String(revision).padStart(10, '0')}`;
}
function safeError(message: string): ToolResult { return { text: message, isError: true }; }
function serialized(value: unknown): string {
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error('invalid');
  return result;
}
function hash(value: unknown): string { return createHash('sha256').update(serialized(value)).digest('hex'); }
function stableOwner(ctx: ToolContext): boolean {
  return ctx.surface === 'dashboard' && !!ctx.userId?.startsWith('dashboard:user:') && ctx.chatId.startsWith('dashboard:');
}
function validateOperationId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value);
}
async function scan(text: string): Promise<boolean> {
  if (Buffer.byteLength(text, 'utf8') > MAX_ROW_BYTES) return false;
  try {
    const result = await scanForExfil(text);
    return !!result && !result.blocked && !result.truncated && result.scannedBytes >= Buffer.byteLength(text, 'utf8') &&
      !result.matches.some((m) => m.severity === 'block');
  } catch { return false; }
}
async function ownedMeta(ctx: ToolContext, draftId: string): Promise<DraftMeta | undefined> {
  const out = await ddb().send(new GetCommand({ TableName: TABLE,
    Key: { PK: pk(ctx.agentId), SK: metaSk(ctx.chatId, draftId) }, ConsistentRead: true }));
  const meta = out.Item as DraftMeta | undefined;
  if (!meta || meta.ownerId !== ctx.userId || meta.agentId !== ctx.agentId || meta.chatId !== ctx.chatId) return undefined;
  return meta;
}
async function assertStableParent(ctx: ToolContext): Promise<boolean> {
  const session = await getSession(ctx.agentId, ctx.chatId, { consistentRead: true });
  if (!session) {
    try { await appendTurns(ctx.agentId, ctx.chatId, [], undefined, { surface: 'dashboard', userId: ctx.userId, ephemeral: false }); }
    catch { return false; }
  }
  const current = await getSession(ctx.agentId, ctx.chatId, { consistentRead: true });
  return !!current && current.surface === 'dashboard' && current.userId === ctx.userId && current.ttl === undefined;
}
async function querySegments(ctx: ToolContext, draftId: string): Promise<Segment[]> {
  const rows: Segment[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const out = await ddb().send(new QueryCommand({ TableName: TABLE,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
      ExpressionAttributeValues: { ':pk': pk(ctx.agentId), ':prefix': segmentPrefix(ctx.chatId, draftId) },
      ConsistentRead: true, ...(cursor ? { ExclusiveStartKey: cursor } : {}) }));
    rows.push(...((out.Items ?? []) as Segment[]));
    cursor = out.LastEvaluatedKey;
    if (rows.length > MAX_CHILDREN) throw new Error('too many');
  } while (cursor);
  return rows.sort((a, b) => a.revision - b.revision);
}
function assemble(meta: DraftMeta, segments: Segment[]): unknown {
  if (meta.format === 'pdf' || meta.format === 'docx') {
    return validateDocumentSpec({ title: meta.title, sections: segments.map((item) => {
      if (item.payload.type !== 'section') throw new Error('invalid');
      return item.payload.section;
    }) });
  }
  if (meta.format === 'pptx') {
    return validatePresentationSpec({ title: meta.title, slides: segments.map((item) => {
      if (item.payload.type !== 'slide') throw new Error('invalid');
      return item.payload.slide;
    }) });
  }
  const sheets: Array<{ name: string; rows: unknown[] }> = [];
  for (const item of segments) {
    const p = item.payload;
    if (p.type === 'sheet') sheets.push({ name: p.name, rows: [...p.rows] });
    else if (p.type === 'row') {
      let sheet = sheets.find((candidate) => candidate.name === p.name);
      if (!sheet) { sheet = { name: p.name, rows: [] }; sheets.push(sheet); }
      sheet.rows.push(p.row);
    } else throw new Error('invalid');
  }
  return validateSpreadsheetSpec({ title: meta.title, sheets });
}
async function checkCost(): Promise<boolean> {
  if (!(await isCostCapEnforced())) return true;
  const cap = await getEffectiveCostCap();
  if (!Number.isFinite(cap)) return true;
  try { return (await getDailyCostUsd({ strict: true })) < cap; } catch { return false; }
}
async function invoke(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!stableOwner(ctx)) return safeError('Incremental document drafts require a stable dashboard conversation owner.');
  if (!validateOperationId(args.operationId)) return safeError('A valid operationId is required.');
  const action = args.action;
  try {
    if (action === 'start') {
      if (!['pdf', 'docx', 'xlsx', 'pptx'].includes(String(args.format)) || typeof args.title !== 'string' || !args.title.length || args.title.length > 200)
        return safeError('Start requires a supported format and a title of at most 200 characters.');
      const format = args.format as GenerateFormat;
      const startValue = { format, title: args.title };
      const startHash = hash(startValue);
      if (!(await scan(serialized({ title: args.title })))) return safeError('Draft title was refused by the required safety scan.');
      const release = await acquireConversationChildLock(ctx.agentId, ctx.chatId);
      try {
        if (!(await assertStableParent(ctx))) return safeError('Draft conversation is missing, ephemeral, or owned by another user.');
        const prefix = `${base(ctx.chatId)}DRAFT#`;
        let cursor: Record<string, unknown> | undefined;
        let prior: DraftMeta | undefined;
        do {
          const existing = await ddb().send(new QueryCommand({ TableName: TABLE,
            KeyConditionExpression: 'PK = :pk AND begins_with(SK, :prefix)',
            ExpressionAttributeValues: { ':pk': pk(ctx.agentId), ':prefix': prefix }, ConsistentRead: true,
            ...(cursor ? { ExclusiveStartKey: cursor } : {}) }));
          prior = ((existing.Items ?? []) as DraftMeta[]).find((row) => row.SK.endsWith('#META') && row.startOperationId === args.operationId);
          cursor = existing.LastEvaluatedKey;
        } while (!prior && cursor);
        if (prior) return prior.startHash === startHash ? { text: JSON.stringify({ draftId: prior.draftId, revision: 0 }) } : safeError('That operationId was already used with different content.');
        const draftId = randomUUID();
        const item: DraftMeta = { PK: pk(ctx.agentId), SK: metaSk(ctx.chatId, draftId), kind: 'document-draft', draftId,
          agentId: ctx.agentId, chatId: ctx.chatId, ownerId: ctx.userId!, format, title: args.title, revision: 0,
          sourceBytes: Buffer.byteLength(serialized(startValue)), status: 'open', startOperationId: args.operationId, startHash };
        if (Buffer.byteLength(serialized(item)) > MAX_ROW_BYTES) return safeError('Draft metadata exceeds the storage limit.');
        await ddb().send(new PutCommand({ TableName: TABLE, Item: item, ConditionExpression: 'attribute_not_exists(PK)' }));
        return { text: JSON.stringify({ draftId, revision: 0 }) };
      } finally { await release(); }
    }

    if (typeof args.draftId !== 'string' || !/^[0-9a-f-]{36}$/i.test(args.draftId)) return safeError('A valid draftId is required.');
    const draftId = args.draftId;
    if (action === 'append') {
      if (!Number.isInteger(args.expectedRevision) || (args.expectedRevision as number) < 0) return safeError('A valid expectedRevision is required.');
      const release = await acquireConversationChildLock(ctx.agentId, ctx.chatId);
      try {
        const meta = await ownedMeta(ctx, draftId);
        if (!meta || meta.status !== 'open') return safeError('Draft is unavailable or no longer open.');
        let payload: Segment['payload'];
        if (meta.format === 'pdf' || meta.format === 'docx') {
          if (!args.section || typeof args.section !== 'object' || Array.isArray(args.section)) return safeError('Append one section object.');
          payload = { type: 'section', section: args.section };
        } else if (meta.format === 'pptx') {
          if (!args.slide || typeof args.slide !== 'object' || Array.isArray(args.slide)) return safeError('Append one slide object.');
          payload = { type: 'slide', slide: args.slide };
        } else if (args.sheet && typeof args.sheet === 'object' && !Array.isArray(args.sheet)) {
          const sheet = args.sheet as { name?: unknown; rows?: unknown };
          if (typeof sheet.name !== 'string' || !Array.isArray(sheet.rows)) return safeError('Append a sheet with a name and rows.');
          payload = { type: 'sheet', name: sheet.name, rows: sheet.rows };
        } else {
          const row = args.row;
          const name = typeof args.sheetName === 'string' ? args.sheetName : 'Sheet1';
          if (!Array.isArray(row)) return safeError('Append one spreadsheet row with an optional sheetName.');
          payload = { type: 'row', name, row };
        }
        const contentHash = hash(payload);
        const segmentText = serialized(payload);
        const sourceBytes = Buffer.byteLength(segmentText, 'utf8');
        const candidate: Segment = { PK: pk(ctx.agentId), SK: segmentSk(ctx.chatId, draftId, (args.expectedRevision as number) + 1),
          draftId, revision: (args.expectedRevision as number) + 1, operationId: args.operationId, contentHash, payload };
        if (Buffer.byteLength(serialized(candidate), 'utf8') > MAX_ROW_BYTES || meta.sourceBytes + sourceBytes > MAX_SOURCE_BYTES)
          return safeError('Draft segment exceeds the bounded storage limit.');
        if (!(await scan(segmentText))) return safeError('Draft content was refused by the required safety scan.');
        const rows = await querySegments(ctx, draftId);
        const duplicate = rows.find((row) => row.operationId === args.operationId);
        if (duplicate) return duplicate.contentHash === contentHash
          ? { text: JSON.stringify({ draftId, revision: duplicate.revision }) }
          : safeError('That operationId was already used with different content.');
        if (meta.revision !== args.expectedRevision) return safeError('Draft revision is stale; reload the current revision before appending.');
        if (rows.length >= MAX_CHILDREN) return safeError('Draft has reached its finite segment limit.');
        await ddb().send(new TransactWriteCommand({ TransactItems: [
          { Put: { TableName: TABLE, Item: candidate, ConditionExpression: 'attribute_not_exists(PK)' } },
          { Put: { TableName: TABLE, Item: { ...meta, revision: candidate.revision, sourceBytes: meta.sourceBytes + sourceBytes },
            ConditionExpression: '#revision = :expected AND #status = :open AND ownerId = :owner',
            ExpressionAttributeNames: { '#revision': 'revision', '#status': 'status' },
            ExpressionAttributeValues: { ':expected': args.expectedRevision, ':open': 'open', ':owner': ctx.userId } } },
        ] }));
        return { text: JSON.stringify({ draftId, revision: candidate.revision }) };
      } finally { await release(); }
    }

    if (action === 'abandon') {
      const release = await acquireConversationChildLock(ctx.agentId, ctx.chatId);
      try {
        const meta = await ownedMeta(ctx, draftId);
        if (!meta || meta.status !== 'open') return safeError('Draft is unavailable or no longer open.');
        await ddb().send(new PutCommand({ TableName: TABLE, Item: { ...meta, status: 'abandoned' },
          ConditionExpression: '#revision = :revision AND #status = :open AND ownerId = :owner',
          ExpressionAttributeNames: { '#status': 'status', '#revision': 'revision' },
          ExpressionAttributeValues: { ':open': 'open', ':revision': meta.revision, ':owner': ctx.userId } }));
        return { text: JSON.stringify({ draftId, abandoned: true }) };
      } finally { await release(); }
    }

    if (action !== 'finalize' || !Number.isInteger(args.expectedRevision) || (args.expectedRevision as number) < 0)
      return safeError('Finalize requires a valid expectedRevision.');
    if (await isKillSwitchActive('document_gen_disabled').then((v) => v.active).catch(() => true))
      return safeError('Document generation is disabled.');
    const release = await acquireConversationChildLock(ctx.agentId, ctx.chatId);
    let meta: DraftMeta;
    let assembled: unknown;
    let finalHash: string;
    try {
      const found = await ownedMeta(ctx, draftId);
      if (!found) return safeError('Draft is unavailable or owned by another user.');
      if (found.status === 'complete' && found.finalOperationId === args.operationId) return { text: 'Draft finalized.', artifacts: found.artifact ? [found.artifact] : [] };
      if (found.status !== 'open' || found.revision !== args.expectedRevision) return safeError('Draft is stale or already finalizing; manual recovery may be required.');
      if (ctx.abortSignal?.aborted) return safeError('Document generation was stopped before build or storage.');
      if (!(await checkCost())) return safeError('Document generation is over the daily cost limit.');
      const segments = await querySegments(ctx, draftId);
      if (segments.length !== found.revision) return safeError('Draft segments are incomplete; manual recovery is required.');
      assembled = assemble(found, segments);
      finalHash = hash({ draftId, revision: found.revision, operationId: args.operationId });
      meta = { ...found, status: 'finalizing', finalOperationId: args.operationId, finalHash };
      await ddb().send(new PutCommand({ TableName: TABLE, Item: meta,
        ConditionExpression: '#status = :open AND #revision = :revision AND ownerId = :owner',
        ExpressionAttributeNames: { '#status': 'status', '#revision': 'revision' },
        ExpressionAttributeValues: { ':open': 'open', ':revision': found.revision, ':owner': ctx.userId } }));
    } catch {
      return safeError('Draft could not be validated or fenced for finalization.');
    } finally { await release(); }

    if (await isKillSwitchActive('document_gen_disabled').then((v) => v.active).catch(() => true))
      return safeError('Document generation is disabled; draft remains fenced for manual recovery.');
    if (ctx.abortSignal?.aborted) return safeError('Document generation was stopped before build or storage; draft remains fenced for manual recovery.');
    try {
      let body: Buffer;
      if (meta!.format === 'pdf') body = await buildPdf(assembled as ReturnType<typeof validateDocumentSpec>);
      else if (meta!.format === 'docx') body = await buildDocx(assembled as ReturnType<typeof validateDocumentSpec>);
      else if (meta!.format === 'xlsx') body = await buildXlsx(assembled as ReturnType<typeof validateSpreadsheetSpec>);
      else body = await buildPptx(assembled);
      if (ctx.abortSignal?.aborted) return safeError('Document generation was stopped before storage; draft remains fenced for manual recovery.');
      const fileName = `${meta!.title.trim().replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'document'}.${meta!.format}`;
      const descriptor = await saveArtifact({ agentId: ctx.agentId, chatId: ctx.chatId, ownerId: ctx.userId!, fileName,
        contentType: CONTENT_TYPES[meta!.format], body,
        source: { kind: 'draft', draftId, revision: meta!.revision, format: meta!.format } });
      await ddb().send(new PutCommand({ TableName: TABLE, Item: { ...meta!, status: 'complete', artifact: descriptor },
        ConditionExpression: '#status = :finalizing AND finalOperationId = :op AND finalHash = :hash',
        ExpressionAttributeNames: { '#status': 'status' },
        ExpressionAttributeValues: { ':finalizing': 'finalizing', ':op': args.operationId, ':hash': finalHash! } }));
      return { text: `${meta!.format.toUpperCase()} generated and saved to this conversation's artifacts.`, artifacts: [descriptor] };
    } catch {
      return safeError('Draft finalization failed; it remains fenced for manual recovery.');
    }
  } catch {
    return safeError('Draft operation failed safely. Please retry with the current revision or request manual recovery.');
  }
}

tools.register('document_draft', { spec: toolSpec(), invoke });
