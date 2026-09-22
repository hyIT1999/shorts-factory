/**
 * The SubtitleResult RENDER burns in: the latest COMPLETED SUBTITLES job
 * result, validated with its schema. It must still describe the current
 * scenes: the input hash is recomputed from the database (deterministic,
 * read-only, no AI). A mismatch fails with RENDER_SUBTITLES_STALE; RENDER never
 * regenerates subtitles itself.
 */
import { JobType } from '../generated/prisma/client.js';
import { getCompletedJobResult } from '../jobs/results.js';
import { SubtitleError } from '../subtitles/errors.js';
import { buildVideoSubtitles } from '../subtitles/service.js';
import { SubtitleResultSchema, type SubtitleResult } from '../subtitles/types.js';
import { RenderError } from './errors.js';

export async function loadSubtitles(videoId: string, durationMs: number): Promise<SubtitleResult> {
  const raw = await getCompletedJobResult(videoId, JobType.SUBTITLES);
  if (raw === null) {
    throw new RenderError('RENDER_SUBTITLES_MISSING', 'No completed SUBTITLES result for this video');
  }
  const parsed = SubtitleResultSchema.safeParse(raw);
  if (!parsed.success || parsed.data.videoId !== videoId) {
    throw new RenderError('RENDER_SUBTITLES_INVALID', 'The SUBTITLES result is not a valid subtitle result for this video; re-run SUBTITLES');
  }

  let current: SubtitleResult;
  try {
    current = await buildVideoSubtitles({ videoId });
  } catch (error) {
    if (error instanceof SubtitleError) {
      throw new RenderError('RENDER_SUBTITLES_STALE', `Subtitles no longer match the video: ${error.message}`);
    }
    throw error;
  }
  if (current.inputHash !== parsed.data.inputHash || parsed.data.durationMs !== durationMs) {
    throw new RenderError(
      'RENDER_SUBTITLES_STALE',
      'Subtitles are out of date (scene text, timing or emphasis changed since SUBTITLES ran); re-run SUBTITLES',
    );
  }
  return parsed.data;
}
