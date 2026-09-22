import { createHash } from 'node:crypto';
import { SPLIT_VERSION } from './split.js';

/**
 * Bump when the narration prompt changes in a way that changes the audio (e.g.
 * the pause instruction): cached narrations are then re-synthesized.
 */
export const NARRATION_KEY_VERSION = 1;

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

const hash = (parts: readonly unknown[]): string => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

/** Per-scene cache key: any change to provider, model, voice, language, speed, style or text changes it. */
export function voiceCacheKey(input: VoiceCacheInput): string {
  return hash([input.provider, input.model, input.voice, input.language, input.speed.toFixed(3), input.style ?? '', input.text]);
}

export interface NarrationCacheInput extends Omit<VoiceCacheInput, 'text'> {
  /** Normalized scene texts in order. */
  texts: readonly string[];
}

/** Whole-narration cache key: any scene text change re-synthesizes the narration. */
export function narrationCacheKey(input: NarrationCacheInput): string {
  return hash([
    'narration',
    NARRATION_KEY_VERSION,
    input.provider,
    input.model,
    input.voice,
    input.language,
    input.speed.toFixed(3),
    input.style ?? '',
    input.texts,
  ]);
}

/**
 * Key of one scene cut out of a narration. It includes the narration file's
 * sha256, so scenes cut from an older narration are never reused next to a
 * new one, and the splitter version, so algorithm changes redo the cuts.
 */
export function sceneSplitKey(narrationSha256: string, sceneIndex: number, sceneCount: number): string {
  return hash(['split', SPLIT_VERSION, narrationSha256, sceneIndex, sceneCount]);
}
