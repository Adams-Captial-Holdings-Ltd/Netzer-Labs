/**
 * Unit tests for the cloud-build pure core (Docker-free installs).
 * Names, buildspec content, IAM policy scoping, and status classification.
 * No I/O; the orchestrator's AWS CLI calls are exercised in real deploys.
 */

import { describe, expect, it } from 'vitest';
import {
  buildSucceeded,
  cloudBuildBuildSpec,
  cloudBuildNames,
  cloudBuildRolePolicy,
  cloudBuildTrustPolicy,
  isBuildInProgress,
} from './cloud-build.js';

const POLICY_INPUT = {
  region: 'us-east-1',
  accountId: '123456789012',
  ecrRepoName: 'claudeclaw-orchestrator',
  stateBucket: 'claudeclaw-deploy-123456789012-us-east-1',
};

describe('cloudBuildNames', () => {
  it('derives deterministic, suffix-aware names from the ECR repo name', () => {
    const n = cloudBuildNames('claudeclaw-staging-orchestrator');
    expect(n.project).toBe('claudeclaw-staging-orchestrator-cloud-build');
    expect(n.role).toBe('claudeclaw-staging-orchestrator-cloud-build-role');
    expect(n.logGroup).toBe('/aws/codebuild/claudeclaw-staging-orchestrator-cloud-build');
    expect(n.s3Prefix).toBe('cloud-build/');
  });
});

describe('cloudBuildBuildSpec', () => {
  const spec = cloudBuildBuildSpec();

  it('logs in to ECR, builds, and pushes both the tag and latest', () => {
    expect(spec).toContain('get-login-password');
    expect(spec).toContain('docker build --build-arg DEPLOY_TIER=');
    expect(spec).toContain('docker push "$ECR_HOST/$ECR_REPO_NAME:$IMAGE_TAG"');
    expect(spec).toContain(':latest"');
  });

  it('self-verifies arm64 INSIDE the build (the item-9 gate moves into CodeBuild)', () => {
    expect(spec).toContain("docker inspect --format '{{.Architecture}}'");
    expect(spec).toContain('test "$ARCH" = "arm64"');
  });

  it('never bakes account-specific values; everything rides env vars', () => {
    expect(spec).not.toMatch(/[0-9]{12}/);
    expect(spec).toContain('$ECR_HOST');
    expect(spec).toContain('$IMAGE_TAG');
  });
});

describe('cloudBuildRolePolicy', () => {
  const policy = JSON.parse(cloudBuildRolePolicy(POLICY_INPUT)) as {
    Statement: Array<{ Sid: string; Action: string | string[]; Resource: string | string[] }>;
  };

  it('scopes ECR push to exactly the one repository', () => {
    const push = policy.Statement.find((s) => s.Sid === 'EcrPush');
    expect(push?.Resource).toBe(
      'arn:aws:ecr:us-east-1:123456789012:repository/claudeclaw-orchestrator',
    );
  });

  it('scopes S3 read to the cloud-build/ prefix of the state bucket only', () => {
    const s3 = policy.Statement.find((s) => s.Sid === 'SourceZip');
    expect(s3?.Resource).toBe(
      'arn:aws:s3:::claudeclaw-deploy-123456789012-us-east-1/cloud-build/*',
    );
  });

  it('scopes logs to the project log group only', () => {
    const logs = policy.Statement.find((s) => s.Sid === 'Logs');
    expect(JSON.stringify(logs?.Resource)).toContain(
      '/aws/codebuild/claudeclaw-orchestrator-cloud-build',
    );
  });

  it('grants no iam, no cloudformation, no wildcard-resource mutations', () => {
    const wildcards = policy.Statement.filter((s) => s.Resource === '*');
    expect(wildcards).toHaveLength(1);
    expect(wildcards[0].Sid).toBe('EcrAuth');
    const actions = policy.Statement.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action]));
    expect(actions.some((a) => a.startsWith('iam:'))).toBe(false);
    expect(actions.some((a) => a.startsWith('cloudformation:'))).toBe(false);
  });
});

describe('trust policy and status classification', () => {
  it('trusts only codebuild.amazonaws.com', () => {
    const trust = JSON.parse(cloudBuildTrustPolicy()) as {
      Statement: Array<{ Principal: { Service: string } }>;
    };
    expect(trust.Statement).toHaveLength(1);
    expect(trust.Statement[0].Principal.Service).toBe('codebuild.amazonaws.com');
  });

  it('classifies build statuses', () => {
    expect(isBuildInProgress('IN_PROGRESS')).toBe(true);
    expect(isBuildInProgress('SUCCEEDED')).toBe(false);
    expect(buildSucceeded('SUCCEEDED')).toBe(true);
    for (const s of ['FAILED', 'FAULT', 'STOPPED', 'TIMED_OUT']) {
      expect(buildSucceeded(s)).toBe(false);
      expect(isBuildInProgress(s)).toBe(false);
    }
  });
});
