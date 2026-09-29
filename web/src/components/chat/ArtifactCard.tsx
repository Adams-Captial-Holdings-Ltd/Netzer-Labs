import type { ArtifactRef } from '../../lib/chat/types';
import { getBytes } from '../../lib/api';
import { artifactLabel } from '../../lib/chat/artifacts';
import { toast } from '../Toast';

export async function downloadArtifact(ref: ArtifactRef, agentId: string, chatId: string): Promise<void> {
  try {
    const path = `/artifacts/download?agentId=${encodeURIComponent(agentId)}` +
      `&chatId=${encodeURIComponent(chatId)}&artifactId=${encodeURIComponent(ref.artifactId)}` +
      `&version=${ref.version}`;
    const { url, fileName } = JSON.parse(new TextDecoder().decode(await getBytes(path))) as { url: string; fileName: string };
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
  } catch {
    toast('Could not download that file. Please try again.', 'error');
  }
}

interface ArtifactCardProps {
  artifact: ArtifactRef;
  agentId: string;
  chatId: string;
  onOpenArtifact: (ref: ArtifactRef, opener: HTMLButtonElement) => void;
}

export function ArtifactCard({ artifact, agentId, chatId, onOpenArtifact }: ArtifactCardProps) {
  const label = artifactLabel(artifact.contentType, artifact.fileName);
  return (
    <div data-artifact-card class="flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2">
      <button type="button" aria-label={`Open ${artifact.fileName}`}
        onClick={(event) => onOpenArtifact(artifact, event.currentTarget as HTMLButtonElement)}
        class="flex min-w-0 flex-1 items-center gap-3 text-left text-body-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        <span aria-hidden="true" class="shrink-0 rounded-md bg-surface-elevated px-1.5 py-1 text-overline uppercase tracking-wider text-secondary">
          {label}
        </span>
        <span class="min-w-0 truncate">{artifact.fileName}</span>
      </button>
      <button type="button" aria-label={`Download ${artifact.fileName}`}
        onClick={() => { void downloadArtifact(artifact, agentId, chatId); }}
        class="shrink-0 text-caption text-secondary hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary">
        Download
      </button>
    </div>
  );
}
