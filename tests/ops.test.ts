/**
 * Operations: the API token, the rate limit, the rendered-video route,
 * deleting a project together with its files, and the health report.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { AIClient } from '../lib/ai/client.js';
import { MockAIProvider } from '../lib/ai/providers/mock.js';
import { getPrisma } from '../lib/db/prisma.js';
import { claimNextJob } from '../lib/jobs/claim-job.js';
import { processNextJob } from '../lib/jobs/process-job.js';
import type { JobContext } from '../lib/jobs/types.js';
import { recordWorkerPresence } from '../lib/jobs/worker-presence.js';
import { getHealth, type HealthReport } from '../server/services/health.js';
import {
  createProjectWithGeneration,
  createTestAssetServices,
  createTestRenderServices,
  createTestVoiceServices,
  migrateTestDb,
  removeTestDb,
  request,
  resetDb,
  startTestServer,
  type TestServer,
} from './helpers.js';

const quiet = (): void => {};
const TOPIC = 'Tại sao con người lại mơ?';
const TOKEN = 'test-token-0123456789abcdef';
const FAKE_MP4 = 'fake mp4 bytes 0123456789';

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

/** A completed pipeline (mock render) whose video also has a rendered file, as the job engine would record it. */
async function renderedProject(ctx: JobContext, title = 'Rendered') {
  const gen = await createProjectWithGeneration(title, TOPIC);
  await runAll(ctx);
  const outputPath = `renders/${gen.projectId}/${gen.videoId}/video.mp4`;
  await ctx.assets.storage.writeAtomic(outputPath, Buffer.from(FAKE_MP4));
  await getPrisma().video.update({ where: { id: gen.videoId }, data: { outputPath } });
  return { ...gen, outputPath };
}

const jsonPost = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

before(migrateTestDb);
after(removeTestDb);
beforeEach(resetDb);

describe('API token', () => {
  let server: TestServer;
  before(async () => {
    server = await startTestServer({ apiToken: TOKEN });
  });
  after(async () => {
    await server.close();
  });
  const get = (route: string, headers: Record<string, string> = {}) => fetch(`${server.baseUrl}${route}`, { headers });

  test('without the token everything but /api/health is 401; Bearer, X-API-Key and the output ?token work', async () => {
    const anonymous = await get('/api/projects');
    assert.equal(anonymous.status, 401);
    assert.equal(((await anonymous.json()) as { error: { code: string } }).error.code, 'UNAUTHORIZED');
    assert.equal(anonymous.headers.get('www-authenticate'), 'Bearer');
    assert.equal((await get('/api/health')).status, 200, 'uptime monitors need no token');

    assert.equal((await get('/api/projects', { authorization: `Bearer ${TOKEN}` })).status, 200);
    assert.equal((await get('/api/projects', { 'x-api-key': TOKEN })).status, 200);
    assert.equal((await get('/api/projects', { authorization: 'Bearer wrong-token-0123456789' })).status, 401);
    assert.equal((await get('/api/projects', { authorization: `Bearer ${TOKEN}x` })).status, 401);

    assert.equal((await jsonPost(`${server.baseUrl}/api/projects`, { title: 'x', topic: 'y' })).status, 401);
    assert.equal(await getPrisma().project.count(), 0, 'nothing was created without the token');

    // A <video> element cannot send headers, so only the output route accepts the token as a query parameter.
    assert.equal((await get(`/api/videos/nope/output?token=${TOKEN}`)).status, 404, 'authenticated, then not found');
    assert.equal((await get(`/api/projects?token=${TOKEN}`)).status, 401);
  });
});

describe('rate limit', () => {
  let server: TestServer;
  before(async () => {
    server = await startTestServer({ rateLimitPerMinute: 2 });
  });
  after(async () => {
    await server.close();
  });

  test('mutating requests beyond the limit get 429 with Retry-After; reads are never limited', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await request(server.baseUrl, 'POST', '/api/projects', { title: `P${i}`, topic: 'topic' })).status);
    }
    assert.deepEqual(statuses, [201, 201, 429]);
    const limited = await jsonPost(`${server.baseUrl}/api/projects`, { title: 'P3', topic: 'topic' });
    assert.equal(limited.status, 429);
    assert.match(limited.headers.get('retry-after') ?? '', /^\d+$/);
    assert.equal(((await limited.json()) as { error: { code: string } }).error.code, 'RATE_LIMITED');
    for (let i = 0; i < 5; i++) {
      assert.equal((await request(server.baseUrl, 'GET', '/api/projects')).status, 200);
    }
    assert.equal(await getPrisma().project.count(), 2);
  });
});

describe('GET /api/videos/:id/output', () => {
  let server: TestServer;
  let ctx: JobContext;
  before(async () => {
    ctx = context();
    server = await startTestServer({ storage: ctx.assets.storage });
  });
  after(async () => {
    await server.close();
  });

  test('streams the rendered MP4 with Range support and an id-based file name', async () => {
    const p = await renderedProject(ctx);
    const url = `${server.baseUrl}/api/videos/${p.videoId}/output`;
    const res = await fetch(url);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'video/mp4');
    assert.equal(res.headers.get('content-disposition'), `inline; filename="${p.projectId}-v1.mp4"`);
    assert.equal(res.headers.get('accept-ranges'), 'bytes');
    assert.equal(await res.text(), FAKE_MP4);

    const partial = await fetch(url, { headers: { range: 'bytes=0-3' } });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get('content-range'), `bytes 0-3/${FAKE_MP4.length}`);
    assert.equal(await partial.text(), 'fake');

    const download = await fetch(`${url}?download=1`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get('content-disposition'), `attachment; filename="${p.projectId}-v1.mp4"`);
  });

  test('404 for an unknown video, a video without a render, and a missing file', async () => {
    const unknown = await request<{ error?: { code: string } }>(server.baseUrl, 'GET', '/api/videos/nope/output');
    assert.deepEqual([unknown.status, unknown.body.error?.code], [404, 'VIDEO_NOT_FOUND']);

    const gen = await createProjectWithGeneration('No render', TOPIC);
    await runAll(ctx); // the mock render writes no file
    const notReady = await request<{ error?: { code: string } }>(server.baseUrl, 'GET', `/api/videos/${gen.videoId}/output`);
    assert.deepEqual([notReady.status, notReady.body.error?.code], [404, 'OUTPUT_NOT_READY']);

    const p = await renderedProject(ctx);
    await ctx.assets.storage.remove(p.outputPath);
    const missing = await request<{ error?: { code: string } }>(server.baseUrl, 'GET', `/api/videos/${p.videoId}/output`);
    assert.deepEqual([missing.status, missing.body.error?.code], [404, 'OUTPUT_MISSING']);
  });
});

describe('DELETE /api/projects/:id', () => {
  test('removes the records and the files of that project only; an active project is refused', async () => {
    const ctx = context();
    const storage = ctx.assets.storage;
    const server = await startTestServer({ storage });
    try {
      const a = await renderedProject(ctx, 'A');
      const b = await renderedProject(ctx, 'B');
      const leftover = storage.resolve(`tmp/render/${a.projectId}/${a.videoId}/old-job`);
      await mkdir(leftover, { recursive: true });
      await writeFile(path.join(leftover, 'video.tmp.mp4'), 'half');
      const dirsOf = (projectId: string) => ['assets', 'audio', 'renders'].map((kind) => storage.resolve(`${kind}/${projectId}`));
      assert.ok(dirsOf(a.projectId).every(existsSync) && existsSync(leftover), 'project A has files of every kind');

      const res = await request<Record<string, unknown>>(server.baseUrl, 'DELETE', `/api/projects/${a.projectId}`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body, { deleted: true, id: a.projectId, filesRemoved: true });
      assert.ok(dirsOf(a.projectId).every((dir) => !existsSync(dir)), 'assets, audio and renders of A are gone');
      assert.equal(existsSync(storage.resolve(`tmp/render/${a.projectId}`)), false, 'its working directories too');
      assert.ok(dirsOf(b.projectId).every(existsSync), 'project B keeps its files');
      const prisma = getPrisma();
      assert.equal(await prisma.project.count(), 1);
      assert.equal(await prisma.asset.count({ where: { videoId: a.videoId } }), 0);

      const c = await createProjectWithGeneration('Active', TOPIC);
      const refused = await request<{ error?: { code: string } }>(server.baseUrl, 'DELETE', `/api/projects/${c.projectId}`);
      assert.deepEqual([refused.status, refused.body.error?.code], [409, 'PROJECT_ACTIVE']);
      assert.equal(await prisma.project.count(), 2);
      assert.equal((await request(server.baseUrl, 'DELETE', '/api/projects/nope')).status, 404);
      assert.equal((await request(server.baseUrl, 'DELETE', '/api/projects/not%20an%20id')).status, 404);
    } finally {
      await server.close();
    }
  });
});

describe('health', () => {
  test('reports queue, workers and disk; degraded without a live worker, with a stale job or a full disk', async () => {
    const storage = createTestAssetServices().storage;
    const fresh = await getHealth(storage, { minFreeBytes: 0 });
    assert.equal(fresh.status, 'degraded', 'no worker has ever checked in');
    assert.equal(fresh.checks.worker, 'none');
    assert.equal(fresh.checks.jobs, 'ok');
    assert.deepEqual(fresh.queue, { pending: 0, running: 0, oldestRunningSec: null, staleRunning: 0 });
    assert.equal(fresh.disk.dataDir, storage.root);

    await recordWorkerPresence('w1', { host: 'box', pid: 42 });
    await createProjectWithGeneration('Queue', TOPIC);
    let report: HealthReport = await getHealth(storage, { minFreeBytes: 0 });
    assert.equal(report.status, 'ok');
    assert.equal(report.queue.pending, 1);
    assert.deepEqual(
      report.workers.map((w) => [w.id, w.host, w.pid, w.lastSeenSec < 5]),
      [['w1', 'box', 42, true]],
    );

    const job = await claimNextJob('w1');
    assert.ok(job);
    report = await getHealth(storage, { minFreeBytes: 0 });
    assert.deepEqual([report.queue.pending, report.queue.running], [0, 1]);
    assert.ok(report.queue.oldestRunningSec !== null && report.queue.oldestRunningSec >= 0);

    await getPrisma().job.update({ where: { id: job.id }, data: { heartbeatAt: new Date(Date.now() - 10 * 60_000) } });
    report = await getHealth(storage, { minFreeBytes: 0 });
    assert.deepEqual([report.queue.staleRunning, report.checks.jobs, report.status], [1, 'stale', 'degraded']);

    const later = await getHealth(storage, { minFreeBytes: 0, now: new Date(Date.now() + 10 * 60_000) });
    assert.equal(later.checks.worker, 'none', 'a worker that stopped checking in no longer counts');

    if (report.disk.freeBytes !== null) {
      const low = await getHealth(storage, { minFreeBytes: Number.MAX_SAFE_INTEGER });
      assert.deepEqual([low.checks.disk, low.status], ['low', 'degraded']);
    }

    const server = await startTestServer({ storage, minFreeBytes: 0 });
    try {
      const res = await request<HealthReport>(server.baseUrl, 'GET', '/api/health');
      assert.equal(res.status, 200);
      assert.ok(['ok', 'degraded'].includes(res.body.status));
      assert.equal(res.body.queue.running, 1);
    } finally {
      await server.close();
    }
  });
});
