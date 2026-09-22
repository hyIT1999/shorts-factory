/**
 * VOICE narration mode against a real (test) database: one TTS request for
 * the whole narration, cut into per-scene WAVs. Mock/silent providers and
 * temporary storage; Gemini is never called.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { AIClient } from '../lib/ai/client.js';
import { MockAIProvider } from '../lib/ai/providers/mock.js';
import { getPrisma } from '../lib/db/prisma.js';
import { JobStatus, JobType } from '../lib/generated/prisma/client.js';
import { processNextJob } from '../lib/jobs/process-job.js';
import type { JobContext } from '../lib/jobs/types.js';
import { VoiceError } from '../lib/voice/errors.js';
import { MockVoiceProvider, type MockVoiceOptions } from '../lib/voice/providers/mock.js';
import { AUDIO_ASSET_TYPE, NARRATION_ASSET_TYPE, synthesizeVideoVoice } from '../lib/voice/service.js';
import { VoiceJobResultSchema } from '../lib/voice/types.js';
import { encodeWav, parseWav } from '../lib/voice/wav.js';
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

async function seedVideo(texts: string[]) {
  const gen = await createProjectWithGeneration('Giấc mơ', 'Tại sao con người lại mơ?');
  const prisma = getPrisma();
  await prisma.video.update({ where: { id: gen.videoId }, data: { scriptJson: JSON.stringify({ language: 'vi' }), duration: 99 } });
  for (let i = texts.length - 1; i >= 0; i--) {
    await prisma.scene.create({
      data: { videoId: gen.videoId, index: i, text: texts[i] ?? '', duration: 7, startTime: i * 7, endTime: i * 7 + 7 },
    });
  }
  return gen;
}

function mockServices(options: MockVoiceOptions = {}) {
  const provider = new MockVoiceProvider(options);
  return { provider, services: createTestVoiceServices(provider) };
}

async function voicedScenes(videoId: string) {
  return getPrisma().scene.findMany({ where: { videoId }, orderBy: { index: 'asc' }, include: { voiceAsset: true } });
}

async function narrationAssets(videoId: string) {
  return getPrisma().asset.findMany({ where: { videoId, type: NARRATION_ASSET_TYPE }, orderBy: { createdAt: 'asc' } });
}

const audioDirOf = (services: ReturnType<typeof mockServices>['services'], gen: { projectId: string; videoId: string }) =>
  path.join(services.storage.root, 'audio', gen.projectId, gen.videoId);

async function expectVoiceError(promise: Promise<unknown>, code: VoiceError['code']): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof VoiceError && error.code === code);
}

/** Tone bursts separated by pauses, for the detection path (mock `audio` returns no boundaries). */
function toneNarration(speechMs: readonly number[], pauseMs: number): Buffer {
  const rate = 24_000;
  const pieces: number[] = [];
  speechMs.forEach((ms, i) => {
    pieces.push(ms);
    if (i < speechMs.length - 1) {
      pieces.push(-pauseMs);
    }
  });
  const total = pieces.reduce((sum, ms) => sum + Math.round((Math.abs(ms) * rate) / 1000), 0);
  const samples = new Int16Array(total);
  let f = 0;
  for (const ms of pieces) {
    const n = Math.round((Math.abs(ms) * rate) / 1000);
    for (let i = 0; i < n; i++, f++) {
      samples[f] = ms > 0 ? Math.round(8000 * Math.sin((2 * Math.PI * 220 * f) / rate)) : 0;
    }
  }
  return encodeWav(new Uint8Array(samples.buffer));
}

describe('VOICE service (narration mode)', () => {
  test('three scenes: one TTS request, narration.wav + one READY audio asset per scene, contiguous timing', async () => {
    const gen = await seedVideo(TEXTS);
    const durations = [3.2, 4.1, 2.5];
    const { provider, services } = mockServices({ durationSec: (r) => durations[r.sceneIndex] ?? 1 });
    const result = await synthesizeVideoVoice(gen, services, quiet);

    assert.equal(provider.calls.length, 1);
    const call = provider.calls[0];
    assert.deepEqual(call?.paragraphs, TEXTS);
    assert.equal(call?.text, TEXTS.join('\n\n'));
    assert.equal(call?.style, 'Curious / mysterious');
    assert.equal(result.mode, 'narration');
    assert.equal(result.ttsCalls, 1);
    assert.deepEqual(
      result.scenes.map((s) => [s.durationSec, s.startTime, s.endTime, s.cached]),
      [
        [3.2, 0, 3.2, false],
        [4.1, 3.2, 7.3, false],
        [2.5, 7.3, 9.8, false],
      ],
    );
    assert.deepEqual(
      result.scenes.map((s) => s.boundary),
      [
        { quality: 'detected', silenceMs: 0 },
        { quality: 'detected', silenceMs: 0 },
        null,
      ],
    );

    const scenes = await voicedScenes(gen.videoId);
    for (const [i, scene] of scenes.entries()) {
      const asset = scene.voiceAsset;
      assert.ok(asset, `scene ${i} linked`);
      assert.equal(asset.type, AUDIO_ASSET_TYPE);
      assert.equal(asset.status, 'READY');
      assert.equal(asset.sceneId, null);
      assert.equal(asset.videoId, gen.videoId);
      assert.equal(asset.localPath, `audio/${gen.projectId}/${gen.videoId}/scene-0${i + 1}.wav`);
      const file = await services.storage.read(asset.localPath ?? '');
      assert.equal(parseWav(file).durationSec, durations[i]);
      assert.equal(asset.sizeBytes, file.length);
      const metadata = JSON.parse(asset.metadataJson ?? '{}') as Record<string, unknown>;
      for (const key of ['provider', 'model', 'voice', 'language', 'speed', 'style', 'cacheKey', 'sha256', 'sampleRate', 'channels', 'durationSec', 'narrationAssetId']) {
        assert.ok(key in metadata, `metadata.${key}`);
      }
      assert.deepEqual([scene.duration, scene.startTime, scene.endTime], [durations[i], result.scenes[i]?.startTime, result.scenes[i]?.endTime]);
    }
    const narrations = await narrationAssets(gen.videoId);
    assert.equal(narrations.length, 1);
    assert.equal(narrations[0]?.status, 'READY');
    assert.equal(narrations[0]?.localPath, `audio/${gen.projectId}/${gen.videoId}/narration.wav`);
    assert.equal(narrations[0]?.duration, 9.8);
    assert.equal((await getPrisma().video.findUniqueOrThrow({ where: { id: gen.videoId } })).duration, 9.8);
    assert.deepEqual(readdirSync(audioDirOf(services, gen)).sort(), ['narration.wav', 'scene-01.wav', 'scene-02.wav', 'scene-03.wav']);
    assert.equal(await getPrisma().asset.count({ where: { type: AUDIO_ASSET_TYPE } }), 3);
    VoiceJobResultSchema.parse(result);
  });

  test('re-run: no TTS call, every scene cached, same asset ids', async () => {
    const gen = await seedVideo(TEXTS);
    const { provider, services } = mockServices();
    const first = await synthesizeVideoVoice(gen, services, quiet);
    const second = await synthesizeVideoVoice(gen, services, quiet);
    assert.equal(provider.calls.length, 1);
    assert.equal(second.ttsCalls, 0);
    assert.ok(second.scenes.every((s) => s.cached));
    assert.deepEqual(
      second.scenes.map((s) => s.audioAssetId),
      first.scenes.map((s) => s.audioAssetId),
    );
    assert.deepEqual(second.scenes.map((s) => s.boundary), first.scenes.map((s) => s.boundary), 'boundaries remembered');
    assert.equal((await narrationAssets(gen.videoId)).length, 1);
    assert.equal(await getPrisma().asset.count({ where: { type: AUDIO_ASSET_TYPE } }), 3);
  });

  test('one changed scene text: the narration is synthesized again (1 call) and every scene is re-cut', async () => {
    const gen = await seedVideo(TEXTS);
    const { provider, services } = mockServices();
    const first = await synthesizeVideoVoice(gen, services, quiet);
    const prisma = getPrisma();
    const scene = await prisma.scene.findFirstOrThrow({ where: { videoId: gen.videoId, index: 1 } });
    await prisma.scene.update({ where: { id: scene.id }, data: { text: 'Một câu hoàn toàn khác về giấc ngủ của bạn.' } });

    const second = await synthesizeVideoVoice(gen, services, quiet);
    assert.equal(provider.calls.length, 2);
    assert.ok(second.scenes.every((s) => !s.cached));
    assert.ok(second.scenes.every((s, i) => s.audioAssetId !== first.scenes[i]?.audioAssetId));
    assert.equal((await narrationAssets(gen.videoId)).length, 1, 'the old narration row is cleaned up');
    assert.equal(await prisma.asset.count({ where: { videoId: gen.videoId, type: AUDIO_ASSET_TYPE } }), 3);
    assert.deepEqual(readdirSync(audioDirOf(services, gen)).sort(), ['narration.wav', 'scene-01.wav', 'scene-02.wav', 'scene-03.wav']);
  });

  test('a corrupted scene file is re-cut from the cached narration without a TTS call', async () => {
    const gen = await seedVideo(TEXTS);
    const { provider, services } = mockServices();
    const first = await synthesizeVideoVoice(gen, services, quiet);
    await services.storage.writeAtomic(first.scenes[1]?.localPath ?? '', Buffer.from('garbage'));

    const second = await synthesizeVideoVoice(gen, services, quiet);
    assert.equal(provider.calls.length, 1);
    assert.deepEqual(
      second.scenes.map((s) => s.cached),
      [true, false, true],
    );
    assert.notEqual(second.scenes[1]?.audioAssetId, first.scenes[1]?.audioAssetId);
    assert.equal(second.scenes[0]?.audioAssetId, first.scenes[0]?.audioAssetId);
    assert.equal(parseWav(await services.storage.read(second.scenes[1]?.localPath ?? '')).durationSec, first.scenes[1]?.durationSec);
  });

  test('a corrupted narration file is synthesized again and every scene is re-cut', async () => {
    const gen = await seedVideo(TEXTS);
    const { provider, services } = mockServices();
    const first = await synthesizeVideoVoice(gen, services, quiet);
    const narration = (await narrationAssets(gen.videoId))[0];
    await services.storage.writeAtomic(narration?.localPath ?? '', Buffer.from('garbage'));

    const second = await synthesizeVideoVoice(gen, services, quiet);
    assert.equal(provider.calls.length, 2, 'the narration is requested again');
    // The mock reproduces byte-identical audio, so the scene cuts (keyed by the narration sha256) are still valid.
    assert.ok(second.scenes.every((s) => s.cached));
    assert.deepEqual(second.scenes.map((s) => s.durationSec), first.scenes.map((s) => s.durationSec));
    const narrations = await narrationAssets(gen.videoId);
    assert.equal(narrations.length, 1);
    assert.notEqual(narrations[0]?.id, narration?.id, 'a fresh narration row replaces the corrupted one');
    assert.equal(parseWav(await services.storage.read(narrations[0]?.localPath ?? '')).durationSec, first.durationSec);
  });

  test('scene cuts of a different narration are never reused (keys include the narration sha256)', async () => {
    const gen = await seedVideo(TEXTS);
    const { provider, services } = mockServices();
    const first = await synthesizeVideoVoice(gen, services, quiet);
    const narration = (await narrationAssets(gen.videoId))[0];
    // Same key, different audio: as if the provider had returned a different take.
    const durations = [3.2, 4.1, 2.5];
    const other = mockServices({ durationSec: (r) => durations[r.sceneIndex] ?? 1 });
    other.services.storage = services.storage;
    await services.storage.writeAtomic(narration?.localPath ?? '', Buffer.from('garbage'));

    const second = await synthesizeVideoVoice(gen, other.services, quiet);
    assert.equal(other.provider.calls.length, 1);
    assert.ok(second.scenes.every((s) => !s.cached));
    assert.ok(second.scenes.every((s, i) => s.audioAssetId !== first.scenes[i]?.audioAssetId));
    assert.deepEqual(second.scenes.map((s) => s.durationSec), durations);
    void provider;
  });

  test('a provider failure leaves scenes and timing untouched and records a FAILED narration', async () => {
    const gen = await seedVideo(TEXTS);
    const { provider, services } = mockServices();
    const first = await synthesizeVideoVoice(gen, services, quiet);

    const failing = mockServices({ fail: () => new VoiceError('VOICE_RATE_LIMIT', 'quota') });
    // Same storage so the cached files are visible; a different text so the narration is not cached.
    failing.services.storage = services.storage;
    const prisma = getPrisma();
    const scene = await prisma.scene.findFirstOrThrow({ where: { videoId: gen.videoId, index: 0 } });
    await prisma.scene.update({ where: { id: scene.id }, data: { text: 'Câu mở đầu mới cho video này.' } });
    await expectVoiceError(synthesizeVideoVoice(gen, failing.services, quiet), 'VOICE_RATE_LIMIT');
    assert.equal(failing.provider.calls.length, 1);

    const scenes = await voicedScenes(gen.videoId);
    assert.deepEqual(
      scenes.map((s) => s.voiceAssetId),
      first.scenes.map((s) => s.audioAssetId),
      'links untouched',
    );
    assert.equal((await prisma.video.findUniqueOrThrow({ where: { id: gen.videoId } })).duration, first.durationSec, 'timing untouched');
    const narrations = await narrationAssets(gen.videoId);
    assert.deepEqual(narrations.map((n) => n.status), ['READY', 'FAILED']);
    assert.match(narrations[1]?.metadataJson ?? '', /quota/);
    void provider;
  });

  test('a split failure marks the narration FAILED so the next run synthesizes again', async () => {
    const gen = await seedVideo(TEXTS);
    // Far too short for its text: the per-scene plausibility check fails after the cut.
    const { provider, services } = mockServices({ audio: () => toneNarration([200, 200, 200], 300) });
    await expectVoiceError(synthesizeVideoVoice(gen, services, quiet), 'INVALID_AUDIO');
    assert.equal(provider.calls.length, 1);
    assert.deepEqual((await narrationAssets(gen.videoId)).map((n) => n.status), ['FAILED']);
    assert.ok((await voicedScenes(gen.videoId)).every((s) => s.voiceAssetId === null));

    await expectVoiceError(synthesizeVideoVoice(gen, services, quiet), 'INVALID_AUDIO');
    assert.equal(provider.calls.length, 2, 'not served from cache');
  });

  test('a narration the provider cut short (speech, then a minute of silence) fails before any scene is written', async () => {
    const gen = await seedVideo(TEXTS);
    // 2 s of speech, then 30 s of silence, then a click: far too little speech for three sentences (~11 s).
    const { provider, services } = mockServices({ audio: () => toneNarration([2000, 10], 30_000) });
    await assert.rejects(
      synthesizeVideoVoice(gen, services, quiet),
      (error: unknown) => error instanceof VoiceError && error.code === 'INVALID_AUDIO' && /cut the narration short/.test(error.message),
    );
    assert.equal(provider.calls.length, 1);
    assert.deepEqual((await narrationAssets(gen.videoId)).map((n) => n.status), ['FAILED']);
    assert.ok((await voicedScenes(gen.videoId)).every((s) => s.voiceAssetId === null));
    assert.ok(!existsSync(audioDirOf(services, gen)), 'nothing written, not even the narration file');
  });

  test('detection path: audio without boundaries is cut at the pauses', async () => {
    const gen = await seedVideo(TEXTS);
    // ≈ 11, 11 and 12 syllables: 3.3 s, 3.3 s and 3.6 s of tone with 400 ms pauses.
    const { provider, services } = mockServices({ audio: () => toneNarration([3300, 3300, 3600], 400) });
    const result = await synthesizeVideoVoice(gen, services, quiet);
    assert.equal(provider.calls.length, 1);
    assert.deepEqual(
      result.scenes.map((s) => s.boundary),
      [
        { quality: 'detected', silenceMs: 400 },
        { quality: 'detected', silenceMs: 400 },
        null,
      ],
    );
    // Each scene keeps its pause minus the 80 ms lead-in of the next one; the pauses are
    // shorter than 500 ms so nothing is dropped: 3300+320, 80+3300+320, 80+3600.
    assert.deepEqual(
      result.scenes.map((s) => Math.round(s.durationSec * 1000)),
      [3620, 3700, 3680],
    );
    assert.equal(result.durationSec, 11);
    const scenes = await voicedScenes(gen.videoId);
    assert.equal(scenes.at(-1)?.endTime, 11);
  });

  test('switching to scene mode and back cleans up the narration file and rows', async () => {
    const gen = await seedVideo(TEXTS);
    const { provider, services } = mockServices();
    await synthesizeVideoVoice(gen, services, quiet);
    assert.equal((await narrationAssets(gen.videoId)).length, 1);

    const sceneMode = { ...services, mode: 'scene' as const };
    await synthesizeVideoVoice(gen, sceneMode, quiet);
    assert.equal(provider.calls.length, 1 + 3);
    assert.equal((await narrationAssets(gen.videoId)).length, 0);
    assert.deepEqual(readdirSync(audioDirOf(services, gen)).sort(), ['scene-01.wav', 'scene-02.wav', 'scene-03.wav']);

    await synthesizeVideoVoice(gen, services, quiet);
    assert.equal(provider.calls.length, 1 + 3 + 1, 'scene-mode files do not satisfy narration-mode keys');
    assert.equal((await narrationAssets(gen.videoId)).length, 1);
    assert.equal(await getPrisma().asset.count({ where: { videoId: gen.videoId, type: AUDIO_ASSET_TYPE } }), 3);
  });

  test('text validation happens before the request', async () => {
    const gen = await seedVideo(['Hello world, this is clearly English text with no accents at all.', 'And so is this one, right here.']);
    const { provider, services } = mockServices();
    await expectVoiceError(synthesizeVideoVoice(gen, services, quiet), 'TEXT_NOT_VIETNAMESE');
    assert.equal(provider.calls.length, 0);
  });
});

describe('VOICE narration mode in the pipeline', () => {
  function context(voiceOptions: MockVoiceOptions = {}): JobContext & { voiceProvider: MockVoiceProvider } {
    const assets = createTestAssetServices();
    const voiceProvider = new MockVoiceProvider(voiceOptions);
    return {
      ai: new AIClient(new MockAIProvider()),
      assets,
      voice: createTestVoiceServices(voiceProvider, assets.storage),
      render: createTestRenderServices(assets.storage),
      voiceProvider,
    };
  }

  test('the pipeline reaches RENDER with one TTS call; narration.wav sits next to the scene files', async () => {
    const ctx = context();
    const gen = await createProjectWithGeneration('Tại sao con người lại mơ?', 'Tại sao con người lại mơ?');
    while (await processNextJob(quiet, ctx)) {
      // run until idle
    }
    const prisma = getPrisma();
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: gen.projectId } })).status, 'COMPLETED');
    const voiceJob = await prisma.job.findFirstOrThrow({ where: { type: JobType.VOICE } });
    assert.equal(voiceJob.status, JobStatus.COMPLETED);
    const result = VoiceJobResultSchema.parse(JSON.parse(voiceJob.resultJson ?? ''));
    assert.equal(result.mode, 'narration');
    assert.equal(result.ttsCalls, 1);
    assert.equal(result.scenes.length, 7);
    assert.equal(ctx.voiceProvider.calls.length, 1);
    assert.equal((await prisma.job.findFirstOrThrow({ where: { type: JobType.RENDER } })).status, JobStatus.COMPLETED);
    const dir = path.join(ctx.voice.storage.root, 'audio', gen.projectId, gen.videoId);
    assert.equal(readdirSync(dir).length, 8, '7 scenes + narration.wav');
  });
});
