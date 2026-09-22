/**
 * Retry helper: backoff, jitter, hints, limits and env parsing. No provider,
 * no network, no real sleeping.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  DEFAULT_RETRY_POLICY,
  NO_RETRY,
  isRetryableError,
  isRetryableHttpStatus,
  parseGoogleDuration,
  parseRetryAfterHeader,
  retryAfterFromError,
  retryDelayMs,
  retryPolicyFromEnv,
  withRetry,
  type RetryPolicy,
} from '../lib/retry.js';

const policy: RetryPolicy = { attempts: 4, baseDelayMs: 5_000, maxDelayMs: 60_000 };
/** Mid-range random → jitter factor exactly 1. */
const mid = () => 0.5;

class TransientError extends Error {
  retryable = true;
  retryAfterMs?: number;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    if (retryAfterMs !== undefined) {
      this.retryAfterMs = retryAfterMs;
    }
  }
}

function recorder() {
  const delays: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    delays.push(ms);
  };
  return { delays, sleep };
}

describe('withRetry', () => {
  test('retries a transient error with growing delays and returns the first success', async () => {
    const { delays, sleep } = recorder();
    let calls = 0;
    const result = await withRetry(
      async (attempt) => {
        calls++;
        if (attempt < 3) {
          throw new TransientError(`fail ${attempt}`);
        }
        return `ok on ${attempt}`;
      },
      { policy, sleep, random: mid },
    );
    assert.equal(result, 'ok on 3');
    assert.equal(calls, 3);
    assert.deepEqual(delays, [5_000, 15_000]);
  });

  test('gives up after the configured attempts and throws the last error unchanged', async () => {
    const { delays, sleep } = recorder();
    const seen: number[] = [];
    await assert.rejects(
      withRetry(
        async (attempt) => {
          throw new TransientError(`fail ${attempt}`);
        },
        { policy, sleep, random: mid, onRetry: (info) => seen.push(info.attempt) },
      ),
      (error: unknown) => error instanceof TransientError && error.message === 'fail 4',
    );
    assert.deepEqual(delays, [5_000, 15_000, 45_000]);
    assert.deepEqual(seen, [1, 2, 3]);
  });

  test('a non-retryable error is thrown immediately without sleeping', async () => {
    const { delays, sleep } = recorder();
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          throw new Error('bad request');
        },
        { policy, sleep },
      ),
      /bad request/,
    );
    assert.equal(calls, 1);
    assert.deepEqual(delays, []);
  });

  test('NO_RETRY runs exactly once even for transient errors', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          throw new TransientError('busy');
        },
        { policy: NO_RETRY },
      ),
    );
    assert.equal(calls, 1);
  });

  test('a Retry-After hint replaces the backoff and is capped at maxDelayMs', async () => {
    const { delays, sleep } = recorder();
    let calls = 0;
    await withRetry(
      async () => {
        calls++;
        if (calls === 1) {
          throw new TransientError('slow down', 12_000);
        }
        if (calls === 2) {
          throw new TransientError('slow down a lot', 600_000);
        }
        return 'ok';
      },
      { policy, sleep, random: mid },
    );
    assert.deepEqual(delays, [12_000, 60_000]);
  });
});

describe('retryDelayMs', () => {
  test('exponential with ±20 % jitter, capped at maxDelayMs', () => {
    assert.equal(retryDelayMs(policy, 1, () => 0), 4_000);
    assert.equal(retryDelayMs(policy, 1, () => 1), 6_000);
    assert.equal(retryDelayMs(policy, 2, mid), 15_000);
    assert.equal(retryDelayMs(policy, 3, mid), 45_000);
    assert.equal(retryDelayMs(policy, 4, mid), 60_000, 'capped');
    assert.equal(retryDelayMs({ ...policy, factor: 2 }, 3, mid), 20_000);
    assert.equal(retryDelayMs(policy, 1, mid, 0), 0, 'a zero hint means retry now');
  });
});

describe('error hints', () => {
  test('only errors that opt in are retryable; hints must be finite non-negative numbers', () => {
    assert.equal(isRetryableError(new TransientError('x')), true);
    assert.equal(isRetryableError(new Error('x')), false);
    assert.equal(isRetryableError(null), false);
    assert.equal(isRetryableError('string'), false);
    assert.equal(retryAfterFromError(new TransientError('x', 2_500)), 2_500);
    assert.equal(retryAfterFromError(new TransientError('x')), undefined);
    assert.equal(retryAfterFromError(Object.assign(new Error('x'), { retryAfterMs: -1 })), undefined);
    assert.equal(retryAfterFromError(Object.assign(new Error('x'), { retryAfterMs: Number.NaN })), undefined);
  });

  test('HTTP statuses: 429 and transient 5xx only', () => {
    assert.deepEqual([429, 500, 502, 503, 504].map(isRetryableHttpStatus), [true, true, true, true, true]);
    assert.deepEqual([400, 401, 403, 404, 422, 501].map(isRetryableHttpStatus), [false, false, false, false, false, false]);
  });

  test('Retry-After header: seconds, HTTP date, garbage, cap', () => {
    const now = Date.parse('2026-09-21T10:00:00Z');
    assert.equal(parseRetryAfterHeader('7', now), 7_000);
    assert.equal(parseRetryAfterHeader(' 0 ', now), 0);
    assert.equal(parseRetryAfterHeader('Mon, 21 Sep 2026 10:00:30 GMT', now), 30_000);
    assert.equal(parseRetryAfterHeader('Mon, 21 Sep 2026 09:00:00 GMT', now), 0, 'a date in the past');
    assert.equal(parseRetryAfterHeader('soon', now), undefined);
    assert.equal(parseRetryAfterHeader(null, now), undefined);
    assert.equal(parseRetryAfterHeader('', now), undefined);
    assert.equal(parseRetryAfterHeader('99999', now), 300_000, 'capped at 5 minutes');
  });

  test('Google RetryInfo durations', () => {
    assert.equal(parseGoogleDuration('12s'), 12_000);
    assert.equal(parseGoogleDuration('0.5s'), 500);
    assert.equal(parseGoogleDuration('12'), undefined);
    assert.equal(parseGoogleDuration(12), undefined);
    assert.equal(parseGoogleDuration('999999s'), 300_000);
  });
});

describe('retryPolicyFromEnv', () => {
  test('defaults, overrides and validation', () => {
    assert.deepEqual(retryPolicyFromEnv({}), DEFAULT_RETRY_POLICY);
    assert.deepEqual(retryPolicyFromEnv({ PROVIDER_RETRY_ATTEMPTS: '1' }), { ...DEFAULT_RETRY_POLICY, attempts: 1 });
    assert.deepEqual(retryPolicyFromEnv({ PROVIDER_RETRY_BASE_MS: '100', PROVIDER_RETRY_MAX_MS: '50' }), {
      attempts: 4,
      baseDelayMs: 100,
      maxDelayMs: 100,
    });
    for (const env of [{ PROVIDER_RETRY_ATTEMPTS: '0' }, { PROVIDER_RETRY_ATTEMPTS: 'x' }, { PROVIDER_RETRY_BASE_MS: '-1' }, { PROVIDER_RETRY_MAX_MS: '1.5' }]) {
      assert.throws(() => retryPolicyFromEnv(env), /must be a whole number/, JSON.stringify(env));
    }
  });
});
