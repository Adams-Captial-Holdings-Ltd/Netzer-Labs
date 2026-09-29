export const CHAT_ATTACHMENT_MAX_BYTES = 30 * 1024 * 1024;
export const CHAT_ATTACHMENT_MAX_FILES = 3;

const documents: Record<string, { mime: string; zip: boolean }> = {
  pdf: { mime: 'application/pdf', zip: false },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', zip: true },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', zip: true },
  txt: { mime: 'text/plain', zip: false },
  md: { mime: 'text/markdown', zip: false },
  csv: { mime: 'text/csv', zip: false },
};

export function chatAttachmentFormat(fileName: string, mimeType?: string):
  { kind: 'image' | 'audio' | 'video' | 'document'; mime: string; zip: boolean } | null {
  const extension = fileName.match(/\.([^.]+)$/)?.[1]?.toLowerCase();
  const document = extension ? documents[extension] : undefined;
  if (document) return { kind: 'document', ...document };
  const mime = (mimeType ?? '').toLowerCase();
  if (mime.startsWith('image/')) return { kind: 'image', mime: mimeType!, zip: false };
  if (mime.startsWith('audio/')) return { kind: 'audio', mime: mimeType!, zip: false };
  if (mime.startsWith('video/')) return { kind: 'video', mime: mimeType!, zip: false };
  return null;
}
