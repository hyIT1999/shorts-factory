export type VoiceErrorCode =
  | 'VOICE_CONFIG'
  | 'VOICE_UNSUPPORTED_LANGUAGE'
  | 'VOICE_TIMEOUT'
  | 'VOICE_RATE_LIMIT'
  | 'VOICE_AUTH'
  | 'VOICE_API_ERROR'
  | 'INVALID_AUDIO'
  | 'EMPTY_TEXT'
  | 'TEXT_NOT_VIETNAMESE';

export interface VoiceErrorOptions {
  /** A transient failure (rate limit, 5xx, timeout, network) worth another attempt (lib/retry.ts). */
  retryable?: boolean;
  /** The provider's Retry-After hint in milliseconds. */
  retryAfterMs?: number;
}

/**
 * A VOICE failure with a short, safe message. It ends up in Job.error and is
 * shown in the UI, so it must never contain secrets or raw provider payloads.
 */
export class VoiceError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    readonly code: VoiceErrorCode,
    message: string,
    options: VoiceErrorOptions = {},
  ) {
    super(message);
    this.name = 'VoiceError';
    this.retryable = options.retryable ?? false;
    if (options.retryAfterMs !== undefined) {
      this.retryAfterMs = options.retryAfterMs;
    }
  }
}
