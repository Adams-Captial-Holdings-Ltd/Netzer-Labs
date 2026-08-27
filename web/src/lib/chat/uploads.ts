// Attachment staging, moved verbatim from web/src/pages/Chat.tsx send()
// (Phase 0 of the chat UI port — zero behavior change). Browser-only (File,
// global fetch); not imported by any test under src/.

import type { TurnAttachment } from './stream.js';

// Stage each file straight to S3 via a presigned PUT (the JSON body to
// the stream endpoint then carries only small s3Key references, far
// under the WAF 8KB cap).
export async function stageAttachments(
  files: File[],
  token: string,
  onStatus: (status: string) => void,
): Promise<TurnAttachment[]> {
  const attachments: TurnAttachment[] = [];
  for (const f of files) {
    onStatus(`Uploading ${f.name}…`);
    const presign = await fetch('/api/vectors/upload-url', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: f.name }),
    });
    if (!presign.ok) throw new Error('Upload failed');
    const { url, key } = await presign.json();
    const put = await fetch(url, { method: 'PUT', body: f });
    if (!put.ok) throw new Error('Upload failed');
    attachments.push({ s3Key: key, fileName: f.name, ...(f.type ? { mimeType: f.type } : {}) });
  }
  return attachments;
}
