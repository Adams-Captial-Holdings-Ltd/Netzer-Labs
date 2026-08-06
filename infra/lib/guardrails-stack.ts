import { CfnOutput, Stack } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { CfnGuardrail } from 'aws-cdk-lib/aws-bedrock';
import { RESOURCE_NAMES, TAGS } from './constants.js';
import type { BaseStackProps, GuardrailsOutputs } from './interfaces.js';

/**
 * Bedrock default guardrail.
 *
 * Every Bedrock Converse call attaches this guardrail. PII redaction,
 * content filters, prompt injection detection.
 *
 * Note: guardrails do NOT inspect tool inputs, retrieved memory, or
 * tool results. Application-layer validation supplements at those points.
 */
export class GuardrailsStack extends Stack implements GuardrailsOutputs {
  public readonly guardrailId: string;
  public readonly guardrailVersion: string;

  constructor(scope: Construct, id: string, props: BaseStackProps) {
    super(scope, id, props);
    Object.entries(TAGS).forEach(([k, v]) => this.tags.setTag(k, v));

    const guardrail = new CfnGuardrail(this, 'DefaultGuardrail', {
      name: RESOURCE_NAMES.guardrail,
      description: 'Default guardrail attached to every ClaudeClaw Bedrock call',
      blockedInputMessaging: 'That message tripped the safety filter and was not processed.',
      blockedOutputsMessaging: 'That reply tripped the safety filter and was withheld.',
      contentPolicyConfig: {
        filtersConfig: [
          { type: 'HATE', inputStrength: 'MEDIUM', outputStrength: 'MEDIUM' },
          { type: 'INSULTS', inputStrength: 'MEDIUM', outputStrength: 'MEDIUM' },
          { type: 'SEXUAL', inputStrength: 'HIGH', outputStrength: 'HIGH' },
          { type: 'VIOLENCE', inputStrength: 'MEDIUM', outputStrength: 'MEDIUM' },
          { type: 'MISCONDUCT', inputStrength: 'MEDIUM', outputStrength: 'MEDIUM' },
          // PROMPT_ATTACK is off: at HIGH it blocked the owner asking the agent
          // about its own system prompt / behavior, and because the blocked turn
          // re-entered history it then blocked every later message in the chat
          // until /newchat. The operator IS the principal here; prompt-injection
          // defense for untrusted content lives at the application layer (DLP,
          // outbound exfil scan, tool-input validation), not in this filter.
          { type: 'PROMPT_ATTACK', inputStrength: 'NONE', outputStrength: 'NONE' },
        ],
      },
      sensitiveInformationPolicyConfig: {
        piiEntitiesConfig: [
          // Everyday PII (EMAIL, PHONE, ADDRESS, NAME, AGE, USERNAME,
          // IP_ADDRESS, URL) is deliberately NOT listed. ANONYMIZE was one-way
          // and stateful-chat-hostile: Bedrock rewrote place names / people
          // into literal {ADDRESS}/{NAME} placeholders, those got persisted
          // into session history, and the model echoed them back forever
          // ("should I live in Aussie" became unanswerable). And action 'NONE'
          // is NOT inert: verified 2026-06-09 via apply-guardrail that a
          // NONE-listed entity still intervenes on OUTPUT. The only way to
          // leave an entity alone is to omit it. An assistant that cannot say
          // names, emails, or places is useless; only credential-grade PII
          // below stays BLOCKed.
          { type: 'PASSWORD', action: 'BLOCK' },
          { type: 'AWS_ACCESS_KEY', action: 'BLOCK' },
          { type: 'AWS_SECRET_KEY', action: 'BLOCK' },
          // High-sensitivity PII — always block; we never want this in our logs/DDB
          { type: 'US_SOCIAL_SECURITY_NUMBER', action: 'BLOCK' },
          { type: 'US_INDIVIDUAL_TAX_IDENTIFICATION_NUMBER', action: 'BLOCK' },
          { type: 'US_PASSPORT_NUMBER', action: 'BLOCK' },
          { type: 'US_BANK_ACCOUNT_NUMBER', action: 'BLOCK' },
          { type: 'US_BANK_ROUTING_NUMBER', action: 'BLOCK' },
          { type: 'CREDIT_DEBIT_CARD_NUMBER', action: 'BLOCK' },
          { type: 'CREDIT_DEBIT_CARD_CVV', action: 'BLOCK' },
          { type: 'CREDIT_DEBIT_CARD_EXPIRY', action: 'BLOCK' },
          { type: 'PIN', action: 'BLOCK' },
        ],
      },
    });

    this.guardrailId = guardrail.attrGuardrailId;
    this.guardrailVersion = guardrail.attrVersion;

    // Explicit CfnOutputs (IaC readiness item 8b): the deploy script's
    // populate-secrets phase reads these from cdk outputs to write the
    // bedrock-guardrails secret. Construct properties alone aren't
    // visible to `cdk deploy --outputs-file`.
    new CfnOutput(this, 'GuardrailId', {
      value: this.guardrailId,
      description: 'Bedrock guardrail ID (source of the bedrock-guardrails secret)',
    });
    new CfnOutput(this, 'GuardrailVersion', {
      value: this.guardrailVersion,
      description: 'Bedrock guardrail version (DRAFT until a version is published)',
    });
  }
}
