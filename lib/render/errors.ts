export type RenderErrorCode =
  | 'RENDER_CONFIG'
  | 'RENDER_FFMPEG_NOT_FOUND'
  | 'RENDER_FFPROBE_NOT_FOUND'
  | 'RENDER_FFMPEG_UNSUPPORTED'
  | 'RENDER_FONT_MISSING'
  | 'RENDER_INVALID_VIDEO'
  | 'RENDER_INVALID_SCENE'
  | 'RENDER_MISSING_VISUAL_ASSET'
  | 'RENDER_INVALID_IMAGE'
  | 'RENDER_MISSING_AUDIO_ASSET'
  | 'RENDER_SUBTITLES_MISSING'
  | 'RENDER_SUBTITLES_INVALID'
  | 'RENDER_SUBTITLES_STALE'
  | 'RENDER_FFMPEG_FAILED'
  | 'RENDER_TIMEOUT'
  | 'RENDER_OUTPUT_INVALID'
  | 'RENDER_STORAGE_ERROR'
  | 'RENDER_GENERATION_ERROR';

/**
 * A RENDER failure with a short, safe message. It ends up in Job.error and is
 * shown in the UI, so it never contains secrets or absolute paths.
 */
export class RenderError extends Error {
  constructor(
    readonly code: RenderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RenderError';
  }
}
