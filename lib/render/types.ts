import { z } from 'zod';
import type { LocalAssetStorage } from '../assets/storage.js';
import type { ProcessRunner } from '../ffmpeg/process.js';

/** Fixed Phase A output: vertical 1080×1920 H.264/AAC MP4. */
export const RENDER_SPEC = {
  width: 1080,
  height: 1920,
  fps: 30,
  videoCodec: 'h264',
  videoEncoder: 'libx264',
  preset: 'veryfast',
  crf: 20,
  pixelFormat: 'yuv420p',
  audioCodec: 'aac',
  audioBitrate: '192k',
  audioSampleRate: 48_000,
  audioChannels: 2,
} as const;

export const FONT_FAMILY = 'Be Vietnam Pro';
export const FONT_FILE = 'BeVietnamPro-Bold.ttf';
/** Relative to the working directory (like DATA_DIR); override with RENDER_FONTS_DIR. */
export const DEFAULT_FONTS_DIR = 'templates/documentary/fonts';

export const MAX_RENDER_SCENES = 20;
export const MAX_RENDER_DURATION_MS = 180_000;
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 50 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 500 * 1024 * 1024;
export const MIN_FREE_DISK_BYTES = 512 * 1024 * 1024;
export const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** Scene timings, Video.duration and WAV lengths are all rounded to the millisecond by VOICE. */
export const TIMING_TOLERANCE_MS = 1;
/**
 * Output duration vs Video.duration: the last frame boundary (≤ 17 ms at
 * 30 fps) plus AAC priming/padding (~21 ms at 48 kHz) plus container rounding.
 */
export const OUTPUT_DURATION_TOLERANCE_MS = 100;
export const FRAME_COUNT_TOLERANCE = 1;

export const DEFAULT_RENDER_TIMEOUT_MS = 600_000;
/** For -version / -encoders / -filters / ffprobe calls. */
export const TOOL_TIMEOUT_MS = 60_000;

export type RenderProviderName = 'ffmpeg' | 'mock';

/** Ken Burns motion on the still images (lib/render/motion.ts): off, or a slow zoom/pan per scene. */
export const MOTION_MODES = ['off', 'kenburns'] as const;
export type MotionMode = (typeof MOTION_MODES)[number];
export const MOTION_PRESETS = ['zoom-in', 'zoom-out', 'pan-left', 'pan-right', 'pan-up', 'pan-down'] as const;
export type MotionPreset = (typeof MOTION_PRESETS)[number];
/** Supersampling of the source before zoompan (RENDER_MOTION_SCALE): 2 keeps slow pans smooth at ~4× the render time. */
export const MIN_MOTION_SCALE = 1;
export const MAX_MOTION_SCALE = 3;
export const DEFAULT_MOTION_SCALE = 2;

export interface MotionConfig {
  mode: MotionMode;
  /** Integer 1–3; the source is scaled to scale × 1080×1920 before zoompan crops it. */
  scale: number;
  /** One preset for every scene, or "auto" (deterministic per scene, never twice in a row). */
  preset: MotionPreset | 'auto';
}

export const MOTION_OFF: Readonly<MotionConfig> = { mode: 'off', scale: 1, preset: 'auto' };

/** Everything the RENDER stage needs, injected through JobContext. */
export interface RenderServices {
  /** "ffmpeg" renders a real MP4; "mock" validates all inputs but writes no video (tests, explicit only). */
  provider: RenderProviderName;
  ffmpegPath: string;
  ffprobePath: string;
  timeoutMs: number;
  /** Absolute directory that contains FONT_FILE. */
  fontsDir: string;
  /** Local storage rooted at data/ (shared with ASSETS and VOICE). */
  storage: LocalAssetStorage;
  runner: ProcessRunner;
  /** Encoder threads (RENDER_THREADS); unset = FFmpeg's default, all cores. */
  threads?: number;
  /** Motion on the still images (RENDER_MOTION*); unset = off (the Phase A chain). */
  motion?: MotionConfig;
}

/** A validated scene: real timing in ms and absolute input files. */
export interface RenderScene {
  id: string;
  index: number;
  startMs: number;
  endMs: number;
  imagePath: string;
  audioPath: string;
}

export interface RenderInput {
  projectId: string;
  videoId: string;
  /** round(Video.duration × 1000) = end of the last scene. */
  durationMs: number;
  scenes: RenderScene[];
}

const relativePath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/') && !/^[A-Za-z]:/.test(p) && !p.includes('\\') && !p.split('/').includes('..'), {
    message: 'outputPath must be a relative POSIX path inside data/',
  });

/** Contract of the RENDER Job.resultJson (paths relative to data/, times in ms). */
export const RenderResultSchema = z
  .strictObject({
    version: z.literal(1),
    provider: z.enum(['ffmpeg', 'mock']),
    videoId: z.string().min(1),
    /** null only for the mock provider (no file is written). */
    outputPath: relativePath.nullable(),
    durationMs: z.number().int().positive(),
    frames: z.number().int().positive(),
    /** Container duration reported by ffprobe. */
    probedDurationMs: z.number().int().nonnegative().nullable(),
    width: z.literal(RENDER_SPEC.width),
    height: z.literal(RENDER_SPEC.height),
    fps: z.literal(RENDER_SPEC.fps),
    videoCodec: z.literal(RENDER_SPEC.videoCodec),
    pixelFormat: z.literal(RENDER_SPEC.pixelFormat),
    audioCodec: z.literal(RENDER_SPEC.audioCodec),
    audioBitrate: z.literal(RENDER_SPEC.audioBitrate),
    fileSize: z.number().int().positive().nullable(),
    ffmpegVersion: z.string().nullable(),
    subtitleVersion: z.literal(1),
    subtitleInputHash: z.string().regex(/^[0-9a-f]{64}$/),
    subtitleSegments: z.number().int().positive(),
    /** Motion applied to the still images; results written before Phase C1 have none (defaults). */
    motion: z.enum(MOTION_MODES).default('off'),
    motionScale: z.number().int().min(MIN_MOTION_SCALE).max(MAX_MOTION_SCALE).default(1),
    /** The preset of each scene, in scene order (empty when motion is off). */
    motionPresets: z.array(z.enum(MOTION_PRESETS)).max(MAX_RENDER_SCENES).default([]),
    renderedAt: z.iso.datetime(),
    /** Font and FFmpeg/libass warnings (e.g. a glyph drawn with a fallback font); the render still succeeded. */
    warnings: z.array(z.string().max(320)).max(50).default([]),
  })
  .superRefine((result, ctx) => {
    const file = [result.outputPath, result.fileSize, result.probedDurationMs];
    if (result.provider === 'ffmpeg' && file.some((value) => value === null)) {
      ctx.addIssue({ code: 'custom', message: 'an ffmpeg render must have outputPath, fileSize and probedDurationMs' });
    }
    if (result.provider === 'mock' && file.some((value) => value !== null)) {
      ctx.addIssue({ code: 'custom', message: 'a mock render writes no file' });
    }
    if (result.motion === 'off' && result.motionPresets.length > 0) {
      ctx.addIssue({ code: 'custom', message: 'motion presets are only recorded when motion is on' });
    }
  });

export type RenderResult = z.infer<typeof RenderResultSchema>;
