import type { LocalAssetStorage } from '../assets/storage.js';
import { retryPolicyFromEnv, type RetryPolicy } from '../retry.js';
import { VoiceError } from './errors.js';
import type { VoiceProvider } from './provider.js';
import { GeminiTtsProvider } from './providers/gemini.js';
import { MockVoiceProvider } from './providers/mock.js';
import { SilentVoiceProvider } from './providers/silent.js';
import { DEFAULT_SPEED } from './types.js';

/** Everything the VOICE stage needs, injected through JobContext. */
export interface VoiceServices {
  provider: VoiceProvider;
  /** Provider voice id (GEMINI_TTS_VOICE for Gemini). */
  voice: string;
  speed: number;
  /** Pause between TTS requests (free-tier friendly). */
  requestDelayMs: number;
  /** Shared local storage rooted at data/ (same instance as ASSETS). */
  storage: LocalAssetStorage;
}

/** PROVIDER_RETRY_* as a VOICE configuration error when invalid. */
function voiceRetryPolicy(env: NodeJS.ProcessEnv): RetryPolicy {
  try {
    return retryPolicyFromEnv(env);
  } catch (error) {
    throw new VoiceError('VOICE_CONFIG', error instanceof Error ? error.message : String(error));
  }
}

/**
 * VOICE_PROVIDER: "gemini" (default), "silent" (offline dev/tests) or "mock" (tests).
 * Gemini retries transient failures (429, 5xx, timeouts) per PROVIDER_RETRY_*.
 */
export function createVoiceProviderFromEnv(env: NodeJS.ProcessEnv = process.env): VoiceProvider {
  const name = (env['VOICE_PROVIDER'] ?? 'gemini').trim().toLowerCase() || 'gemini';
  switch (name) {
    case 'gemini':
      return new GeminiTtsProvider({
        apiKey: env['GEMINI_API_KEY']?.trim() ?? '',
        model: env['GEMINI_TTS_MODEL']?.trim() ?? '',
        retry: voiceRetryPolicy(env),
      });
    case 'silent':
      return new SilentVoiceProvider();
    case 'mock':
      return new MockVoiceProvider();
    default:
      throw new VoiceError('VOICE_CONFIG', `Unknown VOICE_PROVIDER "${name}" (use "gemini", "silent" or "mock")`);
  }
}

export function createVoiceServicesFromEnv(storage: LocalAssetStorage, env: NodeJS.ProcessEnv = process.env): VoiceServices {
  const provider = createVoiceProviderFromEnv(env);
  const delay = Number(env['VOICE_REQUEST_DELAY_MS'] ?? '0');
  if (!Number.isFinite(delay) || delay < 0) {
    throw new VoiceError('VOICE_CONFIG', 'VOICE_REQUEST_DELAY_MS must be a non-negative number');
  }
  return {
    provider,
    voice: provider.name === 'gemini' ? (env['GEMINI_TTS_VOICE']?.trim() ?? '') : 'default',
    speed: DEFAULT_SPEED,
    requestDelayMs: delay,
    storage,
  };
}
