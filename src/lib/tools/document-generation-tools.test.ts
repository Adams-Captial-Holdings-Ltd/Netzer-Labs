/**
 * Regression cover for the document delivery defect.
 *
 * generate_document used to return its presigned URL ONLY as text. That text
 * goes into the model's context and the model reproduces it in its own reply,
 * and a signed S3 URL does not survive that round trip — an observed
 * production .xlsx link arrived with the entire X-Amz-* query string missing
 * and returned AccessDenied against a BlockPublicAccess.BLOCK_ALL bucket.
 *
 * generate_image never had this problem because it also returns media[], which
 * each surface delivers from without the URL passing through the model. These
 * tests pin documents to that same contract.
 */

import { describe, it, expect } from 'vitest';
import { buildDocumentResult, documentFileName } from './document-generation-tools.js';

const URL_WITH_SIGNATURE =
  'https://claudeclaw-raw-1.s3.us-east-1.amazonaws.com/generations/dashboard_1/x.xlsx' +
  '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeef';

function result(overrides: Partial<Parameters<typeof buildDocumentResult>[0]> = {}) {
  return buildDocumentResult({
    format: 'xlsx',
    fileName: 'revenue_forecast.xlsx',
    bytes: 18442,
    bucket: 'claudeclaw-raw-1',
    key: 'generations/dashboard_1/x.xlsx',
    url: URL_WITH_SIGNATURE,
    ...overrides,
  });
}

describe('buildDocumentResult', () => {
  it('returns the document on the media channel, not only as text', () => {
    const r = result();
    expect(r.media).toHaveLength(1);
    expect(r.media?.[0]).toMatchObject({
      kind: 'artifact',
      s3Bucket: 'claudeclaw-raw-1',
      s3Key: 'generations/dashboard_1/x.xlsx',
      presignedUrl: URL_WITH_SIGNATURE,
    });
  });

  it('tags media as artifact, never image, so surfaces do not send a spreadsheet as a photo', () => {
    // Telegram's sendPhoto hardcodes filename 'image.png' and dashboard chat
    // renders media as <img>. A document delivered under kind:'image' would
    // break both.
    expect(result({ format: 'pdf' }).media?.[0]?.kind).toBe('artifact');
    expect(result({ format: 'docx' }).media?.[0]?.kind).toBe('artifact');
  });

  it('carries the correct content type per format', () => {
    expect(result({ format: 'pdf' }).media?.[0]?.contentType).toBe('application/pdf');
    expect(result({ format: 'xlsx' }).media?.[0]?.contentType).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(result({ format: 'docx' }).media?.[0]?.contentType).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });

  it('captions the media with the filename so a surface can name the download', () => {
    expect(result().media?.[0]?.caption).toBe('revenue_forecast.xlsx');
  });

  it('keeps the URL in the text as a fallback', () => {
    // Deliberate, not an oversight: Telegram and Slack have no document
    // delivery path yet (no sendDocument helper exists on either), so the text
    // URL is still their only link. Removing it here would regress both
    // surfaces to no link at all. Drop it once bot delivery lands.
    expect(result().text).toContain(URL_WITH_SIGNATURE);
  });

  it('names the file and its size in the text so the model can refer to it later', () => {
    const text = result().text;
    expect(text).toContain('revenue_forecast.xlsx');
    expect(text).toContain('18,442');
  });

  it('is not an error result', () => {
    expect(result().isError).toBeUndefined();
  });
});

describe('documentFileName', () => {
  it('uses the spec title', () => {
    expect(documentFileName({ title: 'Revenue Forecast' }, 'xlsx')).toBe('Revenue_Forecast.xlsx');
  });

  it('falls back when the title is missing, blank, or not a string', () => {
    expect(documentFileName({}, 'pdf')).toBe('document.pdf');
    expect(documentFileName({ title: '   ' }, 'pdf')).toBe('document.pdf');
    expect(documentFileName({ title: 42 }, 'pdf')).toBe('document.pdf');
    expect(documentFileName(null, 'pdf')).toBe('document.pdf');
    expect(documentFileName(undefined, 'docx')).toBe('document.docx');
  });

  it('falls back when the title sanitizes down to nothing', () => {
    expect(documentFileName({ title: '///' }, 'pdf')).toBe('document.pdf');
  });

  it('strips path separators and traversal so the name cannot escape a directory', () => {
    // This name reaches a Content-Disposition header and an upload filename.
    expect(documentFileName({ title: '../../etc/passwd' }, 'pdf')).toBe('.._.._etc_passwd.pdf');
    expect(documentFileName({ title: 'a/b\\c' }, 'pdf')).toBe('a_b_c.pdf');
  });

  it('caps length so a long title cannot bloat a header', () => {
    const name = documentFileName({ title: 'x'.repeat(500) }, 'xlsx');
    expect(name).toBe(`${'x'.repeat(80)}.xlsx`);
  });
});
