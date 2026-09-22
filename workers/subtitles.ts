/**
 * SUBTITLES stage: deterministic caption segments (text, lines, emphasis,
 * integer-ms timing) built from the scene text and the real narration timings
 * written by VOICE. The SubtitleResult is stored as the job result; no file is
 * written here (RENDER turns it into a styled subtitle file). See
 * lib/subtitles/service.ts.
 */
import type { JobHandler } from '../lib/jobs/types.js';
import { buildVideoSubtitles, type SubtitleResult } from '../lib/subtitles/index.js';

export const subtitlesHandler: JobHandler = async (_job, payload): Promise<SubtitleResult> =>
  buildVideoSubtitles({ videoId: payload.videoId });
