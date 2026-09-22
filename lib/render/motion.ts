/**
 * Ken Burns motion for still images (Phase C1): a slow zoom or pan per scene,
 * rendered by FFmpeg's zoompan filter. Everything here is pure and
 * deterministic: a scene's preset comes from a hash of the video id and the
 * scene index, so a re-run reproduces the same frames.
 *
 * zoompan takes ONE input frame and emits exactly `d` output frames for it
 * (measured on FFmpeg 9.0.2: d=90 → 90 frames with pts 0..89 in a 1/fps time
 * base), so the loop filter of the static chain is not used and the frame
 * counts of lib/render/timeline.ts stay exact. zoompan crops the source on
 * whole pixels, which would make slow pans jitter; two things prevent that:
 * the source is supersampled (RENDER_MOTION_SCALE, default 2×) and kept in
 * 4:4:4 so no chroma alignment rounds x/y, and pans advance by a whole number
 * of source pixels per frame with a zoom chosen so the crop window never hits
 * the edge (zoompan would clamp it and the motion would stall).
 */
import { createHash } from 'node:crypto';
import { RenderError } from './errors.js';
import { MAX_MOTION_SCALE, MIN_MOTION_SCALE, RENDER_SPEC, type MotionPreset } from './types.js';

/** Pixel format of the supersampled source handed to zoompan. */
export const MOTION_SOURCE_PIXEL_FORMAT = 'yuv444p';
/** Zoom presets travel between 1.00 and 1 + ZOOM_RANGE over the scene. */
export const ZOOM_RANGE = 0.1;
/** Scenes shorter than this many frames pan 2 source px/frame (at scale ≥ 2), longer ones 1 px/frame. */
export const SHORT_SCENE_FRAMES = 120;
/** A pan never travels more than this share of the source axis (keeps the zoom it needs under ~1.34). */
export const MAX_PAN_TRAVEL_RATIO = 0.25;

const ZOOM_PRESETS: readonly MotionPreset[] = ['zoom-in', 'zoom-out'];
const HORIZONTAL_PANS: readonly MotionPreset[] = ['pan-left', 'pan-right'];

export function assertMotionScale(scale: number): void {
  if (!Number.isInteger(scale) || scale < MIN_MOTION_SCALE || scale > MAX_MOTION_SCALE) {
    throw new RenderError('RENDER_GENERATION_ERROR', `Motion scale must be a whole number from ${MIN_MOTION_SCALE} to ${MAX_MOTION_SCALE}`);
  }
}

/** Size of the supersampled source: scale × the output size. */
export function motionSourceSize(scale: number): { width: number; height: number } {
  assertMotionScale(scale);
  return { width: RENDER_SPEC.width * scale, height: RENDER_SPEC.height * scale };
}

/**
 * The raw preset cycle of a video: zoom-in, pan, zoom-out, pan, … starting at
 * a hash-chosen offset, with the axis and direction of every pan also taken
 * from the hash. Two consecutive scenes never share a preset.
 */
export function motionPresets(videoId: string, sceneCount: number, forced: MotionPreset | 'auto' = 'auto'): MotionPreset[] {
  if (forced !== 'auto') {
    return Array.from({ length: sceneCount }, () => forced);
  }
  const hash = createHash('sha256').update(videoId).digest();
  const offset = (hash[0] ?? 0) % 4;
  return Array.from({ length: sceneCount }, (_, index) => {
    const slot = (index + offset) % 4;
    if (slot === 0) {
      return 'zoom-in';
    }
    if (slot === 2) {
      return 'zoom-out';
    }
    const bits = hash[(1 + index) % hash.length] ?? 0;
    const vertical = (bits & 1) === 1;
    const reverse = (bits & 2) === 2;
    if (vertical) {
      return reverse ? 'pan-up' : 'pan-down';
    }
    return reverse ? 'pan-left' : 'pan-right';
  });
}

export interface PanParameters {
  /** Source pixels the crop window moves per frame. */
  step: number;
  /** Total travel in source pixels over the scene (step × (frames − 1)). */
  travel: number;
  /** Constant zoom that leaves room for the travel: the crop window never reaches the edge. */
  zoom: number;
}

function panStep(frames: number, scale: number): number {
  return scale >= 2 && frames < SHORT_SCENE_FRAMES ? 2 : 1;
}

/** Rounds up to 3 decimals: what the zoom expression carries. */
const ceil3 = (value: number): number => Math.ceil(value * 1000) / 1000;

/**
 * Whole-pixel pan along an axis of `axisSize` source pixels. The zoom is the
 * smallest 3-decimal value with axisSize − floor(axisSize / zoom) ≥ travel + 2,
 * so x/y = step × on stays inside zoompan's clamp range for every frame.
 */
export function panParameters(frames: number, scale: number, axisSize: number): PanParameters {
  const step = panStep(frames, scale);
  const travel = step * Math.max(frames - 1, 0);
  const zoom = ceil3(axisSize / (axisSize - travel - 2));
  return { step, travel, zoom };
}

/** True when a pan of this length keeps its zoom modest (travel within MAX_PAN_TRAVEL_RATIO of the axis). */
export function panFits(frames: number, scale: number, axisSize: number): boolean {
  return panParameters(frames, scale, axisSize).travel <= Math.floor(axisSize * MAX_PAN_TRAVEL_RATIO);
}

/**
 * The final preset of every scene: the raw cycle, except that a scene too long
 * to pan across at a whole pixel per frame zooms instead (in for right/down,
 * out for left/up), so the cycle still alternates.
 */
export function resolveMotionPresets(
  videoId: string,
  frames: readonly number[],
  scale: number,
  forced: MotionPreset | 'auto' = 'auto',
): MotionPreset[] {
  const { width, height } = motionSourceSize(scale);
  return motionPresets(videoId, frames.length, forced).map((preset, index) => {
    if (ZOOM_PRESETS.includes(preset)) {
      return preset;
    }
    const axis = HORIZONTAL_PANS.includes(preset) ? width : height;
    if (panFits(frames[index] ?? 1, scale, axis)) {
      return preset;
    }
    return preset === 'pan-left' || preset === 'pan-up' ? 'zoom-out' : 'zoom-in';
  });
}

/**
 * The zoompan filter of one scene: `frames` output frames at the output size,
 * expressions in `on` (output frame index) only, with fixed numbers otherwise.
 */
export function zoompanFilter(preset: MotionPreset, frames: number, scale: number): string {
  if (!Number.isInteger(frames) || frames < 1) {
    throw new RenderError('RENDER_GENERATION_ERROR', 'A scene needs at least one frame of motion');
  }
  const { width, height } = motionSourceSize(scale);
  const steps = Math.max(frames - 1, 1);
  let z: string;
  let x = 'iw/2-(iw/zoom/2)';
  let y = 'ih/2-(ih/zoom/2)';
  switch (preset) {
    case 'zoom-in':
      z = `1+${ZOOM_RANGE}*on/${steps}`;
      break;
    case 'zoom-out':
      z = `${1 + ZOOM_RANGE}-${ZOOM_RANGE}*on/${steps}`;
      break;
    case 'pan-right':
    case 'pan-left': {
      const pan = panParameters(frames, scale, width);
      z = String(pan.zoom);
      x = preset === 'pan-right' ? `${pan.step}*on` : `${pan.travel}-${pan.step}*on`;
      break;
    }
    case 'pan-down':
    case 'pan-up': {
      const pan = panParameters(frames, scale, height);
      z = String(pan.zoom);
      y = preset === 'pan-down' ? `${pan.step}*on` : `${pan.travel}-${pan.step}*on`;
      break;
    }
  }
  return `zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${RENDER_SPEC.width}x${RENDER_SPEC.height}:fps=${RENDER_SPEC.fps}`;
}
