import { createHash } from 'node:crypto';

export interface VoiceCacheInput {
  provider: string;
  model: string;
  voice: string;
  language: string;
  speed: number;
  style: string | undefined;
  /** Already normalized narration. */
  text: string;
}

/** Per-scene cache key: any change to provider, model, voice, language, speed, style or text changes it. */
export function voiceCacheKey(input: VoiceCacheInput): string {
  const parts = [input.provider, input.model, input.voice, input.language, input.speed.toFixed(3), input.style ?? '', input.text];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
