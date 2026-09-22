import { z } from 'zod';

export const MIN_SPEED = 0.5;
export const MAX_SPEED = 2;
export const DEFAULT_SPEED = 1;

/** VOICE_MODE: one TTS request for the whole narration (split afterwards) or one per scene. */
export type VoiceMode = 'narration' | 'scene';

/** A narration request: one scene, or the whole video when `paragraphs` is set. */
export interface VoiceRequest {
  /** Normalized narration; in narration mode the paragraphs joined by blank lines. */
  text: string;
  /** Primary language subtag, e.g. "vi". */
  language: string;
  /** Provider voice id (from config, e.g. GEMINI_TTS_VOICE). */
  voice: string;
  /** 0.5–2, 1 = normal. */
  speed: number;
  /** Optional delivery hint, e.g. the Channel DNA tone. */
  style?: string;
  /** Scene being voiced (0 for a whole-narration request); used in logs and file names. */
  sceneIndex: number;
  /** Narration mode: the scene texts in order; the provider is asked to pause between them. */
  paragraphs?: readonly string[];
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
  /**
   * Narration mode: exact paragraph boundaries in seconds (length = paragraphs − 1) when the
   * provider knows them (silent/mock build the audio paragraph by paragraph); null/absent means
   * the boundaries must be detected from the audio.
   */
  boundariesSec?: readonly number[] | null;
  /** Provider extras (requestId, provider mime type…). */
  metadata: Record<string, unknown>;
}

export type BoundaryQuality = 'detected' | 'relaxed' | 'estimated';

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
  /** Absent in results stored before narration mode existed. */
  mode: z.enum(['narration', 'scene']).optional(),
  /** TTS requests made by this run (0 when everything came from cache). */
  ttsCalls: z.number().int().min(0).optional(),
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
        /** Narration mode: how the cut at the END of this scene was found (null for the last scene). */
        boundary: z
          .object({ quality: z.enum(['detected', 'relaxed', 'estimated']), silenceMs: z.number().min(0) })
          .nullable()
          .optional(),
      }),
    )
    .min(1),
});

export type VoiceJobResult = z.infer<typeof VoiceJobResultSchema>;
