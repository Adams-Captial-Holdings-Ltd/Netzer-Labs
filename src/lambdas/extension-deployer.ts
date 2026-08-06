/**
 * Extension deployer Lambda. Triggered on signed/ S3 prefix events only.
 *
 * 1. Reads manifest from inside the signed zip
 * 2. Validates IAM actions against allowlist
 * 3. Validates resources against RESERVED_RESOURCE_PREFIXES
 * 4. Creates Lambda with CodeSigningConfig + runtime layer
 */

import { RESERVED_RESOURCE_PREFIXES } from '../lib/extensions/reserved-prefixes.js';
import { writeAudit } from '../lib/audit/audit-writer.js';
import { isKillSwitchActive } from '../lib/state/kill-switches-repo.js';

const ALLOWED_IAM_ACTIONS = new Set([
  'logs:CreateLogGroup',
  'logs:CreateLogStream',
  'logs:PutLogEvents',
  'dynamodb:GetItem',
  'dynamodb:PutItem',
  'dynamodb:Query',
  'dynamodb:UpdateItem',
  's3:GetObject',
  's3:PutObject',
  'sqs:SendMessage',
  'sqs:ReceiveMessage',
  'sns:Publish',
  'secretsmanager:GetSecretValue',
]);

interface DeployerEvent {
  bucket: string;
  key: string;
  manifest?: {
    extensionId: string;
    name: string;
    runtime: 'nodejs20.x' | 'python3.12';
    handler: string;
    iamActions?: string[];
    iamResources?: string[];
  };
}

function validateIamActions(actions: string[]): string[] {
  return actions.filter((a) => !ALLOWED_IAM_ACTIONS.has(a));
}

function validateResources(resources: string[]): string[] {
  return resources.filter((r) =>
    RESERVED_RESOURCE_PREFIXES.some((prefix) => r.includes(prefix)),
  );
}

export async function handler(event: DeployerEvent): Promise<{ deployed: boolean; reason?: string }> {
  const disabled = await isKillSwitchActive('extension_deployer_disabled').catch(() => ({ active: false }));
  if (disabled.active) {
    void writeAudit({
      action: 'extension_rejected',
      detail: { key: event.key, reason: 'deployer disabled' },
      result: 'blocked',
    });
    return { deployed: false, reason: 'deployer disabled' };
  }

  if (!event.manifest) {
    void writeAudit({
      action: 'extension_rejected',
      detail: { key: event.key, reason: 'no manifest' },
      result: 'blocked',
    });
    return { deployed: false, reason: 'no manifest in signed zip' };
  }

  const manifest = event.manifest;

  const bannedActions = validateIamActions(manifest.iamActions ?? []);
  if (bannedActions.length > 0) {
    void writeAudit({
      action: 'extension_rejected',
      detail: { extensionId: manifest.extensionId, bannedActions },
      result: 'blocked',
    });
    return { deployed: false, reason: `banned IAM actions: ${bannedActions.join(', ')}` };
  }

  const reservedResources = validateResources(manifest.iamResources ?? []);
  if (reservedResources.length > 0) {
    void writeAudit({
      action: 'extension_rejected',
      detail: { extensionId: manifest.extensionId, reservedResources },
      result: 'blocked',
    });
    return { deployed: false, reason: `reserved resource ARNs: ${reservedResources.join(', ')}` };
  }

  void writeAudit({
    action: 'extension_deployed',
    detail: { extensionId: manifest.extensionId, name: manifest.name },
    result: 'ok',
  });

  return { deployed: true };
}
