/* SPIKE SHIM — donor `client/src/Providers` barrel, reduced to the two
 * contexts the markdown pipeline consumes plus the message context Markdown
 * reads for `isSubmitting`. */
import { createContext, useContext, useMemo, useRef } from 'react';
import type { ComponentChildren } from 'preact';

type CodeBlockCtx = {
  getNextIndex: (skip: boolean) => number;
  getNextMermaidIndex: () => number;
  resetCounter: () => void;
};

const CodeBlockContext = createContext<CodeBlockCtx>({
  getNextIndex: () => 0,
  getNextMermaidIndex: () => 0,
  resetCounter: () => undefined,
});

export function CodeBlockProvider({
  children,
  baseIndex = 0,
  mermaidBaseIndex = 0,
}: {
  children: ComponentChildren;
  baseIndex?: number;
  mermaidBaseIndex?: number;
}) {
  const code = useRef(baseIndex);
  const mermaid = useRef(mermaidBaseIndex);
  const value = useMemo<CodeBlockCtx>(
    () => ({
      getNextIndex: (skip: boolean) => (skip ? code.current : code.current++),
      getNextMermaidIndex: () => mermaid.current++,
      resetCounter: () => {
        code.current = baseIndex;
        mermaid.current = mermaidBaseIndex;
      },
    }),
    [baseIndex, mermaidBaseIndex],
  );
  return <CodeBlockContext.Provider value={value}>{children}</CodeBlockContext.Provider>;
}

export const useCodeBlockContext = () => useContext(CodeBlockContext);

const ArtifactContext = createContext<{ baseIndex: number }>({ baseIndex: 0 });
export function ArtifactProvider({
  children,
  baseIndex = 0,
}: {
  children: ComponentChildren;
  baseIndex?: number;
}) {
  const value = useMemo(() => ({ baseIndex }), [baseIndex]);
  return <ArtifactContext.Provider value={value}>{children}</ArtifactContext.Provider>;
}

const MessageContext = createContext<{ isSubmitting: boolean } | null>(null);
export const useMessageContext = () => useContext(MessageContext);
export function MessageProvider({
  children,
  isSubmitting = false,
}: {
  children: ComponentChildren;
  isSubmitting?: boolean;
}) {
  const value = useMemo(() => ({ isSubmitting }), [isSubmitting]);
  return <MessageContext.Provider value={value}>{children}</MessageContext.Provider>;
}
