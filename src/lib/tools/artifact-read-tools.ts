/** Owner-scoped, bounded text reads for immutable dashboard artifact versions. */

import type { Tool as BedrockTool } from '@aws-sdk/client-bedrock-runtime';
import { getArtifactVersion, readArtifactBody } from '../chat/artifacts-repo.js';
import { scanForExfil } from '../safety/exfil-guard.js';
import { tools, type ToolContext, type ToolResult } from './registry.js';

const MAX_STORED_ARTIFACT_BYTES = 30 * 1024 * 1024;
// Keep the textual result below both the 9 KiB contract and the registry
// coordinator's stricter 9,000-character assertion.
const MAX_MODEL_OUTPUT_BYTES = 9_000;
const TEXT_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json']);

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

function isStableDashboardContext(ctx: ToolContext): boolean {
  return ctx.surface === 'dashboard' &&
    typeof ctx.userId === 'string' && ctx.userId.startsWith('dashboard:user:') &&
    ctx.userId.length > 'dashboard:user:'.length &&
    ctx.chatId.startsWith('dashboard:');
}

function error(text: string): ToolResult {
  return { text, isError: true };
}

function contentType(value: string): string {
  return value.split(';', 1)[0]!.trim().toLowerCase();
}

function decodeBoundedUtf8(bytes: Uint8Array, limit: number): string {
  const end = Math.min(bytes.byteLength, limit);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  // The cut may land inside a multibyte character. Back up by at most three
  // bytes, keeping the decoded text valid UTF-8 without copying the body.
  for (let length = end; length >= Math.max(0, end - 3); length--) {
    try {
      return decoder.decode(bytes.subarray(0, length));
    } catch {
      // Retry only the final partial UTF-8 character.
    }
  }
  throw new Error('invalid text encoding');
}

async function readArtifact(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  if (!isStableDashboardContext(ctx)) {
    return error('Artifact reads are available only in a person-owned dashboard conversation.');
  }

  const artifactId = args.artifactId;
  const version = args.version;
  if (typeof artifactId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(artifactId) ||
      typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    return error('Provide a valid artifact ID and positive version number.');
  }

  const scope = {
    agentId: ctx.agentId,
    chatId: ctx.chatId,
    ownerId: ctx.userId!,
    artifactId,
    version,
  };

  try {
    const descriptor = await getArtifactVersion(scope);
    if (descriptor.artifactId !== artifactId || descriptor.version !== version) {
      return error('That artifact version was not found or is unavailable to this owner.');
    }

    const mime = contentType(descriptor.contentType);
    if (!TEXT_TYPES.has(mime)) {
      return error('That artifact version is not a supported text format.');
    }

    // saveArtifact enforces this fixed storage ceiling before writing. The
    // repository read therefore has a 30 MiB allocation bound even though its
    // descriptor intentionally does not expose private storage metadata.
    const body = await readArtifactBody(scope);
    if (!(body instanceof Uint8Array) || body.byteLength > MAX_STORED_ARTIFACT_BYTES) {
      return error('That artifact version is unavailable or exceeds the read limit.');
    }

    let decoded: string;
    try {
      decoded = decodeBoundedUtf8(body, MAX_MODEL_OUTPUT_BYTES);
    } catch {
      return error('That artifact version does not contain valid UTF-8 text.');
    }
    if (decoded.includes('\u0000')) {
      return error('That artifact version is not a supported text format.');
    }

    const prefix = `Artifact text (${mime}, version ${version}):\n`;
    const prefixBytes = Buffer.byteLength(prefix, 'utf8');
    const text = prefix + decodeBoundedUtf8(body, MAX_MODEL_OUTPUT_BYTES - prefixBytes);
    if (Buffer.byteLength(text, 'utf8') > MAX_MODEL_OUTPUT_BYTES) {
      return error('That artifact version could not be safely bounded for reading.');
    }

    let scan;
    try {
      scan = await scanForExfil(text);
    } catch {
      return error('Artifact text could not pass the required safety scan.');
    }
    if (!scan || typeof scan.blocked !== 'boolean' || typeof scan.truncated !== 'boolean' ||
        typeof scan.scannedBytes !== 'number' || !Number.isFinite(scan.scannedBytes) ||
        !Array.isArray(scan.matches) || scan.blocked || scan.truncated || scan.scannedBytes < text.length ||
        scan.matches.some((match) => match.severity === 'block')) {
      return error('Artifact text was refused by the required safety scan.');
    }

    return { text };
  } catch {
    // Repository exceptions may contain object keys, URLs, or infrastructure
    // details. Keep the model result generic and do not log the exception.
    return error('That artifact version was not found or is unavailable to this owner.');
  }
}

tools.register('read_artifact', {
  spec: spec(
    'read_artifact',
    'Read a bounded text artifact version from the current person-owned dashboard conversation.',
    {
      type: 'object',
      properties: {
        artifactId: { type: 'string', format: 'uuid', description: 'Artifact ID to read.' },
        version: { type: 'integer', minimum: 1, description: 'Positive immutable artifact version.' },
      },
      required: ['artifactId', 'version'],
      additionalProperties: false,
    },
  ),
  invoke: readArtifact,
});
