import { Stack, RemovalPolicy, SecretValue } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { Secret } from 'aws-cdk-lib/aws-secretsmanager';
import { RESOURCE_NAMES, TAGS } from './constants.js';
import type { BaseStackProps, SecretsOutputs } from './interfaces.js';
import type { IKey } from 'aws-cdk-lib/aws-kms';

export interface SecretsStackProps extends BaseStackProps {
  dataKey: IKey;
}

/**
 * Secrets Manager entries with placeholder JSON shapes.
 *
 * Each secret is pre-populated with the JSON keys that the Fargate task
 * definition references via `EcsSecret.fromSecretsManager(secret, 'fieldName')`.
 * The values are placeholders ("REPLACE_ME"); the deploy script's
 * `populate-secrets` step writes real values from `.env` after `cdk deploy`.
 *
 * Without the correct JSON shape here, ECS task startup fails because
 * Secrets Manager value extraction looks up missing keys.
 */
export class SecretsStack extends Stack implements SecretsOutputs {
  public readonly slackSecret: Secret;
  public readonly telegramSecret: Secret;
  public readonly dashboardSecret: Secret;
  public readonly dbEncryptionSecret: Secret;
  public readonly bedrockGuardrailsSecret: Secret;
  public readonly vendorKeysSecret: Secret;
  public readonly paperclipSecret: Secret;
  public readonly shadowApproversSecret: Secret;

  constructor(scope: Construct, id: string, props: SecretsStackProps) {
    super(scope, id, props);
    Object.entries(TAGS).forEach(([k, v]) => this.tags.setTag(k, v));

    const placeholder = SecretValue.unsafePlainText('REPLACE_ME');

    const makeSecret = (
      logicalId: string,
      secretName: string,
      description: string,
      fields: string[],
      initialValue?: string,
    ): Secret =>
      new Secret(this, logicalId, {
        secretName,
        description,
        encryptionKey: props.dataKey,
        removalPolicy: RemovalPolicy.RETAIN,
        ...(initialValue === undefined
          ? { secretObjectValue: Object.fromEntries(fields.map((f) => [f, placeholder])) }
          : { secretStringValue: SecretValue.unsafePlainText(initialValue) }),
      });

    this.slackSecret = makeSecret(
      'SecretSlack',
      RESOURCE_NAMES.secrets.slack,
      'Slack bot token, signing secret, app token',
      ['bot_token', 'signing_secret', 'app_token'],
    );
    // Telegram secret has two fields:
    //   - tokens: stringified JSON map of agentId to bot token (orchestrator
    //     parses this and dispatches per agent)
    //   - webhook_secret: matched against X-Telegram-Bot-Api-Secret-Token
    //     on every inbound webhook to authenticate Telegram itself.
    this.telegramSecret = new Secret(this, 'SecretTelegram', {
      secretName: RESOURCE_NAMES.secrets.telegram,
      description: 'Telegram bot tokens + webhook secret',
      encryptionKey: props.dataKey,
      removalPolicy: RemovalPolicy.RETAIN,
      secretObjectValue: {
        tokens: SecretValue.unsafePlainText('{"main":"REPLACE_ME"}'),
        webhook_secret: SecretValue.unsafePlainText('REPLACE_ME'),
      },
    });
    this.dashboardSecret = makeSecret(
      'SecretDashboard',
      RESOURCE_NAMES.secrets.dashboard,
      'Dashboard auth token + emergency kill phrase',
      ['token', 'kill_phrase', 'pin_hash'],
    );
    this.dbEncryptionSecret = makeSecret(
      'SecretDbEncryption',
      RESOURCE_NAMES.secrets.dbEncryption,
      'AES-256-GCM key for application-layer encryption',
      ['key'],
    );
    this.bedrockGuardrailsSecret = makeSecret(
      'SecretBedrockGuardrails',
      RESOURCE_NAMES.secrets.bedrockGuardrails,
      'Bedrock Guardrail ID and version',
      ['guardrail_id', 'guardrail_version'],
    );
    // Optional vendor API keys for the capability tools (web search,
    // Gemini). These previously rode the task definition's plain `env`
    // block, which bakes values from the deploy shell into the
    // CloudFormation template — visible in the console and in every
    // archived cdk.out. REPLACE_ME placeholders are treated as unset by
    // the app (the tool registry skips registration).
    this.vendorKeysSecret = makeSecret(
      'SecretVendorKeys',
      RESOURCE_NAMES.secrets.vendorKeys,
      'Optional vendor API keys: Tavily, Brave, Exa, Serper, Gemini',
      [
        'tavily_api_key',
        'brave_search_api_key',
        'exa_api_key',
        'serper_api_key',
        'google_gemini_api_key',
      ],
    );
    // Paperclip work engine (ADR 0010). The Aurora-generated DB credentials
    // live in the DatabaseStack's own secret; this one carries the
    // integration keys phase b populates (better_auth_secret is generated,
    // reconciler/agent keys are minted against the running instance later).
    this.paperclipSecret = makeSecret(
      'SecretPaperclip',
      RESOURCE_NAMES.secrets.paperclip,
      'Paperclip work engine: auth secret + bridge API keys',
      ['better_auth_secret', 'reconciler_key', 'agent_keys', 'dispatch_secret'],
    );
    this.shadowApproversSecret = makeSecret(
      'SecretShadowApprovers',
      RESOURCE_NAMES.secrets.shadowApprovers,
      'Paperclip shadow approver credentials',
      [],
      '{"v":1,"slots":{}}',
    );
  }
}
