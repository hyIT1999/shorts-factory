/**
 * RENDER with a real FFmpeg (opt-in): the whole mock pipeline (mock AI, silent
 * narration, placeholder images) rendered by the ffmpeg/ffprobe found through
 * FFMPEG_PATH / FFPROBE_PATH or PATH. Skipped, not failed, when there is none.
 *
 * It checks what the fake runner cannot: that this FFmpeg build accepts the
 * filtergraph, that the output passes the real ffprobe checks, and that the
 * subtitles really are burned in (a frame from the middle of a caption has a
 * block of bright pixels in the caption band and none in the sky above it).
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { AIClient } from '../lib/ai/client.js';
import { MockAIProvider } from '../lib/ai/providers/mock.js';
import { encodePng } from '../lib/assets/png.js';
import { getPrisma } from '../lib/db/prisma.js';
import { runProcess } from '../lib/ffmpeg/process.js';
import { JobStatus, JobType } from '../lib/generated/prisma/client.js';
import { processNextJob } from '../lib/jobs/process-job.js';
import type { JobContext } from '../lib/jobs/types.js';
import { createRenderServicesFromEnv } from '../lib/render/index.js';
import { renderVideo } from '../lib/render/service.js';
import { RENDER_SPEC, RenderResultSchema } from '../lib/render/types.js';
import { SubtitleResultSchema } from '../lib/subtitles/types.js';
import {
  createProjectWithGeneration,
  createTestAssetServices,
  createTestVoiceServices,
  makeTempDir,
  migrateTestDb,
  removeTestDb,
} from './helpers.js';

const quiet = (): void => {};
const TOPIC = 'Tại sao con người lại mơ?';
const ffmpegPath = process.env['FFMPEG_PATH']?.trim() || 'ffmpeg';
const ffprobePath = process.env['FFPROBE_PATH']?.trim() || 'ffprobe';

function runs(command: string): boolean {
  try {
    return spawnSync(command, ['-version'], { stdio: 'ignore', windowsHide: true }).status === 0;
  } catch {
    return false;
  }
}
const available = runs(ffmpegPath) && runs(ffprobePath);
const skip = available ? false : 'no ffmpeg/ffprobe found (set FFMPEG_PATH and FFPROBE_PATH or add them to PATH)';

/** One frame at `seconds`, as 8-bit grey pixels (width × height bytes), extracted by the real ffmpeg. */
async function greyFrame(file: string, seconds: number): Promise<Buffer> {
  const out = path.join(makeTempDir('sf-frame-'), 'frame.gray');
  const result = await runProcess(
    ffmpegPath,
    ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-ss', seconds.toFixed(3), '-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', out],
    { timeoutMs: 60_000 },
  );
  assert.equal(result.exitCode, 0, result.stderr);
  const pixels = await readFile(out);
  assert.equal(pixels.length, RENDER_SPEC.width * RENDER_SPEC.height, 'one full frame');
  return pixels;
}

/** Pixels brighter than `threshold` in the rows [fromY, toY). */
function brightPixels(pixels: Buffer, fromY: number, toY: number, threshold = 200): number {
  let count = 0;
  for (let y = fromY; y < toY; y++) {
    const row = y * RENDER_SPEC.width;
    for (let x = 0; x < RENDER_SPEC.width; x++) {
      if ((pixels[row + x] ?? 0) > threshold) {
        count++;
      }
    }
  }
  return count;
}

/** Mean row of the pixels brighter than `threshold` in the rows [fromY, toY): where a bright band sits. */
function brightCentroid(pixels: Buffer, fromY: number, toY: number, threshold = 200): number {
  let count = 0;
  let sum = 0;
  for (let y = fromY; y < toY; y++) {
    const row = y * RENDER_SPEC.width;
    for (let x = 0; x < RENDER_SPEC.width; x++) {
      if ((pixels[row + x] ?? 0) > threshold) {
        count++;
        sum += y;
      }
    }
  }
  assert.ok(count > 1000, `expected a bright band in rows ${fromY}–${toY}, found ${count} bright pixels`);
  return sum / count;
}

before(migrateTestDb);
after(removeTestDb);
beforeEach(async () => {
  const prisma = getPrisma();
  await prisma.$transaction([prisma.job.deleteMany(), prisma.asset.deleteMany(), prisma.scene.deleteMany(), prisma.video.deleteMany(), prisma.project.deleteMany(), prisma.setting.deleteMany()]);
});

describe('RENDER with the real FFmpeg', { skip }, () => {
  test('the mock pipeline renders to a valid MP4 with the subtitles burned in', { timeout: 300_000 }, async () => {
    const assets = createTestAssetServices();
    const ctx: JobContext = {
      ai: new AIClient(new MockAIProvider()),
      assets,
      voice: createTestVoiceServices(undefined, assets.storage),
      render: createRenderServicesFromEnv(assets.storage, { ...process.env, RENDER_PROVIDER: 'ffmpeg', RENDER_TIMEOUT_MS: '240000' }),
    };
    const prisma = getPrisma();
    const gen = await createProjectWithGeneration('Real render', TOPIC);

    // Run up to SUBTITLES, then put a character the bundled font cannot draw into the first caption.
    for (;;) {
      const pending = await prisma.job.findFirst({ where: { status: JobStatus.PENDING } });
      if (!pending || pending.type === JobType.SUBTITLES) {
        break;
      }
      await processNextJob(quiet, ctx);
    }
    const first = await prisma.scene.findFirstOrThrow({ where: { videoId: gen.videoId, index: 0 } });
    await prisma.scene.update({ where: { id: first.id }, data: { text: `${first.text} 😺` } });

    const logs: string[] = [];
    const started = Date.now();
    while (await processNextJob((message) => logs.push(message), ctx)) {
      // until idle
    }
    const elapsedSec = (Date.now() - started) / 1000;

    const job = await prisma.job.findFirstOrThrow({ where: { type: JobType.RENDER } });
    assert.equal(job.status, JobStatus.COMPLETED, `RENDER failed: ${job.error ?? ''}\n${logs.join('\n')}`);
    const result = RenderResultSchema.parse(JSON.parse(job.resultJson ?? ''));
    assert.equal(result.provider, 'ffmpeg');
    assert.ok(result.outputPath && result.probedDurationMs !== null && result.fileSize !== null);
    assert.ok(Math.abs(result.probedDurationMs - result.durationMs) <= 100, `probed ${result.probedDurationMs} vs ${result.durationMs}`);
    assert.equal(result.frames, Math.round((result.durationMs * RENDER_SPEC.fps) / 1000));
    assert.ok(result.fileSize > 10_000, `file size ${result.fileSize}`);
    assert.ok(result.warnings.some((warning) => /cannot draw 1 character/.test(warning)), JSON.stringify(result.warnings));
    const video = await prisma.video.findUniqueOrThrow({ where: { id: gen.videoId } });
    assert.equal(video.outputPath, result.outputPath);
    const file = assets.storage.resolve(result.outputPath);
    assert.ok(existsSync(file));
    assert.equal(existsSync(path.join(assets.storage.root, 'tmp')), false, 'the working directory is gone');

    // The first caption really is on screen: bright text in the caption band, dark sky above it.
    const subtitles = SubtitleResultSchema.parse(
      JSON.parse((await prisma.job.findFirstOrThrow({ where: { type: JobType.SUBTITLES, status: JobStatus.COMPLETED } })).resultJson ?? ''),
    );
    const caption = subtitles.segments[0];
    assert.ok(caption);
    const pixels = await greyFrame(file, (caption.startMs + caption.endMs) / 2000);
    const bandTop = Math.round(RENDER_SPEC.height * 0.66) - 220;
    const inBand = brightPixels(pixels, bandTop, bandTop + 440);
    const above = brightPixels(pixels, 0, Math.round(RENDER_SPEC.height * 0.3));
    assert.ok(inBand > 2_000, `expected a caption's worth of bright pixels in the caption band, found ${inBand}`);
    assert.equal(above, 0, 'the placeholder background is dark; nothing else is drawn there');

    console.log(
      `real FFmpeg (${result.ffmpegVersion}): ${result.frames} frames / ${(result.durationMs / 1000).toFixed(1)} s rendered in ${elapsedSec.toFixed(1)} s ` +
        `(${(result.frames / elapsedSec).toFixed(0)} fps incl. probe), ${(result.fileSize / 1024).toFixed(0)} KB, ${result.warnings.length} warning(s)`,
    );
  });

  test('Ken Burns really moves the picture, frame-exactly; motion off leaves it still', { timeout: 300_000 }, async () => {
    const assets = createTestAssetServices();
    const env = { ...process.env, RENDER_PROVIDER: 'ffmpeg', RENDER_TIMEOUT_MS: '240000' };
    const ctx: JobContext = {
      ai: new AIClient(new MockAIProvider()),
      assets,
      voice: createTestVoiceServices(undefined, assets.storage),
      render: createRenderServicesFromEnv(assets.storage, { ...env, RENDER_MOTION: 'off' }),
    };
    const prisma = getPrisma();
    const gen = await createProjectWithGeneration('Motion render', TOPIC);
    for (;;) {
      const pending = await prisma.job.findFirst({ where: { status: JobStatus.PENDING } });
      if (!pending || pending.type === JobType.RENDER) {
        break;
      }
      await processNextJob(quiet, ctx);
    }
    const renderJob = await prisma.job.findFirstOrThrow({ where: { videoId: gen.videoId, type: JobType.RENDER } });

    // Scene 1 gets a bright horizontal band in its top third: easy to track, far from the caption band.
    const first = await prisma.scene.findFirstOrThrow({ where: { videoId: gen.videoId, index: 0 }, include: { selectedAsset: true } });
    await writeFile(
      assets.storage.resolve(first.selectedAsset?.localPath ?? ''),
      encodePng(RENDER_SPEC.width, RENDER_SPEC.height, (y) => (y >= 300 && y < 500 ? [255, 255, 255] : [12, 12, 24])),
    );
    const sceneEndSec = first.endTime ?? 0;
    assert.ok(sceneEndSec > 1, `scene 1 lasts ${sceneEndSec} s`);
    const job = { projectId: gen.projectId, videoId: gen.videoId, jobId: renderJob.id };
    const rows = Math.round(RENDER_SPEC.height / 2);

    const started = Date.now();
    const moving = await renderVideo(job, createRenderServicesFromEnv(assets.storage, { ...env, RENDER_MOTION: 'kenburns', RENDER_MOTION_PRESET: 'pan-down' }), quiet);
    const elapsedSec = (Date.now() - started) / 1000;
    assert.equal(moving.motion, 'kenburns');
    assert.equal(moving.motionScale, 2);
    assert.ok(moving.motionPresets.every((preset) => preset === 'pan-down'), moving.motionPresets.join(','));
    assert.equal(moving.frames, Math.round((moving.durationMs * RENDER_SPEC.fps) / 1000), 'zoompan emits exactly the frame count');
    assert.ok(moving.probedDurationMs !== null && Math.abs(moving.probedDurationMs - moving.durationMs) <= 100);
    const file = assets.storage.resolve(moving.outputPath ?? '');
    const bandStart = brightCentroid(await greyFrame(file, 0.1), 0, rows);
    const bandEnd = brightCentroid(await greyFrame(file, sceneEndSec - 0.1), 0, rows);
    const shift = bandStart - bandEnd; // the view pans down, so the band rises in the frame
    assert.ok(shift >= 20, `the band moved ${shift.toFixed(1)} px (start ${bandStart.toFixed(1)}, end ${bandEnd.toFixed(1)})`);

    const still = await renderVideo({ ...job, jobId: 'stilljob' }, createRenderServicesFromEnv(assets.storage, { ...env, RENDER_MOTION: 'off' }), quiet);
    assert.deepEqual([still.motion, still.motionPresets], ['off', []]);
    const stillStart = brightCentroid(await greyFrame(file, 0.1), 0, rows);
    const stillEnd = brightCentroid(await greyFrame(file, sceneEndSec - 0.1), 0, rows);
    assert.ok(Math.abs(stillStart - stillEnd) < 1, `a still image does not move (${stillStart.toFixed(1)} vs ${stillEnd.toFixed(1)})`);
    assert.equal(existsSync(path.join(assets.storage.root, 'tmp')), false, 'the working directories are gone');

    console.log(
      `Ken Burns pan-down moved the band ${shift.toFixed(1)} px over scene 1; ${moving.frames} frames rendered in ${elapsedSec.toFixed(1)} s ` +
        `(${(moving.frames / elapsedSec).toFixed(0)} fps incl. probe) at scale ${moving.motionScale}`,
    );
  });
});
