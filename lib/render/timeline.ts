/**
 * Frame timeline. Frame counts come from the absolute scene boundaries, never
 * from per-scene durations, so rounding cannot accumulate: scene k covers
 * frames [frame(start_k), frame(end_k)) and the last boundary is exactly
 * frame(Video.duration). Rounding each scene's own duration instead (ceil for
 * `-loop 1 -t`) drifts by up to a frame per scene.
 */
import { RenderError } from './errors.js';
import { RENDER_SPEC } from './types.js';

/** Index of the frame at `ms` (integer milliseconds). */
export function frameAt(ms: number, fps: number = RENDER_SPEC.fps): number {
  return Math.round((ms * fps) / 1000);
}

/**
 * Frames for each scene from contiguous [startMs, endMs] boundaries; the last
 * scene ends at frameAt(totalMs). Every scene must get at least one frame.
 */
export function sceneFrameCounts(
  scenes: readonly { startMs: number; endMs: number }[],
  totalMs: number,
  fps: number = RENDER_SPEC.fps,
): number[] {
  return scenes.map((scene, i) => {
    const end = i === scenes.length - 1 ? frameAt(totalMs, fps) : frameAt(scene.endMs, fps);
    const frames = end - frameAt(scene.startMs, fps);
    if (frames < 1) {
      throw new RenderError('RENDER_INVALID_SCENE', `Scene ${i + 1} is shorter than one video frame`);
    }
    return frames;
  });
}
