/**
 * SES email tool.
 *
 * Sends multipart/alternative emails (HTML + plain) following the project's
 * email style rules: no em-dashes, no colons in copy, real `<ul>` for
 * lists, paragraphs as single long lines (no hard wrap).
 *
 * Hard caps:
 *   - 5 recipients per turn
 *   - 200 KB body
 *   - per-day send cap kill switch (email_send_disabled)
 *   - sender domain must be CCE_EMAIL_FROM (verified in SES)
 */

import type { Tool as BedrockTool } from '@aws-sdk/client-bedrock-runtime';
import {
  SESv2Client,
  SendEmailCommand,
} from '@aws-sdk/client-sesv2';
import { tools } from './registry.js';
import { registerIfConfigured } from '../addons/registry.js';
import { isKillSwitchActive } from '../state/kill-switches-repo.js';
import { writeAudit } from '../audit/audit-writer.js';
import { logger } from '../../observability/logger.js';

const region = process.env.AWS_REGION ?? 'us-east-1';
const MAX_RECIPIENTS = 5;
const MAX_BODY_BYTES = 200 * 1024;

let _ses: SESv2Client | null = null;
function ses(): SESv2Client {
  if (!_ses) _ses = new SESv2Client({ region });
  return _ses;
}

function spec(name: string, description: string, schema: unknown): BedrockTool {
  return {
    toolSpec: {
      name,
      description,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inputSchema: { json: schema as any },
    },
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function plainToHtml(plain: string): string {
  // Paragraph-aware: split on blank lines, wrap each in <p>, convert
  // single newlines to <br>. Lists supplied as `- ` lines become <ul>.
  const paras = plain.split(/\n{2,}/);
  return paras
    .map((p) => {
      const lines = p.split('\n');
      const isList = lines.every((l) => /^\s*-\s+/.test(l));
      if (isList) {
        return `<ul style="margin-top:4px;margin-bottom:8px">${lines
          .map((l) => `<li>${escapeHtml(l.replace(/^\s*-\s+/, ''))}</li>`)
          .join('')}</ul>`;
      }
      return `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`;
    })
    .join('\n');
}

registerIfConfigured(
  {
    id: 'email_send_ses',
    title: 'Email send (SES)',
    category: 'tool',
    description: 'Sends multipart HTML + plain emails via Amazon SES. Sender domain must be verified.',
    required: [
      { envVar: 'CCE_EMAIL_FROM', description: 'Verified sender address (e.g. "ClaudeClaw <claw@yourdomain.com>")' },
    ],
    killSwitch: 'email_send_disabled',
    defaultOn: false,
  },
  () => {
    tools.register('send_email', {
      spec: spec(
        'send_email',
        'Send an email via Amazon SES. Uses the configured sender address; recipients capped at 5. Body is auto-wrapped as multipart HTML + plain. Use when the user asks you to "email someone X" or "send Y a message".',
        {
          type: 'object',
          required: ['to', 'subject', 'body'],
          properties: {
            to: {
              type: 'array',
              items: { type: 'string', format: 'email' },
              description: 'Up to 5 recipient email addresses.',
            },
            cc: {
              type: 'array',
              items: { type: 'string', format: 'email' },
              description: 'Optional CC list.',
            },
            subject: { type: 'string', description: 'Subject line.' },
            body: {
              type: 'string',
              description:
                'Plain-text body. Use "- " for bullets; the wrapper auto-converts to a real <ul>. No leading whitespace on lines (Gmail mangles it).',
            },
            reply_to: {
              type: 'string',
              format: 'email',
              description: 'Optional Reply-To override.',
            },
          },
        },
      ),
      async invoke(args, ctx) {
        const killed = await isKillSwitchActive('email_send_disabled');
        if (killed.active) {
          return {
            text: `Email send disabled: ${killed.reason ?? 'no reason given'}`,
            isError: true,
          };
        }
        const from = process.env.CCE_EMAIL_FROM ?? '';
        if (!from) {
          return { text: 'CCE_EMAIL_FROM is not configured', isError: true };
        }
        const to = Array.isArray(args.to) ? (args.to as string[]) : [];
        if (to.length === 0) return { text: 'to is required', isError: true };
        if (to.length > MAX_RECIPIENTS) {
          return { text: `at most ${MAX_RECIPIENTS} recipients per send`, isError: true };
        }
        const cc = Array.isArray(args.cc) ? (args.cc as string[]).slice(0, MAX_RECIPIENTS) : [];
        const subject = String(args.subject ?? '').trim();
        const body = String(args.body ?? '').trim();
        if (!subject) return { text: 'subject is required', isError: true };
        if (!body) return { text: 'body is required', isError: true };
        if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
          return { text: `body exceeds ${MAX_BODY_BYTES} byte cap`, isError: true };
        }
        const html = `<div style="font-family:Arial,sans-serif;font-size:14px;line-height:1.5;color:#1a1a1a">${plainToHtml(
          body,
        )}</div>`;
        try {
          const resp = await ses().send(
            new SendEmailCommand({
              FromEmailAddress: from,
              Destination: { ToAddresses: to, CcAddresses: cc },
              ...(typeof args.reply_to === 'string' ? { ReplyToAddresses: [args.reply_to] } : {}),
              Content: {
                Simple: {
                  Subject: { Data: subject, Charset: 'UTF-8' },
                  Body: {
                    Text: { Data: body, Charset: 'UTF-8' },
                    Html: { Data: html, Charset: 'UTF-8' },
                  },
                },
              },
            }),
          );
          logger.info(
            { agentId: ctx.agentId, chatId: ctx.chatId, recipients: to.length, messageId: resp.MessageId },
            'email sent',
          );
          void writeAudit({
            action: 'tool_invoke',
            agentId: ctx.agentId,
            chatId: ctx.chatId,
            toolName: 'send_email',
            detail: {
              messageId: resp.MessageId,
              to: to.length,
              cc: cc.length,
              subjectLen: subject.length,
            },
            result: 'ok',
          });
          return {
            text: `Email sent to ${to.join(', ')}${cc.length ? ` (cc ${cc.length})` : ''}. SES messageId: ${resp.MessageId}`,
          };
        } catch (err) {
          return {
            text: `SES send failed: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          };
        }
      },
    });
  },
);
