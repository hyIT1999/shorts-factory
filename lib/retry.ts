/**
 * Bounded retry with exponential backoff and jitter for transient provider
 * failures (rate limits, 5xx, timeouts, network errors). Nothing here knows
 * about AI or TTS: an error opts in by carrying `retryable: true` (and an
 * optional `retryAfterMs` hint from a Retry-After header). The sleep function
 * and the randomness are injectable so tests never wait.
 */
import { setTimeout as sleepFor } from 'node:timers/promises';

export interface RetryPolicy {
  /** Total attempts including the first one (1 = no retry). */
  attempts: number;
  /** Delay before the first retry; each further retry multiplies it by `factor`. */
  baseDelayMs: number;
  /** Upper bound for a single delay; also caps a provider's Retry-After hint. */
  maxDelayMs: number;
  /** Growth per retry (default 3: 5 s → 15 s → 45 s). */
  factor?: number;
}

/** One request, no retry (unit tests, and the default of a provider constructed directly). */
export const NO_RETRY: RetryPolicy = { attempts: 1, baseDelayMs: 0, maxDelayMs: 0 };

/** Worker default: 1 request + 3 retries after 5 s, 15 s and 45 s (about a minute in total). */
export const DEFAULT_RETRY_POLICY: RetryPolicy = { attempts: 4, baseDelayMs: 5_000, maxDelayMs: 60_000 };

const DEFAULT_FACTOR = 3;
/** Delays vary by ±20 % so several workers do not retry in lockstep. */
const JITTER = 0.2;

/** What an error can carry to take part in retries (AIError and VoiceError do). */
export interface RetryHints {
  retryable?: boolean;
  /** Provider hint (Retry-After) in milliseconds. */
  retryAfterMs?: number;
}

export interface RetryAttempt {
  /** The attempt that just failed (1-based). */
  attempt: number;
  attempts: number;
  delayMs: number;
  error: unknown;
}

export interface RetryOptions {
  policy: RetryPolicy;
  /** Decides whether a failure is worth another attempt; defaults to `isRetryableError`. */
  isRetryable?: (error: unknown) => boolean;
  /** Provider hint for the next delay in ms; defaults to reading `retryAfterMs` from the error. */
  retryAfterMs?: (error: unknown) => number | undefined;
  onRetry?: (info: RetryAttempt) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Uniform random in [0, 1) for the jitter. */
  random?: () => number;
}

const hints = (error: unknown): RetryHints =>
  typeof error === 'object' && error !== null ? (error as RetryHints) : {};

/** True for errors that declared themselves transient (`retryable: true`). */
export function isRetryableError(error: unknown): boolean {
  return hints(error).retryable === true;
}

/** The Retry-After hint an error carries, when it is a usable number of milliseconds. */
export function retryAfterFromError(error: unknown): number | undefined {
  const value = hints(error).retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Delay before retry number `retry` (1-based): the provider hint when there is
 * one, otherwise base × factor^(retry−1) with jitter, both capped at maxDelayMs.
 */
export function retryDelayMs(policy: RetryPolicy, retry: number, random: () => number = Math.random, hintMs?: number): number {
  const cap = Math.max(0, policy.maxDelayMs);
  if (hintMs !== undefined) {
    return Math.min(cap, Math.max(0, hintMs));
  }
  const factor = policy.factor ?? DEFAULT_FACTOR;
  const nominal = Math.max(0, policy.baseDelayMs) * factor ** Math.max(0, retry - 1);
  const jittered = nominal * (1 - JITTER + 2 * JITTER * random());
  return Math.round(Math.min(cap, jittered));
}

/**
 * Runs `fn` until it succeeds, the error is not retryable, or the attempts are
 * used up; the last error is thrown unchanged.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
  const attempts = Math.max(1, Math.floor(options.policy.attempts));
  const isRetryable = options.isRetryable ?? isRetryableError;
  const hint = options.retryAfterMs ?? retryAfterFromError;
  const sleep = options.sleep ?? ((ms: number) => sleepFor(ms));
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (attempt >= attempts || !isRetryable(error)) {
        throw error;
      }
      const delayMs = retryDelayMs(options.policy, attempt, options.random ?? Math.random, hint(error));
      options.onRetry?.({ attempt, attempts, delayMs, error });
      await sleep(delayMs);
    }
  }
}

/** HTTP status codes worth retrying: rate limits and transient server errors. */
export function isRetryableHttpStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

const MAX_RETRY_AFTER_MS = 5 * 60_000;

/** A `Retry-After` header (delay in seconds or an HTTP date) → milliseconds, capped at 5 minutes. */
export function parseRetryAfterHeader(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (!value) {
    return undefined;
  }
  const text = value.trim();
  let ms: number;
  if (/^\d+$/.test(text)) {
    ms = Number(text) * 1000;
  } else {
    const at = Date.parse(text);
    if (Number.isNaN(at)) {
      return undefined;
    }
    ms = at - now;
  }
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, ms));
}

/** A Google RPC duration such as "12s" or "0.5s" (RetryInfo.retryDelay) → milliseconds. */
export function parseGoogleDuration(value: unknown): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value.trim());
  return match ? Math.min(MAX_RETRY_AFTER_MS, Math.round(Number(match[1]) * 1000)) : undefined;
}

/**
 * PROVIDER_RETRY_ATTEMPTS (default 4, at least 1), PROVIDER_RETRY_BASE_MS
 * (default 5000) and PROVIDER_RETRY_MAX_MS (default 60000): the policy shared
 * by the AI and TTS providers. Throws a plain Error on invalid values; the
 * caller turns it into its own config error.
 */
export function retryPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): RetryPolicy {
  const read = (name: string, fallback: number, min: number): number => {
    const raw = env[name]?.trim();
    if (!raw) {
      return fallback;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min) {
      throw new Error(`${name} must be a whole number of at least ${min}`);
    }
    return value;
  };
  const attempts = read('PROVIDER_RETRY_ATTEMPTS', DEFAULT_RETRY_POLICY.attempts, 1);
  const baseDelayMs = read('PROVIDER_RETRY_BASE_MS', DEFAULT_RETRY_POLICY.baseDelayMs, 0);
  const maxDelayMs = read('PROVIDER_RETRY_MAX_MS', DEFAULT_RETRY_POLICY.maxDelayMs, 0);
  return { attempts, baseDelayMs, maxDelayMs: Math.max(maxDelayMs, baseDelayMs) };
}
