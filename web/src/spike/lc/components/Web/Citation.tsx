/* SPIKE SHIM — donor web-search citation components. */
import type { ComponentChildren } from 'preact';
export const Citation = ({ children }: { children?: ComponentChildren }) => <>{children}</>;
export const CompositeCitation = ({ children }: { children?: ComponentChildren }) => <>{children}</>;
export const HighlightedText = ({ children }: { children?: ComponentChildren }) => (
  <mark>{children}</mark>
);
