/* SPIKE SHIM — donor Artifact renderer + its remark directive plugin
 * (the real one is the whole artifacts sandbox: Sandpack, monaco, recoil). */
import type { Plugin } from 'unified';
import type { ComponentChildren } from 'preact';
export const artifactPlugin: Plugin = () => (tree) => tree;
export const Artifact = ({ children }: { children?: ComponentChildren }) => <>{children}</>;
