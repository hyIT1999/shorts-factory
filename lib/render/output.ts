/**
 * Output checks and promotion. The rendered file is only accepted when
 * ffprobe confirms the Phase A format and duration; it is then renamed over
 * the previous video.mp4 (same volume, so the rename is atomic), never written
 * in place.
 */
import { mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ProbeInfo } from '../ffmpeg/probe.js';
import { RenderError } from './errors.js';
import { FRAME_COUNT_TOLERANCE, OUTPUT_DURATION_TOLERANCE_MS, RENDER_SPEC } from './types.js';

export interface ExpectedOutput {
  durationMs: number;
  frames: number;
}

const invalid = (message: string) => new RenderError('RENDER_OUTPUT_INVALID', `Rendered video is invalid: ${message}`);

/** "30/1" → 30; "30000/1001" → 29.97; null when unparsable. */
function frameRate(value: string | undefined): number | null {
  const match = /^(\d+)\/(\d+)$/.exec(value ?? '');
  const num = Number(match?.[1]);
  const den = Number(match?.[2]);
  return match && den > 0 ? num / den : null;
}

/** Verifies ffprobe's view of the output; returns the probed duration in ms. */
export function validateProbe(probe: ProbeInfo | null, expected: ExpectedOutput): { probedDurationMs: number } {
  if (!probe) {
    throw invalid('ffprobe could not read it');
  }
  const videos = probe.streams.filter((s) => s.codec_type === 'video');
  const audios = probe.streams.filter((s) => s.codec_type === 'audio');
  const [video] = videos;
  const [audio] = audios;
  if (videos.length !== 1 || !video) {
    throw invalid(`expected 1 video stream, found ${videos.length}`);
  }
  if (video.codec_name !== RENDER_SPEC.videoCodec) {
    throw invalid(`video codec is ${video.codec_name ?? 'unknown'}, expected ${RENDER_SPEC.videoCodec}`);
  }
  if (video.width !== RENDER_SPEC.width || video.height !== RENDER_SPEC.height) {
    throw invalid(`size is ${video.width ?? '?'}×${video.height ?? '?'}, expected ${RENDER_SPEC.width}×${RENDER_SPEC.height}`);
  }
  if (video.pix_fmt !== RENDER_SPEC.pixelFormat) {
    throw invalid(`pixel format is ${video.pix_fmt ?? 'unknown'}, expected ${RENDER_SPEC.pixelFormat}`);
  }
  const fps = frameRate(video.r_frame_rate) ?? frameRate(video.avg_frame_rate);
  if (fps === null || Math.abs(fps - RENDER_SPEC.fps) > 0.01) {
    throw invalid(`frame rate is ${video.r_frame_rate ?? 'unknown'}, expected ${RENDER_SPEC.fps}`);
  }
  if (video.nb_frames !== undefined) {
    const frames = Number(video.nb_frames);
    if (Number.isFinite(frames) && Math.abs(frames - expected.frames) > FRAME_COUNT_TOLERANCE) {
      throw invalid(`${frames} frames, expected ${expected.frames}`);
    }
  }
  if (audios.length !== 1 || !audio) {
    throw invalid(`expected 1 audio stream, found ${audios.length}`);
  }
  if (audio.codec_name !== RENDER_SPEC.audioCodec) {
    throw invalid(`audio codec is ${audio.codec_name ?? 'unknown'}, expected ${RENDER_SPEC.audioCodec}`);
  }
  if (Number(audio.sample_rate) !== RENDER_SPEC.audioSampleRate || audio.channels !== RENDER_SPEC.audioChannels) {
    throw invalid(`audio is ${audio.sample_rate ?? '?'} Hz / ${audio.channels ?? '?'} ch, expected ${RENDER_SPEC.audioSampleRate} Hz stereo`);
  }
  const seconds = Number(probe.format.duration);
  if (!Number.isFinite(seconds)) {
    throw invalid('no duration');
  }
  const probedDurationMs = Math.round(seconds * 1000);
  if (Math.abs(probedDurationMs - expected.durationMs) > OUTPUT_DURATION_TOLERANCE_MS) {
    throw invalid(`lasts ${probedDurationMs} ms, expected ${expected.durationMs} ± ${OUTPUT_DURATION_TOLERANCE_MS} ms`);
  }
  return { probedDurationMs };
}

/** Windows reports these while another process (e.g. a video player) holds the target open. */
const LOCKED_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

export interface PromoteOptions {
  attempts?: number;
  delayMs?: number;
  rename?: (from: string, to: string) => Promise<void>;
}

/** Moves the validated temporary file over the final one; the old file stays until this succeeds. */
export async function promoteOutput(from: string, to: string, options: PromoteOptions = {}): Promise<void> {
  const attempts = options.attempts ?? 5;
  const move = options.rename ?? rename;
  await mkdir(path.dirname(to), { recursive: true });
  for (let attempt = 1; ; attempt++) {
    try {
      await move(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (LOCKED_CODES.has(code) && attempt < attempts) {
        await sleep(options.delayMs ?? 200);
        continue;
      }
      throw new RenderError(
        'RENDER_STORAGE_ERROR',
        LOCKED_CODES.has(code)
          ? 'The previous video.mp4 is in use (close any player showing it); the new render was not saved'
          : `Could not save the rendered video (${code || 'unknown error'})`,
      );
    }
  }
}
