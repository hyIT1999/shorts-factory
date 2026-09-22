import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { getPrisma } from '../lib/db/prisma.js';
import {
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

interface ProjectBody {
  id: string;
  title: string;
  topic: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

interface ProjectDetailBody extends ProjectBody {
  videos: { id: string; version: number; status: string; scenes: unknown[] }[];
  jobs: { id: string; type: string; status: string; attempts: number }[];
}

interface GenerateBody {
  projectId: string;
  videoId: string;
  jobId: string;
  status: string;
}

interface ErrorBody {
  error: { code: string; message: string };
}

let server: TestServer;

before(async () => {
  migrateTestDb();
  server = await startTestServer();
});

after(async () => {
  await server.close();
  await removeTestDb();
});

beforeEach(resetDb);

async function createProject(title = 'Why Do We Dream?', topic = 'Why do humans dream?') {
  const res = await request<ProjectBody>(server.baseUrl, 'POST', '/api/projects', { title, topic });
  assert.equal(res.status, 201);
  return res.body;
}

describe('Project API', () => {
  test('POST /api/projects creates a DRAFT project with trimmed fields', async () => {
    const project = await createProject('  Why Do We Dream?  ', ' Why do humans dream? ');
    assert.equal(project.title, 'Why Do We Dream?');
    assert.equal(project.topic, 'Why do humans dream?');
    assert.equal(project.status, 'DRAFT');
    assert.deepEqual(Object.keys(project).sort(), ['createdAt', 'id', 'status', 'title', 'topic', 'updatedAt']);
    assert.equal(await getPrisma().project.count(), 1);
  });

  test('POST /api/projects rejects empty, missing, too long and malformed input with 400', async () => {
    const cases: unknown[] = [
      { title: '   ', topic: 'x' },
      { title: 'x' },
      { title: 'x', topic: 'y'.repeat(501) },
      { title: 42, topic: 'x' },
    ];
    for (const body of cases) {
      const res = await request<ErrorBody>(server.baseUrl, 'POST', '/api/projects', body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    }
    const bad = await request<ErrorBody>(server.baseUrl, 'POST', '/api/projects', undefined, '{"title":');
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'INVALID_JSON');
    assert.equal(await getPrisma().project.count(), 0);
  });

  test('GET /api/projects lists projects newest first', async () => {
    const first = await createProject('First', 'topic 1');
    await new Promise((r) => setTimeout(r, 5));
    const second = await createProject('Second', 'topic 2');
    const res = await request<ProjectBody[]>(server.baseUrl, 'GET', '/api/projects');
    assert.equal(res.status, 200);
    assert.deepEqual(
      res.body.map((p) => p.id),
      [second.id, first.id],
    );
  });

  test('GET /api/projects/:id returns detail and 404 for unknown ids', async () => {
    const project = await createProject();
    const res = await request<ProjectDetailBody>(server.baseUrl, 'GET', `/api/projects/${project.id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.title, project.title);
    assert.deepEqual(res.body.videos, []);
    assert.deepEqual(res.body.jobs, []);

    const missing = await request<ErrorBody>(server.baseUrl, 'GET', '/api/projects/does-not-exist');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'PROJECT_NOT_FOUND');
  });

  test('DELETE /api/projects/:id refuses an active project, then deletes it and its related records', async () => {
    const project = await createProject();
    const gen = await request<GenerateBody>(server.baseUrl, 'POST', `/api/projects/${project.id}/generate`);

    const active = await request<ErrorBody>(server.baseUrl, 'DELETE', `/api/projects/${project.id}`);
    assert.deepEqual([active.status, active.body.error.code], [409, 'PROJECT_ACTIVE']);
    assert.equal(await getPrisma().project.count(), 1, 'nothing deleted while the pipeline is active');
    assert.equal((await request(server.baseUrl, 'POST', `/api/jobs/${gen.body.jobId}/abort`)).status, 200);

    const res = await request<{ deleted: boolean; id: string; filesRemoved: boolean }>(
      server.baseUrl,
      'DELETE',
      `/api/projects/${project.id}`,
    );
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { deleted: true, id: project.id, filesRemoved: true });

    const prisma = getPrisma();
    assert.equal(await prisma.project.count(), 0);
    assert.equal(await prisma.video.count(), 0);
    assert.equal(await prisma.job.count(), 0);

    const again = await request<ErrorBody>(server.baseUrl, 'DELETE', `/api/projects/${project.id}`);
    assert.equal(again.status, 404);
  });
});

describe('Generate API', () => {
  test('POST /api/projects/:id/generate creates a QUEUED video and a PENDING RESEARCH job', async () => {
    const project = await createProject();
    const res = await request<GenerateBody>(server.baseUrl, 'POST', `/api/projects/${project.id}/generate`);
    assert.equal(res.status, 202);
    assert.equal(res.body.projectId, project.id);
    assert.equal(res.body.status, 'QUEUED');

    const prisma = getPrisma();
    const video = await prisma.video.findUniqueOrThrow({ where: { id: res.body.videoId } });
    assert.equal(video.version, 1);
    assert.equal(video.status, 'QUEUED');

    const jobs = await prisma.job.findMany();
    assert.equal(jobs.length, 1);
    const [job] = jobs;
    assert.ok(job);
    assert.equal(job.id, res.body.jobId);
    assert.equal(job.type, 'RESEARCH');
    assert.equal(job.status, 'PENDING');
    assert.equal(job.videoId, video.id);
    assert.deepEqual(JSON.parse(job.payloadJson ?? ''), {
      projectId: project.id,
      videoId: video.id,
      topic: project.topic,
      title: project.title,
    });

    const detail = await request<ProjectDetailBody>(server.baseUrl, 'GET', `/api/projects/${project.id}`);
    assert.equal(detail.body.status, 'QUEUED');
    assert.equal(detail.body.videos.length, 1);
    assert.equal(detail.body.jobs.length, 1);
    assert.equal('payloadJson' in (detail.body.jobs[0] ?? {}), false);
  });

  test('duplicate generation is rejected with 409 and creates nothing', async () => {
    const project = await createProject();
    const first = await request(server.baseUrl, 'POST', `/api/projects/${project.id}/generate`);
    assert.equal(first.status, 202);

    // Also fire two concurrent requests while the pipeline is active.
    const results = await Promise.all([
      request<ErrorBody>(server.baseUrl, 'POST', `/api/projects/${project.id}/generate`),
      request<ErrorBody>(server.baseUrl, 'POST', `/api/projects/${project.id}/generate`),
    ]);
    for (const res of results) {
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'GENERATION_ALREADY_ACTIVE');
    }
    const prisma = getPrisma();
    assert.equal(await prisma.video.count(), 1);
    assert.equal(await prisma.job.count(), 1);
  });

  test('concurrent first generate requests create exactly one pipeline', async () => {
    const project = await createProject();
    const results = await Promise.all(
      [1, 2, 3].map(() => request(server.baseUrl, 'POST', `/api/projects/${project.id}/generate`)),
    );
    assert.deepEqual(
      results.map((r) => r.status).sort(),
      [202, 409, 409],
    );
    assert.equal(await getPrisma().job.count(), 1);
  });

  test('generate returns 404 for unknown project', async () => {
    const res = await request<ErrorBody>(server.baseUrl, 'POST', '/api/projects/nope/generate');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'PROJECT_NOT_FOUND');
  });
});

describe('Job API', () => {
  test('GET /api/jobs/:id returns public job fields only', async () => {
    const project = await createProject();
    const gen = await request<GenerateBody>(server.baseUrl, 'POST', `/api/projects/${project.id}/generate`);
    const res = await request<Record<string, unknown>>(server.baseUrl, 'GET', `/api/jobs/${gen.body.jobId}`);
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body).sort(), [
      'attempts',
      'completedAt',
      'createdAt',
      'error',
      'id',
      'startedAt',
      'status',
      'type',
    ]);
    assert.equal(res.body['type'], 'RESEARCH');
    assert.equal(res.body['status'], 'PENDING');

    const missing = await request<ErrorBody>(server.baseUrl, 'GET', '/api/jobs/nope');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'JOB_NOT_FOUND');
  });

  test('unknown API routes return a JSON 404', async () => {
    const res = await request<ErrorBody>(server.baseUrl, 'GET', '/api/unknown');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'NOT_FOUND');
  });
});

describe('Channel DNA API', () => {
  const defaults = {
    niche: 'Science',
    targetAudience: '18-30',
    language: 'vi',
    tone: 'Curious / mysterious',
    averageDuration: '40-55',
    hookStyle: 'Question',
    ctaStyle: 'Short',
    visualStyle: 'Dark documentary',
    subtitleStyle: 'White with yellow emphasis',
    voice: 'Male / Deep',
    musicStyle: 'Cinematic',
  };

  test('GET returns defaults when nothing is stored', async () => {
    const res = await request<Record<string, string>>(server.baseUrl, 'GET', '/api/settings/channel-dna');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, defaults);
  });

  test('PUT validates, saves and returns the Channel DNA', async () => {
    const updated = { ...defaults, niche: '  History ', tone: 'Dramatic' };
    const res = await request<Record<string, string>>(server.baseUrl, 'PUT', '/api/settings/channel-dna', updated);
    assert.equal(res.status, 200);
    assert.equal(res.body['niche'], 'History');

    const again = await request<Record<string, string>>(server.baseUrl, 'GET', '/api/settings/channel-dna');
    assert.deepEqual(again.body, { ...defaults, niche: 'History', tone: 'Dramatic' });
    assert.equal(await getPrisma().setting.count(), 11);
  });

  test('PUT rejects invalid input with 400 and stores nothing', async () => {
    const cases: unknown[] = [
      { ...defaults, niche: '' },
      { niche: 'History' },
      { ...defaults, OPENAI_API_KEY: 'sk-should-not-be-stored' },
    ];
    for (const body of cases) {
      const res = await request<ErrorBody>(server.baseUrl, 'PUT', '/api/settings/channel-dna', body);
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, 'VALIDATION_ERROR');
    }
    assert.equal(await getPrisma().setting.count(), 0);
  });
});

describe('Project detail with AI results', () => {
  test('exposes parsed research, script and scene emphasis — never raw JSON columns', async () => {
    const { AIClient } = await import('../lib/ai/client.js');
    const { MockAIProvider } = await import('../lib/ai/providers/mock.js');
    const { processNextJob } = await import('../lib/jobs/process-job.js');
    const project = await createProject();
    await request(server.baseUrl, 'POST', `/api/projects/${project.id}/generate`);
    const assets = createTestAssetServices();
    const ctx = {
      ai: new AIClient(new MockAIProvider()),
      assets,
      voice: createTestVoiceServices(undefined, assets.storage),
      render: createTestRenderServices(assets.storage),
    };
    while (await processNextJob(() => {}, ctx)) {
      // run the whole pipeline
    }

    const res = await request<{
      status: string;
      videos: {
        research: { facts: unknown[] } | null;
        script: { hook: string; scenes: unknown[] } | null;
        scenes: { subtitleEmphasis: string[] }[];
      }[];
    }>(server.baseUrl, 'GET', `/api/projects/${project.id}`);
    assert.equal(res.body.status, 'COMPLETED');
    const [video] = res.body.videos;
    assert.ok(video?.research && video.research.facts.length >= 3);
    assert.ok(video?.script?.hook);
    assert.deepEqual(video?.script?.scenes, []);
    assert.ok(video?.scenes.every((scene) => Array.isArray(scene.subtitleEmphasis) && scene.subtitleEmphasis.length > 0));
    const raw = JSON.stringify(res.body);
    assert.doesNotMatch(raw, /scriptJson|resultJson|payloadJson|subtitleEmphasisJson/);
  });
});
