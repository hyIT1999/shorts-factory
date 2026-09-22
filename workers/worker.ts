/**
 * Background worker: polls the SQLite Job table, claims PENDING jobs and
 * dispatches them (see lib/jobs/process-job.ts). Several workers may run at
 * once; claiming is safe (see lib/jobs/claim-job.ts).
 *
 * Liveness: every claimed job carries this worker's id and a heartbeat that is
 * refreshed while the job runs. At start-up and every JOB_RECOVERY_INTERVAL_MS
 * the worker recovers jobs whose heartbeat went stale (a worker that died), so
 * a pipeline never stays PROCESSING forever (lib/jobs/recover-jobs.ts).
 *
 * Shutdown (SIGINT/SIGTERM/SIGHUP, Ctrl+Break on Windows, or the message
 * "shutdown" over IPC): external processes such as ffmpeg are killed at once,
 * the job in progress goes back to PENDING and the loop ends. A second signal,
 * or WORKER_STOP_TIMEOUT_MS running out (a handler still waiting on the
 * network), forces the exit; the job is then recovered by its heartbeat.
 */
import { hostname } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { createAIClientFromEnv } from '../lib/ai/client.js';
import { createAssetServicesFromEnv } from '../lib/assets/index.js';
import { enableWal, getPrisma } from '../lib/db/prisma.js';
import { killActiveProcesses } from '../lib/ffmpeg/process.js';
import { heartbeatConfigFromEnv, newWorkerId } from '../lib/jobs/heartbeat.js';
import { processNextJob } from '../lib/jobs/process-job.js';
import { DEFAULT_MAX_ATTEMPTS, recoverAbandonedJobs } from '../lib/jobs/recover-jobs.js';
import type { JobContext } from '../lib/jobs/types.js';
import { clearWorkerPresence, recordWorkerPresence, WORKER_PRESENCE_MS } from '../lib/jobs/worker-presence.js';
import { createRenderServicesFromEnv } from '../lib/render/index.js';
import { createVoiceServicesFromEnv } from '../lib/voice/index.js';

const POLL_INTERVAL_MS = Number(process.env['WORKER_POLL_INTERVAL_MS']) || 1000;
const RECOVERY_INTERVAL_MS = Number(process.env['JOB_RECOVERY_INTERVAL_MS']) || 60_000;
const STOP_TIMEOUT_MS = Number(process.env['WORKER_STOP_TIMEOUT_MS']) || 30_000;
const MAX_ATTEMPTS = Number(process.env['JOB_MAX_ATTEMPTS']) || DEFAULT_MAX_ATTEMPTS;
const workerId = newWorkerId();
const heartbeat = heartbeatConfigFromEnv();

const log = (message: string): void => {
  console.log(`[${new Date().toISOString()}] ${message}`);
};

let running = true;
let stopping = false;
let busy = false;

function requestStop(reason: string): void {
  if (stopping) {
    log(`Received ${reason} again; exiting now`);
    process.exit(130);
  }
  stopping = true;
  running = false;
  const killed = killActiveProcesses();
  log(
    `Received ${reason}: stopping${busy ? ' once the current job is requeued' : ''}` +
      (killed > 0 ? ` (stopped ${killed} external process(es))` : ''),
  );
  setTimeout(() => {
    log(`Stop timed out after ${STOP_TIMEOUT_MS} ms; exiting (the job is recovered through its heartbeat)`);
    process.exit(1);
  }, STOP_TIMEOUT_MS).unref();
}

const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
if (process.platform === 'win32') {
  signals.push('SIGBREAK');
}
for (const signal of signals) {
  process.on(signal, () => requestStop(signal));
}
// Process managers and tests that start the worker with an IPC channel can stop it cross-platform.
process.on('message', (message) => {
  if (message === 'shutdown') {
    requestStop('shutdown message');
  }
});
// An open IPC channel would keep the process alive after the loop has ended; messages still arrive.
process.channel?.unref();
// Last resort: never leave an ffmpeg behind, whatever ends this process.
process.on('exit', () => {
  killActiveProcesses();
});

async function main(): Promise<void> {
  await enableWal();
  const assets = createAssetServicesFromEnv();
  const ctx: JobContext = {
    ai: createAIClientFromEnv(),
    assets,
    voice: createVoiceServicesFromEnv(assets.storage),
    render: createRenderServicesFromEnv(assets.storage),
    workerId,
    heartbeatMs: heartbeat.intervalMs,
    isShuttingDown: () => stopping,
  };
  const model = ctx.ai.provider.name === 'openai' ? ` (model: ${process.env['OPENAI_MODEL'] || 'not set'})` : '';
  log(`Shorts Factory worker ${workerId} started`);
  log(`AI provider: ${ctx.ai.provider.name}${model}`);
  log(
    `Asset provider: ${ctx.assets.provider.name} (storage: ${ctx.assets.storage.root}, ` +
      `normalize: ${ctx.assets.normalizer?.name ?? 'off'}, fallback: ${ctx.assets.fallbackMode ?? 'placeholder'})`,
  );
  const voiceModel = ctx.voice.provider.model || 'model not set';
  log(`Voice provider: ${ctx.voice.provider.name} (${voiceModel}, voice: ${ctx.voice.voice || 'not set'})`);
  const motion = ctx.render.motion;
  const motionSummary = motion && motion.mode !== 'off' ? `${motion.mode} ×${motion.scale}${motion.preset === 'auto' ? '' : ` ${motion.preset}`}` : 'off';
  log(
    `Render provider: ${ctx.render.provider} (ffmpeg: ${ctx.render.ffmpegPath}, ffprobe: ${ctx.render.ffprobePath}, ` +
      `fonts: ${ctx.render.fontsDir}, motion: ${motionSummary})`,
  );
  log(`Heartbeat every ${heartbeat.intervalMs} ms; a job silent for ${heartbeat.staleMs} ms is recovered (up to ${MAX_ATTEMPTS} attempts)`);

  // Presence for /api/health ("is a worker alive?"), independent of jobs.
  const presence = { host: hostname(), pid: process.pid };
  let lastPresence = 0;
  let lastRecovery = 0;
  let idle = false;
  while (running) {
    if (Date.now() - lastPresence >= WORKER_PRESENCE_MS) {
      lastPresence = Date.now();
      await recordWorkerPresence(workerId, presence).catch((error: unknown) => {
        log(`Could not record worker presence: ${error instanceof Error ? error.message : String(error)}`);
      });
    }
    if (Date.now() - lastRecovery >= RECOVERY_INTERVAL_MS) {
      lastRecovery = Date.now();
      try {
        await recoverAbandonedJobs({ staleMs: heartbeat.staleMs, maxAttempts: MAX_ATTEMPTS, log });
      } catch (error) {
        log(`Recovery error: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    let processed = false;
    try {
      busy = true;
      processed = await processNextJob(log, ctx);
    } catch (error) {
      log(`Worker error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      busy = false;
    }

    if (processed) {
      idle = false;
      continue;
    }
    if (!idle) {
      log('Waiting for jobs...');
      idle = true;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  await clearWorkerPresence(workerId).catch(() => undefined);
  await getPrisma().$disconnect();
  log('Worker stopped');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
