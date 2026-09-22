/**
 * RENDER stage: scene images + narration WAVs + SubtitleResult → one
 * 1080×1920 H.264/AAC MP4 with burned-in subtitles (FFmpeg), stored at
 * data/renders/<projectId>/<videoId>/video.mp4 and in Video.outputPath.
 * See lib/render/service.ts. The job engine marks the video and project
 * COMPLETED after this last stage succeeds.
 */
import type { JobHandler } from '../lib/jobs/types.js';
import { renderVideo, type RenderResult } from '../lib/render/index.js';

export const renderHandler: JobHandler = async (job, payload, { render }): Promise<RenderResult> =>
  renderVideo({ projectId: payload.projectId, videoId: payload.videoId, jobId: job.id }, render);
