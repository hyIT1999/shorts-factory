/**
 * Subtitles (Phase A): deterministic caption segments from scene text and the
 * real narration timings. Public API for the SUBTITLES worker and, later,
 * RENDER (which validates Job.resultJson with SubtitleResultSchema).
 */
export { SubtitleError, type SubtitleErrorCode, type SubtitleWarningCode } from './errors.js';
export { buildVideoSubtitles, generateSubtitles } from './service.js';
export {
  MAX_CHARS_PER_LINE,
  MAX_LINES,
  SUBTITLE_ALGORITHM,
  SubtitleResultSchema,
  type SubtitleInput,
  type SubtitleLine,
  type SubtitleResult,
  type SubtitleSceneInput,
  type SubtitleSegment,
  type SubtitleSpan,
  type SubtitleWarning,
} from './types.js';
