/**
 * VOICE service and stage against a real (test) database, with mock/silent
 * providers and temporary storage (never calls Gemini).
 */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { AIClient } from '../lib/ai/client.js';
import { MockAIProvider } from '../lib/ai/providers/mock.js';
import { prepareVideoAssets } from '../lib/assets/service.js';
import { getPrisma } from '../lib/db/prisma.js';
import { JobStatus, JobType } from '../lib/generated/prisma/client.js';
import { processNextJob } from '../lib/jobs/process-job.js';
import type { JobContext } from '../lib/jobs/types.js';
import { VoiceError } from '../lib/voice/errors.js';
import { MockVoiceProvider, type MockVoiceOptions } from '../lib/voice/providers/mock.js';
import { synthesizeVideoVoice } from '../lib/voice/service.js';
import { VoiceJobResultSchema } from '../lib/voice/types.js';
import { parseWav } from '../lib/voice/wav.js';
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
const TEXTS = [
  'Bạn có bao giờ tự hỏi tại sao mình lại mơ không?',
  'Mỗi đêm, não bạn trải qua nhiều chu kỳ ngủ khác nhau.',
  'Trong giai đoạn REM, não hoạt động gần như lúc bạn thức.',
];

before(migrateTestDb);
after(removeTestDb);
beforeEach(resetDb);

/** Creates a video with the given scenes (inserted in reverse order to prove ORDER BY index). */
async function seedVideo(texts: string[], scriptLanguage: string | null = 'vi') {
  const gen = await createProjectWithGeneration('Giấc mơ', 'Tại sao con người lại mơ?');
  const prisma = getPrisma();
  await prisma.video.update({
    where: { id: gen.videoId },
    data: { scriptJson: scriptLanguage === null ? null : JSON.stringify({ language: scriptLanguage }), duration: 99 },
  });
  for (let i = texts.length - 1; i >= 0; i--) {
    await prisma.scene.create({
      data: { videoId: gen.videoId, index: i, text: texts[i] ?? '', duration: 7, startTime: i * 7, endTime: i * 7 + 7 },
    });
  }
  return gen;
}

/** Scene mode (one TTS request per scene); narration mode has its own suite in voice-narration.test.ts. */
function mockServices(options: MockVoiceOptions = {}) {
  const provider = new MockVoiceProvider(options);
  return { provider, services: createTestVoiceServices(provider, undefined, { mode: 'scene' }) };
}

async function voicedScenes(videoId: string) {
  return getPrisma().scene.findMany({ where: { videoId }, orderBy: { index: 'asc' }, include: { voiceAsset: true } });
}

async function expectVoiceError(promise: Promise<unknown>, code: VoiceError['code']): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof VoiceError && error.code === code);
}

describe('VOICE service', () => {
  test('one scene: saves a READY audio asset, links it and times the scene from the audio', async () => {
    const gen = await seedVideo([TEXTS[0] ?? '']);
    const { provider, services } = mockServices({ durationSec: () => 3.2 });
    const result = await synthesizeVideoVoice(gen, services, quiet);

    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0]?.text, TEXTS[0]);
    assert.equal(provider.calls[0]?.language, 'vi');
    assert.equal(provider.calls[0]?.voice, 'test-voice');
    assert.equal(provider.calls[0]?.style, 'Curious / mysterious', 'tone from Channel DNA');

    const [scene] = await voicedScenes(gen.videoId);
    const asset = scene?.voiceAsset;
    assert.ok(asset);
    assert.equal(asset.type, 'audio');
    assert.equal(asset.status, 'READY');
    assert.equal(asset.sceneId, null, 'Asset.sceneId stays reserved for visual candidates');
    assert.equal(asset.videoId, gen.videoId);
    assert.equal(asset.mimeType, 'audio/wav');
    assert.equal(asset.localPath, `audio/${gen.projectId}/${gen.videoId}/scene-01.wav`);
    assert.equal(asset.duration, 3.2);
    const file = await services.storage.read(asset.localPath ?? '');
    assert.equal(file.length, asset.sizeBytes);
    assert.equal(parseWav(file).durationSec, 3.2);
    const metadata = JSON.parse(asset.metadataJson ?? '{}') as Record<string, unknown>;
    for (const key of ['provider', 'model', 'voice', 'language', 'speed', 'style', 'cacheKey', 'sha256', 'sampleRate', 'channels', 'durationSec']) {
      assert.ok(key in metadata, `metadata.${key}`);
    }
    assert.equal(metadata['words'], null);

    assert.deepEqual([scene?.duration, scene?.startTime, scene?.endTime], [3.2, 0, 3.2]);
    assert.equal((await getPrisma().video.findUniqueOrThrow({ where: { id: gen.videoId } })).duration, 3.2);
    assert.deepEqual(VoiceJobResultSchema.parse(result).scenes[0]?.words, null);
  });

  test('multiple scenes: ordered by index, contiguous timing from real audio, Video.duration = total', async () => {
    const gen = await seedVideo(TEXTS);
    const durations = [2.5, 3.25, 4.125];
    const { provider, services } = mockServices({ durationSec: (r) => durations[r.sceneIndex] ?? 1 });
    const result = await synthesizeVideoVoice(gen, services, quiet);

    assert.deepEqual(
      provider.calls.map((c) => c.sceneIndex),
      [0, 1, 2],
    );
    assert.deepEqual(
      provider.calls.map((c) => c.text),
      TEXTS,
    );
    const scenes = await voicedScenes(gen.videoId);
    assert.deepEqual(
      scenes.map((s) => [s.duration, s.startTime, s.endTime]),
      [
        [2.5, 0, 2.5],
        [3.25, 2.5, 5.75],
        [4.125, 5.75, 9.875],
      ],
    );
    assert.equal((await getPrisma().video.findUniqueOrThrow({ where: { id: gen.videoId } })).duration, 9.875);
    assert.equal(result.durationSec, 9.875);
    assert.deepEqual(
      result.scenes.map((s) => s.localPath.split('/').at(-1)),
      ['scene-01.wav', 'scene-02.wav', 'scene-03.wav'],
    );
    assert.ok(result.scenes.every((s) => !s.cached));
    const files = await services.storage.list(`audio/${gen.projectId}/${gen.videoId}`);
    assert.equal(files.length, 3);
  });

  test('a re-run reuses valid cached audio without calling the provider', async () => {
    const gen = await seedVideo(TEXTS);
    const { provider, services } = mockServices();
    const first = await synthesizeVideoVoice(gen, services, quiet);
    const second = await synthesizeVideoVoice(gen, services, quiet);

    assert.equal(provider.calls.length, 3, 'no new TTS calls');
    assert.ok(second.scenes.every((s) => s.cached));
    assert.deepEqual(
      second.scenes.map((s) => s.audioAssetId),
      first.scenes.map((s) => s.audioAssetId),
    );
    assert.equal(second.durationSec, first.durationSec);
    assert.equal(await getPrisma().asset.count({ where: { type: 'audio' } }), 3);
  });

  test('changed text re-synthesizes only that scene and removes the stale audio', async () => {
    const gen = await seedVideo(TEXTS);
    const { provider, services } = mockServices();
    const first = await synthesizeVideoVoice(gen, services, quiet);
    await getPrisma().scene.updateMany({
      where: { videoId: gen.videoId, index: 1 },
      data: { text: 'Mỗi đêm, bộ não của bạn trải qua bốn đến sáu chu kỳ ngủ.' },
    });
    const second = await synthesizeVideoVoice(gen, services, quiet);

    assert.equal(provider.calls.length, 4);
    assert.equal(provider.calls[3]?.sceneIndex, 1);
    assert.deepEqual(
      second.scenes.map((s) => s.cached),
      [true, false, true],
    );
    assert.notEqual(second.scenes[1]?.audioAssetId, first.scenes[1]?.audioAssetId);
    assert.equal(await getPrisma().asset.count({ where: { type: 'audio' } }), 3, 'stale row removed');
    assert.equal((await services.storage.list(`audio/${gen.projectId}/${gen.videoId}`)).length, 3);
  });

  test('a corrupted cached file is detected and re-synthesized', async () => {
    const gen = await seedVideo(TEXTS.slice(0, 1));
    const { provider, services } = mockServices();
    const first = await synthesizeVideoVoice(gen, services, quiet);
    await services.storage.writeAtomic(first.scenes[0]?.localPath ?? '', Buffer.from('garbage'));
    const second = await synthesizeVideoVoice(gen, services, quiet);
    assert.equal(provider.calls.length, 2);
    assert.equal(second.scenes[0]?.cached, false);
    assert.ok(parseWav(await services.storage.read(second.scenes[0]?.localPath ?? '')).durationSec > 0);
  });

  test('a failing scene fails the run; earlier scenes stay READY and are reused next time', async () => {
    const gen = await seedVideo(TEXTS);
    let failSecond = true;
    const { provider, services } = mockServices({
      fail: (r) => (failSecond && r.sceneIndex === 1 ? new VoiceError('VOICE_RATE_LIMIT', 'quota exceeded') : undefined),
    });
    await expectVoiceError(synthesizeVideoVoice(gen, services, quiet), 'VOICE_RATE_LIMIT');

    const prisma = getPrisma();
    const scenes = await voicedScenes(gen.videoId);
    assert.equal(scenes[0]?.voiceAsset?.status, 'READY');
    assert.equal(scenes[1]?.voiceAssetId, null);
    assert.equal(scenes[2]?.voiceAssetId, null);
    const failed = await prisma.asset.findFirstOrThrow({ where: { type: 'audio', status: 'FAILED' } });
    assert.match(failed.metadataJson ?? '', /quota exceeded/);
    assert.equal((await prisma.video.findUniqueOrThrow({ where: { id: gen.videoId } })).duration, 99, 'timing untouched on failure');

    failSecond = false;
    const retry = await synthesizeVideoVoice(gen, services, quiet);
    assert.equal(provider.calls.length, 2 + 2, 'scene 1 reused, scenes 2-3 synthesized');
    assert.deepEqual(
      retry.scenes.map((s) => s.cached),
      [true, false, false],
    );
    assert.equal(await prisma.asset.count({ where: { type: 'audio', status: 'FAILED' } }), 0, 'failed rows cleaned up');
  });

  test('invalid or implausible audio is rejected with INVALID_AUDIO', async () => {
    const gen = await seedVideo(TEXTS.slice(0, 1));
    await expectVoiceError(synthesizeVideoVoice(gen, mockServices({ audio: () => Buffer.from('RIFFxxxxWAVEnope') }).services, quiet), 'INVALID_AUDIO');
    await expectVoiceError(synthesizeVideoVoice(gen, mockServices({ durationSec: () => 0.1 }).services, quiet), 'INVALID_AUDIO');
    await expectVoiceError(synthesizeVideoVoice(gen, mockServices({ durationSec: () => 200 }).services, quiet), 'INVALID_AUDIO');
    assert.equal(await getPrisma().asset.count({ where: { type: 'audio', status: 'READY' } }), 0);
  });

  test('narration validation: unaccented Vietnamese, empty text, unsupported language', async () => {
    const unaccented = await seedVideo([
      'Ban co biet vi sao bach tuoc lai co toi ba trai tim khong?',
      'Loai dong vat nay su dung mot trai tim chinh de nuoi co the.',
    ]);
    const { provider, services } = mockServices();
    await expectVoiceError(synthesizeVideoVoice(unaccented, services, quiet), 'TEXT_NOT_VIETNAMESE');
    assert.equal(provider.calls.length, 0, 'no TTS call for invalid narration');

    await resetDb();
    const empty = await seedVideo([TEXTS[0] ?? '', '   ']);
    await expectVoiceError(synthesizeVideoVoice(empty, mockServices().services, quiet), 'EMPTY_TEXT');

    await resetDb();
    const french = await seedVideo(['Bonjour à tous, voici une courte histoire.'], 'fr-FR');
    const viOnly = mockServices({ supportedLanguages: new Set(['vi']) });
    await expectVoiceError(synthesizeVideoVoice(french, viOnly.services, quiet), 'VOICE_UNSUPPORTED_LANGUAGE');
  });

  test('language falls back to Channel DNA when the script has none', async () => {
    const gen = await seedVideo(TEXTS.slice(0, 1), null);
    const { provider, services } = mockServices();
    await synthesizeVideoVoice(gen, services, quiet);
    assert.equal(provider.calls[0]?.language, 'vi');
  });

  test('scene index gaps are rejected', async () => {
    const gen = await seedVideo(TEXTS.slice(0, 1));
    await getPrisma().scene.create({ data: { videoId: gen.videoId, index: 5, text: TEXTS[1] ?? '' } });
    await assert.rejects(synthesizeVideoVoice(gen, mockServices().services, quiet), /contiguous/);
  });

  test('requests are sequential and respect VOICE_REQUEST_DELAY_MS', async () => {
    const gen = await seedVideo(TEXTS);
    const { services } = mockServices();
    const started = Date.now();
    await synthesizeVideoVoice(gen, { ...services, requestDelayMs: 40 }, quiet);
    assert.ok(Date.now() - started >= 80, 'two delays between three requests');
  });
});

describe('VOICE stage in the pipeline', () => {
  function context(voiceOptions: MockVoiceOptions = {}): JobContext & { voiceProvider: MockVoiceProvider } {
    const assets = createTestAssetServices();
    const voiceProvider = new MockVoiceProvider(voiceOptions);
    return {
      ai: new AIClient(new MockAIProvider()),
      assets,
      voice: createTestVoiceServices(voiceProvider, assets.storage, { mode: 'scene' }),
      render: createTestRenderServices(assets.storage),
      voiceProvider,
    };
  }

  async function runPipeline(ctx: JobContext) {
    const gen = await createProjectWithGeneration('Tại sao con người lại mơ?', 'Tại sao con người lại mơ?');
    while (await processNextJob(quiet, ctx)) {
      // run until idle
    }
    return gen;
  }

  test('VOICE produces real audio, retimes the video and hands off to SUBTITLES', async () => {
    const ctx = context();
    const gen = await runPipeline(ctx);
    const prisma = getPrisma();

    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: gen.projectId } })).status, 'COMPLETED');
    const voiceJob = await prisma.job.findFirstOrThrow({ where: { type: JobType.VOICE } });
    assert.equal(voiceJob.status, JobStatus.COMPLETED);
    const result = VoiceJobResultSchema.parse(JSON.parse(voiceJob.resultJson ?? ''));
    assert.equal(result.provider, 'mock');
    assert.equal(result.scenes.length, 7);
    assert.equal((await prisma.job.findFirstOrThrow({ where: { type: JobType.SUBTITLES } })).status, JobStatus.COMPLETED);

    const scenes = await voicedScenes(gen.videoId);
    assert.ok(scenes.every((s) => s.voiceAsset?.status === 'READY' && s.assetId !== null));
    const video = await prisma.video.findUniqueOrThrow({ where: { id: gen.videoId } });
    assert.equal(video.duration, result.durationSec);
    assert.equal(scenes.at(-1)?.endTime, result.durationSec);
    assert.doesNotMatch(voiceJob.resultJson ?? '', /[A-Za-z]:\\\\|"\/[^/]/, 'no absolute paths');
    const dir = path.join(ctx.voice.storage.root, 'audio', gen.projectId, gen.videoId);
    assert.equal(readdirSync(dir).length, 7);
  });

  test('a VOICE failure fails the job and the pipeline (no silent fallback)', async () => {
    const ctx = context({ fail: () => new VoiceError('VOICE_AUTH', 'Gemini TTS rejected the credentials (HTTP 403)') });
    const gen = await runPipeline(ctx);
    const prisma = getPrisma();
    const voiceJob = await prisma.job.findFirstOrThrow({ where: { type: JobType.VOICE } });
    assert.equal(voiceJob.status, JobStatus.FAILED);
    assert.match(voiceJob.error ?? '', /HTTP 403/);
    assert.equal(await prisma.job.count({ where: { type: JobType.SUBTITLES } }), 0);
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: gen.projectId } })).status, 'FAILED');
  });

  test('regression: re-running ASSETS never deletes audio assets', async () => {
    const ctx = context();
    const gen = await runPipeline(ctx);
    const before = await voicedScenes(gen.videoId);

    await prepareVideoAssets({ projectId: gen.projectId, videoId: gen.videoId }, ctx.assets, quiet);

    const prisma = getPrisma();
    assert.equal(await prisma.asset.count({ where: { type: 'audio', status: 'READY' } }), 7);
    const after = await voicedScenes(gen.videoId);
    assert.deepEqual(
      after.map((s) => s.voiceAssetId),
      before.map((s) => s.voiceAssetId),
    );
    for (const scene of after) {
      assert.ok(await ctx.voice.storage.exists(scene.voiceAsset?.localPath ?? ''), 'audio file kept');
    }
    assert.equal(await prisma.asset.count({ where: { type: { in: ['image', 'video'] } } }), 7, 'visual assets rebuilt');

    // And VOICE after that still hits its cache.
    const calls = ctx.voiceProvider.calls.length;
    await synthesizeVideoVoice(gen, ctx.voice, quiet);
    assert.equal(ctx.voiceProvider.calls.length, calls);
  });
});
