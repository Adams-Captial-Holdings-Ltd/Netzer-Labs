/**
 * End-to-end three-corpus retrieval harness. UNTRACKED, temporary.
 *
 * Proves against REAL AWS that one agent asking one question reaches all three
 * corpora it is entitled to: its own scope, 'default', and 'shared'.
 *
 * Deliberately does NOT load .env — that pins AWS_ENDPOINT_URL at the local
 * Floci emulator, which stubs Bedrock and has no embeddings. Every bucket name
 * is passed explicitly and only STAGING resources are touched.
 *
 *   AWS_PROFILE=netzer-process npx tsx e2e-three-corpus.ts
 *   AWS_PROFILE=netzer-process npx tsx e2e-three-corpus.ts --keep
 *
 * The fixture agent gets an agent.yaml and deliberately NO CLAUDE.md. That
 * absence is the defect under test, so before the loader fix this harness must
 * fail to find the own-corpus document — and must do so silently.
 */

const ACCOUNT = '239887088812';
const REGION = 'us-east-1';

process.env.AWS_REGION = REGION;
process.env.CONFIG_BUCKET = `claudeclaw-staging-config-${ACCOUNT}-${REGION}`;
process.env.VECTORS_BUCKET = `claudeclaw-staging-vectors-staging-${ACCOUNT}-${REGION}`;
process.env.VECTORS_STAGING_BUCKET = process.env.VECTORS_BUCKET;
delete process.env.AWS_ENDPOINT_URL;

const RUN = `e2e${Date.now().toString(36)}`;
const AGENT_ID = `${RUN}-agent`;
const OWN_SCOPE = `${RUN}-own`;

/** One unmistakable fact per corpus; the run nonce makes any hit unambiguous. */
const DOCS = [
  {
    label: 'OWN',
    scope: OWN_SCOPE,
    title: `${RUN} own-corpus note`,
    content:
      `The Zarnack calibration constant for the ${RUN} programme is 47.3 millibars. ` +
      `This figure is recorded only in the agent's own private knowledge corpus.`,
  },
  {
    label: 'DEFAULT',
    scope: 'default',
    title: `${RUN} default-corpus note`,
    content:
      `The Zarnack escalation rota for the ${RUN} programme is owned by the Meridian duty desk. ` +
      `This fact is recorded only in the platform default knowledge corpus.`,
  },
  {
    label: 'SHARED',
    scope: 'shared',
    title: `${RUN} shared-corpus note`,
    content:
      `The Zarnack fleet-wide retention window for the ${RUN} programme is 19 days. ` +
      `This figure is recorded only in the shared knowledge corpus.`,
  },
];

const QUESTION =
  `For the ${RUN} Zarnack programme: what is the calibration constant, ` +
  `who owns the escalation rota, and what is the retention window?`;

async function main(): Promise<void> {
  const keep = process.argv.includes('--keep');

  const { S3Client, PutObjectCommand, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
  const { ingestDocument } = await import('../src/lib/vectors/ingest.js');
  const { deleteDocument } = await import('../src/lib/vectors/store.js');
  await import('../src/lib/tools/vector-tools.js'); // side-effect registration
  const { tools } = await import('../src/lib/tools/registry.js');

  const s3 = new S3Client({ region: REGION });
  const configBucket = process.env.CONFIG_BUCKET as string;
  const yamlKey = `agents/${AGENT_ID}/agent.yaml`;

  console.log(`run         : ${RUN}`);
  console.log(`agent       : ${AGENT_ID}`);
  console.log(`own scope   : ${OWN_SCOPE}`);
  console.log(`config bkt  : ${configBucket}`);
  console.log(`vectors bkt : ${process.env.VECTORS_BUCKET}`);
  console.log('');

  const ingested: Array<{ scope: string; docId: string }> = [];

  try {
    await s3.send(
      new PutObjectCommand({
        Bucket: configBucket,
        Key: yamlKey,
        Body: `name: ${AGENT_ID}\nknowledgeScope: ${OWN_SCOPE}\n`,
        ContentType: 'text/yaml; charset=utf-8',
      }),
    );
    console.log(`[fixture] wrote ${yamlKey} — no CLAUDE.md, by design`);

    for (const d of DOCS) {
      const r = await ingestDocument({
        content: d.content,
        scope: d.scope,
        docTitle: d.title,
        source: `${RUN}-harness`,
      });
      ingested.push({ scope: r.scope, docId: r.docId });
      console.log(
        `[ingest ] ${d.label.padEnd(7)} scope=${r.scope} doc=${r.docId} chunks=${r.chunks} failed=${r.failed}`,
      );
    }
    console.log('');

    const out = await tools.invoke(
      's3_vectors_search',
      { query: QUESTION, top_k: 10, min_score: 0.0 },
      { agentId: AGENT_ID, chatId: `owner:${RUN}` },
    );

    console.log('--- s3_vectors_search ---------------------------------------');
    console.log(out.text);
    console.log('-------------------------------------------------------------');
    console.log('');

    const text = String(out.text ?? '');
    const results = DOCS.map((d) => ({
      label: d.label,
      scope: d.scope,
      found: text.includes(d.title) && text.includes(`<${d.scope}>`),
    }));

    for (const r of results) {
      console.log(`  ${r.found ? 'HIT ' : 'MISS'}  ${r.label.padEnd(7)} <${r.scope}>`);
    }
    console.log('');

    const missing = results.filter((r) => !r.found);
    if (missing.length === 0) {
      console.log('RESULT: PASS — all three corpora returned in one search, each cited by scope.');
    } else {
      console.log(`RESULT: FAIL — missing: ${missing.map((m) => m.scope).join(', ')}`);
      console.log(
        out.isError
          ? '        the tool reported isError'
          : '        the tool reported NO error — this is the silent failure mode',
      );
    }
    process.exitCode = missing.length === 0 ? 0 : 1;
  } finally {
    if (keep) {
      console.log('\n[cleanup] --keep given; fixture left in place:');
      console.log(`  s3://${configBucket}/${yamlKey}`);
      for (const i of ingested) console.log(`  scope=${i.scope} doc=${i.docId}`);
    } else {
      console.log('\n[cleanup] removing fixture');
      for (const i of ingested) {
        try {
          await deleteDocument(i.scope, i.docId);
          console.log(`  deleted doc ${i.docId} from ${i.scope}`);
        } catch (e) {
          console.log(`  FAILED deleting ${i.docId} from ${i.scope}: ${(e as Error).message}`);
        }
      }
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: configBucket, Key: yamlKey }));
        console.log(`  deleted ${yamlKey}`);
      } catch (e) {
        console.log(`  FAILED deleting ${yamlKey}: ${(e as Error).message}`);
      }
    }
  }
}

main().catch((e) => {
  console.error('harness error:', e);
  process.exitCode = 1;
});
