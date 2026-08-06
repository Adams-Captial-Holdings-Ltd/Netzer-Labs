import { Stack, CfnOutput, Duration } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { CfnWebACL, CfnWebACLAssociation } from 'aws-cdk-lib/aws-wafv2';
import { CfnDetector as GuardDutyDetector } from 'aws-cdk-lib/aws-guardduty';
import { ManagedRule, ManagedRuleIdentifiers } from 'aws-cdk-lib/aws-config';
import { Rule } from 'aws-cdk-lib/aws-events';
import { SnsTopic } from 'aws-cdk-lib/aws-events-targets';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import type { IBucket } from 'aws-cdk-lib/aws-s3';
import {
  Distribution,
  HttpVersion,
  OriginProtocolPolicy,
  ViewerProtocolPolicy,
  AllowedMethods,
  CachedMethods,
  CachePolicy,
  OriginRequestPolicy,
  PriceClass,
  ResponseHeadersPolicy,
  SecurityPolicyProtocol,
  LambdaEdgeEventType,
  experimental,
  type EdgeLambda,
} from 'aws-cdk-lib/aws-cloudfront';
import { Runtime as LambdaRuntime, Code as LambdaCode } from 'aws-cdk-lib/aws-lambda';
import { HttpOrigin } from 'aws-cdk-lib/aws-cloudfront-origins';
import { Certificate, CertificateValidation } from 'aws-cdk-lib/aws-certificatemanager';
import { HostedZone } from 'aws-cdk-lib/aws-route53';
import { APP, TAGS, TIERS } from './constants.js';
import {
  cloudFrontOriginSecret,
  ORIGIN_HEADER_NAME,
} from './cf-origin-secret.js';
import type { BaseStackProps } from './interfaces.js';

export interface SecurityStackProps extends BaseStackProps {
  /** ARN of the ALB to associate the web ACL with. Empty string means
   * the WAF is provisioned but unattached (T0/T1 fallback). */
  albArn?: string;
  /** SNS topic ops alerts go to. Optional — when absent, B2 GuardDuty
   * findings still go to CloudWatch Events history but no email/page. */
  alertTopic?: ITopic;
  /** S3 bucket the AWS Config delivery channel writes snapshots to.
   * Required at T3 for B2. */
  logsBucket?: IBucket;
  /**
   * Power-panel URL (the pause/wake Lambda's Function URL). When set, a
   * CloudFront viewer-response function 302s browser page loads to it while
   * the origin is dark (502/503/504), so a paused stack routes people to the
   * one control surface that still works instead of an opaque error page.
   * Webhook + API + health paths are excluded (they need the raw 5xx).
   */
  powerPanelUrl?: string;
}

/**
 * WAFv2 web ACL for the ALB. Only provisioned when tier.wafEnabled is true.
 *
 * Rules (regional scope):
 *   - AWS managed Core Rule Set (OWASP top 10 coverage)
 *   - AWS managed Known Bad Inputs
 *   - AWS managed Anonymous IP List (drop TOR / VPN abuse)
 *   - Rate-based rule: 2000 requests per 5-min window per source IP
 *
 * The Bedrock-side guardrail handles content safety inside the request;
 * WAF handles abuse at the edge so we don't pay Bedrock for traffic
 * that's obviously hostile.
 */
export class SecurityStack extends Stack {
  public readonly webAclArn?: string;

  constructor(scope: Construct, id: string, props: SecurityStackProps) {
    super(scope, id, props);
    Object.entries(TAGS).forEach(([k, v]) => this.tags.setTag(k, v));

    const tier = TIERS[props.tier];
    if (!tier.wafEnabled) {
      // No-op stack for T0/T1; keeps the dependency graph stable.
      return;
    }

    const webAcl = new CfnWebACL(this, 'WebAcl', {
      name: `${APP}-web-acl`,
      description: 'ClaudeClaw orchestrator edge WAF',
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `${APP}-web-acl`,
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'RateLimit',
          priority: 0,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 2000,
              aggregateKeyType: 'IP',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'rate-limit',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'AwsCommonRules',
          priority: 10,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
              scopeDownStatement: {
                notStatement: {
                  statement: {
                    orStatement: {
                      statements: [
                        {
                          byteMatchStatement: {
                            searchString: '/tg/',
                            fieldToMatch: { uriPath: {} },
                            positionalConstraint: 'STARTS_WITH',
                            textTransformations: [{ priority: 0, type: 'NONE' }],
                          },
                        },
                        {
                          byteMatchStatement: {
                            searchString: '/slack/',
                            fieldToMatch: { uriPath: {} },
                            positionalConstraint: 'STARTS_WITH',
                            textTransformations: [{ priority: 0, type: 'NONE' }],
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'aws-common-rules',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'AwsKnownBadInputs',
          priority: 20,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'aws-known-bad-inputs',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'AwsAnonymousIpList',
          priority: 30,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesAnonymousIpList',
              // Exclude paths that receive traffic from data-center IPs:
              // /health (GitHub Actions), /status (public), /tg/ and
              // /slack/ (Telegram + Slack webhook servers).
              scopeDownStatement: {
                notStatement: {
                  statement: {
                    orStatement: {
                      statements: [
                        {
                          byteMatchStatement: {
                            searchString: '/health',
                            fieldToMatch: { uriPath: {} },
                            positionalConstraint: 'EXACTLY',
                            textTransformations: [{ priority: 0, type: 'NONE' }],
                          },
                        },
                        {
                          byteMatchStatement: {
                            searchString: '/status',
                            fieldToMatch: { uriPath: {} },
                            positionalConstraint: 'STARTS_WITH',
                            textTransformations: [{ priority: 0, type: 'NONE' }],
                          },
                        },
                        {
                          byteMatchStatement: {
                            searchString: '/tg/',
                            fieldToMatch: { uriPath: {} },
                            positionalConstraint: 'STARTS_WITH',
                            textTransformations: [{ priority: 0, type: 'NONE' }],
                          },
                        },
                        {
                          byteMatchStatement: {
                            searchString: '/slack/',
                            fieldToMatch: { uriPath: {} },
                            positionalConstraint: 'STARTS_WITH',
                            textTransformations: [{ priority: 0, type: 'NONE' }],
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'aws-anonymous-ip-list',
            sampledRequestsEnabled: true,
          },
        },
      ],
    });
    this.webAclArn = webAcl.attrArn;

    if (props.albArn) {
      new CfnWebACLAssociation(this, 'WebAclAssoc', {
        resourceArn: props.albArn,
        webAclArn: webAcl.attrArn,
      });
    }

    new CfnOutput(this, 'WebAclArn', { value: webAcl.attrArn });

    // ── CloudFront (T3 only) ────────────────────────────────────
    // Distribution in front of the ALB. Origin uses the
    // `origin.<apex>` alias provisioned by compute-stack so the SSL
    // hostname matches the ALB cert. The user-facing apex Route 53
    // record stays on the ALB so the deploy doesn't flip DNS by
    // surprise — the operator changes the apex alias to point at
    // CloudFront when they're ready to cut over.
    //
    // Origin custom header `X-CloudFront-Origin` is sent on every
    // origin request. ALB-side enforcement (reject requests without
    // the header) is a follow-up; today this is a "make casual
    // ALB-DNS bypass slightly harder" mitigation, not a real security
    // boundary. The bearer auth on /api/* is the real boundary.
    if (!tier.cloudFrontEnabled) return;
    const domainName = process.env.DOMAIN_NAME ?? '';
    if (!domainName) {
      // No domain configured -> nothing to alias. Skip CloudFront.
      return;
    }
    const originHost = `origin.${domainName}`;
    // B1: deterministic secret value, shared with the ALB listener rule
    // in compute-stack so direct ALB DNS hits without the header get 403.
    const cfOriginSecret = cloudFrontOriginSecret(this.account, this.region);

    // ACM cert for CloudFront viewer. MUST be in us-east-1; since the
    // app deploys there, we issue it from this stack.
    const apex = domainName.split('.').slice(-2).join('.');
    const hostedZone = HostedZone.fromLookup(this, 'HostedZoneCf', {
      domainName: apex,
    });
    const cfCert = new Certificate(this, 'CloudFrontCert', {
      domainName,
      validation: CertificateValidation.fromDns(hostedZone),
    });

    // ── B4 · CloudFront WAF (CLOUDFRONT scope) ──────────────────
    // Second WebACL with scope=CLOUDFRONT. Edge drops are faster and
    // cheaper than regional WAF drops on the ALB, so this rule set
    // mirrors the regional one and fires before the ALB even sees
    // the request. CLOUDFRONT scope ACLs MUST live in us-east-1 —
    // this stack already does, so no cross-region machinery needed.
    //
    // The regional WAF on the ALB stays in place: it's still a
    // boundary if traffic ever bypasses CloudFront (e.g., direct
    // origin.<apex> probes that somehow get past the B1 header gate).
    const cfWebAcl = new CfnWebACL(this, 'CloudFrontWebAcl', {
      name: `${APP}-cf-web-acl`,
      description: 'ClaudeClaw CloudFront-scope edge WAF',
      scope: 'CLOUDFRONT',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `${APP}-cf-web-acl`,
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'RateLimit',
          priority: 0,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 2000,
              aggregateKeyType: 'IP',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'cf-rate-limit',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'AwsCommonRules',
          priority: 10,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'cf-aws-common-rules',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'AwsKnownBadInputs',
          priority: 20,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'cf-aws-known-bad-inputs',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'AwsAnonymousIpList',
          priority: 30,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesAnonymousIpList',
              // Same /health and /status exclusions as the regional WAF.
              // /health: deploy smoke from GitHub Actions runner IPs.
              // /status (and /status/data.json): D5 public status page.
              scopeDownStatement: {
                notStatement: {
                  statement: {
                    orStatement: {
                      statements: [
                        {
                          byteMatchStatement: {
                            searchString: '/health',
                            fieldToMatch: { uriPath: {} },
                            positionalConstraint: 'EXACTLY',
                            textTransformations: [{ priority: 0, type: 'NONE' }],
                          },
                        },
                        {
                          byteMatchStatement: {
                            searchString: '/status',
                            fieldToMatch: { uriPath: {} },
                            positionalConstraint: 'STARTS_WITH',
                            textTransformations: [{ priority: 0, type: 'NONE' }],
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'cf-aws-anonymous-ip-list',
            sampledRequestsEnabled: true,
          },
        },
      ],
    });
    new CfnOutput(this, 'CloudFrontWebAclArn', { value: cfWebAcl.attrArn });

    // Paused-mode reroute: when the power switch has drained the service, the
    // origin answers 502/503/504 and the dashboard URL would be a dead end.
    // This 302s browser PAGE LOADS to the always-up power panel instead, so
    // "visit the dashboard while paused" lands on the one control surface that
    // still works. Only GETs are rerouted, and the machine paths are excluded
    // on purpose: /tg + /slack webhooks need the raw 5xx for the platforms'
    // retry semantics, /api keeps XHR failures clean for the SPA's fail-soft
    // handling, and /health + /status must stay truthful for probes (including
    // the power Lambda's own restore check).
    //
    // This MUST be Lambda@Edge on ORIGIN_RESPONSE, not a CloudFront Function
    // on viewer-response: CloudFront Functions are documented (and verified
    // live 2026-07-02) to NOT execute on viewer-response when the origin
    // returned a 4xx/5xx — which is the only case this reroute exists for.
    const powerReroute = props.powerPanelUrl
      ? new experimental.EdgeFunction(this, 'PowerPauseRerouteEdge', {
          runtime: LambdaRuntime.NODEJS_20_X,
          handler: 'index.handler',
          code: LambdaCode.fromInline(`'use strict';
exports.handler = async (event) => {
  const cf = event.Records[0].cf;
  const response = cf.response;
  const status = parseInt(response.status, 10);
  if (status !== 502 && status !== 503 && status !== 504) return response;
  const request = cf.request;
  if (request.method !== 'GET') return response;
  const uri = request.uri || '';
  if (/^\\/(api|tg|slack|health|status)/.test(uri)) return response;
  return {
    status: '302',
    statusDescription: 'Found',
    headers: {
      location: [{ key: 'Location', value: ${JSON.stringify(props.powerPanelUrl)} }],
      'cache-control': [{ key: 'Cache-Control', value: 'no-store' }],
    },
  };
};`),
          description: 'Reroute page loads to the power panel while the origin is paused',
        })
      : undefined;
    const powerRerouteAssociations: EdgeLambda[] | undefined = powerReroute
      ? [
          {
            functionVersion: powerReroute.currentVersion,
            eventType: LambdaEdgeEventType.ORIGIN_RESPONSE,
          },
        ]
      : undefined;

    // Three cache behaviors:
    //   /dashboard and /dashboard/*  → cache 1h, ignore Authorization
    //     (SPA assets are public; no per-user variation)
    //   /api/*, /tg/*, /slack/*      → never cache, forward everything
    //     (webhooks + bearer-auth APIs + SSE)
    //   default                       → never cache, forward everything
    //     (matches API behavior so we don't accidentally cache anything
    //     model-generated)
    const cfDistribution = new Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: new HttpOrigin(originHost, {
          protocolPolicy: OriginProtocolPolicy.HTTPS_ONLY,
          httpsPort: 443,
          customHeaders: {
            [ORIGIN_HEADER_NAME]: cfOriginSecret,
          },
          readTimeout: Duration.seconds(60),
          keepaliveTimeout: Duration.seconds(60),
        }),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: AllowedMethods.ALLOW_ALL,
        cachedMethods: CachedMethods.CACHE_GET_HEAD,
        cachePolicy: CachePolicy.CACHING_DISABLED,
        originRequestPolicy: OriginRequestPolicy.ALL_VIEWER,
        responseHeadersPolicy: ResponseHeadersPolicy.SECURITY_HEADERS,
        compress: true,
        ...(powerRerouteAssociations ? { edgeLambdas: powerRerouteAssociations } : {}),
      },
      additionalBehaviors: {
        '/dashboard': {
          origin: new HttpOrigin(originHost, {
            protocolPolicy: OriginProtocolPolicy.HTTPS_ONLY,
            httpsPort: 443,
            customHeaders: { [ORIGIN_HEADER_NAME]: cfOriginSecret },
          }),
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
          cachedMethods: CachedMethods.CACHE_GET_HEAD,
          cachePolicy: CachePolicy.CACHING_OPTIMIZED,
          compress: true,
          ...(powerRerouteAssociations ? { edgeLambdas: powerRerouteAssociations } : {}),
        },
        '/dashboard/*': {
          origin: new HttpOrigin(originHost, {
            protocolPolicy: OriginProtocolPolicy.HTTPS_ONLY,
            httpsPort: 443,
            customHeaders: { [ORIGIN_HEADER_NAME]: cfOriginSecret },
          }),
          viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: AllowedMethods.ALLOW_GET_HEAD,
          cachedMethods: CachedMethods.CACHE_GET_HEAD,
          cachePolicy: CachePolicy.CACHING_OPTIMIZED,
          compress: true,
          ...(powerRerouteAssociations ? { edgeLambdas: powerRerouteAssociations } : {}),
        },
      },
      domainNames: [domainName],
      certificate: cfCert,
      minimumProtocolVersion: SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: HttpVersion.HTTP2_AND_3,
      enableLogging: true,
      // B4: attach the CLOUDFRONT-scope WebACL. webAclId on the L2
      // construct accepts the full ARN despite the name.
      webAclId: cfWebAcl.attrArn,
      // North America + Europe; T3 enterprise might add the global
      // PRICE_CLASS_ALL but that ~doubles edge cost.
      priceClass: PriceClass.PRICE_CLASS_100,
      comment: 'ClaudeClaw Enterprise edge (T3)',
    });

    new CfnOutput(this, 'CloudFrontDomain', {
      value: cfDistribution.distributionDomainName,
      description:
        'Point the apex Route 53 record at this CloudFront domain to flip live traffic from ALB to CloudFront.',
    });
    new CfnOutput(this, 'CloudFrontDistId', {
      value: cfDistribution.distributionId,
    });
    new CfnOutput(this, 'CloudFrontOriginHost', {
      value: originHost,
      description: 'Hostname CloudFront uses to reach the ALB. Provisioned in compute-stack as a Route 53 alias.',
    });

    // ── B2 · GuardDuty + AWS Config baseline (T3 only) ───────────
    // GuardDuty: managed threat detection. Findings flow through
    // EventBridge → the existing ops alert SNS topic.
    // AWS Config: continuous compliance recording against ~15 managed
    // rules. Delivery channel writes snapshots to the shared logs
    // bucket under config/. The bucket policy for Config writes is
    // added in storage-stack so the dependency direction stays
    // storage → security and not the other way around.
    const guardduty = new GuardDutyDetector(this, 'GuardDutyDetector', {
      enable: true,
      findingPublishingFrequency: 'FIFTEEN_MINUTES',
    });

    if (props.alertTopic) {
      new Rule(this, 'GuardDutyFindingRule', {
        ruleName: `${APP}-guardduty-findings`,
        description: 'Forward GuardDuty findings to the ops alert SNS topic.',
        eventPattern: {
          source: ['aws.guardduty'],
          detailType: ['GuardDuty Finding'],
        },
        targets: [new SnsTopic(props.alertTopic)],
      });
    }

    new CfnOutput(this, 'GuardDutyDetectorId', { value: guardduty.attrId });

    // AWS Config: gated on CCE_CONFIG_ENABLED=1. The recorder + delivery
    // channel have a mutual create-time dependency that pure CFN can't
    // express cleanly — both orderings of `addDependency` fail with
    // either NoAvailableDeliveryChannelException (recorder-first) or
    // NoAvailableConfigurationRecorderException (channel-first). The
    // robust pattern is a Custom Resource that calls Put + Put + Start
    // in sequence; tracked as a follow-up. For now, GuardDuty alone
    // covers the threat-detection half of B2.
    //
    // Out-of-band bootstrap (one-shot, run before flipping the flag):
    //   aws iam create-role ... claudeclaw-config-role
    //   aws iam attach-role-policy ... AWS_ConfigRole
    //   aws configservice put-configuration-recorder ...
    //   aws configservice put-delivery-channel ...
    //   aws configservice start-configuration-recorder ...
    // See docs/runbooks/bootstrap-aws-config.md (to be written).
    if (process.env.CCE_CONFIG_ENABLED === '1' && props.logsBucket) {
      // ManagedRule constructs reference the recorder by NAME only — no
      // CDK dependency edge needed. Bootstrap the recorder out-of-band
      // first; these rules adopt it implicitly.
      const ruleDefs: Array<[string, string]> = [
        ['S3BucketPublicReadProhibited', ManagedRuleIdentifiers.S3_BUCKET_PUBLIC_READ_PROHIBITED],
        ['S3BucketPublicWriteProhibited', ManagedRuleIdentifiers.S3_BUCKET_PUBLIC_WRITE_PROHIBITED],
        ['S3BucketServerSideEncryptionEnabled', ManagedRuleIdentifiers.S3_BUCKET_SERVER_SIDE_ENCRYPTION_ENABLED],
        ['IamRootAccessKeyCheck', ManagedRuleIdentifiers.IAM_ROOT_ACCESS_KEY_CHECK],
        ['IamPasswordPolicy', ManagedRuleIdentifiers.IAM_PASSWORD_POLICY],
        ['IamUserMfaEnabled', ManagedRuleIdentifiers.IAM_USER_MFA_ENABLED],
        ['KmsCmkNotScheduledForDeletion', ManagedRuleIdentifiers.CMK_BACKING_KEY_ROTATION_ENABLED],
        ['EncryptedVolumes', ManagedRuleIdentifiers.EBS_ENCRYPTED_VOLUMES],
        ['CloudTrailEnabled', ManagedRuleIdentifiers.CLOUD_TRAIL_ENABLED],
        ['CloudWatchAlarmActionCheck', ManagedRuleIdentifiers.CLOUDWATCH_ALARM_ACTION_CHECK],
        ['VpcFlowLogsEnabled', ManagedRuleIdentifiers.VPC_FLOW_LOGS_ENABLED],
        ['VpcDefaultSecurityGroupClosed', ManagedRuleIdentifiers.VPC_DEFAULT_SECURITY_GROUP_CLOSED],
        ['SecretsManagerRotationEnabledCheck', ManagedRuleIdentifiers.SECRETSMANAGER_ROTATION_ENABLED_CHECK],
        ['IncomingSshDisabled', ManagedRuleIdentifiers.EC2_SECURITY_GROUPS_INCOMING_SSH_DISABLED],
        ['Ec2InstancesInVpc', ManagedRuleIdentifiers.EC2_INSTANCES_IN_VPC],
      ];
      for (const [id, identifier] of ruleDefs) {
        new ManagedRule(this, id, { identifier });
      }
    }
  }
}
