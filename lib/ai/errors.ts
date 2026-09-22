export type AIErrorCode =
  | 'AI_CONFIG'
  | 'AI_AUTH'
  | 'AI_RATE_LIMIT'
  | 'AI_TIMEOUT'
  | 'AI_NETWORK'
  | 'AI_API_ERROR'
  | 'AI_REFUSAL'
  | 'AI_INCOMPLETE'
  | 'AI_INVALID_OUTPUT';

export interface AIErrorOptions {
  /** A transient failure (rate limit, 5xx, timeout, network) worth another attempt (lib/retry.ts). */
  retryable?: boolean;
  /** The provider's Retry-After hint in milliseconds. */
  retryAfterMs?: number;
}

/**
 * An AI failure with a short, safe message. The message ends up in Job.error
 * and is shown in the UI, so it must never contain secrets or raw provider
 * payloads.
 */
export class AIError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    readonly code: AIErrorCode,
    message: string,
    options: AIErrorOptions = {},
  ) {
    super(message);
    this.name = 'AIError';
    this.retryable = options.retryable ?? false;
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
  }
}
