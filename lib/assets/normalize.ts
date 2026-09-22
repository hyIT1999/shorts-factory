/**
 * Image normalization for stock photos: ffmpeg scales (cover) and centre-crops
 * a downloaded image to the render size and re-encodes it as JPEG. Stored
 * images are then a few hundred KB instead of a 5–15 MB original, and RENDER
 * decodes 2 Mpx per scene whatever the provider sent. Images already within
 * the render size and small (placeholders, CDN-cropped photos) are kept as
 * they are, so the offline providers never need ffmpeg.
 */
import { ProcessStartError, runProcess, type ProcessRunner } from '../ffmpeg/process.js';
import type { ImageInfo } from './image-info.js';
import { AssetError } from './types.js';

export const NORMALIZED_WIDTH = 1080;
export const NORMALIZED_HEIGHT = 1920;
export const NORMALIZED_MIME_TYPE = 'image/jpeg';
export const NORMALIZED_EXTENSION = 'jpg';
/** An image within the render size is still re-encoded when its file is bigger than this. */
export const MAX_STORED_IMAGE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_NORMALIZE_TIMEOUT_MS = 60_000;
/** mjpeg quality scale (2 = best … 31): 3 is visually lossless for photos, ~300–600 KB at 1080×1920. */
export const JPEG_QSCALE = 3;

export interface ImageNormalizer {
  readonly name: string;
  /** Writes a NORMALIZED_WIDTH×NORMALIZED_HEIGHT JPEG made from `sourcePath` to `targetPath` (both absolute). */
  normalize(sourcePath: string, targetPath: string): Promise<void>;
}

/** True when an image is larger than the render size in either direction, or its file is heavy. */
export function needsNormalization(info: Pick<ImageInfo, 'width' | 'height'>, sizeBytes: number): boolean {
  return info.width > NORMALIZED_WIDTH || info.height > NORMALIZED_HEIGHT || sizeBytes > MAX_STORED_IMAGE_BYTES;
}

/**
 * The ffmpeg arguments (no shell; the paths are separate argv entries). The
 * same cover-and-crop as RENDER's filtergraph. yuvj420p is the pixel format
 * every FFmpeg from 4.x to 9.x accepts for mjpeg without extra flags; new
 * builds print a deprecation notice for it that -loglevel error hides.
 */
export function normalizeArgs(sourcePath: string, targetPath: string): string[] {
  const filter =
    `scale=${NORMALIZED_WIDTH}:${NORMALIZED_HEIGHT}:force_original_aspect_ratio=increase:flags=lanczos,` +
    `crop=${NORMALIZED_WIDTH}:${NORMALIZED_HEIGHT},setsar=1,format=yuvj420p`;
  return [
    '-nostdin',
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    sourcePath,
    '-vf',
    filter,
    '-frames:v',
    '1',
    '-c:v',
    'mjpeg',
    '-q:v',
    String(JPEG_QSCALE),
    '-f',
    'image2',
    '-update',
    '1',
    targetPath,
  ];
}

export interface FfmpegImageNormalizerOptions {
  ffmpegPath: string;
  timeoutMs?: number;
  runner?: ProcessRunner;
}

/** The first meaningful stderr line, without ffmpeg's "[component @ 0x…]" prefix or the file paths. */
function stderrSummary(stderr: string, paths: readonly string[]): string {
  let line = stderr.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? 'no error output';
  for (const p of paths) {
    line = line.split(p).join('<image>');
  }
  return line.replace(/^\[[^\]]*\]\s*/, '').slice(0, 200);
}

export class FfmpegImageNormalizer implements ImageNormalizer {
  readonly name = 'ffmpeg';
  private readonly timeoutMs: number;
  private readonly runner: ProcessRunner;

  constructor(private readonly options: FfmpegImageNormalizerOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_NORMALIZE_TIMEOUT_MS;
    this.runner = options.runner ?? runProcess;
  }

  async normalize(sourcePath: string, targetPath: string): Promise<void> {
    let result;
    try {
      result = await this.runner(this.options.ffmpegPath, normalizeArgs(sourcePath, targetPath), { timeoutMs: this.timeoutMs });
    } catch (error) {
      if (error instanceof ProcessStartError) {
        throw new AssetError('CONFIG', `Could not start ffmpeg to normalize an image (${error.code}); check FFMPEG_PATH`);
      }
      throw error;
    }
    if (result.timedOut) {
      throw new AssetError('INVALID_IMAGE', `ffmpeg did not finish converting the image within ${this.timeoutMs} ms`);
    }
    if (result.exitCode !== 0) {
      throw new AssetError(
        'INVALID_IMAGE',
        `ffmpeg could not convert the image (exit code ${result.exitCode ?? 'none'}): ${stderrSummary(result.stderr, [sourcePath, targetPath])}`,
      );
    }
  }
}

/** FFMPEG_PATH (default: "ffmpeg" on PATH) and ASSET_NORMALIZE_TIMEOUT_MS (default 60 s). */
export function createImageNormalizerFromEnv(env: NodeJS.ProcessEnv = process.env): ImageNormalizer {
  const ffmpegPath = env['FFMPEG_PATH']?.trim() || 'ffmpeg';
  if (/\.(cmd|bat)$/i.test(ffmpegPath)) {
    // Node refuses to spawn .cmd/.bat files without a shell, and a shell is never used here.
    throw new AssetError('CONFIG', 'FFMPEG_PATH must point to the executable (e.g. ffmpeg.exe), not a .cmd/.bat wrapper');
  }
  const raw = env['ASSET_NORMALIZE_TIMEOUT_MS']?.trim();
  const timeoutMs = raw ? Number(raw) : DEFAULT_NORMALIZE_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) {
    throw new AssetError('CONFIG', 'ASSET_NORMALIZE_TIMEOUT_MS must be a whole number of milliseconds (at least 1000)');
  }
  return new FfmpegImageNormalizer({ ffmpegPath, timeoutMs });
}
