/** P5 L1 (carried from P4): a downloaded artifact carries its content type's extension. */
import { beforeEach, expect, it, vi } from 'vitest';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import type { GetObjectCommand } from '@aws-sdk/client-s3';
import { createFakeDynamo } from '../../__test-utils__/fake-dynamo.js';

const { ddbSend, scanForExfil, getSignedUrl } = vi.hoisted(() => {
  process.env.TABLE_SESSIONS = 'p5-unit-sessions';
  process.env.CURATED_BUCKET = 'p5-unit-curated';
  return { ddbSend: vi.fn(), scanForExfil: vi.fn(), getSignedUrl: vi.fn() };
});
vi.mock('../state/ddb.js', async (importActual) => {
  const actual = await importActual<typeof import('../state/ddb.js')>();
  return { ...actual, ddb: () => ({ send: ddbSend }) };
});
vi.mock('../safety/exfil-guard.js', async (importActual) => {
  const actual = await importActual<typeof import('../safety/exfil-guard.js')>();
  return { ...actual, scanForExfil };
});
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: (...args: unknown[]) => getSignedUrl(...args),
}));
vi.mock('../state/runtime-config-repo.js', () => ({ getConfig: async () => undefined }));
vi.mock('../../agent/memory-ingest.js', () => ({ ingestEvictedTurns: () => undefined }));
vi.mock('../observability/xray.js', () => ({ captureAwsClient: <T,>(client: T): T => client }));

const OWNER = 'dashboard:user:p5-owner';
const PERSON = { surface: 'dashboard' as const, userId: OWNER, ephemeral: false };
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
let table: ReturnType<typeof createFakeDynamo>;
const spyS3 = () => vi.spyOn(S3Client.prototype, 'send');
let s3Send: ReturnType<typeof spyS3> | undefined;

beforeEach(() => {
  table = createFakeDynamo();
  ddbSend.mockReset();
  ddbSend.mockImplementation((cmd) => table.send(cmd));
  scanForExfil.mockReset();
  scanForExfil.mockImplementation(async (text: string) =>
    ({ blocked: false, matches: [], scannedBytes: text.length, truncated: false }));
  getSignedUrl.mockReset();
  getSignedUrl.mockResolvedValue('https://curated.example/signed?X-Amz-Signature=p5');
  let n = 0;
  s3Send?.mockRestore();
  s3Send = spyS3().mockImplementation(async (cmd: unknown) => {
    if (cmd instanceof PutObjectCommand) return { VersionId: `physical-${++n}` } as never;
    throw new Error('unexpected S3 command in the P5 name test');
  });
});

it('P5 download names end with the extension of their content type', async () => {
  const repo = await import('./artifacts-repo.js');
  expect((repo as { downloadFileName?: unknown }).downloadFileName, 'one naming rule for downloads').toBeTypeOf('function');
  const name = (repo as unknown as { downloadFileName: (fileName: string, contentType: string) => string }).downloadFileName;
  const cases: Array<[string, string, string]> = [
    // L1: the model's title, with no extension, gains the type's own.
    ['Quarterly report', 'text/html', 'Quarterly report.html'],
    ['Revenue chart', 'image/svg+xml', 'Revenue chart.svg'],
    ['Launch deck', PPTX, 'Launch deck.pptx'],
    ['Memo', DOCX, 'Memo.docx'],
    ['Model', XLSX, 'Model.xlsx'],
    ['Report', 'application/pdf', 'Report.pdf'],
    ['Notes', 'text/markdown', 'Notes.md'],
    ['Table', 'text/csv', 'Table.csv'],
    ['Flow', 'text/vnd.mermaid', 'Flow.mmd'],
    ['Data', 'application/json', 'Data.json'],
    ['Feed', 'text/xml', 'Feed.xml'],
    ['Letter', 'application/rtf', 'Letter.rtf'],
    ['Icon', 'image/png', 'Icon.png'],
    ['Photo', 'image/jpeg', 'Photo.jpg'],
    ['Anim', 'image/gif', 'Anim.gif'],
    ['Pic', 'image/webp', 'Pic.webp'],
    ['readme', 'text/plain', 'readme.txt'],
    // A name that already carries a matching extension is left alone, whatever its case.
    ['report.pdf', 'application/pdf', 'report.pdf'],
    ['CHART.SVG', 'image/svg+xml', 'CHART.SVG'],
    ['photo.jpeg', 'image/jpeg', 'photo.jpeg'],
    ['page.htm', 'text/html', 'page.htm'],
    // Plain text is how code arrives; its own extension is kept.
    ['fibonacci.py', 'text/plain', 'fibonacci.py'],
    // A mismatched extension does not decide the type: the real one is appended.
    ['notes.txt', 'text/markdown', 'notes.txt.md'],
    // An unknown type is never guessed at.
    ['odd', 'application/x-unknown', 'odd'],
  ];
  for (const [fileName, contentType, want] of cases) {
    expect(name(fileName, contentType), `${fileName} (${contentType})`).toBe(want);
  }
  const longest = name('a'.repeat(255), 'text/html');
  expect(longest, 'a file name never grows past 255 characters').toHaveLength(255);
  expect(longest.endsWith('.html')).toBe(true);
});

it('P5 presigned downloads carry the extended name', async () => {
  const repo = await import('./artifacts-repo.js');
  const { appendTurns } = await import('../state/sessions-repo.js');
  const chatId = `dashboard:p5-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await appendTurns('main', chatId, [{ role: 'user', text: 'Make a page', ts: 1 }], undefined, PERSON);
  const saved = await repo.saveArtifact({
    agentId: 'main', chatId, ownerId: OWNER, fileName: 'Quarterly report', contentType: 'text/html',
    body: Buffer.from('<p>Q3</p>'), source: { kind: 'grammar', identifier: 'q3' },
  });
  expect(saved.fileName, 'the stored name is unchanged (P4 rows pin storage)').toBe('Quarterly report');

  const url = await repo.presignArtifactDownload({ agentId: 'main', chatId, ownerId: OWNER,
    artifactId: saved.artifactId, version: 1 });
  expect(url).toBe('https://curated.example/signed?X-Amz-Signature=p5');
  expect(getSignedUrl).toHaveBeenCalledOnce();
  const [, command, options] = getSignedUrl.mock.calls[0]! as [unknown, GetObjectCommand, { expiresIn: number }];
  expect(command.input.ResponseContentDisposition).toBe(
    'attachment; filename="Quarterly_report.html"; filename*=UTF-8\'\'Quarterly%20report.html');
  expect(options, 'the link lifetime is unchanged').toEqual({ expiresIn: 300 });
});
