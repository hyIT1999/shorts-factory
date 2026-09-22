export type SubtitleErrorCode =
  | 'SUBTITLE_INVALID_SCENE'
  | 'SUBTITLE_INVALID_TIMING'
  | 'SUBTITLE_EMPTY_TEXT'
  | 'SUBTITLE_INVALID_TEXT'
  | 'SUBTITLE_TEXT_NOT_VIETNAMESE'
  | 'SUBTITLE_UNSUPPORTED_LANGUAGE'
  | 'SUBTITLE_GENERATION_ERROR';

/** Non-fatal issues: recorded in SubtitleResult.warnings, the job still succeeds. */
export type SubtitleWarningCode = 'SUBTITLE_INVALID_EMPHASIS' | 'SUBTITLE_LINE_OVERFLOW' | 'SUBTITLE_SHORT_SCENE';

/**
 * A SUBTITLES failure with a short, safe message. It ends up in Job.error and
 * is shown in the UI.
 */
export class SubtitleError extends Error {
  constructor(
    readonly code: SubtitleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SubtitleError';
  }
}
