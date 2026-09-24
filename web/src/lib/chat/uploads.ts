// Browser-only upload staging. The signed PUT must use exactly the Content-Type
// returned by the chat upload route; S3 rejects a different value.

export interface SignedUpload {
  url: string;
  key: string;
  id: string;
  headers: { 'Content-Type': string };
}

export interface StagedFile {
  localId: number;
  file: File;
  status: 'uploading' | 'ready' | 'failed';
  progress: number;
  signed?: SignedUpload;
  error?: string;
  addToKnowledge: boolean;
}

export async function stageAttachment(
  file: File,
  token: string,
  onProgress: (percent: number) => void,
): Promise<SignedUpload> {
  const presign = await fetch('/api/chat/uploads', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: file.name, mimeType: file.type, size: file.size }),
  });
  if (!presign.ok) {
    const body = await presign.json().catch(() => ({})) as { error?: string };
    const words: Record<string, string> = {
      file_too_large: 'File exceeds the 30 MB limit.',
      unsupported_type: 'This file cannot be attached.',
      invalid_upload: 'This file cannot be uploaded.',
    };
    throw new Error(words[body.error ?? ''] ?? 'Upload failed. Please try again.');
  }
  const signed = await presign.json() as SignedUpload;
  await new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('PUT', signed.url);
    request.setRequestHeader('Content-Type', signed.headers['Content-Type']);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(99, Math.round(event.loaded / event.total * 100)));
      }
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new Error('Upload failed. Please try again.'));
    };
    request.onerror = () => reject(new Error('Upload failed. Please try again.'));
    request.send(file);
  });
  return signed;
}
