import type { VoiceRequest, VoiceResult } from './types.js';

/**
 * A text-to-speech backend. It only turns text into audio bytes; validation,
 * caching, storage, database and timing are handled by the voice service.
 */
export interface VoiceProvider {
  readonly name: string;
  readonly model: string;
  /** Languages this provider can speak; undefined means "any". */
  readonly supportedLanguages?: ReadonlySet<string>;
  synthesize(request: VoiceRequest): Promise<VoiceResult>;
}
