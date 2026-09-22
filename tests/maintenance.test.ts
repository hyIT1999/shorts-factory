/**
 * Storage maintenance: the database↔files consistency check and the sweep
 * (orphans, abandoned render directories, retention of old versions), on a
 * temporary storage root with a real pipeline (mock providers).
 */
import assert from 'node:assert/strict';
import { existsSync, utimesSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { AIClient } from '../lib/ai/client.js';
import { MockAIProvider } from '../lib/ai/providers/mock.js';
import { getPrisma } from '../lib/db/prisma.js';
import { processNextJob } from '../lib/jobs/process-job.js';
import type { JobContext } from '../lib/jobs/types.js';
import { checkData, sweepData } from '../lib/maintenance/index.js';
import { startGeneration } from '../server/services/projects.js';
import {
  createProjectWithGeneration,
  createTestAssetServices,
  createTestRenderServices,
  createTestVoiceServices,
  migrateTestDb,
  removeTestDb,
  resetDb,
} from './helpers.js';

const quiet = (): void => {};
const TOPIC = 'Tại sao con người lại mơ?';
const DAY_MS = 24 * 60 * 60_000;

function context(): JobContext {
  const assets = createTestAssetServices();
  return {
    ai: new AIClient(new MockAIProvider()),
    assets,
    voice: createTestVoiceServices(undefined, assets.storage),
    render: createTestRenderServices(assets.storage),
  };
}

async function runAll(ctx: JobContext): Promise<void> {
  while (await processNextJob(quiet, ctx)) {
    // until idle
  }
}

/** Gives a completed (mock-rendered) video a rendered file, as the job engine would record it. */
async function fakeRender(ctx: JobContext, projectId: string, videoId: string): Promise<string> {
  const outputPath = `renders/${projectId}/${videoId}/video.mp4`;
  await ctx.assets.storage.writeAtomic(outputPath, Buffer.from('fake mp4 bytes'));
  await getPrisma().video.update({ where: { id: videoId }, data: { outputPath } });
  return outputPath;
}

const codesOf = (issues: { code: string }[]) => [...new Set(issues.map((issue) => issue.code))].sort();

before(migrateTestDb);
after(removeTestDb);
beforeEach(resetDb);

describe('checkData', () => {
  test('a clean pipeline has no issues; every kind of inconsistency is reported', async () => {
    const ctx = context();
    const storage = ctx.assets.storage;
    const prisma = getPrisma();
    const gen = await createProjectWithGeneration('Clean', TOPIC);
    await runAll(ctx);
    const outputPath = await fakeRender(ctx, gen.projectId, gen.videoId);

    let report = await checkData(storage);
    assert.deepEqual(report.issues, []);
    assert.equal(report.counts.videos, 1);
    assert.equal(report.counts.readyAssets, 14, '7 images + 7 narrations');
    assert.equal(report.counts.dirs, 3, 'assets, audio and renders of one video');

    const audio = await prisma.asset.findFirstOrThrow({ where: { type: 'audio', status: 'READY' } });
    assert.ok(audio.localPath && audio.sizeBytes);
    await storage.writeAtomic(audio.localPath, Buffer.from('short'));
    report = await checkData(storage);
    assert.deepEqual(codesOf(report.issues), ['ASSET_SIZE_MISMATCH']);
    assert.equal(report.issues[0]?.id, audio.id);

    await storage.writeAtomic(audio.localPath, Buffer.alloc(audio.sizeBytes, 1));
    assert.deepEqual(codesOf((await checkData(storage)).issues), ['ASSET_CHECKSUM_MISMATCH']);

    await storage.remove(audio.localPath);
    assert.deepEqual(codesOf((await checkData(storage)).issues), ['ASSET_FILE_MISSING']);

    await storage.remove(outputPath);
    assert.deepEqual(codesOf((await checkData(storage)).issues), ['ASSET_FILE_MISSING', 'OUTPUT_FILE_MISSING']);

    await prisma.video.update({ where: { id: gen.videoId }, data: { outputPath: null } });
    await mkdir(storage.resolve('assets/orphanproject123/orphanvideo456'), { recursive: true });
    await writeFile(storage.resolve(`audio/${gen.projectId}/${gen.videoId}/scene-01.wav.abc.tmp`), 'partial');
    await prisma.asset.create({
      data: { videoId: gen.videoId, type: 'image', provider: 'mock', status: 'DOWNLOADING', createdAt: new Date(Date.now() - 2 * 60 * 60_000) },
    });
    // Directories that are not named like our ids are none of our business.
    await mkdir(storage.resolve('assets/not our dir!/x'), { recursive: true });
    report = await checkData(storage);
    assert.deepEqual(codesOf(report.issues), ['ASSET_FILE_MISSING', 'ASSET_STUCK', 'ORPHAN_DIR', 'TEMP_FILE', 'VIDEO_WITHOUT_OUTPUT']);
    assert.equal(report.issues.find((issue) => issue.code === 'ORPHAN_DIR')?.path, 'assets/orphanproject123/orphanvideo456');
    assert.ok(report.issues.every((issue) => !issue.detail.includes('not our dir')));
  });
});

describe('sweepData', () => {
  test('dry run lists; apply removes orphans, abandoned tmp and old versions, and keeps the latest version and unknown files', async () => {
    const ctx = context();
    const storage = ctx.assets.storage;
    const prisma = getPrisma();

    const v1 = await createProjectWithGeneration('Versions', TOPIC);
    await runAll(ctx);
    await fakeRender(ctx, v1.projectId, v1.videoId);
    const v2 = await startGeneration(v1.projectId);
    await runAll(ctx);
    const v2Output = await fakeRender(ctx, v2.projectId, v2.videoId);
    const v2Assets = await prisma.asset.count({ where: { videoId: v2.videoId } });
    assert.ok(v2Assets > 0);
    // Both versions are old; only v1 is not the latest.
    const longAgo = new Date(Date.now() - 40 * DAY_MS);
    await prisma.video.updateMany({ where: { projectId: v1.projectId }, data: { createdAt: longAgo } });

    const orphan = storage.resolve('renders/orphanproject123/orphanvideo456');
    await mkdir(orphan, { recursive: true });
    await writeFile(path.join(orphan, 'video.mp4'), 'x');
    const deadJob = storage.resolve(`tmp/render/${v2.projectId}/${v2.videoId}/dead-job`);
    const liveJob = storage.resolve(`tmp/render/${v2.projectId}/${v2.videoId}/live-job`);
    for (const dir of [deadJob, liveJob]) {
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'video.tmp.mp4'), 'work');
    }
    const eightyMinutesAgo = new Date(Date.now() - 80 * 60_000);
    utimesSync(path.join(deadJob, 'video.tmp.mp4'), eightyMinutesAgo, eightyMinutesAgo);
    utimesSync(deadJob, eightyMinutesAgo, eightyMinutesAgo);
    const strays = [storage.resolve('shorts-factory.db'), storage.resolve('assets/README.txt'), storage.resolve('assets/not our dir!/x/file')];
    for (const file of strays) {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, 'keep me');
    }
    const v1Dirs = ['assets', 'audio', 'renders'].map((kind) => `${kind}/${v1.projectId}/${v1.videoId}`);
    const v2Dirs = ['assets', 'audio', 'renders'].map((kind) => `${kind}/${v2.projectId}/${v2.videoId}`);

    const dry = await sweepData(storage, { dryRun: true, retentionDays: 30 });
    assert.equal(dry.dryRun, true);
    assert.deepEqual(
      dry.actions.map((action) => [action.kind, action.target, action.applied]).sort(),
      [
        ['OLD_VERSION_FILES', v1Dirs[0], false],
        ['OLD_VERSION_FILES', v1Dirs[1], false],
        ['OLD_VERSION_FILES', v1Dirs[2], false],
        ['OLD_VERSION_ROWS', v1.videoId, false],
        ['ORPHAN_DIR', 'renders/orphanproject123/orphanvideo456', false],
        ['STALE_TMP', `tmp/render/${v2.projectId}/${v2.videoId}/dead-job`, false],
      ].sort(),
    );
    assert.ok(existsSync(orphan) && existsSync(deadJob), 'a dry run removes nothing');
    assert.ok(v1Dirs.every((dir) => existsSync(storage.resolve(dir))));

    const applied = await sweepData(storage, { dryRun: false, retentionDays: 30 });
    assert.equal(applied.actions.length, 6);
    assert.ok(applied.actions.every((action) => action.applied && !action.error), JSON.stringify(applied.actions));
    assert.equal(existsSync(orphan), false);
    assert.equal(existsSync(deadJob), false);
    assert.equal(existsSync(path.join(liveJob, 'video.tmp.mp4')), true, 'a render in progress is left alone');
    assert.ok(v1Dirs.every((dir) => !existsSync(storage.resolve(dir))), 'files of the old version are gone');
    assert.equal(await prisma.asset.count({ where: { videoId: v1.videoId } }), 0, 'its asset rows too');
    const oldVideo = await prisma.video.findUniqueOrThrow({ where: { id: v1.videoId } });
    assert.deepEqual([oldVideo.outputPath, oldVideo.status], [null, 'COMPLETED'], 'the video row stays, without a dangling output path');
    assert.ok(v2Dirs.every((dir) => existsSync(storage.resolve(dir))), 'the latest version keeps its files even though it is old');
    assert.equal(await prisma.asset.count({ where: { videoId: v2.videoId } }), v2Assets);
    assert.equal((await prisma.video.findUniqueOrThrow({ where: { id: v2.videoId } })).outputPath, v2Output);
    assert.ok(strays.every(existsSync), 'files we did not create are never touched');

    assert.deepEqual((await sweepData(storage, { dryRun: false, retentionDays: 30 })).actions, [], 'idempotent');
  });
});
