/**
 * Image header inspection without decoding: the format and pixel size of a
 * PNG, JPEG or WebP file from its first bytes. ASSETS uses it before keeping a
 * downloaded image and RENDER before handing an image to ffmpeg, so a corrupt
 * or absurdly large file (a 20000×20000 PNG decodes to 1.2 GB per frame) is
 * rejected with a clear message instead of a crash or an out-of-memory ffmpeg.
 */
import { open } from 'node:fs/promises';

export type ImageFormat = 'png' | 'jpeg' | 'webp';

export interface ImageInfo {
  format: ImageFormat;
  width: number;
  height: number;
}

/** The image format a MIME type declares (undefined for anything else). */
export function imageFormatOf(mimeType: string | null | undefined): ImageFormat | undefined {
  switch ((mimeType ?? '').trim().toLowerCase()) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpeg';
    case 'image/webp':
      return 'webp';
    default:
      return undefined;
  }
}

/** Longest side an image may have, in pixels. */
export const MAX_IMAGE_SIDE = 12_000;
/** Largest pixel count: 40 Mpx (about 6300×6300) decodes to roughly 120 MB. */
export const MAX_IMAGE_PIXELS = 40_000_000;
/** Shortest side an image must have; anything smaller is a broken download or an icon. */
export const MIN_IMAGE_SIDE = 16;

export interface ImageLimits {
  maxSide: number;
  maxPixels: number;
  minSide: number;
}

export const DEFAULT_IMAGE_LIMITS: Readonly<ImageLimits> = { maxSide: MAX_IMAGE_SIDE, maxPixels: MAX_IMAGE_PIXELS, minSide: MIN_IMAGE_SIDE };

/** The bytes are not a supported image; `truncated` means more bytes might still make them one. */
export class ImageHeaderError extends Error {
  constructor(
    message: string,
    readonly truncated = false,
  ) {
    super(message);
    this.name = 'ImageHeaderError';
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Start-of-frame markers of every JPEG process (baseline, progressive, lossless, arithmetic). */
const JPEG_SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

const truncated = (what: string): ImageHeaderError => new ImageHeaderError(`${what} is truncated`, true);

function parsePng(b: Buffer): ImageInfo {
  if (b.length < 24) {
    throw truncated('PNG header');
  }
  if (b.toString('ascii', 12, 16) !== 'IHDR') {
    throw new ImageHeaderError('PNG file does not start with an IHDR chunk');
  }
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  if (width === 0 || height === 0 || width > 0x7fffffff || height > 0x7fffffff) {
    throw new ImageHeaderError('PNG header has an invalid size');
  }
  return { format: 'png', width, height };
}

function parseJpeg(b: Buffer): ImageInfo {
  let i = 2;
  for (;;) {
    if (i >= b.length) {
      throw truncated('JPEG header');
    }
    if (b[i] !== 0xff) {
      throw new ImageHeaderError('JPEG marker expected');
    }
    while (b[i] === 0xff) {
      i++; // 0xFF fill bytes may precede a marker
      if (i >= b.length) {
        throw truncated('JPEG header');
      }
    }
    const marker = b[i] ?? 0;
    i++;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue; // standalone markers without a length
    }
    if (marker === 0xd9 || marker === 0xda) {
      throw new ImageHeaderError('JPEG file has no frame header before its image data');
    }
    if (i + 1 >= b.length) {
      throw truncated('JPEG header');
    }
    const length = b.readUInt16BE(i);
    if (length < 2) {
      throw new ImageHeaderError('JPEG segment has an invalid length');
    }
    if (JPEG_SOF_MARKERS.has(marker)) {
      // length(2) precision(1) height(2) width(2)
      if (i + 6 >= b.length) {
        throw truncated('JPEG frame header');
      }
      const height = b.readUInt16BE(i + 3);
      const width = b.readUInt16BE(i + 5);
      if (width === 0 || height === 0) {
        throw new ImageHeaderError('JPEG frame header has no size');
      }
      return { format: 'jpeg', width, height };
    }
    i += length;
  }
}

function parseWebp(b: Buffer): ImageInfo {
  if (b.length < 30) {
    throw truncated('WebP header');
  }
  const chunk = b.toString('ascii', 12, 16);
  let width: number;
  let height: number;
  if (chunk === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) {
      throw new ImageHeaderError('WebP VP8 frame has an invalid start code');
    }
    width = b.readUInt16LE(26) & 0x3fff;
    height = b.readUInt16LE(28) & 0x3fff;
  } else if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) {
      throw new ImageHeaderError('WebP VP8L header has an invalid signature');
    }
    const bits = b.readUInt32LE(21);
    width = (bits & 0x3fff) + 1;
    height = ((bits >>> 14) & 0x3fff) + 1;
  } else if (chunk === 'VP8X') {
    width = 1 + b.readUIntLE(24, 3);
    height = 1 + b.readUIntLE(27, 3);
  } else {
    throw new ImageHeaderError(`WebP chunk "${chunk}" is not supported`);
  }
  if (width === 0 || height === 0) {
    throw new ImageHeaderError('WebP header has an invalid size');
  }
  return { format: 'webp', width, height };
}

/** Format and pixel size from the first bytes of an image file. Throws ImageHeaderError. */
export function parseImageInfo(bytes: Uint8Array): ImageInfo {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length < 12) {
    throw truncated('Image header');
  }
  if (PNG_SIGNATURE.every((byte, index) => b[index] === byte)) {
    return parsePng(b);
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    return parseJpeg(b);
  }
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    return parseWebp(b);
  }
  throw new ImageHeaderError('Not a PNG, JPEG or WebP file');
}

/** Why an image of this size may not be used, or null when it is within the limits. */
export function imageLimitViolation(info: Pick<ImageInfo, 'width' | 'height'>, limits: Readonly<ImageLimits> = DEFAULT_IMAGE_LIMITS): string | null {
  const size = `${info.width}×${info.height} px`;
  if (info.width > limits.maxSide || info.height > limits.maxSide) {
    return `${size} exceeds ${limits.maxSide} px per side`;
  }
  if (info.width * info.height > limits.maxPixels) {
    return `${size} exceeds ${limits.maxPixels / 1_000_000} megapixels`;
  }
  if (info.width < limits.minSide || info.height < limits.minSide) {
    return `${size} is smaller than ${limits.minSide} px`;
  }
  return null;
}

const FIRST_READ_BYTES = 64 * 1024;
/** How far into a file the frame header is looked for (JPEGs can carry large ICC/EXIF segments first). */
export const DEFAULT_HEADER_SCAN_BYTES = 32 * 1024 * 1024;

/**
 * Reads only as much of the file as the header needs: 64 KB first, then more
 * (up to maxBytes) when the frame header lies further in. Throws ImageHeaderError
 * for anything that is not a supported image; file errors propagate.
 */
export async function readImageInfo(file: string, options: { maxBytes?: number } = {}): Promise<ImageInfo> {
  const maxBytes = Math.max(FIRST_READ_BYTES, options.maxBytes ?? DEFAULT_HEADER_SCAN_BYTES);
  const handle = await open(file, 'r');
  try {
    let buffer = Buffer.alloc(0);
    for (let size = FIRST_READ_BYTES; ; size = Math.min(maxBytes, size * 8)) {
      const chunk = Buffer.alloc(size - buffer.length);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, buffer.length);
      buffer = Buffer.concat([buffer, chunk.subarray(0, bytesRead)]);
      try {
        return parseImageInfo(buffer);
      } catch (error) {
        const canReadMore = bytesRead === chunk.length && buffer.length < maxBytes;
        if (!(error instanceof ImageHeaderError && error.truncated && canReadMore)) {
          throw error;
        }
      }
    }
  } finally {
    await handle.close();
  }
}
