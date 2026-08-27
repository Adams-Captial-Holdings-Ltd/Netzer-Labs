/*
 * `~/utils` — the donor's own utility barrel, reduced to what the ported tree
 * imports. Aliased as `~` in web/vite.config.ts and web/tsconfig.json, so donor
 * files keep their `import { cn } from '~/utils'` line unmodified.
 *
 * This is deliberately NOT the donor's 90-module `utils/index.ts`. Every export
 * here is backed by a file in this directory that carries its own provenance
 * header; anything a future donor copy reaches for and does not find fails as a
 * compile error naming the missing export, which is the loud failure we want
 * rather than a silent `any`.
 */
export { cn, default as cnDefault } from './cn';
export { getMessageTimestamp, isValidTimestamp } from './messages';
export type { MessageTimestamp } from './messages';
export { systemLocale, localeUsesMeridiem } from './clock';
