/**
 * Controllable provider for tests (VOICE_PROVIDER=mock): durations, failures
 * and raw audio can be overridden per request; every call is recorded.
 *
 * For a narration request (paragraphs): `fail` and `audio` see the whole
 * request once; `durationSec` is asked per paragraph (as a scene request with
 * that paragraph's text and index) and the exact boundaries are returned.
 * Audio supplied through `audio` comes with no boundaries, which exercises
 * the detection path.
 */
import type { VoiceProvider } from '../provider.js';
import type { VoiceRequest, VoiceResult } from '../types.js';
import { silenceWav, silentDurationSec, silentParagraphs } from './silent.js';

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
    const raw = this.options.audio?.(request);
    if (raw) {
      return { audio: raw, mimeType: 'audio/wav', words: null, boundariesSec: null, metadata: { mock: true } };
    }
    const durationOf = (r: VoiceRequest) => this.options.durationSec?.(r) ?? silentDurationSec(r.text, r.speed);
    if (request.paragraphs) {
      const { audio, boundariesSec } = silentParagraphs(
        request.paragraphs.map((text, sceneIndex) => durationOf({ ...request, text, sceneIndex, paragraphs: undefined })),
      );
      return { audio, mimeType: 'audio/wav', words: null, boundariesSec, metadata: { mock: true } };
    }
    return { audio: silenceWav(durationOf(request)), mimeType: 'audio/wav', words: null, metadata: { mock: true } };
  }
}
