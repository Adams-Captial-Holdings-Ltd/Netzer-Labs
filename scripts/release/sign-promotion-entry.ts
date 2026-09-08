/**
 * tsx entry for sign-promotion. Separate from sign-promotion.ts so test
 * imports of signPromotion never risk firing a CLI, and release CI has an
 * unambiguous always-runs entry. Mirrors build-release-entry.ts.
 */

import { signPromotionMain } from './sign-promotion.js';

process.exitCode = await signPromotionMain(process.argv.slice(2));
