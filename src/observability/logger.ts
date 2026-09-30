/**
 * Structured logger. pino in production (JSON to stdout, picked up by
 * the awslogs Fargate log driver). pino-pretty in dev for readability.
 *
 * Base fields: `agentId`, `chatId`, `requestId` are added by per-request
 * child loggers in the orchestrator. PII rule: user-message text is
 * truncated to 100 chars in log output. Full text only in DDB.
 */

import { pino, type DestinationStream, type Logger } from 'pino';

// pino-pretty is a devDependency only. Enable it explicitly via LOG_PRETTY=1
// in dev shells. In production (and any unknown env) we emit raw JSON so
// CloudWatch Logs ingests structured fields cleanly.
const isPretty = process.env.LOG_PRETTY === '1';

export function createLogger(destination?: DestinationStream): Logger {
  const options = {
    level: process.env.LOG_LEVEL ?? 'info',
    base: {
      service: 'orchestrator',
      env: process.env.NODE_ENV ?? 'development',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'authorization', '*.authorization', 'headers.authorization', 'req.headers.authorization',
        'password', '*.password', 'token', '*.token', 'secret', '*.secret', 'apiKey', '*.apiKey',
      ],
      censor: '[redacted]',
    },
    transport: !destination && isPretty
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname,service,env',
          },
        }
      : undefined,
  };
  return destination ? pino(options, destination) : pino(options);
}

export const logger: Logger = createLogger();

/**
 * Truncate user-facing text for logs. Full text belongs in DDB only.
 */
export function truncateForLog(text: string | undefined, max = 100): string {
  if (!text) return '';
  if (text.length <= max) return text;
  return text.slice(0, max) + `…(${text.length - max} more)`;
}
