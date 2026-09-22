/**
 * ASSETS stage against a real (test) database, mock AI and temporary storage.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { AIClient } from '../lib/ai/client.js';
import { MockAIProvider } from '../lib/ai/providers/mock.js';
import type { AssetServices } from '../lib/assets/index.js';
import type { ImageNormalizer } from '../lib/assets/normalize.js';
import { MockAssetProvider, type MockAssetProviderOptions } from '../lib/assets/providers/mock.js';
import { renderPlaceholderPng } from '../lib/assets/providers/placeholder.js';
import { prepareVideoAssets } from '../lib/assets/service.js';
import { LocalAssetStorage, sceneFileBase } from '../lib/assets/storage.js';
import { AssetError, AssetsResultSchema, type AssetCandidate } from '../lib/assets/types.js';
import { getPrisma } from '../lib/db/prisma.js';
import { JobStatus, JobType } from '../lib/generated/prisma/client.js';
import { processNextJob } from '../lib/jobs/process-job.js';
import type { JobContext } from '../lib/jobs/types.js';
import {
  createProjectWithGeneration,
  createTestAssetServices,
  createTestRenderServices,
  createTestVoiceServices,
  migrateTestDb,
  removeTestDb,
  resetDb,
} from './helpers.js';
import { pngHeader, syntheticJpeg } from './image-fixtures.js';

const quiet = (): void => {};
const SCENES = 7; // the mock AI scene fixture has 7 scenes

before(migrateTestDb);
after(removeTestDb);
beforeEach(resetDb);

function context(assets: AssetServices = createTestAssetServices()): JobContext {
  return {
    ai: new AIClient(new MockAIProvider()),
    assets,
    voice: createTestVoiceServices(undefined, assets.storage),
    render: createTestRenderServices(assets.storage),
  };
}

/** Runs RESEARCH, SCRIPT and SCENES so ASSETS is the next pending job. */
async function generateUntilAssets(ctx: JobContext) {
  const gen = await createProjectWithGeneration('Tại sao con người lại mơ?', 'Tại sao con người lại mơ?');
  for (let i = 0; i < 3; i++) {
    assert.equal(await processNextJob(quiet, ctx), true);
  }
  const pending = await getPrisma().job.findFirstOrThrow({ where: { status: JobStatus.PENDING } });
  assert.equal(pending.type, JobType.ASSETS);
  return gen;
}

function pngSize(file: string): { width: number; height: number } {
  const png = readFileSync(file);
  assert.equal(png.toString('ascii', 1, 4), 'PNG');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

async function sceneAssets(videoId: string) {
  return getPrisma().scene.findMany({
    where: { videoId },
    orderBy: { index: 'asc' },
    include: { selectedAsset: true },
  });
}

describe('ASSETS stage (placeholder provider)', () => {
  test('creates a READY asset, a local PNG and Scene.assetId for every scene, then VOICE', async () => {
    const assets = createTestAssetServices();
    const ctx = context(assets);
    const gen = await generateUntilAssets(ctx);
    assert.equal(await processNextJob(quiet, ctx), true);

    const prisma = getPrisma();
    const scenes = await sceneAssets(gen.videoId);
    assert.equal(scenes.length, SCENES);
    assert.equal(await prisma.asset.count(), SCENES);

    const dir = path.join(assets.storage.root, 'assets', gen.projectId, gen.videoId);
    assert.deepEqual(
      readdirSync(dir).sort(),
      Array.from({ length: SCENES }, (_, i) => `scene-${String(i + 1).padStart(2, '0')}.png`),
    );

    for (const scene of scenes) {
      const asset = scene.selectedAsset;
      assert.ok(asset, `scene ${scene.index} has a selected asset`);
      assert.equal(scene.assetId, asset.id);
      assert.equal(asset.sceneId, scene.id, 'candidate link');
      assert.equal(asset.videoId, gen.videoId);
      assert.equal(asset.status, 'READY');
      assert.equal(asset.provider, 'placeholder');
      assert.equal(asset.type, 'image');
      assert.equal(asset.mimeType, 'image/png');
      assert.equal(asset.localPath, `assets/${gen.projectId}/${gen.videoId}/scene-${String(scene.index + 1).padStart(2, '0')}.png`);
      assert.equal(path.isAbsolute(asset.localPath ?? ''), false);
      assert.ok((asset.sizeBytes ?? 0) > 0);
      const file = assets.storage.resolve(asset.localPath ?? '');
      assert.equal(readFileSync(file).length, asset.sizeBytes);
      assert.deepEqual(pngSize(file), { width: 1080, height: 1920 });
      const metadata = JSON.parse(asset.metadataJson ?? '{}') as Record<string, unknown>;
      assert.equal(metadata['fallback'], false);
      assert.match(String(metadata['sha256']), /^[0-9a-f]{64}$/);
    }

    const job = await prisma.job.findFirstOrThrow({ where: { type: JobType.ASSETS } });
    assert.equal(job.status, JobStatus.COMPLETED);
    const result = AssetsResultSchema.parse(JSON.parse(job.resultJson ?? ''));
    assert.equal(result.provider, 'placeholder');
    assert.equal(result.scenes.length, SCENES);
    assert.deepEqual(result.scenes[0]?.source, { provider: 'placeholder', externalId: null, url: null });
    assert.doesNotMatch(job.resultJson ?? '', /[A-Za-z]:\\\\|"\/(?!\/)|\\\\/, 'no absolute or Windows paths in the result');
    assert.ok(!(job.resultJson ?? '').includes(assets.storage.root.replaceAll('\\', '\\\\')));

    const next = await prisma.job.findFirstOrThrow({ where: { status: JobStatus.PENDING } });
    assert.equal(next.type, JobType.VOICE);
  });

  test('re-running ASSETS for the same video replaces assets instead of duplicating them', async () => {
    const assets = createTestAssetServices();
    const ctx = context(assets);
    const gen = await generateUntilAssets(ctx);
    assert.equal(await processNextJob(quiet, ctx), true);
    const firstIds = (await sceneAssets(gen.videoId)).map((s) => s.assetId);

    await prepareVideoAssets({ projectId: gen.projectId, videoId: gen.videoId }, assets, quiet);
    await prepareVideoAssets({ projectId: gen.projectId, videoId: gen.videoId }, assets, quiet);

    const prisma = getPrisma();
    assert.equal(await prisma.asset.count(), SCENES, 'still one asset per scene');
    const scenes = await sceneAssets(gen.videoId);
    assert.ok(scenes.every((s) => s.selectedAsset?.status === 'READY'));
    assert.ok(scenes.every((s, i) => s.assetId !== firstIds[i]), 'old rows were replaced');
    const files = readdirSync(path.join(assets.storage.root, 'assets', gen.projectId, gen.videoId));
    assert.equal(files.length, SCENES, 'no extra or temp files');
  });

  test('the full pipeline still completes with real assets', async () => {
    const ctx = context();
    const gen = await createProjectWithGeneration('Cá mập', 'Tại sao cá mập không ngủ?');
    let processed = 0;
    while (await processNextJob(quiet, ctx)) {
      processed++;
    }
    assert.equal(processed, 7);
    const prisma = getPrisma();
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: gen.projectId } })).status, 'COMPLETED');
    assert.equal(await prisma.scene.count({ where: { videoId: gen.videoId, assetId: { not: null } } }), SCENES);
  });

  test('deleting the project removes its assets from the database', async () => {
    const ctx = context();
    const gen = await generateUntilAssets(ctx);
    await processNextJob(quiet, ctx);
    await getPrisma().project.delete({ where: { id: gen.projectId } });
    assert.equal(await getPrisma().asset.count(), 0);
  });
});

describe('ASSETS stage (mock provider, selection and fallback)', () => {
  async function runAssets(options: MockAssetProviderOptions = {}) {
    const provider = new MockAssetProvider(options);
    const assets = createTestAssetServices(provider);
    const ctx = context(assets);
    const gen = await generateUntilAssets(ctx);
    assert.equal(await processNextJob(quiet, ctx), true);
    const job = await getPrisma().job.findFirstOrThrow({ where: { type: JobType.ASSETS } });
    return { gen, assets, provider, job };
  }

  test('records candidates and selects the portrait one deterministically', async () => {
    const { gen, provider, job } = await runAssets();
    const prisma = getPrisma();
    assert.equal(job.status, JobStatus.COMPLETED);
    assert.equal(provider.searches.length, SCENES);
    assert.equal(provider.searches[0]?.text, 'person sleeping night moonlight');

    const all = await prisma.asset.findMany({ where: { videoId: gen.videoId } });
    assert.equal(all.length, SCENES, 'the untried candidate of every scene is removed once one is stored');
    assert.equal(all.filter((a) => a.status === 'READY').length, SCENES);
    assert.equal(all.filter((a) => a.status === 'DISCOVERED').length, 0, 'nothing is left DISCOVERED');

    for (const scene of await sceneAssets(gen.videoId)) {
      assert.equal(scene.selectedAsset?.externalId, `mock-${scene.index}-portrait`);
      assert.equal(scene.selectedAsset?.height, 1920);
    }
    const result = AssetsResultSchema.parse(JSON.parse(job.resultJson ?? ''));
    assert.equal(result.provider, 'mock');
    assert.ok(result.scenes.every((s) => !s.fallback && s.source.provider === 'mock'));
  });

  test('no candidates → placeholder fallback with NO_CANDIDATES', async () => {
    const { gen, job } = await runAssets({ search: () => [] });
    assert.equal(job.status, JobStatus.COMPLETED);
    for (const scene of await sceneAssets(gen.videoId)) {
      const asset = scene.selectedAsset;
      assert.equal(asset?.provider, 'placeholder');
      assert.equal(asset?.status, 'READY');
      const metadata = JSON.parse(asset?.metadataJson ?? '{}') as Record<string, unknown>;
      assert.equal(metadata['fallback'], true);
      assert.equal(metadata['fallbackReason'], 'NO_CANDIDATES');
    }
    const result = AssetsResultSchema.parse(JSON.parse(job.resultJson ?? ''));
    assert.ok(result.scenes.every((s) => s.fallback && s.source.provider === 'placeholder'));
  });

  test('a provider search error → placeholder fallback with the error recorded', async () => {
    const { gen, job } = await runAssets({
      search: () => {
        throw new Error('stock API unavailable');
      },
    });
    assert.equal(job.status, JobStatus.COMPLETED);
    const [first] = await sceneAssets(gen.videoId);
    const metadata = JSON.parse(first?.selectedAsset?.metadataJson ?? '{}') as Record<string, unknown>;
    assert.equal(metadata['fallbackReason'], 'PROVIDER_ERROR');
    assert.equal(metadata['error'], 'stock API unavailable');
  });

  test('failed downloads mark candidates FAILED, then fall back to placeholder', async () => {
    const { gen, job } = await runAssets({
      open: () => {
        throw new Error('HTTP 503');
      },
    });
    assert.equal(job.status, JobStatus.COMPLETED);
    const all = await getPrisma().asset.findMany({ where: { videoId: gen.videoId } });
    assert.equal(all.filter((a) => a.status === 'FAILED').length, SCENES * 2);
    assert.equal(all.filter((a) => a.status === 'READY' && a.provider === 'placeholder').length, SCENES);
    const failed = all.find((a) => a.status === 'FAILED');
    assert.equal((JSON.parse(failed?.metadataJson ?? '{}') as Record<string, unknown>)['error'], 'HTTP 503');
    const [first] = await sceneAssets(gen.videoId);
    assert.equal(
      (JSON.parse(first?.selectedAsset?.metadataJson ?? '{}') as Record<string, unknown>)['fallbackReason'],
      'DOWNLOAD_FAILED',
    );
  });

  test('a storage failure (no fallback possible) fails the job and stops the pipeline', async () => {
    const assets = createTestAssetServices();
    const broken = Object.assign(Object.create(LocalAssetStorage.prototype) as LocalAssetStorage, assets.storage, {
      writeAtomic: async () => {
        throw new Error('disk full');
      },
    });
    const ctx = context({ ...assets, storage: broken });
    const gen = await generateUntilAssets(ctx);
    assert.equal(await processNextJob(quiet, ctx), true);

    const prisma = getPrisma();
    const job = await prisma.job.findFirstOrThrow({ where: { type: JobType.ASSETS } });
    assert.equal(job.status, JobStatus.FAILED);
    assert.match(job.error ?? '', /disk full/);
    assert.equal(await prisma.job.count({ where: { type: JobType.VOICE } }), 0, 'VOICE is not created');
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: gen.projectId } })).status, 'FAILED');
  });
});

describe('ASSETS stage (image checks, normalization and ASSET_FALLBACK)', () => {
  const portrait = (id: string, mimeType = 'image/png'): AssetCandidate => ({
    provider: 'mock',
    externalId: id,
    kind: 'image',
    url: null,
    width: 1080,
    height: 1920,
    durationSec: null,
    mimeType,
    metadata: {},
  });
  const landscape = (id: string): AssetCandidate => ({ ...portrait(id), width: 1920, height: 1080 });

  /** A normalizer that records its calls and writes whatever bytes it is given. */
  function fakeNormalizer(output: () => Buffer): ImageNormalizer & { calls: [string, string][] } {
    return {
      name: 'fake',
      calls: [],
      async normalize(source, target) {
        this.calls.push([source, target]);
        writeFileSync(target, output());
      },
    };
  }

  async function run(options: MockAssetProviderOptions, extra: Partial<AssetServices> = {}) {
    const assets = { ...createTestAssetServices(new MockAssetProvider(options)), ...extra };
    const ctx = context(assets);
    const gen = await generateUntilAssets(ctx);
    assert.equal(await processNextJob(quiet, ctx), true);
    const job = await getPrisma().job.findFirstOrThrow({ where: { type: JobType.ASSETS } });
    return { gen, assets, job, dir: path.join(assets.storage.root, 'assets', gen.projectId, gen.videoId) };
  }

  const metadataOf = (asset: { metadataJson: string | null } | null | undefined): Record<string, unknown> =>
    JSON.parse(asset?.metadataJson ?? '{}') as Record<string, unknown>;

  test('a download that is not an image is marked FAILED and the next candidate is used', async () => {
    const { gen, job, dir } = await run({
      search: (q) => [portrait(`bad-${q.sceneIndex}`), portrait(`good-${q.sceneIndex}`)],
      open: (c) => (c.externalId?.startsWith('bad') ? Buffer.from('<html>not an image</html>') : renderPlaceholderPng(c.externalId ?? '', 1080, 1920)),
    });
    assert.equal(job.status, JobStatus.COMPLETED);
    const all = await getPrisma().asset.findMany({ where: { videoId: gen.videoId } });
    const failed = all.filter((a) => a.status === 'FAILED');
    assert.equal(failed.length, SCENES);
    assert.match(String(metadataOf(failed[0])['error']), /Not a usable image: Not a PNG, JPEG or WebP/);
    for (const scene of await sceneAssets(gen.videoId)) {
      assert.equal(scene.selectedAsset?.externalId, `good-${scene.index}`);
      assert.equal(scene.selectedAsset?.status, 'READY');
      assert.deepEqual([scene.selectedAsset?.width, scene.selectedAsset?.height], [1080, 1920]);
    }
    assert.equal(readdirSync(dir).length, SCENES, 'rejected downloads leave no files behind');
  });

  test('oversized or mislabelled images are rejected from their header; fallback reason INVALID_IMAGE', async () => {
    const { gen, job, dir } = await run({
      search: (q) => [portrait(`huge-${q.sceneIndex}`), portrait(`mislabelled-${q.sceneIndex}`)],
      open: (c) => (c.externalId?.startsWith('huge') ? pngHeader(20_000, 20_000) : syntheticJpeg(1080, 1920)),
    });
    assert.equal(job.status, JobStatus.COMPLETED);
    const all = await getPrisma().asset.findMany({ where: { videoId: gen.videoId } });
    const errors = all.filter((a) => a.status === 'FAILED').map((a) => String(metadataOf(a)['error']));
    assert.equal(errors.length, SCENES * 2);
    assert.ok(errors.some((e) => /Image 20000×20000 px exceeds 12000 px per side/.test(e)), errors.join('\n'));
    assert.ok(errors.some((e) => /declared image\/png but the file is a JPEG/.test(e)), errors.join('\n'));
    for (const scene of await sceneAssets(gen.videoId)) {
      assert.equal(scene.selectedAsset?.provider, 'placeholder');
      assert.equal(metadataOf(scene.selectedAsset)['fallbackReason'], 'INVALID_IMAGE');
    }
    assert.equal(readdirSync(dir).length, SCENES);
  });

  test('images larger than 1080×1920 are normalized to JPEG when a normalizer is configured', async () => {
    const jpeg = syntheticJpeg(1080, 1920);
    const normalizer = fakeNormalizer(() => jpeg);
    const { gen, job, dir } = await run({ search: (q) => [landscape(`wide-${q.sceneIndex}`)] }, { normalizer });
    assert.equal(job.status, JobStatus.COMPLETED);
    assert.equal(normalizer.calls.length, SCENES);
    assert.ok(
      normalizer.calls.every(([source, target]) => source.endsWith('.png') && target.startsWith(source) && target.endsWith('.normalized')),
      JSON.stringify(normalizer.calls),
    );
    const expectedSha = createHash('sha256').update(jpeg).digest('hex');
    for (const scene of await sceneAssets(gen.videoId)) {
      const asset = scene.selectedAsset;
      assert.equal(asset?.localPath, `assets/${gen.projectId}/${gen.videoId}/${sceneFileBase(scene.index)}.jpg`);
      assert.deepEqual([asset?.mimeType, asset?.width, asset?.height, asset?.sizeBytes], ['image/jpeg', 1080, 1920, jpeg.length]);
      const metadata = metadataOf(asset);
      assert.equal(metadata['sha256'], expectedSha);
      assert.deepEqual(metadata['normalized'], { tool: 'fake', width: 1080, height: 1920 });
      const original = metadata['original'] as Record<string, unknown>;
      assert.deepEqual([original['width'], original['height'], original['mimeType']], [1920, 1080, 'image/png']);
      assert.ok(typeof original['sizeBytes'] === 'number' && original['sizeBytes'] > 0);
      assert.match(String(original['sha256']), /^[0-9a-f]{64}$/);
    }
    assert.deepEqual(
      readdirSync(dir).sort(),
      [...Array(SCENES).keys()].map((i) => `${sceneFileBase(i)}.jpg`),
    );
    const result = AssetsResultSchema.parse(JSON.parse(job.resultJson ?? ''));
    assert.ok(result.scenes.every((s) => s.width === 1080 && s.height === 1920 && s.localPath.endsWith('.jpg') && !s.fallback));
  });

  test('images already at the render size skip the normalizer; a wrong normalizer result falls back', async () => {
    const untouched = fakeNormalizer(() => syntheticJpeg(1080, 1920));
    const first = await run({}, { normalizer: untouched });
    assert.equal(first.job.status, JobStatus.COMPLETED);
    assert.equal(untouched.calls.length, 0);
    for (const scene of await sceneAssets(first.gen.videoId)) {
      assert.equal(scene.selectedAsset?.mimeType, 'image/png');
    }

    await resetDb();
    const wrongSize = fakeNormalizer(() => syntheticJpeg(800, 600));
    const second = await run({ search: (q) => [landscape(`wide-${q.sceneIndex}`)] }, { normalizer: wrongSize });
    assert.equal(second.job.status, JobStatus.COMPLETED);
    for (const scene of await sceneAssets(second.gen.videoId)) {
      assert.equal(scene.selectedAsset?.provider, 'placeholder');
      const metadata = metadataOf(scene.selectedAsset);
      assert.equal(metadata['fallbackReason'], 'INVALID_IMAGE');
      assert.match(String(metadata['error']), /Normalized image is 800×600 jpeg, expected 1080×1920 jpeg/);
    }
    assert.equal(readdirSync(second.dir).length, SCENES, 'no temp or rejected files remain');
  });

  test('a normalizer that cannot start ffmpeg fails the job (configuration, not a candidate problem)', async () => {
    const broken: ImageNormalizer = {
      name: 'ffmpeg',
      async normalize() {
        throw new AssetError('CONFIG', 'Could not start ffmpeg to normalize an image (ENOENT); check FFMPEG_PATH');
      },
    };
    const { gen, job } = await run({ search: (q) => [landscape(`wide-${q.sceneIndex}`)] }, { normalizer: broken });
    assert.equal(job.status, JobStatus.FAILED);
    assert.match(job.error ?? '', /Could not start ffmpeg/);
    assert.equal((await getPrisma().project.findUniqueOrThrow({ where: { id: gen.projectId } })).status, 'FAILED');
  });

  test('ASSET_FALLBACK=fail fails the job instead of using a placeholder', async () => {
    const { gen, job } = await run({ search: () => [] }, { fallbackMode: 'fail' });
    assert.equal(job.status, JobStatus.FAILED);
    assert.match(job.error ?? '', /Scene 1: mock found nothing for "person sleeping night moonlight"/);
    assert.match(job.error ?? '', /ASSET_FALLBACK=fail/);
    const prisma = getPrisma();
    assert.equal(await prisma.job.count({ where: { type: JobType.VOICE } }), 0);
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: gen.projectId } })).status, 'FAILED');
    assert.equal(await prisma.scene.count({ where: { videoId: gen.videoId, assetId: { not: null } } }), 0);
  });
});
