/**
 * NZR-6 (Q83) — move every legacy chat-added knowledge doc out of the agent,
 * default and shared scopes into the admin-only `chat_quarantine` scope. Those
 * docs have no reliable uploader record, so they fail closed: admins list them
 * (GET /api/knowledge/quarantine) and reassign or delete each.
 *
 *   npx tsx scripts/nzr6-quarantine-chat-docs.ts            DRY RUN: list only
 *   npx tsx scripts/nzr6-quarantine-chat-docs.ts --apply    move (owner yes, Q50)
 *   npx tsx scripts/nzr6-quarantine-chat-docs.ts --verify   count what is left
 *
 * Per doc: copy (docId `<fromScope>__<docId>`, tag `from:<fromScope>`, chunks
 * and embeddings unchanged), then an awaited `knowledge_quarantined` row, then
 * delete the original. A failed audit leaves the doc where it was and the run
 * exits non-zero. Idempotent. Not registered in scripts/migrations (a fresh
 * install has nothing to move) and never run on the legacy app (Q84).
 */

import { pathToFileURL } from 'node:url';
import { listScopePrefixes, iterateRows, putDocument, deleteDocument, type VectorRow } from '../src/lib/vectors/store.js';
import { writeAuditOrThrow } from '../src/lib/audit/audit-writer.js';
import { isChatScope, scopeHash, QUARANTINE_SCOPE } from '../src/lib/vectors/scope-access.js';

export interface Candidate {
  fromScope: string;
  docId: string;
  title: string | null;
  chunks: number;
  rows: VectorRow[];
}

/** Docs tagged `chat` in every scope outside the chat_ namespace. */
async function findCandidates(): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const fromScope of await listScopePrefixes()) {
    if (isChatScope(fromScope)) continue;
    const byDoc = new Map<string, VectorRow[]>();
    for await (const row of iterateRows(fromScope)) {
      if (!(row.metadata.tags ?? []).includes('chat')) continue;
      const rows = byDoc.get(row.metadata.docId) ?? [];
      rows.push(row);
      byDoc.set(row.metadata.docId, rows);
    }
    for (const [docId, rows] of byDoc) {
      out.push({ fromScope, docId, title: rows[0]!.metadata.docTitle ?? null, chunks: rows.length, rows });
    }
  }
  return out;
}

export async function countChatDocsOutsideChatScopes(): Promise<number> {
  return (await findCandidates()).length;
}

export async function quarantineChatDocs(opts: {
  apply: boolean;
  log: (line: string) => void;
}): Promise<{ candidates: Array<Omit<Candidate, 'rows'>>; moved: number; failures: string[] }> {
  const found = await findCandidates();
  const failures: string[] = [];
  let moved = 0;
  for (const c of found) {
    opts.log(`${opts.apply ? 'move' : 'would move'} fromScope=${c.fromScope} docId=${c.docId} title=${JSON.stringify(c.title)} chunks=${c.chunks}`);
    if (!opts.apply) continue;
    // listScopePrefixes returns on-disk (already normalized) names.
    const qDocId = `${c.fromScope}__${c.docId}`;
    const agentId = (c.rows[0]!.metadata.tags ?? []).find((t) => t.startsWith('agent:'))?.slice('agent:'.length);
    try {
      await putDocument(
        QUARANTINE_SCOPE,
        qDocId,
        c.rows.map((r) => ({ ...r, metadata: { ...r.metadata, docId: qDocId, tags: [...(r.metadata.tags ?? []), `from:${c.fromScope}`] } })),
      );
      await writeAuditOrThrow({
        action: 'knowledge_quarantined',
        ...(agentId ? { agentId } : {}),
        // Hashes only, no file or scope name (qDocId embeds it): the audit log is viewer-readable.
        detail: { docId: c.docId, fromScopeHash: scopeHash(c.fromScope), toScopeHash: scopeHash(QUARANTINE_SCOPE), chunks: c.chunks },
        result: 'ok',
      });
      await deleteDocument(c.fromScope, c.docId);
      moved += 1;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`${c.fromScope}/${c.docId}: ${msg}`);
      opts.log(`FAILED fromScope=${c.fromScope} docId=${c.docId}: ${msg} (left in place)`);
    }
  }
  return { candidates: found.map(({ rows: _rows, ...rest }) => rest), moved, failures };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--verify')) {
    const n = await countChatDocsOutsideChatScopes();
    console.log(`chat docs outside chat_ scopes: ${n}`);
    if (n > 0) process.exit(1);
    return;
  }
  const apply = argv.includes('--apply');
  console.log(`${apply ? 'APPLYING' : 'DRY RUN'} via ${process.env.AWS_ENDPOINT_URL ?? 'real AWS'}`);
  const report = await quarantineChatDocs({ apply, log: (l) => console.log(l) });
  console.log(`candidates: ${report.candidates.length}, moved: ${report.moved}, failures: ${report.failures.length}`);
  if (report.failures.length > 0) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
