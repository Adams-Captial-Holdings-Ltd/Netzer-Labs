import { Stack } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import {
  Vpc,
  IpAddresses,
  SubnetType,
  SecurityGroup,
  Peer,
  Port,
  InterfaceVpcEndpoint,
  InterfaceVpcEndpointAwsService,
  GatewayVpcEndpoint,
  GatewayVpcEndpointAwsService,
} from 'aws-cdk-lib/aws-ec2';
import { TIERS, TAGS, RESOURCE_NAMES, bucketName } from './constants.js';
import type { BaseStackProps, NetworkOutputs } from './interfaces.js';
import { CfnFlowLog } from 'aws-cdk-lib/aws-ec2';

/**
 * VPC, subnets, NAT, security groups, VPC endpoints.
 *
 * Per Codex review:
 *   - 2 NATs across 2 AZs (not 1)
 *   - Full interface-endpoint coverage so private Fargate tasks can call
 *     every AWS service without traversing the public internet
 *   - Gateway endpoints (free) for S3 and DynamoDB
 *   - Conditional endpoints at tier 2: bedrock-agent-runtime, Athena, Glue
 */
export class NetworkStack extends Stack implements NetworkOutputs {
  public readonly vpc: Vpc;
  public readonly albSecurityGroup: SecurityGroup;
  public readonly fargateSecurityGroup: SecurityGroup;
  public readonly endpointsSecurityGroup: SecurityGroup;
  public readonly paperclipSecurityGroup: SecurityGroup;
  public readonly endpoints: { [name: string]: InterfaceVpcEndpoint | GatewayVpcEndpoint } = {};

  constructor(scope: Construct, id: string, props: BaseStackProps) {
    super(scope, id, props);
    Object.entries(TAGS).forEach(([k, v]) => this.tags.setTag(k, v));

    const tier = TIERS[props.tier];

    this.vpc = new Vpc(this, 'Vpc', {
      ipAddresses: IpAddresses.cidr('10.42.0.0/16'),
      // Pinned at 2 AZs across every tier because CDK can't add a third
      // AZ in-place without a /16 re-layout (existing subnets collide
      // with the new CIDR allocation). Re-evaluate this if we ever
      // green-field a fresh VPC with /17 subnets and headroom for 3+ AZs.
      maxAzs: 2,
      natGateways: tier.natGatewayCount,
      subnetConfiguration: [
        { name: 'public', subnetType: SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      ],
    });

    // VPC Flow Logs to S3 (logs bucket, vpc-flow-logs/ prefix). The
    // bucket's existing lifecycle rule transitions to Glacier at 90d
    // and expires at 730d. Gated by tier so T0 doesn't pay for them.
    // Bucket name is constructed deterministically so we don't need to
    // create a cross-stack reference to storage-stack.
    if (tier.flowLogsEnabled) {
      const account = this.account;
      const region = this.region;
      const logsBucketArn = `arn:aws:s3:::${bucketName(
        RESOURCE_NAMES.logsBucket,
        account,
        region,
      )}`;
      new CfnFlowLog(this, 'FlowLog', {
        resourceType: 'VPC',
        resourceId: this.vpc.vpcId,
        trafficType: 'ALL',
        logDestinationType: 's3',
        logDestination: `${logsBucketArn}/vpc-flow-logs/`,
        maxAggregationInterval: 600,
      });
    }

    this.albSecurityGroup = new SecurityGroup(this, 'AlbSg', {
      vpc: this.vpc,
      description: 'ALB ingress from internet',
      allowAllOutbound: false,
    });
    // NOTE (no-domain `infra-only` mode): these any-IPv4 ingress rules stay
    // unconditional on purpose. In privateAccessOnly mode (see
    // compute-stack.ts / deploy-mode.ts) the ALB itself is synthesized
    // INTERNAL in private subnets, so the internet cannot route to it
    // regardless of what this SG would admit — the privacy guarantee is the
    // ALB scheme + subnet placement, not this SG. Keeping the rules
    // identical across modes also means flipping modes never churns the SG.
    this.albSecurityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(443), 'HTTPS in');
    this.albSecurityGroup.addIngressRule(Peer.anyIpv4(), Port.tcp(80), 'HTTP redirect in');

    this.fargateSecurityGroup = new SecurityGroup(this, 'FargateSg', {
      vpc: this.vpc,
      description: 'Fargate tasks ingress from ALB only',
      allowAllOutbound: true,
    });
    this.fargateSecurityGroup.addIngressRule(
      this.albSecurityGroup,
      Port.tcp(3000),
      'ALB to Fargate',
    );
    this.albSecurityGroup.addEgressRule(
      this.fargateSecurityGroup,
      Port.tcp(3000),
      'ALB to Fargate port',
    );

    // Paperclip work engine (ADR 0010): its own SG on its own port (3100),
    // NOT PORT=3000 reuse — distinct in flow logs, metrics, and SG audits.
    this.paperclipSecurityGroup = new SecurityGroup(this, 'PaperclipSg', {
      vpc: this.vpc,
      description: 'Paperclip server task (single-node, stateful)',
      allowAllOutbound: true, // needs NAT egress for npm-installed agent CLIs
    });
    this.paperclipSecurityGroup.addIngressRule(
      this.albSecurityGroup,
      Port.tcp(3100),
      'ALB to Paperclip',
    );
    this.albSecurityGroup.addEgressRule(
      this.paperclipSecurityGroup,
      Port.tcp(3100),
      'ALB to Paperclip',
    );

    this.endpointsSecurityGroup = new SecurityGroup(this, 'EndpointsSg', {
      vpc: this.vpc,
      description: 'VPC interface endpoints',
      allowAllOutbound: false,
    });
    this.endpointsSecurityGroup.addIngressRule(
      this.fargateSecurityGroup,
      Port.tcp(443),
      'Fargate to VPC endpoints',
    );
    // Paperclip tasks reach AWS APIs through the same PrivateLink endpoints
    // when the opt-in flag is armed (matches the Fargate rule above; harmless
    // otherwise because the endpoints themselves are gated below).
    this.endpointsSecurityGroup.addIngressRule(
      this.paperclipSecurityGroup,
      Port.tcp(443),
      'Paperclip to VPC endpoints',
    );

    // ── Gateway endpoints (free, no hourly charge) ─────────────────
    this.endpoints.s3 = this.vpc.addGatewayEndpoint('S3Gateway', {
      service: GatewayVpcEndpointAwsService.S3,
    });
    this.endpoints.dynamodb = this.vpc.addGatewayEndpoint('DynamoDbGateway', {
      service: GatewayVpcEndpointAwsService.DYNAMODB,
    });

    // ── Interface endpoints (priced per AZ-hour + per-GB) ──────────
    const ifaceCommon = {
      securityGroups: [this.endpointsSecurityGroup],
      subnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      privateDnsEnabled: true,
    };

    const addIface = (
      logicalId: string,
      service: InterfaceVpcEndpointAwsService,
      key: string,
    ): void => {
      this.endpoints[key] = new InterfaceVpcEndpoint(this, logicalId, {
        vpc: this.vpc,
        service,
        ...ifaceCommon,
      });
    };

    // Interface endpoints are OPT-IN. With NAT gateways present (these subnets
    // are PRIVATE_WITH_EGRESS), the tasks already reach every AWS API over NAT,
    // so the ~15 interface endpoints are redundant and were the single largest
    // line on the bill (~$175/mo for the prod set). Default OFF for cost; set
    // CCE_PRIVATE_ENDPOINTS=1 to keep AWS API traffic fully off the public
    // internet (security-strict deployments that want PrivateLink isolation).
    // The gateway endpoints above (S3, DynamoDB) stay on — they are free.
    const privateEndpoints = process.env.CCE_PRIVATE_ENDPOINTS === '1';
    if (privateEndpoints) {
      // Always-on interface endpoints
      addIface('BedrockRuntimeEndpoint', InterfaceVpcEndpointAwsService.BEDROCK_RUNTIME, 'bedrockRuntime');
      addIface('SecretsManagerEndpoint', InterfaceVpcEndpointAwsService.SECRETS_MANAGER, 'secrets');
      addIface('EcrApiEndpoint', InterfaceVpcEndpointAwsService.ECR, 'ecrApi');
      addIface('EcrDkrEndpoint', InterfaceVpcEndpointAwsService.ECR_DOCKER, 'ecrDkr');
      addIface('CloudWatchLogsEndpoint', InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS, 'cwLogs');
      addIface('CloudWatchEndpoint', InterfaceVpcEndpointAwsService.CLOUDWATCH, 'cw');
      addIface('SnsEndpoint', InterfaceVpcEndpointAwsService.SNS, 'sns');
      addIface('SqsEndpoint', InterfaceVpcEndpointAwsService.SQS, 'sqs');
      addIface('StsEndpoint', InterfaceVpcEndpointAwsService.STS, 'sts');
      // ECS Exec via SSM Session Manager. With NAT present, exec also works over
      // NAT; these are only required for exec in a no-egress private subnet.
      addIface('SsmEndpoint', InterfaceVpcEndpointAwsService.SSM, 'ssm');
      addIface('SsmMessagesEndpoint', InterfaceVpcEndpointAwsService.SSM_MESSAGES, 'ssmMessages');
      addIface('Ec2MessagesEndpoint', InterfaceVpcEndpointAwsService.EC2_MESSAGES, 'ec2Messages');

      // Tier 2: Bedrock Agent Runtime (for Bedrock KB retrieve), Athena, Glue
      if (tier.wafEnabled || props.tier >= 2) {
        addIface(
          'BedrockAgentRuntimeEndpoint',
          InterfaceVpcEndpointAwsService.BEDROCK_AGENT_RUNTIME,
          'bedrockAgentRuntime',
        );
        addIface('AthenaEndpoint', InterfaceVpcEndpointAwsService.ATHENA, 'athena');
        addIface('GlueEndpoint', InterfaceVpcEndpointAwsService.GLUE, 'glue');
      }
    }
  }

}
