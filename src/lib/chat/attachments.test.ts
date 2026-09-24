/**
 * P3 (step 5) — the chat attachment format table and its limits.
 *
 * Written BEFORE the change, as the bar (netzar-chat-plan/p3-proof.sh rows F-1, F-2,
 * W-1, W-2).
 *
 * One table decides which chat files are accepted — the composer's own `accept` list
 * (web/src/components/chat/Composer.tsx), enforced on the server too, where today
 * nothing checks a type at all — and which of them are ZIP containers that must pass
 * the bounded ZIP check before anything reads them (WI-3.2). One ceiling holds every
 * chat file: 30 MB (owner decision 29, "a 30 MB file survives end to end"), three
 * files a message (the existing cap, which stops being a silent drop — UPL-01).
 *
 * The browser keeps its own copy of the numbers, because web/ is a separate build
 * that cannot import src/. The last test pins the copy to the original, so the two
 * cannot drift apart unnoticed.
 */

import { describe, it, expect } from 'vitest';
import {
  CHAT_ATTACHMENT_MAX_BYTES,
  CHAT_ATTACHMENT_MAX_FILES,
  chatAttachmentFormat,
} from './attachments.js';
import { MAX_BYTES, MAX_FILES, admitFiles } from '../../../web/src/lib/chat/attachment-rules.js';

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const MB = 1024 * 1024;

describe('chat attachments (P3) — the format table', () => {
  it('accepts exactly the chat file types the composer offers', () => {
    const accepted: Array<[string, string]> = [
      ['a.png', 'image/png'],
      ['b.jpg', 'image/jpeg'],
      ['c.gif', 'image/gif'],
      ['d.webp', 'image/webp'],
      ['e.heic', 'image/heic'],
      ['v.mp4', 'video/mp4'],
      ['n.m4a', 'audio/mp4'],
      ['r.pdf', 'application/pdf'],
      ['w.docx', DOCX],
      ['s.pptx', PPTX],
      ['t.txt', 'text/plain'],
      ['m.md', 'text/markdown'],
      // Browsers often report no type at all for Markdown and CSV: the name decides.
      ['m2.md', ''],
      ['c.csv', 'text/csv'],
    ];
    for (const [name, type] of accepted) {
      expect(chatAttachmentFormat(name, type), `${name} should be accepted`).not.toBeNull();
    }

    const refused: Array<[string, string]> = [
      ['tool.exe', 'application/x-msdownload'],
      ['bundle.zip', 'application/zip'],
      ['page.html', 'text/html'],
      ['sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['script.js', 'text/javascript'],
      ['blob', 'application/octet-stream'],
      // A document is known by its name; a type string alone does not make one.
      ['renamed.bin', 'application/pdf'],
    ];
    for (const [name, type] of refused) {
      expect(chatAttachmentFormat(name, type), `${name} should be refused`).toBeNull();
    }

    // The two Office formats are ZIP containers, so they pass the bounded ZIP check
    // before anything opens them; nothing else is one.
    expect(chatAttachmentFormat('w.docx', DOCX)).toMatchObject({ kind: 'document', zip: true });
    expect(chatAttachmentFormat('s.pptx', PPTX)).toMatchObject({ kind: 'document', zip: true });
    expect(chatAttachmentFormat('r.pdf', 'application/pdf')).toMatchObject({ kind: 'document', zip: false });
    expect(chatAttachmentFormat('a.png', 'image/png')).toMatchObject({ kind: 'image', zip: false });
  });

  it('holds every chat file to one 30 MB ceiling and three files a message', () => {
    expect(CHAT_ATTACHMENT_MAX_BYTES).toBe(30 * MB);
    expect(CHAT_ATTACHMENT_MAX_FILES).toBe(3);
  });
});

describe('chat attachments (P3) — what the browser admits', () => {
  const file = (name: string, size: number, type: string) => ({ name, size, type });

  it('refuses a fourth file and a file over 30 MB before uploading, and names each one', () => {
    const current = [file('one.pdf', 10, 'application/pdf'), file('two.pdf', 10, 'application/pdf')];
    const picked = [
      file('three.pdf', 10, 'application/pdf'),
      file('huge.pdf', 30 * MB + 1, 'application/pdf'),
      file('four.txt', 10, 'text/plain'),
      file('tool.exe', 10, 'application/x-msdownload'),
    ];

    const { accepted, refused } = admitFiles(current, picked);

    expect(accepted.map((f) => f.name)).toEqual(['three.pdf']);
    // Nothing is dropped in silence: every file that did not make it is named, with
    // the reason the composer shows.
    expect(refused).toEqual([
      { name: 'huge.pdf', reason: 'too_large' },
      { name: 'four.txt', reason: 'too_many' },
      { name: 'tool.exe', reason: 'unsupported' },
    ]);
    // A file of exactly 30 MB is inside the ceiling, not over it.
    expect(admitFiles([], [file('edge.pdf', 30 * MB, 'application/pdf')]).accepted).toHaveLength(1);
  });

  it('keeps the browser limits equal to the server limits', () => {
    expect(MAX_BYTES).toBe(CHAT_ATTACHMENT_MAX_BYTES);
    expect(MAX_FILES).toBe(CHAT_ATTACHMENT_MAX_FILES);
    // And the same verdict on the type of every sample: the browser refuses exactly
    // what the server's table refuses.
    const samples: Array<[string, string]> = [
      ['a.png', 'image/png'], ['e.heic', 'image/heic'], ['v.mp4', 'video/mp4'], ['n.m4a', 'audio/mp4'],
      ['r.pdf', 'application/pdf'], ['w.docx', DOCX], ['s.pptx', PPTX], ['t.txt', 'text/plain'],
      ['m.md', ''], ['c.csv', 'text/csv'], ['tool.exe', 'application/x-msdownload'],
      ['bundle.zip', 'application/zip'], ['page.html', 'text/html'], ['renamed.bin', 'application/pdf'],
    ];
    for (const [name, type] of samples) {
      const browserRefuses = admitFiles([], [file(name, 10, type)]).refused.some((r) => r.reason === 'unsupported');
      expect(browserRefuses, name).toBe(chatAttachmentFormat(name, type) === null);
    }
  });
});
