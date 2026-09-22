/**
 * Silent provider for tests and offline development only (VOICE_PROVIDER=silent).
 * Produces a valid WAV of silence whose length is estimated from the text, so
 * timing logic works without any API. A narration request (paragraphs) is
 * built paragraph by paragraph, so the exact boundaries are returned and no
 * silence detection is needed. Never used automatically as a fallback.
 */
import type { VoiceProvider } from '../provider.js';
import { estimateSpeechSeconds } from '../text.js';
import type { VoiceRequest, VoiceResult } from '../types.js';
import { encodeWav } from '../wav.js';

export const SILENT_SAMPLE_RATE = 24_000;

/** Deterministic duration (seconds, 0.1 s precision) for a narration at a given speed. */
export function silentDurationSec(text: string, speed = 1): number {
  return Math.round((estimateSpeechSeconds(text) / speed) * 10) / 10;
}

export function silenceWav(durationSec: number, sampleRate = SILENT_SAMPLE_RATE): Buffer {
  const samples = Math.round(durationSec * sampleRate);
  return encodeWav(new Uint8Array(samples * 2), { sampleRate, channels: 1, bitsPerSample: 16 });
}

/**
 * One silent WAV whose paragraphs last `durations[k]` seconds each, plus the
 * boundaries between them (cumulative, in seconds).
 */
export function silentParagraphs(durations: readonly number[], sampleRate = SILENT_SAMPLE_RATE): { audio: Buffer; boundariesSec: number[] } {
  const boundariesSec: number[] = [];
  let cursor = 0;
  durations.forEach((seconds, k) => {
    cursor = Math.round((cursor + seconds) * 10) / 10;
    if (k < durations.length - 1) {
      boundariesSec.push(cursor);
    }
  });
  return { audio: silenceWav(cursor, sampleRate), boundariesSec };
}

export class SilentVoiceProvider implements VoiceProvider {
  readonly name = 'silent';
  readonly model = 'silent-v1';

  async synthesize(request: VoiceRequest): Promise<VoiceResult> {
    if (request.paragraphs) {
      const { audio, boundariesSec } = silentParagraphs(request.paragraphs.map((text) => silentDurationSec(text, request.speed)));
      return { audio, mimeType: 'audio/wav', words: null, boundariesSec, metadata: { silent: true } };
    }
    return {
      audio: silenceWav(silentDurationSec(request.text, request.speed)),
      mimeType: 'audio/wav',
      words: null,
      metadata: { silent: true },
    };
  }
}
