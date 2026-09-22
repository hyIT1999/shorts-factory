import type { LocalAssetStorage } from '../assets/storage.js';
import { retryPolicyFromEnv, type RetryPolicy } from '../retry.js';
import { VoiceError } from './errors.js';
import type { VoiceProvider } from './provider.js';
import { GeminiTtsProvider } from './providers/gemini.js';
import { MockVoiceProvider } from './providers/mock.js';
import { SilentVoiceProvider } from './providers/silent.js';
import { DEFAULT_SPEED, type VoiceMode } from './types.js';

export const DEFAULT_VOICE_MODE: VoiceMode = 'narration';
const DEFAULT_TIMEOUT_MS = 300_000;

/** Everything the VOICE stage needs, injected through JobContext. */
export interface VoiceServices {
  provider: VoiceProvider;
  /** Provider voice id (GEMINI_TTS_VOICE for Gemini). */
  voice: string;
  speed: number;
  /** One TTS request per video (narration, split afterwards) or per scene. */
  mode: VoiceMode;
  /** Pause between TTS requests in scene mode (free-tier friendly). */
  requestDelayMs: number;
  /** Shared local storage rooted at data/ (same instance as ASSETS). */
  storage: LocalAssetStorage;
}

function voiceMode(env: NodeJS.ProcessEnv): VoiceMode {
  const value = (env['VOICE_MODE'] ?? '').trim().toLowerCase() || DEFAULT_VOICE_MODE;
  if (value !== 'narration' && value !== 'scene') {
    throw new VoiceError('VOICE_CONFIG', `Unknown VOICE_MODE "${value}" (use "narration" or "scene")`);
  }
  return value;
}

function nonNegativeMs(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isFinite(value) || value < 0) {
    throw new VoiceError('VOICE_CONFIG', `${name} must be a non-negative number`);
  }
  return value;
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
 * Gemini retries transient failures (429, 5xx, timeouts) per PROVIDER_RETRY_* and
 * gives up on one request after VOICE_TIMEOUT_MS (a whole narration takes a while).
 */
export function createVoiceProviderFromEnv(env: NodeJS.ProcessEnv = process.env): VoiceProvider {
  const name = (env['VOICE_PROVIDER'] ?? 'gemini').trim().toLowerCase() || 'gemini';
  switch (name) {
    case 'gemini':
      return new GeminiTtsProvider({
        apiKey: env['GEMINI_API_KEY']?.trim() ?? '',
        model: env['GEMINI_TTS_MODEL']?.trim() ?? '',
        timeoutMs: nonNegativeMs(env, 'VOICE_TIMEOUT_MS', DEFAULT_TIMEOUT_MS),
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
  return {
    provider,
    voice: provider.name === 'gemini' ? (env['GEMINI_TTS_VOICE']?.trim() ?? '') : 'default',
    speed: DEFAULT_SPEED,
    mode: voiceMode(env),
    requestDelayMs: nonNegativeMs(env, 'VOICE_REQUEST_DELAY_MS', 0),
    storage,
  };
}
