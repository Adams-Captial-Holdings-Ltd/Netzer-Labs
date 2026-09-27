// DOM-free artifact descriptors and preview document builders. This module is
// imported by tests under src/, so relative imports stay `.js`-suffixed.

import type { ArtifactRef } from './types.js';

/** Keep only the fields the server's safeArtifactDescriptor permits. */
export function parseArtifactRef(value: unknown): ArtifactRef | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (typeof row.artifactId !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.artifactId) ||
      !Number.isInteger(row.version) || (row.version as number) < 1 ||
      typeof row.fileName !== 'string' || row.fileName.length < 1 || row.fileName.length > 255 ||
      /[/\\\u0000-\u001f\u007f]/.test(row.fileName) ||
      typeof row.contentType !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(row.contentType) ||
      typeof row.createdAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(row.createdAt) ||
      !Number.isFinite(Date.parse(row.createdAt))) return null;
  return {
    artifactId: row.artifactId,
    version: row.version as number,
    fileName: row.fileName,
    contentType: row.contentType,
    createdAt: row.createdAt,
  };
}

export type PreviewKind = 'html' | 'svg' | 'image' | 'pdf' | 'markdown' | 'code' | 'csv' | 'mermaid' | 'outline' | 'fallback';

export function previewKind(contentType: string, head: Uint8Array): PreviewKind {
  switch (contentType) {
    case 'text/html': return 'html';
    case 'image/svg+xml':
      return /<svg[\s>]/i.test(new TextDecoder().decode(head.subarray(0, 1024))) ? 'svg' : 'fallback';
    case 'image/png':
      return head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47 &&
        head[4] === 0x0d && head[5] === 0x0a && head[6] === 0x1a && head[7] === 0x0a ? 'image' : 'fallback';
    case 'image/jpeg':
      return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff ? 'image' : 'fallback';
    case 'image/gif':
      return head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38 &&
        (head[4] === 0x37 || head[4] === 0x39) && head[5] === 0x61 ? 'image' : 'fallback';
    case 'image/webp':
      return head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46 &&
        head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50 ? 'image' : 'fallback';
    case 'application/pdf':
      return head[0] === 0x25 && head[1] === 0x50 && head[2] === 0x44 && head[3] === 0x46 && head[4] === 0x2d ? 'pdf' : 'fallback';
    case 'text/markdown': return 'markdown';
    case 'text/plain':
    case 'application/json':
    case 'text/xml': return 'code';
    case 'text/csv': return 'csv';
    case 'text/vnd.mermaid': return 'mermaid';
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation': return 'outline';
    default: return 'fallback';
  }
}

export const SANDBOX_CSP = "default-src 'none'; script-src 'unsafe-inline' https://cdn.jsdelivr.net/npm/ https://cdnjs.cloudflare.com/ajax/libs/; style-src 'unsafe-inline' https://cdn.jsdelivr.net/npm/ https://cdnjs.cloudflare.com/ajax/libs/; font-src data: https://cdn.jsdelivr.net/npm/ https://cdnjs.cloudflare.com/ajax/libs/; img-src data: blob:; media-src data: blob:; connect-src 'none'; form-action 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; manifest-src 'none'";

const GUARD = "(function(){try{var n=window.navigation;if(n&&typeof n.addEventListener==='function'){n.addEventListener('navigate',function(e){if(e.cancelable&&!(e.destination&&e.destination.sameDocument)){e.preventDefault();}});}}catch(x){}['RTCPeerConnection','webkitRTCPeerConnection','RTCDataChannel','RTCSessionDescription','RTCIceCandidate'].forEach(function(k){try{Object.defineProperty(window,k,{value:undefined,writable:false,configurable:false});}catch(x){}});})();";

export function buildSandboxDocument(html: string): string {
  return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta http-equiv="Content-Security-Policy" content="' + SANDBOX_CSP + '">' +
    '<meta http-equiv="x-dns-prefetch-control" content="off">' +
    '<meta name="referrer" content="no-referrer">' +
    '<script>' + GUARD + '</script>' + html;
}

export const MERMAID_SRC = 'https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.min.js';
export const MERMAID_INTEGRITY = 'sha384-EOXBFmc3gx5mb+vn0vPvvGqACToJD24hhacX5Yx+8NUUQrHIle/Qi5Bg9o3zKwW2';

function escapeHtml(source: string): string {
  return source.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function buildMermaidDocument(source: string): string {
  return '<style>body{margin:0;padding:16px;font:14px system-ui,sans-serif;background:#fff;color:#111}#source{white-space:pre-wrap;margin:0}</style>' +
    '<pre id="source">' + escapeHtml(source) + '</pre><div id="diagram"></div>' +
    '<script src="' + MERMAID_SRC + '" integrity="' + MERMAID_INTEGRITY + '" crossorigin="anonymous"></script>' +
    "<script>(async function(){try{if(!window.mermaid)return;mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });var s=document.getElementById('source');var r=await mermaid.render('netzar-diagram',s.textContent);document.getElementById('diagram').innerHTML=r.svg;s.hidden=true;}catch(x){}})();</script>";
}

/** Parse CSV into plain text cells, stopping once one row beyond the cap is known. */
export function parseCsv(text: string, maxRows: number): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  if (text === '') return { rows, truncated: false };
  const limit = Math.max(0, Math.floor(maxRows));
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let atFieldStart = true;

  const finishRow = (): boolean => {
    row.push(field);
    if (rows.length >= limit) return false;
    rows.push(row);
    row = [];
    field = '';
    atFieldStart = true;
    return true;
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"' && atFieldStart) {
      quoted = true;
      atFieldStart = false;
    } else if (c === ',') {
      row.push(field);
      field = '';
      atFieldStart = true;
    } else if (c === '\r' || c === '\n') {
      if (!finishRow()) return { rows, truncated: true };
      if (c === '\r' && text[i + 1] === '\n') i++;
    } else {
      field += c;
      atFieldStart = false;
    }
  }
  if (row.length > 0 || field !== '' || !/[\r\n]$/.test(text)) {
    if (!finishRow()) return { rows, truncated: true };
  }
  return { rows, truncated: false };
}
