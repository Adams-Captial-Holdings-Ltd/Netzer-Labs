export const MAX_BYTES = 30 * 1024 * 1024;
export const MAX_FILES = 3;
export const ACCEPT = 'image/*,video/*,audio/*,.pdf,.docx,.pptx,.txt,.md,.csv';

type FileLike = { name: string; size: number; type: string };

export function admitFiles(current: FileLike[], picked: FileLike[]): {
  accepted: FileLike[];
  refused: Array<{ name: string; reason: 'unsupported' | 'too_large' | 'too_many' }>;
} {
  const accepted: FileLike[] = [];
  const refused: Array<{ name: string; reason: 'unsupported' | 'too_large' | 'too_many' }> = [];
  for (const file of picked) {
    const supported = /\.(pdf|docx|pptx|txt|md|csv)$/i.test(file.name) ||
      /^(image|audio|video)\//i.test(file.type);
    if (!supported) refused.push({ name: file.name, reason: 'unsupported' });
    else if (file.size > MAX_BYTES) refused.push({ name: file.name, reason: 'too_large' });
    else if (current.length + accepted.length >= MAX_FILES) refused.push({ name: file.name, reason: 'too_many' });
    else accepted.push(file);
  }
  return { accepted, refused };
}
