import { AppError, toAppError } from '../errors/AppError.js';
import type { ErrorCode } from '../../contracts/common.js';

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Minimum useful attempt duration; below this there is no point retrying. */
  minAttemptMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 300,
  maxDelayMs: 4_000,
  minAttemptMs: 250,
};

/**
 * Only transient transport/availability conditions are retried. A 400, a bad
 * key, an unknown model, or a schema violation is a deterministic answer: asking
 * again cannot change it, it only amplifies load and cost.
 */
const RETRYABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'PROVIDER_RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_TIMEOUT',
  'TIMEOUT',
]);

export function isRetryable(error: AppError): boolean {
  return RETRYABLE.has(error.code);
}

/** Full-jitter exponential backoff: uniform in [0, cap). */
export function computeBackoffMs(attempt: number, policy: RetryPolicy, retryAfterMs?: number): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, policy.maxDelayMs);
  const exponential = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.round(exponential * Math.random());
}

export function readRetryAfter(error: AppError): number | undefined {
  const details = error.details;
  if (details === null || typeof details !== 'object') return undefined;
  const value = (details as { retry_after_ms?: unknown }).retry_after_ms;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * AbortSignal.timeout() rejects non-integer and out-of-range delays, and the
 * injected clock is fractional (performance.now()). Every delay is therefore
 * normalised to a positive integer here, in ONE place.
 */
const MAX_TIMER_MS = 2_147_483_647;
function toTimerMs(value: number): number {
  const floored = Math.floor(value);
  if (!Number.isFinite(floored) || floored < 1) return 1;
  return Math.min(floored, MAX_TIMER_MS);
}

export interface AttemptContext {
  attempt: number;
  maxAttempts: number;
  abortedByDeadline: boolean;
}

export interface ExecuteOptions<T> {
  operation: (signal: AbortSignal, context: AttemptContext) => Promise<T>;
  policy: RetryPolicy;
  deadlineAt: number;
  now: () => number;
  /** Called for each failed attempt so the orchestrator can record it. */
  onFailure?: (error: AppError, context: AttemptContext) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Aborted when the caller goes away; work stops instead of running to the deadline. */
  externalSignal?: AbortSignal;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Bounded, deadline-aware retry. Three properties matter:
 *  1. it can never run past `deadlineAt`;
 *  2. a retry that cannot finish before the deadline is skipped entirely,
 *     so a request fails fast with budget left rather than late with none;
 *  3. `Retry-After` is honoured but capped.
 */
export async function executeWithRetry<T>(options: ExecuteOptions<T>): Promise<T> {
  const { policy, deadlineAt, now } = options;
  const sleep = options.sleep ?? defaultSleep;
  const maxAttempts = Math.max(1, policy.maxAttempts);

  let lastError: AppError | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const remaining = Math.floor(deadlineAt - now());
    if (remaining <= 0) {
      const context: AttemptContext = { attempt, maxAttempts, abortedByDeadline: true };
      const timeout = lastError ?? new AppError('TIMEOUT');
      const finalError =
        timeout.code === 'TIMEOUT' ? timeout : new AppError('TIMEOUT', undefined, { cause: timeout });
      options.onFailure?.(finalError, context);
      throw finalError;
    }

    const willRetry = attempt < maxAttempts;
    const attemptBudget = willRetry
      ? Math.max(1, remaining - policy.baseDelayMs - policy.minAttemptMs)
      : remaining;

    const deadlineSignal = AbortSignal.timeout(toTimerMs(remaining));
    const attemptSignal = AbortSignal.timeout(toTimerMs(attemptBudget));
    const signal = options.externalSignal
      ? AbortSignal.any([deadlineSignal, attemptSignal, options.externalSignal])
      : AbortSignal.any([deadlineSignal, attemptSignal]);

    const context: AttemptContext = { attempt, maxAttempts, abortedByDeadline: false };

    try {
      return await options.operation(signal, context);
    } catch (error) {
      const abortedByDeadline = deadlineSignal.aborted;
      const abortedByAttempt = attemptSignal.aborted;
      // Adapters translate every SDK fault into AppError, so a non-AppError
      // escaping one means our own code failed: INTERNAL (500) is the honest
      // verdict. Claiming "provider unavailable" would send an operator to
      // debug a vendor that is fine. Aborts are still deadline/provider timeouts.
      const appError = signal.aborted
        ? AppError.isAppError(error) && error.code === 'TIMEOUT'
          ? new AppError('TIMEOUT', undefined, { cause: error })
          : new AppError('PROVIDER_TIMEOUT', undefined, { cause: error })
        : toAppError(error);

      const failureContext: AttemptContext = { ...context, abortedByDeadline };
      options.onFailure?.(appError, failureContext);

      // A caller that hung up will never read the answer: stop immediately.
      if (options.externalSignal?.aborted) {
        throw new AppError('TIMEOUT', undefined, {
          cause: appError,
          details: { reason: 'client_disconnected' },
        });
      }

      // A deadline abort is final: there is no budget left for another attempt.
      if (abortedByDeadline) throw new AppError('TIMEOUT', undefined, { cause: appError });

      lastError = appError;

      const canRetry = isRetryable(appError) && attempt < maxAttempts;
      if (!canRetry) throw appError;

      const delay = computeBackoffMs(attempt, policy, readRetryAfter(appError));
      const afterDelay = now() + delay;
      if (afterDelay + policy.minAttemptMs > deadlineAt) {
        // No useful attempt fits before the deadline. The service budget ran out,
        // which is a 504 TIMEOUT — not a provider verdict we never received.
        throw new AppError('TIMEOUT', undefined, { cause: appError });
      }
      if (abortedByAttempt && delay === 0) continue;
      await sleep(delay);
    }
  }

  throw lastError ?? new AppError('INTERNAL');
}
