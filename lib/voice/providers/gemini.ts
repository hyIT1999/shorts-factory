/**
 * Gemini TTS provider: REST generateContent with responseModalities ["AUDIO"]
 * and a prebuilt voice, using native fetch. Gemini returns base64 PCM
 * (observed: "audio/l16; rate=24000; channels=1"); it is wrapped into a WAV
 * container here. Transient failures (HTTP 429, 5xx, timeouts, network
 * errors) are retried according to the injected RetryPolicy (no retry when
 * the provider is constructed directly). No file writes.
 */
import {
  isRetryableHttpStatus,
  NO_RETRY,
  parseGoogleDuration,
  parseRetryAfterHeader,
  withRetry,
  type RetryPolicy,
} from '../../retry.js';
import { VoiceError } from '../errors.js';
import type { VoiceProvider } from '../provider.js';
import type { VoiceRequest, VoiceResult } from '../types.js';
import { encodeWav } from '../wav.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_SAMPLE_RATE = 24_000;
const MAX_DETAIL_LENGTH = 200;

/** Languages listed in the Gemini speech-generation documentation. */
export const GEMINI_TTS_LANGUAGES: ReadonlySet<string> = new Set([
  'ar', 'bn', 'de', 'en', 'es', 'fr', 'hi', 'id', 'it', 'ja', 'ko', 'mr', 'nl',
  'pl', 'pt', 'ro', 'ru', 'ta', 'te', 'th', 'tr', 'uk', 'vi', 'zh',
]);

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

export interface GeminiTtsOptions {
  apiKey: string;
  model: string;
  fetch?: FetchFn;
  timeoutMs?: number;
  /** Retry policy for transient failures (default: a single request). */
  retry?: RetryPolicy;
  /** Injected for tests so retries do not really wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Where retries are reported (default: console.warn). */
  log?: (message: string) => void;
}

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function safeDetail(message: string): string {
  return message.replace(/AIza[0-9A-Za-z_-]{10,}/g, '[redacted]').slice(0, MAX_DETAIL_LENGTH);
}

/** Natural-language delivery hint (Gemini TTS follows instructions like "Say cheerfully: …"). */
function deliveryPrompt(request: VoiceRequest): string {
  const hints: string[] = [];
  if (request.style) {
    hints.push(`in a ${request.style.toLowerCase()} tone`);
  }
  if (request.speed < 0.9) {
    hints.push('at a slow pace');
  } else if (request.speed > 1.1) {
    hints.push('at a fast pace');
  }
  return hints.length > 0 ? `Read aloud ${hints.join(', ')}: ${request.text}` : request.text;
}

/** "audio/l16; rate=24000; channels=1" → { sampleRate: 24000, channels: 1 }. */
function pcmFormatFrom(mimeType: string): { sampleRate: number; channels: number } {
  const rate = /rate=(\d+)/i.exec(mimeType);
  const channels = /channels=(\d+)/i.exec(mimeType);
  return { sampleRate: rate ? Number(rate[1]) : DEFAULT_SAMPLE_RATE, channels: channels ? Number(channels[1]) : 1 };
}

export class GeminiTtsProvider implements VoiceProvider {
  readonly name = 'gemini';
  readonly model: string;
  readonly supportedLanguages = GEMINI_TTS_LANGUAGES;
  private readonly apiKey: string;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;
  private readonly retry: RetryPolicy;
  private readonly sleep: ((ms: number) => Promise<void>) | undefined;
  private readonly log: (message: string) => void;

  constructor(options: GeminiTtsOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model.replace(/^models\//, '');
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retry = options.retry ?? NO_RETRY;
    this.sleep = options.sleep;
    this.log = options.log ?? ((message) => console.warn(message));
  }

  async synthesize(request: VoiceRequest): Promise<VoiceResult> {
    if (!this.apiKey) {
      throw new VoiceError('VOICE_CONFIG', 'GEMINI_API_KEY is not configured');
    }
    if (!this.model) {
      throw new VoiceError('VOICE_CONFIG', 'GEMINI_TTS_MODEL is not configured');
    }
    if (!request.voice) {
      throw new VoiceError('VOICE_CONFIG', 'GEMINI_TTS_VOICE is not configured');
    }
    return withRetry(() => this.attempt(request), {
      policy: this.retry,
      ...(this.sleep ? { sleep: this.sleep } : {}),
      onRetry: ({ attempt, attempts, delayMs, error }) =>
        this.log(
          `Gemini TTS scene ${request.sceneIndex + 1}: ${error instanceof Error ? error.message : String(error)}; ` +
            `retry ${attempt} of ${attempts - 1} in ${Math.round(delayMs / 1000)} s`,
        ),
    });
  }

  /** One generateContent request; throws a VoiceError that says whether it is worth retrying. */
  private async attempt(request: VoiceRequest): Promise<VoiceResult> {
    const body = {
      contents: [{ role: 'user', parts: [{ text: deliveryPrompt(request) }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: request.voice } } },
      },
    };

    let response: Response;
    let payload: unknown;
    try {
      response = await this.fetchFn(`${API_BASE}/${encodeURIComponent(this.model)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const text = await response.text();
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        payload = undefined;
      }
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        throw new VoiceError('VOICE_TIMEOUT', 'Gemini TTS request timed out', { retryable: true });
      }
      throw new VoiceError('VOICE_API_ERROR', 'Could not reach the Gemini TTS API (network error)', { retryable: true });
    }

    if (!response.ok) {
      throw httpError(response.status, payload, response.headers);
    }
    return extractAudio(payload, request);
  }
}

/** Google's RetryInfo detail ("retryDelay": "12s") that accompanies quota errors. */
function googleRetryDelay(payload: unknown): number | undefined {
  const error = isObject(payload) && isObject(payload['error']) ? payload['error'] : undefined;
  const details = Array.isArray(error?.['details']) ? error['details'] : [];
  for (const detail of details) {
    const ms = isObject(detail) ? parseGoogleDuration(detail['retryDelay']) : undefined;
    if (ms !== undefined) {
      return ms;
    }
  }
  return undefined;
}

function httpError(status: number, payload: unknown, headers?: Headers): VoiceError {
  const retryAfterMs = parseRetryAfterHeader(headers?.get('retry-after')) ?? googleRetryDelay(payload);
  if (status === 401 || status === 403) {
    return new VoiceError('VOICE_AUTH', `Gemini TTS rejected the credentials (HTTP ${status}); check GEMINI_API_KEY`);
  }
  if (status === 429) {
    return new VoiceError('VOICE_RATE_LIMIT', 'Gemini TTS rate limit or quota exceeded (HTTP 429)', { retryable: true, retryAfterMs });
  }
  const error = isObject(payload) && isObject(payload['error']) ? payload['error'] : undefined;
  const message = typeof error?.['message'] === 'string' ? error['message'] : '';
  // 400/404 explain misconfiguration (unknown model/voice, invalid key) without credentials.
  const detail = (status === 400 || status === 404) && message ? `: ${safeDetail(message)}` : '';
  return new VoiceError('VOICE_API_ERROR', `Gemini TTS API error (HTTP ${status})${detail}`, {
    retryable: isRetryableHttpStatus(status),
    retryAfterMs,
  });
}

function extractAudio(payload: unknown, request: VoiceRequest): VoiceResult {
  if (!isObject(payload)) {
    throw new VoiceError('VOICE_API_ERROR', 'Gemini TTS response was not valid JSON');
  }
  const feedback = payload['promptFeedback'];
  if (isObject(feedback) && typeof feedback['blockReason'] === 'string') {
    throw new VoiceError('VOICE_API_ERROR', `Gemini TTS blocked scene ${request.sceneIndex + 1} (${feedback['blockReason']})`);
  }
  const candidates = payload['candidates'];
  const candidate = Array.isArray(candidates) ? candidates[0] : undefined;
  if (!isObject(candidate)) {
    throw new VoiceError('INVALID_AUDIO', 'Gemini TTS response contained no candidates');
  }
  const finishReason = typeof candidate['finishReason'] === 'string' ? candidate['finishReason'] : 'STOP';
  if (finishReason !== 'STOP') {
    throw new VoiceError('INVALID_AUDIO', `Gemini TTS finished with "${finishReason}" for scene ${request.sceneIndex + 1}`);
  }

  const content = candidate['content'];
  const parts = isObject(content) && Array.isArray(content['parts']) ? content['parts'] : [];
  const audioParts = parts
    .map((part) => (isObject(part) && isObject(part['inlineData']) ? part['inlineData'] : undefined))
    .filter((inline): inline is JsonObject => inline !== undefined && typeof inline['data'] === 'string');
  if (audioParts.length === 0) {
    throw new VoiceError('INVALID_AUDIO', 'Gemini TTS response contained no audio data');
  }

  const mimeType = typeof audioParts[0]?.['mimeType'] === 'string' ? audioParts[0]['mimeType'] : 'audio/L16;rate=24000';
  if (!/^audio\/(l16|pcm)/i.test(mimeType)) {
    throw new VoiceError('INVALID_AUDIO', `Unexpected Gemini TTS audio format "${mimeType}"`);
  }
  const pcm = Buffer.concat(audioParts.map((inline) => Buffer.from(String(inline['data']), 'base64')));
  if (pcm.length === 0) {
    throw new VoiceError('INVALID_AUDIO', 'Gemini TTS returned empty audio');
  }

  const responseId = typeof payload['responseId'] === 'string' ? payload['responseId'] : undefined;
  return {
    audio: encodeWav(pcm, { ...pcmFormatFrom(mimeType), bitsPerSample: 16 }),
    mimeType: 'audio/wav',
    words: null,
    metadata: { providerMimeType: mimeType, ...(responseId ? { requestId: responseId } : {}) },
  };
}
