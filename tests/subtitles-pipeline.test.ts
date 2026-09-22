/**
 * SUBTITLES against a real (test) database: input validation (scenes, VOICE
 * timings, text, language), read-only behaviour, and the pipeline stage.
 */
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { after, before, beforeEach, describe, test } from 'node:test';
import { AIClient } from '../lib/ai/client.js';
import { MockAIProvider } from '../lib/ai/providers/mock.js';
import { getPrisma } from '../lib/db/prisma.js';
import { JobStatus, JobType } from '../lib/generated/prisma/client.js';
import { processNextJob } from '../lib/jobs/process-job.js';
import type { JobContext } from '../lib/jobs/types.js';
import { SubtitleError } from '../lib/subtitles/errors.js';
import { buildVideoSubtitles } from '../lib/subtitles/service.js';
import { SubtitleResultSchema } from '../lib/subtitles/types.js';
import { VoiceError } from '../lib/voice/errors.js';
import { MockVoiceProvider, type MockVoiceOptions } from '../lib/voice/providers/mock.js';
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

before(migrateTestDb);
after(removeTestDb);
beforeEach(resetDb);

interface SeedScene {
  text: string;
  /** Seconds, like VOICE writes them. */
  duration: number;
  emphasis?: string[];
  index?: number;
}

interface SeedOptions {
  /** Script language (null → no script, Channel DNA fallback). */
  language?: string | null;
  /** Overrides Video.duration (default: end of the last scene). */
  videoDuration?: number | null;
  /** false → scenes keep estimated timings without narration audio (VOICE not run). */
  voiced?: boolean;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** A video whose scenes look like VOICE's output (inserted in reverse order to prove ORDER BY index). */
async function seedVideo(scenes: SeedScene[], options: SeedOptions = {}) {
  const gen = await createProjectWithGeneration('Mùa thu', 'Vì sao lá cây chuyển màu vào mùa thu?');
  const prisma = getPrisma();
  let cursor = 0;
  const timed = scenes.map((scene, i) => {
    const startTime = cursor;
    cursor = round3(cursor + scene.duration);
    return { ...scene, index: scene.index ?? i, startTime, endTime: cursor };
  });
  const language = options.language === undefined ? 'vi' : options.language;
  await prisma.video.update({
    where: { id: gen.videoId },
    data: {
      scriptJson: language === null ? null : JSON.stringify({ language }),
      duration: options.videoDuration === undefined ? cursor : options.videoDuration,
    },
  });
  for (const scene of [...timed].reverse()) {
    const audio =
      options.voiced === false
        ? null
        : await prisma.asset.create({
            data: {
              type: 'audio',
              provider: 'silent',
              status: 'READY',
              videoId: gen.videoId,
              localPath: `audio/${gen.projectId}/${gen.videoId}/scene-${scene.index + 1}.wav`,
              mimeType: 'audio/wav',
              duration: scene.duration,
            },
          });
    await prisma.scene.create({
      data: {
        videoId: gen.videoId,
        index: scene.index,
        text: scene.text,
        duration: scene.duration,
        startTime: scene.startTime,
        endTime: scene.endTime,
        subtitleEmphasisJson: scene.emphasis ? JSON.stringify(scene.emphasis) : null,
        voiceAssetId: audio?.id ?? null,
      },
    });
  }
  return gen;
}

function rejectsWith(code: string, pattern?: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof SubtitleError, `expected SubtitleError, got ${String(error)}`);
    assert.equal(error.code, code);
    if (pattern) {
      assert.match(error.message, pattern);
    }
    return true;
  };
}

const LEAVES: SeedScene[] = [
  { text: 'Bạn có bao giờ tự hỏi tại sao lá cây lại đổi màu rực rỡ trước khi rụng xuống?', duration: 5.7, emphasis: ['đổi màu rực rỡ', 'rụng xuống'] },
  { text: 'Khi mùa thu đến, ngày ngắn lại và cây ngừng quá trình quang hợp khiến chất diệp lục màu xanh biến mất.', duration: 6.6, emphasis: ['quá trình quang hợp', 'chất diệp lục'] },
  { text: 'Lúc này, các sắc tố vàng và cam vốn bị lấn át suốt mùa hè mới chính thức lộ diện.', duration: 6, emphasis: ['sắc tố vàng và cam', 'lộ diện'] },
  { text: 'Kỳ lạ hơn, màu đỏ và tím rực rỡ lại được tạo ra hoàn toàn mới từ lượng đường còn kẹt lại trong lá dưới ánh nắng.', duration: 8.1, emphasis: ['màu đỏ và tím', 'lượng đường'] },
  { text: 'Tất cả những thay đổi này thực chất là một chiến lược sinh tồn thông minh, khi cây chủ động cắt đứt nguồn nuôi để giữ ẩm và vượt qua mùa đông lạnh giá.', duration: 10.2, emphasis: ['chiến lược sinh tồn', 'mùa đông lạnh giá'] },
  { text: 'Hãy bấm đăng ký kênh để khám phá thêm nhiều điều kỳ diệu của tự nhiên nhé!', duration: 5.1, emphasis: ['đăng ký kênh', 'điều kỳ diệu'] },
];

describe('buildVideoSubtitles', () => {
  test('one scene', async () => {
    const gen = await seedVideo([{ text: 'Bạn có bao giờ tự hỏi tại sao mình lại mơ không?', duration: 4.25 }]);
    const result = await buildVideoSubtitles({ videoId: gen.videoId });
    SubtitleResultSchema.parse(result);
    assert.equal(result.videoId, gen.videoId);
    assert.equal(result.language, 'vi');
    assert.equal(result.durationMs, 4250);
    assert.equal(result.segments[0]?.startMs, 0);
    assert.equal(result.segments.at(-1)?.endMs, 4250);
  });

  test('many scenes, inserted out of order: output follows Scene.index and the real timings', async () => {
    const gen = await seedVideo(LEAVES);
    const result = await buildVideoSubtitles({ videoId: gen.videoId });
    const scenes = await getPrisma().scene.findMany({ where: { videoId: gen.videoId }, orderBy: { index: 'asc' } });
    assert.equal(result.durationMs, 41700);
    const sceneOrder = result.segments.map((s) => s.sceneIndex);
    assert.deepEqual(sceneOrder, [...sceneOrder].sort((a, b) => a - b));
    for (const scene of scenes) {
      const own = result.segments.filter((s) => s.sceneIndex === scene.index);
      assert.ok(own.every((s) => s.sceneId === scene.id));
      assert.equal(own[0]?.startMs, Math.round((scene.startTime ?? 0) * 1000));
      assert.equal(own.at(-1)?.endMs, Math.round((scene.endTime ?? 0) * 1000));
      assert.equal(own.map((s) => s.text).join(' '), scene.text);
    }
    assert.deepEqual(result.warnings, []);
  });

  test('never writes to the database (scenes and video are unchanged)', async () => {
    const gen = await seedVideo(LEAVES);
    const prisma = getPrisma();
    const snapshot = async () =>
      JSON.stringify([
        await prisma.scene.findMany({ where: { videoId: gen.videoId }, orderBy: { index: 'asc' } }),
        await prisma.video.findUniqueOrThrow({ where: { id: gen.videoId } }),
        await prisma.asset.count(),
      ]);
    const before = await snapshot();
    await buildVideoSubtitles({ videoId: gen.videoId });
    assert.equal(await snapshot(), before);
  });

  test('scene problems: none, index gap', async () => {
    const empty = await seedVideo([]);
    await assert.rejects(buildVideoSubtitles({ videoId: empty.videoId }), rejectsWith('SUBTITLE_INVALID_SCENE', /no scenes/));
    await resetDb();
    const gap = await seedVideo([LEAVES[0] as SeedScene, { ...(LEAVES[1] as SeedScene), index: 2 }]);
    await assert.rejects(buildVideoSubtitles({ videoId: gap.videoId }), rejectsWith('SUBTITLE_INVALID_SCENE', /contiguous/));
  });

  test('VOICE has not run: estimated timings without audio are rejected', async () => {
    // Like the dev video "cá mập": 7 scenes with SCENES estimates only.
    const scenes = Array.from({ length: 7 }, (_, i) => ({ text: `Cảnh số ${i + 1} kể về loài cá mập cổ đại.`, duration: 6.5 }));
    const gen = await seedVideo(scenes, { voiced: false });
    await assert.rejects(buildVideoSubtitles({ videoId: gen.videoId }), rejectsWith('SUBTITLE_INVALID_TIMING', /VOICE must complete first/));
  });

  test('narration audio that is not READY is rejected', async () => {
    const gen = await seedVideo(LEAVES.slice(0, 2));
    const scene = await getPrisma().scene.findFirstOrThrow({ where: { videoId: gen.videoId, index: 1 } });
    await getPrisma().asset.update({ where: { id: scene.voiceAssetId ?? '' }, data: { status: 'FAILED' } });
    await assert.rejects(buildVideoSubtitles({ videoId: gen.videoId }), rejectsWith('SUBTITLE_INVALID_TIMING', /not ready/));
  });

  test('broken timings are rejected', async () => {
    const prisma = getPrisma();
    const cases: [string, (videoId: string) => Promise<unknown>, RegExp][] = [
      ['null start', (videoId) => prisma.scene.updateMany({ where: { videoId, index: 1 }, data: { startTime: null } }), /no valid timing/],
      ['NaN-like duration', (videoId) => prisma.scene.updateMany({ where: { videoId, index: 0 }, data: { duration: null } }), /no valid timing/],
      ['end before start', (videoId) => prisma.scene.updateMany({ where: { videoId, index: 0 }, data: { endTime: 0 } }), /ends before it starts/],
      ['gap', (videoId) => prisma.scene.updateMany({ where: { videoId, index: 1 }, data: { startTime: 5.8, duration: 6.5 } }), /does not start where/],
      ['not from 0', (videoId) => prisma.scene.updateMany({ where: { videoId, index: 0 }, data: { startTime: 0.2, duration: 5.5 } }), /must start at 0/],
      ['duration mismatch', (videoId) => prisma.scene.updateMany({ where: { videoId, index: 0 }, data: { duration: 5 } }), /duration does not match/],
      ['video duration', (videoId) => prisma.video.update({ where: { id: videoId }, data: { duration: 12.5 } }), /Video duration/],
    ];
    for (const [name, corrupt, pattern] of cases) {
      await resetDb();
      const gen = await seedVideo(LEAVES.slice(0, 2));
      await corrupt(gen.videoId);
      await assert.rejects(buildVideoSubtitles({ videoId: gen.videoId }), rejectsWith('SUBTITLE_INVALID_TIMING', pattern), name);
    }
  });

  test('Video.duration within the 1 ms tolerance is accepted', async () => {
    const gen = await seedVideo(LEAVES.slice(0, 2), { videoDuration: 12.3004 });
    assert.equal((await buildVideoSubtitles({ videoId: gen.videoId })).durationMs, 12300);
  });

  test('text problems: empty, control characters, unaccented Vietnamese', async () => {
    const empty = await seedVideo([{ text: '   ', duration: 2 }]);
    await assert.rejects(buildVideoSubtitles({ videoId: empty.videoId }), rejectsWith('SUBTITLE_EMPTY_TEXT'));
    await resetDb();
    const control = await seedVideo([{ text: `Mèo ngủ${String.fromCharCode(7)} say.`, duration: 2 }]);
    await assert.rejects(buildVideoSubtitles({ videoId: control.videoId }), rejectsWith('SUBTITLE_INVALID_TEXT'));
    await resetDb();
    // Like the dev video "bạch tuộc": Vietnamese without diacritics.
    const unaccented = await seedVideo([
      { text: 'Ban co biet vi sao bach tuoc lai co toi ba trai tim?', duration: 4 },
      { text: 'Loai dong vat nay su dung mot trai tim chinh de nuoi co the.', duration: 5 },
    ]);
    await assert.rejects(buildVideoSubtitles({ videoId: unaccented.videoId }), rejectsWith('SUBTITLE_TEXT_NOT_VIETNAMESE'));
  });

  test('NFD text is normalized to NFC; whitespace is collapsed like VOICE', async () => {
    const nfc = 'Bạch tuộc có ba trái tim và máu màu xanh.';
    const stored = `  ${nfc.replace(' có ', '   có\n')}  `.normalize('NFD');
    assert.notEqual(stored.trim(), nfc);
    const gen = await seedVideo([{ text: stored, duration: 3.5 }]);
    const result = await buildVideoSubtitles({ videoId: gen.videoId });
    assert.equal(result.segments.map((s) => s.text).join(' '), nfc);
  });

  test('language: script first, then Channel DNA; only vi and en', async () => {
    const english = await seedVideo([{ text: 'Octopuses have three hearts and blue blood.', duration: 3 }], { language: 'en' });
    assert.equal((await buildVideoSubtitles({ videoId: english.videoId })).language, 'en');
    await resetDb();
    const regional = await seedVideo(LEAVES.slice(0, 1), { language: 'vi-VN' });
    assert.equal((await buildVideoSubtitles({ videoId: regional.videoId })).language, 'vi');
    await resetDb();
    const french = await seedVideo(LEAVES.slice(0, 1), { language: 'fr' });
    await assert.rejects(buildVideoSubtitles({ videoId: french.videoId }), rejectsWith('SUBTITLE_UNSUPPORTED_LANGUAGE', /"fr"/));
    await resetDb();
    const fallback = await seedVideo(LEAVES.slice(0, 1), { language: null });
    assert.equal((await buildVideoSubtitles({ videoId: fallback.videoId })).language, 'vi', 'Channel DNA default');
    await getPrisma().setting.create({ data: { key: 'channelDna.language', value: 'ja' } });
    await assert.rejects(buildVideoSubtitles({ videoId: fallback.videoId }), rejectsWith('SUBTITLE_UNSUPPORTED_LANGUAGE'));
  });

  test('same database state → identical result', async () => {
    const gen = await seedVideo(LEAVES);
    const first = await buildVideoSubtitles({ videoId: gen.videoId });
    const second = await buildVideoSubtitles({ videoId: gen.videoId });
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });
});

describe('SUBTITLES stage in the pipeline', () => {
  function context(voiceOptions: MockVoiceOptions = {}): JobContext {
    const assets = createTestAssetServices();
    return {
      ai: new AIClient(new MockAIProvider()),
      assets,
      voice: createTestVoiceServices(new MockVoiceProvider(voiceOptions), assets.storage),
      render: createTestRenderServices(assets.storage),
    };
  }

  async function runUntil(ctx: JobContext, stop?: JobType) {
    const prisma = getPrisma();
    for (;;) {
      const pending = await prisma.job.findFirst({ where: { status: JobStatus.PENDING } });
      if (!pending || pending.type === stop) {
        return;
      }
      await processNextJob(quiet, ctx);
    }
  }

  test('VOICE → SUBTITLES stores a valid SubtitleResult and the pipeline completes', async () => {
    const ctx = context();
    const gen = await createProjectWithGeneration('Tại sao con người lại mơ?', 'Tại sao con người lại mơ?');
    await runUntil(ctx);
    const prisma = getPrisma();

    const job = await prisma.job.findFirstOrThrow({ where: { type: JobType.SUBTITLES } });
    assert.equal(job.status, JobStatus.COMPLETED);
    const result = SubtitleResultSchema.parse(JSON.parse(job.resultJson ?? ''));
    const video = await prisma.video.findUniqueOrThrow({ where: { id: gen.videoId } });
    assert.equal(result.videoId, gen.videoId);
    assert.equal(result.durationMs, Math.round((video.duration ?? 0) * 1000), 'subtitles follow the real audio duration');
    const scenes = await prisma.scene.findMany({ where: { videoId: gen.videoId }, orderBy: { index: 'asc' } });
    assert.deepEqual([...new Set(result.segments.map((s) => s.sceneId))], scenes.map((s) => s.id));
    assert.equal((await prisma.job.findFirstOrThrow({ where: { type: JobType.RENDER } })).status, JobStatus.COMPLETED);
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: gen.projectId } })).status, 'COMPLETED');
    assert.deepEqual(readdirSync(ctx.assets.storage.root).sort(), ['assets', 'audio'], 'SUBTITLES writes no files');
  });

  test('VOICE FAILED → no SUBTITLES job', async () => {
    const ctx = context({ fail: () => new VoiceError('VOICE_RATE_LIMIT', 'Gemini TTS rate limit or quota exceeded (HTTP 429)') });
    const gen = await createProjectWithGeneration('Tại sao con người lại mơ?', 'Tại sao con người lại mơ?');
    await runUntil(ctx);
    const prisma = getPrisma();
    assert.equal((await prisma.job.findFirstOrThrow({ where: { type: JobType.VOICE } })).status, JobStatus.FAILED);
    assert.equal(await prisma.job.count({ where: { type: JobType.SUBTITLES } }), 0);
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: gen.projectId } })).status, 'FAILED');
  });

  test('a SUBTITLES failure fails the job, video and project (no RENDER, no retry)', async () => {
    const ctx = context();
    const gen = await createProjectWithGeneration('Tại sao con người lại mơ?', 'Tại sao con người lại mơ?');
    await runUntil(ctx, JobType.SUBTITLES);
    const prisma = getPrisma();
    await prisma.scene.updateMany({ where: { videoId: gen.videoId, index: 0 }, data: { voiceAssetId: null } });
    await runUntil(ctx);

    const job = await prisma.job.findFirstOrThrow({ where: { type: JobType.SUBTITLES } });
    assert.equal(job.status, JobStatus.FAILED);
    assert.match(job.error ?? '', /VOICE must complete first/);
    assert.equal(await prisma.job.count({ where: { type: JobType.SUBTITLES } }), 1);
    assert.equal(await prisma.job.count({ where: { type: JobType.RENDER } }), 0);
    assert.equal((await prisma.video.findUniqueOrThrow({ where: { id: gen.videoId } })).status, 'FAILED');
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: gen.projectId } })).status, 'FAILED');
  });
});
