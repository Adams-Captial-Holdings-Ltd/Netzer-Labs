/* SPIKE SHIM — donor CodeBlock (171 lines) pulls FloatingCodeBar, CodeBar,
 * ResultSwitcher, LogContent and the tool-calls map context: four more files
 * and a react-query surface. Rendering the fence is enough to prove the
 * markdown pipeline reaches the `code` component with the right props. */
import type { ComponentChildren } from 'preact';

export default function CodeBlock({
  lang,
  codeChildren,
  classProp = '',
}: {
  lang: string;
  codeChildren: ComponentChildren;
  blockIndex?: number;
  allowExecution?: boolean;
  classProp?: string;
}) {
  return (
    <div className="my-2 overflow-hidden rounded-lg border border-border-light bg-surface-secondary">
      <div className="px-3 py-1 font-mono text-xs text-text-secondary">{lang}</div>
      <pre className={`overflow-x-auto px-3 pb-3 text-sm ${classProp}`}>
        <code>{codeChildren}</code>
      </pre>
    </div>
  );
}
