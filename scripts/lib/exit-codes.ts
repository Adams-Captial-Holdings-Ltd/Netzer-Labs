/**
 * Cross-command exit-code contract.
 *
 * DEPLOY_EXIT_DECLINED distinguishes "the operator answered No at deploy's
 * money gate" from success (0, resources created) and failure (1, something
 * broke). Deploy used to exit 0 on a decline, which read fine standalone but
 * made the up conductor treat the decline as a finished deploy and run
 * verify against an account where nothing was created. The conductor keys
 * on this code to stop cleanly with decline-shaped copy instead.
 *
 * Lives in its own file because deploy.ts calls main() at module top level
 * (NOT import-safe), so up.ts cannot import the constant from there.
 */
export const DEPLOY_EXIT_DECLINED = 10;
