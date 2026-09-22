/**
 * Image normalization with a real ffmpeg (opt-in, skipped when there is none):
 * a landscape PNG becomes a 1080×1920 JPEG, a corrupt file is refused, and the
 * ASSETS stage stores such JPEGs so RENDER's input check accepts them.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { AIClient } from '../lib/ai/client.js';
import { MockAIProvider } from '../lib/ai/providers/mock.js';
import { parseImageInfo } from '../lib/assets/image-info.js';
import { FfmpegImageNormalizer } from '../lib/assets/normalize.js';
import { MockAssetProvider } from '../lib/assets/providers/mock.js';
import { renderPlaceholderPng } from '../lib/assets/providers/placeholder.js';
import { AssetError, type AssetCandidate, type AssetQuery } from '../lib/assets/types.js';
import { getPrisma } from '../lib/db/prisma.js';
import { JobStatus, JobType } from '../lib/generated/prisma/client.js';
import { processNextJob } from '../lib/jobs/process-job.js';
import type { JobContext } from '../lib/jobs/types.js';
import {
  createProjectWithGeneration,
  createTestAssetServices,
  createTestRenderServices,
  createTestVoiceServices,
  makeTempDir,
  migrateTestDb,
  removeTestDb,
  resetDb,
} from './helpers.js';

const quiet = (): void => {};
const ffmpegPath = process.env['FFMPEG_PATH']?.trim() || 'ffmpeg';

function runs(command: string): boolean {
  try {
    return spawnSync(command, ['-version'], { stdio: 'ignore', windowsHide: true }).status === 0;
  } catch {
    return false;
  }
}
const skip = runs(ffmpegPath) ? false : 'no ffmpeg found (set FFMPEG_PATH or add it to PATH)';

before(migrateTestDb);
after(removeTestDb);
beforeEach(resetDb);

describe('image normalization with the real ffmpeg', { skip }, () => {
  const normalizer = new FfmpegImageNormalizer({ ffmpegPath, timeoutMs: 60_000 });

  test('turns a 1920×1080 PNG into a 1080×1920 JPEG', async () => {
    const dir = makeTempDir('sf-normalize-');
    const source = path.join(dir, 'landscape.png');
    writeFileSync(source, renderPlaceholderPng('landscape', 1920, 1080));
    const target = path.join(dir, 'out.normalized');
    await normalizer.normalize(source, target);
    const bytes = readFileSync(target);
    assert.deepEqual(parseImageInfo(bytes), { format: 'jpeg', width: 1080, height: 1920 });
    assert.ok(bytes.length > 1000 && bytes.length < 2 * 1024 * 1024, `${bytes.length} bytes`);
  });

  test('refuses a corrupt file with INVALID_IMAGE and no path in the message', async () => {
    const dir = makeTempDir('sf-normalize-');
    const source = path.join(dir, 'broken.png');
    writeFileSync(source, 'not an image');
    const target = path.join(dir, 'out.normalized');
    await assert.rejects(
      normalizer.normalize(source, target),
      (error: unknown) => error instanceof AssetError && error.code === 'INVALID_IMAGE' && !error.message.includes(dir),
    );
    assert.equal(existsSync(target), false);
  });

  test('ASSETS stores normalized JPEGs for landscape stock results and RENDER accepts them', async () => {
    const landscape = (query: AssetQuery): AssetCandidate[] => [
      { provider: 'mock', externalId: `wide-${query.sceneIndex}`, kind: 'image', url: null, width: 1920, height: 1080, durationSec: null, mimeType: 'image/png', metadata: {} },
    ];
    const assets = { ...createTestAssetServices(new MockAssetProvider({ search: landscape })), normalizer };
    const ctx: JobContext = {
      ai: new AIClient(new MockAIProvider()),
      assets,
      voice: createTestVoiceServices(undefined, assets.storage),
      render: createTestRenderServices(assets.storage),
    };
    const gen = await createProjectWithGeneration('Cá mập', 'Tại sao cá mập không ngủ?');
    let processed = 0;
    while (await processNextJob(quiet, ctx)) {
      processed++;
    }
    assert.equal(processed, 7);

    const prisma = getPrisma();
    const jobs = await prisma.job.findMany({ where: { videoId: gen.videoId } });
    assert.ok(
      jobs.every((j) => j.status === JobStatus.COMPLETED),
      jobs.map((j) => `${j.type}:${j.status}:${j.error ?? ''}`).join(', '),
    );
    const scenes = await prisma.scene.findMany({ where: { videoId: gen.videoId }, include: { selectedAsset: true }, orderBy: { index: 'asc' } });
    assert.ok(scenes.length > 0);
    for (const scene of scenes) {
      const asset = scene.selectedAsset;
      assert.ok(asset?.localPath?.endsWith('.jpg'), asset?.localPath ?? 'no localPath');
      assert.deepEqual([asset?.mimeType, asset?.width, asset?.height], ['image/jpeg', 1080, 1920]);
      const file = assets.storage.resolve(asset?.localPath ?? '');
      assert.deepEqual(parseImageInfo(readFileSync(file)), { format: 'jpeg', width: 1080, height: 1920 });
      assert.equal(existsSync(file.replace(/\.jpg$/, '.png')), false, 'the downloaded PNG is removed');
      const metadata = JSON.parse(asset?.metadataJson ?? '{}') as { normalized?: { tool?: string }; original?: { width?: number } };
      assert.equal(metadata.normalized?.tool, 'ffmpeg');
      assert.equal(metadata.original?.width, 1920);
    }
    assert.equal(await prisma.job.count({ where: { videoId: gen.videoId, type: JobType.RENDER, status: JobStatus.COMPLETED } }), 1);
  });
});
