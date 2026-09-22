/**
 * Input validation (scenes and timings after VOICE) and output invariants.
 * Input problems are the pipeline's fault upstream and fail the job with a
 * specific code; a broken invariant in the output is a bug in SUBTITLES and
 * fails with SUBTITLE_GENERATION_ERROR.
 */
import { SubtitleError } from './errors.js';
import { charLength } from './tokenize.js';
import { toMs } from './timing.js';
import {
  MAX_CHARS_PER_LINE,
  MAX_SCENES,
  MAX_SEGMENTS,
  TIMING_TOLERANCE_MS,
  type SubtitleInput,
  type SubtitleResult,
} from './types.js';

/** The Scene columns SUBTITLES reads. */
export interface SceneRow {
  id: string;
  index: number;
  text: string;
  duration: number | null;
  startTime: number | null;
  endTime: number | null;
  subtitleEmphasisJson: string | null;
  voiceAssetId: string | null;
  voiceAsset: { status: string; type: string } | null;
}

/** Scenes sorted by index, which must run 0..n-1 without gaps or duplicates. */
export function orderScenes<T extends { index: number }>(scenes: readonly T[]): T[] {
  if (scenes.length === 0) {
    throw new SubtitleError('SUBTITLE_INVALID_SCENE', 'Video has no scenes; SCENES stage must run first');
  }
  if (scenes.length > MAX_SCENES) {
    throw new SubtitleError('SUBTITLE_GENERATION_ERROR', `Video has ${scenes.length} scenes; subtitles support at most ${MAX_SCENES}`);
  }
  const sorted = [...scenes].sort((a, b) => a.index - b.index);
  sorted.forEach((scene, position) => {
    if (position > 0 && scene.index === sorted[position - 1]?.index) {
      throw new SubtitleError('SUBTITLE_INVALID_SCENE', `Scene index ${scene.index} appears more than once`);
    }
    if (scene.index !== position) {
      throw new SubtitleError('SUBTITLE_INVALID_SCENE', `Scene indexes must be contiguous from 0 (found ${scene.index} at position ${position})`);
    }
  });
  return sorted;
}

const finite = (value: number | null): value is number => value !== null && Number.isFinite(value);

/**
 * Checks that every scene carries real audio timing from VOICE (audio READY,
 * contiguous from 0, matching Video.duration) and returns it in integer ms.
 */
export function sceneTimingsMs(
  scenes: readonly SceneRow[],
  videoDurationSec: number | null,
): { startMs: number; endMs: number }[] {
  const timings: { startMs: number; endMs: number }[] = [];
  let previousEnd = 0;
  for (const scene of scenes) {
    const label = `Scene ${scene.index + 1}`;
    if (!scene.voiceAssetId) {
      throw new SubtitleError('SUBTITLE_INVALID_TIMING', `${label} has no narration audio; VOICE must complete first`);
    }
    if (scene.voiceAsset?.status !== 'READY' || scene.voiceAsset.type !== 'audio') {
      throw new SubtitleError('SUBTITLE_INVALID_TIMING', `${label} narration audio is not ready`);
    }
    if (!finite(scene.startTime) || !finite(scene.endTime) || !finite(scene.duration)) {
      throw new SubtitleError('SUBTITLE_INVALID_TIMING', `${label} has no valid timing`);
    }
    const startMs = toMs(scene.startTime);
    const endMs = toMs(scene.endTime);
    if (endMs <= startMs) {
      throw new SubtitleError('SUBTITLE_INVALID_TIMING', `${label} ends before it starts`);
    }
    if (Math.abs(toMs(scene.duration) - (endMs - startMs)) > TIMING_TOLERANCE_MS) {
      throw new SubtitleError('SUBTITLE_INVALID_TIMING', `${label} duration does not match its start/end times`);
    }
    if (startMs !== previousEnd) {
      throw new SubtitleError(
        'SUBTITLE_INVALID_TIMING',
        timings.length === 0 ? `${label} must start at 0` : `${label} does not start where the previous scene ends`,
      );
    }
    timings.push({ startMs, endMs });
    previousEnd = endMs;
  }
  if (!finite(videoDurationSec) || Math.abs(toMs(videoDurationSec) - previousEnd) > TIMING_TOLERANCE_MS) {
    throw new SubtitleError('SUBTITLE_INVALID_TIMING', 'Video duration does not match the end of the last scene');
  }
  return timings;
}

function broken(message: string): never {
  throw new SubtitleError('SUBTITLE_GENERATION_ERROR', `Subtitle invariant failed: ${message}`);
}

/** Verifies the generated result against its input (ordering, coverage, text reconstruction). */
export function assertResultInvariants(result: SubtitleResult, input: SubtitleInput): void {
  const { segments } = result;
  if (segments.length > MAX_SEGMENTS) {
    broken(`${segments.length} segments (max ${MAX_SEGMENTS})`);
  }
  let cursor = 0;
  let position = 0;
  for (const scene of input.scenes) {
    const words = scene.text.split(' ');
    const own: SubtitleResult['segments'] = [];
    while (segments[position]?.sceneIndex === scene.index) {
      own.push(segments[position] as SubtitleResult['segments'][number]);
      position++;
    }
    if (own.length === 0) {
      broken(`scene ${scene.index} has no segments`);
    }
    if (own[0]?.startMs !== scene.startMs || own.at(-1)?.endMs !== scene.endMs) {
      broken(`scene ${scene.index} segments do not cover the scene`);
    }
    let wordCursor = 0;
    own.forEach((segment, k) => {
      const where = `segment ${segment.id}`;
      if (segment.sceneId !== scene.id || segment.indexInScene !== k || segment.id !== `${scene.index}.${k}`) {
        broken(`${where} has a wrong id or order`);
      }
      if (segment.startMs !== cursor || segment.endMs <= segment.startMs) {
        broken(`${where} overlaps, leaves a gap or has no duration`);
      }
      cursor = segment.endMs;
      const [from, to] = segment.wordRange;
      if (from !== wordCursor || to <= from || words.slice(from, to).join(' ') !== segment.text) {
        broken(`${where} word range does not match its text`);
      }
      wordCursor = to;
      if (segment.lines.map((line) => line.text).join(' ') !== segment.text) {
        broken(`${where} lines do not rebuild the text`);
      }
      for (const line of segment.lines) {
        if (line.spans.map((span) => span.text).join('') !== line.text) {
          broken(`${where} spans do not rebuild the line`);
        }
        if (charLength(line.text) > MAX_CHARS_PER_LINE && line.text.includes(' ')) {
          broken(`${where} has a line longer than ${MAX_CHARS_PER_LINE} characters`);
        }
      }
    });
    if (wordCursor !== words.length || own.map((segment) => segment.text).join(' ') !== scene.text) {
      broken(`scene ${scene.index} segments do not rebuild the scene text`);
    }
  }
  if (position !== segments.length) {
    broken('segments are not sorted by scene');
  }
  if (segments[0]?.startMs !== 0 || cursor !== result.durationMs) {
    broken('segments do not cover the whole video');
  }
}
