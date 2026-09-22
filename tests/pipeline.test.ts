import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { AIClient } from '../lib/ai/client.js';
import { AIError } from '../lib/ai/errors.js';
import { MOCK_FIXTURES, MockAIProvider, type MockResponse } from '../lib/ai/providers/mock.js';
import { MAX_SCENE_SECONDS, MIN_SCENE_SECONDS } from '../lib/ai/schemas/scenes.js';
import { ScriptSchema } from '../lib/ai/schemas/script.js';
import { getPrisma } from '../lib/db/prisma.js';
import { JobStatus, JobType } from '../lib/generated/prisma/client.js';
import { claimNextJob } from '../lib/jobs/claim-job.js';
import { processJob, processNextJob } from '../lib/jobs/process-job.js';
import { PIPELINE, type JobContext } from '../lib/jobs/types.js';
import { saveChannelDna, DEFAULT_CHANNEL_DNA } from '../lib/settings/channel-dna.js';
import { createProject, startGeneration } from '../server/services/projects.js';
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

function mockContext(overrides: Record<string, MockResponse> = {}): { ctx: JobContext; provider: MockAIProvider } {
  const provider = new MockAIProvider(overrides);
  const assets = createTestAssetServices();
  const ctx: JobContext = {
    ai: new AIClient(provider),
    assets,
    voice: createTestVoiceServices(undefined, assets.storage),
    render: createTestRenderServices(assets.storage),
  };
  return { ctx, provider };
}

async function runUntilIdle(ctx: JobContext = mockContext().ctx): Promise<number> {
  let processed = 0;
  while (await processNextJob(quiet, ctx)) {
    processed++;
  }
  return processed;
}

/** Processes exactly one job with the given context. */
async function runOne(ctx: JobContext): Promise<void> {
  assert.equal(await processNextJob(quiet, ctx), true, 'a job was processed');
}

async function jobsByType() {
  const jobs = await getPrisma().job.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  return jobs.map((j) => `${j.type}:${j.status}`);
}

async function expectPipelineFailed(projectId: string, videoId: string) {
  const prisma = getPrisma();
  assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: projectId } })).status, 'FAILED');
  assert.equal((await prisma.video.findUniqueOrThrow({ where: { id: videoId } })).status, 'FAILED');
}

before(migrateTestDb);
after(removeTestDb);
beforeEach(resetDb);

describe('Job engine', () => {
  test('claiming moves the job to RUNNING and the pipeline to PROCESSING', async () => {
    const gen = await createProjectWithGeneration('Why Do We Dream?', TOPIC);

    const job = await claimNextJob();
    assert.ok(job);
    assert.equal(job.id, gen.jobId);
    assert.equal(job.status, JobStatus.RUNNING);
    assert.equal(job.attempts, 1);
    assert.ok(job.startedAt);

    const prisma = getPrisma();
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: gen.projectId } })).status, 'PROCESSING');
    assert.equal((await prisma.video.findUniqueOrThrow({ where: { id: gen.videoId } })).status, 'PROCESSING');
    assert.equal(await claimNextJob(), null, 'a RUNNING job cannot be claimed again');
  });

  test('in-process concurrent claims hand out each job once', async () => {
    for (let i = 0; i < 3; i++) {
      await createProjectWithGeneration(`P${i}`, `topic ${i}`);
    }
    const claims = await Promise.all(Array.from({ length: 6 }, () => claimNextJob()));
    const ids = claims.filter((j) => j !== null).map((j) => j.id);
    assert.equal(ids.length, 3);
    assert.equal(new Set(ids).size, 3);
  });

  test('the full pipeline (mock AI) reaches COMPLETED', async () => {
    const gen = await createProjectWithGeneration('Why Do We Dream?', TOPIC);
    assert.equal(await runUntilIdle(), PIPELINE.length);

    const prisma = getPrisma();
    const jobs = await prisma.job.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    assert.deepEqual(
      jobs.map((j) => j.type),
      [...PIPELINE],
    );
    for (const job of jobs) {
      assert.equal(job.status, JobStatus.COMPLETED);
      assert.equal(job.attempts, 1);
      assert.equal(job.error, null);
    }
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: gen.projectId } })).status, 'COMPLETED');
    const video = await prisma.video.findUniqueOrThrow({ where: { id: gen.videoId } });
    assert.equal(video.status, 'COMPLETED');
    assert.equal(await prisma.scene.count({ where: { videoId: gen.videoId } }), 7);
  });

  test('a new generation after completion creates video version 2', async () => {
    const gen = await createProjectWithGeneration('Why Do We Dream?', TOPIC);
    await runUntilIdle();
    const second = await startGeneration(gen.projectId);
    const videos = await getPrisma().video.findMany({ orderBy: { version: 'asc' } });
    assert.deepEqual(
      videos.map((v) => [v.version, v.status]),
      [
        [1, 'COMPLETED'],
        [2, 'QUEUED'],
      ],
    );
    assert.equal(videos[1]?.id, second.videoId);
  });

  test('an invalid payload fails the job, video and project and stops the pipeline', async () => {
    const prisma = getPrisma();
    const project = await createProject({ title: 'Broken', topic: 'broken payload' });
    const video = await prisma.video.create({ data: { projectId: project.id, version: 1, status: 'QUEUED' } });
    await prisma.project.update({ where: { id: project.id }, data: { status: 'QUEUED' } });
    await prisma.job.create({
      data: {
        projectId: project.id,
        videoId: video.id,
        type: JobType.RESEARCH,
        payloadJson: JSON.stringify({ projectId: project.id, videoId: video.id }),
      },
    });

    const job = await claimNextJob();
    assert.ok(job);
    await processJob(job, quiet, mockContext().ctx);

    const failed = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(failed.status, JobStatus.FAILED);
    assert.match(failed.error ?? '', /Invalid job payload/);
    assert.ok(failed.completedAt);
    await expectPipelineFailed(project.id, video.id);
    assert.equal(await prisma.job.count(), 1, 'no next job is created');
    assert.equal((await startGeneration(project.id)).status, 'QUEUED', 'a failed project can be generated again');
  });

  test('a job whose project was deleted mid-run does not crash the worker', async () => {
    const gen = await createProjectWithGeneration('Gone', 'deleted topic');
    const job = await claimNextJob();
    assert.ok(job);
    await getPrisma().project.delete({ where: { id: gen.projectId } });
    await processJob(job, quiet, mockContext().ctx);
    assert.equal(await getPrisma().job.count(), 0);
  });
});

describe('RESEARCH stage', () => {
  test('stores validated research and creates the SCRIPT job', async () => {
    const gen = await createProjectWithGeneration('Why Do We Dream?', TOPIC);
    const { ctx, provider } = mockContext();
    await runOne(ctx);

    const research = await getPrisma().job.findUniqueOrThrow({ where: { id: gen.jobId } });
    assert.equal(research.status, JobStatus.COMPLETED);
    const result = JSON.parse(research.resultJson ?? '') as { topic: string; facts: unknown[]; sources: unknown[] };
    assert.equal(result.topic, TOPIC);
    assert.ok(result.facts.length >= 3);
    assert.deepEqual(await jobsByType(), ['RESEARCH:COMPLETED', 'SCRIPT:PENDING']);

    // Only the topic is sent to the model.
    const [call] = provider.calls;
    assert.equal(call?.schemaName, 'research');
    assert.equal(call?.userPrompt, `Topic: ${TOPIC}`);
    assert.equal(call?.jsonSchema['additionalProperties'], false);
  });

  test('an AI error fails the pipeline and does not create SCRIPT', async () => {
    const gen = await createProjectWithGeneration('Why Do We Dream?', TOPIC);
    const { ctx } = mockContext({
      research: () => {
        throw new AIError('AI_RATE_LIMIT', 'OpenAI rate limit or quota exceeded (HTTP 429)');
      },
    });
    await runOne(ctx);

    const job = await getPrisma().job.findUniqueOrThrow({ where: { id: gen.jobId } });
    assert.equal(job.status, JobStatus.FAILED);
    assert.equal(job.error, 'OpenAI rate limit or quota exceeded (HTTP 429)');
    assert.deepEqual(await jobsByType(), ['RESEARCH:FAILED']);
    await expectPipelineFailed(gen.projectId, gen.videoId);
  });

  test('malformed AI output fails validation and does not create SCRIPT', async () => {
    const gen = await createProjectWithGeneration('Why Do We Dream?', TOPIC);
    const { ctx } = mockContext({ research: { topic: TOPIC, summary: 'x', facts: [], sources: [] } });
    await runOne(ctx);

    const job = await getPrisma().job.findUniqueOrThrow({ where: { id: gen.jobId } });
    assert.equal(job.status, JobStatus.FAILED);
    assert.match(job.error ?? '', /research output failed validation: facts/);
    assert.deepEqual(await jobsByType(), ['RESEARCH:FAILED']);
    await expectPipelineFailed(gen.projectId, gen.videoId);
  });
});

describe('SCRIPT stage', () => {
  test('saves the script to Video.scriptJson and creates the SCENES job', async () => {
    const source = { title: 'Sleep and dreaming', url: 'https://en.wikipedia.org/wiki/Dream' };
    const researchWithSource: MockResponse = (request) => ({
      ...(MOCK_FIXTURES['research']?.(request) as object),
      sources: [source],
    });
    await saveChannelDna({ ...DEFAULT_CHANNEL_DNA, tone: 'Playful', averageDuration: '45-50' });

    const gen = await createProjectWithGeneration('Why Do We Dream?', TOPIC);
    const { ctx, provider } = mockContext({ research: researchWithSource });
    await runOne(ctx);
    await runOne(ctx);

    const video = await getPrisma().video.findUniqueOrThrow({ where: { id: gen.videoId } });
    const script = ScriptSchema.parse(JSON.parse(video.scriptJson ?? ''));
    assert.equal(video.title, script.title);
    assert.deepEqual(script.scenes, []);
    assert.deepEqual(script.sources, [source], 'sources are copied from research');
    assert.equal(script.language, 'vi');

    const scriptJob = await getPrisma().job.findFirstOrThrow({ where: { type: JobType.SCRIPT } });
    assert.deepEqual(JSON.parse(scriptJob.resultJson ?? ''), script, 'the script is also the job result');
    assert.deepEqual(await jobsByType(), ['RESEARCH:COMPLETED', 'SCRIPT:COMPLETED', 'SCENES:PENDING']);

    // Research facts and Channel DNA reach the prompt.
    const scriptCall = provider.calls.find((c) => c.schemaName === 'script');
    assert.ok(scriptCall);
    assert.match(scriptCall.userPrompt, /Tone: Playful/);
    assert.match(scriptCall.userPrompt, /Target duration: 45-50 seconds/);
    assert.match(scriptCall.userPrompt, /REM/);
    assert.doesNotMatch(scriptCall.userPrompt, /wikipedia/, 'source URLs are not sent to the script model');
  });

  test('invalid script output fails the pipeline and does not create SCENES', async () => {
    const gen = await createProjectWithGeneration('Why Do We Dream?', TOPIC);
    const { ctx } = mockContext({
      script: (request) => ({ ...(MOCK_FIXTURES['script']?.(request) as object), targetDuration: 120 }),
    });
    await runOne(ctx);
    await runOne(ctx);

    const job = await getPrisma().job.findFirstOrThrow({ where: { type: JobType.SCRIPT } });
    assert.equal(job.status, JobStatus.FAILED);
    assert.match(job.error ?? '', /targetDuration/);
    assert.deepEqual(await jobsByType(), ['RESEARCH:COMPLETED', 'SCRIPT:FAILED']);
    assert.equal((await getPrisma().video.findUniqueOrThrow({ where: { id: gen.videoId } })).scriptJson, null);
    await expectPipelineFailed(gen.projectId, gen.videoId);
  });
});

describe('SCENES stage', () => {
  test('creates normalized Scene records and the ASSETS job', async () => {
    const gen = await createProjectWithGeneration('Why Do We Dream?', TOPIC);
    const { ctx } = mockContext();
    await runOne(ctx);
    await runOne(ctx);
    await runOne(ctx);

    const prisma = getPrisma();
    const video = await prisma.video.findUniqueOrThrow({
      where: { id: gen.videoId },
      include: { scenes: { orderBy: { index: 'asc' } } },
    });
    const script = ScriptSchema.parse(JSON.parse(video.scriptJson ?? ''));

    assert.ok(video.scenes.length >= 5 && video.scenes.length <= 10);
    let expectedStart = 0;
    video.scenes.forEach((scene, i) => {
      assert.equal(scene.index, i);
      assert.ok(scene.duration !== null && scene.duration >= MIN_SCENE_SECONDS && scene.duration <= MAX_SCENE_SECONDS);
      assert.equal(scene.startTime, expectedStart, 'no gaps or overlaps');
      assert.ok(scene.endTime !== null && scene.endTime > scene.startTime);
      assert.ok(['video', 'image'].includes(scene.visualType ?? ''));
      assert.ok((JSON.parse(scene.subtitleEmphasisJson ?? '[]') as string[]).length > 0);
      expectedStart = scene.endTime;
    });
    // The mock proposes 36 s for a 45 s target; normalization brings it within 10%.
    assert.ok(Math.abs(expectedStart - script.targetDuration) <= script.targetDuration * 0.1, `total ${expectedStart}`);
    assert.equal(video.duration, expectedStart);

    const scenesJob = await prisma.job.findFirstOrThrow({ where: { type: JobType.SCENES } });
    const result = JSON.parse(scenesJob.resultJson ?? '') as { scenes: unknown[] };
    assert.equal(result.scenes.length, video.scenes.length);
    assert.deepEqual(await jobsByType(), [
      'RESEARCH:COMPLETED',
      'SCRIPT:COMPLETED',
      'SCENES:COMPLETED',
      'ASSETS:PENDING',
    ]);
  });

  test('invalid scenes output fails the pipeline and does not create ASSETS', async () => {
    const gen = await createProjectWithGeneration('Why Do We Dream?', TOPIC);
    const { ctx } = mockContext({
      scenes: (request) => {
        const fixture = MOCK_FIXTURES['scenes']?.(request) as { scenes: Record<string, unknown>[] };
        return { scenes: fixture.scenes.slice(0, 3) }; // fewer than 5 scenes
      },
    });
    await runOne(ctx);
    await runOne(ctx);
    await runOne(ctx);

    const job = await getPrisma().job.findFirstOrThrow({ where: { type: JobType.SCENES } });
    assert.equal(job.status, JobStatus.FAILED);
    assert.match(job.error ?? '', /scenes output failed validation/);
    assert.deepEqual(await jobsByType(), ['RESEARCH:COMPLETED', 'SCRIPT:COMPLETED', 'SCENES:FAILED']);
    assert.equal(await getPrisma().scene.count(), 0);
    await expectPipelineFailed(gen.projectId, gen.videoId);
  });
});
