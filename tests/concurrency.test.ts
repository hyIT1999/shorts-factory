/**
 * Runs two real worker processes against the same SQLite database and checks
 * that no job is claimed twice.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import { enableWal, getPrisma } from '../lib/db/prisma.js';
import { PIPELINE } from '../lib/jobs/types.js';
import {
  TEST_DATABASE_URL,
  createProjectWithGeneration,
  migrateTestDb,
  makeTempDir,
  removeTestDb,
} from './helpers.js';

const PROJECTS = 20;
const TIMEOUT_MS = 90_000;

interface WorkerProcess {
  child: ChildProcess;
  output: string[];
}

const dataDir = makeTempDir('sf-workers-data-');

function startWorker(): WorkerProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', 'workers/worker.ts'], {
    // A short idle poll makes both workers compete for every job; mock AI avoids real API calls.
    env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, WORKER_POLL_INTERVAL_MS: '20', AI_PROVIDER: 'mock', ASSET_PROVIDER: 'placeholder', VOICE_PROVIDER: 'silent', VOICE_REQUEST_DELAY_MS: '0', RENDER_PROVIDER: 'mock', DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output: string[] = [];
  child.stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString()));
  return { child, output };
}

function claimedIds(worker: WorkerProcess): string[] {
  return [...worker.output.join('').matchAll(/Claimed job (\S+)/g)].map((m) => m[1] ?? '');
}

const workers: WorkerProcess[] = [];

before(async () => {
  migrateTestDb();
  await enableWal();
});
after(async () => {
  // Wait for the workers to exit so they release the SQLite file before it is removed.
  await Promise.all(
    workers.map(
      (w) =>
        new Promise<void>((resolve) => {
          if (w.child.exitCode !== null || w.child.signalCode !== null) {
            resolve();
            return;
          }
          w.child.once('exit', () => resolve());
          w.child.kill();
        }),
    ),
  );
  await removeTestDb();
});

test('two worker processes never claim the same job', { timeout: TIMEOUT_MS + 10_000 }, async () => {
  const prisma = getPrisma();
  const deadline = Date.now() + TIMEOUT_MS;

  // Start both workers and wait until both are polling, so they compete for jobs.
  workers.push(startWorker(), startWorker());
  while (!workers.every((w) => w.output.join('').includes('Waiting for jobs...'))) {
    if (Date.now() > deadline) {
      assert.fail(`Workers did not start.\n${workers.map((w) => w.output.join('')).join('\n---\n')}`);
    }
    await sleep(100);
  }

  for (let i = 0; i < PROJECTS; i++) {
    await createProjectWithGeneration(`Project ${i}`, `Topic ${i}`);
  }

  while ((await prisma.project.count({ where: { status: 'COMPLETED' } })) < PROJECTS) {
    if (Date.now() > deadline) {
      assert.fail(`Pipeline did not finish in time.\n${workers.map((w) => w.output.join('')).join('\n---\n')}`);
    }
    await sleep(250);
  }

  const [a, b] = workers.map(claimedIds);
  const all = [...(a ?? []), ...(b ?? [])];
  const expected = PROJECTS * PIPELINE.length;

  assert.equal(all.length, expected, 'every job was claimed exactly once in total');
  assert.equal(new Set(all).size, expected, 'no job id was claimed by two workers');
  assert.ok((a?.length ?? 0) > 0 && (b?.length ?? 0) > 0, 'both workers took part');

  const logs = workers.map((w) => w.output.join('')).join('\n');
  assert.doesNotMatch(logs, /Worker error|Failed job|Could not mark/, 'workers reported no errors');

  const jobs = await prisma.job.findMany();
  assert.equal(jobs.length, expected);
  for (const job of jobs) {
    assert.equal(job.status, 'COMPLETED');
    assert.equal(job.attempts, 1);
  }
});
