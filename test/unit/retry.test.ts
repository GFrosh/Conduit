import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RETRY_POLICY,
  computeBackoffMs,
  executeWithRetry,
  isRetryable,
  type RetryPolicy,
} from '../../src/core/process/retry.js';
import { AppError } from '../../src/core/errors/AppError.js';

const POLICY: RetryPolicy = { ...DEFAULT_RETRY_POLICY, baseDelayMs: 10, maxDelayMs: 40, minAttemptMs: 1 };

function harness(deadlineMs = 60_000, policy: RetryPolicy = POLICY) {
  let clock = 1_000;
  const sleeps: number[] = [];
  const now = (): number => clock;
  const sleep = async (ms: number): Promise<void> => {
    sleeps.push(ms);
    clock += ms;
  };
  return { now, sleep, sleeps, deadlineAt: 1_000 + deadlineMs, policy, tick: (ms: number) => (clock += ms) };
}

describe('retry policy', () => {
  it('retries only transient transport and availability failures', () => {
    for (const code of ['PROVIDER_RATE_LIMITED', 'PROVIDER_UNAVAILABLE', 'PROVIDER_TIMEOUT', 'TIMEOUT'] as const) {
      expect(isRetryable(new AppError(code))).toBe(true);
    }
  });

  it('refuses to retry verdicts that cannot change', () => {
    for (const code of [
      'PROVIDER_AUTH_FAILED',
      'PROVIDER_BAD_REQUEST',
      'PROVIDER_MODEL_NOT_FOUND',
      'OUTPUT_VALIDATION_FAILED',
      'OUTPUT_UNPARSEABLE',
      'INVALID_JSON_SCHEMA',
      'VALIDATION_FAILED',
    ] as const) {
      expect(isRetryable(new AppError(code))).toBe(false);
    }
  });

  it('honours Retry-After but never exceeds the configured cap', () => {
    expect(computeBackoffMs(1, POLICY, 25)).toBe(25);
    expect(computeBackoffMs(1, POLICY, 90_000)).toBe(POLICY.maxDelayMs);
  });

  it('keeps jittered backoff inside the cap', () => {
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const delay = computeBackoffMs(attempt, POLICY);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(POLICY.maxDelayMs);
    }
  });
});

describe('executeWithRetry', () => {
  it('returns the first successful attempt', async () => {
    const h = harness();
    const operation = vi.fn(async () => 'ok');
    await expect(executeWithRetry({ operation, policy: h.policy, deadlineAt: h.deadlineAt, now: h.now, sleep: h.sleep })).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('recovers from a transient failure and reports both attempts', async () => {
    const h = harness();
    const failures: string[] = [];
    let call = 0;
    const operation = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new AppError('PROVIDER_UNAVAILABLE');
      return 'recovered';
    });
    const result = await executeWithRetry({
      operation,
      policy: h.policy,
      deadlineAt: h.deadlineAt,
      now: h.now,
      sleep: h.sleep,
      onFailure: (error) => failures.push(error.code),
    });
    expect(result).toBe('recovered');
    expect(operation).toHaveBeenCalledTimes(2);
    expect(failures).toEqual(['PROVIDER_UNAVAILABLE']);
  });

  it('stops at maxAttempts instead of amplifying load', async () => {
    const h = harness();
    const operation = vi.fn(async () => {
      throw new AppError('PROVIDER_UNAVAILABLE');
    });
    await expect(
      executeWithRetry({ operation, policy: h.policy, deadlineAt: h.deadlineAt, now: h.now, sleep: h.sleep }),
    ).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(operation).toHaveBeenCalledTimes(POLICY.maxAttempts);
  });

  it('never retries an authentication failure', async () => {
    const h = harness();
    const operation = vi.fn(async () => {
      throw new AppError('PROVIDER_AUTH_FAILED');
    });
    await expect(
      executeWithRetry({ operation, policy: h.policy, deadlineAt: h.deadlineAt, now: h.now, sleep: h.sleep }),
    ).rejects.toMatchObject({ code: 'PROVIDER_AUTH_FAILED' });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(h.sleeps).toEqual([]);
  });

  it('never retries an invalid request or an unknown model', async () => {
    const h = harness();
    for (const code of ['PROVIDER_BAD_REQUEST', 'PROVIDER_MODEL_NOT_FOUND'] as const) {
      const operation = vi.fn(async () => {
        throw new AppError(code);
      });
      await expect(
        executeWithRetry({ operation, policy: h.policy, deadlineAt: h.deadlineAt, now: h.now, sleep: h.sleep }),
      ).rejects.toMatchObject({ code });
      expect(operation).toHaveBeenCalledTimes(1);
    }
  });

  it('waits exactly as long as the provider asked', async () => {
    const h = harness();
    let call = 0;
    const operation = vi.fn(async () => {
      call += 1;
      if (call === 1) throw new AppError('PROVIDER_RATE_LIMITED', undefined, { details: { retry_after_ms: 25 } });
      return 'ok';
    });
    await executeWithRetry({ operation, policy: h.policy, deadlineAt: h.deadlineAt, now: h.now, sleep: h.sleep });
    expect(h.sleeps).toEqual([25]);
  });

  it('fails fast with TIMEOUT when a retry cannot fit before the deadline', async () => {
    const h = harness(50, { ...POLICY, maxDelayMs: 5_000 });
    const operation = vi.fn(async () => {
      throw new AppError('PROVIDER_UNAVAILABLE', undefined, { details: { retry_after_ms: 5_000 } });
    });
    await expect(
      executeWithRetry({ operation, policy: h.policy, deadlineAt: h.deadlineAt, now: h.now, sleep: h.sleep }),
    ).rejects.toMatchObject({ code: 'TIMEOUT', status: 504 });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(h.sleeps).toEqual([]);
  });

  it('classifies a deadline abort as TIMEOUT rather than a provider verdict', async () => {
    const h = harness(5_000);
    const operation = async (_signal: AbortSignal, context: { attempt: number }): Promise<never> => {
      if (context.attempt === 1) throw new AppError('PROVIDER_UNAVAILABLE');
      h.tick(5_000);
      throw new AppError('PROVIDER_TIMEOUT');
    };
    await expect(
      executeWithRetry({ operation, policy: h.policy, deadlineAt: h.deadlineAt, now: h.now, sleep: h.sleep }),
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
});
