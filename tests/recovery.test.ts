/**
 * Job liveness and recovery: heartbeats, recovery of jobs abandoned by a dead
 * worker, graceful shutdown (job requeued, external processes killed), the
 * abort API, the one-active-job-per-video guard and the atomic RENDER
 * completion. Unit tests against the test database, plus real worker
 * processes (kill -9 mid-job, IPC shutdown).
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, beforeEach, describe, test } from 'node:test';
import { AIClient } from '../lib/ai/client.js';
import { MockAIProvider, type MockResponse } from '../lib/ai/providers/mock.js';
import { enableWal, getPrisma } from '../lib/db/prisma.js';
import { activeProcessCount, killActiveProcesses, runProcess } from '../lib/ffmpeg/process.js';
import { JobStatus, JobType } from '../lib/generated/prisma/client.js';
import { claimNextJob } from '../lib/jobs/claim-job.js';
import { completeJob } from '../lib/jobs/complete-job.js';
import { ActiveJobConflictError, createJob } from '../lib/jobs/create-job.js';
import { failJob } from '../lib/jobs/fail-job.js';
import { beatJob, startHeartbeat } from '../lib/jobs/heartbeat.js';
import { processNextJob, videoUpdateFor } from '../lib/jobs/process-job.js';
import { recoverAbandonedJobs } from '../lib/jobs/recover-jobs.js';
import { jobPayloadSchema, type JobContext } from '../lib/jobs/types.js';
import { abortJob } from '../server/services/jobs.js';
import { startGeneration } from '../server/services/projects.js';
import { rerunStage } from '../server/services/videos.js';
import {
  TEST_DATABASE_URL,
  createProjectWithGeneration,
  createTestAssetServices,
  createTestRenderServices,
  createTestVoiceServices,
  makeTempDir,
  migrateTestDb,
  removeTestDb,
  request,
  resetDb,
  startTestServer,
  type TestServer,
} from './helpers.js';

const quiet = (): void => {};
const TOPIC = 'Tại sao con người lại mơ?';

function context(extra: Partial<JobContext> = {}, ai: Record<string, MockResponse> = {}): JobContext {
  const assets = createTestAssetServices();
  return {
    ai: new AIClient(new MockAIProvider(ai)),
    assets,
    voice: createTestVoiceServices(undefined, assets.storage),
    render: createTestRenderServices(assets.storage),
    ...extra,
  };
}

async function waitFor(condition: () => Promise<boolean>, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      assert.fail(`Timed out waiting for ${label}`);
    }
    await sleep(50);
  }
}

/** Runs the pipeline in-process until nothing is pending (or the given stage is next). */
async function runUntil(ctx: JobContext, stop?: JobType): Promise<void> {
  for (;;) {
    const pending = await getPrisma().job.findFirst({ where: { status: JobStatus.PENDING } });
    if (!pending || pending.type === stop) {
      return;
    }
    await processNextJob(quiet, ctx);
  }
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const payloadOf = (job: { payloadJson: string | null }) => jobPayloadSchema.parse(JSON.parse(job.payloadJson ?? ''));

before(async () => {
  migrateTestDb();
  await enableWal();
});
after(removeTestDb);
beforeEach(resetDb);

describe('heartbeat', () => {
  test('claiming records the worker and a heartbeat; only that worker can refresh it, and only while RUNNING', async () => {
    await createProjectWithGeneration('Heartbeat', TOPIC);
    const job = await claimNextJob('worker-A');
    assert.ok(job);
    assert.equal(job.workerId, 'worker-A');
    assert.ok(job.heartbeatAt);

    await sleep(5);
    assert.equal(await beatJob(job.id, 'worker-A'), true);
    const refreshed = await getPrisma().job.findUniqueOrThrow({ where: { id: job.id } });
    assert.ok((refreshed.heartbeatAt?.getTime() ?? 0) > job.heartbeatAt.getTime(), 'the heartbeat moved forward');
    assert.equal(await beatJob(job.id, 'worker-B'), false, 'another worker cannot beat our job');

    await abortJob(job.id);
    assert.equal(await beatJob(job.id, 'worker-A'), false, 'a cancelled job is no longer ours');
  });

  test('startHeartbeat keeps beating and calls onLost exactly once when the job is cancelled', async () => {
    await createProjectWithGeneration('Heartbeat timer', TOPIC);
    const job = await claimNextJob('worker-A');
    assert.ok(job);
    let lost = 0;
    const handle = startHeartbeat(job.id, 'worker-A', { intervalMs: 20, onLost: () => lost++, log: quiet });
    try {
      await sleep(120);
      assert.equal(lost, 0, 'a live job is never reported lost');
      const beforeAbort = (await getPrisma().job.findUniqueOrThrow({ where: { id: job.id } })).heartbeatAt;
      assert.ok(beforeAbort && beforeAbort.getTime() > (job.heartbeatAt?.getTime() ?? 0), 'the timer refreshed the heartbeat');

      await abortJob(job.id);
      await waitFor(async () => lost > 0, 'onLost', 5_000);
      await sleep(120);
      assert.equal(lost, 1);
    } finally {
      handle.stop();
    }
  });
});

describe('recovery of abandoned jobs', () => {
  test('a RUNNING job whose heartbeat went stale goes back to PENDING and is processed again', async () => {
    const gen = await createProjectWithGeneration('Crash', TOPIC);
    const job = await claimNextJob('dead-worker');
    assert.ok(job);
    const prisma = getPrisma();
    await prisma.job.update({ where: { id: job.id }, data: { heartbeatAt: minutesAgo(10) } });

    const logs: string[] = [];
    const recovered = await recoverAbandonedJobs({ staleMs: 60_000, log: (message) => logs.push(message) });
    assert.deepEqual(
      recovered.map((r) => [r.id, r.outcome, r.attempts, r.workerId]),
      [[job.id, 'requeued', 1, 'dead-worker']],
    );
    const requeued = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    assert.deepEqual([requeued.status, requeued.workerId, requeued.heartbeatAt], [JobStatus.PENDING, null, null]);
    assert.match(requeued.error ?? '', /Requeued after dead-worker stopped responding \(attempt 1 of 3\)/);
    assert.match(logs[0] ?? '', /Recovered job .* back to PENDING/);
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: gen.projectId } })).status, 'PROCESSING', 'the pipeline stays active');
    assert.deepEqual(await recoverAbandonedJobs({ staleMs: 60_000 }), [], 'nothing left to recover');

    assert.equal(await processNextJob(quiet, context({ workerId: 'worker-2' })), true);
    const done = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    assert.deepEqual([done.status, done.attempts, done.error, done.workerId], [JobStatus.COMPLETED, 2, null, 'worker-2']);
    assert.equal(await prisma.job.count({ where: { type: JobType.SCRIPT, status: JobStatus.PENDING } }), 1, 'the pipeline continued');
  });

  test('a live heartbeat is left alone; a job claimed before heartbeats existed is judged by startedAt', async () => {
    await createProjectWithGeneration('Alive', TOPIC);
    const job = await claimNextJob('busy-worker');
    assert.ok(job);
    assert.deepEqual(await recoverAbandonedJobs({ staleMs: 60_000 }), []);

    await getPrisma().job.update({ where: { id: job.id }, data: { heartbeatAt: null, workerId: null, startedAt: minutesAgo(10) } });
    assert.equal((await recoverAbandonedJobs({ staleMs: 60_000 })).length, 1);
    assert.match((await getPrisma().job.findUniqueOrThrow({ where: { id: job.id } })).error ?? '', /an unknown worker/);
  });

  test('after the maximum attempts the job, video and project fail, and the project can be generated again', async () => {
    const gen = await createProjectWithGeneration('Cursed', TOPIC);
    const job = await claimNextJob('dead-worker');
    assert.ok(job);
    const prisma = getPrisma();
    await prisma.job.update({ where: { id: job.id }, data: { heartbeatAt: minutesAgo(10), attempts: 3 } });

    const recovered = await recoverAbandonedJobs({ staleMs: 60_000, maxAttempts: 3 });
    assert.deepEqual(
      recovered.map((r) => r.outcome),
      ['failed'],
    );
    const failed = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(failed.status, JobStatus.FAILED);
    assert.match(failed.error ?? '', /dead-worker stopped responding; giving up after 3 attempts/);
    assert.ok(failed.completedAt);
    assert.equal((await prisma.video.findUniqueOrThrow({ where: { id: gen.videoId } })).status, 'FAILED');
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: gen.projectId } })).status, 'FAILED');
    assert.equal((await startGeneration(gen.projectId)).status, 'QUEUED', 'no longer stuck');
  });
});

describe('graceful shutdown', () => {
  test('while shutting down, a job that fails is requeued with its attempt undone instead of failed', async () => {
    const gen = await createProjectWithGeneration('Stopping', TOPIC);
    const ctx = context(
      { workerId: 'stopping-worker', isShuttingDown: () => true },
      {
        research: () => {
          throw new Error('ffmpeg killed');
        },
      },
    );
    assert.equal(await processNextJob(quiet, ctx), true);

    const prisma = getPrisma();
    const job = await prisma.job.findUniqueOrThrow({ where: { id: gen.jobId } });
    assert.deepEqual([job.status, job.attempts, job.workerId, job.heartbeatAt], [JobStatus.PENDING, 0, null, null]);
    assert.match(job.error ?? '', /Requeued: worker stopped while running RESEARCH \(ffmpeg killed\)/);
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: gen.projectId } })).status, 'PROCESSING', 'not failed');
    assert.equal(await prisma.job.count(), 1, 'no next job');

    assert.equal(await processNextJob(quiet, context({ workerId: 'next-worker' })), true);
    const done = await prisma.job.findUniqueOrThrow({ where: { id: gen.jobId } });
    assert.deepEqual([done.status, done.attempts, done.error], [JobStatus.COMPLETED, 1, null]);
  });

  test('killActiveProcesses stops a running child, which runProcess reports as killed', async () => {
    const running = runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 20_000 });
    await waitFor(async () => activeProcessCount() === 1, 'the child to start', 5_000);
    assert.equal(killActiveProcesses(), 1);
    const result = await running;
    assert.deepEqual([result.exitCode, result.timedOut], [null, false]);
    assert.equal(activeProcessCount(), 0);
    assert.equal(killActiveProcesses(), 0, 'nothing left to kill');
  });
});

describe('abort API', () => {
  let server: TestServer;
  before(async () => {
    server = await startTestServer();
  });
  after(async () => {
    await server.close();
  });
  const abort = (id: string) =>
    request<{ status?: string; error?: { code: string } } & Record<string, unknown>>(server.baseUrl, 'POST', `/api/jobs/${id}/abort`);

  test('a PENDING job is cancelled, its pipeline fails, and the project can be generated again', async () => {
    const gen = await createProjectWithGeneration('Abort me', TOPIC);
    const res = await abort(gen.jobId);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'CANCELLED');
    assert.deepEqual(Object.keys(res.body).sort(), ['attempts', 'completedAt', 'createdAt', 'error', 'id', 'startedAt', 'status', 'type']);

    const prisma = getPrisma();
    assert.equal((await prisma.video.findUniqueOrThrow({ where: { id: gen.videoId } })).status, 'FAILED');
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: gen.projectId } })).status, 'FAILED');
    assert.equal(await claimNextJob('w'), null, 'a cancelled job is never claimed');

    const again = await abort(gen.jobId);
    assert.deepEqual([again.status, again.body.error?.code], [409, 'JOB_NOT_ACTIVE']);
    assert.equal((await abort('nope')).status, 404);
    assert.equal((await startGeneration(gen.projectId)).status, 'QUEUED');
  });

  test("a RUNNING job: the worker's later completion and failure are discarded", async () => {
    const gen = await createProjectWithGeneration('Abort running', TOPIC);
    const job = await claimNextJob('busy');
    assert.ok(job);
    assert.equal((await abortJob(job.id)).status, 'CANCELLED');

    await assert.rejects(completeJob(job, payloadOf(job), { done: true }), /no longer RUNNING/);
    assert.equal(await failJob(job, 'too late'), false);
    const prisma = getPrisma();
    const later = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    assert.deepEqual([later.status, later.resultJson, later.error], [JobStatus.CANCELLED, null, 'Cancelled through the API']);
    assert.equal(await prisma.job.count(), 1, 'no next job was created');
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: gen.projectId } })).status, 'FAILED');
  });
});

describe('one active job per video', () => {
  test('createJob refuses a second active job; the API answers 409 JOB_ALREADY_ACTIVE and rolls back', async () => {
    const gen = await createProjectWithGeneration('Twice', TOPIC);
    const prisma = getPrisma();
    const payload = { projectId: gen.projectId, videoId: gen.videoId, topic: TOPIC, title: 'Twice' };
    await assert.rejects(
      createJob(prisma, JobType.RENDER, payload),
      (error: unknown) => error instanceof ActiveJobConflictError && error.activeJobId === gen.jobId && error.activeType === JobType.RESEARCH,
    );
    assert.equal(await prisma.job.count(), 1);

    // A finished pipeline plus a stray PENDING job and a project status reset by hand:
    // the job engine still refuses to queue a second job for the video.
    await runUntil(context());
    await prisma.job.create({
      data: { projectId: gen.projectId, videoId: gen.videoId, type: JobType.RENDER, status: JobStatus.PENDING, payloadJson: JSON.stringify(payload) },
    });
    await prisma.project.update({ where: { id: gen.projectId }, data: { status: 'FAILED' } });
    const server = await startTestServer();
    try {
      const res = await request<{ error?: { code: string } }>(server.baseUrl, 'POST', `/api/videos/${gen.videoId}/rerun`, { stage: 'RENDER' });
      assert.deepEqual([res.status, res.body.error?.code], [409, 'JOB_ALREADY_ACTIVE']);
    } finally {
      await server.close();
    }
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: gen.projectId } })).status, 'FAILED', 'the transaction rolled back');
    assert.equal(await prisma.job.count({ where: { status: JobStatus.PENDING } }), 1);
  });
});

describe('RENDER completion', () => {
  test('videoUpdateFor: only an ffmpeg render carries an output path', () => {
    const base = {
      version: 1,
      videoId: 'v',
      durationMs: 1000,
      frames: 30,
      width: 1080,
      height: 1920,
      fps: 30,
      videoCodec: 'h264',
      pixelFormat: 'yuv420p',
      audioCodec: 'aac',
      audioBitrate: '192k',
      ffmpegVersion: null,
      subtitleVersion: 1,
      subtitleInputHash: 'a'.repeat(64),
      subtitleSegments: 1,
      renderedAt: new Date().toISOString(),
    };
    const ffmpeg = { ...base, provider: 'ffmpeg', outputPath: 'renders/p/v/video.mp4', probedDurationMs: 1000, fileSize: 10 };
    const mock = { ...base, provider: 'mock', outputPath: null, probedDurationMs: null, fileSize: null };
    assert.deepEqual(videoUpdateFor({ type: JobType.RENDER }, ffmpeg), { outputPath: 'renders/p/v/video.mp4' });
    assert.equal(videoUpdateFor({ type: JobType.RENDER }, mock), undefined);
    assert.equal(videoUpdateFor({ type: JobType.VOICE }, ffmpeg), undefined);
    assert.equal(videoUpdateFor({ type: JobType.RENDER }, { garbage: true }), undefined);
  });

  test('completeJob writes Video.outputPath together with the last job; a cancelled job writes neither', async () => {
    const gen = await createProjectWithGeneration('Atomic', TOPIC);
    const prisma = getPrisma();
    await runUntil(context(), JobType.RENDER);
    const first = await claimNextJob('w');
    assert.ok(first && first.type === JobType.RENDER);
    await abortJob(first.id);
    await assert.rejects(completeJob(first, payloadOf(first), { provider: 'ffmpeg' }, { outputPath: 'renders/x/y/video.mp4' }), /no longer RUNNING/);
    assert.equal((await prisma.video.findUniqueOrThrow({ where: { id: gen.videoId } })).outputPath, null, 'nothing was written');

    const rerun = await rerunStage(gen.videoId, 'RENDER');
    const second = await claimNextJob('w');
    assert.ok(second && second.id === rerun.jobId);
    assert.equal(await completeJob(second, payloadOf(second), { provider: 'ffmpeg' }, { outputPath: 'renders/p/v/video.mp4' }), null);
    const video = await prisma.video.findUniqueOrThrow({ where: { id: gen.videoId } });
    assert.deepEqual([video.status, video.outputPath], ['COMPLETED', 'renders/p/v/video.mp4']);
    assert.equal((await prisma.job.findUniqueOrThrow({ where: { id: second.id } })).status, JobStatus.COMPLETED);
    assert.equal((await prisma.project.findUniqueOrThrow({ where: { id: gen.projectId } })).status, 'COMPLETED');
  });
});

describe('worker processes', () => {
  interface Worker {
    child: ChildProcess;
    output: string[];
    exited: Promise<number | null>;
  }

  const dataDir = makeTempDir('sf-recovery-data-');
  const workerEnv = {
    ...process.env,
    DATABASE_URL: TEST_DATABASE_URL,
    DATA_DIR: dataDir,
    WORKER_POLL_INTERVAL_MS: '20',
    AI_PROVIDER: 'mock',
    VOICE_PROVIDER: 'silent',
    RENDER_PROVIDER: 'mock',
    // Six pauses between the seven scenes keep VOICE running for a few seconds: the window for the kill.
    VOICE_REQUEST_DELAY_MS: '1500',
    JOB_HEARTBEAT_MS: '1000',
    JOB_STALE_MS: '2000',
    JOB_RECOVERY_INTERVAL_MS: '300',
    WORKER_STOP_TIMEOUT_MS: '20000',
  };
  const workers: Worker[] = [];

  function startWorker(): Worker {
    const child = spawn(process.execPath, ['--import', 'tsx', 'workers/worker.ts'], {
      env: workerEnv,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const output: string[] = [];
    child.stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    const worker = { child, output, exited };
    workers.push(worker);
    return worker;
  }
  const logOf = (worker: Worker) => worker.output.join('');
  const started = (worker: Worker) => waitFor(async () => logOf(worker).includes('Waiting for jobs...'), 'the worker to start');
  const voiceRunning = async () => (await getPrisma().job.count({ where: { type: JobType.VOICE, status: JobStatus.RUNNING } })) === 1;
  const projectStatus = async (id: string) => (await getPrisma().project.findUniqueOrThrow({ where: { id } })).status;

  after(async () => {
    for (const worker of workers) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) {
        worker.child.kill('SIGKILL');
        await worker.exited;
      }
    }
  });

  test('a worker killed mid-job: the next worker recovers the job and finishes the pipeline', { timeout: 90_000 }, async () => {
    const first = startWorker();
    await started(first);
    const gen = await createProjectWithGeneration('Killed', TOPIC);
    await waitFor(voiceRunning, 'VOICE to be running');
    first.child.kill('SIGKILL');
    await first.exited;

    const prisma = getPrisma();
    const stuck = await prisma.job.findFirstOrThrow({ where: { type: JobType.VOICE } });
    assert.equal(stuck.status, JobStatus.RUNNING, 'nobody has recovered the job yet');
    assert.ok(stuck.workerId?.includes(String(first.child.pid)), 'the job names the dead worker');

    const second = startWorker();
    await waitFor(async () => (await projectStatus(gen.projectId)) === 'COMPLETED', 'the pipeline to finish', 60_000);
    const voice = await prisma.job.findUniqueOrThrow({ where: { id: stuck.id } });
    assert.deepEqual([voice.status, voice.attempts, voice.error], [JobStatus.COMPLETED, 2, null]);
    assert.match(logOf(second), /Recovered job .* back to PENDING \(attempt 1 of 3\)/);
    assert.equal(await prisma.job.count({ where: { status: { in: [JobStatus.RUNNING, JobStatus.PENDING] } } }), 0);
    assert.doesNotMatch(logOf(second), /Worker error|Failed job/);

    assert.equal(second.child.send('shutdown'), true);
    assert.equal(await second.exited, 0);
  });

  test('the IPC shutdown message: nothing stays RUNNING, the exit is clean, and the next worker resumes', { timeout: 90_000 }, async () => {
    const worker = startWorker();
    await started(worker);
    const gen = await createProjectWithGeneration('Stopped', TOPIC);
    await waitFor(voiceRunning, 'VOICE to be running');
    assert.equal(worker.child.send('shutdown'), true);
    assert.equal(await worker.exited, 0, 'a clean exit');
    assert.match(logOf(worker), /Received shutdown message: stopping/);
    assert.match(logOf(worker), /Worker stopped/);

    const prisma = getPrisma();
    assert.equal(await prisma.job.count({ where: { status: JobStatus.RUNNING } }), 0, 'no job is left RUNNING');
    const voice = await prisma.job.findFirstOrThrow({ where: { type: JobType.VOICE } });
    assert.ok(voice.status === JobStatus.COMPLETED || voice.status === JobStatus.PENDING, `VOICE is ${voice.status}`);
    assert.notEqual(await projectStatus(gen.projectId), 'COMPLETED', 'the rest of the pipeline waits for the next worker');

    const next = startWorker();
    await waitFor(async () => (await projectStatus(gen.projectId)) === 'COMPLETED', 'the pipeline to finish', 60_000);
    assert.equal(next.child.send('shutdown'), true);
    assert.equal(await next.exited, 0);
  });
});
