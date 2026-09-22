/**
 * Controllable provider for tests (VOICE_PROVIDER=mock): durations, failures
 * and raw audio can be overridden per request; every call is recorded.
 */
import type { VoiceProvider } from '../provider.js';
import type { VoiceRequest, VoiceResult } from '../types.js';
import { silenceWav, silentDurationSec } from './silent.js';

export interface MockVoiceOptions {
  /** Audio length for a request (default: the silent estimate). */
  durationSec?: (request: VoiceRequest) => number;
  /** Throw to simulate a failure for a request. */
  fail?: (request: VoiceRequest) => Error | undefined;
  /** Replace the returned audio bytes (e.g. corrupt data). */
  audio?: (request: VoiceRequest) => Uint8Array;
  supportedLanguages?: ReadonlySet<string>;
}

export class MockVoiceProvider implements VoiceProvider {
  readonly name = 'mock';
  readonly model = 'mock-tts';
  readonly supportedLanguages?: ReadonlySet<string>;
  readonly calls: VoiceRequest[] = [];

  constructor(private readonly options: MockVoiceOptions = {}) {
    if (options.supportedLanguages) {
      this.supportedLanguages = options.supportedLanguages;
    }
  }

  async synthesize(request: VoiceRequest): Promise<VoiceResult> {
    this.calls.push(request);
    const failure = this.options.fail?.(request);
    if (failure) {
      throw failure;
    }
    const audio =
      this.options.audio?.(request) ??
      silenceWav(this.options.durationSec?.(request) ?? silentDurationSec(request.text, request.speed));
    return { audio, mimeType: 'audio/wav', words: null, metadata: { mock: true } };
  }
}
