import { pathToFileURL } from 'node:url';

export function validateDeploySource({ targetEnv, ref, allowLegacyMain = false }) {
  if (targetEnv === 'staging') {
    const allowed = ref === 'refs/heads/staging';
    return {
      allowed,
      reason: allowed
        ? 'staging source accepted'
        : 'staging deploys require refs/heads/staging',
    };
  }

  if (targetEnv === 'prod') {
    const allowed =
      ref === 'refs/heads/production' ||
      (allowLegacyMain && ref === 'refs/heads/main');
    return {
      allowed,
      reason: allowed
        ? 'production source accepted'
        : 'production deploys require refs/heads/production',
    };
  }

  return {
    allowed: false,
    reason: `unsupported target environment: ${targetEnv || '<empty>'}`,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = validateDeploySource({
    targetEnv: process.env.TARGET_ENV ?? '',
    ref: process.env.GITHUB_REF ?? '',
    allowLegacyMain: process.env.CCE_ALLOW_LEGACY_MAIN === '1',
  });

  console.log(result.reason);
  process.exitCode = result.allowed ? 0 : 1;
}
