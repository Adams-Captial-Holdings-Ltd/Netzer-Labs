/**
 * The single hard-stop boundary for ALL paid Amazon Bedrock Runtime calls.
 *
 * When the `bedrock_global` kill switch is active the system must make ZERO paid
 * model calls — regardless of which task, agent tool loop, embedding, image-gen,
 * or voice stream is alive. To make that true, every
 * `@aws-sdk/client-bedrock-runtime` send (Converse, ConverseStream, InvokeModel,
 * InvokeModelWithBidirectionalStream) goes through this guard: either wrapped in
 * `guardedBedrockSend(() => client.send(...))`, or immediately preceded by
 * `assertBedrockAllowed()`.
 *
 * The invariant is enforced by the enforcement suite in `guard.test.ts` (the
 * "no unguarded paid Bedrock send" describe block), which fails the build if any
 * source file constructs a Bedrock command without a guard call within reach.
 * The agent loop's existing start-of-turn check stays as an early exit; this
 * guard is the lower, per-send boundary it cannot bypass.
 */
import {
  isKillSwitchActive,
  KillSwitchActiveError,
} from '../state/kill-switches-repo.js';

/**
 * Throw `KillSwitchActiveError` when `bedrock_global` is active. Reads through
 * the kill-switch cache (30s TTL) so it is cheap to call before every send, and
 * fails OPEN if the switch store is unreachable (matching the rest of the app —
 * a hiccup in DynamoDB must not brick all inference).
 */
export async function assertBedrockAllowed(): Promise<void> {
  const killed = await isKillSwitchActive('bedrock_global');
  if (killed.active) {
    throw new KillSwitchActiveError(killed.reason ?? 'no reason given', 'bedrock_global');
  }
}

/**
 * Run a Bedrock Runtime send behind the `bedrock_global` hard stop. The send is
 * passed as a thunk so the SDK's exact response type is preserved:
 *
 *   const out = await guardedBedrockSend(() =>
 *     bedrockClient().send(new ConverseCommand(params)),
 *   );
 */
export async function guardedBedrockSend<R>(send: () => Promise<R>): Promise<R> {
  await assertBedrockAllowed();
  return send();
}
