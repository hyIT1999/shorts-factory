/**
 * Quota-free batch trial with the REAL FFmpeg: N projects through the whole
 * pipeline (mock AI, silent narration, placeholder images) rendered by the
 * ffmpeg/ffprobe from .env, on a throwaway database and data directory that
 * are removed afterwards. It prints per-stage timings, render speed and
 * output sizes: the numbers the production audit could only estimate. Run it
 * on the VPS before the first real batch.
 *
 *   npm run trial:render -- --count 5 [--keep]
 */
import 'dotenv/config';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AIClient } from '../lib/ai/client.js';
import { MockAIProvider } from '../lib/ai/providers/mock.js';
import { createAssetServicesFromEnv } from '../lib/assets/index.js';
import { enableWal, getPrisma } from '../lib/db/prisma.js';
import { JobStatus, JobType } from '../lib/generated/prisma/client.js';
import { processNextJob } from '../lib/jobs/process-job.js';
import type { JobContext } from '../lib/jobs/types.js';
import { checkData } from '../lib/maintenance/index.js';
import { createRenderServicesFromEnv } from '../lib/render/index.js';
import { RenderResultSchema } from '../lib/render/types.js';
import { createVoiceServicesFromEnv } from '../lib/voice/index.js';
import { createProject, startGeneration } from '../server/services/projects.js';

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const count = Number(option('--count', '3'));
const keep = process.argv.includes('--keep');
if (!Number.isInteger(count) || count < 1 || count > 100) {
  console.error('--count must be a whole number between 1 and 100');
  process.exit(2);
}

// A throwaway database and storage root; the real data/ is never touched.
const root = mkdtempSync(path.join(os.tmpdir(), 'sf-trial-'));
const dbFile = path.join(root, 'trial.db');
process.env['DATABASE_URL'] = `file:${dbFile}`;
execSync('npx prisma migrate deploy', { env: { ...process.env }, stdio: 'ignore' });

const dataDir = path.join(root, 'data');
const env = { ...process.env, DATA_DIR: dataDir, ASSET_PROVIDER: 'placeholder', VOICE_PROVIDER: 'silent', RENDER_PROVIDER: 'ffmpeg' };
const assets = createAssetServicesFromEnv(env);
const ctx: JobContext = {
  ai: new AIClient(new MockAIProvider()),
  assets,
  voice: createVoiceServicesFromEnv(assets.storage, env),
  render: createRenderServicesFromEnv(assets.storage, env),
  workerId: `trial-${process.pid}`,
};

interface Row {
  video: string;
  stages: Record<string, number>;
  totalSec: number;
  renderSec: number;
  frames: number;
  durationSec: number;
  sizeMb: number;
  warnings: number;
  error: string | null;
}

const seconds = (from: Date | null, to: Date | null) => (from && to ? (to.getTime() - from.getTime()) / 1000 : 0);

async function runOne(index: number): Promise<Row> {
  const project = await createProject({ title: `Trial ${index + 1}`, topic: 'Tại sao con người lại mơ?' });
  const gen = await startGeneration(project.id);
  const started = Date.now();
  const logs: string[] = [];
  while (await processNextJob((message) => logs.push(message), ctx)) {
    // until idle
  }
  const totalSec = (Date.now() - started) / 1000;
  const prisma = getPrisma();
  const jobs = await prisma.job.findMany({ where: { videoId: gen.videoId }, orderBy: { createdAt: 'asc' } });
  const stages: Record<string, number> = {};
  for (const job of jobs) {
    stages[job.type] = seconds(job.startedAt, job.completedAt);
  }
  const render = jobs.find((job) => job.type === JobType.RENDER);
  const failed = jobs.find((job) => job.status === JobStatus.FAILED);
  const result = render?.status === JobStatus.COMPLETED ? RenderResultSchema.safeParse(JSON.parse(render.resultJson ?? 'null')) : null;
  return {
    video: gen.videoId,
    stages,
    totalSec,
    renderSec: stages['RENDER'] ?? 0,
    frames: result?.success ? result.data.frames : 0,
    durationSec: result?.success ? result.data.durationMs / 1000 : 0,
    sizeMb: result?.success && result.data.fileSize ? result.data.fileSize / 1024 / 1024 : 0,
    warnings: result?.success ? result.data.warnings.length : 0,
    error: failed ? `${failed.type}: ${failed.error ?? 'unknown error'}` : null,
  };
}

async function main(): Promise<number> {
  await enableWal();
  console.log(`Render trial: ${count} video(s), ffmpeg ${ctx.render.ffmpegPath}, threads ${ctx.render.threads ?? 'default'}, data ${dataDir}`);
  console.log('video                      total   RENDER   fps   length   size     warnings');
  const rows: Row[] = [];
  for (let i = 0; i < count; i++) {
    const row = await runOne(i);
    rows.push(row);
    if (row.error) {
      console.log(`${row.video}  FAILED ${row.error}`);
      continue;
    }
    const fps = row.renderSec > 0 ? row.frames / row.renderSec : 0;
    console.log(
      `${row.video}  ${row.totalSec.toFixed(1).padStart(5)}s  ${row.renderSec.toFixed(1).padStart(5)}s  ${fps.toFixed(0).padStart(4)}  ${row.durationSec.toFixed(1).padStart(5)}s  ${row.sizeMb.toFixed(2).padStart(6)} MB  ${row.warnings}`,
    );
  }

  const ok = rows.filter((row) => !row.error);
  if (ok.length > 0) {
    const avg = (pick: (row: Row) => number) => ok.reduce((sum, row) => sum + pick(row), 0) / ok.length;
    const totalFrames = ok.reduce((sum, row) => sum + row.frames, 0);
    const totalRender = ok.reduce((sum, row) => sum + row.renderSec, 0);
    console.log(
      `\n${ok.length}/${rows.length} rendered. Average per video: ${avg((r) => r.totalSec).toFixed(1)} s total, ` +
        `${avg((r) => r.renderSec).toFixed(1)} s RENDER for ${avg((r) => r.durationSec).toFixed(1)} s of video ` +
        `(${(totalFrames / totalRender).toFixed(0)} fps), ${avg((r) => r.sizeMb).toFixed(2)} MB output.`,
    );
    const stageNames = Object.keys(ok[0]?.stages ?? {});
    console.log(`Average stage seconds: ${stageNames.map((name) => `${name} ${avg((r) => r.stages[name] ?? 0).toFixed(2)}`).join(', ')}`);
  }
  const report = await checkData(assets.storage);
  console.log(`Consistency check: ${report.issues.length === 0 ? 'no issues' : `${report.issues.length} issue(s)`}${report.issues.map((issue) => `\n  ${issue.code} ${issue.detail}`).join('')}`);
  return rows.every((row) => !row.error) && report.issues.length === 0 ? 0 : 1;
}

main()
  .then(async (code) => {
    await getPrisma().$disconnect();
    if (keep) {
      console.log(`Kept: ${root}`);
    } else {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
    process.exit(code);
  })
  .catch(async (error: unknown) => {
    console.error(error);
    await getPrisma().$disconnect();
    process.exit(1);
  });
