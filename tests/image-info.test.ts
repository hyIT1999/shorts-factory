/**
 * Unit tests for the image header parser and the image normalizer contract
 * (lib/assets/image-info.ts, lib/assets/normalize.ts): no database, no ffmpeg.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import {
  ImageHeaderError,
  imageFormatOf,
  imageLimitViolation,
  MAX_IMAGE_PIXELS,
  MAX_IMAGE_SIDE,
  parseImageInfo,
  readImageInfo,
} from '../lib/assets/image-info.js';
import {
  createImageNormalizerFromEnv,
  FfmpegImageNormalizer,
  MAX_STORED_IMAGE_BYTES,
  needsNormalization,
  normalizeArgs,
} from '../lib/assets/normalize.js';
import { encodePng } from '../lib/assets/png.js';
import { AssetError } from '../lib/assets/types.js';
import { ProcessStartError, type ProcessResult, type ProcessRunner } from '../lib/ffmpeg/process.js';
import { jpegWithoutFrameHeader, pngHeader, syntheticJpeg, syntheticWebp } from './image-fixtures.js';

const tempDirs: string[] = [];
function tempFile(name: string, bytes: Buffer): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'sf-image-'));
  tempDirs.push(dir);
  const file = path.join(dir, name);
  writeFileSync(file, bytes);
  return file;
}
after(() => tempDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function headerError(pattern: RegExp, truncated?: boolean) {
  return (error: unknown): boolean =>
    error instanceof ImageHeaderError && pattern.test(error.message) && (truncated === undefined || error.truncated === truncated);
}

const assetError = (code: AssetError['code'], pattern = /./) => (error: unknown): boolean =>
  error instanceof AssetError && error.code === code && pattern.test(error.message);

describe('parseImageInfo', () => {
  test('PNG: size from IHDR', () => {
    assert.deepEqual(parseImageInfo(encodePng(3, 2, () => [1, 2, 3])), { format: 'png', width: 3, height: 2 });
    assert.deepEqual(parseImageInfo(pngHeader(20_000, 20_000)), { format: 'png', width: 20_000, height: 20_000 });
  });

  test('JPEG: baseline, progressive, fill bytes and big APP segments before the frame header', () => {
    assert.deepEqual(parseImageInfo(syntheticJpeg(1080, 1920)), { format: 'jpeg', width: 1080, height: 1920 });
    assert.deepEqual(parseImageInfo(syntheticJpeg(640, 480, { progressive: true })), { format: 'jpeg', width: 640, height: 480 });
    assert.deepEqual(parseImageInfo(syntheticJpeg(10, 20, { fill: true })), { format: 'jpeg', width: 10, height: 20 });
    assert.deepEqual(parseImageInfo(syntheticJpeg(4000, 6000, { paddingBytes: 150_000 })), { format: 'jpeg', width: 4000, height: 6000 });
  });

  test('WebP: VP8, VP8L and VP8X headers', () => {
    assert.deepEqual(parseImageInfo(syntheticWebp('VP8 ', 1080, 1920)), { format: 'webp', width: 1080, height: 1920 });
    assert.deepEqual(parseImageInfo(syntheticWebp('VP8L', 1, 16_384)), { format: 'webp', width: 1, height: 16_384 });
    assert.deepEqual(parseImageInfo(syntheticWebp('VP8X', 12_345, 678)), { format: 'webp', width: 12_345, height: 678 });
  });

  test('rejects other files and broken headers', () => {
    assert.throws(() => parseImageInfo(Buffer.from('not an image at all')), headerError(/Not a PNG, JPEG or WebP/, false));
    assert.throws(() => parseImageInfo(Buffer.from('%PDF-1.4 ...........')), headerError(/Not a PNG/));
    assert.throws(() => parseImageInfo(jpegWithoutFrameHeader()), headerError(/no frame header/, false));
    assert.throws(() => parseImageInfo(pngHeader(0, 10)), headerError(/invalid size/));
    const png = encodePng(3, 2, () => [0, 0, 0]);
    png.write('IDAT', 12, 'ascii');
    assert.throws(() => parseImageInfo(png), headerError(/IHDR/));
    const webp = syntheticWebp('VP8X', 10, 10);
    webp.write('ALPH', 12, 'ascii');
    assert.throws(() => parseImageInfo(webp), headerError(/ALPH/));
  });

  test('truncated headers are reported as such', () => {
    assert.throws(() => parseImageInfo(Buffer.from([0xff, 0xd8, 0xff])), headerError(/truncated/, true));
    assert.throws(() => parseImageInfo(syntheticJpeg(10, 10).subarray(0, 30)), headerError(/truncated/, true));
    assert.throws(() => parseImageInfo(encodePng(3, 2, () => [0, 0, 0]).subarray(0, 20)), headerError(/truncated/, true));
    assert.throws(() => parseImageInfo(syntheticWebp('VP8 ', 10, 10).subarray(0, 20)), headerError(/truncated/, true));
  });
});

describe('readImageInfo', () => {
  test('reads only the header of a big file, and more when the frame header lies past 64 KB', async () => {
    const big = Buffer.concat([encodePng(3, 2, () => [0, 0, 0]), Buffer.alloc(200_000)]);
    assert.deepEqual(await readImageInfo(tempFile('big.png', big)), { format: 'png', width: 3, height: 2 });
    const jpeg = syntheticJpeg(1234, 5678, { paddingBytes: 150_000 });
    assert.deepEqual(await readImageInfo(tempFile('icc.jpg', jpeg)), { format: 'jpeg', width: 1234, height: 5678 });
    await assert.rejects(readImageInfo(tempFile('icc-cut.jpg', jpeg), { maxBytes: 100_000 }), headerError(/truncated/));
    await assert.rejects(readImageInfo(tempFile('text.txt', Buffer.from('hello world, not an image'))), headerError(/Not a PNG/));
    await assert.rejects(readImageInfo(tempFile('tiny.bin', Buffer.from([0xff, 0xd8]))), headerError(/truncated/));
    await assert.rejects(
      readImageInfo(path.join(os.tmpdir(), 'sf-does-not-exist.png')),
      (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT',
    );
  });
});

describe('image limits', () => {
  test('imageLimitViolation', () => {
    assert.equal(imageLimitViolation({ width: 1080, height: 1920 }), null);
    assert.equal(imageLimitViolation({ width: 6000, height: 6000 }), null);
    assert.match(imageLimitViolation({ width: 20_000, height: 100 }) ?? '', new RegExp(`exceeds ${MAX_IMAGE_SIDE} px per side`));
    assert.match(imageLimitViolation({ width: 8000, height: 8000 }) ?? '', /8000×8000 px exceeds 40 megapixels/);
    assert.match(imageLimitViolation({ width: 8, height: 1920 }) ?? '', /smaller than 16 px/);
    assert.equal(MAX_IMAGE_PIXELS, 40_000_000);
  });

  test('imageFormatOf', () => {
    assert.equal(imageFormatOf('image/png'), 'png');
    assert.equal(imageFormatOf(' image/JPEG '), 'jpeg');
    assert.equal(imageFormatOf('image/jpg'), 'jpeg');
    assert.equal(imageFormatOf('image/webp'), 'webp');
    assert.equal(imageFormatOf('image/gif'), undefined);
    assert.equal(imageFormatOf(null), undefined);
  });
});

describe('normalization contract', () => {
  test('needsNormalization: bigger than the render size in either direction, or a heavy file', () => {
    assert.equal(needsNormalization({ width: 1080, height: 1920 }, 10_000), false);
    assert.equal(needsNormalization({ width: 800, height: 1200 }, 10_000), false);
    assert.equal(needsNormalization({ width: 1920, height: 1080 }, 10_000), true);
    assert.equal(needsNormalization({ width: 1080, height: 1921 }, 10_000), true);
    assert.equal(needsNormalization({ width: 1080, height: 1920 }, MAX_STORED_IMAGE_BYTES + 1), true);
  });

  test('normalizeArgs: cover + centre crop to 1080×1920 as JPEG, paths as separate arguments', () => {
    const args = normalizeArgs('C:\\in put.png', '/tmp/out.tmp');
    assert.equal(args[args.length - 1], '/tmp/out.tmp');
    assert.equal(args[args.indexOf('-i') + 1], 'C:\\in put.png');
    const filter = args[args.indexOf('-vf') + 1] ?? '';
    assert.match(filter, /scale=1080:1920:force_original_aspect_ratio=increase/);
    assert.match(filter, /crop=1080:1920/);
    for (const flag of ['-nostdin', '-y', 'mjpeg', '-update', '-frames:v']) {
      assert.ok(args.includes(flag), flag);
    }
  });

  test('FfmpegImageNormalizer maps runner outcomes to asset errors', async () => {
    const calls: string[][] = [];
    const runner =
      (result: Partial<ProcessResult>): ProcessRunner =>
      async (_command, args) => {
        calls.push([...args]);
        return { exitCode: 0, stdout: '', stderr: '', timedOut: false, ...result };
      };

    await new FfmpegImageNormalizer({ ffmpegPath: 'ffmpeg', runner: runner({}) }).normalize('/a/in.png', '/a/out.tmp');
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], normalizeArgs('/a/in.png', '/a/out.tmp'));

    const stderr = '[png @ 0x1] Invalid PNG signature 0x6E6F\n/a/in.png: Invalid data found when processing input\n';
    const failing = new FfmpegImageNormalizer({ ffmpegPath: 'ffmpeg', runner: runner({ exitCode: 69, stderr }) });
    await assert.rejects(
      failing.normalize('/a/in.png', '/a/out.tmp'),
      (error: unknown) =>
        assetError('INVALID_IMAGE', /exit code 69.*Invalid PNG signature/)(error) &&
        !(error as Error).message.includes('[png @') &&
        !(error as Error).message.includes('/a/in.png'),
    );

    const slow = new FfmpegImageNormalizer({ ffmpegPath: 'ffmpeg', timeoutMs: 5000, runner: runner({ exitCode: null, timedOut: true }) });
    await assert.rejects(slow.normalize('/a/in.png', '/a/out.tmp'), assetError('INVALID_IMAGE', /5000 ms/));

    const missing = new FfmpegImageNormalizer({
      ffmpegPath: 'nope',
      runner: async () => {
        throw new ProcessStartError('ENOENT', 'Could not start nope (ENOENT)');
      },
    });
    await assert.rejects(missing.normalize('/a/in.png', '/a/out.tmp'), assetError('CONFIG', /ENOENT.*FFMPEG_PATH/));
  });

  test('createImageNormalizerFromEnv validates FFMPEG_PATH and the timeout', () => {
    assert.equal(createImageNormalizerFromEnv({}).name, 'ffmpeg');
    assert.equal(createImageNormalizerFromEnv({ FFMPEG_PATH: 'C:\\ffmpeg\\bin\\ffmpeg.exe', ASSET_NORMALIZE_TIMEOUT_MS: '30000' }).name, 'ffmpeg');
    assert.throws(() => createImageNormalizerFromEnv({ FFMPEG_PATH: 'C:\\tools\\ffmpeg.cmd' }), assetError('CONFIG', /\.cmd/));
    assert.throws(() => createImageNormalizerFromEnv({ ASSET_NORMALIZE_TIMEOUT_MS: '10' }), assetError('CONFIG', /ASSET_NORMALIZE_TIMEOUT_MS/));
    assert.throws(() => createImageNormalizerFromEnv({ ASSET_NORMALIZE_TIMEOUT_MS: 'soon' }), assetError('CONFIG', /ASSET_NORMALIZE_TIMEOUT_MS/));
  });
});
