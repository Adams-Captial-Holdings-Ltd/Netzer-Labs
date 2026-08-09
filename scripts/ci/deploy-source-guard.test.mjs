import test from 'node:test';
import assert from 'node:assert/strict';

import { validateDeploySource } from './deploy-source-guard.mjs';

test('staging accepts only refs/heads/staging', () => {
  assert.equal(
    validateDeploySource({
      targetEnv: 'staging',
      ref: 'refs/heads/staging',
      allowLegacyMain: true,
    }).allowed,
    true,
  );

  for (const ref of [
    'refs/heads/main',
    'refs/heads/development',
    'refs/heads/qa',
    'refs/heads/production',
  ]) {
    assert.equal(
      validateDeploySource({ targetEnv: 'staging', ref, allowLegacyMain: true }).allowed,
      false,
    );
  }
});

test('production accepts production and transitional main only', () => {
  assert.equal(
    validateDeploySource({
      targetEnv: 'prod',
      ref: 'refs/heads/production',
      allowLegacyMain: true,
    }).allowed,
    true,
  );
  assert.equal(
    validateDeploySource({
      targetEnv: 'prod',
      ref: 'refs/heads/main',
      allowLegacyMain: true,
    }).allowed,
    true,
  );
  assert.equal(
    validateDeploySource({
      targetEnv: 'prod',
      ref: 'refs/heads/main',
      allowLegacyMain: false,
    }).allowed,
    false,
  );

  for (const ref of [
    'refs/heads/development',
    'refs/heads/qa',
    'refs/heads/staging',
    'refs/heads/feature/x',
  ]) {
    assert.equal(
      validateDeploySource({ targetEnv: 'prod', ref, allowLegacyMain: true }).allowed,
      false,
    );
  }
});

test('unknown environments fail closed', () => {
  assert.equal(
    validateDeploySource({
      targetEnv: 'production',
      ref: 'refs/heads/production',
      allowLegacyMain: true,
    }).allowed,
    false,
  );
});
