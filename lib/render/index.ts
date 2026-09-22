/**
 * RENDER: FFmpeg composition of scene images (still, or moved by Ken Burns
 * zoom/pan), narration WAVs and burned-in subtitles into a vertical MP4.
 * Configuration comes from the environment; the mock provider is only used
 * when configured explicitly.
 */
import path from 'node:path';
import type { LocalAssetStorage } from '../assets/storage.js';
import { runProcess } from '../ffmpeg/process.js';
import { RenderError } from './errors.js';
import {
  DEFAULT_FONTS_DIR,
  DEFAULT_MOTION_SCALE,
  DEFAULT_RENDER_TIMEOUT_MS,
  MAX_MOTION_SCALE,
  MIN_MOTION_SCALE,
  MOTION_MODES,
  MOTION_PRESETS,
  type MotionConfig,
  type MotionMode,
  type MotionPreset,
  type RenderProviderName,
  type RenderServices,
} from './types.js';

export { RenderError, type RenderErrorCode } from './errors.js';
export { renderVideo, type RenderJobInput } from './service.js';
export { RenderResultSchema, RENDER_SPEC, type MotionConfig, type RenderResult, type RenderServices } from './types.js';

/** FFMPEG_PATH / FFPROBE_PATH: an executable, or the bare name found on PATH. */
function toolPath(value: string | undefined, fallback: string, name: string): string {
  const configured = value?.trim() || fallback;
  if (/\.(cmd|bat)$/i.test(configured)) {
    // Node refuses to spawn .cmd/.bat files without a shell, and a shell is never used here.
    throw new RenderError('RENDER_CONFIG', `${name} must point to the executable (e.g. ffmpeg.exe), not a .cmd/.bat wrapper`);
  }
  return configured;
}

/**
 * RENDER_MOTION: "kenburns" (default: a slow zoom or pan per scene) or "off"
 * (still images, the Phase A chain). RENDER_MOTION_SCALE (default 2): how much
 * the source is supersampled before zoompan, 1 is about twice as fast but pans
 * a little less smoothly. RENDER_MOTION_PRESET (default "auto"): force one
 * preset for every scene.
 */
export function motionConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MotionConfig {
  const mode = (env['RENDER_MOTION'] ?? 'kenburns').trim().toLowerCase() || 'kenburns';
  if (!(MOTION_MODES as readonly string[]).includes(mode)) {
    throw new RenderError('RENDER_CONFIG', `Unknown RENDER_MOTION "${mode}" (use "kenburns" or "off")`);
  }
  const rawScale = env['RENDER_MOTION_SCALE']?.trim();
  const scale = rawScale ? Number(rawScale) : DEFAULT_MOTION_SCALE;
  if (!Number.isInteger(scale) || scale < MIN_MOTION_SCALE || scale > MAX_MOTION_SCALE) {
    throw new RenderError('RENDER_CONFIG', `RENDER_MOTION_SCALE must be a whole number from ${MIN_MOTION_SCALE} to ${MAX_MOTION_SCALE}`);
  }
  const preset = (env['RENDER_MOTION_PRESET'] ?? 'auto').trim().toLowerCase() || 'auto';
  if (preset !== 'auto' && !(MOTION_PRESETS as readonly string[]).includes(preset)) {
    throw new RenderError('RENDER_CONFIG', `Unknown RENDER_MOTION_PRESET "${preset}" (use "auto" or one of ${MOTION_PRESETS.join(', ')})`);
  }
  return { mode: mode as MotionMode, scale, preset: preset as MotionPreset | 'auto' };
}

/**
 * RENDER_PROVIDER: "ffmpeg" (default) or "mock" (tests; writes no video).
 * FFMPEG_PATH / FFPROBE_PATH (default: on PATH), RENDER_TIMEOUT_MS (default
 * 10 min), RENDER_FONTS_DIR (default templates/documentary/fonts, relative to
 * the working directory like DATA_DIR), RENDER_THREADS (encoder threads;
 * default 0 = all cores, lower it when other work shares the machine), and
 * the RENDER_MOTION* variables (motionConfigFromEnv).
 */
export function createRenderServicesFromEnv(storage: LocalAssetStorage, env: NodeJS.ProcessEnv = process.env): RenderServices {
  const provider = (env['RENDER_PROVIDER'] ?? 'ffmpeg').trim().toLowerCase() || 'ffmpeg';
  if (provider !== 'ffmpeg' && provider !== 'mock') {
    throw new RenderError('RENDER_CONFIG', `Unknown RENDER_PROVIDER "${provider}" (use "ffmpeg" or "mock")`);
  }
  const rawTimeout = env['RENDER_TIMEOUT_MS']?.trim();
  const timeoutMs = rawTimeout ? Number(rawTimeout) : DEFAULT_RENDER_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) {
    throw new RenderError('RENDER_CONFIG', 'RENDER_TIMEOUT_MS must be a whole number of milliseconds (at least 1000)');
  }
  const rawThreads = env['RENDER_THREADS']?.trim();
  const threads = rawThreads ? Number(rawThreads) : 0;
  if (!Number.isInteger(threads) || threads < 0 || threads > 256) {
    throw new RenderError('RENDER_CONFIG', 'RENDER_THREADS must be a whole number of encoder threads (0 = FFmpeg default)');
  }
  return {
    provider: provider satisfies RenderProviderName,
    ffmpegPath: toolPath(env['FFMPEG_PATH'], 'ffmpeg', 'FFMPEG_PATH'),
    ffprobePath: toolPath(env['FFPROBE_PATH'], 'ffprobe', 'FFPROBE_PATH'),
    timeoutMs,
    fontsDir: path.resolve(env['RENDER_FONTS_DIR']?.trim() || DEFAULT_FONTS_DIR),
    storage,
    runner: runProcess,
    ...(threads > 0 ? { threads } : {}),
    motion: motionConfigFromEnv(env),
  };
}
