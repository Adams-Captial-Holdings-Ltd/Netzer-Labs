/* SPIKE SHIM — stands in for donor `client/src/utils/index.ts` (1000+ lines).
 * Re-exports only the four donor modules copied verbatim, plus the two tiny
 * helpers MarkdownComponents reaches for. Everything else in the donor barrel
 * is app plumbing the spiked components never touch. */
export { default as cn } from './cn';
export * from './languages';
export * from './latex';
export * from './tilde';
export * from './configHtml';

/** Verbatim from donor `client/src/utils/index.ts` (selects a code token on double click). */
export const handleDoubleClick: React.MouseEventHandler<HTMLElement> = (event) => {
  const range = document.createRange();
  range.selectNodeContents(event.currentTarget);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
};

/** Stub for donor `utils/downloadFile.ts#triggerDownload`. */
export function triggerDownload(target: string, filename: string): void {
  const link = document.createElement('a');
  link.href = target;
  link.download = filename;
  link.click();
}

/** Stub for donor `utils/agents.tsx#getSpecAgentAvatarURL` (resolves an agent
 *  avatar out of the agents map). */
export const getSpecAgentAvatarURL = (_spec: unknown, _agentsMap?: unknown): string | undefined =>
  undefined;
