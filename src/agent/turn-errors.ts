/**
 * What a person is told when a turn fails — the same words on every chat
 * surface (CLAUDE.md, "chat surface parity": error rendering). Never the raw
 * exception text, which can carry ARNs, account ids and file paths; the raw
 * message belongs in the surface's own log line.
 */

import { CostCapExceededError, KillSwitchActiveError } from './agent-loop.js';

/** Bedrock's own failures: the model could not answer this time, and trying again is the remedy. */
const MODEL_ERROR_NAMES = new Set([
  'ValidationException', 'ThrottlingException', 'ServiceUnavailableException', 'ModelTimeoutException',
  'ModelNotReadyException', 'ModelErrorException', 'ModelStreamErrorException', 'AccessDeniedException',
  'ResourceNotFoundException', 'ServiceQuotaExceededException',
]);

export function classifyTurnError(err: unknown): { code: string; message: string } {
  if (err instanceof CostCapExceededError) {
    return Number.isNaN(err.spendUsd)
      ? { code: 'cost_cap_unverifiable', message: 'The daily spending check could not run, so this message was not sent.' }
      : { code: 'cost_cap_exceeded', message: 'The daily spending cap has been reached. Raise it in Cost or try again tomorrow.' };
  }
  if (err instanceof KillSwitchActiveError) {
    return { code: 'kill_switch_active', message: 'An operator has paused this for now. Try again later.' };
  }
  return MODEL_ERROR_NAMES.has((err as { name?: string })?.name ?? '')
    ? { code: 'model_error', message: 'The model could not answer this time. Try again.' }
    : { code: 'internal_error', message: 'Something went wrong on our side. Try again.' };
}
