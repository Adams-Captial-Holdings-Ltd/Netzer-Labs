/**
 * Bounded-concurrency primitives.
 *
 * Two shapes, both used to keep paid fan-out from spending money faster than a
 * cap can observe it:
 *
 *   - runBounded(): a chunked Promise.all that runs a list of async tasks with
 *     at most `limit` in flight at once. Use it when ONE request fans out over
 *     many items server-side.
 *
 *   - InFlightGate: a process-wide counter that admits at most `max` concurrent
 *     holders and rejects (does not queue) the rest. Use it when independent
 *     requests each do one paid call and you need a ceiling on how many run at
 *     the same time across the whole task — e.g. the Playground, where the SPA
 *     fires one HTTP call per selected model in parallel, so the fan-out is not
 *     inside a single request and a chunked Promise.all cannot bound it.
 *
 * Everything here is in-memory and per-process. On a multi-task deployment each
 * Fargate task enforces its own ceiling; the DDB cost cap remains the global
 * backstop. This is a guard against a single client fanning out unbounded, not
 * a distributed quota.
 */

/**
 * Run `tasks` with at most `limit` running concurrently, preserving result
 * order. Mirrors Promise.all's shape: rejects on the first task that throws.
 * `limit` is clamped to at least 1.
 */
export async function runBounded<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const max = Math.max(1, Math.floor(limit));
  const results: T[] = new Array(tasks.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  }
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(max, tasks.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

/**
 * A process-wide admission counter. tryAcquire() returns true and reserves a
 * slot while fewer than `max` are held; otherwise it returns false and reserves
 * nothing. Every successful tryAcquire() MUST be paired with exactly one
 * release() (use try/finally). Never blocks or queues — callers that lose the
 * race are rejected so they can return 429 instead of piling up.
 */
export class InFlightGate {
  private inFlight = 0;
  constructor(private readonly max: number) {}

  /** Reserve a slot if one is free. Returns false (and reserves nothing) when full. */
  tryAcquire(): boolean {
    if (this.inFlight >= this.max) return false;
    this.inFlight += 1;
    return true;
  }

  /** Release a previously acquired slot. Never drops below zero. */
  release(): void {
    if (this.inFlight > 0) this.inFlight -= 1;
  }

  /** Slots currently held (for tests / observability). */
  get held(): number {
    return this.inFlight;
  }
}
