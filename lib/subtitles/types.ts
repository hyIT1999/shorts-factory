import { z } from 'zod';
import type { WordTiming } from '../voice/types.js';

/** Bump when the segmentation/timing rules or their constants change. */
export const SUBTITLE_ALGORITHM = 'proportional-v1';
export const MAX_LINES = 2;
/** Safe width 1080 − 2×90 px at ~72 px bold sans ≈ 22 characters. */
export const MAX_CHARS_PER_LINE = 22;

export const TARGET_SEGMENT_SEC = 2.2;
export const MIN_SEGMENT_MS = 800;
export const MAX_SEGMENT_SEC = 3.5;

export const MAX_SCENES = 20;
export const MAX_SCENE_CHARS = 1000;
export const MAX_SEGMENTS = 300;
/** Allowed rounding difference between scene timings and Video.duration. */
export const TIMING_TOLERANCE_MS = 1;

export const SUPPORTED_LANGUAGES: ReadonlySet<string> = new Set(['vi', 'en']);

export type BoundaryType = 'SENTENCE' | 'CLAUSE' | 'COMMA' | 'CONNECTOR' | 'NONE';

/** Extra timing weight (in syllables) for the pause after a boundary. */
export const PAUSE_WEIGHT: Record<BoundaryType, number> = {
  SENTENCE: 1.5,
  CLAUSE: 1.0,
  COMMA: 0.7,
  CONNECTOR: 0,
  NONE: 0,
};

/** One whitespace-separated word of a scene; punctuation stays attached. */
export interface SubtitleToken {
  text: string;
  /** Position within the scene (0-based). */
  index: number;
  /** Text without leading/trailing punctuation ("" for pure symbols). */
  core: string;
  syllableWeight: number;
  boundaryAfter: BoundaryType;
  /** Breaking after this token splits a unit (number + unit, brackets, emphasis). */
  noBreakAfter: boolean;
  /** A bare function word ("của", "và", "the"…) that should not end a line or segment. */
  functionWord: boolean;
}

/** A scene prepared for subtitle generation (text normalized, timings in ms). */
export interface SubtitleSceneInput {
  id: string;
  index: number;
  text: string;
  startMs: number;
  endMs: number;
  /** Raw Scene.subtitleEmphasisJson. */
  emphasisJson: string | null;
}

export interface SubtitleInput {
  videoId: string;
  language: string;
  scenes: SubtitleSceneInput[];
}

const WordTimingSchema: z.ZodType<WordTiming> = z.strictObject({
  word: z.string(),
  startSec: z.number().min(0),
  endSec: z.number().min(0),
});

const SpanSchema = z.strictObject({ text: z.string().min(1), emphasis: z.boolean() });
const LineSchema = z.strictObject({ text: z.string().min(1), spans: z.array(SpanSchema).min(1) });
const ms = z.number().int().min(0);

const SegmentSchema = z.strictObject({
  /** `${sceneIndex}.${indexInScene}` */
  id: z.string().min(1),
  sceneId: z.string().min(1),
  sceneIndex: z.number().int().min(0),
  indexInScene: z.number().int().min(0),
  startMs: ms,
  endMs: ms,
  text: z.string().min(1),
  /** [from, to) over the scene's tokens, for mapping word timings later. */
  wordRange: z.tuple([z.number().int().min(0), z.number().int().min(1)]),
  lines: z.array(LineSchema).min(1).max(MAX_LINES),
  /** Phase C (karaoke). Never produced in Phase A. */
  words: z.array(WordTimingSchema).optional(),
});

/** Contract of the SUBTITLES Job.resultJson (all times in integer milliseconds). */
export const SubtitleResultSchema = z.strictObject({
  version: z.literal(1),
  algorithm: z.literal(SUBTITLE_ALGORITHM),
  videoId: z.string().min(1),
  language: z.string().min(1),
  durationMs: z.number().int().positive(),
  inputHash: z.string().regex(/^[0-9a-f]{64}$/),
  timing: z.literal('segment'),
  layout: z.strictObject({
    maxLines: z.literal(MAX_LINES),
    maxCharsPerLine: z.number().int().positive(),
  }),
  segments: z.array(SegmentSchema).min(1).max(MAX_SEGMENTS),
  warnings: z.array(
    z.strictObject({
      code: z.string().min(1),
      sceneIndex: z.number().int().min(0).optional(),
      message: z.string(),
    }),
  ),
});

export type SubtitleResult = z.infer<typeof SubtitleResultSchema>;
export type SubtitleSegment = SubtitleResult['segments'][number];
export type SubtitleLine = SubtitleSegment['lines'][number];
export type SubtitleSpan = SubtitleLine['spans'][number];
export type SubtitleWarning = SubtitleResult['warnings'][number];
