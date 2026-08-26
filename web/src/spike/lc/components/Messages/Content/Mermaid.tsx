/* SPIKE SHIM — donor Mermaid lazy-loads the `mermaid` package (~600 kB). */
import type { ComponentChildren } from 'preact';

export default function Mermaid({ children }: { id?: string; children: ComponentChildren }) {
  return <pre className="my-2 rounded-lg bg-surface-secondary p-3 text-xs">{children}</pre>;
}

export function MermaidErrorBoundary({ children }: { code?: string; children: ComponentChildren }) {
  return <>{children}</>;
}
