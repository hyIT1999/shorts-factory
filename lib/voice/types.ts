import { z } from 'zod';

export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2;
export const DEFAULT_SPEED = 1;

/** One scene's narration request. */
export interface VoiceRequest {
  text: string;
  /** Primary language subtag, e.g. "vi". */
  language: string;
  /** Provider voice id (from config, e.g. GEMINI_TTS_VOICE). */
  voice: string;
  /** 0.5–2, 1 = normal. */
  speed: number;
  /** Optional delivery hint, e.g. the Channel DNA tone. */
  style?: string;
  sceneIndex: number;
}

export interface WordTiming {
  word: string;
  startSec: number;
  endSec: number;
}

/** What a provider returns: encoded audio bytes, never a file path. */
export interface VoiceResult {
  /** Complete WAV file (PCM 16-bit). */
  audio: Uint8Array;
  mimeType: 'audio/wav';
  /** Word timestamps when the provider supplies them (none in Phase A). */
  words: WordTiming[] | null;
  /** Provider extras (requestId, provider mime type…). */
  metadata: Record<string, unknown>;
}

const relativePath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.includes('\\') && !p.split('/').includes('..'), {
    message: 'localPath must be a relative POSIX path inside data/',
  });

/** Contract of the VOICE Job.resultJson (paths relative to data/, timings in seconds). */
export const VoiceJobResultSchema = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1),
  videoId: z.string().min(1),
  durationSec: z.number().positive(),
  scenes: z
    .array(
      z.strictObject({
        sceneIndex: z.number().int().min(0),
        sceneId: z.string().min(1),
        audioAssetId: z.string().min(1),
        localPath: relativePath,
        durationSec: z.number().positive(),
        startTime: z.number().min(0),
        endTime: z.number().positive(),
        /** true when valid cached audio was reused (no TTS call). */
        cached: z.boolean(),
        words: z.null(),
      }),
    )
    .min(1),
});

export type VoiceJobResult = z.infer<typeof VoiceJobResultSchema>;
