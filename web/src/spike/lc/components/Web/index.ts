/* SPIKE SHIM — donor `~/components/Web` barrel. */
import type { Plugin } from 'unified';
export const unicodeCitation: Plugin = () => (tree) => tree;
export * from './Citation';
