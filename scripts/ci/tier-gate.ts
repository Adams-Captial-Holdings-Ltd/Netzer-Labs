#!/usr/bin/env node
/**
 * Emit the Paperclip tier gate for `.github/workflows/deploy.yml`.
 *
 * The CI driver had four separate `[ "$CCE_TIER" != "0" ]` / `env.CCE_TIER != '0'`
 * conditions (ECR repo, image build, secret populate, migration). They happened
 * to agree with `TierShape.paperclipEnabled` only because Tier 0 is the sole
 * false today; the moment another tier opts out, CI would build and migrate a
 * Paperclip that CDK does not provision. This prints the boolean ONCE, through
 * the same `paperclipProvisioned` predicate `infra/bin/app.ts` deploys from, and
 * every step gates on it. That predicate is the tier OR the environment-scoped
 * CCE_PAPERCLIP_PROVISION_ENV_OVERRIDE, so on staging — pinned to Tier 0 and
 * carrying the override — these steps build the image, populate the secret and
 * migrate, exactly as they must for the environment where the engine is
 * validated.
 *
 * Writes `paperclip_enabled=1|0` to $GITHUB_OUTPUT (stdout when unset, so it is
 * runnable by hand). Reads the tier through clampTier for the same reason
 * app.ts does: a blank CCE_TIER must not read as Hobby.
 */
import { appendFileSync } from 'node:fs';
import { TIERS, clampTier, paperclipProvisioned } from '../../infra/lib/constants.js';

const tier = clampTier(process.env.CCE_TIER ?? process.env.DEPLOY_TIER);
const line = `paperclip_enabled=${paperclipProvisioned(tier) ? '1' : '0'}`;
const out = process.env.GITHUB_OUTPUT;
if (out) appendFileSync(out, `${line}\n`);
// eslint-disable-next-line no-console
console.log(`tier ${tier} (${TIERS[tier].label}): ${line}`);
